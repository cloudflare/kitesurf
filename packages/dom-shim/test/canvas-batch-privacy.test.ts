// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it, vi } from "vitest";
import { makeCanvas2DContext } from "../src/canvas2d.js";
import { getInternalState } from "../src/internal-state.js";
import { canvas2dCache } from "../src/registries.js";

const batches = vi.hoisted(() => [] as string[]);
const page = vi.hoisted(() => ({ documentUrl: "https://page.example/" }));
const image = vi.hoisted(() => ({ src: "https://other.example/image" }));
const shimDom = vi.hoisted(() => ({
  baseId: -1,
  baseHref: "",
  localNames: new Map<number, string>(),
  attrs: new Map<number, string[]>(),
  parents: new Map<number, number>(),
  children: new Map<number, number[]>(),
}));
vi.mock("../src/state.js", async (original) => ({
  ...(await original<typeof import("../src/state.js")>()),
  getDocumentUrl: () => page.documentUrl,
  dom: {
    canvasSourceInfo: () => ({ kind: "img", src: image.src }),
    canvasApplyOps: (_id: number, json: string) => (batches.push(json), 1),
    querySelector: () => shimDom.baseId,
    nodeInfo: (id: number) => ({
      localName: shimDom.localNames.get(id) ?? "",
      attributes:
        id === shimDom.baseId && shimDom.baseHref
          ? ["href", shimDom.baseHref]
          : shimDom.attrs.get(id),
    }),
    parentId: (id: number) => shimDom.parents.get(id) ?? -1,
    childIds: (id: number) => shimDom.children.get(id) ?? [],
  },
}));
function resetShimNodes(): void {
  shimDom.localNames.clear();
  shimDom.attrs.clear();
  shimDom.parents.clear();
  shimDom.children.clear();
}

it.each(["arrayJSON", "objectJSON", "push", "weakmap"] as const)(
  "keeps cross-origin canvas operations private from %s",
  (hook) => {
    batches.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "https://page.example" });
    vi.stubGlobal("document", { baseURI: "https://page.example/" });
    const canvas = { _id: 1, width: 8, height: 8 };
    canvas2dCache.set(1, { deref: () => canvas });
    const ctx = makeCanvas2DContext(canvas);
    const image = { _id: 2, complete: true, naturalWidth: 1 };
    const pattern = ctx.createPattern(image, "repeat");
    if (!pattern) throw new Error("fixture pattern missing");
    const owner =
      hook === "objectJSON"
        ? Object.prototype
        : hook === "weakmap"
          ? WeakMap.prototype
          : Array.prototype;
    const key = hook === "push" ? "push" : hook === "weakmap" ? "get" : "toJSON";
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const nativePush = Array.prototype.push;
    const nativeGet = WeakMap.prototype.get;
    let sawPrivate = false;
    const attack = (value: unknown) => {
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) attack(value[i]);
      if (
        value &&
        typeof value === "object" &&
        (Reflect.get(value, "o") === "drawImage" || Reflect.get(value, "k") === "pattern")
      ) {
        sawPrivate = true;
        Reflect.set(value, "oc", true);
      }
    };
    Object.defineProperty(owner, key, {
      configurable: true,
      writable: true,
      value: function (this: object, ...args: unknown[]) {
        if (hook === "push") {
          attack(args);
          return Reflect.apply(nativePush, this, args);
        }
        if (hook === "weakmap") {
          const value: unknown = Reflect.apply(nativeGet, this, args);
          attack(value);
          return value;
        }
        attack(this);
        return this;
      },
    });
    try {
      ctx.drawImage(image, 0, 0);
      ctx.fillStyle = pattern;
      ctx.__ksFlushForRead();
    } finally {
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else Reflect.deleteProperty(owner, key);
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      getInternalState().pendingCanvasPushes.clear();
      canvas2dCache.delete(1);
    }
    expect(JSON.parse(batches[0])[1].oc).toBe(false);
    expect(JSON.parse(batches[1])[0].g.oc).toBe(false);
    expect(sawPrivate).toBe(false);
    batches.length = 0;
  },
);

function drawAndCollectOps(): Array<Record<string, unknown>> {
  batches.length = 0;
  vi.useFakeTimers();
  const canvas = { _id: 1, width: 8, height: 8 };
  canvas2dCache.set(1, { deref: () => canvas });
  try {
    const ctx = makeCanvas2DContext(canvas);
    ctx.drawImage({ _id: 2, complete: true, naturalWidth: 1 }, 0, 0);
    ctx.__ksFlushForRead();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    getInternalState().pendingCanvasPushes.clear();
    canvas2dCache.delete(1);
  }
  return batches.flatMap((batch) => JSON.parse(batch) as Array<Record<string, unknown>>);
}

