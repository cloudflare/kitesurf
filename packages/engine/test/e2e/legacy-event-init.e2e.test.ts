// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var message = new MessageEvent("x");
    message.initMessageEvent("m", true, false, 7, "https://a.test", "id1", null, []);
    var storage = new StorageEvent("x");
    storage.initStorageEvent("s", false, true, "k", null, "new", "https://b.test");
    var composition = new CompositionEvent("x");
    composition.initCompositionEvent("c", false, false, window, "data");
    var text = new TextEvent("x");
    text.initTextEvent("t");
    var keyboard = new KeyboardEvent("x", { repeat: true });
    keyboard.initKeyboardEvent("k", true, true, null, "a", 1, true, false, true, false);
    var reinit = new Event("x");
    reinit.initEvent(null);
    globalThis.__initReport = JSON.stringify({
      types: [new Event(null).type, new Event(undefined).type, new Event(0).type, reinit.type],
      message: [message.type, message.bubbles, message.data, message.origin, message.lastEventId, message.source, message.ports.length],
      storage: [storage.type, storage.cancelable, storage.key, storage.oldValue, storage.newValue, storage.url, storage.storageArea],
      composition: [composition.type, composition.view === window, composition.data],
      text: [text.type, text.data],
      keyboard: [keyboard.type, keyboard.key, keyboard.location, keyboard.ctrlKey, keyboard.altKey, keyboard.shiftKey, keyboard.metaKey, keyboard.repeat],
    });
  })();
</script>`;

test("legacy init*Event methods follow the IDL", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__initReport")).toEqual({
    types: ["null", "undefined", "0", "null"],
    message: ["m", true, 7, "https://a.test", "id1", null, 0],
    storage: ["s", true, "k", null, "new", "https://b.test", null],
    composition: ["c", true, "data"],
    text: ["t", "undefined"],
    keyboard: ["k", "a", 1, true, false, true, false, true],
  });
}, 60_000);
