// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

const DATA_URL_PREFIX = "data:text/html;charset=utf-8,";
const PAGE = "<!doctype html><html><body><h1>Unforgeable test</h1></body></html>";
const LOCATION_MEMBERS = [
  "href",
  "origin",
  "protocol",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
  "toString",
  "valueOf",
  "assign",
  "replace",
  "reload",
];

type PropertyProbe = { defined?: boolean; hasGet?: boolean; configurable?: boolean };

function isDefinedNonConfigurable(property: PropertyProbe): boolean {
  return property.defined === true && property.configurable === false;
}

function isOwnAccessor(property: PropertyProbe): boolean {
  return isDefinedNonConfigurable(property) && property.hasGet === true;
}

test.fails("window and document.location are own non-configurable accessors", async ({ page }) => {
  // Gap: the engine does not define these as [LegacyUnforgeable] accessors.
  await setContent(page, PAGE);
  const desc = await page.evaluate(() => {
    const inspect = (obj: object, name: string): Record<string, boolean | undefined> => {
      const d = Object.getOwnPropertyDescriptor(obj, name);
      if (!d) return { defined: false };
      return {
        defined: true,
        hasGet: typeof d.get === "function",
        configurable: d.configurable,
      };
    };
    return {
      windowLocation: inspect(window, "location"),
      windowWindow: inspect(window, "window"),
      windowDocument: inspect(window, "document"),
      windowTop: inspect(window, "top"),
      docLocation: inspect(document, "location"),
    };
  });

  expect(
    isOwnAccessor(desc.windowLocation),
    "window.location is an own non-configurable accessor",
  ).toBe(true);
  expect(
    isDefinedNonConfigurable(desc.windowWindow),
    "window.window is an own non-configurable accessor",
  ).toBe(true);
  expect(
    isDefinedNonConfigurable(desc.windowDocument),
    "window.document is an own non-configurable accessor",
  ).toBe(true);
  expect(
    isDefinedNonConfigurable(desc.windowTop),
    "window.top is an own non-configurable accessor",
  ).toBe(true);
  expect(
    isDefinedNonConfigurable(desc.docLocation),
    "document.location is an own non-configurable accessor",
  ).toBe(true);
});

test.fails("window and document.location resist redefinition", async ({ page }) => {
  // Gap: page script can redefine these properties, so it can replace the URL object.
  await setContent(page, PAGE);
  const forgery = await page.evaluate(() => {
    const tryRedefine = (obj: any, name: string): boolean => {
      try {
        Object.defineProperty(obj, name, {
          value: { href: "https://ks.invalid/" },
          configurable: true,
        });
        return false;
      } catch {
        return true;
      }
    };
    return {
      winLoc: tryRedefine(window, "location"),
      winDoc: tryRedefine(window, "document"),
      winTop: tryRedefine(window, "top"),
      docLoc: tryRedefine(document, "location"),
    };
  });

  expect(forgery.winLoc, 'defineProperty(window, "location") throws').toBe(true);
  expect(forgery.winDoc, 'defineProperty(window, "document") throws').toBe(true);
  expect(forgery.winTop, 'defineProperty(window, "top") throws').toBe(true);
  expect(forgery.docLoc, 'defineProperty(document, "location") throws').toBe(true);
});

test.fails("location.toString and location.valueOf are own non-configurable properties", async ({
  page,
}) => {
  // Gap: the engine does not define these two as own, non-configurable properties of location.
  await setContent(page, PAGE);
  const shape = await page.evaluate(() => {
    const ts = Object.getOwnPropertyDescriptor(location, "toString");
    const vo = Object.getOwnPropertyDescriptor(location, "valueOf");
    return {
      toStringLocked: !!ts && ts.configurable === false,
      valueOfLocked: !!vo && vo.configurable === false,
    };
  });

  expect(shape.toStringLocked, "location.toString is a non-configurable own property").toBe(true);
  expect(shape.valueOfLocked, "location.valueOf is a non-configurable own property").toBe(true);
});

