// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getComputedStyle().getPropertyValue("--name") read "" for every custom property, so a script that
// parseInt()s one got NaN: apple.com's nav then sized its label SVGs calc(NaN * 1em), zero.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("getComputedStyle reads custom properties: own, inherited, var()-substituted, and unset", async ({
  page,
}) => {
  await setContent(
    page,
    `<style>
    #outer { --font-size: 17px; --gap: 4px; }
    #inner { --scaled: calc(var(--gap) * 2); --own:  hello  world ; }
  </style><div id=outer><span id=inner>x</span></div>`,
  );
  const read = await page.evaluate(() => {
    const byId = (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`no #${id}`);
      return el;
    };
    const cs = getComputedStyle(byId("inner"));
    const bulkFirst = getComputedStyle(byId("outer"));
    void bulkFirst.cssText;
    return {
      inherited: cs.getPropertyValue("--font-size"),
      own: cs.getPropertyValue("--own"),
      substituted: cs.getPropertyValue("--scaled"),
      unset: cs.getPropertyValue("--nope"),
      afterBulk: bulkFirst.getPropertyValue("--gap"),
      parsed: parseInt(cs.getPropertyValue("--font-size")),
    };
  });
  expect(read).toEqual({
    inherited: "17px",
    own: "hello  world",
    substituted: "calc(4px * 2)",
    unset: "",
    afterBulk: "4px",
    parsed: 17,
  });
}, 60_000);
