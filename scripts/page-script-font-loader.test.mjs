// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Match packages/page-script/tsconfig.json: an ES5 default target downlevels Map for-of to zero
// iterations without downlevelIteration.
const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};
const transpile = (file) =>
  ts.transpileModule(
    readFileSync(new URL(`../packages/page-script/src/${file}`, import.meta.url), "utf8"),
    { compilerOptions },
  ).outputText;
const fontLoaderCode = transpile("font-loader.ts");
const sourceScan = {};
runInContext(transpile("source-scan.ts"), createContext({ exports: sourceScan }));
// The loader takes the engine's scan of the page source.
const scan = (html) => sourceScan.scanSourceFonts(html);

const ASSET_ORIGIN = "http://kitesurf-fonts/fonts/";

// Pixel-free startup requests shaping variants first. Distinct sizes identify retained faces.
const FACES = {
  sans: { url: "NotoSans.shaping.otf", fallback: "NotoSans.ttf", size: 1000 },
  sansItalic: { url: "NotoSans-Italic.shaping.otf", fallback: "NotoSans-Italic.ttf", size: 1100 },
  serif: { url: "NotoSerif.shaping.otf", fallback: "NotoSerif.ttf", size: 1200 },
  mono: { url: "NotoSansMono.shaping.otf", fallback: "NotoSansMono.ttf", size: 1300 },
  symbols: { url: "NotoSansSymbols.shaping.otf", fallback: "NotoSansSymbols.ttf", size: 1400 },
  symbols2: { url: "NotoSansSymbols2.shaping.otf", fallback: "NotoSansSymbols2.ttf", size: 1500 },
  emoji: { url: "noto-color-emoji.shaping.otf", fallback: "noto-color-emoji.woff2", size: 1600 },
  cjk: {
    url: "NotoSansCJKsc-Regular.shaping.otf",
    fallback: "NotoSansCJKsc-Regular.woff2",
    size: 1700,
  },
  Arab: { url: "NotoSansArabic.shaping.otf", fallback: "NotoSansArabic.ttf", size: 1800 },
  Hebr: { url: "NotoSansHebrew.shaping.otf", fallback: "NotoSansHebrew.ttf", size: 1900 },
  Deva: { url: "NotoSansDevanagari.shaping.otf", fallback: "NotoSansDevanagari.ttf", size: 2000 },
};
const size = (face) => FACES[face].size;

const REGISTER_EXPORTS = [
  "register_ua_fonts",
  "register_emoji_font",
  "register_symbol_fonts",
  "register_cjk_font",
  "register_script_font",
];

const uaCall = (serif = 0, mono = 0) => [
  "register_ua_fonts",
  size("sans"),
  size("sansItalic"),
  serif,
  mono,
];
const symbolsCall = (symbols2 = 0) => ["register_symbol_fonts", size("symbols"), symbols2];
const emojiCall = ["register_emoji_font", size("emoji")];
const cjkCall = ["register_cjk_font", size("cjk")];
const scriptCall = (tag) => ["register_script_font", size(tag), tag];

function dependency(values = {}) {
  return new Proxy(
    { __esModule: true, ...values },
    {
      get(target, key) {
        if (!Object.hasOwn(target, key))
          throw new Error(`Unexpected dependency use: ${String(key)}`);
        return target[key];
      },
    },
  );
}

function response(status, byteLength = 0) {
  return {
    ok: status === 200,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  };
}

// Sums every byte view reachable from the loader's staging record.
function stagedBytes(value) {
  if (value === null || value === undefined) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value.values === "function") {
    let total = 0;
    for (const entry of value.values()) total += stagedBytes(entry);
    return total;
  }
  return typeof value === "object" ? stagedBytes(new Map(Object.entries(value))) : 0;
}

// Records every registration call, keyed by export name or `register_script_font:<tag>`, and
// answers each with the outcome from `outcomes`: true, false or "throw".
function registrationRecorder(outcomes) {
  const calls = [];
  const register =
    (name) =>
    (...args) => {
      const tag = typeof args[1] === "string" ? args[1] : null;
      calls.push([name, ...args.map((arg) => (typeof arg === "string" ? arg : arg.byteLength))]);
      const outcome = outcomes[tag ? `${name}:${tag}` : name] ?? true;
      if (outcome === "throw") throw new Error(`${name} rejected the font`);
      return outcome;
    };
  const wasmGlue = Object.fromEntries(REGISTER_EXPORTS.map((name) => [name, register(name)]));
  return { calls, wasmGlue };
}

