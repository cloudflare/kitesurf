// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

const HTML = `<!doctype html><html><head></head><body>
<div class="probe" id="p">probe</div>
<div class="csOpzq" id="q">nested</div>
<div id="out"></div>
<script>
// styled-components v6 boot shape: fresh tag + empty text node,
// insertBefore into head, then speedy insertRule for every rule.
const tag = document.createElement('style');
tag.setAttribute('data-styled', 'active');
tag.appendChild(document.createTextNode(''));
document.head.insertBefore(tag, null);
const sheet = tag.sheet;
let fails = 0;
const ins = (r) => { try { sheet.insertRule(r, sheet.cssRules.length); } catch (e) { fails++; } };
// The poison shape: multi-declaration camelCase rule inside a
// FALSE media condition, inserted BEFORE the rules that matter.
ins('@media screen and (max-width: 1px) { .csOpzq{height:26px;max-width:248px;} }');
// A TRUE media condition whose inner rule must apply.
ins('@media screen and (min-width: 2px) { .csOpzq{margin-top:7px;} }');
ins('.probe{position:relative;color:rgb(1,2,3)}');
document.getElementById('out').textContent = 'fails=' + fails;
</script></body></html>`;

test("cssom-atrule-mirror", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, {
    timeout: 20_000,
  });
  await page
    .waitForFunction(() => document.getElementById("out")?.textContent === "fails=0", {
      timeout: 15_000,
    })
    .catch(() => {});

  const res = await page.evaluate(() => {
    const p = document.getElementById("p")!;
    const q = document.getElementById("q")!;
    const tag = document.querySelector("style[data-styled='active']")!;
    const text = tag.textContent || "";
    let depth = 0;
    for (const ch of text) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    return {
      out: document.getElementById("out")!.textContent,
      probePos: getComputedStyle(p).position,
      probeColor: getComputedStyle(p).color,
      qHeight: getComputedStyle(q).height,
      qMarginTop: getComputedStyle(q).marginTop,
      braceDepth: depth,
      keepsCamelCase: text.includes(".csOpzq"),
      kebabLeak: text.includes(".cs-opzq"),
    };
  });

  expect(res.out, "no insertRule failures").toBe("fails=0");
  expect(res.probePos, "rule after @media applies").toBe("relative");
  expect(res.probeColor).toBe("rgb(1, 2, 3)");
  expect(res.braceDepth, "mirrored text has balanced braces").toBe(0);
  expect(res.keepsCamelCase, "inner selector case preserved").toBe(true);
  expect(res.kebabLeak, "no kebab-cased selector leak").toBe(false);
  expect(res.qMarginTop, "true @media inner rule applies").toBe("7px");
  expect(res.qHeight, "false @media inner rule dormant").not.toBe("26px");
});
