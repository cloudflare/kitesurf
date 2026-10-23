// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near, type DecodedPng } from "./png";
import { targetIdForSession } from "../connect";

const IDLE_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
  #hidden { display: none; }
</style></head>
<body><div id="patch"></div><div id="hidden"></div></body></html>`);

function firstRedPixelPosition(png: DecodedPng): number | undefined {
  for (let x = 0; x < png.width - 2; x += 10) {
    if (near(sample(png, x + 2, 230), [255, 0, 0])) return x;
  }
  return undefined;
}

async function collectMovingPositions(
  frames: Uint8Array[],
  waitForFrames: (count: number, timeoutMs: number) => Promise<boolean>,
  durationMs: number,
): Promise<Set<number>> {
  const seen = new Set<number>();
  const deadline = Date.now() + durationMs;
  let decodedThrough = 0;
  while (Date.now() < deadline && seen.size < 3) {
    if (!(await waitForFrames(decodedThrough + 1, deadline - Date.now()))) break;
    decodedThrough = frames.length;
    const png = decodePng(frames[frames.length - 1]);
    const position = firstRedPixelPosition(png);
    if (position !== undefined) seen.add(position);
  }
  return seen;
}

test("pixel-neutral seq bumps do not stall a screenshot", async ({ page, cdpSession }) => {
  await page.goto(IDLE_PAGE, { timeout: 25_000 });

  const first = (await cdpSession.send("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  expect(first.data.length, "first screenshot returns bytes").toBeGreaterThan(0);

  await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "detached";
    d.textContent = "tick";
    d.appendChild(document.createElement("span"));
  });

  const shot = (await cdpSession.send("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  expect(shot.data.length, "screenshot returns bytes").toBeGreaterThan(0);
  const png = decodePng(Uint8Array.from(Buffer.from(shot.data, "base64")));
  expect(
    near(sample(png, 330, 230), [0, 0, 255]),
    `screenshot still shows the patch (got ${sample(png, 330, 230)})`,
  ).toBe(true);
});

test("detached pixel-neutral damage returns unchanged for polling callers", async ({
  page,
  cdpSession,
}) => {
  await page.goto(IDLE_PAGE, { timeout: 25_000 });
  const targetId = await targetIdForSession(cdpSession);
  const record = async (sinceSeq: number, baseSeq: number) => {
    const reply = await cdpSession.send("Kitesurf.recordScene", {
      targetId,
      producer: "replay",
      sinceSeq,
      allowPartial: true,
      baseSeq,
    });
    if (!("seq" in reply)) throw new Error(`recordScene: ${reply.error}`);
    return reply;
  };

  const first = await record(0, 0);
  await page.evaluate(() => {
    (document.getElementById("patch") as HTMLElement).style.background = "#ff0";
  });
  const base = await record(first.seq, first.seq);
  await page.evaluate(() => {
    const detached = document.createTextNode("detached");
    detached.data = "changed";
  });
  const second = await record(base.seq, base.seq);
  expect(second.unchanged, JSON.stringify(second)).toBe(true);
});

test("a plain checkbox toggle ships its state-driven paint", async ({ page, cdpSession }) => {
  await page.goto(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html><html><body style="margin:0">
<input id="check" type="checkbox" style="position:absolute;left:100px;top:100px;width:40px;height:40px">
<div id="marker" style="position:absolute;left:300px;top:100px;width:20px;height:20px;background:#0f0"></div>
</body></html>`),
    { timeout: 25_000 },
  );

  const frames: Uint8Array[] = [];
  const frameWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    for (const notify of [...frameWaiters]) notify();
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  const waitForFrames = (count: number, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (frames.length >= count) {
        resolve(true);
        return;
      }
      const done = (reached: boolean) => {
        clearTimeout(timer);
        frameWaiters.delete(notify);
        resolve(reached);
      };
      const notify = () => {
        if (frames.length >= count) done(true);
      };
      const timer = setTimeout(() => done(frames.length >= count), timeoutMs);
      frameWaiters.add(notify);
    });
  const waitFor = async (count: number, timeoutMs: number) => {
    expect(await waitForFrames(count, timeoutMs), "checkbox frame arrives").toBe(true);
  };
  const getPartialCount = async () => {
    const info = await cdpSession.send("Kitesurf.getRendererInfo");
    return info.partialFramesRendered;
  };

  await waitFor(1, 15_000);
  const unchecked = decodePng(frames[frames.length - 1]);

  let frameCount = frames.length;
  await page.evaluate(() => {
    const marker = document.getElementById("marker");
    if (marker) marker.style.background = "#ff0";
  });
  await waitFor(frameCount + 1, 10_000);

  const partialsBefore = await getPartialCount();
  frameCount = frames.length;
  await page.evaluate(() => {
    const checkbox = document.getElementById("check") as HTMLInputElement;
    checkbox.checked = true;
  });
  await waitFor(frameCount + 1, 10_000);
  const checked = decodePng(frames[frames.length - 1]);

  let changedPixels = 0;
  for (let y = 100; y < 140; y++) {
    for (let x = 100; x < 140; x++) {
      const before = sample(unchecked, x, y);
      const after = sample(checked, x, y);
      if (before.some((channel, i) => channel !== after[i])) changedPixels++;
    }
  }
  expect(changedPixels, "checkbox pixels change after .checked = true").toBeGreaterThan(0);
  expect(
    await getPartialCount(),
    "checkbox state reaches the damage-summary partial path",
  ).toBeGreaterThan(partialsBefore);

  await cdpSession.send("Page.stopScreencast");
});