// Each fresh VM context is one page isolate with pixel-free deferred fonts.
function loadFontLoader(outcomes = {}) {
  const { calls, wasmGlue } = registrationRecorder(outcomes);
  const requested = [];
  const pending = new Map();
  const failing = new Set();

  const fetch = (url) => {
    requested.push(url);
    if (failing.has(url)) return Promise.resolve(response(404));
    return new Promise((resolve) => pending.set(url, resolve));
  };
  const respond = (face, result) => {
    const url = ASSET_ORIGIN + FACES[face].url;
    const resolve = pending.get(url);
    assert.ok(resolve, `${url} was not requested`);
    pending.delete(url);
    resolve(result);
  };

  const modules = {
    "./wasm-glue.js": dependency(wasmGlue),
    "./native-scheduling.ts": dependency(),
    "./startup-probe.ts": dependency({ startupFontDefer: true, startupPixelFree: true }),
    "./source-scan.ts": dependency({
      CJK_SCAN: sourceScan.CJK_SCAN,
      EMOJI_BMP_SCAN: sourceScan.EMOJI_BMP_SCAN,
      SCRIPT_RANGES: sourceScan.SCRIPT_RANGES,
    }),
  };
  const require = (name) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  };

  const exports = {};
  const context = createContext({ exports, require, fetch, console: { log() {}, warn() {} } });
  runInContext(fontLoaderCode, context);

  return {
    loader: exports,
    calls,
    requested,
    arrive: (...faces) => faces.forEach((face) => respond(face, response(200, size(face)))),
    fail: (face) => {
      failing.add(ASSET_ORIGIN + FACES[face].fallback);
      respond(face, response(404));
    },
    heldBytes: () => stagedBytes(runInContext("deferStash", context)),
  };
}

// Fetch completions chain only microtasks, so one macrotask turn drains them.
const drainFetchCallbacks = () => new Promise((resolve) => setImmediate(resolve));

const byCall = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));

function assertRegistered(calls, core, groups) {
  assert.deepEqual(calls[0], core);
  assert.deepEqual(calls.slice(1).sort(byCall), [...groups].sort(byCall));
}

test("bytes-only prefetch stages without registering; demand releases groups", async () => {
  const page = loadFontLoader();
  const faces = Object.keys(FACES).filter((face) => face !== "Hebr" && face !== "Deva");
  page.loader.startFontPrefetch(
    scan('<p style="font-family: serif">中 ع 😀</p><pre>x</pre><ul><li>a</li></ul>'),
  );
  page.arrive(...faces);
  await page.loader.awaitDeferredFontBytes();

  assert.equal(page.loader.fontDemandFired(), false);
  assert.deepEqual(page.calls, []);
  assert.equal(
    page.heldBytes(),
    faces.reduce((total, face) => total + size(face), 0),
  );

  assert.equal(page.loader.demandDeferredFonts(), true);
  assertRegistered(page.calls, uaCall(size("serif"), size("mono")), [
    symbolsCall(size("symbols2")),
    emojiCall,
    cjkCall,
    scriptCall("Arab"),
  ]);
  assert.equal(page.heldBytes(), 0);
  assert.equal(page.loader.demandDeferredFonts(), true);
  assert.equal(page.calls.length, 5);
});

test("demand before arrival degrades, then core and groups register once on arrival", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan("← 😀"));

  assert.equal(page.loader.demandDeferredFonts(), false);
  assert.equal(page.loader.deferredDegradedReads(), 1);

  page.arrive("emoji", "sans");
  await drainFetchCallbacks();

  assert.deepEqual(page.calls, []);
  assert.equal(page.loader.fontsDeferredUnregistered(), true);

  page.arrive("sansItalic");
  await drainFetchCallbacks();

  assert.deepEqual(page.calls, [uaCall(), emojiCall]);
  assert.equal(page.heldBytes(), 0);

  page.arrive("symbols");
  await drainFetchCallbacks();

  assert.deepEqual(page.calls, [uaCall(), emojiCall, symbolsCall()]);
  assert.equal(page.heldBytes(), 0);
  assert.equal(page.loader.demandDeferredFonts(), true);
  assert.equal(page.calls.length, 3);
  assert.equal(page.loader.deferredDegradedReads(), 1);
  assert.equal(page.loader.fontsDeferredUnregistered(), false);
});

for (const [first, second] of [
  ["symbols", "symbols2"],
  ["symbols2", "symbols"],
]) {
  test(`symbol pair stages ${first} until ${second} arrives, then releases both`, async () => {
    const page = loadFontLoader();
    page.loader.startFontPrefetch(scan("<ul><li>item</li></ul>"));
    page.arrive("sans", "sansItalic");
    await drainFetchCallbacks();
    assert.equal(page.loader.demandDeferredFonts(), true);

    page.arrive(first);
    await drainFetchCallbacks();
    assert.deepEqual(page.calls, [uaCall()]);
    assert.equal(page.heldBytes(), size(first));

    page.arrive(second);
    await drainFetchCallbacks();
    assert.deepEqual(page.calls, [uaCall(), symbolsCall(size("symbols2"))]);
    assert.equal(page.heldBytes(), 0);
  });
}

