// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Keep positive and negative controls paired; a broken pipeline can block every script.
import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";

const scriptUrl = (params: Record<string, string>): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-script.js`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const docUrl = (csp: string, body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  if (csp) u.searchParams.set("csp", csp);
  u.searchParams.set("body", body);
  return u.toString();
};

async function ran(page: Page): Promise<string[]> {
  return (await page.evaluate(
    () => (globalThis as { __ksRan?: string[] }).__ksRan ?? [],
  )) as string[];
}

async function sri(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(source));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `sha384-${btoa(bin)}`;
}

const fixtureBody = (tag: string, extra: boolean): string =>
  `globalThis.__ksRan = (globalThis.__ksRan || []).concat(["${tag}"]);\n` +
  (extra ? "/* tampered */\n" : "");

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
}

test("SRI: a matching digest runs, a tampered body does not", async ({ browser }) => {
  const good = await sri(fixtureBody("good", false));

  const page = await browser.newPage();
  await page.goto(
    docUrl(
      "",
      `<script src="${scriptUrl({ tag: "good" })}" integrity="${good}" crossorigin="anonymous"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page)).toEqual(["good"]);

  const page2 = await browser.newPage();
  await page2.goto(
    docUrl(
      "",
      `<script src="${scriptUrl({ tag: "bad", extra: "1" })}" integrity="${good}" crossorigin="anonymous"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual([]);
});

test("SRI: integrity without crossorigin cannot be honoured", async ({ browser }) => {
  const url = "https://ks-other.invalid/__fixtures/policy-script.js?tag=opaque";
  const digest = await sri(fixtureBody("opaque", false));

  const page = await browser.newPage();
  await page.goto(docUrl("", `<script src="${url}" integrity="${digest}"></script>`), {
    waitUntil: "load",
  });
  expect(await ran(page)).toEqual([]);

  const page2 = await browser.newPage();
  await page2.goto(
    docUrl("", `<script src="${url}" integrity="${digest}" crossorigin="anonymous"></script>`),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual(["opaque"]);
});

test("nosniff: a JSON-typed response is refused as script", async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(
    docUrl(
      "",
      `<script src="${scriptUrl({ tag: "sniffable", ct: "application/json" })}"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page)).toEqual(["sniffable"]);

  const page2 = await browser.newPage();
  await page2.goto(
    docUrl(
      "",
      `<script src="${scriptUrl({ tag: "refused", ct: "application/json", nosniff: "1" })}"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual([]);
});

test("CSP header: script-src 'self' refuses a third-party host", async ({ browser }) => {
  const sameOrigin = scriptUrl({ tag: "same" });
  const page = await browser.newPage();
  await page.goto(docUrl("script-src 'self'", `<script src="${sameOrigin}"></script>`), {
    waitUntil: "load",
  });
  expect(await ran(page)).toEqual(["same"]);

  const page2 = await browser.newPage();
  await page2.goto(
    docUrl("script-src https://other.invalid", `<script src="${sameOrigin}"></script>`),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual([]);
});

test("CSP header: a nonce admits inline script and nothing else", async ({ page }) => {
  const body =
    `<script nonce="n0nce">globalThis.__ksRan=["nonced"];</script>` +
    `<script>globalThis.__ksRan=(globalThis.__ksRan||[]).concat(["injected"]);</script>`;
  await page.goto(docUrl("script-src 'unsafe-inline' 'nonce-n0nce'", body), { waitUntil: "load" });
  expect(await ran(page)).toEqual(["nonced"]);
});

test("meta http-equiv CSP is enforced like a header policy", async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(
    docUrl(
      "",
      `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">` +
        `<script>globalThis.__ksRan=["inline"];</script>` +
        `<script src="${scriptUrl({ tag: "external" })}"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page)).toEqual([]);

  const page2 = await browser.newPage();
  await page2.goto(
    docUrl(
      "",
      `<script>globalThis.__ksRan=["inline"];</script>` +
        `<script src="${scriptUrl({ tag: "external" })}"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual(["inline", "external"]);
});

