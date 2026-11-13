// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A script that fails inside an async function only rejects a promise; the page must still see
// unhandledrejection, and a CDP client the "Uncaught (in promise)" exception Chrome reports.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an unhandled rejection fires at window and is reported unless canceled", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.split("\n")[0] ?? ""));
  // These rejections are reported after load, and exceptions raised then reach CDP only on the
  // background drain, which DOM.enable turns on.
  const session = await page.createCDPSession();
  await session.send("DOM.enable");
  await setContent(
    page,
    `<script>
      var byReason = (window.__byReason = {});
      window.__count = 0;
      var text = function (r) { return r instanceof Error ? r.message : String(r); };
      var note = function (reason, entry) {
        (byReason[reason] = byReason[reason] || []).push(entry);
        window.__count++;
      };
      var record = function (e) {
        var p = e.promise;
        note(text(e.reason), [e.type, e instanceof PromiseRejectionEvent, p instanceof Promise,
          e.cancelable, e.isTrusted]);
        if (e.reason === "quiet") e.preventDefault();
        if (text(e.reason) === "attached") p.catch(function () {});
      };
      addEventListener("unhandledrejection", record);
      addEventListener("rejectionhandled", record);
      window.onunhandledrejection = function (e) { note(text(e.reason), ["handler"]); };
      (async function boot() { throw new Error("boot failed"); })();
      Promise.reject("quiet");
      Promise.reject(new Error("attached"));
      var late = Promise.reject(new Error("late"));
      setTimeout(function () { late.catch(function () {}); }, 100);
    </script>`,
  );
  await page.waitForFunction("window.__count >= 9", { timeout: 10_000 });
  await expect.poll(() => errors.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  const unhandled = [["unhandledrejection", true, true, true, true], ["handler"]];
  expect(await page.evaluate("window.__byReason")).toEqual({
    "boot failed": unhandled,
    quiet: unhandled,
    attached: unhandled,
    late: [...unhandled, ["rejectionhandled", true, true, false, true]],
  });
  expect(errors.sort()).toEqual(["attached", "boot failed", "late"]);
});

// Evaluated and inserted code runs on boa, which reaches a V8 promise through a bridge. The
// bridge must attach its handler at once, or a rejection that boa code handles looks unhandled.
test("a rejected V8 promise that boa code handles is not reported", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.split("\n")[0] ?? ""));
  const session = await page.createCDPSession();
  await session.send("DOM.enable");
  await setContent(
    page,
    `<script>
      window.__seen = [];
      addEventListener("unhandledrejection", function (e) { window.__seen.push(String(e.reason)); });
    </script>`,
  );
  // An unclosed IPv6 literal makes fetch reject before its first await, so the promise is
  // already rejected when it crosses to the code that handles it.
  const evaluated = await page.evaluate(() =>
    fetch("http://[").then(
      () => "ok",
      () => "caught",
    ),
  );
  expect(evaluated).toBe("caught");
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent =
      'fetch("http://[").catch(function () { window.__insertedCaught = true; });';
    document.head.appendChild(script);
  });
  await page.waitForFunction("window.__insertedCaught === true", { timeout: 10_000 });
  // A rejection whose handler came late was reported within the bridge's next poll, at most
  // 100 ms away: none by now means none was.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await page.evaluate("window.__seen")).toEqual([]);
  expect(errors).toEqual([]);
});
