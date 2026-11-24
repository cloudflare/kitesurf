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
  JP: {
    url: "NotoSansCJKjp-Regular.shaping.otf",
    fallback: "NotoSansCJKjp-Regular.woff2",
    size: 2100,
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
  "register_cjk_region_font",
  "register_script_font",
];

// core's NOTO_PROFILE (packages/core/src/resources/fonts.rs), in register_ua_fonts face order.
const NOTO_PROFILE = {
  faces: [
    "/fonts/NotoSans.ttf",
    "/fonts/NotoSans-Italic.ttf",
    "",
    "",
    "/fonts/NotoSerif.ttf",
    "",
    "",
    "",
    "",
  ],
  serifOnDemand: true,
  latinFallback: false,
};

const uaCall = (serif = 0, mono = 0) => [
  "register_ua_fonts",
  size("sans"),
  size("sansItalic"),
  0,
  0,
  serif,
  0,
  0,
  0,
  0,
  mono,
  "noto",
];
const symbolsCall = (symbols2 = 0) => ["register_symbol_fonts", size("symbols"), symbols2];
const emojiCall = ["register_emoji_font", size("emoji")];
const cjkCall = ["register_cjk_font", size("cjk")];
const cjkRegionCall = (region) => ["register_cjk_region_font", size(region), region];
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
  wasmGlue.uaFontProfile = (name) => (name === "noto" ? JSON.stringify(NOTO_PROFILE) : "");
  return { calls, wasmGlue };
}

// Each fresh VM context is one page isolate with deferred fonts, pixel-free unless `lazy`, where
// the full-font upgrade finds no recorded face and finishes at once.
function loadFontLoader(outcomes = {}, { lazy = false } = {}) {
  const { calls, wasmGlue } = registrationRecorder(outcomes);
  if (lazy) {
    Object.assign(wasmGlue, {
      setFontShapingLazy: () => {},
      pendingLazyFontPaths: () => [],
      upgradeFontFace: () => false,
      finishFontUpgrade: () => true,
    });
  }
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
    "./native-scheduling.ts": dependency({ NativePromise: Promise }),
    "./startup-probe.ts": dependency({
      startupFontDefer: true,
      startupFontProfile: "noto",
      startupPixelFree: !lazy,
    }),
    "./source-scan.ts": dependency({
      CJK_REGION_SCANS: sourceScan.CJK_REGION_SCANS,
      CJK_SCAN: sourceScan.CJK_SCAN,
      EMOJI_BMP_SCAN: sourceScan.EMOJI_BMP_SCAN,
      SCRIPT_RANGES: sourceScan.SCRIPT_RANGES,
      SYMBOL_SCAN: sourceScan.SYMBOL_SCAN,
      SYMBOLS2_EXCLUSIVE: sourceScan.SYMBOLS2_EXCLUSIVE,
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
    arriveFull: (face) => {
      const url = ASSET_ORIGIN + FACES[face].fallback;
      const resolve = pending.get(url);
      assert.ok(resolve, `${url} was not requested`);
      pending.delete(url);
      resolve(response(200, size(face) + 1));
    },
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
  const faces = Object.keys(FACES).filter((face) => !["Hebr", "Deva", "JP"].includes(face));
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

test("numeric character references want the symbol faces", () => {
  const page = loadFontLoader();
  const wants = scan("<div>&#x21BB; &#x25BE;</div>");
  assert.equal(wants.symbols, true);
  assert.equal(wants.symbols2, true);
  page.loader.startFontPrefetch(wants);
  for (const face of ["symbols", "symbols2"]) {
    assert.ok(page.requested.includes(ASSET_ORIGIN + FACES[face].url), `${face} prefetched`);
  }
});

test("only uncommon named references ask for a parsed-text probe", () => {
  for (const html of [
    "<p>a &amp; b &nbsp;&copy; &eacute;&mdash;&rsquo;&AElig;</p>",
    "<p>&#x2713;</p>",
  ]) {
    assert.equal(scan(html).namedRefs, false, html);
  }
  for (const html of ["<p>&check;</p>", "<p>&sum;</p>", "<p>&olarr; &amp;</p>"]) {
    assert.equal(scan(html).namedRefs, true, html);
  }
});

test("a page with named references probes its parsed text once", () => {
  for (const [html, wantsProbe] of [
    ["<p>&check;</p>", true],
    ["<p>&amp;</p>", false],
  ]) {
    const page = loadFontLoader();
    page.loader.startFontPrefetch(scan(html));
    let probes = 0;
    // The parse wrote non-Latin text before noteNavigateText; nothing writes after it.
    const dom = {
      nonLatinTextWrites: () => 1,
      textUsesCodepoints: () => (probes++, false),
    };
    page.loader.noteNavigateText(dom);
    page.loader.demandFacesForScriptText(dom);
    assert.equal(probes > 0, wantsProbe, `${html} probed at the first paint`);
    const afterFirst = probes;
    page.loader.demandFacesForScriptText(dom);
    assert.equal(probes, afterFirst, `${html} probed again without a new write`);
  }
});

test("the probe leaves faces the deferred stash is fetching to the stash", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan("<p>&#x2191; &#x25BE;</p>"));
  const dom = { nonLatinTextWrites: () => 1, textUsesCodepoints: () => true };
  page.loader.demandFacesForScriptText(dom);
  for (const face of ["symbols", "symbols2"]) {
    const url = ASSET_ORIGIN + FACES[face].url;
    assert.equal(page.requested.filter((u) => u === url).length, 1, `${face} fetched once`);
  }
});

test("a script-built symbol escape stays invisible to the source scan", () => {
  assert.equal(scan('<script>d.textContent = "\\u21BB";</script>').symbols, false);
});

// The demand probe reads the document's own codepoints, so text a script built from escapes
// still loads its faces. Ranges arrive as [start, end, …] pairs; a probe answers by first pair.
test("script-inserted symbol text demands its faces, in phases", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan("<p>latin only</p>"));
  page.arrive("sans", "sansItalic");
  await page.loader.awaitDeferredFontBytes();
  assert.equal(page.loader.demandDeferredFonts(), true);
  assert.deepEqual(page.calls, [uaCall()]);

  // U+2191 sits in the symbol scan; U+25BE is Symbols-2-only.
  const hit = (start) => (ranges) => ranges.length >= 2 && ranges[0] === start;
  let writes = 0;
  let hasSymbols2Text = false;
  const dom = {
    nonLatinTextWrites: () => ++writes,
    textUsesCodepoints: (ranges) => hit(0x2100)(ranges) || (hasSymbols2Text && hit(0x21af)(ranges)),
  };

  page.loader.demandFacesForScriptText(dom);
  page.arrive("symbols");
  await drainFetchCallbacks();
  assert.deepEqual(page.calls, [uaCall(), ["register_symbol_fonts", size("symbols"), 0]]);

  // A later write of Symbols-2-only text registers the second face beside the first.
  hasSymbols2Text = true;
  page.loader.demandFacesForScriptText(dom);
  await drainFetchCallbacks();
  page.arrive("symbols2");
  await drainFetchCallbacks();
  assert.deepEqual(page.calls, [
    uaCall(),
    ["register_symbol_fonts", size("symbols"), 0],
    ["register_symbol_fonts", 0, size("symbols2")],
  ]);
});

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

