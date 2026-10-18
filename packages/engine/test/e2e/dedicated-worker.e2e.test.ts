// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { waitForTitle } from "./waits";

test("a blob worker answers messages and sees a worker global", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const reply = await page.evaluate(async () => {
    const source = `
      var seen = 0;
      self.onmessage = function (e) {
        seen += 1;
        postMessage({
          echo: e.data,
          seen: seen,
          name: self.name,
          isScope: self instanceof DedicatedWorkerGlobalScope,
          noDocument: typeof document === "undefined",
          protocol: location.protocol,
          ua: navigator.userAgent.length > 0,
        });
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { name: "echo" });
    const replies: unknown[] = [];
    await new Promise<void>((resolve) => {
      worker.onmessage = (e) => {
        replies.push(e.data);
        if (replies.length === 2) resolve();
      };
      worker.postMessage({ n: 1 });
      worker.postMessage({ n: 2, nested: [1, { deep: true }] });
    });
    worker.terminate();
    return replies;
  });
  expect(reply).toEqual([
    {
      echo: { n: 1 },
      seen: 1,
      name: "echo",
      isScope: true,
      noDocument: true,
      protocol: "blob:",
      ua: true,
    },
    {
      echo: { n: 2, nested: [1, { deep: true }] },
      seen: 2,
      name: "echo",
      isScope: true,
      noDocument: true,
      protocol: "blob:",
      ua: true,
    },
  ]);
});

test("a data: worker runs, and importScripts throws", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const reply = await page.evaluate(async () => {
    const source =
      "var r = 6 * 7; try { importScripts('x.js'); } catch (e) { r = [r, e.name]; } postMessage(r);";
    const worker = new Worker("data:text/javascript," + encodeURIComponent(source));
    const data = await new Promise((resolve) => {
      worker.addEventListener("message", (e) => resolve(e.data), { once: true });
    });
    worker.terminate();
    return data;
  });
  expect(reply).toEqual([42, "NetworkError"]);
});

test("an http worker loads from the page origin and fetches through the gateway", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/worker-host.html", {
    waitUntil: "domcontentloaded",
  });
  const reply = await page.evaluate(async () => {
    const worker = new Worker("/__fixtures/worker-echo.js");
    const data = await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage("ping");
    });
    worker.terminate();
    return data;
  });
  expect(reply).toEqual({
    echo: "ping",
    hops: 1,
    href: "http://127.0.0.1:8787/__fixtures/worker-echo.js",
    body: "kitesurf-xhr-ok",
  });
});

test("transferred buffers detach on the sender and arrive intact", async ({ page }) => {
  await setContent(
    page,
    `<script>
      globalThis.runTransfer = async function () {
        var source = "self.onmessage = function (e) {" +
          "var bytes = new Uint8Array(e.data); var sum = 0;" +
          "for (var i = 0; i < bytes.length; i++) sum += bytes[i];" +
          "var back = new Uint8Array([sum & 255]).buffer;" +
          "postMessage({ sum: sum, length: bytes.length, back: back }, [back]); };";
        var worker = new Worker(URL.createObjectURL(new Blob([source])));
        var buffer = new Uint8Array([1, 2, 3, 4]).buffer;
        var reply = await new Promise(function (resolve) {
          worker.onmessage = function (e) { resolve(e.data); };
          worker.postMessage(buffer, [buffer]);
        });
        worker.terminate();
        var portThrew = "";
        try {
          var port = new MessageChannel().port1;
          new Worker(URL.createObjectURL(new Blob([""]))).postMessage(port, [port]);
        } catch (err) {
          portThrew = err.name;
        }
        return JSON.stringify({
          detached: buffer.byteLength,
          sum: reply.sum,
          length: reply.length,
          back: Array.from(new Uint8Array(reply.back)),
          backIsBuffer: reply.back instanceof ArrayBuffer,
          portThrew: portThrew,
        });
      };
    </script>`,
  );
  const out = await page.evaluate(async () => {
    const run = Reflect.get(globalThis, "runTransfer") as () => Promise<string>;
    return JSON.parse(await run());
  });
  expect(out).toEqual({
    detached: 0,
    sum: 10,
    length: 4,
    back: [10],
    backIsBuffer: true,
    portThrew: "DataCloneError",
  });
});

test("terminate and self.close free the slot for the next worker", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const out = await page.evaluate(async () => {
    const blob = (src: string) => URL.createObjectURL(new Blob([src]));
    const firstReply = (w: Worker) =>
      new Promise((resolve) => {
        w.onmessage = (e) => resolve(e.data);
        w.onerror = () => resolve("error");
      });
    const a = new Worker(blob("postMessage('a')"));
    const aSaid = await firstReply(a);
    const b = new Worker(blob("postMessage('b')"));
    const bSaid = await firstReply(b);
    a.terminate();
    const c = new Worker(
      blob(
        "postMessage('c'); close(); postMessage('same task'); setTimeout(function () { postMessage('later task'); }, 0)",
      ),
    );
    const cSaid: unknown[] = [];
    await new Promise<void>((resolve) => {
      c.onmessage = (e) => cSaid.push(e.data);
      setTimeout(resolve, 500);
    });
    const d = new Worker(blob("postMessage('d')"));
    const dSaid = await firstReply(d);
    d.terminate();
    return { aSaid, bSaid, cSaid, dSaid };
  });
  expect(out).toEqual({ aSaid: "a", bSaid: "error", cSaid: ["c", "same task"], dSaid: "d" });
});

test("uncaught worker errors fire error on the Worker unless the worker handles them", async ({
  page,
}) => {
  await setContent(page, "<p>x</p>");
  const out = await page.evaluate(async () => {
    const run = (src: string, message: unknown) =>
      new Promise<unknown>((resolve) => {
        const w = new Worker(URL.createObjectURL(new Blob([src])));
        w.onerror = (e) => {
          e.preventDefault();
          resolve({ error: e.message, line: e.lineno, file: e.filename.slice(0, 5) });
          w.terminate();
        };
        w.onmessage = (e) => {
          resolve({ message: e.data });
          w.terminate();
        };
        w.postMessage(message);
      });
    const thrown = await run("self.onmessage = function () {\n  throw new Error('boom');\n};", 1);
    const handled = await run(
      "self.onerror = function () { postMessage('handled'); return true; };\n" +
        "self.onmessage = function () { throw new Error('quiet'); };",
      1,
    );
    return { thrown, handled };
  });
  expect(out).toEqual({
    thrown: { error: "Uncaught Error: boom", line: 2, file: "blob:" },
    handled: { message: "handled" },
  });
});

const firstReport = `
  globalThis.firstReport = function (src) {
    return new Promise(function (resolve) {
      var w = new Worker(URL.createObjectURL(new Blob([src])));
      w.onerror = function (e) { resolve({ error: e.constructor.name }); w.terminate(); };
      w.onmessage = function (e) {
        resolve({ message: e.data === undefined ? "undefined" : e.data });
        w.terminate();
      };
    });
  };`;

test("a worker script that does not parse fires a plain Event", async ({ page }) => {
  await setContent(page, `<script>${firstReport}</script>`);
  const out = await page.evaluate(() =>
    (Reflect.get(globalThis, "firstReport") as (s: string) => Promise<unknown>)("postMessage(1;"),
  );
  expect(out).toEqual({ error: "Event" });
});

test("a posted undefined arrives as undefined, and a null transfer throws TypeError", async ({
  page,
}) => {
  await setContent(page, `<script>${firstReport}</script>`);
  const out = await page.evaluate(async () => {
    const run = Reflect.get(globalThis, "firstReport") as (s: string) => Promise<unknown>;
    return {
      undef: await run("postMessage(undefined)"),
      nullTransfer: await run(
        "try { postMessage(false, [null]); } catch (e) { postMessage(e.constructor.name); }",
      ),
    };
  });
  expect(out).toEqual({ undef: { message: "undefined" }, nullTransfer: { message: "TypeError" } });
});

test("posting a SharedArrayBuffer throws DataCloneError on both sides", async ({ page }) => {
  await setContent(
    page,
    `<script>${firstReport}
      globalThis.runShared = async function () {
        var fromPage = "posted";
        var w = new Worker(URL.createObjectURL(new Blob([""])));
        try { w.postMessage({ nested: [new Uint8Array(new SharedArrayBuffer(4))] }); }
        catch (e) { fromPage = e.name; }
        w.terminate();
        var fromWorker = await firstReport(
          "try { postMessage(new SharedArrayBuffer(4)); } catch (e) { postMessage(e.name); }",
        );
        return JSON.stringify({ fromPage: fromPage, fromWorker: fromWorker });
      };
    </script>`,
  );
  const out = await page.evaluate(async () =>
    JSON.parse(await (Reflect.get(globalThis, "runShared") as () => Promise<string>)()),
  );
  expect(out).toEqual({ fromPage: "DataCloneError", fromWorker: { message: "DataCloneError" } });
});

test("a worker's clock starts at its creation", async ({ page }) => {
  await setContent(page, `<script>${firstReport}</script>`);
  const out = await page.evaluate(async () => {
    const run = Reflect.get(globalThis, "firstReport") as (s: string) => Promise<unknown>;
    const reply = (await run(
      "postMessage([performance.now(), performance.timeOrigin + performance.now()])",
    )) as { message: [number, number] };
    const [workerNow, workerEpoch] = reply.message;
    return {
      nowCountsFromWorkerStart: workerNow > 0 && workerNow < 60_000,
      epochMatchesPage: Math.abs(performance.timeOrigin + performance.now() - workerEpoch) < 60_000,
    };
  });
  expect(out).toEqual({ nowCountsFromWorkerStart: true, epochMatchesPage: true });
});

test("cross-origin and module workers throw at construction", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/worker-host.html", {
    waitUntil: "domcontentloaded",
  });
  const names = await page.evaluate(() => {
    const nameOf = (fn: () => unknown) => {
      try {
        fn();
        return "constructed";
      } catch (err) {
        return String(Reflect.get(Object(err), "name"));
      }
    };
    return {
      crossOrigin: nameOf(() => new Worker("https://example.com/w.js")),
      module: nameOf(() => new Worker("/__fixtures/worker-echo.js", { type: "module" })),
      shared: nameOf(() => new SharedWorker("/__fixtures/worker-echo.js")),
      noArguments: nameOf(() => Reflect.construct(Worker, [])),
    };
  });
  expect(names).toEqual({
    crossOrigin: "SecurityError",
    module: "NotSupportedError",
    shared: "SecurityError",
    noArguments: "TypeError",
  });
});

test("the page's CSP gates blob: and data: workers", async ({ page }) => {
  await setContent(
    page,
    `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' blob:">`,
  );
  const out = await page.evaluate(async () => {
    const firstReply = (url: string) =>
      new Promise((resolve) => {
        const w = new Worker(url);
        w.onmessage = (e) => {
          resolve(e.data);
          w.terminate();
        };
        w.onerror = () => resolve("error");
      });
    return {
      blob: await firstReply(URL.createObjectURL(new Blob(["postMessage('up')"]))),
      data: await firstReply("data:text/javascript,postMessage('up')"),
    };
  });
  expect(out).toEqual({ blob: "up", data: "error" });
});

