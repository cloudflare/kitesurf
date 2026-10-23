// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const SWEEP_SETTLE_MS = 1500;
const MOVE_ROUNDS = 3;

test("holding a descendant preserves one inline and IDL handler across detach", async ({
  page,
}) => {
  await setContent(
    page,
    `<main><button onclick="globalThis.inlineCalls++"><span>held</span></button></main><script>
    globalThis.inlineCalls = 0;
    globalThis.idlCalls = 0;
    (() => {
      const button = document.querySelector("button");
      button.oninput = () => globalThis.idlCalls++;
      globalThis.heldLeaf = button.firstElementChild;
      button.click();
    })();
  </script>`,
  );
  for (let round = 0; round < MOVE_ROUNDS; round++) {
    await page.evaluate(() => {
      const leaf: unknown = Reflect.get(globalThis, "heldLeaf");
      if (!(leaf instanceof Element) || !leaf.parentElement) throw new Error("missing held tree");
      leaf.parentElement.remove();
    });
    await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS));
    await page.evaluate(() => {
      const leaf: unknown = Reflect.get(globalThis, "heldLeaf");
      if (!(leaf instanceof Element) || !(leaf.parentElement instanceof HTMLButtonElement)) {
        throw new Error("missing detached button");
      }
      const button = leaf.parentElement;
      document.body.appendChild(button);
      button.click();
      button.dispatchEvent(new Event("input"));
    });
  }
  const result = await page.evaluate(() => ({
    inline: Reflect.get(globalThis, "inlineCalls"),
    idl: Reflect.get(globalThis, "idlCalls"),
  }));
  expect(result).toEqual({ inline: MOVE_ROUNDS + 1, idl: MOVE_ROUNDS });
});
