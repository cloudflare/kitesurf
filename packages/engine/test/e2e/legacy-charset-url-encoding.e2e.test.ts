// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setContent } from "./set-content";
import { expect, test } from "./harness";

const EUCKR_PAGE = "https://ks.invalid/__fixtures/euckr-form.html";
const UTF8_PAGE = "https://ks.invalid/__fixtures/form-echo";

test("an euc-kr document encodes hyperlink queries in euc-kr", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(() => {
    const a = document.createElement("a");
    const read = (href: string) => {
      a.href = href;
      return { search: a.search, pathname: a.pathname, href: a.href };
    };
    return {
      characterSet: document.characterSet,
      charset: document.charset,
      hangul: read("https://example.com/?\uAC00").search,
      unmappable: read("https://example.com/?\u0100").search,
      path: read("https://example.com/\uAC00?\uAC00"),
      relative: read("?x=\uAC00#\uAC00").href,
      wss: read("wss://example.com/?\uAC00").search,
      ascii: read("https://example.com/?a b").search,
    };
  });

  expect(got.characterSet).toBe("EUC-KR");
  expect(got.charset).toBe("EUC-KR");
  expect(got.hangul).toBe("?%B0%A1");
  expect(got.unmappable).toBe("?%26%23256%3B");
  expect(got.path).toEqual({
    search: "?%B0%A1",
    pathname: "/%EA%B0%80",
    href: "https://example.com/%EA%B0%80?%B0%A1",
  });
  expect(got.relative).toBe(`${EUCKR_PAGE}?x=%B0%A1#%EA%B0%80`);
  expect(got.wss).toBe("?%EA%B0%80");
  expect(got.ascii).toBe("?a%20b");
});

test("a same-origin iframe decodes and reports its response charset", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.onload = () => {
          const child = frame.contentDocument!;
          resolve({
            characterSet: child.characterSet,
            charset: child.charset,
            inputEncoding: child.inputEncoding,
            text: child.querySelector("#k")?.textContent ?? "",
          });
        };
        frame.src = "/__fixtures/euckr-child.html";
        document.body.appendChild(frame);
      }),
  );

  expect(got).toEqual({
    characterSet: "EUC-KR",
    charset: "EUC-KR",
    inputEncoding: "EUC-KR",
    text: "한국어",
  });
});

test("an iframe ignores <meta charset> labels the Encoding Standard doesn't know", async ({
  page,
}) => {
  await page.goto(UTF8_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(
    async (bodies: string[]) => {
      const characterSetOf = (html: string) =>
        new Promise<string>((resolve, reject) => {
          const frame = document.createElement("iframe");
          const timer = setTimeout(() => reject(new Error("frame never loaded")), 10000);
          frame.onload = () => {
            clearTimeout(timer);
            resolve(frame.contentDocument?.characterSet ?? "no document");
            frame.remove();
          };
          frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
          document.body.appendChild(frame);
        });
      const out: string[] = [];
      for (const html of bodies) out.push(await characterSetOf(html));
      return out;
    },
    [
      '<meta charset="437">x',
      '<meta charset="utf-32">x',
      '<meta charset="iso-8859-8 visual">x',
      '<meta charset="bogus"><meta charset="windows-1251">x',
      '<meta http-equiv="content-type" content="text/html; charset=koi8-u">x',
    ],
  );

  expect(got).toEqual(["UTF-8", "UTF-8", "UTF-8", "windows-1251", "KOI8-U"]);
});

test("a POST form targeting an iframe sends its body to the frame", async ({ page }) => {
  await page.goto(UTF8_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.name = "sink";
    document.body.appendChild(frame);
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/__fixtures/form-echo?q=1";
    form.target = "sink";
    const input = document.createElement("input");
    input.name = "user";
    input.value = "r\u00fai";
    form.appendChild(input);
    document.body.appendChild(form);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("frame never loaded")), 10000);
      frame.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      form.submit();
    });
    const doc = frame.contentDocument;
    const text = (id: string) => doc?.getElementById(id)?.textContent ?? null;
    return {
      method: text("method"),
      ctype: text("ctype"),
      body: text("body"),
      query: text("query"),
      pageUrl: location.href,
    };
  });

  expect(got).toEqual({
    method: "POST",
    ctype: "application/x-www-form-urlencoded",
    body: "user=r%C3%BAi",
    query: "?q=1",
    pageUrl: UTF8_PAGE,
  });
});

