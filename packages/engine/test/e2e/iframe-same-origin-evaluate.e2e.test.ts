// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Same-origin iframes (script-free and isolate-backed) announce a default main-world context and
// evaluate in their own document. Script-free children share one document with contentDocument.

import { expect, test } from "./harness";

const SCRIPT_FREE_HOST = "https://ks.invalid/__fixtures/iframe-host.html";
const SCRIPT_FREE_CHILD_SUFFIX = "/__fixtures/iframe-child.html";

const ISOLATE_HOST =
  "https://ks.invalid/__fixtures/sandbox-host.html?src=/__fixtures/sandbox-child.html";
const ISOLATE_CHILD_SUFFIX = "/__fixtures/sandbox-child.html";

test("frame.evaluate() shares one document with contentDocument in a script-free same-origin iframe", async ({
  page,
  cdpSession,
}) => {
  await page.goto(SCRIPT_FREE_HOST, { waitUntil: "load", timeout: 30_000 });

  const child = page
    .frames()
    .find((frame) => frame !== page.mainFrame() && frame.url().endsWith(SCRIPT_FREE_CHILD_SUFFIX));
  if (!child) throw new Error("child frame missing from page.frames()");

  const initial = await child.evaluate(() => ({
    text: document.body.innerText,
    msg: document.querySelector(".msg")?.textContent ?? null,
    url: location.href,
  }));
  expect(initial.msg).toBe("child body text");
  expect(initial.text).toContain("child body text");
  expect(initial.url).toBe("https://ks.invalid/__fixtures/iframe-child.html");

  // Parent writes through contentDocument -> child frame.evaluate() reads the same node.
  await page.evaluate(() => {
    document
      .querySelector<HTMLIFrameElement>('iframe[name="child-a"]')
      ?.contentDocument?.querySelector(".msg")
      ?.setAttribute("data-x", "from-parent");
  });
  expect(
    await child.evaluate(() => document.querySelector(".msg")?.getAttribute("data-x") ?? null),
  ).toBe("from-parent");

  // Child frame.evaluate() writes -> parent reads the same node through contentDocument.
  await child.evaluate(() => {
    document.querySelector(".msg")?.setAttribute("data-x", "from-frame");
  });
  expect(
    await page.evaluate(
      () =>
        document
          .querySelector<HTMLIFrameElement>('iframe[name="child-a"]')
          ?.contentDocument?.querySelector(".msg")
          ?.getAttribute("data-x") ?? null,
    ),
  ).toBe("from-frame");

  // Frame JS globals stay isolated from the parent window.
  await page.evaluate(() => {
    Reflect.set(window, "__parentOnly", 1);
  });
  expect(
    await child.evaluate(() => {
      Reflect.set(window, "__childOnly", 2);
      return {
        seesParent: "__parentOnly" in window,
        own: Reflect.get(window, "__childOnly"),
        sameGlobal: window === globalThis,
      };
    }),
  ).toEqual({ seesParent: false, own: 2, sameGlobal: true });
  expect(await page.evaluate(() => "__childOnly" in window)).toBe(false);

  // Isolated worlds (used by Playwright frameLocator/screenshot) and objectId-only callFunctionOn
  // (used by Playwright UtilityScript) must both target the child's document.
  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  const childTree = frameTree.childFrames?.find((entry) =>
    entry.frame.url.endsWith(SCRIPT_FREE_CHILD_SUFFIX),
  );
  if (!childTree) throw new Error("child frame missing from Page.getFrameTree");
  const childFrameId = childTree.frame.id;

  const world = await cdpSession.send("Page.createIsolatedWorld", {
    frameId: childFrameId,
    worldName: "utility",
  });
  const inWorld = await cdpSession.send("Runtime.evaluate", {
    expression: "document.querySelector('.msg')?.getAttribute('data-x') ?? null",
    contextId: world.executionContextId,
    returnByValue: true,
  });
  expect(inWorld.result.value).toBe("from-frame");

  const replayed: Array<{ id: number; frameId?: string; isDefault?: boolean }> = [];
  cdpSession.on("Runtime.executionContextCreated", (event) => {
    const aux = event.context.auxData as { frameId?: string; isDefault?: boolean } | undefined;
    replayed.push({ id: event.context.id, frameId: aux?.frameId, isDefault: aux?.isDefault });
  });
  await cdpSession.send("Runtime.enable");
  const childCtx = replayed.find((entry) => entry.frameId === childFrameId && entry.isDefault);
  if (!childCtx) throw new Error("replayed default context missing for child frame");

  const holder = await cdpSession.send("Runtime.callFunctionOn", {
    executionContextId: childCtx.id,
    functionDeclaration: "() => ({ global: globalThis })",
    returnByValue: false,
  });
  if (!holder.result.objectId) throw new Error("expected objectId handle for frame realm object");
  const viaHandle = await cdpSession.send("Runtime.callFunctionOn", {
    objectId: holder.result.objectId,
    functionDeclaration:
      "function () { return this.global.eval(\"document.querySelector('.msg').getAttribute('data-x')\"); }",
    returnByValue: true,
  });
  expect(viaHandle.result.value).toBe("from-frame");
}, 120_000);

test("frame.evaluate() resolves in a same-origin iframe with an isolate", async ({
  page,
  cdpSession,
}) => {
  await page.goto(ISOLATE_HOST, { waitUntil: "load", timeout: 30_000 });

  const child = page
    .frames()
    .find((frame) => frame !== page.mainFrame() && frame.url().endsWith(ISOLATE_CHILD_SUFFIX));
  if (!child) throw new Error("child frame missing from page.frames()");

  const childText = await child.evaluate(() => ({
    markup: document.querySelector("#markup")?.textContent ?? null,
    url: location.href,
  }));
  expect(childText).toEqual({
    markup: "sandbox child markup",
    url: "https://ks.invalid/__fixtures/sandbox-child.html",
  });

  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  const childTree = frameTree.childFrames?.find((entry) =>
    entry.frame.url.endsWith(ISOLATE_CHILD_SUFFIX),
  );
  if (!childTree) throw new Error("child frame missing from Page.getFrameTree");
  const childFrameId = childTree.frame.id;

  const replayed: Array<{ id: number; frameId?: string; isDefault?: boolean }> = [];
  cdpSession.on("Runtime.executionContextCreated", (event) => {
    const aux = event.context.auxData as { frameId?: string; isDefault?: boolean } | undefined;
    replayed.push({ id: event.context.id, frameId: aux?.frameId, isDefault: aux?.isDefault });
  });
  await cdpSession.send("Runtime.enable");
  expect(replayed.find((entry) => entry.frameId === childFrameId && entry.isDefault)).toBeTruthy();
}, 120_000);
