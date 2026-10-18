// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test.for([false, true])(
  "idle scene streams wake promptly without extra scenes (text=%s)",
  async (text, { page, cdpSession }) => {
    const frames: number[] = [];
    let heartbeats = 0;
    cdpSession.on("Kitesurf.sceneFrame", (event) => {
      const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
      if (bytes[0] === 2) {
        const info = JSON.parse(new TextDecoder().decode(bytes.subarray(11))) as { t?: string };
        if (info.t === "sceneAlive") heartbeats++;
      }
      if (bytes[0] !== 3 && bytes[0] !== 5) return;
      const seq = new DataView(bytes.buffer).getUint32(3, true);
      frames.push(seq);
      void cdpSession.send("Kitesurf.sceneFrameAck", { seq, painted: true }).catch(() => {});
    });
    await cdpSession.send("Kitesurf.startSceneStream", {
      width: 800,
      height: 600,
      fps: 60,
      terminal: true,
      text,
      allowPartial: false,
    });
    try {
      await setContent(
        page,
        `<body style="margin:0;min-height:3000px">
      <a href="#done">link</a><div id="visible">initial</div>
      <canvas id="canvas" width="40" height="40"></canvas>`,
      );
      await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(0);
      await expect.poll(() => heartbeats, { timeout: 3000 }).toBeGreaterThan(0);
      const idleCount = frames.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(frames).toHaveLength(idleCount);
      const change = async (action: () => Promise<unknown>) => {
        // Every successful paint can return to idle. Exercise the push, not the 1 s backstop.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const count = frames.length;
        await action();
        await expect
          .poll(() => frames.length, { timeout: 650, interval: 20 })
          .toBeGreaterThan(count);
      };
      await change(() =>
        page.evaluate(() => {
          const visible = document.getElementById("visible");
          if (visible) visible.textContent = "updated";
        }),
      );
      await change(() =>
        cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab" }),
      );
      await change(() =>
        page.evaluate(() => {
          setTimeout(() => {
            const visible = document.getElementById("visible");
            if (visible) visible.textContent = "timer updated";
          }, 100);
        }),
      );
      await change(() =>
        page.evaluate(() => {
          const context = document.querySelector<HTMLCanvasElement>("#canvas")?.getContext("2d");
          if (!context) throw new Error("canvas context missing");
          context.fillStyle = "red";
          context.fillRect(0, 0, 40, 40);
        }),
      );
      await change(() =>
        cdpSession.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 10,
          y: 10,
          deltaY: 80,
        }),
      );
      const beforeNavigate = frames.length;
      await change(() => setContent(page, "<div>next document</div>"));
      expect(frames.at(-1)).toBeGreaterThan(frames[beforeNavigate - 1] ?? -1);
      await change(async () => {
        await cdpSession.send("Emulation.setDeviceMetricsOverride", {
          width: 640,
          height: 480,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdpSession.send("Kitesurf.startSceneStream", {
          width: 640,
          height: 480,
          fps: 60,
          terminal: true,
          text,
          allowPartial: false,
        });
      });
    } finally {
      await cdpSession.send("Kitesurf.stopSceneStream");
    }
  },
);

