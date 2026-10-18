// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";
import { decodePng, sample, near } from "./png";

test("full JPEG frames detect changes in an unaligned row tail", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 161, height: 65 });
  await setContent(
    page,
    `<!doctype html><style>
    body { margin: 0; background: white; }
    #layout { height: 1px; }
    #edge { position: absolute; left: 160px; top: 32px;
            width: 1px; height: 8px; background: red; }
  </style><div id="layout"></div><div id="edge"></div>`,
  );
  const before = await cdpSession.send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
  await page.evaluate(() => {
    document.getElementById("edge")!.style.background = "blue";
    document.getElementById("layout")!.style.height = "2px";
  });
  const changed = await cdpSession.send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
  await cdpSession.send("Kitesurf.setPartialRaster", { enabled: false });
  const fresh = await cdpSession.send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
  expect(changed.data).not.toBe(before.data);
  expect(changed.data).toBe(fresh.data);
});

test("screencast ships paint-only mutations as partial composites", async ({
  page,
  cdpSession,
}) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #header { position: absolute; left: 0; top: 0; width: 200px; height: 40px;
            background: #00a000; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
</style></head>
<body><div id="header"></div><div id="patch"></div></body></html>`);

  await page.goto(HTML_URL, { timeout: 25_000 });

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
  expect(await waitFor(1, 15_000), "first (full) frame arrives").toBe(true);

  const colors: Array<[string, [number, number, number]]> = [
    ["#ff0000", [255, 0, 0]],
    ["#ff00ff", [255, 0, 255]],
    ["#ffa500", [255, 165, 0]],
  ];
  for (const [css, rgb] of colors) {
    const before = frames.length;
    await page.evaluate((c: string) => {
      const el = document.getElementById("patch");
      if (el) (el as HTMLElement).style.background = c;
    }, css);
    expect(await waitFor(before + 1, 10_000), `frame after ${css}`).toBe(true);
    const png = decodePng(frames[frames.length - 1]);
    expect(png.width, "frame stays full-viewport").toBeGreaterThan(400);
    expect(png.height).toBeGreaterThan(300);
    expect(
      near(sample(png, 330, 230), rgb),
      `patch shows ${css} (got ${sample(png, 330, 230)})`,
    ).toBe(true);
    expect(near(sample(png, 50, 20), [0, 160, 0]), "header pixels untouched by the composite").toBe(
      true,
    );
    expect(
      near(sample(png, png.width - 20, png.height - 20), [255, 255, 255]),
      "background pixels untouched by the composite",
    ).toBe(true);
  }

  await cdpSession.send("Page.stopScreencast");

  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  console.log(
    `[partial-frames] frames=${frames.length} rendered=${info.framesRendered} ` +
      `partial=${info.partialFramesRendered} relaunches=${info.relaunchCount}`,
  );
  expect(info.partialFramesRendered, "damage-rect composites engaged").toBeGreaterThanOrEqual(1);
  expect(info.relaunchCount, "no renderer relaunch burned the base").toBe(0);
});

test("a partial composite does not drag position:fixed boxes into the clip", async ({
  page,
  cdpSession,
}) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; height: 2000px; }
  #header { position: fixed; left: 0; top: 0; width: 100%; height: 40px;
            background: #00a000; }
  #patch { position: absolute; left: 300px; top: 200px; width: 240px;
           height: 240px; background: #0000ff; }
</style></head>
<body><div id="header"></div><div id="patch"></div></body></html>`);

  await page.goto(HTML_URL, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  const waitForCount = async (n: number, what: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (frames.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(frames.length >= n, what).toBe(true);
  };
  const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
  const headerRect = () =>
    page.evaluate(() => {
      const r = document.getElementById("header")!.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });

  await waitForCount(1, "first (full) frame", 15_000);
  const rectBefore = await headerRect();

  const partialsBefore = (await getInfo()).partialFramesRendered;
  for (const [css, rgb] of [
    ["#ff0000", [255, 0, 0]],
    ["#ff00ff", [255, 0, 255]],
  ] as Array<[string, [number, number, number]]>) {
    const before = frames.length;
    await page.evaluate((c: string) => {
      const el = document.getElementById("patch");
      if (el) (el as HTMLElement).style.background = c;
    }, css);
    await waitForCount(before + 1, `frame after ${css}`, 10_000);
    const png = decodePng(frames[frames.length - 1]);
    expect(
      near(sample(png, 400, 320), rgb),
      `patch shows ${css} (got ${sample(png, 400, 320)})`,
    ).toBe(true);
    const top = sample(png, 320, 210);
    expect(near(top, rgb), `damage-rect top strip is patch (got ${top})`).toBe(true);
    expect(near(top, [0, 160, 0]), "the fixed header did not bleed into the damage rect").toBe(
      false,
    );
    expect(
      near(sample(png, 50, 20), [0, 160, 0]),
      "the fixed header still paints at the viewport top",
    ).toBe(true);
    expect(
      near(sample(png, 700, 300), [255, 255, 255]),
      "page background outside the damage rect untouched",
    ).toBe(true);
  }

  await cdpSession.send("Page.stopScreencast");
  const info = await getInfo();
  console.log(
    `[partial-fixed] frames=${frames.length} partialBefore=${partialsBefore} ` +
      `after=${info.partialFramesRendered} relaunches=${info.relaunchCount}`,
  );
  expect(info.partialFramesRendered, "the composite path actually engaged").toBeGreaterThan(
    partialsBefore,
  );
  expect(info.relaunchCount, "no renderer relaunch burned the base").toBe(0);
  expect(await headerRect(), "fixed header geometry unchanged").toEqual(rectBefore);
});