test("Clerk's timer worker ticks", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const ticks = await page.evaluate(async () => {
    const source = `
      var timers = {};
      self.addEventListener("message", function (e) {
        if (e.data.type === "setTimeout") {
          timers[e.data.id] = setTimeout(function () {
            self.postMessage({ id: e.data.id });
          }, e.data.ms);
        }
      });`;
    const worker = new Worker(URL.createObjectURL(new Blob([source])));
    const fired: number[] = [];
    await new Promise<void>((resolve) => {
      worker.addEventListener("message", (e) => {
        fired.push(e.data.id);
        if (fired.length === 2) resolve();
      });
      worker.postMessage({ type: "setTimeout", id: 2, ms: 60 });
      worker.postMessage({ type: "setTimeout", id: 1, ms: 10 });
    });
    worker.terminate();
    return fired;
  });
  expect(ticks).toEqual([1, 2]);
});

test("navigating away terminates the old document's workers", async ({ page }) => {
  const startWorker = () =>
    page.evaluate(async () => {
      const worker = new Worker(URL.createObjectURL(new Blob(["postMessage('up')"])));
      return await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = () => resolve("error");
      });
    });
  await setContent(page, "<p>first</p>");
  expect(await startWorker()).toBe("up");
  await setContent(page, "<p>second</p>");
  expect(await startWorker()).toBe("up");
});

