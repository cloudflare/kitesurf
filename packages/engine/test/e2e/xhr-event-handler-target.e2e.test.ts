// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("XHR event handler attributes see the event's target and currentTarget", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const xhr = new XMLHttpRequest();
    const log: string[] = [];
    xhr.onreadystatechange = (event) => {
      log.push(`handler:${event.target === xhr}:${event.currentTarget === xhr}:${xhr.readyState}`);
    };
    xhr.addEventListener("readystatechange", (event) => {
      log.push(`listener:${event.target === xhr}:${xhr.readyState}`);
    });
    xhr.open("GET", "data:text/plain,hi");
    return log;
  });
  expect(seen).toEqual(["handler:true:true:1", "listener:true:1"]);
});

test("XHR event handler attributes run in registration order with listeners", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const xhr = new XMLHttpRequest();
    const log: string[] = [];
    xhr.addEventListener("readystatechange", () => log.push("listener"));
    xhr.onreadystatechange = () => log.push("handler");
    xhr.open("GET", "data:text/plain,hi");
    const handlerIsNull = (() => {
      xhr.onreadystatechange = null;
      return xhr.onreadystatechange === null;
    })();
    xhr.open("GET", "data:text/plain,hi");
    return { log, handlerIsNull, initial: new XMLHttpRequest().onload };
  });
  expect(seen).toEqual({
    log: ["listener", "handler", "listener"],
    handlerIsNull: true,
    initial: null,
  });
});

test("a replaced XHR event handler keeps its place among listeners", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const xhr = new XMLHttpRequest();
    const replaced: string[] = [];
    xhr.onreadystatechange = () => replaced.push("first");
    xhr.addEventListener("readystatechange", () => replaced.push("listener"));
    xhr.onreadystatechange = () => replaced.push("second");
    xhr.open("GET", "data:text/plain,hi");

    // A non-callable object stays in the slot, so the handler keeps its place.
    const inert: string[] = [];
    const other = new XMLHttpRequest();
    other.onload = () => inert.push("first");
    other.addEventListener("load", () => inert.push("listener"));
    const marker = {};
    Reflect.set(other, "onload", marker);
    const keptObject = Reflect.get(other, "onload") === marker;
    other.dispatchEvent(new Event("load"));
    other.onload = () => inert.push("second");
    other.dispatchEvent(new Event("load"));
    return { replaced, inert, keptObject };
  });
  expect(seen).toEqual({
    replaced: ["second", "listener"],
    inert: ["listener", "second", "listener"],
    keptObject: true,
  });
});

test("an XHR event handler that returns false cancels the event", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => false;
    const event = new Event("load", { cancelable: true });
    const notCanceled = xhr.dispatchEvent(event);
    return { notCanceled, defaultPrevented: event.defaultPrevented };
  });
  expect(seen).toEqual({ notCanceled: false, defaultPrevented: true });
});

test("a throwing XHR event handler does not stop later listeners", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const xhr = new XMLHttpRequest();
    const log: string[] = [];
    xhr.onreadystatechange = () => {
      log.push("handler");
      throw new Error("handler failed");
    };
    xhr.addEventListener("readystatechange", () => log.push("listener"));
    xhr.open("GET", "data:text/plain,hi");
    return log;
  });
  expect(seen).toEqual(["handler", "listener"]);
});

test("XHR and FileReader event handlers reject a receiver of the wrong type", async ({ page }) => {
  await setContent(page, "<!doctype html><title>xhr</title>");
  const seen = await page.evaluate(() => {
    const errorName = (run: () => unknown) => {
      try {
        run();
        return "none";
      } catch (error) {
        return error instanceof TypeError ? "TypeError" : String(error);
      }
    };
    return {
      xhrGet: errorName(() => XMLHttpRequest.prototype.onload),
      xhrSet: errorName(() => {
        XMLHttpRequest.prototype.onload = () => {};
      }),
      readerSet: errorName(() => {
        FileReader.prototype.onload = () => {};
      }),
    };
  });
  expect(seen).toEqual({ xhrGet: "TypeError", xhrSet: "TypeError", readerSet: "TypeError" });
});

test("FileReader event handler attributes see the event's target", async ({ page }) => {
  await setContent(page, "<!doctype html><title>fr</title>");
  const seen = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(`${event.target === reader}:${reader.result}`);
        reader.readAsText(new Blob(["hi"]));
      }),
  );
  expect(seen).toBe("true:hi");
});
