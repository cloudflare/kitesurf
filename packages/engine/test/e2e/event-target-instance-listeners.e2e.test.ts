// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<script>
  const out = {};
  // Bare EventTargets: dispatch on B must not reach A; target/this are the instance.
  {
    const a = new EventTarget(), b = new EventTarget();
    let hitsA = 0, hitsB = 0, targetOk = false, thisOk = false;
    a.addEventListener("x", function (e) { hitsA++; targetOk = e.target === a && e.currentTarget === a; thisOk = this === a; });
    b.addEventListener("x", () => { hitsB++; });
    b.dispatchEvent(new Event("x"));
    out.bareAfterB = { hitsA, hitsB };
    a.dispatchEvent(new Event("x"));
    out.bareAfterA = { hitsA, hitsB, targetOk, thisOk };
    a.removeEventListener("x", () => {}); // no-op removal of an unknown fn
    a.dispatchEvent(new Event("x"));
    out.bareHitsAfterNoopRemove = hitsA;
  }
  // FileReader: concurrent readers, then two reads on one reader with the
  // WPT EventWatcher discipline (only loadstart/loadend listened for).
  (async () => {
    const blob = new Blob(["kitesurf"]);
    const others = ["readAsText", "readAsDataURL", "readAsArrayBuffer", "readAsBinaryString"].map((m) => {
      const r = new FileReader(); r[m](blob); return r;
    });
    const reader = new FileReader();
    const seen = [];
    let waitingFor = null;
    const handler = (e) => {
      seen.push((waitingFor ? "" : "STRAY:") + e.type);
      if (waitingFor && waitingFor.type === e.type) { const res = waitingFor.resolve; waitingFor = null; res(); }
    };
    reader.addEventListener("loadstart", handler);
    reader.addEventListener("loadend", handler);
    const waitFor = (type) => new Promise((resolve) => { waitingFor = { type, resolve }; });
    reader.readAsArrayBuffer(blob);
    await waitFor("loadstart");
    const resultDuringLoadstart = reader.result;
    await waitFor("loadend");
    reader.readAsArrayBuffer(blob);
    await waitFor("loadstart");
    const resultDuringSecondLoadstart = reader.result;
    await waitFor("loadend");
    // Let every other reader's loadend timer fire; none may reach us.
    await new Promise((r) => setTimeout(r, 30));
    out.fileReader = { seen, resultDuringLoadstart, resultDuringSecondLoadstart, othersDone: others.every((r) => r.readyState === 2) };
    window.__out = out;
  })();
</script>`;

test("non-node EventTargets keep per-instance listeners", async ({ page }) => {
  await setContent(page, MARKUP);
  await page.waitForFunction("!!window.__out", { timeout: 10_000 }).catch(() => {});
  const r: Record<string, any> | null = await page.evaluate(
    () => (window as typeof window & { __out?: Record<string, any> }).__out ?? null,
  );
  expect(r).not.toBeNull();

  expect(r!.bareAfterB).toEqual({ hitsA: 0, hitsB: 1 });
  expect(r!.bareAfterA).toEqual({ hitsA: 1, hitsB: 1, targetOk: true, thisOk: true });
  expect(r!.bareHitsAfterNoopRemove).toBe(2);

  expect(r!.fileReader.seen).toEqual(["loadstart", "loadend", "loadstart", "loadend"]);
  expect(r!.fileReader.resultDuringLoadstart).toBeNull();
  expect(r!.fileReader.resultDuringSecondLoadstart).toBeNull();
  expect(r!.fileReader.othersDone).toBe(true);
});
