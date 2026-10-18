// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// reCAPTCHA nests `this.a=(this.b=(...` ~75 deep in a function. boa's parser spent ~9 KiB of
// wasm stack per level there, trapped past ~90, and left the module terminated for the page.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const depth = 150;

test("deeply nested assignments and operators parse on boa", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");

  let assignments = "7";
  for (let i = 0; i < depth; i++) assignments = `o.p${i}=(${assignments})`;
  const chain = await page.evaluate(
    `(function () { var o = {}; ${assignments}; return [o.p0, o.p${depth - 1}, Object.keys(o).length]; })()`,
  );
  expect(chain).toEqual([7, 7, depth]);

  let operators = "0";
  for (let i = 0; i < depth; i++) operators = `(${operators} * 1 + 1)`;
  expect(await page.evaluate(operators)).toBe(depth);

  expect(await page.evaluate("[1, 2, 3].map((n) => n * 2).join()")).toBe("2,4,6");
}, 60_000);
