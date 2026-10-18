// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var events = [
      new Event("x"),
      new CustomEvent("x", { detail: 1 }),
      new MouseEvent("click", { clientX: 5, relatedTarget: document.body }),
      new PointerEvent("pointerdown", { pointerId: 2 }),
      new KeyboardEvent("keydown", { key: "a" }),
      new MessageEvent("message", { data: 1 }),
      new FocusEvent("focus"),
    ];
    var ev = events[2];
    var illegal = null;
    try { Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX").get.call(new Event("x")); }
    catch (e) { illegal = e.constructor.name; }
    var dispatched = [];
    document.body.addEventListener("click", function (e) {
      dispatched.push(e.eventPhase, e.currentTarget === document.body, e.relatedTarget === document.body);
      e.stopPropagation();
    });
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, relatedTarget: document.body }));
    var rejectionErrors = [undefined, {}, { promise: 1 }, { promise: null }].map(function (init) {
      try { new PromiseRejectionEvent("x", init); return "none"; } catch (e) { return e.constructor.name; }
    });
    var promise = Promise.resolve();
    var motion = new DeviceMotionEvent("x", { acceleration: { x: 1 }, rotationRate: { gamma: 2 } });
    var motionErrors = [
      function () { new DeviceMotionEventAcceleration(); },
      function () { new DeviceMotionEvent("x", { acceleration: { x: NaN } }); },
    ].map(function (f) { try { f(); return "none"; } catch (e) { return e.constructor.name; } });
    globalThis.__eventReport = JSON.stringify({
      motion: [motion.acceleration instanceof DeviceMotionEventAcceleration,
        motion.acceleration.x, motion.acceleration.y, motion.rotationRate.gamma, motion.rotationRate.alpha,
        motion.accelerationIncludingGravity, Object.keys(motion.acceleration)].concat(motionErrors),
      rejection: rejectionErrors.concat(new PromiseRejectionEvent("x", { promise: promise }).promise === promise),
      ownKeys: events.map(function (e) { return Object.keys(e); }),
      forIn: (function () { var k = []; for (var p in ev) if (p.charAt(0) === "_") k.push(p); return k; })(),
      json: JSON.stringify(ev),
      values: [ev.clientX, ev.x, ev.pageX, ev.relatedTarget === document.body, events[4].keyCode, events[1].detail,
        new PointerEvent("x", { persistentDeviceId: 3 }).persistentDeviceId,
        new WheelEvent("x", { momentum: true }).momentum, new WheelEvent("x").momentum],
      illegal: illegal,
      dispatched: dispatched,
      afterDispatch: [ev.eventPhase, ev.cancelBubble, ev.composedPath().length],
    });
  })();
</script>`;

test("events have no own properties but isTrusted", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__eventReport")).toEqual({
    motion: [true, 1, null, 2, null, null, [], "TypeError", "TypeError"],
    rejection: ["TypeError", "TypeError", "TypeError", "TypeError", true],
    ownKeys: Array(7).fill(["isTrusted"]),
    forIn: [],
    json: '{"isTrusted":false}',
    values: [5, 5, 5, true, 65, 1, 3, true, false],
    illegal: "TypeError",
    dispatched: [2, true, true],
    afterDispatch: [0, false, 0],
  });
}, 60_000);
