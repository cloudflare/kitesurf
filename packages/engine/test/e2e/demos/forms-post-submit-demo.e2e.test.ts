// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

const FIXTURE_HOST = "http://127.0.0.1:8787";

function formPage(method: string, extra = "") {
  return (
    "data:text/html," +
    encodeURIComponent(`<!doctype html><html><body>
      <form id="f" method="${method}" action="${FIXTURE_HOST}/__fixtures/form-echo" ${extra}>
        <input name="user" value="rui">
        <input name="lang" value="pt">
        <input id="s" type="submit" name="go" value="Send">
      </form>
    </body></html>`)
  );
}

async function readEcho(page: any) {
  return page.evaluate(() => ({
    method: document.getElementById("method")?.textContent,
    ctype: document.getElementById("ctype")?.textContent,
    body: document.getElementById("body")?.textContent,
    query: document.getElementById("query")?.textContent,
  }));
}

function submitForm() {
  const form = document.getElementById("f");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("form #f was not found");
  }
  form.submit();
}

test("forms-post-submit-click", async ({ page }) => {
  await page.goto(formPage("post"));
  await Promise.all([page.waitForNavigation(), page.click("#s")]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("POST");
  expect(echo.ctype).toContain("application/x-www-form-urlencoded");
  expect(echo.body).toBe("user=rui&lang=pt&go=Send");
  expect(echo.query).toBe("");
});

test("forms-post-submit-enter", async ({ page }) => {
  await page.goto(formPage("post"));
  await page.click('input[name="user"]');
  await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("POST");
  expect(echo.body).toBe("user=rui&lang=pt&go=Send");
});

test("forms-post-submit-page-js", async ({ page }) => {
  await page.goto(formPage("post"));
  await Promise.all([page.waitForNavigation(), page.evaluate(submitForm).catch(() => {})]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("POST");
  expect(echo.body).toBe("user=rui&lang=pt");
});

test("forms-get-submit-page-js", async ({ page }) => {
  await page.goto(formPage("get"));
  await Promise.all([page.waitForNavigation(), page.evaluate(submitForm).catch(() => {})]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("GET");
  expect(echo.query).toBe("?user=rui&lang=pt");
  expect(echo.body).toBe("");
});

test("forms-post-submit-textplain", async ({ page }) => {
  await page.goto(formPage("post", 'enctype="text/plain"'));
  await Promise.all([page.waitForNavigation(), page.click("#s")]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("POST");
  expect(echo.ctype).toContain("text/plain");
  expect(echo.body).toBe("user=rui\nlang=pt\ngo=Send\n");
});

test("forms-post-submit-multipart", async ({ page }) => {
  await page.goto(formPage("post", 'enctype="multipart/form-data"'));
  await Promise.all([page.waitForNavigation(), page.click("#s")]);
  const echo = await readEcho(page);
  expect(echo.method).toBe("POST");
  expect(echo.ctype).toContain("multipart/form-data; boundary=");
  expect(echo.body).toContain('Content-Disposition: form-data; name="user"');
  expect(echo.body).toContain("rui");
});

test("forms-submit-page-js-navigates-its-own-page", async ({ browser }) => {
  const [first] = await browser.pages();
  await first.goto("data:text/html,<title>first</title>");
  const second = await browser.newPage();
  try {
    await second.goto(formPage("get"));
    await Promise.all([second.waitForNavigation(), second.evaluate(submitForm).catch(() => {})]);
    expect((await readEcho(second)).query).toBe("?user=rui&lang=pt");
    expect(await first.title()).toBe("first");
  } finally {
    await second.close();
  }
});
