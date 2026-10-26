// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BYTES_PER_MIB = 1048576;

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const HOST = process.env.KITESURF_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.KITESURF_PORT ?? "8787", 10);
const WS = `ws://${HOST}:${PORT}/devtools/browser`;
const topN = parseInt(flag("top", "25"), 10);
const htmlFile = flag("html", null);
const url = flag("url", null);
const wantShot = flag("screenshot", false) !== false || flag("shot", false) !== false;
const dumpFile = flag("dump", null);
const outFile = flag("out", null);

const SKIP_FN_PREFIXES = [
  "__memprof",
  "hooked___rustc",
  "__rust_alloc",
  "__rust_realloc",
  "__rust_dealloc",
  "__rustc[",
  "alloc::alloc",
  "<alloc::alloc",
  "alloc::raw_vec",
  "<alloc::raw_vec",
  "alloc::vec::Vec",
  "<alloc::vec::Vec",
  "alloc::boxed::Box",
  "<alloc::boxed::Box",
  "<alloc::sync::",
  "alloc::sync::",
  "<alloc::collections::",
  "alloc::collections::",
  "hashbrown::",
  "<hashbrown::",
  "core::alloc::",
];

function stripHashes(name) {
  return (name ?? "").replace(/\[[0-9a-f]{6,}\]/g, "").replace(/::h[0-9a-f]{16}$/, "");
}

function isInteresting(fn) {
  const s = stripHashes(fn);
  if (!s) return false;
  for (const p of SKIP_FN_PREFIXES) {
    if (s.startsWith(p) || s.includes(p)) return false;
  }
  return true;
}

function firstInteresting(stack) {
  for (const f of stack ?? []) {
    if (isInteresting(f.fn)) return f;
  }
  return firstStackFrame(stack);
}

function firstStackFrame(stack) {
  return (stack ?? [])[0] ?? { fn: "<empty>" };
}

function sampleKey(frame) {
  return stripHashes(frame.fn ?? "<?>");
}

function sampleCount(sample) {
  return sample.count ?? 1;
}

function sampleMaximum(sample) {
  return sample.max ?? sample.size;
}

function addSample(agg, sample) {
  const frame = firstInteresting(sample.stack);
  const key = sampleKey(frame);
  let entry = agg.get(key);
  if (!entry) {
    entry = { bytes: 0, count: 0, max: 0 };
    agg.set(key, entry);
  }
  entry.bytes += sample.size;
  entry.count += sampleCount(sample);
  const sampleMax = sampleMaximum(sample);
  if (sampleMax > entry.max) entry.max = sampleMax;
}

function printSummary(dump, totalBytes) {
  console.log(
    `Total samples: ${(dump.samples ?? []).length} | in-use: ${(dump.in_use_bytes / BYTES_PER_MIB).toFixed(2)} MiB ` +
      `(${(totalBytes / BYTES_PER_MIB).toFixed(2)} verified) | total_allocs: ${dump.total_allocs} | ` +
      `total_frees: ${dump.total_frees} | sampled_allocs: ${dump.sampled_allocs} | ` +
      `sample_rate: ${dump.sample_rate} B | elapsed: ${dump.elapsed_ms}ms`,
  );
  console.log("");
  console.log(`Top ${topN} attribution sites (by total in-use bytes):`);
  console.log(
    `${"bytes".padStart(11)}  ${"MiB".padStart(7)}  ${"count".padStart(6)}  ${"max".padStart(8)}  call site`,
  );
  console.log("-".repeat(140));
}

function printAttributionSites(agg) {
  const ranked = [...agg.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [k, v] of ranked.slice(0, topN)) {
    console.log(
      `${v.bytes.toString().padStart(11)}  ${(v.bytes / BYTES_PER_MIB).toFixed(2).padStart(7)}  ` +
        `${v.count.toString().padStart(6)}  ${v.max.toString().padStart(8)}  ${k.slice(0, 110)}`,
    );
  }
}

function analyze(dump) {
  const agg = new Map();
  let totalBytes = 0;
  for (const sample of dump.samples ?? []) {
    totalBytes += sample.size;
    addSample(agg, sample);
  }
  printSummary(dump, totalBytes);
  printAttributionSites(agg);
}

function requireCaptureInput() {
  if (!htmlFile && !url) {
    throw new Error("provide --html <file> or --url <url> (or --dump <file> to analyze only)");
  }
}

async function loadPage(session) {
  if (htmlFile) {
    const html = readFileSync(resolve(htmlFile), "utf8");
    console.error(`[memprof] setDocumentContent ${htmlFile} (${html.length} bytes)`);
    await session.send("Page.setDocumentContent", { frameId: "main", html });
  } else {
    console.error(`[memprof] navigate ${url}`);
    await session.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function captureScreenshot(session) {
  if (!wantShot) return;
  console.error("[memprof] captureScreenshot");
  await session.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
}

async function readDump(session, targetId) {
  const result = await session.send("Kitesurf.getMemprofDump", { targetId });
  const json = result?.json;
  if (typeof json !== "string") {
    throw new Error(
      `getMemprofDump returned no json (${JSON.stringify(result).slice(0, 200)}). ` +
        `Did you build with KITESURF_MEMPROF=1 for BOTH wasm and page-script?`,
    );
  }
  return JSON.parse(json);
}

async function captureDump() {
  requireCaptureInput();
  const browser = await puppeteer.connect({ browserWSEndpoint: WS });
  try {
    const page = await browser.newPage();
    const session = await page.target().createCDPSession();
    const targetId = page.target()._targetId;
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await loadPage(session);
    await captureScreenshot(session);
    return await readDump(session, targetId);
  } finally {
    await browser.disconnect();
  }
}

async function loadDump() {
  if (dumpFile && dumpFile !== true) return JSON.parse(readFileSync(dumpFile, "utf8"));
  const dump = await captureDump();
  if (outFile && outFile !== true) {
    writeFileSync(outFile, JSON.stringify(dump));
    console.error(`[memprof] wrote raw dump to ${outFile}`);
  }
  return dump;
}

async function main() {
  analyze(await loadDump());
}

main().catch((err) => {
  console.error("[memprof] fatal:", err?.stack ?? err);
  process.exit(1);
});
