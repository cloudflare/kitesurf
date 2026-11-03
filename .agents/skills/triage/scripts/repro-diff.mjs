// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one bug reproduction in Kitesurf and in Chrome, then diff the two:
// screenshots, pixel diff, return values, console and page errors.
// Usage, the --script contract and exit codes: ../reproduce.md, step 5.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const args = parseArgs(process.argv.slice(2));
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
// A value flag given with no value parses as `true`; treat that, an empty
// value, an unreadable input or a bad URL as a usage error (exit 2).
if (["out", "html", "url", "script"].some((k) => k in args && !isNonEmptyString(args[k]))) {
  usage("a flag is missing its value");
}
if (!args.out || (!args.html && !args.url)) usage("need --out and --html or --url");
if (args.url && !URL.canParse(args.url)) usage(`not a URL: ${args.url}`);

const OUT = resolve(args.out);
const WIDTH = positiveInt("--width", args.width ?? 1280);
const HEIGHT = positiveInt("--height", args.height ?? 800);
const SETTLE_MS = positiveInt("--settle-ms", args["settle-ms"] ?? 250, true);
const PORT = positiveInt("KITESURF_PORT", process.env.KITESURF_PORT ?? 8787);
const ENGINE_WS = `ws://127.0.0.1:${PORT}/devtools/browser`;
const NAV_TIMEOUT_MS = 30_000;
// A hung repro script must not hold the triage job until its own timeout.
const SCRIPT_TIMEOUT_MS = 60_000;

mkdirSync(OUT, { recursive: true });

const html = args.html
  ? await readInput("--html", () => readFileSync(resolve(args.html), "utf8"))
  : null;
const target =
  html !== null ? `data:text/html;charset=utf-8,${encodeURIComponent(html)}` : args.url;
// Chrome treats data: URLs as non-secure, which hides secure-context APIs
// (crypto.subtle, clipboard...) and skews the witness. Serve the markup to
// Chrome from http://localhost/, a secure context, by request interception.
const CHROME_HTML_URL = "http://localhost/__repro.html";
const CHROME_FAVICON_URL = "http://localhost/favicon.ico";
const repro = args.script
  ? await readInput("--script", async () => {
      const fn = (await import(pathToFileURL(resolve(args.script)).href)).default;
      if (typeof fn !== "function") throw new Error("has no default-exported function");
      return fn;
    })
  : null;

const summary = {
  target: html !== null ? args.html : args.url,
  viewport: { width: WIDTH, height: HEIGHT },
  kitesurf: null,
  chrome: null,
};

summary.kitesurf = await runOne(
  "kitesurf",
  () => puppeteer.connect({ browserWSEndpoint: ENGINE_WS }),
  true,
);
let chromeMissing = false;
if (!args["engine-only"]) {
  const chromePath = findChrome();
  chromeMissing = !chromePath;
  summary.chrome = chromePath
    ? await runOne(
        "chrome",
        () =>
          puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] }),
        false,
      )
    : { ok: false, error: "Chrome not found. Set CHROME_PATH." };
}

if (summary.kitesurf.ok && summary.chrome?.ok) {
  summary.diff = diffScreenshots();
  summary.outputsEqual = isDeepStrictEqual(summary.kitesurf.output, summary.chrome.output);
}
writeFileSync(resolve(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

// Exit 2 only when a browser never started. A Kitesurf crash after it
// connected is a finding, not an infrastructure problem.
const infraFailed =
  summary.kitesurf.stage === "connect" || summary.chrome?.stage === "connect" || chromeMissing;
process.exit(infraFailed ? 2 : 0);

async function runOne(label, open, isEngine) {
  const console_ = [];
  const pageErrors = [];
  let browser;
  let stage = "connect";
  try {
    browser = await open();
    stage = "run";
    const page = await browser.newPage();
    page.on("console", (m) => console_.push({ type: m.type(), text: m.text() }));
    page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    let url = target;
    if (html !== null && !isEngine) {
      url = CHROME_HTML_URL;
      await page.setRequestInterception(true);
      // Chrome asks for /favicon.ico on its own; a refused connection would
      // show up as a console error that Kitesurf never logs.
      page.on("request", (req) => {
        if (req.url() === CHROME_HTML_URL) {
          void req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        } else if (req.url() === CHROME_FAVICON_URL) {
          void req.respond({ status: 204, body: "" });
        } else {
          void req.continue();
        }
      });
    }
    const started = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    const loadMs = Date.now() - started;
    const output = repro ? await withTimeout(repro(page, { browser, label })) : null;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const png = await page.screenshot({ type: "png" });
    writeFileSync(resolve(OUT, `${label}.png`), png);
    const result = { ok: true, loadMs, output, console: console_, pageErrors };
    writeFileSync(resolve(OUT, `${label}.json`), JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    const error = String(err?.stack ?? err);
    const result = { ok: false, stage, error, console: console_, pageErrors };
    writeFileSync(resolve(OUT, `${label}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    // Disconnect from the engine (never close it: it is a shared dev
    // server), but close the Chrome we launched.
    if (browser) await (isEngine ? browser.disconnect() : browser.close()).catch(() => {});
  }
}

function usage(problem) {
  console.error(problem);
  console.error(
    "usage: repro-diff.mjs --out <dir> (--html <file> | --url <url>) [--script <repro.mjs>]",
  );
  process.exit(2);
}

async function readInput(flag, read) {
  try {
    return await read();
  } catch (err) {
    return usage(`${flag}: ${err?.message ?? err}`);
  }
}

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`repro script took over ${SCRIPT_TIMEOUT_MS} ms`)),
      SCRIPT_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function positiveInt(name, value, allowZero = false) {
  const n = /^\d+$/.test(String(value)) && value !== true ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    console.error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
    process.exit(2);
  }
  return n;
}

function diffScreenshots() {
  const a = PNG.sync.read(readFileSync(resolve(OUT, "kitesurf.png")));
  const b = PNG.sync.read(readFileSync(resolve(OUT, "chrome.png")));
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, kitesurf: [a.width, a.height], chrome: [b.width, b.height] };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  writeFileSync(resolve(OUT, "diff.png"), PNG.sync.write(diff));
  return {
    comparable: true,
    diffPixels: pixels,
    diffRatio: Number((pixels / (a.width * a.height)).toFixed(4)),
  };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}
