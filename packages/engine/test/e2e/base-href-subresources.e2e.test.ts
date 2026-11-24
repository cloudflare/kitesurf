// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const ORIGIN = "https://ks.invalid";

// A page in /__fixtures/ whose base folder is two levels deeper: every `../../x` below names a
// fixture through the base, and a 404 outside /__fixtures/ without it.
const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};
const DEEPER_BASE = `<base href="/__fixtures/nested/deeper/">`;

function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    urls.push(request.url());
  });
  return urls;
}

async function imagesLoaded(page: Page, ...ids: string[]): Promise<void> {
  await page.waitForFunction(
    (wanted: string[]) =>
      wanted.every((id) => (document.getElementById(id) as HTMLImageElement).naturalWidth > 0),
    { timeout: 10_000 },
    ids,
  );
}

async function imageSize(page: Page, id: string): Promise<number[]> {
  return page.evaluate((imageId: string) => {
    const img = document.getElementById(imageId) as HTMLImageElement;
    return [img.naturalWidth, img.naturalHeight];
  }, id);
}

test("<base href> resolves stylesheet and image fetches", async ({ page }) => {
  await setContent(
    page,
    `<base href="${ORIGIN}/__fixtures/">
     <link rel="stylesheet" href="external-sheet.css">
     <p id="x">styled</p><img id="img" src="tiny.png">`,
  );
  await imagesLoaded(page, "img");

  const observed = await page.evaluate(() => {
    const img = document.getElementById("img") as HTMLImageElement;
    return {
      color: getComputedStyle(document.getElementById("x")!).color,
      size: [img.naturalWidth, img.naturalHeight],
    };
  });

  expect(observed).toEqual({ color: "rgb(0, 128, 0)", size: [7, 4] });
});

test("a root-relative <base href> moves subresources out of the page's folder", async ({
  page,
}) => {
  const requests = recordRequests(page);
  await page.goto(
    docUrl(
      DEEPER_BASE +
        `<link rel="stylesheet" href="../../external-sheet.css">` +
        `<p id="x">styled</p><img id="img" src="../../tiny.png">` +
        `<div id="bg" style="background-image: url(../../solid-red.png)"></div>`,
    ),
    { waitUntil: "load" },
  );
  await imagesLoaded(page, "img");

  const observed = await page.evaluate(() => ({
    color: getComputedStyle(document.getElementById("x")!).color,
    background: getComputedStyle(document.getElementById("bg")!).backgroundImage,
  }));
  expect(observed).toEqual({
    color: "rgb(0, 128, 0)",
    background: `url("${ORIGIN}/__fixtures/solid-red.png")`,
  });
  expect(await imageSize(page, "img")).toEqual([7, 4]);
  expect(requests).toContain(`${ORIGIN}/__fixtures/external-sheet.css`);
  expect(requests).toContain(`${ORIGIN}/__fixtures/tiny.png`);
  expect(requests).not.toContain(`${ORIGIN}/external-sheet.css`);
  expect(requests).not.toContain(`${ORIGIN}/tiny.png`);
});

test("a sheet fetched through <base href> exposes its rules", async ({ page }) => {
  await page.goto(
    docUrl(DEEPER_BASE + `<link id="l" rel="stylesheet" href="../../external-sheet.css">`),
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => getComputedStyle(document.body).fontFamily.includes("sans-serif"),
    { timeout: 10_000 },
  );

  const observed = await page.evaluate(() => {
    const link = document.getElementById("l") as HTMLLinkElement;
    return {
      href: link.href,
      rules: Array.from(link.sheet!.cssRules, (rule) => rule.cssText),
      sheetHref: document.styleSheets[0]?.href,
    };
  });
  expect(observed).toEqual({
    href: `${ORIGIN}/__fixtures/external-sheet.css`,
    rules: ["p#x { color: rgb(0, 128, 0); font-size: 24px; }", "body { font-family: sans-serif; }"],
    sheetHref: `${ORIGIN}/__fixtures/external-sheet.css`,
  });
});