test("idle scene streams wake for rAF and CSS animation and coexist with screencast", async ({
  page,
  cdpSession,
}) => {
  let scenes = 0;
  let screenshots = 0;
  cdpSession.on("Kitesurf.sceneFrame", (event) => {
    const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
    if (bytes[0] !== 3 && bytes[0] !== 5) return;
    scenes++;
    const seq = new DataView(bytes.buffer).getUint32(3, true);
    void cdpSession.send("Kitesurf.sceneFrameAck", { seq, painted: true }).catch(() => {});
  });
  cdpSession.on("Page.screencastFrame", (event) => {
    screenshots++;
    void cdpSession.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 800,
    height: 600,
    fps: 30,
    allowPartial: false,
  });
  try {
    await setContent(
      page,
      `<style>
      @keyframes slide { from { left: 0 } to { left: 400px } }
      #box { position: absolute; top: 100px; width: 40px; height: 40px; background: red }
      .moving { animation: slide 2s linear infinite }
    </style><div id="box"></div>`,
    );
    await cdpSession.send("Page.startScreencast", { format: "png" });
    await expect.poll(() => scenes > 0 && screenshots > 0, { timeout: 5000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const beforeRaf = scenes;
    const beforeShots = screenshots;
    await page.evaluate(() => {
      const box = document.getElementById("box");
      if (!box) throw new Error("missing box");
      let ticks = 0;
      const animate = () => {
        box.style.left = `${++ticks * 10}px`;
        if (ticks < 12) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    });
    await expect
      .poll(() => scenes - beforeRaf, { timeout: 650, interval: 20 })
      .toBeGreaterThanOrEqual(3);
    await expect
      .poll(() => screenshots, { timeout: 650, interval: 20 })
      .toBeGreaterThan(beforeShots);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const beforeCss = scenes;
    await page.evaluate(() => {
      const box = document.getElementById("box");
      if (box) box.className = "moving";
    });
    await expect
      .poll(() => scenes - beforeCss, { timeout: 650, interval: 20 })
      .toBeGreaterThanOrEqual(3);
    await page.evaluate(() => {
      const box = document.getElementById("box");
      if (box) box.className = "";
    });
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
    await cdpSession.send("Page.stopScreencast");
  }
});

test("offscreen mutations do not flood the terminal scene stream", async ({ page, cdpSession }) => {
  const frames: number[] = [];
  cdpSession.on("Kitesurf.sceneFrame", (event) => {
    const binary = atob(event.data);
    if (binary.charCodeAt(0) !== 3) return;
    const seq = new DataView(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer,
    ).getUint32(3, true);
    frames.push(seq);
    void cdpSession.send("Kitesurf.sceneFrameAck", { seq, painted: true }).catch(() => {});
  });
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 800,
    height: 600,
    fps: 30,
    terminal: true,
    allowPartial: false,
  });
  try {
    await page.goto(
      "data:text/html," +
        encodeURIComponent(`<!doctype html>
      <body style="margin:0;height:3000px"><div id="visible">initial</div>
      <div id="offscreen" style="position:absolute;top:2500px;width:30px;height:30px"></div>
      <script>
        let ticks = 0;
        window.running = true;
        function animate() {
          document.getElementById("offscreen").setAttribute("data-tick", String(++ticks));
          window.ticks = ticks;
          if (window.running) requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
      </script>`),
    );
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "ticks") ?? 0), { timeout: 5000 })
      .toBeGreaterThan(10);
    const idleCount = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frames.length - idleCount).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const visible = document.getElementById("visible");
      if (!visible) throw new Error("visible element missing");
      visible.textContent = "updated";
    });
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(idleCount);
    const beforeWheel = frames.length;
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaY: 80,
    });
    expect(await page.evaluate(() => scrollY)).toBe(80);
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(beforeWheel);
  } finally {
    await page.evaluate(() => {
      Reflect.set(window, "running", false);
    });
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
});

test("terminal wheel bursts coalesce without losing scroll distance", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `<body style="height:3000px"><script>
    window.wheelEvents = 0;
    document.addEventListener("wheel", () => {
      if (++window.wheelEvents === 1) {
        const until = Date.now() + 30;
        while (Date.now() < until) {}
      }
    });
  </script>`,
  );
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 800,
    height: 600,
    fps: 10,
    terminal: true,
    allowPartial: false,
  });
  try {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        cdpSession.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 10,
          y: 10,
          deltaY: 80,
        }),
      ),
    );
    expect(await page.evaluate(() => scrollY)).toBe(800);
    expect(await page.evaluate(() => Reflect.get(window, "wheelEvents"))).toBeLessThan(10);
    await cdpSession.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown" });
    expect(await page.evaluate(() => scrollY)).toBe(840);
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
  const before = await page.evaluate(() => Reflect.get(window, "wheelEvents"));
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 10,
    y: 10,
    deltaY: 80,
  });
  expect(
    await page.evaluate(() => ({ y: scrollY, wheelEvents: Reflect.get(window, "wheelEvents") })),
  ).toEqual({ y: 920, wheelEvents: before + 1 });
});
