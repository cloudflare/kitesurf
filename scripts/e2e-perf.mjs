// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ARGS = parseArgs(process.argv.slice(2));
const HOST = ARGS.host ?? "127.0.0.1";
const PORT = intArg(ARGS.port, 8787);
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const WS = `ws://${HOST}:${PORT}/devtools/browser`;
const URL = ARGS.url ?? process.env.KITESURF_URL ?? `http://${HOST}:${PORT}/__fixtures/events.html`;
const ITERATIONS = intArg(ARGS.iterations, 5);
const WARMUP = intArg(ARGS.warmup, 1);
const INTERACTION = (ARGS.interaction ?? "click").toLowerCase();
const SELECTOR = ARGS.selector ?? "body";
const KEY = ARGS.key ?? "Enter";
const NO_SCREENCAST = "no-screencast" in ARGS;
const USE_RUNNING = "use-running-server" in ARGS;
const JSON_OUT = ARGS.json ?? null;

const SCREENCAST_POLL_FLOOR_MS = 100;

const SERVER_BOOT_TIMEOUT_MS = 60_000;

const FIRST_FRAME_TIMEOUT_MS = 30_000;
const RENDER_AFTER_TIMEOUT_MS = 5_000;
const SERVER_HEALTH_POLL_INTERVAL_MS = 250;
const SERVER_TERM_GRACE_MS = 500;
const SERVER_POST_KILL_SETTLE_MS = 200;
const SERVER_STDERR_TAIL_LIMIT_CHARS = 4000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function intArg(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const green = (s) => c(32, s);

function stats(samples) {
  const clean = samples.filter((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  const n = clean.length;
  if (n === 0) return { n: 0 };
  const sorted = clean.slice().sort((a, b) => a - b);
  const mean = clean.reduce((a, b) => a + b, 0) / n;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = (p) => {
    if (n === 1) return sorted[0];
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    n,
    mean: +mean.toFixed(2),
    stddev: +Math.sqrt(variance).toFixed(2),
    min: +sorted[0].toFixed(2),
    p50: +pct(50).toFixed(2),
    p95: +pct(95).toFixed(2),
    max: +sorted[n - 1].toFixed(2),
    samples: clean.map((x) => +x.toFixed(2)),
  };
}

function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return "   —   ";
  if (v >= 10000) return `${(v / 1000).toFixed(1)}s`.padStart(7);
  return `${v.toFixed(1)}ms`.padStart(7);
}

async function isServerUp() {
  try {
    const r = await fetch(HEALTH_URL);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return true;
    await sleep(SERVER_HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

function startDevServer() {
  console.log(dim(`[e2e-perf] starting workerd via 'pnpm --filter @kitesurf/engine dev'…`));
  const proc = spawn("pnpm", ["--filter", "@kitesurf/engine", "dev"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  proc.__stderrTail = "";
  proc.stderr.on("data", (d) => {
    proc.__stderrTail = (proc.__stderrTail + d.toString()).slice(-SERVER_STDERR_TAIL_LIMIT_CHARS);
  });
  proc.stdout.on("data", () => {});
  proc.__expectedExit = false;
  proc.on("exit", (code) => {
    if (proc.__expectedExit) return;
    if (code !== 0) {
      console.error(red(`[e2e-perf] dev server exited unexpectedly with code ${code}`));
      if (proc.__stderrTail) console.error(proc.__stderrTail);
    }
  });
  return proc;
}

async function teardownServer(proc) {
  if (!proc) return;
  console.log(dim("[e2e-perf] stopping workerd"));
  proc.__expectedExit = true;
  try {
    proc.kill("SIGTERM");
  } catch {}
  await sleep(SERVER_TERM_GRACE_MS);
  try {
    proc.kill("SIGKILL");
  } catch {}
  await sleep(SERVER_POST_KILL_SETTLE_MS);
}

function waitForFrame(session, sentinelWallSec, timeoutMs) {
  return new Promise((resolveFrame) => {
    let done = false;
    const handler = async (params) => {
      try {
        await session.send("Page.screencastFrameAck", { sessionId: params.sessionId });
      } catch {}
      const serverTs = frameTimestamp(params);
      if (shouldIgnoreFrame(done, sentinelWallSec, serverTs)) return;
      done = true;
      session.off("Page.screencastFrame", handler);
      resolveFrame({
        tFrame: performance.now(),
        dWall: Date.now(),
        serverTs,
        sessionId: params.sessionId,
      });
    };
    session.on("Page.screencastFrame", handler);
    setTimeout(() => {
      if (done) return;
      done = true;
      session.off("Page.screencastFrame", handler);
      resolveFrame(null);
    }, timeoutMs);
  });
}

function frameTimestamp(params) {
  return params?.metadata?.timestamp ?? 0;
}

function shouldIgnoreFrame(done, sentinelWallSec, serverTs) {
  return done || (sentinelWallSec > 0 && serverTs > 0 && serverTs < sentinelWallSec);
}

async function drainOneFrame(session, timeoutMs = 2000) {
  return waitForFrame(session, 0, timeoutMs);
}

function rootNodeId(document) {
  return document?.root?.nodeId ?? 0;
}

function queriedNodeId(query) {
  return query?.nodeId ?? 0;
}

function hasContentQuad(quad) {
  return Array.isArray(quad) && quad.length >= 8;
}

function contentQuad(box, selector) {
  const quad = box?.model?.content;
  if (!hasContentQuad(quad)) {
    throw new Error(`getBoxModel returned no content quad for ${selector}`);
  }
  return quad;
}

async function resolveClickTarget(session, selector) {
  const doc = await session.send("DOM.getDocument", {});
  const rootId = rootNodeId(doc);
  const q = await session.send("DOM.querySelector", { nodeId: rootId, selector });
  const nodeId = queriedNodeId(q);
  if (!nodeId) throw new Error(`selector matched nothing: ${selector}`);
  const box = await session.send("DOM.getBoxModel", { nodeId });
  const quad = contentQuad(box, selector);
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  return { x, y, nodeId };
}

async function dispatchClick(session, x, y) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function dispatchKey(session, key) {
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key });
}

function createRow() {
  return {
    loadMs: NaN,
    firstPaintMs: NaN,
    rpcRttMs: NaN,
    interactionMs: NaN,
    renderAfterMs: NaN,
    screenshotMs: NaN,
    phases: null,
  };
}

async function startScreencast(session) {
  if (!NO_SCREENCAST) {
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    await drainOneFrame(session, 2000);
  }
}

function firstPaintPromise(session, wallStart) {
  return NO_SCREENCAST ? null : waitForFrame(session, wallStart / 1000, FIRST_FRAME_TIMEOUT_MS);
}

async function readNavigatePhases(session, row) {
  try {
    const result = await session.send("Kitesurf.getNavigatePhases", {});
    row.phases = firstNavigatePhases(navigateTargets(result)) ?? null;
  } catch {}
}

function navigateTargets(result) {
  return result?.byTarget ?? {};
}

function firstNavigatePhases(byTarget) {
  for (const phases of Object.values(byTarget)) {
    if (phases && typeof phases === "object") return phases;
  }
  return undefined;
}

function frameDuration(frame, start) {
  return frame ? frame.tFrame - start : NaN;
}

async function stopScreencast(session) {
  if (NO_SCREENCAST) return;
  try {
    await session.send("Page.stopScreencast");
  } catch {}
}

async function detachSession(session) {
  await session.detach().catch(() => {});
}

async function finishWithoutInteraction(session, row) {
  await stopScreencast(session);
  await detachSession(session);
  return row;
}

async function drainBeforeInteraction(session) {
  if (!NO_SCREENCAST) await drainOneFrame(session, 500);
}

function renderAfterPromise(session, wallStart) {
  return NO_SCREENCAST ? null : waitForFrame(session, wallStart / 1000, RENDER_AFTER_TIMEOUT_MS);
}

async function dispatchInteraction(session) {
  try {
    switch (INTERACTION) {
      case "click": {
        const { x, y } = await resolveClickTarget(session, SELECTOR);
        await dispatchClick(session, x, y);
        break;
      }
      case "key":
        await dispatchKey(session, KEY);
        break;
      default:
        console.warn(`  unknown --interaction ${INTERACTION}, treating as none`);
    }
  } catch (err) {
    console.warn(`  interaction failed: ${err.message}`);
  }
}

async function captureScreenshot(session, row) {
  const tShot = performance.now();
  try {
    await session.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    row.screenshotMs = performance.now() - tShot;
  } catch {}
}

async function runOnce(browser) {
  const page = await browser.newPage();
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("DOM.enable");
  await session.send("Runtime.enable");
  const row = createRow();
  await startScreencast(session);

  const tNavStart = performance.now();
  const dNavStart = Date.now();
  const paintPromise = firstPaintPromise(session, dNavStart);
  try {
    await page.goto(URL, { timeout: 30000, waitUntil: "load" });
  } catch (err) {
    console.warn(`  goto failed: ${err.message}`);
    await session.detach().catch(() => {});
    return row;
  }
  row.loadMs = performance.now() - tNavStart;

  if (paintPromise) {
    const frame = await paintPromise;
    row.firstPaintMs = frameDuration(frame, tNavStart);
  }

  await readNavigatePhases(session, row);

  const tRpc = performance.now();
  await session.send("Runtime.evaluate", { expression: "1", returnByValue: true });
  row.rpcRttMs = performance.now() - tRpc;

  if (INTERACTION === "none") {
    return finishWithoutInteraction(session, row);
  }

  await drainBeforeInteraction(session);

  const tInteractStart = performance.now();
  const dInteractStart = Date.now();
  const renderPromise = renderAfterPromise(session, dInteractStart);
  await dispatchInteraction(session);
  row.interactionMs = performance.now() - tInteractStart;

  if (renderPromise) {
    const frame = await renderPromise;
    row.renderAfterMs = frameDuration(frame, tInteractStart);
  }

  await captureScreenshot(session, row);
  await stopScreencast(session);
  await detachSession(session);
  return row;
}

function printRow(i, row) {
  const ph = row.phases ?? {};
  const subBreakdown = [
    `parse=${fmtMs(ph.parseMs).trim()}`,
    `shim=${fmtMs(ph.shimMs).trim()}`,
    `scripts=${fmtMs((ph.regularScriptsMs ?? 0) + (ph.moduleScriptsMs ?? 0) + (ph.asyncScriptsMs ?? 0)).trim()}`,
    `drain=${fmtMs(ph.drainMs).trim()}`,
  ].join(" ");
  console.log(
    `  iter ${String(i + 1).padStart(2)}:` +
      ` load=${fmtMs(row.loadMs)}` +
      ` firstPaint=${fmtMs(row.firstPaintMs)}` +
      ` rpcRtt=${fmtMs(row.rpcRttMs)}` +
      ` interact=${fmtMs(row.interactionMs)}` +
      ` render=${fmtMs(row.renderAfterMs)}` +
      ` shot=${fmtMs(row.screenshotMs)}` +
      `  ${dim(`[${subBreakdown}]`)}`,
  );
}

function printMetricSummary(rows, cols) {
  for (const col of cols) {
    const s = stats(rows.map((r) => r[col]));
    if (!s.n) {
      console.log(`  ${col.padEnd(16)} ${String(0).padStart(2)}    —`);
      continue;
    }
    console.log(
      `  ${col.padEnd(16)} ${String(s.n).padStart(2)} ` +
        `${fmtMs(s.min)} ${fmtMs(s.p50)} ${fmtMs(s.p95)} ${fmtMs(s.max)} ` +
        `${fmtMs(s.mean)} ${fmtMs(s.stddev)}`,
    );
  }
}

function printPhaseSummary(rows, phaseKeys) {
  if (!rows.some((r) => r.phases)) return;
  console.log("\nSub-isolate phases (ms):");
  for (const key of phaseKeys) {
    const s = stats(rows.map((r) => r.phases?.[key]));
    if (!s.n) continue;
    console.log(
      `  ${key.padEnd(20)} p50=${fmtMs(s.p50)}  p95=${fmtMs(s.p95)}  max=${fmtMs(s.max)}`,
    );
  }
}

function printSummary(rows) {
  const cols = [
    "loadMs",
    "firstPaintMs",
    "rpcRttMs",
    "interactionMs",
    "renderAfterMs",
    "screenshotMs",
  ];
  const phaseKeys = [
    "teardownMs",
    "parseMs",
    "shimMs",
    "regularScriptsMs",
    "moduleScriptsMs",
    "asyncScriptsMs",
    "drainMs",
  ];
  console.log("\nSummary (ms):");
  console.log("  metric            n   min      p50      p95      max      mean     stddev");
  printMetricSummary(rows, cols);
  printPhaseSummary(rows, phaseKeys);
  console.log(
    dim(
      `\nNotes: firstPaint & renderAfter floor is ~${SCREENCAST_POLL_FLOOR_MS}ms ` +
        `(screencast loop polls every ${SCREENCAST_POLL_FLOOR_MS}ms). ` +
        `screenshotMs is the un-floored paint cost.`,
    ),
  );
}

console.log(`[e2e-perf] workerd target: ${HEALTH_URL}`);
console.log(`[e2e-perf] url=${URL}`);
console.log(
  `[e2e-perf] iterations=${ITERATIONS} warmup=${WARMUP} ` +
    `interaction=${INTERACTION}${INTERACTION === "click" ? ` selector=${JSON.stringify(SELECTOR)}` : ""}${INTERACTION === "key" ? ` key=${KEY}` : ""}` +
    `${NO_SCREENCAST ? " no-screencast" : ""}`,
);

let serverProc = null;
try {
  const alreadyUp = await isServerUp();
  if (alreadyUp && !USE_RUNNING) {
    console.error(red(`[e2e-perf] something is already listening on ${HOST}:${PORT}.`));
    console.error(red(`           stop it first, or pass --use-running-server to reuse it.`));
    process.exit(2);
  }
  if (!alreadyUp) {
    serverProc = startDevServer();
    const ok = await waitForServer(SERVER_BOOT_TIMEOUT_MS);
    if (!ok) {
      console.error(
        red(`[e2e-perf] workerd did not become ready within ${SERVER_BOOT_TIMEOUT_MS} ms`),
      );
      await teardownServer(serverProc);
      process.exit(2);
    }
    console.log(green(`[e2e-perf] workerd ready (pid ${serverProc.pid})`));
  } else {
    console.log(dim(`[e2e-perf] reusing existing server at ${HEALTH_URL}`));
  }

  const browser = await puppeteer.connect({ browserWSEndpoint: WS });
  const rows = [];
  try {
    for (let i = 0; i < WARMUP; i++) {
      console.log(dim(`  warmup ${i + 1}/${WARMUP}…`));
      await runOnce(browser);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const row = await runOnce(browser);
      rows.push(row);
      printRow(i, row);
      await sleep(50);
    }
    printSummary(rows);

    if (JSON_OUT) {
      const out = {
        timestamp: new Date().toISOString(),
        ws: WS,
        url: URL,
        iterations: ITERATIONS,
        warmup: WARMUP,
        interaction: INTERACTION,
        selector: INTERACTION === "click" ? SELECTOR : null,
        key: INTERACTION === "key" ? KEY : null,
        noScreencast: NO_SCREENCAST,
        rows,
        summary: Object.fromEntries(
          [
            "loadMs",
            "firstPaintMs",
            "rpcRttMs",
            "interactionMs",
            "renderAfterMs",
            "screenshotMs",
          ].map((col) => [col, stats(rows.map((r) => r[col]))]),
        ),
        phaseSummary: Object.fromEntries(
          [
            "teardownMs",
            "parseMs",
            "shimMs",
            "regularScriptsMs",
            "moduleScriptsMs",
            "asyncScriptsMs",
            "drainMs",
          ].map((k) => [k, stats(rows.map((r) => r.phases?.[k]))]),
        ),
      };
      const abs = resolve(process.cwd(), JSON_OUT);
      writeFileSync(abs, JSON.stringify(out, null, 2));
      console.log(green(`\n[e2e-perf] saved JSON snapshot to ${abs}`));
    }
  } finally {
    await browser.disconnect();
  }
} catch (err) {
  console.error(red("[e2e-perf] ERROR:"), err && err.stack ? err.stack : err);
  process.exitCode = 1;
} finally {
  await teardownServer(serverProc);
}
