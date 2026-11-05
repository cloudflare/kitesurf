// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const body = `<!--before--><title>t</title><p title="é">𝔽 &amp; é</p>
<script>
  globalThis.__doctypeReport = JSON.stringify({
    children: document.childNodes.length,
    firstType: document.firstChild.nodeType,
    secondData: document.childNodes[1].data,
    doctype: document.doctype && document.doctype.name,
  });
</script>`;

test("a source doctype stays out of page and default HTML but returns with includeDoctype", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, `<!DOCTYPE html>${body}`, { waitUntil: "load" });
  expect(await readJsonReport(cdpSession, "globalThis.__doctypeReport")).toEqual({
    children: 3,
    firstType: 10,
    secondData: "before",
    doctype: "html",
  });
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const plain = await cdpSession.send("DOM.getOuterHTML", { nodeId: root.nodeId });
  const withDoctype = await cdpSession.send("DOM.getOuterHTML", {
    nodeId: root.nodeId,
    includeDoctype: true,
  });

  expect(plain.outerHTML).toMatch(/^<!--before--><html><head><title>t<\/title><\/head>/);
  expect(plain.outerHTML).toContain('<p title="é">𝔽 &amp; é</p>');
  expect(plain.outerHTML).not.toContain("__kitesurf_doctype");
  expect(withDoctype.outerHTML).toBe(`<!DOCTYPE html>${plain.outerHTML}`);
}, 60_000);

// The page gets its source as UTF-8, so the doctype marker goes at a byte offset: multibyte
// characters before the doctype must not shift it.
test("a doctype after a non-ASCII comment keeps its place", async ({ page, cdpSession }) => {
  await setContent(page, `<!-- é𝔽 --><!DOCTYPE html><p>x</p>`, { waitUntil: "load" });
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const { outerHTML } = await cdpSession.send("DOM.getOuterHTML", {
    nodeId: root.nodeId,
    includeDoctype: true,
  });
  expect(outerHTML).toBe(
    "<!-- é𝔽 --><!DOCTYPE html><html><head></head><body><p>x</p></body></html>",
  );
}, 60_000);

// Several 256 KiB stream chunks, with multibyte characters split across chunk boundaries.
const LONG_TEXT = "é𝔽a".repeat(120_000);

test("a page larger than one stream chunk serializes whole", async ({ page, cdpSession }) => {
  await setContent(page, `<!DOCTYPE html><p id="long">${LONG_TEXT}</p>`, { waitUntil: "load" });
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const { outerHTML } = await cdpSession.send("DOM.getOuterHTML", {
    nodeId: root.nodeId,
    includeDoctype: true,
  });

  expect(outerHTML).toBe(
    `<!DOCTYPE html><html><head></head><body><p id="long">${LONG_TEXT}</p></body></html>`,
  );
}, 60_000);

// Page timers run between stream pulls. Both ends change in one task, so a single
// serialization always shows them equal.
const TICKING_PAGE = `<!DOCTYPE html><p id="first" data-v="0"></p><p>${LONG_TEXT}</p>
<p id="last" data-v="0"></p>
<script>
  let n = 0;
  setInterval(() => {
    n = (n + 1) % 10;
    document.getElementById("first").dataset.v = String(n);
    document.getElementById("last").dataset.v = String(n);
  }, 0);
</script>`;

test("a DOM that changes while it streams still serializes from one tree", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, TICKING_PAGE, { waitUntil: "load" });
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  for (let i = 0; i < 5; i++) {
    const { outerHTML } = await cdpSession.send("DOM.getOuterHTML", { nodeId: root.nodeId });
    const first = /<p id="first" data-v="(\d)">/.exec(outerHTML)?.[1];
    const last = /<p id="last" data-v="(\d)">/.exec(outerHTML)?.[1];
    expect(first).toMatch(/^\d$/);
    expect(last).toBe(first);
    expect(outerHTML).toContain(`<p>${LONG_TEXT}</p>`);
  }
}, 60_000);