test.fails("location.toString and location.valueOf resist redefinition", async ({ page }) => {
  // Gap: page script can redefine location.toString and location.valueOf.
  await setContent(page, PAGE);
  const redefined = await page.evaluate(() => {
    const tryRedefine = (name: string, descriptor: PropertyDescriptor): boolean => {
      try {
        Object.defineProperty(location, name, descriptor);
        return false;
      } catch {
        return true;
      }
    };
    return {
      toString: tryRedefine("toString", {
        get() {},
        set(_v) {},
        enumerable: true,
        configurable: true,
      }),
      valueOf: tryRedefine("valueOf", { get() {}, enumerable: false, configurable: true }),
    };
  });

  expect(redefined.toString, 'defineProperty(location, "toString") throws TypeError').toBe(true);
  expect(redefined.valueOf, 'defineProperty(location, "valueOf") throws TypeError').toBe(true);
});

test("window is a Window with own unforgeable members", async ({ page }) => {
  await setContent(page, PAGE);
  const shape = await page.evaluate(() => {
    function isOwnUnforgeable(id: string): boolean {
      return id in window && !(id in Window.prototype);
    }

    function constructorFlags(descriptor: PropertyDescriptor | undefined) {
      return {
        writable: descriptor?.writable === true,
        enumerable: descriptor?.enumerable === false,
        configurable: descriptor?.configurable === true,
      };
    }

    const unforgeable = ["window", "document", "location", "top"];
    const own: Record<string, boolean> = {};
    for (const id of unforgeable) {
      own[id] = isOwnUnforgeable(id);
    }
    const ctor = Object.getOwnPropertyDescriptor(Window.prototype, "constructor");
    const flags = constructorFlags(ctor);
    return {
      windowExists: typeof Window === "function",
      windowIsInstance: window instanceof Window,
      ctorNotOwn: !Object.prototype.hasOwnProperty.call(window, "constructor"),
      own,
      ctorWritable: flags.writable,
      ctorEnumerable: flags.enumerable,
      ctorConfigurable: flags.configurable,
    };
  });

  expect(shape.windowExists, "Window constructor exists on globalThis").toBe(true);
  expect(shape.windowIsInstance, "window instanceof Window").toBe(true);
  expect(shape.ctorNotOwn, "window.constructor is NOT an own property (inherited)").toBe(true);
  for (const id of ["window", "document", "location", "top"]) {
    expect(
      shape.own[id],
      `[LegacyUnforgeable] ${id}: own on window, absent from Window.prototype`,
    ).toBe(true);
  }
  expect(
    shape.ctorWritable && shape.ctorEnumerable && shape.ctorConfigurable,
    "Window.prototype.constructor descriptor: {writable:true, enumerable:false, configurable:true}",
  ).toBe(true);
});

test.fails("window.constructor is Window", async ({ page }) => {
  // Gap: the engine's window.constructor does not resolve to Window.
  await setContent(page, PAGE);
  const ctor = await page.evaluate(() => ({
    windowConstructor: window.constructor === Window,
    prototypeConstructor:
      Object.getOwnPropertyDescriptor(Window.prototype, "constructor")?.value === Window,
  }));

  expect(ctor.windowConstructor, "window.constructor === Window").toBe(true);
  expect(ctor.prototypeConstructor, "Window.prototype.constructor === Window").toBe(true);
});

test.fails("every location member is own, non-configurable, and resists redefinition", async ({
  page,
}) => {
  // Gap: the engine's Location members are configurable and redefinable.
  await setContent(page, PAGE);
  const members = await page.evaluate((names: string[]) => {
    const out: Record<string, boolean> = {};
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(location, name);
      let threw = false;
      try {
        Object.defineProperty(location, name, { value: "spoofed", configurable: true });
      } catch {
        threw = true;
      }
      out[name] = !!d && d.configurable === false && threw;
    }
    return out;
  }, LOCATION_MEMBERS);

  for (const name of LOCATION_MEMBERS) {
    expect(members[name], `location.${name}: own, non-configurable, redefine throws`).toBe(true);
  }
});

test.fails("location.valueOf is Object.prototype.valueOf", async ({ page }) => {
  // Gap: Chrome's location.valueOf is the Object.prototype.valueOf function; the engine's is not.
  await setContent(page, PAGE);
  const sameAsObjectProto = await page.evaluate(
    () => location.valueOf === Object.prototype.valueOf,
  );
  expect(sameAsObjectProto, "location.valueOf === Object.prototype.valueOf").toBe(true);
});

