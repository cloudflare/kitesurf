// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parser script policy in the source-based legacy plan: source cache keys, template ancestry,
// modulepreload pin scope, parser initiator, and lifecycle events for refused modules.
// The page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchExternalScripts } from "../src/eval/prefetch-scripts.ts";

const hoisted = vi.hoisted(() => ({
  importImpl: null as null | ((url: string, base: string) => Promise<unknown>),
}));

vi.mock("../../page-script/src/wasm-glue.js", () => ({
  __setBridgeFetchResource: () => {},
  initSync: () => {},
  ks_bridge_install_desc_helpers: () => {},
  ks_eval_page: () => {},
  ks_import: (url: string, base: string) =>
    hoisted.importImpl ? hoisted.importImpl(url, base) : Promise.resolve(),
  DomHandle: class {
    deliverResource(): boolean {
      return true;
    }
    deliverFontResource(): boolean {
      return true;
    }
  },
  register_ua_fonts: () => {},
  register_emoji_font: () => {},
  register_symbol_fonts: () => {},
  register_cjk_font: () => {},
  register_script_font: () => {},
  setFontShapingLazy: () => {},
  pendingLazyFontPaths: () => [],
  upgradeFontFace: () => {},
  finishFontUpgrade: () => {},
}));

vi.mock("../../page-script/src/startup-probe.ts", () => ({
  startupCsp: [],
  startupMetaCsp: [],
  startupInsertedBaked: [],
  importModule: async () => undefined,
}));

const PAGE = "https://page.test/index.html";
const MODULE = "https://page.test/m.js";

let scripts: any;
let inserted: any;
let policy: any;
let stateModule: any;
let trusted: any;
let state: any;

const realFetch = globalThis.fetch;
const realWarn = console.warn;

beforeAll(async () => {
  scripts = await vi.importActual("../../page-script/src/scripts.ts");
  inserted = await vi.importActual("../../page-script/src/inserted-scripts.ts");
  policy = await vi.importActual("../../page-script/src/script-policy.ts");
  stateModule = await vi.importActual("../../page-script/src/state.ts");
  trusted = await vi.importActual("../../page-script/src/trusted-fetch.ts");
  state = stateModule.state;
});

