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

test("a rejection after load reaches a client that sends nothing more", async ({ page }) => {
  const reported = new Promise<string>((resolve) => {
    page.on("pageerror", (error) => resolve(error.message.split("\n")[0] ?? ""));
  });
  // No DOM session and no command after the page loads, so nothing drains the page on its own
  // schedule: the page must wake the engine itself.
  await setContent(
    page,
    `<script>
      setTimeout(function () {
        (async function later() { throw new Error("after load"); })();
      }, 300);
    </script>`,
  );
  expect(await reported).toBe("after load");
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

// workerd tracks V8's promises only: boa reports its own, and the handler its bridge attaches to a
// V8 promise read from boa code must not count as the page handling an already reported rejection.
test("a rejection in boa code is reported, and boa reading one does not handle it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.split("\n")[0] ?? ""));
  await setContent(
    page,
    `<script>
      window.__events = [];
      var note = function (e) {
        window.__events.push([e.type, String(Object(e.reason).message)]);
      };
      addEventListener("unhandledrejection", note);
      addEventListener("rejectionhandled", note);
      window.late = Promise.reject(new Error("late"));
    </script>`,
  );
  await page.waitForFunction("window.__events.length >= 1", { timeout: 10_000 });
  expect(await page.evaluate(() => typeof Reflect.get(window, "late"))).toBe("object");
  // The client awaits this one, so it handles the rejection: the page hears no event, and the
  // client gets no pageerror for it.
  await expect(page.evaluate(() => Promise.reject(new Error("awaited")))).rejects.toThrow(
    "awaited",
  );
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent =
      'var handledLater = (async function () { throw new Error("handled later"); })();' +
      "setTimeout(function () { handledLater.catch(function () {}); }, 0);" +
      '(async function () { throw new Error("inserted"); })();';
    document.head.appendChild(script);
  });
  await page.waitForFunction("window.__events.length >= 2", { timeout: 10_000 });
  // A rejectionhandled is queued as a task right after the handler that causes it, so one the
  // read or the later handler caused would be in by now.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await page.evaluate("window.__events")).toEqual([
    ["unhandledrejection", "late"],
    ["unhandledrejection", "inserted"],
  ]);
  await expect.poll(() => [...errors].sort(), { timeout: 10_000 }).toEqual(["inserted", "late"]);
});