test("a transform move ships as a partial that clears the old position", async ({
  page,
  cdpSession,
}) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #mover { position: absolute; left: 100px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
  #tail { position: absolute; left: 70px; top: 20px; width: 20px;
          height: 20px; background: #ff0000; }
</style></head>
<body><div id="mover"><div id="tail"></div></div></body></html>`);
  await page.goto(HTML_URL, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
  const partialsBefore = (await getInfo()).partialFramesRendered;

  const WHITE: [number, number, number] = [255, 255, 255];
  const BLUE: [number, number, number] = [0, 0, 255];
  const RED: [number, number, number] = [255, 0, 0];
  let from = 0;
  for (const to of [200, 400, 100, 300]) {
    await page.evaluate((x: number) => {
      document.getElementById("mover")!.style.transform = `translateX(${x}px)`;
    }, to);
    await expect
      .poll(() => near(sample(decodePng(frames[frames.length - 1]), 130 + to, 250), BLUE), {
        timeout: 10_000,
      })
      .toBe(true);
    const png = decodePng(frames[frames.length - 1]);
    const at = (x: number, y: number) => sample(png, x, y);
    expect(near(at(180 + to, 230), RED), `tail at +${to}`).toBe(true);
    expect(near(at(130 + from, 250), WHITE), `mover left +${from}`).toBe(true);
    expect(near(at(180 + from, 230), WHITE), `tail left +${from}`).toBe(true);
    from = to;
  }

  await cdpSession.send("Page.stopScreencast");
  const info = await getInfo();
  expect(
    info.partialFramesRendered - partialsBefore,
    "transform moves composited",
  ).toBeGreaterThanOrEqual(1);
  expect(info.relaunchCount, "no renderer relaunch burned the base").toBe(0);
});

test("a transform move of a box with overflowing text clears the old text", async ({
  page,
  cdpSession,
}) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #mover { position: absolute; left: 100px; top: 100px; width: 40px;
           height: 40px; background: #0000ff; white-space: nowrap;
           font: 40px sans-serif; color: #ff0000; }
</style></head>
<body><div id="mover">MMMMMMMM</div></body></html>`);
  await page.goto(HTML_URL, { timeout: 25_000 });

  const frames: Uint8Array[] = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
  const partialsBefore = (await getInfo()).partialFramesRendered;

  const BLUE: [number, number, number] = [0, 0, 255];
  const RED: [number, number, number] = [255, 0, 0];
  const redTextPixels = (png: ReturnType<typeof decodePng>, dy: number) => {
    let n = 0;
    for (let y = 100 + dy; y < 140 + dy; y += 2) {
      for (let x = 145; x < 400; x += 2) if (near(sample(png, x, y), RED)) n++;
    }
    return n;
  };
  let from = 0;
  for (const to of [120, 240, 60, 180]) {
    await page.evaluate((dy: number) => {
      const mover = document.getElementById("mover");
      if (mover) mover.style.transform = `translateY(${dy}px)`;
    }, to);
    await expect
      .poll(() => near(sample(decodePng(frames[frames.length - 1]), 120, 120 + to), BLUE), {
        timeout: 10_000,
      })
      .toBe(true);
    const png = decodePng(frames[frames.length - 1]);
    expect(redTextPixels(png, to), `text drawn at +${to}`).toBeGreaterThan(0);
    expect(redTextPixels(png, from), `text left at +${from}`).toBe(0);
    from = to;
  }

  await cdpSession.send("Page.stopScreencast");
  const info = await getInfo();
  expect(
    info.partialFramesRendered - partialsBefore,
    "transform moves composited",
  ).toBeGreaterThanOrEqual(1);
  expect(info.relaunchCount, "no renderer relaunch burned the base").toBe(0);
});

