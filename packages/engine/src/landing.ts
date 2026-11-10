// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Serves the default root page: a URL form and examples that open the configured DevTools
// frontend, the CDP endpoints for agents and other clients, and the chrome://inspect steps.

import { inspectorTargetUrl } from "./inspector.ts";

const README = "https://github.com/cloudflare/kitesurf#readme";

const EXAMPLES: ReadonlyArray<{ title: string; url: string }> = [
  { title: "Example Domain", url: "https://example.com/" },
  { title: "Wikipedia: Kitesurfing", url: "https://en.wikipedia.org/wiki/Kitesurfing" },
  { title: "The Cloudflare Blog", url: "https://blog.cloudflare.com/" },
  { title: "Browser Run docs", url: "https://developers.cloudflare.com/browser-run/" },
];

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Chrome's Configure dialog wants host:port, and URL.host drops a default port.
function discoveryTarget(url: URL): string {
  if (url.port !== "") return url.host;
  return `${url.hostname}:${url.protocol === "https:" ? "443" : "80"}`;
}

// The form submits to `/?url=`, which redirects to the frontend; the examples link to it directly.
function inspectSection(url: URL, base: string): string {
  const examples = EXAMPLES.map(({ title, url: page }) => {
    const href = escapeHtml(inspectorTargetUrl(base, { url, host: url.host, initialUrl: page }));
    return `<li><a href="${href}">${escapeHtml(title)}</a> <code>${escapeHtml(page)}</code></li>`;
  }).join("\n");
  return `<form class="omnibox" action="/" method="get" autocomplete="off">
<label class="sr-only" for="inspect-url">Enter a URL to inspect</label>
<input id="inspect-url" type="url" name="url" placeholder="Enter a URL to inspect" required spellcheck="false" autocapitalize="off">
<button type="submit">Inspect</button>
</form>
<p>Or open an example page in DevTools:</p>
<ul class="examples">
${examples}
</ul>`;
}

function cdpSection(url: URL): string {
  const ws = url.protocol === "https:" ? "wss" : "ws";
  const browserWs = escapeHtml(`${ws}://${url.host}/devtools/browser`);
  const pageWs = escapeHtml(`${ws}://${url.host}/devtools/page/kitesurf`);
  const origin = escapeHtml(url.origin);
  return `<h2>Connect a CDP client</h2>
<p>Point your agent, Puppeteer, Playwright or another DevTools client at this engine:</p>
<dl class="endpoints">
<dt>Browser endpoint, for Puppeteer, Playwright and agents</dt>
<dd><code>${browserWs}</code></dd>
<dt>Page endpoint, for a DevTools frontend</dt>
<dd><code>${pageWs}</code></dd>
<dt>Discovery</dt>
<dd><a href="/json/version"><code>${origin}/json/version</code></a>, <a href="/json/list"><code>${origin}/json/list</code></a></dd>
</dl>
<pre><code>const browser = await puppeteer.connect({
  browserWSEndpoint: "${browserWs}",
});</code></pre>`;
}

// Chrome discovers network targets over plain HTTP and WebSocket only, so HTTPS skips the steps.
function chromeInspectSection(url: URL): string {
  if (url.protocol === "https:") return "";
  return `<h2>Use chrome://inspect</h2>
<ol>
<li>Open <code>chrome://inspect/#devices</code> in Chrome. Type or paste it into the address bar: web pages cannot link to it.</li>
<li>Select <strong>Discover network targets</strong>, click <strong>Configure…</strong> and add <code>${escapeHtml(discoveryTarget(url))}</code>.</li>
<li>Under <strong>Remote Target</strong>, click <strong>inspect</strong> next to <strong>kitesurf</strong>.</li>
<li>Type a page URL in the address bar above the screencast.</li>
</ol>`;
}

/** `inspectorBase` is the configured DevTools frontend; null leaves the CDP endpoints only. */
export function landingPage(url: URL, inspectorBase: string | null = null): Response {
  const intro =
    inspectorBase === null
      ? "<p>This engine speaks the Chrome DevTools Protocol and serves no DevTools frontend. " +
        "Connect your agent or DevTools client to the endpoints below.</p>"
      : "<p>This engine speaks the Chrome DevTools Protocol. Enter a URL to open it in Chrome DevTools.</p>" +
        inspectSection(url, inspectorBase);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kitesurf</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
code { background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f2f2f2; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; }
li { margin: 0.5rem 0; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
dt { font-weight: 600; margin-top: 0.75rem; }
dd { margin: 0.25rem 0 0; }
.omnibox { display: flex; gap: 0.5rem; margin: 1.5rem 0; }
.omnibox input { flex: 1; font: inherit; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 6px; }
.omnibox button { font: inherit; padding: 0.5rem 1rem; border: 0; border-radius: 6px; background: #f46021; color: #fff; cursor: pointer; }
.examples { padding-left: 1.25rem; }
.examples code { color: #555; font-size: 0.85em; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
</head>
<body>
<h1>Kitesurf</h1>
${intro}
${cdpSection(url)}
${chromeInspectSection(url)}
<p>See the <a href="${README}">README</a>.</p>
</body>
</html>
`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; " +
        "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
