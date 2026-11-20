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

test("cssom append fast-path resyncs after external text edit and rule mutation", async ({
  page,
}) => {
  await page.goto(
    `data:text/html,${encodeURIComponent(
      "<!doctype html><html><head><style id='s'></style></head><body><div id='a'>a</div><div id='b'>b</div></body></html>",
    )}`,
    { timeout: 20_000 },
  );

  const res = await page.evaluate(() => {
    const tag = document.getElementById("s") as HTMLStyleElement;
    const sheet = tag.sheet!;
    const bInitial = getComputedStyle(document.getElementById("b")!).color;
    sheet.insertRule("#a { color: rgb(10, 20, 30); }", sheet.cssRules.length);
    sheet.insertRule("#b { color: rgb(40, 50, 60); }", sheet.cssRules.length);
    const aAfterAppend = getComputedStyle(document.getElementById("a")!).color;
    const bAfterAppend = getComputedStyle(document.getElementById("b")!).color;

    (sheet.cssRules[1] as CSSStyleRule).style.color = "rgb(70, 80, 90)";
    const bAfterMutate = getComputedStyle(document.getElementById("b")!).color;

    tag.textContent = "#a { color: rgb(1, 2, 3); }";
    sheet.insertRule("#b { color: rgb(4, 5, 6); }", sheet.cssRules.length);
    const aAfterExternal = getComputedStyle(document.getElementById("a")!).color;
    const bAfterExternal = getComputedStyle(document.getElementById("b")!).color;
    const ruleCount = sheet.cssRules.length;

    sheet.deleteRule(1);
    const bAfterDelete = getComputedStyle(document.getElementById("b")!).color;
    return {
      bInitial,
      aAfterAppend,
      bAfterAppend,
      bAfterMutate,
      aAfterExternal,
      bAfterExternal,
      ruleCount,
      bAfterDelete,
    };
  });

  expect(res.aAfterAppend).toBe("rgb(10, 20, 30)");
  expect(res.bAfterAppend).toBe("rgb(40, 50, 60)");
  expect(res.bAfterMutate).toBe("rgb(70, 80, 90)");
  expect(res.aAfterExternal).toBe("rgb(1, 2, 3)");
  expect(res.bAfterExternal).toBe("rgb(4, 5, 6)");
  expect(res.ruleCount).toBe(2);
  expect(res.bAfterDelete).toBe(res.bInitial);
});

test("a rule object survives an unrelated style edit after the append fast path", async ({
  page,
}) => {
  await page.goto(
    `data:text/html,${encodeURIComponent(
      "<!doctype html><html><head><style id='s'></style></head><body><div id='a'>a</div></body></html>",
    )}`,
    { timeout: 20_000 },
  );

  const res = await page.evaluate(() => {
    const tag = document.getElementById("s") as HTMLStyleElement;
    const sheet = tag.sheet!;
    sheet.insertRule("#a { color: rgb(1, 1, 1); }", 0);
    sheet.insertRule("#b { color: rgb(2, 2, 2); }", 1);
    const rule = sheet.cssRules[0] as CSSStyleRule;
    const other = document.createElement("style");
    other.textContent = ".c { color: red; }";
    document.head.appendChild(other);
    const same = sheet.cssRules[0] === rule;
    rule.style.color = "rgb(9, 9, 9)";
    return { same, color: getComputedStyle(document.getElementById("a")!).color };
  });

  expect(res).toEqual({ same: true, color: "rgb(9, 9, 9)" });
});