test.for(["png", "jpeg"] as const)(
  "a page scroll ships as a shifted %s partial that keeps pinned boxes in place",
  async (format, { page, cdpSession }) => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<div style="height:37px;background:hsl(${(i * 47) % 360},70%,60%)">${i}</div>`,
    );
    await page.goto(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; font: 16px monospace; }
  #header { position: fixed; top: 0; left: 0; width: 300px; height: 40px; background: #0000ff; }
  #footer { position: fixed; bottom: 30px; right: 30px; width: 80px; height: 30px; background: #ff0000; outline: 16px solid #000; }
  #sticky { position: sticky; top: 50px; height: 20px; width: 200px; background: #00ff00; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
  #header::after { content: ""; position: absolute; inset: 0; box-shadow: 0 0 20px 4px rgba(0,0,0,.5); }
</style></head>
<body><div id="header"></div><div id="footer"></div>${rows.slice(0, 10).join("")}<div id="sticky"></div>${rows.slice(10).join("")}</body></html>`),
      { timeout: 25_000 },
    );

    const frames: Uint8Array[] = [];
    cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
      frames.push(Uint8Array.from(Buffer.from(ev.data, "base64")));
      cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdpSession.send("Page.startScreencast", { format, quality: 80, everyNthFrame: 1 });
    await expect.poll(() => frames.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
    const partialsBefore = (await getInfo()).partialFramesRendered;

    const scrolls = [100, 137, 60, 700, 650, 666, 634];
    const shown: Uint8Array[] = [];
    for (const y of scrolls) {
      const seen = frames.length;
      await page.evaluate((top: number) => window.scrollTo(0, top), y);
      await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(seen);
      shown.push(frames[frames.length - 1]);
    }
    await cdpSession.send("Page.stopScreencast");
    const info = await getInfo();
    expect(
      info.partialFramesRendered - partialsBefore,
      "scrolls composited",
    ).toBeGreaterThanOrEqual(3);
    expect(info.relaunchCount, "no renderer relaunch burned the base").toBe(0);

    await cdpSession.send("Kitesurf.setPartialRaster", { enabled: false });
    for (const [i, y] of scrolls.entries()) {
      await page.evaluate((top: number) => window.scrollTo(0, top), y);
      const { data } = await cdpSession.send("Page.captureScreenshot", { format, quality: 80 });
      const want = Uint8Array.from(Buffer.from(data, "base64"));
      const [got, ref] =
        format === "png" ? [decodePng(shown[i]).pixels, decodePng(want).pixels] : [shown[i], want];
      expect(Buffer.compare(got, ref), `frame at scrollY ${y} matches a full raster`).toBe(0);
    }
  },
);

