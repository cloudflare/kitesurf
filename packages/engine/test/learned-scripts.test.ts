// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import {
  clearLearnedScripts,
  forgetLearnedScript,
  learnedScriptsFor,
  recordInsertedScript,
  type LearnedScripts,
} from "../src/eval/learned-scripts.ts";

const PAGE = "https://site.test/";
const BIG = 64 * 1024;

describe("learned inserted scripts", () => {
  it("lets a stable script in after cache-busted inserts filled the list", () => {
    const store: LearnedScripts = new Map();
    for (let i = 0; i < 24; i++)
      recordInsertedScript(store, PAGE, `https://cdn.test/px.js?cb=${i}`, BIG);
    recordInsertedScript(store, PAGE, "https://cdn.test/gtm.js", BIG);
    expect(learnedScriptsFor(store, PAGE)).toContain("https://cdn.test/gtm.js");
  });

  it("drops a script the origin stopped inserting after a few navigates", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/once.js", BIG);
    for (let nav = 0; nav < 3; nav++)
      expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/once.js"]);
    expect(learnedScriptsFor(store, PAGE)).toEqual([]);
  });

  it("keeps a script that keeps running from its bake", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/gtm.js", BIG);
    for (let nav = 0; nav < 6; nav++) {
      expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/gtm.js"]);
      recordInsertedScript(store, PAGE, "https://cdn.test/gtm.js", BIG, "baked");
    }
  });

  it("evicts the least recently browsed origin, not the first learned", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/a.js", BIG);
    for (let i = 1; i < 32; i++)
      recordInsertedScript(store, `https://o${i}.test/`, "https://cdn.test/x.js", BIG);
    expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/a.js"]);
    recordInsertedScript(store, "https://o32.test/", "https://cdn.test/x.js", BIG);
    expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/a.js"]);
    expect(learnedScriptsFor(store, "https://o1.test/")).toEqual([]);
  });

  it("forgets a script whose bake went stale and does not relearn it", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/volatile.js", BIG);
    recordInsertedScript(store, PAGE, "https://cdn.test/volatile.js", BIG, "stale");
    expect(learnedScriptsFor(store, PAGE)).toEqual([]);
    recordInsertedScript(store, PAGE, "https://cdn.test/volatile.js", BIG);
    expect(learnedScriptsFor(store, PAGE)).toEqual([]);
  });

  it("prefetches a query-string URL only once the origin inserts it again", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/gtm.js?id=GTM-1", BIG);
    recordInsertedScript(store, PAGE, "https://cdn.test/jsonp.js?callback=cb123", BIG);
    expect(learnedScriptsFor(store, PAGE)).toEqual([]);
    recordInsertedScript(store, PAGE, "https://cdn.test/gtm.js?id=GTM-1", BIG);
    expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/gtm.js?id=GTM-1"]);
  });

  it("forgets a script whose prefetch failed", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/gone.js", BIG);
    forgetLearnedScript(store, PAGE, "https://cdn.test/gone.js");
    expect(learnedScriptsFor(store, PAGE)).toEqual([]);
  });
});

describe("learned inserted scripts per browser context", () => {
  it("keeps contexts apart and drops a disposed context's scripts", () => {
    const store: LearnedScripts = new Map();
    recordInsertedScript(store, PAGE, "https://cdn.test/a.js", BIG, "boa", "ctx-1");
    recordInsertedScript(store, PAGE, "https://cdn.test/b.js", BIG, "boa");
    expect(learnedScriptsFor(store, PAGE, "ctx-1")).toEqual(["https://cdn.test/a.js"]);
    expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/b.js"]);
    clearLearnedScripts(store, "ctx-1");
    expect(learnedScriptsFor(store, PAGE, "ctx-1")).toEqual([]);
    expect(learnedScriptsFor(store, PAGE)).toEqual(["https://cdn.test/b.js"]);
  });
});
