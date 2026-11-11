// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import iframeReferrerHostHtml from "../../assets/iframe-referrer-host.html";
import iframeReferrerNestedHtml from "../../assets/iframe-referrer-nested.html";
import { escapeHtmlText, intQuery, jsonForScript } from "../util.ts";

export const frames = new Hono();

frames.all("/oopif-child-solid.html", (c) => {
  const raw = c.req.query("c") ?? "000000";
  const hex = /^[0-9a-fA-F]{6}$/.test(raw) ? raw : "000000";
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>solid ${hex}</title></head>
<body style="margin:0;background:#${hex}">
<script>window.__c=${jsonForScript(hex)}</script>
<div style="width:100vw;height:100vh;background:#${hex}"></div>
</body>
</html>`);
});

const CROSS_ORIGIN_HOST = "http://127.0.0.1:8787";
const COLORS = ["ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff", "800000", "008080"];
frames.all("/oopif-host-many.html", (c) => {
  const childCount = intQuery(c, "k", { fallback: 4, min: 1, max: COLORS.length });
  const iframes = COLORS.slice(0, childCount).map(
    (color) =>
      `<iframe src="${CROSS_ORIGIN_HOST}/__fixtures/oopif-child-solid.html?c=${color}" width="100" height="100" style="border:0;display:block;margin:0"></iframe>`,
  );
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>oopif-host-many ${childCount}</title></head>
<body style="margin:0;background:#ffffff">
${iframes.join("\n")}
</body>
</html>`);
});

// A cross-origin frame document with its own CSP header. Its classic scripts run in the frame's
// own isolate, so they exercise the policy the navigate RPC carries from the terminal response.
const OOPIF_CSP_NONCE = "n0nce";
const oopifCspHits = new Map<string, number>();

frames.all("/oopif-csp-hop/:file{[\\w-]+\\.js}", (c) => {
  const key = c.req.param("file").slice(0, -".js".length);
  oopifCspHits.set(key, (oopifCspHits.get(key) ?? 0) + 1);
  return c.body(`parent.postMessage("ran:${key}", "*");`, 200, {
    "content-type": "text/javascript; charset=utf-8",
    // A classic script redirect before the fix goes through the CORS path; echo the origin so
    // only the policy, never an unrelated CORS denial, decides the outcome.
    "access-control-allow-origin": c.req.header("origin") ?? "*",
    "access-control-allow-credentials": "true",
  });
});

frames.all("/oopif-csp-hits/:key{[\\w-]+}", (c) =>
  c.json({ hits: oopifCspHits.get(c.req.param("key")) ?? 0 }, 200, { "cache-control": "no-store" }),
);

frames.all("/oopif-csp-frame.html", (c) => {
  const src = c.req.query("src") ?? "";
  const inline =
    c.req.query("inline") === "1" ? `<script>parent.postMessage("inline", "*")</script>` : "";
  return c.html(
    `<!doctype html><title>oopif csp</title>` +
      (src ? `<script src="${escapeHtmlText(src)}"></script>` : "") +
      inline +
      // The last parser script proves every earlier script finished, allowed or refused.
      `<script nonce="${OOPIF_CSP_NONCE}">parent.postMessage("parsed", "*")</script>`,
    200,
    { "content-security-policy": c.req.query("csp") ?? "" },
  );
});

// `?sandbox=` present is the empty attribute; omitting the query key omits the attribute.
frames.all("/sandbox-host.html", (c) => {
  const sandbox = c.req.query("sandbox");
  const src = c.req.query("src") ?? "";
  const attr = sandbox === undefined ? "" : ` sandbox="${escapeHtmlText(sandbox)}"`;
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>sandbox host</title></head>
<body>
<iframe id="f" src="${escapeHtmlText(src)}"${attr}
  style="border:0;display:block;width:120px;height:120px"></iframe>
<script>
window.__msgs = [];
addEventListener("message", (e) => window.__msgs.push({ data: e.data, origin: e.origin }));
</script>
</body></html>`);
});

// Reports whether its parser script ran and what identity and storage the document has. The block
// paints so a test can see the frame's bitmap without reading its document.
frames.all("/sandbox-child.html", (c) => {
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>sandbox child</title></head>
<body style="margin:0">
<p id="markup">sandbox child markup</p>
<div style="width:120px;height:120px;background:rgb(0,0,255)">x</div>
<script>
let cookie = "ok";
let storage = "ok";
try { document.cookie; } catch (e) { cookie = e.name; }
try { localStorage.getItem("k"); } catch (e) { storage = e.name; }
parent.postMessage({ ran: true, cookie: cookie, storage: storage }, "*");
</script>
</body></html>`);
});

