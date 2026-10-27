// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("preserves tag-specific element discriminators", async ({ page }) => {
  await setContent(page, "<!doctype html><html><head></head><body></body></html>");

  const result = await page.evaluate(() => {
    const head: Element | null = document.querySelector("head");
    const body: Element = document.body;
    const div: Element = document.createElement("div");
    const span: Element = document.createElement("span");
    const img: Element = document.createElement("img");
    const anchor: Element = document.createElement("a");
    const form: Element = document.createElement("form");
    const input: Element = document.createElement("input");
    const button: Element = document.createElement("button");

    const styleLoaderRepro = (() => {
      let target: Element | null | undefined = document.querySelector("head");
      if (window.HTMLIFrameElement && target instanceof window.HTMLIFrameElement) {
        try {
          target = target.contentDocument!.head;
        } catch {
          target = null;
        }
      }
      return target != null && target.tagName === "HEAD";
    })();

    const selection = document.getSelection();
    const range = document.createRange();
    const rangeRect = range && range.getBoundingClientRect();

    return {
      headIsIframe: head instanceof window.HTMLIFrameElement,
      bodyIsIframe: body instanceof window.HTMLIFrameElement,
      divIsIframe: div instanceof window.HTMLIFrameElement,
      formIsAnchor: form instanceof window.HTMLAnchorElement,
      anchorIsForm: anchor instanceof window.HTMLFormElement,
      inputIsButton: input instanceof window.HTMLButtonElement,
      buttonIsInput: button instanceof window.HTMLInputElement,
      formIsForm: form instanceof window.HTMLFormElement,
      anchorIsAnchor: anchor instanceof window.HTMLAnchorElement,
      inputIsInput: input instanceof window.HTMLInputElement,
      buttonIsButton: button instanceof window.HTMLButtonElement,
      divIsDiv: div instanceof window.HTMLDivElement,
      spanIsSpan: span instanceof window.HTMLSpanElement,
      divIsHTMLElement: div instanceof window.HTMLElement,
      divIsElement: div instanceof window.Element,
      imgIsImage: img instanceof window.HTMLImageElement,
      iframeName: window.HTMLIFrameElement && window.HTMLIFrameElement.name,
      formName: window.HTMLFormElement && window.HTMLFormElement.name,
      anchorName: window.HTMLAnchorElement && window.HTMLAnchorElement.name,
      divIsSvg: div instanceof window.SVGElement,
      svgName: window.SVGElement && window.SVGElement.name,
      styleLoaderRepro,
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      execCommandReturn: document.execCommand("copy"),
      querySupported: document.queryCommandSupported("copy"),
      selectionShaped: selection && selection.rangeCount === 0,
      rangeShaped: range && rangeRect && rangeRect.width === 0,
      currentScriptIsNull: document.currentScript === null,
    };
  });

  expect(result.headIsIframe, "head is not an iframe").toBe(false);
  expect(result.bodyIsIframe, "body is not an iframe").toBe(false);
  expect(result.divIsIframe, "div is not an iframe").toBe(false);
  expect(result.formIsAnchor, "form is not an anchor").toBe(false);
  expect(result.anchorIsForm, "anchor is not a form").toBe(false);
  expect(result.inputIsButton, "input is not a button").toBe(false);
  expect(result.buttonIsInput, "button is not an input").toBe(false);
  expect(result.formIsForm, "form is a form").toBe(true);
  expect(result.anchorIsAnchor, "anchor is an anchor").toBe(true);
  expect(result.inputIsInput, "input is an input").toBe(true);
  expect(result.buttonIsButton, "button is a button").toBe(true);
  expect(result.divIsDiv, "div is a div").toBe(true);
  expect(result.spanIsSpan, "span is a span").toBe(true);
  expect(result.divIsHTMLElement, "div is an HTMLElement").toBe(true);
  expect(result.divIsElement, "div is an Element").toBe(true);
  expect(result.imgIsImage, "img is an image").toBe(true);
  expect(result.iframeName, "HTMLIFrameElement name").toBe("HTMLIFrameElement");
  expect(result.formName, "HTMLFormElement name").toBe("HTMLFormElement");
  expect(result.anchorName, "HTMLAnchorElement name").toBe("HTMLAnchorElement");
  expect(result.divIsSvg, "div is not an SVGElement").toBe(false);
  expect(result.svgName, "SVGElement name").toBe("SVGElement");
  expect(result.styleLoaderRepro, "head selector returns the actual head").toBe(true);
  expect(result.hasFocus, "document.hasFocus returns true").toBe(true);
  expect(result.visibilityState, "document is visible").toBe("visible");
  expect(result.hidden, "document.hidden is false").toBe(false);
  expect(result.execCommandReturn, "document.execCommand returns false").toBe(false);
  expect(result.querySupported, "document.queryCommandSupported returns false").toBe(false);
  expect(result.selectionShaped, "document.getSelection has zero ranges").toBeTruthy();
  expect(result.rangeShaped, "document.createRange has a zero-width rect").toBeTruthy();
  expect(result.currentScriptIsNull, "document.currentScript is null").toBe(true);
});