test("a GET form targeting an iframe navigates the frame with euc-kr entries", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(async () => {
    const frame = document.querySelector('iframe[name="sink"]');
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("sink iframe missing");
    const submit = (acceptCharset: string | null) =>
      new Promise<string>((resolve, reject) => {
        const form = document.createElement("form");
        form.target = "sink";
        if (acceptCharset !== null) form.acceptCharset = acceptCharset;
        const input = document.createElement("input");
        input.name = "q";
        input.value = "\uAC00 \u0100";
        form.appendChild(input);
        const charset = document.createElement("input");
        charset.type = "hidden";
        charset.name = "_charset_";
        form.appendChild(charset);
        document.body.appendChild(form);
        const timer = setTimeout(() => reject(new Error("frame never loaded")), 10000);
        frame.onload = () => {
          clearTimeout(timer);
          const contentWindow = frame.contentWindow;
          if (!contentWindow) reject(new Error("sink iframe has no window"));
          else resolve(contentWindow.location.search);
        };
        form.submit();
        form.remove();
      });
    return {
      documentCharset: await submit(null),
      bogusThenUtf8: await submit("bogus utf-8"),
      pageUrl: location.href,
    };
  });

  expect(got.documentCharset).toBe("?q=%B0%A1+%26%23256%3B&_charset_=EUC-KR");
  expect(got.bogusThenUtf8).toBe("?q=%EA%B0%80+%C4%80&_charset_=UTF-8");
  expect(got.pageUrl).toBe(EUCKR_PAGE);
});

test("a GET form into an iframe at about:blank keeps a same-origin document", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });

  const got = await page.evaluate(
    () =>
      new Promise<{ search: string; hasDocument: boolean }>((resolve, reject) => {
        const frame = document.querySelector('iframe[name="sink"]');
        if (!(frame instanceof HTMLIFrameElement)) throw new Error("sink iframe missing");
        const form = document.createElement("form");
        form.target = "sink";
        form.action = "about:blank";
        const input = document.createElement("input");
        input.name = "a";
        input.value = "1";
        form.appendChild(input);
        document.body.appendChild(form);
        frame.onload = () => {
          const contentWindow = frame.contentWindow;
          if (!contentWindow) {
            reject(new Error("sink iframe has no window"));
            return;
          }
          resolve({
            search: contentWindow.location.search,
            hasDocument: frame.contentDocument !== null,
          });
        };
        form.submit();
      }),
  );

  expect(got).toEqual({ search: "?a=1", hasDocument: true });
});

test("a link click navigates with the query in euc-kr", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "go";
    a.href = "?q=\uAC00";
    a.textContent = "go";
    a.style.cssText = "display:block;width:100px;height:40px";
    document.body.prepend(a);
  });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 15000 }),
    page.click("#go"),
  ]);

  expect(page.url()).toBe(`${EUCKR_PAGE}?q=%B0%A1`);
});

test("responseText decodes in the response's charset", async ({ page }) => {
  await page.goto(EUCKR_PAGE, { waitUntil: "load", timeout: 30000 });

  const text = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/__fixtures/euckr-child.html");
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(new Error("xhr failed"));
        xhr.send();
      }),
  );

  expect(text).toContain("\uD55C\uAD6D\uC5B4");
});

test("a utf-8 document keeps utf-8 queries", async ({ page }) => {
  await setContent(page, "<a href='https://example.com/?\u00e9'>x</a>");

  const got = await page.evaluate(() => {
    const anchor = document.querySelector("a");
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("anchor missing");
    return { characterSet: document.characterSet, search: anchor.search };
  });

  expect(got).toEqual({ characterSet: "UTF-8", search: "?%C3%A9" });
});
