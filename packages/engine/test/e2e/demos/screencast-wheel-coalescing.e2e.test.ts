// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __wheelEvents: { dx: number; dy: number; shiftKey: boolean }[];
    __clickScrollY?: number;
  }
}

test("screencast-wheel-coalescing", async ({ page, cdpSession }) => {
  const html = `<!doctype html><html><body style="margin:0"><div id="outer" style="position:absolute;left:400px;top:100px;width:200px;height:200px;overflow:scroll"><div style="height:1000px"></div></div><div style="height:5000px"></div><button id="probe" style="position:fixed;left:10px;top:10px">probe</button>
    <script>
      window.__wheelEvents = [];
      window.addEventListener("wheel", function (event) {
        window.__wheelEvents.push({
          dx: event.deltaX,
          dy: event.deltaY,
          shiftKey: event.shiftKey,
        });
        if (event.shiftKey) event.preventDefault();
      }, { passive: false });
      document.getElementById("probe").addEventListener("click", function () {
        window.__clickScrollY = window.scrollY;
      });
    </script>
  </body></html>`;
  await page.goto(`data:text/html,${encodeURIComponent(html)}`, { timeout: 15000 });

  const reset = async () => {
    await page.evaluate(() => {
      window.__wheelEvents.length = 0;
      delete window.__clickScrollY;
      window.scrollTo(0, 0);
    });
  };
  const snapshot = () =>
    page.evaluate(() => ({
      events: window.__wheelEvents,
      scrollY: window.scrollY,
    }));

  let frames = 0;
  const frameWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (event: { sessionId: number }) => {
    frames++;
    for (const notify of [...frameWaiters]) notify();
    void cdpSession.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });

  const waitForFrames = (count: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (frames >= count) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        frameWaiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (frames >= count) done();
      };
      const timer = setTimeout(done, timeoutMs);
      frameWaiters.add(notify);
    });
  await waitForFrames(1, 5000);
  expect(frames, "screencast is active before the wheel burst").toBeGreaterThan(0);

  const burstSize = 24;
  await Promise.all(
    Array.from({ length: burstSize }, () =>
      cdpSession.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 10,
        y: 10,
        deltaY: 10,
      }),
    ),
  );
  const coalesced = await snapshot();
  expect(coalesced.events.length, "screencast wheels are coalesced").toBeLessThan(burstSize);
  expect(
    coalesced.events.reduce((sum, event) => sum + event.dy, 0),
    "coalescing preserves total scroll delta",
  ).toBe(burstSize * 10);
  expect(coalesced.scrollY, "coalesced wheels scroll the page").toBe(burstSize * 10);

  await reset();
  await Promise.all([
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 450,
      y: 150,
      deltaY: 10,
    }),
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 20,
    }),
  ]);
  const positions = await page.evaluate(() => ({
    events: window.__wheelEvents,
    scrollY: window.scrollY,
    outerScrollTop: document.getElementById("outer").scrollTop,
  }));
  expect(positions.events.length, "position changes split wheel batches").toBe(2);
  expect(positions.outerScrollTop, "the first position scrolls the nested element").toBe(10);
  expect(positions.scrollY, "the second position scrolls the document").toBe(20);

  await reset();
  await Promise.all(
    [
      { deltaY: 10, modifiers: 0 },
      { deltaY: 20, modifiers: 8 },
      { deltaY: 30, modifiers: 8 },
      { deltaY: 40, modifiers: 0 },
    ].map(({ deltaY, modifiers }) =>
      cdpSession.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 10,
        y: 10,
        deltaY,
        modifiers,
      }),
    ),
  );
  const modifiers = await snapshot();
  expect(modifiers.events.length, "modifier changes split wheel batches").toBeGreaterThanOrEqual(3);
  expect(
    modifiers.events.filter((event) => event.shiftKey).reduce((sum, event) => sum + event.dy, 0),
    "modifier changes split wheel batches",
  ).toBe(50);
  expect(modifiers.scrollY, "preventDefault cancels only the shifted batch").toBe(50);

  const otherSession = await page.createCDPSession();
  await reset();
  for (let i = 0; i < 3; i++) {
    await otherSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 1,
    });
  }
  const other = await snapshot();
  expect(other.events.length, "another session stays one-for-one").toBe(3);
  expect(other.scrollY, "another session keeps synchronous wheel replies").toBe(3);
  await otherSession.detach();

  const takeover = await page.createCDPSession();
  let takeoverFrames = 0;
  const takeoverWaiters = new Set<() => void>();
  takeover.on("Page.screencastFrame", (event: { sessionId: number }) => {
    takeoverFrames++;
    for (const notify of [...takeoverWaiters]) notify();
    void takeover.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  const waitForTakeoverFrames = (count: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (takeoverFrames >= count) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        takeoverWaiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (takeoverFrames >= count) done();
      };
      const timer = setTimeout(done, timeoutMs);
      takeoverWaiters.add(notify);
    });

  await reset();
  const queuedBurst = Array.from({ length: burstSize }, (_, i) =>
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10 + (i % 5),
      y: 10,
      deltaY: 10,
    }),
  );
  const takeoverReply = takeover.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  const newOwnerWheel = takeover.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 10,
    y: 10,
    deltaY: 1,
  });
  await takeoverReply;
  await Promise.all(queuedBurst);
  await newOwnerWheel;
  const drained = await snapshot();
  expect(
    drained.events.reduce((sum, event) => sum + event.dy, 0),
    "former-owner wheels accepted before takeover still dispatch",
  ).toBe(burstSize * 10 + 1);
  expect(drained.scrollY, "queued former-owner wheels scroll the page").toBe(burstSize * 10 + 1);
  expect(
    drained.events[drained.events.length - 1]?.dy,
    "the new owner's wheel dispatches after the former burst",
  ).toBe(1);

  await waitForTakeoverFrames(1, 5000);
  expect(takeoverFrames, "the new owner receives screencast frames after takeover").toBeGreaterThan(
    0,
  );

  await reset();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      cdpSession.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 10,
        y: 10,
        deltaY: 1,
      }),
    ),
  );
  const formerOwner = await snapshot();
  expect(formerOwner.events.length, "the former owner loses coalescing after takeover").toBe(3);
  expect(formerOwner.scrollY, "the former owner keeps synchronous wheel replies").toBe(3);

  await reset();
  const takeoverBurst = Array.from({ length: burstSize }, () =>
    takeover.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 1,
    }),
  );
  await Promise.all(takeoverBurst);
  const newOwner = await snapshot();
  expect(newOwner.events.length, "the new owner coalesces wheels after takeover").toBeLessThan(
    burstSize,
  );
  expect(newOwner.scrollY, "coalesced wheels scroll the page after takeover").toBe(burstSize);

  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  await reset();
  await Promise.all(
    Array.from({ length: 2 }, () =>
      takeover.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 10,
        y: 10,
        deltaY: 1,
      }),
    ),
  );
  const formerTakeover = await snapshot();
  expect(formerTakeover.events.length, "the interim owner loses coalescing on re-takeover").toBe(2);
  expect(formerTakeover.scrollY, "the interim owner keeps synchronous wheel replies").toBe(2);
  await takeover.detach();

  const handoffTakeover = await page.createCDPSession();
  await reset();
  const drainBurst = Array.from({ length: burstSize }, (_, i) =>
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10 + i,
      y: 10,
      deltaY: 10,
    }),
  );
  const handoffReply = handoffTakeover.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  await handoffTakeover.send("Page.stopScreencast");
  const clickPress = cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1,
  });
  const clickRelease = cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1,
  });
  await Promise.all([handoffReply, ...drainBurst, clickPress, clickRelease]);
  const clickOrder = await page.evaluate(() => ({
    scrollY: window.scrollY,
    clickScrollY: window.__clickScrollY,
  }));
  expect(clickOrder.clickScrollY, "the former owner's click lands after its own wheel drain").toBe(
    burstSize * 10,
  );
  expect(clickOrder.scrollY, "the accepted burst still scrolls").toBe(burstSize * 10);
  await handoffTakeover.detach();

  await reset();
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  const stoppingBurst = Array.from({ length: burstSize }, () =>
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 2,
    }),
  );
  await cdpSession.send("Page.stopScreencast");
  await Promise.all(stoppingBurst);
  const stopped = await snapshot();
  expect(
    stopped.events.length,
    "stopping a live screencast preserves coalescing while draining",
  ).toBeLessThan(burstSize);
  expect(
    stopped.events.reduce((sum, event) => sum + event.dy, 0),
    "stopping the screencast does not discard accepted wheel commands",
  ).toBe(burstSize * 2);
  expect(stopped.scrollY, "accepted wheel commands finish before their replies").toBe(
    burstSize * 2,
  );

  await reset();
  for (let i = 0; i < 3; i++) {
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 1,
    });
  }
  const ordinary = await snapshot();
  expect(ordinary.events.length, "ordinary CDP wheels stay one-for-one").toBe(3);
  expect(ordinary.scrollY, "ordinary CDP wheel replies stay synchronous").toBe(3);

  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  const navOwner = await page.createCDPSession();
  await reset();
  const drainingBurst = Array.from({ length: burstSize }, (_, i) =>
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10 + (i % 5),
      y: 10,
      deltaY: 10,
    }),
  );
  const navTakeover = navOwner.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  const gotoP = page.goto(`data:text/html,${encodeURIComponent(html)}`, {
    timeout: 15000,
  });
  const teardownWheel = navOwner.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 10,
    y: 10,
    deltaY: 5,
  });
  await gotoP;
  await Promise.all([navTakeover, ...drainingBurst, teardownWheel]);

  await reset();
  const postNavBurst = Array.from({ length: burstSize }, () =>
    navOwner.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 1,
    }),
  );
  await Promise.all(postNavBurst);
  const postNav = await snapshot();
  expect(postNav.events.length, "the owner coalesces wheels after navigation").toBeLessThan(
    burstSize,
  );
  expect(postNav.scrollY, "coalesced wheels scroll the new document").toBe(burstSize);
  await navOwner.detach();

  const root = cdpSession.connection()!;
  await root.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  await reset();
  const rootBurst = Array.from({ length: burstSize }, (_, i) =>
    root.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10 + i,
      y: 10,
      deltaY: 10,
    }),
  );
  const rootTakeover = cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 100,
    maxInFlight: 1,
  });
  const rootPress = root.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1,
  });
  const rootRelease = root.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1,
  });
  await rootTakeover;
  await Promise.all([...rootBurst, rootPress, rootRelease]);
  const rootClick = await page.evaluate(() => ({
    scrollY: window.scrollY,
    clickScrollY: window.__clickScrollY,
  }));
  expect(rootClick.clickScrollY, "the root session's click lands after its own wheel drain").toBe(
    burstSize * 10,
  );
  expect(rootClick.scrollY, "the root session's accepted burst still scrolls").toBe(burstSize * 10);
});