test.fails("location[Symbol.toPrimitive] is non-enumerable, non-writable, and non-configurable", async ({
  page,
}) => {
  // Gap: the engine's own Symbol.toPrimitive on location is writable or configurable.
  await setContent(page, PAGE);
  const descriptor = await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(location, Symbol.toPrimitive);
    return { enumerable: d?.enumerable, writable: d?.writable, configurable: d?.configurable };
  });

  expect(
    descriptor.enumerable === false &&
      descriptor.writable === false &&
      descriptor.configurable === false,
    "Symbol.toPrimitive descriptor is non-enum / non-writable / non-configurable",
  ).toBe(true);
});

test("location exposes no toJSON and a URL string form", async ({ page }) => {
  await setContent(page, PAGE);
  const extra = await page.evaluate(
    (prefix: string) => ({
      valueOfCallOn5IsObject: typeof location.valueOf.call(5) === "object",
      toJSONUndefined: (location as any).toJSON === undefined,
      toJSONNoOwnDescriptor: Object.getOwnPropertyDescriptor(location, "toJSON") === undefined,
      hasOwnToJSONFalse: location.hasOwnProperty("toJSON") === false,
      symbolToPrimitiveReadsUndefined: (location as any)[Symbol.toPrimitive] === undefined,
      symbolToPrimitiveOwn:
        Object.getOwnPropertyDescriptor(location, Symbol.toPrimitive) !== undefined,
      stringCoerce: String(location).startsWith(prefix),
    }),
    DATA_URL_PREFIX,
  );

  expect(extra.valueOfCallOn5IsObject, "location.valueOf.call(5) returns an object").toBe(true);
  expect(extra.toJSONUndefined, "location.toJSON is undefined").toBe(true);
  expect(extra.toJSONNoOwnDescriptor, "location has no toJSON own descriptor").toBe(true);
  expect(extra.hasOwnToJSONFalse, "location.hasOwnProperty('toJSON') === false").toBe(true);
  expect(
    extra.symbolToPrimitiveReadsUndefined,
    "location[Symbol.toPrimitive] reads as undefined",
  ).toBe(true);
  expect(extra.symbolToPrimitiveOwn, "location has an own Symbol.toPrimitive descriptor").toBe(
    true,
  );
  expect(extra.stringCoerce, "String(location) returns the real URL").toBe(true);
});

test("location reads, setters, and methods work on the real URL", async ({ page }) => {
  await setContent(page, PAGE);
  const reads = await page.evaluate(
    (prefix: string) => ({
      href: window.location.href,
      docHref: document.location.href,
      windowIsSelf: window === window.self,
      topIsWindow: window.top === window,
      defaultViewIsWindow: document.defaultView === window,
      assignIsFn: typeof location.assign === "function",
      replaceIsFn: typeof location.replace === "function",
      hrefStartsWithPrefix: window.location.href.startsWith(prefix),
    }),
    DATA_URL_PREFIX,
  );
  expect(reads.hrefStartsWithPrefix, "window.location.href reads real URL").toBe(true);
  expect(reads.docHref === reads.href, "document.location.href matches window.location.href").toBe(
    true,
  );
  expect(reads.windowIsSelf, "window === window.self").toBe(true);
  expect(reads.topIsWindow, "window.top === window").toBe(true);
  expect(reads.defaultViewIsWindow, "document.defaultView === window").toBe(true);
  expect(reads.assignIsFn && reads.replaceIsFn, "location.assign / replace remain callable").toBe(
    true,
  );

  const navResult = await page.evaluate(() => {
    const before = window.location.href;
    (window as any).location = before + "#hash-via-setter";
    return { hash: window.location.hash };
  });
  expect(
    navResult.hash === "#hash-via-setter",
    `window.location = "url" runs through the setter (hash now ${navResult.hash})`,
  ).toBe(true);

  const navResult2 = await page.evaluate(() => {
    const before = document.location.href.split("#")[0];
    (document as any).location = before + "#via-document";
    return { hash: window.location.hash };
  });
  expect(
    navResult2.hash === "#via-document",
    `document.location = "url" runs through the setter (hash now ${navResult2.hash})`,
  ).toBe(true);
});