test("focus and blur state changes do not return unchanged", async ({ page, cdpSession }) => {
  await page.goto(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html><style>
        body { margin: 0; }
        input { position: absolute; left: 100px; top: 100px; width: 120px;
          height: 30px; outline: none; caret-color: #f00; }
      </style><input id=input value=focus>`),
    { timeout: 25_000 },
  );
  const targetId = await targetIdForSession(cdpSession);
  const record = async (sinceSeq: number, baseSeq: number) => {
    const reply = await cdpSession.send("Kitesurf.recordScene", {
      targetId,
      producer: "replay",
      sinceSeq,
      allowPartial: true,
      baseSeq,
    });
    if (!("seq" in reply)) throw new Error(`recordScene: ${reply.error}`);
    return reply;
  };

  const first = await record(0, 0);
  await page.evaluate(() => (document.getElementById("input") as HTMLInputElement).focus());
  const focused = await record(first.seq, first.seq);
  expect(focused.unchanged).not.toBe(true);

  await page.evaluate(() => (document.getElementById("input") as HTMLInputElement).blur());
  const blurred = await record(focused.seq, focused.seq);
  expect(blurred.unchanged).not.toBe(true);
});

test("a screencast still ships real mutations after idle ticks", async ({ page, cdpSession }) => {
  await page.goto(IDLE_PAGE, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  const frameWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    for (const notify of [...frameWaiters]) notify();
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  const waitFor = (n: number, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (frames.length >= n) {
        resolve(true);
        return;
      }
      const done = (reached: boolean) => {
        clearTimeout(timer);
        frameWaiters.delete(notify);
        resolve(reached);
      };
      const notify = () => {
        if (frames.length >= n) done(true);
      };
      const timer = setTimeout(() => done(frames.length >= n), timeoutMs);
      frameWaiters.add(notify);
    });
  expect(await waitFor(1, 15_000), "first frame arrives").toBe(true);

  await page.evaluate(() => document.body?.offsetHeight);
  const waitForStableFrames = async () => {
    while (await waitFor(frames.length + 1, 500)) {}
  };
  await waitForStableFrames();
  const idleFrames = frames.length;
  for (let i = 0; i < 4; i++) {
    await page.evaluate((n: number) => {
      const comment = document.createComment(`idle ${n}`);
      comment.data = `idle ${n + 1}`;
    }, i);
    await new Promise((r) => setTimeout(r, 120));
  }
  expect(frames.length, "pixel-neutral mutations stay skipped").toBe(idleFrames);

  const before = frames.length;
  await page.evaluate(() => {
    const el = document.getElementById("patch");
    if (el) (el as HTMLElement).style.background = "#ff0000";
  });
  expect(await waitFor(before + 1, 10_000), "the real mutation still ships a frame").toBe(true);

  const png = decodePng(frames[frames.length - 1]);
  expect(
    near(sample(png, 330, 230), [255, 0, 0]),
    `patch repainted red (got ${sample(png, 330, 230)})`,
  ).toBe(true);

  await cdpSession.send("Page.stopScreencast");
});

const IDLE_ENTRY_MS = 200;
const IDLE_WAKE_FRAME_MAX_MS = 750;

test("a mutation wakes an idle screencast without waiting for its poll", async ({
  page,
  cdpSession,
}) => {
  await page.goto(IDLE_PAGE, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", { format: "png" });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

  await new Promise((r) => setTimeout(r, IDLE_ENTRY_MS));
  const started = Date.now();
  await page.evaluate(() => {
    (document.getElementById("patch") as HTMLElement).style.background = "#ff0000";
  });
  await expect
    .poll(() => sample(decodePng(frames[frames.length - 1]), 330, 230), {
      timeout: 5_000,
      interval: 10,
    })
    .toEqual([255, 0, 0]);
  expect(Date.now() - started, "mutation frame latency").toBeLessThan(IDLE_WAKE_FRAME_MAX_MS);

  await cdpSession.send("Page.stopScreencast");
});

const NAV_WAKE_FRAME_MAX_MS = 400;

test("a navigation wakes an idle screencast without waiting for its poll", async ({
  page,
  cdpSession,
}) => {
  await page.goto(IDLE_PAGE, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", { format: "png" });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

  await new Promise((r) => setTimeout(r, IDLE_ENTRY_MS));
  await page.goto("data:text/html,<style>html,body{margin:0;background:%23f00}</style>");
  const loaded = Date.now();
  await expect
    .poll(() => sample(decodePng(frames[frames.length - 1]), 330, 230), {
      timeout: 5_000,
      interval: 10,
    })
    .toEqual([255, 0, 0]);
  expect(Date.now() - loaded, "new page frame after load").toBeLessThan(NAV_WAKE_FRAME_MAX_MS);

  await cdpSession.send("Page.stopScreencast");
});

test("a css transition keeps producing frames while it runs", async ({ page, cdpSession }) => {
  await page.goto(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #box { position: absolute; left: 0; top: 200px; width: 60px; height: 60px;
         background: #ff0000; transition: left 3s linear; }
</style></head>
<body><div id="box"></div></body></html>`),
    { timeout: 25_000 },
  );

  const frames: Uint8Array[] = [];
  const frameWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    for (const notify of [...frameWaiters]) notify();
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  const waitForFrames = (count: number, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (frames.length >= count) {
        resolve(true);
        return;
      }
      const done = (reached: boolean) => {
        clearTimeout(timer);
        frameWaiters.delete(notify);
        resolve(reached);
      };
      const notify = () => {
        if (frames.length >= count) done(true);
      };
      const timer = setTimeout(() => done(frames.length >= count), timeoutMs);
      frameWaiters.add(notify);
    });
  expect(await waitForFrames(1, 15_000), "first frame arrives").toBe(true);

  await page.evaluate(() => {
    const el = document.getElementById("box");
    if (el) (el as HTMLElement).style.left = "400px";
  });

  const seen = await collectMovingPositions(frames, waitForFrames, 6_000);
  await cdpSession.send("Page.stopScreencast");
  expect(
    seen.size,
    `transition produced moving frames (positions seen: ${[...seen].join(",")})`,
  ).toBeGreaterThanOrEqual(3);
});