test("a worker started during load reaches its page", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/worker-at-load.html", {
    waitUntil: "domcontentloaded",
  });
  const title = await waitForTitle(page, "WORKER:", { prefix: true, timeout: 20_000 });
  expect(JSON.parse(title.slice("WORKER:".length))).toEqual({
    origin: "http://127.0.0.1:8787",
    body: "kitesurf-xhr-ok",
  });
});

test("setDocumentContent frees the slot for the new document's workers", async ({
  page,
  cdpSession,
}) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/worker-host.html", {
    waitUntil: "domcontentloaded",
  });
  const first = await page.evaluate(async () => {
    const worker = new Worker(URL.createObjectURL(new Blob(["postMessage('up')"])));
    return await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
    });
  });
  expect(first).toBe("up");
  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  await cdpSession.send("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html:
      "<script>var w = new Worker(URL.createObjectURL(new Blob(['postMessage(\"second\")'])));" +
      "w.onmessage = function (e) { document.title = 'DOC:' + e.data; };" +
      "w.onerror = function () { document.title = 'DOC:error'; };</script>",
  });
  expect(await waitForTitle(page, "DOC:", { prefix: true, timeout: 20_000 })).toBe("DOC:second");
});

test("a worker created in an OOPIF reports to that frame", async ({ page }) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-worker.html", {
    waitUntil: "load",
    timeout: 60_000,
  });
  const title = await waitForTitle(page, "OOPIF-WORKER:", { prefix: true, timeout: 30_000 });
  expect(JSON.parse(title.slice("OOPIF-WORKER:".length))).toEqual({
    worker: "error",
    message: "Failed to start worker: no isolate slot is free for this worker",
  });
});
