// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const mode = args.find((a) => a === "--chrome" || a === "--kitesurf");
const url = args.find((a) => !a.startsWith("--"));
if (!mode || !url) {
  console.error("usage: node scripts/ax-dump.mjs --chrome|--kitesurf <url>");
  process.exit(1);
}

const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-146.0.7680.153/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

let browser, page;
if (mode === "--chrome") {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    args: ["--no-sandbox", "--window-size=1280,720"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
} else {
  const port = process.env.KITESURF_PORT || "41130";
  browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}/devtools/browser`,
  });
  page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 720 });
}

await page.goto(url, { waitUntil: "load", timeout: 60_000 });
const session = await page.createCDPSession();
await session.send("Accessibility.enable").catch(() => {});
const { nodes } = await session.send("Accessibility.getFullAXTree");

const norm = nodes.map((n) => ({
  id: n.nodeId,
  parent: n.parentId ?? null,
  children: n.childIds ?? [],
  ignored: !!n.ignored,
  ignoredReasons: (n.ignoredReasons ?? []).map((r) => r.name).sort(),
  role: n.role?.value ?? "",
  name: (n.name?.value ?? "").replace(/\s+/g, " ").trim(),
  description: (n.description?.value ?? "").replace(/\s+/g, " ").trim(),
  value: n.value?.value ?? null,
  props: Object.fromEntries(
    (n.properties ?? [])
      .map((p) => [p.name, p.value?.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ),
}));

console.log(JSON.stringify({ mode, url, count: norm.length, nodes: norm }, null, 0));
if (mode === "--chrome") await browser.close();
else await browser.disconnect();
