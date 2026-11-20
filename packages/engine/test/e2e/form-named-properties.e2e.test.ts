// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// HTMLFormElement is [LegacyOverrideBuiltIns]: a control named "id" is what form.id reads.
// Storefront themes rely on it (form.id.disabled = false on the variant input).
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PROBE = `(function (realm) {
  "use strict";
  var f = document.getElementById("f");
  var tag = function (v) { return v && v.tagName ? v.tagName + ":" + v.getAttribute("name") : typeof v; };
  f.id.disabled = false;
  (window.__forms = window.__forms || {})[realm] = {
    id: tag(f.id),
    action: tag(f.action),
    method: tag(f.method),
    byIndex: tag(f[0]),
    attribute: f.getAttribute("id"),
    elements: f.elements.length,
    submit: typeof f.submit,
    plain: tag(document.getElementById("g").id) + ":" + document.getElementById("g").id,
    enabled: !f.id.disabled
  };
})`;

test("a form's named controls override its own members, on V8 and on boa", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <form id="f"><input name="id" value="1" disabled><input name="action"><input name="method"></form>
    <input form="f" name="outside">
    <form id="g"><input name="quantity"></form>
    <script>${PROBE}("v8");
    var s = document.createElement("script");
    s.textContent = ${JSON.stringify(PROBE + '("boa");')};
    document.head.appendChild(s);
    </script>`,
  );
  await page.waitForFunction(() => !!(globalThis as { __forms?: { boa?: unknown } }).__forms?.boa, {
    timeout: 20_000,
  });
  const expected = {
    id: "INPUT:id",
    action: "INPUT:action",
    method: "INPUT:method",
    byIndex: "INPUT:id",
    attribute: "f",
    elements: 4,
    submit: "function",
    plain: "string:g",
    enabled: true,
  };
  expect(await page.evaluate(() => (globalThis as { __forms?: unknown }).__forms)).toEqual({
    v8: expected,
    boa: expected,
  });
}, 60_000);

// The override is for page code only. A browser's own algorithms (reset, submission, FormData)
// never read named properties, so controls named "reset" or "elements" must not break them.
test("engine form algorithms ignore the named-control override", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <form id="r"><input name="q" value="orig"><input id="reset-click" type="reset" name="reset"></form>
    <form id="s"><input name="q" value="orig"><input id="reset-js" type="reset" name="reset"></form>
    <form id="e"><input name="a" value="1"><input name="elements" value="2"></form>`,
  );
  await page.evaluate(() => {
    (document.querySelector("#r input[name=q]") as HTMLInputElement).value = "changed";
    (document.querySelector("#s input[name=q]") as HTMLInputElement).value = "changed";
    const s = document.getElementById("s") as HTMLFormElement;
    s.addEventListener("reset", (e) => {
      (globalThis as { __resetTarget?: boolean }).__resetTarget = e.target === s;
    });
  });
  await page.click("#reset-click");
  const result = await page.evaluate(() => {
    (document.getElementById("reset-js") as HTMLInputElement).click();
    const form = document.getElementById("e") as HTMLFormElement;
    return {
      clickReset: (document.querySelector("#r input[name=q]") as HTMLInputElement).value,
      jsReset: (document.querySelector("#s input[name=q]") as HTMLInputElement).value,
      formData: [...new FormData(form).entries()].map(([k, v]) => k + "=" + String(v)),
      resetTargetIsPageForm: (globalThis as { __resetTarget?: boolean }).__resetTarget,
    };
  });
  expect(result).toEqual({
    clickReset: "orig",
    jsReset: "orig",
    formData: ["a=1", "elements=2"],
    resetTargetIsPageForm: true,
  });
}, 60_000);

test("a form with a control named elements submits all its fields", async ({ page }) => {
  const doc = new URL("https://ks.invalid/__fixtures/policy-doc.html");
  doc.searchParams.set(
    "body",
    `<form id="e" action="/__fixtures/policy-doc.html"><input name="a" value="1"><input name="elements" value="2"><button id="go">go</button></form>`,
  );
  await page.goto(doc.toString(), { waitUntil: "load" });
  await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click("#go")]);
  expect(new URL(page.url()).search).toBe("?a=1&elements=2");
}, 60_000);

// Node, EventTarget and Element tree members stay the form's own: the engine walks trees through
// them, so a control named parentNode would loop every ancestor walk. Pages do not rely on that.
test("controls named after tree members do not break engine walks", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><div id="host"><form id="f">` +
      `<input name="parentNode" value="x"><input name="firstChild"><input name="nextSibling">` +
      `</form></div>`,
  );
  const result = await page.evaluate(() => {
    const form = document.getElementById("f") as HTMLFormElement;
    const host = document.getElementById("host") as HTMLElement;
    let insert = "";
    try {
      form.appendChild(host);
    } catch (e) {
      insert = (e as Error).name;
    }
    return {
      entries: [...new FormData(form).entries()].map(([k, v]) => k + "=" + String(v)),
      insert,
      parentIsHost: form.parentNode === host,
      firstIsInput: (form.firstChild as Element | null)?.tagName,
    };
  });
  expect(result).toEqual({
    entries: ["parentNode=x", "firstChild=", "nextSibling="],
    insert: "HierarchyRequestError",
    parentIsHost: true,
    firstIsInput: "INPUT",
  });
}, 60_000);

test("numeric names do not override form indices", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><form id="f"><input name="first"><input name="0"><input name="5"></form>`,
  );
  const result = await page.evaluate(() => {
    const form = document.getElementById("f") as HTMLFormElement & Record<string, unknown>;
    return [form[0] === form.elements[0], form[5] === undefined];
  });
  expect(result).toEqual([true, true]);
}, 60_000);

test("detached forms keep externally associated controls", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const result = await page.evaluate(() => {
    const doc = document.implementation.createHTMLDocument("t");
    const form = doc.createElement("form");
    form.id = "f";
    const input = doc.createElement("input");
    input.name = "q";
    input.value = "x";
    input.setAttribute("form", "f");
    doc.body.appendChild(form);
    doc.body.appendChild(input);
    return [
      form.ownerDocument === doc,
      input.form === form,
      form.elements.length,
      new FormData(form).get("q"),
    ];
  });
  expect(result).toEqual([true, true, 1, "x"]);
}, 60_000);
