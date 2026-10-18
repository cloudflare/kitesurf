// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Serves the default root page: how to open this engine from chrome://inspect.

const README = "https://github.com/cloudflare/kitesurf#readme";

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

export function landingPage(url: URL): Response {
  const target = escapeHtml(discoveryTarget(url));
  const browserWs = escapeHtml(
    `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/devtools/browser`,
  );
  // Chrome discovers network targets over plain HTTP and WebSocket only.
  const httpsNote =
    url.protocol === "https:"
      ? "<p><strong>Note:</strong> chrome://inspect discovers targets over plain HTTP, so it " +
        "cannot reach this engine over HTTPS. Use it with a local engine " +
        "(<code>pnpm run dev</code>) instead.</p>"
      : "";
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kitesurf</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
code { background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 3px; }
li { margin: 0.5rem 0; }
</style>
</head>
<body>
<h1>Kitesurf</h1>
<p>This engine speaks the Chrome DevTools Protocol. It has no web UI. To browse with it from Chrome DevTools:</p>
<ol>
<li>Open <code>chrome://inspect/#devices</code> in Chrome. Type or paste it into the address bar: web pages cannot link to it.</li>
<li>Select <strong>Discover network targets</strong>, click <strong>Configure…</strong> and add <code>${target}</code>.</li>
<li>Under <strong>Remote Target</strong>, click <strong>inspect</strong> next to <strong>kitesurf</strong>.</li>
<li>Type a page URL in the address bar above the screencast.</li>
</ol>
${httpsNote}
<p>Puppeteer and other CDP clients connect to <code>${browserWs}</code>. See the <a href="${README}">README</a>.</p>
</body>
</html>
`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
