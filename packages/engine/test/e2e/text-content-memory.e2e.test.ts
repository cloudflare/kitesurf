// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, type BrowserFactory } from "./harness";
import { setContent } from "./set-content";

const BASE_RULES = Array.from(
  { length: 500 },
  (_, i) =>
    `.sc-${i.toString(36)}{display:flex;padding:${i % 16}px;margin:0 auto;` +
    `color:rgb(${i % 255},0,0);font-family:Montserrat,sans-serif}`,
);
const ROUNDS = 150;
type ObserverMode = "none" | "ancestor" | "unrelated";

async function textContentChurn(browserFactory: BrowserFactory, observe: boolean) {
  const browser = await browserFactory();
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await setContent(page, "<style id=s></style><p>text</p>");
  const before = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  const result = await page.evaluate(
    ({ base, rounds, observe: shouldObserve }) => {
      const style = document.querySelector<HTMLStyleElement>("#s")!;
      if (shouldObserve) {
        new MutationObserver(() => {}).observe(style, { childList: true });
      }
      for (let i = 0; i < rounds; i++) {
        style.textContent = `${base}\n.x${i}{color:red}`;
      }
      return { childCount: style.childNodes.length, textLength: style.textContent.length };
    },
    { base: BASE_RULES.join("\n"), rounds: ROUNDS, observe },
  );
  const after = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  return { browser, page, result, delta: after.usedSize - before.usedSize };
}

async function innerHtmlChurn(browserFactory: BrowserFactory, observerMode: ObserverMode) {
  const browser = await browserFactory();
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await setContent(page, "<div id=unrelated></div><div id=host></div>");
  const before = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  const childCount = await page.evaluate(
    ({ rounds, observerMode: mode }) => {
      const host = document.querySelector<HTMLDivElement>("#host")!;
      const unrelated = document.querySelector<HTMLDivElement>("#unrelated")!;
      if (mode === "ancestor") {
        new MutationObserver(() => {}).observe(document.body, {
          childList: true,
          subtree: true,
        });
      } else if (mode === "unrelated") {
        new MutationObserver(() => {}).observe(unrelated, { childList: true });
      }
      const children = "<input type=checkbox checked>".repeat(200);
      for (let i = 0; i < rounds; i++) {
        host.innerHTML = `${children}<i>${i}</i>`;
      }
      const inputs = Array.from(host.querySelectorAll("input"));
      const checked = inputs.every((input) => input.checked);
      const checkedMatchesSelector = inputs.every((input) => input.matches(":checked"));
      const firstInput = inputs[0]!;
      firstInput.removeAttribute("checked");
      const checkedFollowsAttribute = !firstInput.checked;
      const checkedSelectorFollowsAttribute = !firstInput.matches(":checked");
      firstInput.checked = false;
      firstInput.setAttribute("checked", "");

      const radios = document.createElement("div");
      radios.innerHTML =
        '<input id="radio-a" type="radio" name="group">' +
        '<input id="radio-b" type="radio" name="group">';
      host.appendChild(radios);
      const radioA = radios.querySelector<HTMLInputElement>("#radio-a")!;
      const radioB = radios.querySelector<HTMLInputElement>("#radio-b")!;
      radioA.setAttribute("checked", "");
      radioB.setAttribute("checked", "");
      return {
        childCount: host.childNodes.length - 1,
        checked,
        checkedMatchesSelector,
        checkedFollowsAttribute,
        checkedSelectorFollowsAttribute,
        dirtyCheckedIgnoresAttribute: !firstInput.checked,
        dirtySelectorIgnoresAttribute: !firstInput.matches(":checked"),
        dirtyDefaultCheckedFollowsAttribute: firstInput.defaultChecked,
        radioAAfterAttributes: radioA.checked,
        radioBAfterAttributes: radioB.checked,
        radioASelectorAfterAttributes: radioA.matches(":checked"),
        radioBSelectorAfterAttributes: radioB.matches(":checked"),
      };
    },
    { rounds: ROUNDS, observerMode },
  );
  const after = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  await browser.disconnect();
  return { ...childCount, delta: after.usedSize - before.usedSize };
}

