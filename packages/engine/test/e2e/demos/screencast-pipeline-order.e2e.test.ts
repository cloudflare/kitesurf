// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample } from "./png";

const RAMP_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html>
<html><head><style>html,body{margin:0;height:100%}</style></head>
<body><script>
  window.__step = 0;
  window.__ramp = function () {
    window.__timer = setInterval(function () {
      window.__step += 1;
      var v = 250 - window.__step * 2;
      if (v < 40) { clearInterval(window.__timer); return; }
      document.body.style.background = "rgb(" + v + "," + v + "," + v + ")";
    }, 16);
  };
</script></body></html>`);

const solid = (hex: string) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html><body style="margin:0;background:${hex}">` +
      `<div style="height:100%"></div></body></html>`,
  );

type Frame = { data: string; sessionId: number };

type Session = {
  on: (ev: string, fn: (p: unknown) => void) => void;
  send: (m: string, p?: unknown) => Promise<unknown>;
};

function collect(session: Session, ack = true): Frame[] {
  const frames: Frame[] = [];
  session.on("Page.screencastFrame", (raw) => {
    const ev = raw as Frame;
    frames.push(ev);
    if (!ack) return;
    void session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  return frames;
}

const shadeOf = (f: Frame) =>
  sample(decodePng(Uint8Array.from(Buffer.from(f.data, "base64"))), 200, 150)[0]!;

test.for([
  { window: {}, expected: 1 },
  { window: { maxInFlight: 2 }, expected: 2 },
  { window: { maxFramesInFlight: 2 }, expected: 2 },
])(
  "an unacked client gets $expected frame(s) with window $window",
  async ({ window: credit, expected }, { page, cdpSession }) => {
    await page.goto(RAMP_PAGE, { timeout: 25_000 });
    const frames = collect(cdpSession as never, false);

    await cdpSession.send("Page.startScreencast", {
      format: "png",
      maxWidth: 400,
      maxHeight: 300,
      everyNthFrame: 1,
      minFrameIntervalMs: 16,
      ...credit,
    });
    await page.evaluate(() => (window as typeof window & { __ramp: () => void }).__ramp());
    await new Promise((r) => setTimeout(r, 1500));
    await cdpSession.send("Page.stopScreencast");

    expect(frames.length, "unacked frames on the wire").toBe(expected);
  },
);

test("navigation placeholder waits for screencast credit", async ({ page, cdpSession }) => {
  await page.goto(solid("#ff0000"), { timeout: 25_000 });
  const frames = collect(cdpSession as never, false);
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
    minFrameIntervalMs: 16,
    maxInFlight: 1,
  });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBe(1);

  const navigating = page.goto("https://ks.invalid/__fixtures/css-block.html", { timeout: 25_000 });
  await navigating;
  await new Promise((r) => setTimeout(r, 100));
  expect(frames, "the placeholder cannot bypass the full credit window").toHaveLength(1);
  await cdpSession.send("Page.stopScreencast");
});

test("pipelined frames arrive in order and never go backwards", async ({ page, cdpSession }) => {
  await page.goto(RAMP_PAGE, { timeout: 25_000 });
  const frames = collect(cdpSession as never);

  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
    minFrameIntervalMs: 16,
    maxInFlight: 2,
  });
  await page.evaluate(() => (window as typeof window & { __ramp: () => void }).__ramp());
  await new Promise((r) => setTimeout(r, 2500));
  await cdpSession.send("Page.stopScreencast");

  expect(frames.length, "screencast delivered frames").toBeGreaterThan(2);

  const shades = frames.map(shadeOf);
  for (let i = 1; i < shades.length; i++) {
    expect(
      shades[i]! <= shades[i - 1]!,
      `frame ${i} is not older than frame ${i - 1} (shades ${shades.join(",")})`,
    ).toBe(true);
  }
  expect(
    shades[shades.length - 1]! < shades[0]!,
    `stream tracked the page (shades ${shades.join(",")})`,
  ).toBe(true);
});

test("a finished render ships without waiting for the next tick", async ({ page, cdpSession }) => {
  const PERIOD = 1000;
  await page.goto(solid("#000000"), { timeout: 25_000 });
  const frames = collect(cdpSession as never);
  const arrivals: number[] = [];
  cdpSession.on("Page.screencastFrame", () => arrivals.push(Date.now()));
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
    minFrameIntervalMs: PERIOD,
  });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const latencies: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const shade = i % 2 ? 255 : 0;
    const before = frames.length;
    const start = Date.now();
    await page.evaluate((v) => {
      document.body.style.background = `rgb(${v},${v},${v})`;
    }, shade);
    await expect
      .poll(() => frames.slice(before).findIndex((f) => shadeOf(f) === shade), {
        timeout: 5_000,
        interval: 10,
      })
      .toBeGreaterThanOrEqual(0);
    const hit = frames.slice(before).findIndex((f) => shadeOf(f) === shade);
    latencies.push(arrivals[before + hit]! - start);
  }
  await cdpSession.send("Page.stopScreencast");

  const median = [...latencies].sort((a, b) => a - b)[2]!;
  expect(
    median,
    `median change-to-frame latency below one period (${latencies.join(",")} ms)`,
  ).toBeLessThan(PERIOD);
});

test("a buffered frame is never emitted after its generation is retired", async ({
  page,
  cdpSession,
}) => {
  await page.goto(solid("#ff0000"), { timeout: 25_000 });
  const frames = collect(cdpSession as never);
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
    minFrameIntervalMs: 16,
    maxInFlight: 2,
  });
  await new Promise((r) => setTimeout(r, 400));

  await page.goto(solid("#0000ff"), { timeout: 25_000 });
  await new Promise((r) => setTimeout(r, 900));
  await cdpSession.send("Page.stopScreencast");

  const isBlue = frames.map((f) => {
    const px = sample(decodePng(Uint8Array.from(Buffer.from(f.data, "base64"))), 200, 150);
    return px[2]! > 200 && px[0]! < 80;
  });
  const firstBlue = isBlue.indexOf(true);
  expect(firstBlue, "a post-navigate frame arrived").toBeGreaterThanOrEqual(0);
  expect(
    isBlue.slice(firstBlue).every(Boolean),
    `no old-generation frame after the navigate (${isBlue.join(",")})`,
  ).toBe(true);
});

test("frames keep flowing after navigating off a mutation-heavy page", async ({
  page,
  cdpSession,
}) => {
  const busy = (rate: number) =>
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><body style="background:#fff"><div id="s"></div><script>
  var n = 0;
  setInterval(function () {
    for (var i = 0; i < ${rate}; i++) {
      var d = document.createElement("i");
      d.textContent = String(n++);
      document.getElementById("s").appendChild(d);
    }
    document.body.style.background = (n % 2) ? "#e00000" : "#0000e0";
  }, 16);
</script></body></html>`);

  await page.goto(busy(40), { timeout: 25_000 });
  const frames = collect(cdpSession as never);
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
    minFrameIntervalMs: 16,
    maxInFlight: 1,
  });
  await new Promise((r) => setTimeout(r, 1200));
  expect(frames.length, "the heavy page produced frames").toBeGreaterThan(0);

  await page.goto(busy(1), { timeout: 25_000 });
  const afterNavigate = frames.length;
  await new Promise((r) => setTimeout(r, 2000));
  await cdpSession.send("Page.stopScreencast");

  expect(
    frames.length - afterNavigate,
    "the light page keeps producing frames after the navigate",
  ).toBeGreaterThan(0);
});
