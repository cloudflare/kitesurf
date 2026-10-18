// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";
import html from "./html/event-handler-idl.html?raw";

test("event-handler IDL attributes: wiring, [Global] shape, brand checks", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const report = await readJsonReport(cdpSession, "globalThis.__ehReport");

  expect(report).toEqual({
    documentHandlerFired: true,
    windowHandlerFired: true,
    windowOwnAccessor: true,
    windowProtoClean: true,
    elementGetterName: true,
    elementBrandThrows: true,
    lenientUndefined: true,
    elementHandlerFired: true,
    bodyForwardsAfterprint: true,
    bodyReadsWindowState: true,
    arrowHandlerIdentity: true,
    compiledHandlerIdentity: true,
    contentAttrForwardIdentity: true,
    nestedOnerrorBounded: true,
    windowPointerHandlerFired: true,
  });
}, 120_000);

test("EventTarget methods bridge native AbortSignal receivers", async ({ page }) => {
  await setContent(page, "");

  const report = await page.evaluate(`(() => {
    const controller = new AbortController();
    const originalAdd = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    let patchedCalls = 0;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      patchedCalls++;
      return originalAdd.call(this, type, listener, options);
    };
    const add = EventTarget.prototype.addEventListener;
    const calls = [];
    const retained = () => { calls.push("retained"); };
    const removed = () => { calls.push("removed"); };
    add.call(controller.signal, "abort", retained, { once: true });
    add.call(controller.signal, "abort", removed);
    remove.call(controller.signal, "abort", removed);
    controller.abort();
    let wrongReceiverThrows = false;
    try {
      add.call({}, "abort", retained);
    } catch {
      wrongReceiverThrows = true;
    }
    return {
      calls,
      patchedCalls,
      wrongReceiverThrows,
      addName: originalAdd.name,
      addLength: originalAdd.length,
      removeName: remove.name,
      removeLength: remove.length,
    };
  })()`);

  expect(report).toEqual({
    calls: ["retained"],
    patchedCalls: 3,
    wrongReceiverThrows: true,
    addName: "addEventListener",
    addLength: 2,
    removeName: "removeEventListener",
    removeLength: 2,
  });
}, 120_000);

test("Boa preserves V8 event accessor descriptors", async ({ page }) => {
  await setContent(page, '<button id="target">click</button>');

  await page.evaluate(`(() => {
    document.addEventListener("click", (event) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        Event.prototype,
        "currentTarget",
      );
      globalThis.__eventDescriptorReport = {
        getter: typeof descriptor?.get,
        hasValue: Object.prototype.hasOwnProperty.call(descriptor, "value"),
        currentTarget: descriptor?.get?.call(event) === document,
      };
    });
  })()`);

  await page.click("#target");
  const report = await page.evaluate("globalThis.__eventDescriptorReport");
  expect(report).toEqual({
    getter: "function",
    hasValue: false,
    currentTarget: true,
  });
}, 120_000);