test("report-only CSP records but never blocks", async ({ page }) => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("cspReportOnly", "script-src 'none'");
  u.searchParams.set("body", `<script>globalThis.__ksRan=["reported"];</script>`);
  await page.goto(u.toString(), { waitUntil: "load" });
  expect(await ran(page)).toEqual(["reported"]);
});

test("a runtime-inserted script is gated too", async ({ browser }) => {
  const insert =
    `<script nonce="n0nce">` +
    `var s = document.createElement("script");` +
    `s.src = ${JSON.stringify(scriptUrl({ tag: "chunk" }))};` +
    `document.head.appendChild(s);` +
    `</script>`;

  const page = await browser.newPage();
  await page.goto(docUrl("script-src 'nonce-n0nce'", insert), {
    waitUntil: "load",
  });
  await settle(page);
  expect(await ran(page)).toEqual([]);

  const page2 = await browser.newPage();
  await page2.goto(docUrl(`script-src 'nonce-n0nce' ${ORIGIN}`, insert), { waitUntil: "load" });
  await settle(page2);
  expect(await ran(page2)).toEqual(["chunk"]);
});

test("'self' stays the committed document's origin during a pending navigation", async ({
  browser,
}) => {
  // The 204 aborts the navigation, so the inserting document stays live.
  const OTHER = "https://ks-other.invalid";
  const insert = (src: string) =>
    `<script nonce="n0nce">` +
    `location.href = ${JSON.stringify(`${OTHER}/__fixtures/status-204`)};` +
    `var s = document.createElement("script");` +
    `s.src = ${JSON.stringify(src)};` +
    `document.head.appendChild(s);` +
    `</script>`;
  const policy = "script-src 'nonce-n0nce' 'self'";
  const crossOrigin = scriptUrl({ tag: "xo" }).replace(ORIGIN, OTHER);

  const page = await browser.newPage();
  await page.goto(docUrl(policy, insert(crossOrigin)), { waitUntil: "load" });
  await settle(page);
  expect(await ran(page)).toEqual([]);

  const page2 = await browser.newPage();
  await page2.goto(docUrl(policy, insert(scriptUrl({ tag: "self" }))), { waitUntil: "load" });
  await settle(page2);
  expect(await ran(page2)).toEqual(["self"]);
});

test("a runtime-inserted script's nonce is read from the IDL property", async ({ browser }) => {
  const inline = `globalThis.__ksRan=(globalThis.__ksRan||[]).concat(["inline"]);`;
  const insert = (how: string, body: string) =>
    `<script nonce="n0nce">` +
    `var s = document.createElement("script");` +
    how +
    body +
    `document.head.appendChild(s);` +
    `</script>`;
  const external = `s.src = ${JSON.stringify(scriptUrl({ tag: "chunk" }))};`;
  const text = `s.textContent = ${JSON.stringify(inline)};`;
  const policy = "script-src 'nonce-n0nce'";

  const cases: Array<[string, string, string, string[]]> = [
    ["external, IDL, matching", `s.nonce = "n0nce";`, external, ["chunk"]],
    ["external, IDL, wrong", `s.nonce = "other";`, external, []],
    ["external, attribute, matching", `s.setAttribute("nonce", "n0nce");`, external, ["chunk"]],
    ["inline, IDL, matching", `s.nonce = "n0nce";`, text, ["inline"]],
    ["inline, IDL, wrong", `s.nonce = "other";`, text, []],
  ];
  for (const [label, how, body, expected] of cases) {
    const page = await browser.newPage();
    await page.goto(docUrl(policy, insert(how, body)), { waitUntil: "load" });
    await settle(page);
    expect(await ran(page), label).toEqual(expected);
  }
});

test("a hash-source policy admits a runtime-inserted inline script", async ({ browser }) => {
  const inserted = `globalThis.__ksRan=(globalThis.__ksRan||[]).concat(["inserted"]);`;
  const insert =
    `<script nonce="n0nce">` +
    `var s = document.createElement("script");` +
    `s.textContent = ${JSON.stringify(inserted)};` +
    `document.head.appendChild(s);` +
    `</script>`;
  const hash = await sri(inserted);

  const page = await browser.newPage();
  await page.goto(docUrl(`script-src 'nonce-n0nce' '${hash}'`, insert), {
    waitUntil: "load",
  });
  await settle(page);
  expect(await ran(page)).toEqual(["inserted"]);

  const other = await sri(`${inserted}// not this one\n`);
  const page2 = await browser.newPage();
  await page2.goto(docUrl(`script-src 'nonce-n0nce' '${other}'`, insert), {
    waitUntil: "load",
  });
  await settle(page2);
  expect(await ran(page2)).toEqual([]);
});