test("inner-element scrolling damages its retained-frame region", async ({ page, cdpSession }) => {
  const html = `<!doctype html><html><body style="margin:0;background:#fff">
    <div id="scroller" style="position:absolute;left:100px;top:100px;width:120px;height:100px;overflow:hidden">
      <div style="height:100px;background:#f00"></div>
      <div style="height:100px;background:#00f"></div>
    </div>
    <div id="marker" style="position:absolute;left:300px;top:100px;width:20px;height:20px;background:#0f0"></div>
  </body></html>`;
  await page.goto("data:text/html," + encodeURIComponent(html), {
    timeout: 25_000,
  });

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
  const waitForFrame = async (count: number, timeoutMs: number) => {
    expect(await waitForFrames(count, timeoutMs), "inner-scroll frame arrives").toBe(true);
  };
  const getPartialCount = async () => {
    const info = await cdpSession.send("Kitesurf.getRendererInfo");
    return info.partialFramesRendered;
  };

  await waitForFrame(1, 15_000);
  const before = decodePng(frames[frames.length - 1]);
  expect(near(sample(before, 150, 145), [255, 0, 0]), "red before scroll").toBe(true);

  let frameCount = frames.length;
  await page.evaluate(() => {
    const marker = document.getElementById("marker");
    if (marker) marker.style.background = "#ff0";
  });
  await waitForFrame(frameCount + 1, 10_000);

  const partialsBefore = await getPartialCount();
  frameCount = frames.length;
  await page.evaluate(async () => {
    const scroller = document.getElementById("scroller");
    if (scroller) await (scroller as HTMLElement).scrollTo({ top: 100 });
  });
  await waitForFrame(frameCount + 1, 10_000);
  const after = decodePng(frames[frames.length - 1]);
  expect(near(sample(after, 150, 145), [0, 0, 255]), "inner-scroll pixels update").toBe(true);
  expect(
    await getPartialCount(),
    "inner scroll reaches the damage-summary partial path",
  ).toBeGreaterThan(partialsBefore);

  await cdpSession.send("Page.stopScreencast");
});