// A child that reports its own worker identity: `?mode=same-origin` tries a same-origin worker
// script URL, `?mode=blob` reports the blob URL a document here mints.
frames.all("/sandbox-worker-child.html", (c) => {
  const script =
    c.req.query("mode") === "blob"
      ? `const url = URL.createObjectURL(new Blob([""]));
URL.revokeObjectURL(url);
parent.postMessage({ blobUrl: url, blobOrigin: new URL(url).origin }, "*");`
      : `let sameOriginWorker = "constructed";
try { new Worker("/__fixtures/worker-echo.js"); } catch (e) { sameOriginWorker = e.name; }
parent.postMessage({ sameOriginWorker: sameOriginWorker }, "*");`;
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>sandbox worker child</title></head>
<body><script>${script}</script></body></html>`);
});

// Registers an unload handler from its parser script, so a test can see which document identity
// the engine attributes to a message sent while that document is being replaced.
frames.all("/sandbox-unload-child.html", (c) => {
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>sandbox unload child</title></head>
<body><p id="markup">sandbox child markup</p>
<script>
addEventListener("unload", () => parent.postMessage({ unload: 1, href: location.href }, "*"));
</script>
</body></html>`);
});

// Static srcdoc children: an unsandboxed and a same-origin one carry a script and a relative link,
// and a script-disabled one carries an inline handler the parent-side facade must not keep.
frames.all("/sandbox-facade-host.html", (c) =>
  c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>sandbox facade host</title></head>
<body>
<iframe id="plain" srcdoc='<script>window.__srcdoc_ran = 1</script><a id="a" href="sibling.html">rel</a>'></iframe>
<iframe id="same" sandbox="allow-same-origin" srcdoc='<script>window.__srcdoc_ran = 2</script><a id="a" href="sibling.html">rel</a>'></iframe>
<iframe id="handler" sandbox="allow-same-origin" srcdoc='<button id="b" onclick="window.__ran = 1">go</button>'></iframe>
</body></html>`),
);

const MAX_IFRAMES = 40;
const CHILD_SEED_STRIDE = 1000;
frames.all("/iframe-many.html", (c) => {
  const iframeCount = intQuery(c, "k", { fallback: 10, min: 1, max: MAX_IFRAMES });
  const seed = intQuery(c, "seed", { fallback: 0 });
  const iframes = Array.from(
    { length: iframeCount },
    (_, index) =>
      `<iframe src="/__fixtures/iframe-churn-child.html?seed=${seed * CHILD_SEED_STRIDE + index}" width="120" height="80" style="border:0"></iframe>`,
  ).join("");
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>iframe-many ${seed}</title></head>
<body style="margin:0">${iframes}</body>
</html>`);
});

const CHURN_CHILD_ROWS = 400;
frames.all("/iframe-churn-child.html", (c) => {
  const seed = intQuery(c, "seed", { fallback: 0 });
  const rows = Array.from(
    { length: CHURN_CHILD_ROWS },
    (_, row) => `<p class="r${row}" data-seed="${seed}">row ${row} of seed ${seed}</p>`,
  );
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>churn child ${seed}</title></head>
<body style="margin:0;background:#0a0">
<div id="s">${seed}</div>
${rows.join("\n")}
</body>
</html>`);
});

// A static same-origin frame on echo-headers-frame.html beside a srcless
// one, so a test can compare the frame's wire Referer with its
// document.referrer. `?policy=` sets the host's Referrer-Policy.
frames.all("/iframe-referrer-host.html", (c) => {
  const policy = c.req.query("policy");
  return c.html(iframeReferrerHostHtml, 200, policy ? { "referrer-policy": policy } : {});
});

// A middle frame that embeds referer-to-url.html. `?policy=` sets its own
// Referrer-Policy, which its child's fetch must follow.
frames.all("/iframe-referrer-nested.html", (c) => {
  const policy = c.req.query("policy");
  return c.html(iframeReferrerNestedHtml, 200, policy ? { "referrer-policy": policy } : {});
});

// A cross-origin child marks its own document only if the engine parses the response as HTML.
const KIND_EXECUTES = `<script>document.documentElement.setAttribute('data-executed','1')</script>`;
const KIND_NAMES = ["html", "text", "json", "attachment", "204", "205"];
function kindQuery(value: string | undefined): string {
  return value && KIND_NAMES.includes(value) ? value : "html";
}

// One cross-origin frame of the requested response kind, so a test can see whether the engine
// rendered the child's bytes as a document.
frames.all("/oopif-kind-host.html", (c) => {
  const kind = kindQuery(c.req.query("kind"));
  const run = encodeURIComponent(c.req.query("run") ?? "");
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>kind host</title></head>
<body style="margin:0;background:#ffffff">
<iframe src="${CROSS_ORIGIN_HOST}/__fixtures/oopif-kind-child.html?kind=${kind}&run=${run}" width="200" height="200" style="border:0;display:block;margin:0"></iframe>
</body>
</html>`);
});

