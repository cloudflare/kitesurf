// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng } from "./png";

test("scheduler.postTask runs the callback as a later task", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const order = await page.evaluate(async () => {
    const seen: string[] = [];
    const scheduler = Reflect.get(globalThis, "scheduler");
    const task = scheduler.postTask(() => {
      seen.push("task");
      return 7;
    });
    queueMicrotask(() => seen.push("microtask"));
    seen.push("sync");
    const value = await task;
    return [...seen, String(value)];
  });
  expect(order).toEqual(["sync", "microtask", "task", "7"]);
});

test("IndexedDB stores and reads back a record", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const value = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ks-test", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("records");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put({ shape: "draw" }, "a");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const names = (await indexedDB.databases()).map((d) => d.name);
    const record = await new Promise((resolve, reject) => {
      const req = db.transaction("records").objectStore("records").get("a");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return { names, record };
  });
  expect(value).toEqual({ names: ["ks-test"], record: { shape: "draw" } });
});

test("ctx.fill(Path2D) paints the path and keeps the default path", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<body style="margin:0;background:#fff"><canvas id="c" width="200" height="100"></canvas>
    <script>
      const ctx = document.getElementById("c").getContext("2d");
      ctx.fillStyle = "#e00";
      ctx.beginPath();
      ctx.rect(0, 0, 40, 40);
      const outline = new Path2D("M100 0h40v40h-40z");
      const moved = new Path2D();
      moved.addPath(outline, { e: 20, f: 50 });
      // A non-finite transform adds nothing (HTML addPath step 2).
      const dropped = new Path2D();
      dropped.addPath(new Path2D("M60 60h20v20h-20z"), { e: NaN });
      ctx.fill(outline);
      ctx.fill(moved);
      ctx.fill(dropped);
      ctx.fill();
    </script>`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const png = await decodePng(new Uint8Array(await page.screenshot({ encoding: "binary" })));
  const redAt = (x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return (
      (png.data[i] ?? 0) > 150 && (png.data[i + 1] ?? 255) < 80 && (png.data[i + 2] ?? 255) < 80
    );
  };
  expect(redAt(20, 20)).toBe(true);
  expect(redAt(120, 20)).toBe(true);
  expect(redAt(140, 70)).toBe(true);
  expect(redAt(70, 20)).toBe(false);
  expect(redAt(110, 70)).toBe(false);
  expect(redAt(70, 70)).toBe(false);
  const misuse = await page.evaluate(() => {
    try {
      Path2D.prototype.moveTo.call({}, 0, 0);
      return "no throw";
    } catch (err) {
      return String(Reflect.get(Object(err), "name"));
    }
  });
  expect(misuse).toBe("TypeError");
});

test("a trusted pointermove lists itself as a coalesced event", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<body style="margin:0"><div style="width:200px;height:100px"></div>
    <script>
      window.moves = [];
      addEventListener("pointermove", (e) => {
        const list = e.getCoalescedEvents();
        window.moves.push({ n: list.length, x: list[0]?.clientX, type: list[0]?.type });
      });
    </script>`,
  );
  await page.mouse.move(50, 50);
  const moves = await page.evaluate(() => Reflect.get(window, "moves"));
  expect(moves.at(-1)).toEqual({ n: 1, x: 50, type: "pointermove" });
});

test("a pointer-events:all button takes the click back from its layer", async ({ page }) => {
  await page.setViewport({ width: 400, height: 300 });
  await setContent(
    page,
    `<body style="margin:0"><div style="position:relative;width:400px;height:300px">
      <span dir="ltr"><div id="canvas" style="position:absolute;inset:0;width:100%;height:100%"></div></span>
      <div id="layer" style="position:relative;height:100%;z-index:300;pointer-events:none">
        <button id="tool" style="position:absolute;left:20px;bottom:20px;width:40px;height:40px;pointer-events:all"></button>
      </div>
    </div>
    <script>
      window.clicks = [];
      addEventListener("click", (e) => window.clicks.push(e.target.id));
    </script>`,
  );
  const layerTop = await page.evaluate(
    () => document.getElementById("layer")?.getBoundingClientRect().top,
  );
  expect(layerTop).toBe(0);
  await page.mouse.click(40, 260);
  await page.mouse.click(200, 100);
  const clicks = await page.evaluate(() => Reflect.get(window, "clicks"));
  expect(clicks).toEqual(["tool", "canvas"]);
});

test("a mouse move fires pointer boundary events before mouse ones", async ({ page }) => {
  await page.setViewport({ width: 400, height: 300 });
  await setContent(
    page,
    `<body style="margin:0">
    <div id="a" style="position:absolute;left:0;top:0;width:100px;height:100px"></div>
    <div id="b" style="position:absolute;left:200px;top:0;width:100px;height:100px"></div>
    <script>
      window.log = [];
      for (const t of ["pointerover", "pointerenter", "pointerout", "pointerleave",
                       "mouseover", "mouseenter", "mouseout", "mouseleave"]) {
        document.addEventListener(t, (e) => {
          if (e.target.id) log.push(t + ":" + e.target.id + (e.pointerType ? "/" + e.pointerType : ""));
        }, true);
      }
    </script>`,
  );
  for (const [x, y] of [
    [350, 250],
    [50, 50],
    [250, 50],
  ] as const) {
    await page.mouse.move(x, y);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const log = await page.evaluate(() => Reflect.get(window, "log"));
  expect(log).toEqual([
    "pointerover:a/mouse",
    "pointerenter:a/mouse",
    "mouseover:a",
    "mouseenter:a",
    "pointerout:a/mouse",
    "pointerleave:a/mouse",
    "pointerover:b/mouse",
    "pointerenter:b/mouse",
    "mouseout:a",
    "mouseleave:a",
    "mouseover:b",
    "mouseenter:b",
  ]);
});