test("disabling partials keeps the pixels, and re-enabling resumes them", async ({
  page,
  cdpSession,
}) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #header { position: absolute; left: 0; top: 0; width: 200px; height: 40px;
            background: #00a000; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
</style></head>
<body><div id="header"></div><div id="patch"></div></body></html>`);

  await page.goto(HTML_URL, { timeout: 25_000 });

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

  const waitForFrames = (n: number, timeoutMs: number): Promise<boolean> =>
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
  const waitForCount = async (n: number, what: string, timeoutMs: number) => {
    expect(await waitForFrames(n, timeoutMs), what).toBe(true);
  };
  const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
  const paint = async (css: string) => {
    const before = frames.length;
    await page.evaluate((c: string) => {
      const el = document.getElementById("patch");
      if (el) (el as HTMLElement).style.background = c;
    }, css);
    await waitForCount(before + 1, `frame after ${css}`, 10_000);
    return decodePng(frames[frames.length - 1]);
  };

  await waitForCount(1, "first (full) frame", 15_000);
  expect((await getInfo()).partialRaster, "partials on by default").toBe(true);

  await paint("#ff0000");
  await paint("#00ffff");
  const partialsWhileOn = (await getInfo()).partialFramesRendered;
  expect(partialsWhileOn, "composites engaged before the switch").toBeGreaterThanOrEqual(1);

  const off = await cdpSession.send("Kitesurf.setPartialRaster", { enabled: false });
  expect(off.enabled).toBe(false);
  expect((await getInfo()).partialRaster, "switch reflected").toBe(false);

  for (const [css, rgb] of [
    ["#ffa500", [255, 165, 0]],
    ["#800080", [128, 0, 128]],
  ] as Array<[string, [number, number, number]]>) {
    const png = await paint(css);
    expect(
      near(sample(png, 330, 230), rgb),
      `full-frame fallback painted ${css} (got ${sample(png, 330, 230)})`,
    ).toBe(true);
    expect(near(sample(png, 50, 20), [0, 160, 0]), "header intact on the fallback path").toBe(true);
  }
  expect((await getInfo()).partialFramesRendered, "no composites while disabled").toBe(
    partialsWhileOn,
  );

  await cdpSession.send("Kitesurf.setPartialRaster", { enabled: true });
  const resumed = await paint("#0000ff");
  expect(near(sample(resumed, 330, 230), [0, 0, 255]), "re-keyed frame").toBe(true);
  const after = await paint("#ff00ff");
  expect(
    near(sample(after, 330, 230), [255, 0, 255]),
    `composite after re-enable (got ${sample(after, 330, 230)})`,
  ).toBe(true);
  const info = await getInfo();
  console.log(
    `[partial-switch] frames=${frames.length} on=${partialsWhileOn} ` +
      `after=${info.partialFramesRendered} relaunches=${info.relaunchCount}`,
  );
  expect(info.partialFramesRendered, "composites resume once re-enabled").toBeGreaterThan(
    partialsWhileOn,
  );
  expect(info.relaunchCount, "no renderer relaunch").toBe(0);

  await cdpSession.send("Page.stopScreencast");
});

test("a mid-cast resize forces a full frame at the new size", async ({ page, cdpSession }) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; background: #ffffff; }
  #header { position: absolute; left: 0; top: 0; width: 200px; height: 40px;
            background: #00a000; }
  #patch { position: absolute; left: 300px; top: 200px; width: 60px;
           height: 60px; background: #0000ff; }
</style></head>
<body><div id="header"></div><div id="patch"></div></body></html>`);

  await page.goto(HTML_URL, { timeout: 25_000 });

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

  const waitFor = async (pred: () => boolean, what: string, timeoutMs: number) => {
    if (!pred()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          frameWaiters.delete(notify);
          resolve();
        };
        const notify = () => {
          if (pred()) done();
        };
        const timer = setTimeout(done, timeoutMs);
        frameWaiters.add(notify);
      });
    }
    expect(pred(), what).toBe(true);
  };
  await waitFor(() => frames.length >= 1, "first (full) frame", 15_000);

  await page.evaluate(() => {
    const el = document.getElementById("patch");
    if (el) (el as HTMLElement).style.background = "#ff0000";
  });
  const getInfo = () => cdpSession.send("Kitesurf.getRendererInfo");
  await waitFor(() => frames.length >= 2, "frame after the pre-resize mutation", 10_000);

  const infoBefore = await getInfo();
  const partialsBefore = infoBefore.partialFramesRendered;
  expect(infoBefore.initialRes ?? "", "KS_INITIAL_RES forwarded").toMatch(/^\d+x\d+$/);

  await cdpSession.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const decodeLast = () => decodePng(frames[frames.length - 1]);
  await waitFor(
    () => frames.length >= 1 && decodeLast().width === 800,
    "a frame at the new size arrives",
    15_000,
  );
  {
    const png = decodeLast();
    expect(png.height, "full frame at the resized viewport").toBe(600);
    expect(near(sample(png, 330, 230), [255, 0, 0]), "patch intact").toBe(true);
    expect(near(sample(png, 50, 20), [0, 160, 0]), "header intact").toBe(true);
    expect(
      near(sample(png, 780, 580), [255, 255, 255]),
      "new-viewport corner painted (not a stale composite)",
    ).toBe(true);
  }

  const before = frames.length;
  await page.evaluate(() => {
    const el = document.getElementById("patch");
    if (el) (el as HTMLElement).style.background = "#ff00ff";
  });
  await waitFor(() => frames.length > before, "frame after the post-resize mutation", 10_000);
  {
    const png = decodeLast();
    expect(png.width, "post-resize frames keep the new size").toBe(800);
    expect(png.height).toBe(600);
    expect(
      near(sample(png, 330, 230), [255, 0, 255]),
      `patch shows the post-resize color (got ${sample(png, 330, 230)})`,
    ).toBe(true);
  }

  await cdpSession.send("Page.stopScreencast");
  const info = await getInfo();
  console.log(
    `[resize-full-frame] frames=${frames.length} rendered=${info.framesRendered} ` +
      `partialBefore=${partialsBefore} partialAfter=${info.partialFramesRendered}`,
  );
  expect(
    info.partialFramesRendered,
    "partials resume on the re-keyed base after the resize",
  ).toBeGreaterThan(partialsBefore);
  expect(info.relaunchCount, "no renderer relaunch").toBe(0);
});