it("derives the document origin from shim state, not page-replaced globals", () => {
  // Page code shares the realm, so it can replace these plain writable globals.
  vi.stubGlobal("location", { origin: "", href: "" });
  vi.stubGlobal("document", { baseURI: "https://page.example/" });
  vi.stubGlobal(
    "URL",
    class PageURL {
      readonly origin = "https://page.example";
      readonly protocol = "https:";
      readonly href = "https://page.example/image";
    },
  );
  const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
  expect(draw?.oc).toBe(false);
});

it("resolves relative sources against the shim base element, not the global document", () => {
  image.src = "/relative.png";
  shimDom.baseId = 7;
  shimDom.baseHref = "https://other.example/";
  try {
    vi.stubGlobal("document", { baseURI: "https://page.example/" });
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(draw?.oc).toBe(false);
  } finally {
    image.src = "https://other.example/image";
    shimDom.baseId = -1;
    shimDom.baseHref = "";
  }
});

it("taints an image whose srcset names a cross-origin candidate", () => {
  image.src = "/__fixtures/tiny.png";
  shimDom.attrs.set(2, ["srcset", "https://other.example/image 2x"]);
  try {
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(draw?.oc).toBe(false);
  } finally {
    image.src = "https://other.example/image";
    resetShimNodes();
  }
});

it("taints an image whose preceding picture source names a cross-origin candidate", () => {
  image.src = "/__fixtures/tiny.png";
  shimDom.parents.set(2, 9);
  shimDom.localNames.set(9, "picture");
  shimDom.children.set(9, [8, 2]);
  shimDom.localNames.set(8, "source");
  shimDom.attrs.set(8, ["srcset", "https://other.example/image 2x"]);
  try {
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(draw?.oc).toBe(false);
  } finally {
    image.src = "https://other.example/image";
    resetShimNodes();
  }
});

it("keeps an image whose candidates are all same-origin or data: clean", () => {
  image.src = "/__fixtures/tiny.png";
  shimDom.attrs.set(2, ["srcset", "/__fixtures/tiny.png 2x, data:image/png;base64,AA=="]);
  try {
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(draw?.oc).toBeUndefined();
  } finally {
    image.src = "https://other.example/image";
    resetShimNodes();
  }
});

it("reads the shim base with captured String intrinsics, not page replacements", () => {
  image.src = "/relative.png";
  shimDom.baseId = 7;
  shimDom.baseHref = "https://other.example/";
  const stringDescriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
  const lowerDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "toLowerCase");
  const nativeString = String;
  let oc: unknown;
  try {
    // A page that answers for the base URL, the way breaker canvas7 did.
    Object.defineProperty(globalThis, "String", {
      configurable: true,
      writable: true,
      value: function (value: unknown) {
        return nativeString(value) === "https://other.example/"
          ? "https://page.example/"
          : nativeString(value);
      },
    });
    Object.defineProperty(String.prototype, "toLowerCase", {
      configurable: true,
      writable: true,
      value: function (this: string) {
        return nativeString(this) === "href" ? "hreF" : nativeString(this);
      },
    });
    oc = drawAndCollectOps().find((op) => op && op.o === "drawImage")?.oc;
  } finally {
    if (stringDescriptor) Object.defineProperty(globalThis, "String", stringDescriptor);
    if (lowerDescriptor) {
      Object.defineProperty(String.prototype, "toLowerCase", lowerDescriptor);
    }
    image.src = "https://other.example/image";
    resetShimNodes();
  }
  expect(oc).toBe(false);
});

it.each([
  ["data:image/png;base64,AA==", undefined],
  ["https://page.example/image", false],
])("an opaque document keeps %s at oc=%s", (src, expected) => {
  page.documentUrl = "about:blank";
  image.src = src;
  try {
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(draw?.oc).toBe(expected);
  } finally {
    page.documentUrl = "https://page.example/";
    image.src = "https://other.example/image";
  }
});

it("writes the taint flag as an own property instead of through a page setter", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "oc");
  let setterCalls = 0;
  Object.defineProperty(Object.prototype, "oc", {
    configurable: true,
    get: () => true,
    set(this: object) {
      setterCalls += 1;
      // A page setter receives the operation and can plant its own serializer.
      Object.defineProperty(this, "toJSON", {
        configurable: true,
        value: () => ({ o: "hijacked" }),
      });
    },
  });
  try {
    const draw = drawAndCollectOps().find((op) => op && op.o === "drawImage");
    expect(setterCalls).toBe(0);
    expect(draw?.oc).toBe(false);
    expect(draw?.id).toBe(2);
    expect(draw?.s).toBe("img");
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, "oc", descriptor);
    else Reflect.deleteProperty(Object.prototype, "oc");
  }
});
