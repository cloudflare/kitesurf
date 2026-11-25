// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// onerror ran once with the ErrorEvent and again with five arguments, so a handler reading the
// message as a string threw on the first call (Microsoft's WebWatson, on its sign-in page).
test("window.onerror runs once with an ErrorEvent's fields", async ({ page }) => {
  await setContent(
    page,
    `<script>
      const calls = [];
      const prevented = [];
      const target = document.createElement("div");
      target.addEventListener("boom", () => { throw "listener threw"; });
      window.onerror = function (...args) {
        calls.push(args.map((arg) => (typeof arg === "object" ? String(arg) : arg)));
        return args[0] === "Uncaught cancel";
      };
      window.addEventListener("error", (event) => prevented.push(event.defaultPrevented));
      target.dispatchEvent(new Event("boom"));
      window.dispatchEvent(
        new ErrorEvent("error", { message: "synthetic", filename: "a.js", lineno: 3, colno: 4, error: "e" }),
      );
      window.dispatchEvent(new Event("error"));
      target.addEventListener("cancel", () => { throw "cancel"; });
      target.dispatchEvent(new Event("cancel"));
      window.onerror = null;
      onerror = (...args) => calls.push(["bare", args.length]);
      target.dispatchEvent(new Event("boom"));
      window.__onerror = JSON.stringify({ calls, prevented });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__onerror)")).toEqual({
    calls: [
      ["Uncaught listener threw", "", 0, 0, "listener threw"],
      ["synthetic", "a.js", 3, 4, "e"],
      ["[object Event]"],
      ["Uncaught cancel", "", 0, 0, "cancel"],
      ["bare", 5],
    ],
    prevented: [false, false, false, true, false],
  });
});