test("unwrapped textContent replacements do not retain every old text node", async ({
  browserFactory,
}) => {
  const observed = await textContentChurn(browserFactory, true);
  await observed.browser.disconnect();
  const freed = await textContentChurn(browserFactory, false);
  expect(freed.result.childCount).toBe(1);
  expect(freed.result.textLength).toBeGreaterThan(BASE_RULES.join("\n").length);
  expect(freed.delta).toBeLessThan(observed.delta - 3 * 1024 * 1024);
  expect(freed.delta).toBeLessThan(16 * 1024 * 1024);
}, 120_000);

test("an unrelated observer does not retain innerHTML replacements", async ({ browserFactory }) => {
  const observed = await innerHtmlChurn(browserFactory, "ancestor");
  const freed = await innerHtmlChurn(browserFactory, "none");
  const unrelated = await innerHtmlChurn(browserFactory, "unrelated");

  const expectedControl = {
    childCount: 201,
    checked: true,
    checkedMatchesSelector: true,
    checkedFollowsAttribute: true,
    checkedSelectorFollowsAttribute: true,
    dirtyCheckedIgnoresAttribute: true,
    dirtySelectorIgnoresAttribute: true,
    dirtyDefaultCheckedFollowsAttribute: true,
    radioAAfterAttributes: false,
    radioBAfterAttributes: true,
    radioASelectorAfterAttributes: false,
    radioBSelectorAfterAttributes: true,
  };
  expect(freed).toMatchObject(expectedControl);
  expect(unrelated).toMatchObject(expectedControl);
  expect(observed.delta).toBeGreaterThan(unrelated.delta + 16 * 1024 * 1024);
  expect(Math.abs(unrelated.delta - freed.delta)).toBeLessThan(4 * 1024 * 1024);
}, 120_000);

test("held DOM wrappers survive textContent and innerHTML replacement", async ({ page }) => {
  await setContent(
    page,
    "<style id=s></style><div id=host><span>old text</span></div>" +
      "<select id=select><option>choice</option></select>",
  );
  const result = await page.evaluate(async () => {
    const style = document.querySelector<HTMLStyleElement>("#s")!;
    style.textContent = "before";
    const heldText = style.firstChild!;
    const host = document.querySelector<HTMLDivElement>("#host")!;
    const heldElement = host.firstChild!;
    const heldDescendant = heldElement.firstChild!;
    const parsed = new DOMParser().parseFromString("", "text/html");
    const heldAdoptedText = parsed.createTextNode("adopted text");
    host.appendChild(heldAdoptedText);
    const select = document.querySelector<HTMLSelectElement>("#select")!;
    const heldSelectLabel = select.lastChild!;
    const selectLabelValue = heldSelectLabel.textContent;
    const cssomStyle = document.createElement("style");
    document.head.appendChild(cssomStyle);
    cssomStyle.sheet!.insertRule(".held { color: red; }");
    const heldCssomText = cssomStyle.firstChild!;
    const cssomTextValue = heldCssomText.textContent;
    let cssomTextMutations = 0;
    new MutationObserver((records) => {
      cssomTextMutations += records.length;
    }).observe(heldCssomText, { characterData: true });
    cssomStyle.sheet!.insertRule(".second { color: blue; }");
    await Promise.resolve();

    style.textContent = "after";
    host.innerHTML = "<b>new text</b>";
    select.remove(0);
    cssomStyle.sheet!.deleteRule(1);
    cssomStyle.sheet!.deleteRule(0);

    return {
      heldTextParent: heldText.parentNode,
      heldTextValue: heldText.textContent,
      heldElementParent: heldElement.parentNode,
      heldElementValue: heldElement.textContent,
      heldDescendantParent: heldDescendant.parentNode === (heldElement as any),
      heldDescendantValue: heldDescendant.textContent,
      heldAdoptedTextParent: heldAdoptedText.parentNode,
      heldAdoptedTextValue: heldAdoptedText.textContent,
      heldSelectLabelParent: heldSelectLabel.parentNode,
      heldSelectLabelValue: heldSelectLabel.textContent,
      selectLabelValue,
      heldCssomTextParent: heldCssomText.parentNode,
      heldCssomTextValue: heldCssomText.textContent,
      cssomTextValue,
      cssomTextMutations,
      currentMarkup: host.innerHTML,
    };
  });

  expect(result).toEqual({
    heldTextParent: null,
    heldTextValue: "before",
    heldElementParent: null,
    heldElementValue: "old text",
    heldDescendantParent: true,
    heldDescendantValue: "old text",
    heldAdoptedTextParent: null,
    heldAdoptedTextValue: "adopted text",
    heldSelectLabelParent: null,
    heldSelectLabelValue: "choice",
    selectLabelValue: "choice",
    heldCssomTextParent: null,
    heldCssomTextValue: ".held { color: red; }",
    cssomTextValue: ".held { color: red; }",
    cssomTextMutations: 0,
    currentMarkup: "<b>new text</b>",
  });
}, 120_000);

