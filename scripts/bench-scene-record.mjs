// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const WS = process.env.KITESURF_WS ?? "ws://127.0.0.1:8787/devtools/browser";
const ORIGIN = WS.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "");

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
const ONLY = argVal("--scenario", null);
const DURATION_MS = Number(argVal("--duration", "10")) * 1000;
const HZ = Number(argVal("--hz", "30"));
const JSON_OUT = argVal("--json", null);
const SKIP_DOOM = args.includes("--skip-doom");
const CANVAS_PUSH_MS = Number(argVal("--canvas-push-ms", "0")) | 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doomSetup(page) {
  await sleep(3000);
  if (CANVAS_PUSH_MS > 0) {
    await page
      .evaluate((ms) => {
        globalThis.__KS_CANVAS_PUSH_MS = ms;
      }, CANVAS_PUSH_MS)
      .catch(() => {});
    console.log(`  [doom] canvas push interval override: ${CANVAS_PUSH_MS}ms`);
  }
  const clicked = await page
    .evaluate(() => {
      const el =
        document.getElementById("solo") ||
        Array.from(document.querySelectorAll("a,button")).find((e) =>
          /play\s*solo|single\s*player/i.test(e.textContent || ""),
        );
      if (!el) return null;
      el.click();
      return (el.textContent || "").trim().slice(0, 60);
    })
    .catch(() => null);
  console.log(`  [doom] clicked: ${clicked ?? "(nothing found)"}`);
  await sleep(4000);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(1200);
  }
  await sleep(3000);
}

const SCENARIOS = [
  { name: "static", url: `${ORIGIN}/__fixtures/bench-static.html` },
  { name: "heavy", url: `${ORIGIN}/__fixtures/bench-heavy.html?sections=40` },
  {
    name: "heavy-mutate",
    url: `${ORIGIN}/__fixtures/bench-heavy.html?sections=40&mutate=1`,
  },
  { name: "animate", url: `${ORIGIN}/__fixtures/bench-animate.html?n=60` },
  {
    name: "doom",
    url: "https://silentspacemarine.com",
    live: true,
    setup: doomSetup,
    timeout: 45000,
  },
];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function stats1(values) {
  const s = [...values].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] ?? 0 };
}
const kb = (b) => (b / 1024).toFixed(1);

function selectTargetReply(reply) {
  if (!reply || !reply.byTarget) return reply;
  const values = Object.values(reply.byTarget);
  return values.find((value) => value && !value.error) ?? values[0] ?? null;
}

async function measure(cdp, targetId) {
  const t0 = performance.now();
  const params = targetId ? { targetId } : {};
  const reply = await cdp.send("Kitesurf.getSceneStats", params);
  const callMs = performance.now() - t0;
  return { callMs, reply: selectTargetReply(reply) };
}

async function loadScenario(page, scenario) {
  await page.setViewport({ width: 1280, height: 720 });
  await page
    .goto(scenario.url, {
      timeout: scenario.timeout ?? 20000,
      waitUntil: "load",
    })
    .catch((error) => console.log(`  [goto] ${error.message} (continuing)`));
  if (scenario.setup) await scenario.setup(page);
  else await sleep(2000);
}

function pageTargetId(page) {
  try {
    return page.target()._targetId ?? null;
  } catch {
    return null;
  }
}

function parseStats(reply) {
  try {
    return JSON.parse(reply.statsJson);
  } catch {
    return null;
  }
}

function recordMeasurementError(state, reply) {
  state.errors += 1;
  if (state.errors <= 3 && reply?.error) console.log(`  [err] ${reply.error}`);
}

function hasStatsPayload(reply) {
  return Boolean(reply && !reply.error && reply.statsJson);
}

function recordFrame(state, callMs, reply, stats) {
  state.frames.push({
    callMs,
    prepMs: reply.prepMs ?? 0,
    recordMs: reply.recordMs ?? 0,
    seq: reply.seq ?? 0,
    seqAdvanced: reply.seq > state.prevSeq,
    sceneBytes: stats.sceneBytes,
    gzBytes: stats.sceneBytesGzipped,
    opCount: stats.opCount,
    imageRgba: stats.imageRgbaBytesTotal,
    bytesByKind: stats.bytesByKind,
  });
  state.prevSeq = reply.seq ?? state.prevSeq;
}