beforeEach(() => {
  hoisted.importImpl = null;
  state.pageUrl = PAGE;
  state.documentUrl = PAGE;
  state.document = null;
  state.dom = null;
  state.resolveNodeId = () => null;
  inserted.setModulePreloadPins([]);
  policy.setNavigationScriptPolicy({ cspHeaders: [], cspReportOnlyHeaders: [], metaCsp: [] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

function setPolicy(cspHeaders: string[], cspReportOnlyHeaders: string[] = []): void {
  policy.setNavigationScriptPolicy({ cspHeaders, cspReportOnlyHeaders, metaCsp: [] });
}

function installFetch(source: string, status = 200): Array<{ url: string; initiator?: string }> {
  const seen: Array<{ url: string; initiator?: string }> = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    seen.push({ url, initiator: trusted.takeTrustedRequestMeta(init)?.initiator });
    return new Response(source, {
      status,
      headers: { "content-type": "text/javascript", "x-kitesurf-cors": "clean" },
    });
  }) as typeof fetch;
  trusted.captureTrustedFetch();
  return seen;
}

function classic(src: string, integrity: string | null = null): any {
  return {
    src,
    kind: "classic",
    defer: false,
    async: false,
    body: "",
    nonce: null,
    integrity,
    crossOrigin: null,
  };
}

function moduleScript(src: string, nodeId: number): any {
  return {
    src,
    kind: "module",
    defer: false,
    async: false,
    body: "",
    nonce: null,
    integrity: null,
    crossOrigin: null,
    nodeId,
  };
}

function planOf(modules: any[]): any {
  return { regular: [], deferred: [], async_: [], modules, sourceCache: new Map() };
}

async function sha384(source: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-384", new TextEncoder().encode(source)),
  );
  return "sha384-" + btoa(String.fromCharCode(...digest));
}

describe("legacy plan source cache", () => {
  it("fetches and verifies once per element, so a second integrity value is still checked", async () => {
    const source = "globalThis.ran = 1;";
    const good = await sha384(source);
    const seen = installFetch(source);
    const matching = classic("/a.js", good);
    const tampered = classic("/a.js", "sha384-" + "A".repeat(64));

    const plan = scripts.planScripts([matching, tampered]);
    const first = await plan.sourceCache.get(matching);
    const second = await plan.sourceCache.get(tampered);

    expect(seen.length).toBe(2);
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(false);
    expect(second?.error).toMatch(/integrity/);
  });
});

describe("template ancestry", () => {
  it("skips a script inside <template> and survives a stale ancestor id", () => {
    const parents: Record<number, number> = { 10: 20, 11: 21, 12: 99, 20: -1, 21: 30, 30: -1 };
    const dom = {
      querySelectorAll: () => [10, 11, 12],
      parentId: (id: number) => parents[id] ?? -1,
      nodeInfo: (id: number) => {
        if (id === 99) throw new Error("stale node id");
        if (id === 30) return { localName: "template", nodeName: "TEMPLATE" };
        if (id >= 10 && id < 13) {
          return { localName: "script", nodeName: "SCRIPT", attributes: ["src", "/a.js"] };
        }
        return { localName: "div", nodeName: "DIV" };
      },
      textContent: () => "",
    };
    state.dom = dom;

    const extracted = scripts.extractScripts();
    expect(extracted.map((script: any) => script.nodeId)).toEqual([10, 12]);
  });
});

describe("modulepreload pins", () => {
  const DEP = "https://page.test/dep.js";
  const BAD = "sha384-" + "A".repeat(64);
  const SOURCE = "export const dep = 1;";

  it("refuses a later import of a url whose modulepreload pin mismatches", async () => {
    inserted.setModulePreloadPins([{ url: DEP, integrity: BAD }]);
    const seen = installFetch(SOURCE);

    await expect(inserted.fetchGatedModuleSource(DEP)).rejects.toThrow(/integrity/);
    // HTML stores the failed fetch for the url, so a later import of it sees the same refusal.
    await expect(
      inserted.fetchGatedModuleSource(DEP, "https://page.test/entry.js"),
    ).rejects.toThrow(/integrity/);
    expect(seen.length).toBe(2);
  });

  it("runs a later import of a url whose modulepreload pin matches", async () => {
    inserted.setModulePreloadPins([{ url: DEP, integrity: await sha384(SOURCE) }]);
    installFetch(SOURCE);

    await expect(inserted.fetchGatedModuleSource(DEP, "https://page.test/entry.js")).resolves.toBe(
      SOURCE,
    );
  });
});

describe("parser script initiator", () => {
  it("reports a parser classic as a parser request", async () => {
    const seen = installFetch("globalThis.ran = 1;");
    const plan = scripts.planScripts([classic("/a.js")]);
    await plan.sourceCache.get(plan.regular[0]);
    expect(seen[0]?.initiator).toBe("parser");
  });

  it("reports a parser entry module as a parser request", async () => {
    const seen = installFetch("export const m = 1;");
    scripts.setEntryModuleGateAttributes(MODULE, {
      nonce: null,
      integrity: null,
      parser: true,
    });
    try {
      await inserted.fetchGatedModuleSource(MODULE, PAGE);
    } finally {
      scripts.clearEntryModuleGateAttributes(MODULE);
    }
    expect(seen[0]?.initiator).toBe("parser");
  });
});

describe("engine parser prefetch initiator", () => {
  it("reports a parser classic prefetch as parser and a speculative one as script", async () => {
    const seen: Array<string | null> = [];
    const fetcher = {
      fetch: async (req: Request) => {
        seen.push(req.headers.get("x-kitesurf-initiator"));
        return new Response("globalThis.ran = 1;", {
          headers: { "content-type": "text/javascript" },
        });
      },
    } as Fetcher;
    const sandboxOutbound = {
      external: false,
      parent: () => fetcher,
      loaded: () => fetcher,
      session: () => (req: Request) => fetcher.fetch(req),
      final: async () => new Response(null, { status: 404 }),
    } as any;
    const run = (initiator?: "parser" | "script") =>
      prefetchExternalScripts({
        descriptors: [classic("/a.js")],
        pageUrl: PAGE,
        connectionId: "",
        baseUrl: PAGE,
        sandboxOutbound,
        ...(initiator ? { initiator } : {}),
      });
    await run("parser");
    await run();
    expect(seen).toEqual(["parser", "script"]);
  });
});

describe("parser module refusals", () => {
  function recordLifecycle(): string[] {
    const events: string[] = [];
    state.resolveNodeId = () => ({
      dispatchEvent: (event: any) => {
        events.push(event.type);
        return true;
      },
    });
    stateModule.ksEventCtors.Event = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
    return events;
  }

  it("fires error for a module the parser gate refuses", async () => {
    setPolicy(["script-src 'none'"]);
    const events = recordLifecycle();
    let imported = 0;
    hoisted.importImpl = async () => {
      imported++;
    };
    const script = moduleScript("/m.js", 7);
    script._resolvedUrl = MODULE;

    await scripts.runModulePhase(planOf([script]));

    expect(imported).toBe(0);
    expect(events).toEqual(["error"]);
  });

  it("fires error when the module fetch is refused", async () => {
    const events = recordLifecycle();
    installFetch("", 404);
    hoisted.importImpl = async (url: string) => {
      try {
        await inserted.fetchGatedModuleSource(url, PAGE);
      } catch (err) {
        // boa reports a rejected loader promise this way (core's gated_module_source).
        throw new Error(`import(${url}) rejected: module refused for ${url}: ${String(err)}`);
      }
    };
    const script = moduleScript("/m.js", 7);
    script._resolvedUrl = MODULE;

    await scripts.runModulePhase(planOf([script]));

    expect(events).toEqual(["error"]);
  });

  it("fires load when a module throws an error whose message mentions a refusal", async () => {
    const events = recordLifecycle();
    const THROWN = "https://page.test/thrown.js";
    hoisted.importImpl = async () => {
      // The page's own message: this URL never failed a gated fetch.
      throw new Error("module refused for " + THROWN + ": the page wrote this");
    };
    const script = moduleScript("/thrown.js", 7);
    script._resolvedUrl = THROWN;

    await scripts.runModulePhase(planOf([script]));

    expect(events).toEqual([]);
  });

  it("reports a report-only violation once per parser module", async () => {
    setPolicy([], ["script-src 'none'"]);
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    installFetch("export const m = 1;");
    hoisted.importImpl = async (url: string) => {
      await inserted.fetchGatedModuleSource(url, PAGE);
    };
    const script = moduleScript("/m.js", 7);
    script._resolvedUrl = MODULE;

    await scripts.runModulePhase(planOf([script]));

    expect(warns.filter((warning) => warning.includes("[Report Only]")).length).toBe(1);
  });
});