// Child document requests per `kind` and `run`, so a test can see a refused document fetched once.
const kindHits = new Map<string, number>();
frames.all("/oopif-kind-hits", (c) =>
  c.json({ hits: kindHits.get(`${c.req.query("kind")}:${c.req.query("run")}`) ?? 0 }),
);

frames.all("/oopif-kind-child.html", (c) => {
  const hitKey = `${c.req.query("kind")}:${c.req.query("run")}`;
  kindHits.set(hitKey, (kindHits.get(hitKey) ?? 0) + 1);
  switch (kindQuery(c.req.query("kind"))) {
    case "204":
      return c.body(null, 204);
    case "205":
      return c.body(null, 205);
    case "attachment":
      return c.html(KIND_EXECUTES, 200, {
        "content-disposition": "attachment; filename=child.html",
      });
    case "json":
      return c.json({ body: KIND_EXECUTES });
    case "text":
      return c.text(KIND_EXECUTES);
    default:
      return c.html(KIND_EXECUTES);
  }
});

// Redirects to itself with the Referer it got in `?referer=`, so the frame
// tree shows what a frame's request sent even where no page script can
// read the frame's document.
frames.all("/referer-to-url.html", (c) => {
  if (c.req.query("referer") !== undefined) {
    return c.html("<!doctype html><p>referer recorded</p>");
  }
  const next = new URL(c.req.url);
  next.searchParams.set("referer", c.req.header("referer") ?? "");
  return c.redirect(next.href, 302);
});

// One host for the embedding-policy regression. `child` is an absolute or same-origin URL, and
// `mode=srcdoc` wraps it in a srcdoc intermediate frame so the child's ancestry includes a
// local-scheme document. `dynamic=1` inserts the frame from script.
frames.all("/frame-policy-host.html", (c) => {
  const child = c.req.query("child") ?? "/__fixtures/frame-policy-child.html";
  const dynamic = c.req.query("dynamic") === "1";
  const frameMarkup = dynamic
    ? ""
    : `<iframe id="f" onload="window.__frameLoaded = true" src="${escapeHtmlText(child)}" style="border:0;width:200px;height:120px"></iframe>`;
  const dynamicScript = dynamic
    ? `<script>
      const f = document.createElement("iframe");
      f.id = "f";
      f.src = ${jsonForScript(child)};
      f.style.cssText = "border:0;width:200px;height:120px";
      f.addEventListener("load", () => { window.__frameLoaded = true; });
      document.body.appendChild(f);
    </script>`
    : "";
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>frame policy host</title></head>
<body style="margin:0">
<script>
window.__msgs = [];
window.__frameLoaded = false;
addEventListener("message", (e) => window.__msgs.push({ data: e.data, origin: e.origin }));
</script>
${frameMarkup}
${dynamicScript}
</body></html>`);
});

const framePolicyHits = new Map<string, number>();
frames.all("/frame-policy-hits", (c) =>
  c.json({ hits: framePolicyHits.get(c.req.query("marker") ?? "") ?? 0 }, 200, {
    "cache-control": "no-store",
  }),
);

// Reports through postMessage when it runs, and carries protected markup a blocked commit must
// never expose. `redirect=1` makes the terminal response one redirect away.
frames.all("/frame-policy-child.html", (c) => {
  const marker = c.req.query("marker") ?? "child";
  framePolicyHits.set(marker, (framePolicyHits.get(marker) ?? 0) + 1);
  if (c.req.query("redirect") === "1") {
    const target = new URL(c.req.url);
    target.searchParams.delete("redirect");
    return c.redirect(target.href, 302);
  }
  const headers: Record<string, string> = {};
  const csp = c.req.query("csp");
  const cspReportOnly = c.req.query("cspReportOnly");
  const xfo = c.req.query("xfo");
  if (csp !== undefined) headers["content-security-policy"] = csp;
  if (cspReportOnly !== undefined) headers["content-security-policy-report-only"] = cspReportOnly;
  if (xfo !== undefined) headers["x-frame-options"] = xfo;
  const script =
    c.req.query("script") === "0"
      ? ""
      : `<script>parent.postMessage(${jsonForScript(`ran:${marker}`)}, "*")</script>`;
  return c.html(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>frame policy child</title></head>
<body><p id="secret">protected ${escapeHtmlText(marker)}</p>
${script}
</body></html>`,
    200,
    headers,
  );
});