test("a keyframes animation keeps producing frames", async ({ page, cdpSession }) => {
  await page.goto(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  @keyframes slide { from { left: 0; } to { left: 400px; } }
  #box { position: absolute; top: 200px; width: 60px; height: 60px;
         background: #ff0000; animation: slide 3s linear infinite; }
</style></head>
<body><div id="box"></div></body></html>`),
    { timeout: 25_000 },
  );

  const frames: Uint8Array[] = [];
  const frameWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    for (const notify of [...frameWaiters]) notify();
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  const waitForFrames = (count: number, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (frames.length >= count) {
        resolve(true);
        return;
      }
      const done = (reached: boolean) => {
        clearTimeout(timer);
        frameWaiters.delete(notify);
        resolve(reached);
      };
      const notify = () => {
        if (frames.length >= count) done(true);
      };
      const timer = setTimeout(() => done(frames.length >= count), timeoutMs);
      frameWaiters.add(notify);
    });

  const seen = await collectMovingPositions(frames, waitForFrames, 8_000);
  await cdpSession.send("Page.stopScreencast");
  expect(
    seen.size,
    `animation produced moving frames (positions: ${[...seen].join(",")})`,
  ).toBeGreaterThanOrEqual(3);
});

const LOAD_DRAIN_MS = 500;
const CHILD_SETTLE_MS = 1_500;
const IDLE_WINDOW_MS = 1_000;

test.for([
  {
    visibility: "hidden",
    animation: "visibility: hidden; animation: spin .6s linear infinite;",
  },
  {
    visibility: "offscreen",
    animation: "top: 2200px; animation: pulse .6s linear infinite alternate;",
  },
])(
  "an $visibility infinite animation does not stream identical frames",
  async ({ animation, visibility }, { page, cdpSession }) => {
    await page.goto(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; min-height: 3000px; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { to { background-color: #ffffff; } }
  #spinner { position: absolute; left: 20px; top: 20px; width: 20px;
             height: 20px; background: #000; ${animation} }
</style></head>
<body><div id="patch"></div><div id="spinner"></div></body></html>`),
      { timeout: 25_000 },
    );

    const frames: Uint8Array[] = [];
    const scrollOffsets: number[] = [];
    const frameWaiters = new Set<() => void>();
    cdpSession.on(
      "Page.screencastFrame",
      (ev: { data: string; sessionId: number; metadata: { scrollOffsetY: number } }) => {
        frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
        scrollOffsets.push(ev.metadata.scrollOffsetY);
        for (const notify of [...frameWaiters]) notify();
        cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
      },
    );
    await cdpSession.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
    });
    const waitFor = (n: number, timeoutMs: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (frames.length >= n) {
          resolve(true);
          return;
        }
        const done = (reached: boolean) => {
          clearTimeout(timer);
          frameWaiters.delete(notify);
          resolve(reached);
        };
        const notify = () => {
          if (frames.length >= n) done(true);
        };
        const timer = setTimeout(() => done(frames.length >= n), timeoutMs);
        frameWaiters.add(notify);
      });
    expect(await waitFor(1, 15_000), "first frame arrives").toBe(true);

    await new Promise((r) => setTimeout(r, LOAD_DRAIN_MS));
    const settled = frames.length;
    await new Promise((r) => setTimeout(r, IDLE_WINDOW_MS));
    expect(
      frames.length - settled,
      "identical scenes are not re-rasterized and re-sent",
    ).toBeLessThanOrEqual(1);

    if (visibility === "offscreen") {
      const beforeScroll = frames.length;
      await page.evaluate(() => window.scrollTo(0, 2000));
      await expect
        .poll(() => scrollOffsets.slice(beforeScroll).filter((y) => y === 2000).length, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(3);
      expect(scrollOffsets.at(-1), "scrolled into the animated box").toBe(2000);
      const colors = frames
        .slice(beforeScroll)
        .filter((_, i) => scrollOffsets[beforeScroll + i] === 2000)
        .map((frame) => sample(decodePng(frame), 30, 210)[0]);
      expect(colors[0], "the animated box is painted").toBeLessThan(255);
      expect(new Set(colors).size, "visible animation changes pixels").toBeGreaterThan(1);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => scrollOffsets.at(-1), { timeout: 10_000 }).toBe(0);
    }

    const before = frames.length;
    await page.evaluate(() => {
      const el = document.getElementById("patch");
      if (el) (el as HTMLElement).style.background = "#ff0000";
    });
    expect(await waitFor(before + 1, 10_000), "a visible change still ships a frame").toBe(true);
    const png = decodePng(frames[frames.length - 1]);
    expect(
      near(sample(png, 330, 230), [255, 0, 0]),
      `patch repainted red (got ${sample(png, 330, 230)})`,
    ).toBe(true);

    await cdpSession.send("Page.stopScreencast");
  },
);