test("script faces release only successful registrations and skip no entry", async () => {
  const page = loadFontLoader({ "register_script_font:Hebr": false });
  page.loader.startFontPrefetch(scan("<p>ع ש क</p>"));
  page.arrive("sans", "sansItalic", "Arab", "Hebr", "Deva");
  await page.loader.awaitDeferredFontBytes();

  assert.equal(page.loader.demandDeferredFonts(), true);
  assertRegistered(page.calls, uaCall(), ["Arab", "Hebr", "Deva"].map(scriptCall));
  assert.equal(page.heldBytes(), size("Hebr"));
  assert.equal(page.loader.demandDeferredFonts(), true);
  assert.equal(page.calls.length, 4);
  assert.equal(page.heldBytes(), size("Hebr"));
});

const CORE_BYTES = size("sans") + size("sansItalic");
for (const scenario of [
  {
    name: "core registration returning false",
    outcomes: { register_ua_fonts: false },
    demanded: true,
    calls: [uaCall(), emojiCall],
    held: CORE_BYTES,
    degradedReads: 0,
    unregistered: false,
  },
  {
    name: "core registration throwing",
    outcomes: { register_ua_fonts: "throw" },
    demanded: false,
    calls: [uaCall()],
    held: CORE_BYTES + size("emoji"),
    degradedReads: 2,
    unregistered: true,
  },
  {
    name: "optional registration returning false",
    outcomes: { register_emoji_font: false },
    demanded: true,
    calls: [uaCall(), emojiCall],
    held: size("emoji"),
    degradedReads: 0,
    unregistered: false,
  },
  {
    name: "optional registration throwing",
    outcomes: { register_emoji_font: "throw" },
    demanded: true,
    calls: [uaCall(), emojiCall],
    held: size("emoji"),
    degradedReads: 0,
    unregistered: false,
  },
]) {
  test(`${scenario.name} keeps its bytes and is not retried on repeated demand`, async () => {
    const page = loadFontLoader(scenario.outcomes);
    page.loader.startFontPrefetch(scan("😀"));
    page.arrive("sans", "sansItalic", "emoji");
    await page.loader.awaitDeferredFontBytes();

    for (let demand = 0; demand < 2; demand++) {
      assert.equal(page.loader.demandDeferredFonts(), scenario.demanded);
      assert.deepEqual(page.calls, scenario.calls);
      assert.equal(page.heldBytes(), scenario.held);
    }
    assert.equal(page.loader.deferredDegradedReads(), scenario.degradedReads);
    assert.equal(page.loader.fontsDeferredUnregistered(), scenario.unregistered);
  });
}

test("awaitDeferredFonts arms demand before bytes arrive and never refetches", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan(""));
  const registered = page.loader.awaitDeferredFonts();

  assert.equal(page.loader.fontDemandFired(), true);
  assert.deepEqual(page.calls, []);

  page.arrive("sans", "sansItalic");
  await registered;

  assert.deepEqual(page.calls, [uaCall()]);
  assert.equal(page.heldBytes(), 0);

  const requests = page.requested.length;
  await page.loader.awaitDeferredFonts();

  assert.equal(page.requested.length, requests);
  assert.deepEqual(page.calls, [uaCall()]);
});

for (const [failed, delivered] of [
  ["serif", "mono"],
  ["mono", "serif"],
]) {
  test(`${failed} fetch failure registers core with empty ${failed} bytes`, async () => {
    const page = loadFontLoader();
    page.loader.startFontPrefetch(scan('<p style="font-family: serif">x</p><pre>x</pre>'));
    page.arrive("sans", "sansItalic", delivered);
    page.fail(failed);
    await page.loader.awaitDeferredFontBytes();

    assert.equal(page.loader.demandDeferredFonts(), true);
    const optional = { serif: size("serif"), mono: size("mono"), [failed]: 0 };
    assert.deepEqual(page.calls, [uaCall(optional.serif, optional.mono)]);
    assert.equal(page.heldBytes(), 0);
  });
}

// `sans-serif` alone wants no serif face, but the space it stands for still bounds a word.
for (const [html, wantsSerif] of [
  ['<p style="font-family: Arial, sans-serif">x</p>', false],
  ['<p style="font-family: SANS-SERIF">x</p><b class="serifs">y</b>', false],
  ['<p style="font-family: sans-serif, serif">x</p>', true],
  ["<p>sans-serifserif</p>", true],
]) {
  test(`serif prefetch for ${JSON.stringify(html)} is ${wantsSerif}`, () => {
    const page = loadFontLoader();
    page.loader.startFontPrefetch(scan(html));
    assert.equal(page.requested.includes(ASSET_ORIGIN + FACES.serif.url), wantsSerif);
  });
}

test("core fetch failure keeps reads degraded without registering", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan(""));
  page.fail("sans");
  page.arrive("sansItalic");
  await page.loader.awaitDeferredFontBytes();

  assert.equal(page.loader.demandDeferredFonts(), false);
  assert.equal(page.loader.demandDeferredFonts(), false);
  assert.deepEqual(page.calls, []);
  assert.equal(page.heldBytes(), size("sansItalic"));
  assert.equal(page.loader.deferredDegradedReads(), 2);
  assert.equal(page.loader.fontsDeferredUnregistered(), true);
});