test("<base href> is what relative script src resolves against", async ({ page }) => {
  await page.goto(
    docUrl(
      "",
      `<base href="${ORIGIN}/__fixtures/nested/deeper/">` +
        `<script src="../../policy-script.js?tag=based"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page)).toEqual(["based"]);
});

const HANDLER_BODY =
  `<script nonce="n0nce">` +
  `globalThis.__ksRan = [];` +
  `const b = document.createElement("button");` +
  `b.setAttribute("onclick", "__ksRan.push('setAttribute')");` +
  `document.body.append(b);` +
  `addEventListener("load", () => { document.getElementById("p").click(); b.click(); });` +
  `</script>` +
  `<button id="p" onclick="__ksRan.push('parsed')"></button>` +
  `<img src="/__fixtures/missing.png" onerror="__ksRan.push('onerror')">`;

test("CSP: a nonce does not admit inline event handler attributes", async ({ page }) => {
  await page.goto(docUrl("script-src 'nonce-n0nce'", HANDLER_BODY), { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 200));
  expect(await ran(page)).toEqual([]);
});

test("CSP: 'unsafe-inline' still admits inline event handler attributes", async ({ page }) => {
  await page.goto(
    docUrl("script-src 'unsafe-inline'", HANDLER_BODY.replace(' nonce="n0nce"', "")),
    {
      waitUntil: "load",
    },
  );
  await new Promise((r) => setTimeout(r, 200));
  expect([...(await ran(page))].sort()).toEqual(["onerror", "parsed", "setAttribute"]);
});

test("CSP: script-src-attr governs handlers independently of script-src", async ({ page }) => {
  await page.goto(
    docUrl("script-src 'nonce-n0nce'; script-src-attr 'unsafe-inline'", HANDLER_BODY),
    {
      waitUntil: "load",
    },
  );
  await new Promise((r) => setTimeout(r, 200));
  expect([...(await ran(page))].sort()).toEqual(["onerror", "parsed", "setAttribute"]);
});

const viaRedirect = (to: string): string =>
  `${ORIGIN}/__fixtures/loud-redirect?to=${encodeURIComponent(to)}`;
const OTHER_SCRIPT = "https://ks-other.invalid/__fixtures/policy-script.js";

test("CSP: a parser script that redirects off the allowlist does not run", async ({ browser }) => {
  const csp = `script-src ${ORIGIN} 'nonce-n0nce'`;
  const page = await browser.newPage();
  await page.goto(
    docUrl(csp, `<script src="${viaRedirect(`${OTHER_SCRIPT}?tag=redirected`)}"></script>`),
    { waitUntil: "load" },
  );
  expect(await ran(page)).toEqual([]);

  // A redirect inside the allowlist still runs, and a source path is not matched after it.
  const page2 = await browser.newPage();
  await page2.goto(
    docUrl(
      `script-src ${ORIGIN}/__fixtures/loud-redirect`,
      `<script src="${viaRedirect(scriptUrl({ tag: "same-host" }))}"></script>`,
    ),
    { waitUntil: "load" },
  );
  expect(await ran(page2)).toEqual(["same-host"]);
});

test("CSP: a runtime-inserted script that redirects off the allowlist does not run", async ({
  page,
}) => {
  const body =
    `<script nonce="n0nce">` +
    `for (const src of ${JSON.stringify([
      viaRedirect(`${OTHER_SCRIPT}?tag=inserted-off`),
      viaRedirect(scriptUrl({ tag: "inserted-on" })),
    ])}) { const s = document.createElement("script"); s.src = src; document.head.append(s); }` +
    `</script>`;
  await page.goto(docUrl(`script-src ${ORIGIN} 'nonce-n0nce'`, body), { waitUntil: "load" });
  await settle(page);
  expect(await ran(page)).toEqual(["inserted-on"]);
});