test("screencast wheel respects overscroll boundaries on both axes", async ({
  page,
  cdpSession,
}) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><style>
        html,body{margin:0;width:2000px;height:2000px}
        #outer-y{position:absolute;left:0;top:0;width:100px;height:100px;
          overflow:auto;overscroll-behavior-y:auto}
        #inner-y{width:100px;height:300px}
        #outer-x{position:absolute;left:120px;top:0;width:100px;height:100px;
          overflow:auto;overscroll-behavior-x:auto}
        #inner-x{width:300px;height:100px}
      </style><div id=outer-y><div id=inner-y></div></div>
      <div id=outer-x><div id=inner-x></div></div>`),
    { timeout: 15_000 },
  );

  const scrollOffsets: Array<{ x: number; y: number }> = [];
  cdpSession.on(
    "Page.screencastFrame",
    (event: { sessionId: number; metadata: { scrollOffsetX: number; scrollOffsetY: number } }) => {
      scrollOffsets.push({ x: event.metadata.scrollOffsetX, y: event.metadata.scrollOffsetY });
      void cdpSession
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => {});
    },
  );
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
  });
  await expect.poll(() => scrollOffsets.length, { timeout: 5_000 }).toBeGreaterThan(0);

  const wheel = (x: number, y: number, deltaX: number, deltaY: number) =>
    cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  const scrollY = async (behavior: "auto" | "contain" | "none") => {
    await page.evaluate((value: string) => {
      const outer = document.getElementById("outer-y") as HTMLElement;
      outer.style.overscrollBehaviorY = value;
      outer.scrollTop = 10_000;
      window.scrollTo(0, 0);
    }, behavior);
    const at = await page.evaluate(() => ({
      inner: (document.getElementById("outer-y") as HTMLElement).scrollTop,
      page: window.scrollY,
      behavior: getComputedStyle(document.getElementById("outer-y")!).overscrollBehaviorY,
    }));
    expect(at.inner).toBe(200);
    expect(at.page).toBe(0);
    expect(at.behavior).toBe(behavior);
    await wheel(50, 50, 0, 80);
    return page.evaluate(() => ({
      inner: (document.getElementById("outer-y") as HTMLElement).scrollTop,
      page: window.scrollY,
    }));
  };
  const autoY = await scrollY("auto");
  expect(autoY).toEqual({ inner: 200, page: 80 });
  await expect.poll(() => scrollOffsets.at(-1)?.y, { timeout: 5_000 }).toBe(80);
  const containY = await scrollY("contain");
  expect(containY).toEqual({ inner: 200, page: 0 });
  const noneY = await scrollY("none");
  expect(noneY).toEqual({ inner: 200, page: 0 });

  const scrollX = async (behavior: "auto" | "contain" | "none") => {
    await page.evaluate((value: string) => {
      const outer = document.getElementById("outer-x") as HTMLElement;
      outer.style.overscrollBehaviorX = value;
      outer.scrollLeft = 10_000;
      window.scrollTo(0, 0);
    }, behavior);
    const at = await page.evaluate(() => ({
      inner: (document.getElementById("outer-x") as HTMLElement).scrollLeft,
      page: window.scrollX,
      behavior: getComputedStyle(document.getElementById("outer-x")!).overscrollBehaviorX,
    }));
    expect(at.inner).toBe(200);
    expect(at.page).toBe(0);
    expect(at.behavior).toBe(behavior);
    await wheel(150, 50, 80, 0);
    return page.evaluate(() => ({
      inner: (document.getElementById("outer-x") as HTMLElement).scrollLeft,
      page: window.scrollX,
    }));
  };
  const autoX = await scrollX("auto");
  expect(autoX).toEqual({ inner: 200, page: 80 });
  await expect.poll(() => scrollOffsets.at(-1)?.x, { timeout: 5_000 }).toBe(80);
  const containX = await scrollX("contain");
  expect(containX).toEqual({ inner: 200, page: 0 });
  const noneX = await scrollX("none");
  expect(noneX).toEqual({ inner: 200, page: 0 });

  await cdpSession.send("Page.stopScreencast");
});

test("screencast takeover transfers frame and stop ownership", async ({ page, cdpSession }) => {
  let firstOwnerFrames = 0;
  let firstOwnerAck: Promise<unknown> | undefined;
  const firstOwnerWaiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (event: { sessionId: number }) => {
    firstOwnerFrames++;
    for (const notify of [...firstOwnerWaiters]) notify();
    firstOwnerAck = cdpSession.send("Page.screencastFrameAck", {
      sessionId: event.sessionId,
    });
  });
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 800,
    maxHeight: 600,
    minFrameIntervalMs: 1000,
  });
  const waitForFirstOwnerFrames = (count: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (firstOwnerFrames >= count) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        firstOwnerWaiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (firstOwnerFrames >= count) done();
      };
      const timer = setTimeout(done, timeoutMs);
      firstOwnerWaiters.add(notify);
    });
  await waitForFirstOwnerFrames(1, 5_000);
  expect(firstOwnerFrames).toBeGreaterThan(0);
  await firstOwnerAck;

  const nextOwner = await page.createCDPSession();
  const nextOwnerFrames: Array<{ width: number; height: number }> = [];
  const nextOwnerWaiters = new Set<() => void>();
  nextOwner.on(
    "Page.screencastFrame",
    (event: { sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      nextOwnerFrames.push({
        width: event.metadata.deviceWidth,
        height: event.metadata.deviceHeight,
      });
      for (const notify of [...nextOwnerWaiters]) notify();
      void nextOwner.send("Page.screencastFrameAck", {
        sessionId: event.sessionId,
      });
    },
  );
  const waitForNextOwnerFrames = (count: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (nextOwnerFrames.length >= count) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        nextOwnerWaiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (nextOwnerFrames.length >= count) done();
      };
      const timer = setTimeout(done, timeoutMs);
      nextOwnerWaiters.add(notify);
    });
  const takeoverStartedAt = Date.now();
  await nextOwner.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 400,
    maxHeight: 300,
    minFrameIntervalMs: 16,
  });
  await waitForNextOwnerFrames(1, 5_000);
  expect(nextOwnerFrames.length).toBeGreaterThan(0);
  expect(Date.now() - takeoverStartedAt).toBeLessThan(750);
  expect(nextOwnerFrames.every(({ width, height }) => width === 400 && height === 300)).toBe(true);

  await cdpSession.send("Page.stopScreencast");
  const framesBeforeNavigation = nextOwnerFrames.length;
  await page.goto("data:text/html,<body>changed</body>");
  await waitForNextOwnerFrames(framesBeforeNavigation + 1, 5_000);
  expect(nextOwnerFrames.length).toBeGreaterThan(framesBeforeNavigation);

  await nextOwner.send("Page.stopScreencast");
  await nextOwner.detach();
});
