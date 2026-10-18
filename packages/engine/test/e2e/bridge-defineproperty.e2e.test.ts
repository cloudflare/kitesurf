// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/bridge-defineprop.html?raw";

test("Object.defineProperty from boa reaches the real V8 object", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const out = await page.evaluate(() => {
    const g = globalThis as any;
    const o = g.__ksObj;
    const r: Record<string, unknown> = {};

    Object.defineProperty(o, "acc", {
      enumerable: true,
      get() {
        return "from-getter";
      },
    });
    r.accFromBoa = o.acc;
    r.accFromV8 = g.__ksReadFromV8("acc");
    r.accDescInV8 = g.__ksDescFromV8("acc");
    r.accDescInBoa = (() => {
      const d = Object.getOwnPropertyDescriptor(o, "acc");
      return d ? "get:" + typeof d.get + " enum:" + d.enumerable : "none";
    })();
    r.accIn = "acc" in o;
    r.accHasInV8 = g.__ksHasFromV8("acc");
    const boundMethod = o.readReceiver;
    r.boundMethodReceiver = boundMethod();

    Object.defineProperty(o, "dat", { enumerable: true, value: 7 });
    r.datFromBoa = o.dat;
    r.datFromV8 = g.__ksReadFromV8("dat");

    let n = 0;
    Object.defineProperty(o, "live", {
      enumerable: true,
      get() {
        return ++n;
      },
    });
    r.liveA = g.__ksReadFromV8("live");
    r.liveB = g.__ksReadFromV8("live");

    r.keysFromBoa = Object.keys(o).sort().join(",");
    r.keysFromV8 = g.__ksKeysFromV8().split(",").sort().join(",");

    Object.defineProperty(o, "tracker", {
      configurable: true,
      enumerable: true,
      get() {
        return "tracked";
      },
    });
    r.trackerBeforeDelete = g.__ksReadFromV8("tracker");
    r.trackerDeleteResult = delete o.tracker;
    r.trackerAfterDeleteBoa = o.tracker === undefined ? "gone" : "still";
    r.trackerAfterDeleteV8 = g.__ksDescFromV8("tracker");

    r.accDeleteResult = delete o.acc;
    r.accAfterDeleteBoa = o.acc === undefined ? "gone" : "still:" + o.acc;

    const exports_: any = {};
    g.__ksObj.mod = exports_;
    Object.defineProperty(exports_, "__esModule", { value: true });
    Object.defineProperty(exports_, "cloneDeep", {
      enumerable: true,
      get() {
        return (v: unknown) => v;
      },
    });
    r.webpackShape = "esm:" + exports_.__esModule + " fn:" + typeof exports_.cloneDeep;
    r.webpackCall = (0, exports_.cloneDeep)("round-trip");

    return r;
  });

  expect(out.accFromBoa, "accessor read in boa").toBe("from-getter");
  expect(out.accFromV8, "accessor read in V8").toBe("from-getter");
  expect(out.accDescInV8, "descriptor kind in V8").toBe("get:function value:undefined enum:true");
  expect(out.accDescInBoa, "descriptor kind in boa").toBe("get:function enum:true");
  expect(out.accIn, "'acc' in obj from boa").toBe(true);
  expect(out.accHasInV8, "'acc' in obj from V8").toBe(true);
  expect(out.boundMethodReceiver, "bound V8 method receiver").toBe("v8-object");

  expect(out.datFromBoa, "data value in boa").toBe(7);
  expect(out.datFromV8, "data value in V8").toBe(7);

  expect(out.keysFromBoa, "Object.keys from boa").toBe("acc,dat,live");
  expect(out.keysFromV8, "Object.keys from V8").toBe("acc,dat,live");

  expect(out.liveA, "live getter, first V8 read").toBe(1);
  expect(out.liveB, "live getter, second V8 read").toBe(2);

  expect(out.trackerBeforeDelete, "tracker installed in V8").toBe("tracked");
  expect(out.trackerDeleteResult, "delete of a configurable prop").toBe(true);
  expect(out.trackerAfterDeleteBoa, "delete seen from boa").toBe("gone");
  expect(out.trackerAfterDeleteV8, "delete seen from V8").toBe("none");

  expect(out.accDeleteResult, "delete of a non-configurable prop").toBe(false);
  expect(out.accAfterDeleteBoa, "non-configurable survives delete").toBe("still:from-getter");

  expect(out.webpackShape, "webpack export shape").toBe("esm:true fn:function");
  expect(out.webpackCall, "calling a bridged accessor export").toBe("round-trip");
});