test("subtree observers see mutations before removal delivery", async ({ page }) => {
  await setContent(page, "<div id=host><span>before</span></div>");
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLDivElement>("#host")!;
    const text = host.firstChild!.firstChild! as Text;
    let deliveryCount = 0;
    const records = await new Promise<
      Array<{
        type: string;
        target: string;
        oldValue: string | null;
      }>
    >((resolve) => {
      const observer = new MutationObserver((entries) => {
        deliveryCount++;
        resolve(
          entries.map((entry) => ({
            type: entry.type,
            target: entry.target.nodeName,
            oldValue: entry.oldValue,
          })),
        );
      });
      const options = {
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true,
      };
      observer.observe(host, options);
      observer.observe(document.body, options);

      host.textContent = "";
      text.data = "after";
    });

    text.data = "after delivery";
    await new Promise((resolve) => setTimeout(resolve, 0));
    const postDeliveryRecords = deliveryCount - 1;

    const characterOnlyHost = document.createElement("div");
    characterOnlyHost.innerHTML = "<span>character before</span>";
    document.body.appendChild(characterOnlyHost);
    const characterOnlyText = characterOnlyHost.firstChild!.firstChild! as Text;
    const characterOnlyRecords = await new Promise<string[]>((resolve) => {
      new MutationObserver((entries) => {
        resolve(entries.map((entry) => entry.type));
      }).observe(characterOnlyHost, { characterData: true, subtree: true });
      characterOnlyHost.textContent = "";
      characterOnlyText.data = "character after";
    });

    const staleHost = document.createElement("div");
    staleHost.innerHTML = "<span>stale before</span>";
    const staleText = staleHost.firstChild!.firstChild! as Text;
    let staleRecords = 0;
    const staleObserver = new MutationObserver((entries) => {
      staleRecords += entries.length;
    });
    staleObserver.observe(staleHost, { characterData: true, subtree: true });
    staleHost.textContent = "";
    await new Promise((resolve) => setTimeout(resolve, 0));
    staleText.data = "after checkpoint";
    await new Promise((resolve) => setTimeout(resolve, 0));
    staleObserver.disconnect();

    return {
      records,
      postDeliveryRecords,
      characterOnlyRecords,
      staleRecords,
    };
  });

  expect(result).toEqual({
    records: [
      { type: "childList", target: "DIV", oldValue: null },
      { type: "characterData", target: "#text", oldValue: "before" },
    ],
    postDeliveryRecords: 0,
    characterOnlyRecords: ["characterData"],
    staleRecords: 0,
  });
}, 120_000);