test("the Latn script face stays off under a profile without a Latin fallback", () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan("<p>\uFB00 \uA730</p>"));
  const sans = page.requested.filter((url) => url === ASSET_ORIGIN + FACES.sans.url);
  assert.equal(sans.length, 1);
});

test("a lang=ja page stages the JP Han face beside SC and releases it on demand", async () => {
  const page = loadFontLoader();
  page.loader.startFontPrefetch(scan('<html lang="ja"><p>日本</p></html>'));
  page.arrive("sans", "sansItalic", "cjk", "JP");
  await page.loader.awaitDeferredFontBytes();

  assert.equal(page.loader.demandDeferredFonts(), true);
  assertRegistered(page.calls, uaCall(), [cjkCall, cjkRegionCall("JP")]);
  assert.equal(page.heldBytes(), 0);
});

test("a regional CJK face core declines before the UA faces register is retried", async () => {
  const page = loadFontLoader({ "register_cjk_region_font:JP": false });
  page.loader.startFontPrefetch(scan(""));
  let writes = 0;
  // Only the kana ranges match, so the demand asks for the JP face alone.
  const dom = {
    nonLatinTextWrites: () => ++writes,
    textUsesCodepoints: (ranges) => ranges.length === 6 && ranges[4] === 0xff66,
  };
  const jpUrl = ASSET_ORIGIN + FACES.JP.url;
  for (let demand = 1; demand <= 2; demand++) {
    page.loader.demandFacesForScriptText(dom);
    page.arrive("JP");
    await drainFetchCallbacks();
    assert.equal(page.requested.filter((url) => url === jpUrl).length, demand);
    assert.equal(page.calls.filter(([name]) => name === "register_cjk_region_font").length, demand);
  }
});

test("the source scan finds regional CJK from lang attributes and decoded kana", () => {
  const regions = (html) => [...scan(html).cjkRegions];
  assert.deepEqual(regions("<p>日本かな</p>"), ["JP"]);
  assert.deepEqual(regions("<p>日本&#x304B;&#12394;</p>"), ["JP"]);
  assert.equal(scan("<p>&#x4E2D;&#25991;</p>").cjk, true);
  assert.deepEqual(regions('<html lang="ja"><p>日本</p>'), ["JP"]);
  assert.deepEqual(regions("<p xml:lang=ja>日本</p>"), ["JP"]);
  assert.deepEqual(regions('<a lang="zh-Hant">中文</a>'), ["TC"]);
  assert.deepEqual(regions('<html lang="ja_JP"><p>日本</p>'), ["JP"]);
  assert.deepEqual(regions("<p class=x lang=zh_TW>中文</p>"), ["TC"]);
  for (const html of [
    '<div data-lang="ja">Japanese</div>',
    '<a href="/?lang=ja">Japanese</a>',
    '<link rel=alternate hreflang="ja" href="/ja/">',
    '<p lang="jam">Patwa</p>',
    "<p>Set lang=ja on the root element.</p>",
    '<pre>&lt;p lang="ja"&gt;</pre>',
    '<a title="lang=ja">docs</a>',
  ]) {
    assert.deepEqual(regions(html), [], html);
  }
});

test("a CJK face whose shaping file lands after the full-font upgrade registers its full file", async () => {
  const page = loadFontLoader({}, { lazy: true });
  page.loader.startFontPrefetch(scan(""));
  assert.equal(page.loader.fontLoaderMode(), "lazy");
  const dom = {
    nonLatinTextWrites: () => 1,
    textUsesCodepoints: (ranges) => ranges.length === 6 && ranges[4] === 0xff66,
  };
  page.loader.demandFacesForScriptText(dom);
  await page.loader.upgradeToFullFonts();
  assert.equal(page.loader.fontLoaderMode(), "full");
  page.arrive("JP");
  await drainFetchCallbacks();
  page.arriveFull("JP");
  await drainFetchCallbacks();
  assert.deepEqual(
    page.calls.filter(([name]) => name === "register_cjk_region_font"),
    [["register_cjk_region_font", size("JP") + 1, "JP"]],
  );
});