test("a sheet loaded through <base href> keeps its rules after the base changes", async ({
  page,
}) => {
  await page.goto(
    docUrl(DEEPER_BASE + `<link id="l" rel="stylesheet" href="../../external-sheet.css">`),
    { waitUntil: "load" },
  );
  await page.waitForFunction(
    () => getComputedStyle(document.body).fontFamily.includes("sans-serif"),
    { timeout: 10_000 },
  );

  // The write moves link.href but not the sheet already fetched; read the rules only after it.
  const observed = await page.evaluate(() => {
    document.querySelector("base")!.setAttribute("href", "/elsewhere/a/b/");
    const link = document.getElementById("l") as HTMLLinkElement;
    return { href: link.href, rules: link.sheet!.cssRules.length };
  });
  expect(observed).toEqual({ href: `${ORIGIN}/elsewhere/external-sheet.css`, rules: 2 });
});

test("an iframe src resolves against <base href> in the frame tree", async ({ page }) => {
  await page.goto(docUrl(DEEPER_BASE + `<iframe src="../../external-sheet.html"></iframe>`), {
    waitUntil: "load",
  });

  const childUrls = page
    .frames()
    .filter((frame) => frame !== page.mainFrame())
    .map((frame) => frame.url());
  expect(childUrls).toEqual([`${ORIGIN}/__fixtures/external-sheet.html`]);
});

test("a script-inserted or rewritten <base> decides the fetches made after it", async ({
  page,
}) => {
  const requests = recordRequests(page);
  await page.goto(docUrl(`<p id="x">styled</p><img id="before" src="tiny.png">`), {
    waitUntil: "load",
  });
  await imagesLoaded(page, "before");

  await page.evaluate(() => {
    const base = document.createElement("base");
    base.href = "/__fixtures/nested/deeper/";
    document.head.append(base);
    const red = document.createElement("img");
    red.id = "red";
    red.src = "../../solid-red.png";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "../../external-sheet.css";
    document.body.append(red, link);

    base.href = "/__fixtures/nested/";
    const tiny = document.createElement("img");
    tiny.id = "tiny";
    tiny.src = "../tiny.png?rewritten";
    document.body.append(tiny);
  });
  await imagesLoaded(page, "red", "tiny");
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById("x")!).color === "rgb(0, 128, 0)",
    { timeout: 10_000 },
  );

  expect(await imageSize(page, "red")).toEqual([8, 8]);
  expect(await imageSize(page, "tiny")).toEqual([7, 4]);
  // The base change does not refetch or drop the image loaded before it.
  expect(await imageSize(page, "before")).toEqual([7, 4]);
  expect(requests.filter((url) => new URL(url).pathname.endsWith("/tiny.png"))).toEqual([
    `${ORIGIN}/__fixtures/tiny.png`,
    `${ORIGIN}/__fixtures/tiny.png?rewritten`,
  ]);
  expect(requests).not.toContain(`${ORIGIN}/solid-red.png`);
});

test("srcset and <picture> sources resolve against <base href>", async ({ page }) => {
  await page.goto(
    docUrl(
      DEEPER_BASE +
        `<img id="srcset" srcset="../../solid-red.png 1x">` +
        `<picture><source srcset="../../solid-red.png"><img id="picture" src="../../tiny.png"></picture>`,
    ),
    { waitUntil: "load" },
  );
  await imagesLoaded(page, "srcset", "picture");

  expect(await imageSize(page, "srcset")).toEqual([8, 8]);
  expect(await imageSize(page, "picture")).toEqual([8, 8]);
});

test("a data:, javascript: or unparsable <base href> leaves the document URL", async ({ page }) => {
  for (const href of ["data:,", "data:/x/", "javascript:/x/", "https://[::1"]) {
    await page.goto(
      docUrl(
        `<base href="${href}"><link rel="stylesheet" href="external-sheet.css">` +
          `<p id="x">styled</p><img id="img" src="tiny.png">`,
      ),
      { waitUntil: "load" },
    );
    await imagesLoaded(page, "img");

    const observed = await page.evaluate(() => ({
      baseIsDocument: document.baseURI === document.URL,
      color: getComputedStyle(document.getElementById("x")!).color,
    }));
    expect(observed, href).toEqual({ baseIsDocument: true, color: "rgb(0, 128, 0)" });
  }
});
