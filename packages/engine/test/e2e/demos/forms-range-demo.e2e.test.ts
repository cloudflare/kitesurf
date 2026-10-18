// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-range-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body style="margin:0">
        <input id="r" type="range" min="0" max="100" value="0"
               style="width:300px;height:20px;display:block;margin:40px">
        <div id="log"></div>
        <script>
          window.events = [];
          const r = document.getElementById("r");
          r.addEventListener("input",  () => window.events.push("input:" + r.value));
          r.addEventListener("change", () => window.events.push("change:" + r.value));
        </script>
      </body></html>`),
  );

  const shot0 = await page.screenshot({ type: "png" });
  await page.evaluate(() => {
    (document.getElementById("r") as any).value = "100";
  });
  const shot1 = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(shot0 as Buffer, shot1 as Buffer),
    "thumb must repaint when .value changes",
  ).not.toBe(0);

  await page.evaluate(() => {
    (document.getElementById("r") as any).value = "0";
    (window as any).events.length = 0;
  });

  const yMid = 50;
  await page.mouse.move(115, yMid);
  await page.mouse.down();
  await page.mouse.move(190, yMid, { steps: 3 });
  await page.mouse.move(265, yMid, { steps: 3 });
  await page.mouse.up();

  const result = await page.evaluate(() => {
    const r = document.getElementById("r") as any;
    return { value: r.valueAsNumber, events: (window as any).events as string[] };
  });

  expect(result.value).toBeGreaterThan(60);
  expect(result.value).toBeLessThan(90);
  const inputs = result.events.filter((e) => e.startsWith("input:"));
  const changes = result.events.filter((e) => e.startsWith("change:"));
  expect(inputs.length).toBeGreaterThan(0);
  expect(changes.length).toBe(1);
  expect(result.events[result.events.length - 1]).toMatch(/^change:/);

  const blocked = await page.evaluate(() => {
    const r = document.getElementById("r") as any;
    r.value = "0";
    (window as any).events.length = 0;
    r.addEventListener("mousedown", (e: any) => e.preventDefault(), { once: true });
    return r.value;
  });
  expect(blocked).toBe("0");
  await page.mouse.move(115, yMid);
  await page.mouse.down();
  await page.mouse.move(265, yMid, { steps: 2 });
  await page.mouse.up();
  const afterBlocked = await page.evaluate(() => (document.getElementById("r") as any).value);
  expect(afterBlocked).toBe("0");
});

test("forms-range-accent-color", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><body style="margin:0">
        <input id="r1" type="range" value="50" style="width:300px;display:block">
        <input id="r2" type="range" value="50" style="width:300px;display:block;accent-color:crimson">
      </body>`),
  );
  const computed = await page.evaluate(() => ({
    r1: getComputedStyle(document.getElementById("r1")!).getPropertyValue("accent-color"),
    r2: getComputedStyle(document.getElementById("r2")!).getPropertyValue("accent-color"),
  }));
  expect(computed.r1).toBe("auto");
  expect(computed.r2).toContain("220");
  const shot1 = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width: 320, height: 20 },
  });
  const shot2 = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 20, width: 320, height: 20 },
  });
  expect(Buffer.compare(shot1 as Buffer, shot2 as Buffer)).not.toBe(0);
});

test("forms-range-webkit-thumb-compat", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><head><style>
        .form-range::-webkit-slider-thumb { width: 1rem; background-color: navy; border: 0; }
        .form-range::-moz-range-thumb { background-color: navy; }
      </style></head><body>
        <input class="form-range" type="range" value="50" style="width:300px">
      </body></html>`),
  );
  const accent = await page.evaluate(() =>
    getComputedStyle(document.querySelector("input")!).getPropertyValue("accent-color"),
  );
  expect(accent).toBe("rgb(0, 0, 128)");
});