async function collectMeasurement(cdp, targetId, state) {
  const { callMs, reply } = await measure(cdp, targetId).catch(() => ({
    callMs: 0,
    reply: null,
  }));
  if (!hasStatsPayload(reply)) {
    recordMeasurementError(state, reply);
    return;
  }
  const stats = parseStats(reply);
  if (!stats) {
    state.errors += 1;
    return;
  }
  recordFrame(state, callMs, reply, stats);
}

async function collectFrames(cdp, targetId, state) {
  const interval = 1000 / HZ;
  const startedAt = performance.now();
  let next = startedAt;
  while (performance.now() - startedAt < DURATION_MS) {
    await collectMeasurement(cdp, targetId, state);
    next += interval;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    else next = performance.now();
  }
  return performance.now() - startedAt;
}

async function runScenario(browser, scenario) {
  console.log(`\n=== ${scenario.name} — ${scenario.url}`);
  const page = await browser.newPage();
  const state = { frames: [], errors: 0, prevSeq: -1 };
  try {
    await loadScenario(page, scenario);
    const cdp = await page.createCDPSession();
    const elapsed = await collectFrames(cdp, pageTargetId(page), state);
    report(scenario.name, state.frames, state.errors, elapsed);
    return { name: scenario.name, elapsedMs: elapsed, errors: state.errors, frames: state.frames };
  } finally {
    await page.close().catch(() => {});
  }
}

function report(name, frames, errors, elapsedMs) {
  if (!frames.length) {
    console.log(`  no frames (errors=${errors})`);
    return;
  }
  const hz = ((frames.length / elapsedMs) * 1000).toFixed(1);
  const rec = stats1(frames.map((f) => f.recordMs));
  const prep = stats1(frames.map((f) => f.prepMs));
  const call = stats1(frames.map((f) => f.callMs));
  const raw = stats1(frames.map((f) => f.sceneBytes));
  const gz = stats1(frames.map((f) => f.gzBytes));
  const ops = stats1(frames.map((f) => f.opCount));
  const img = stats1(frames.map((f) => f.imageRgba));
  const adv = frames.filter((f) => f.seqAdvanced).length;
  console.log(
    `  frames=${frames.length} errors=${errors} achieved=${hz}Hz ` +
      `seqAdvanced=${((adv / frames.length) * 100).toFixed(0)}%`,
  );
  console.log(
    `  recordMs p50=${rec.p50} p95=${rec.p95} max=${rec.max} | ` +
      `prepMs p50=${prep.p50} p95=${prep.p95} | ` +
      `callMs p50=${call.p50.toFixed(1)} p95=${call.p95.toFixed(1)}`,
  );
  console.log(
    `  scene p50=${kb(raw.p50)}KB gz=${kb(gz.p50)}KB ops=${ops.p50} ` +
      `imgRGBA=${kb(img.p50)}KB | gz@30Hz=${kb(gz.p50 * 30)}KB/s`,
  );
  const mid = frames[Math.floor(frames.length / 2)];
  if (mid?.bytesByKind) {
    const kinds = Object.entries(mid.bytesByKind)
      .filter(([, v]) => v.b > 0)
      .sort((a, b) => b[1].b - a[1].b)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${kb(v.b)}KB(${v.c})`);
    console.log(`  byKind(median frame): ${kinds.join(" ")}`);
  }
}

const browser = await puppeteer.connect({
  browserWSEndpoint: WS,
  protocolTimeout: 60000,
});
let exitCode = 0;
const results = [];
try {
  console.log(`engine: ${WS}  duration=${DURATION_MS / 1000}s hz=${HZ}`);
  for (const s of SCENARIOS) {
    if (ONLY && s.name !== ONLY) continue;
    if (s.live && SKIP_DOOM) {
      console.log(`\n=== ${s.name} — skipped (--skip-doom)`);
      continue;
    }
    try {
      results.push(await runScenario(browser, s));
    } catch (e) {
      console.log(`  scenario failed: ${e.message}`);
      exitCode = 1;
    }
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
} finally {
  await browser.disconnect().catch(() => {});
}
process.exit(exitCode);