const SLOW_FRAME_INTERVAL_MS = 1_000;

test.for([
  { page: "idle", spinner: "" },
  {
    page: "offscreen-animated",
    spinner: "top: 2200px; animation: pulse .6s linear infinite alternate;",
  },
])(
  "a screenshot does not hide a mutation from a slow screencast ($page page)",
  async ({ spinner }, { page, cdpSession }) => {
    await page.goto(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; min-height: 3000px; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
  @keyframes pulse { to { background-color: #ffffff; } }
  #spinner { position: absolute; left: 20px; width: 20px; height: 20px;
             background: #000; ${spinner || "display: none;"} }
</style></head>
<body><div id="patch"></div><div id="spinner"></div></body></html>`),
      { timeout: 25_000 },
    );

    const frames: Uint8Array[] = [];
    cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
      frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
      cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdpSession.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
      minFrameIntervalMs: SLOW_FRAME_INTERVAL_MS,
    });
    await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.evaluate(() => {
      (document.getElementById("patch") as HTMLElement).style.background = "#ff0000";
    });
    const shot = (await cdpSession.send("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    expect(sample(decodePng(Uint8Array.from(Buffer.from(shot.data, "base64"))), 330, 230)).toEqual([
      255, 0, 0,
    ]);

    await expect
      .poll(() => sample(decodePng(frames[frames.length - 1]), 330, 230), {
        timeout: 2 * SLOW_FRAME_INTERVAL_MS + 1_000,
      })
      .toEqual([255, 0, 0]);

    await cdpSession.send("Page.stopScreencast");
  },
);

test("an idle cross-origin iframe is not re-rasterized on every tick", async ({
  page,
  cdpSession,
}) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host.html", {
    waitUntil: "load",
    timeout: 60_000,
  });
  const framesRendered = async () =>
    (await cdpSession.send("Kitesurf.getRendererInfo")).framesRendered;
  let frames = 0;
  cdpSession.on("Page.screencastFrame", (ev: { sessionId: number }) => {
    frames++;
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    minFrameIntervalMs: 33,
  });
  await expect.poll(() => frames, { timeout: 15_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, CHILD_SETTLE_MS));

  const before = await framesRendered();
  await new Promise((r) => setTimeout(r, IDLE_WINDOW_MS));
  const rendered = (await framesRendered()) - before;
  expect(rendered, "rasters during one idle second").toBeLessThanOrEqual(2);

  await cdpSession.send("Page.stopScreencast");
});
