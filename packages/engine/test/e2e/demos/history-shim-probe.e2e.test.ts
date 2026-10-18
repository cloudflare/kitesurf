// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("history-shim-probe", async ({ page }) => {
  const cdp = await page.target().createCDPSession();

  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", {
    url: "http://localhost:8787/__fixtures/lifecycle.html",
  });
  await new Promise((resolve) => {
    cdp.once("Page.loadEventFired", resolve);
    setTimeout(resolve, 5000);
  });

  const evalIt = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  };

  const initial = await evalIt(`({
  hasHistory: typeof window.history === "object" && window.history !== null,
  state: window.history.state,
  length: window.history.length,
  scrollRestoration: window.history.scrollRestoration,
})`);
  expect(initial.hasHistory, "window.history exists").toBe(true);
  expect(initial.state, "initial state is null").toBeNull();
  expect(initial.length, "initial length is 1").toBe(1);
  expect(initial.scrollRestoration, "scrollRestoration default").toBe("auto");

  const afterPush = await evalIt(`(function() {
  window.history.pushState({ page: 1 }, "", "/active");
  return {
    state: window.history.state,
    length: window.history.length,
    pathname: window.location.pathname,
    href: window.location.href,
  };
})()`);
  expect(afterPush.state, "state after pushState").toEqual({ page: 1 });
  expect(afterPush.length, "length after pushState").toBe(2);
  expect(afterPush.pathname, "pathname after pushState").toBe("/active");
  expect(
    afterPush.href.endsWith("/active"),
    `href after pushState: ${afterPush.href}`,
  ).toBeTruthy();

  const afterReplace = await evalIt(`(function() {
  window.history.replaceState({ page: 2 }, "", "/completed");
  return {
    state: window.history.state,
    length: window.history.length,
    pathname: window.location.pathname,
  };
})()`);
  expect(afterReplace.state, "state after replaceState").toEqual({ page: 2 });
  expect(afterReplace.length, "length unchanged after replaceState").toBe(2);
  expect(afterReplace.pathname, "pathname after replaceState").toBe("/completed");

  const afterBack = await evalIt(`(async function() {
  let captured = null;
  const handler = (e) => { captured = { state: e.state, type: e.type }; };
  window.addEventListener("popstate", handler);
  window.history.go(-1);
  await new Promise((r) => setTimeout(r, 0));
  window.removeEventListener("popstate", handler);
  return {
    captured,
    state: window.history.state,
    pathname: window.location.pathname,
  };
})()`);
  expect(afterBack.captured?.type, "popstate dispatched").toBe("popstate");
  expect(afterBack.captured?.state, "popstate.state matches new entry").toBeNull();
  expect(afterBack.state, "history.state is null after go(-1)").toBeNull();
  expect(
    afterBack.pathname === "/__fixtures/lifecycle.html" ||
      afterBack.pathname === "/" ||
      afterBack.pathname.endsWith("lifecycle.html"),
    `pathname after go(-1) is initial: ${afterBack.pathname}`,
  ).toBeTruthy();

  const apis = await evalIt(`({
  back: typeof window.history.back === "function",
  forward: typeof window.history.forward === "function",
  go: typeof window.history.go === "function",
})`);
  expect(apis.back).toBe(true);
  expect(apis.forward).toBe(true);
  expect(apis.go).toBe(true);

  const oob = await evalIt(`(function() {
  const before = { length: window.history.length, state: window.history.state };
  window.history.go(99);
  const after = { length: window.history.length, state: window.history.state };
  return { before, after };
})()`);
  expect(oob.before, "go(99) is a no-op").toEqual(oob.after);
});
