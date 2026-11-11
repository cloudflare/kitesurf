// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Classifies navigation responses into document types supported by the renderer and builds the
// viewer document for the types that are not parsed as HTML.

import { htmlTagSpans, removeHtmlTagSpans } from "../eval/html-tag-spans.ts";
import { sniffImageDims } from "../eval/image-dims.ts";

export type DocumentKind = "html" | "json" | "svg" | "image" | "text" | "blocked";

const RASTER_MIMES = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_APPLICATION_MIMES = new Set([
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
]);

function mimeEssence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isAttachment(contentDisposition: string | null): boolean {
  if (contentDisposition === null) return false;
  const type = (contentDisposition.split(";")[0] ?? "").trim().toLowerCase();
  return type !== "" && type !== "inline" && !type.includes("=");
}

export function documentKind(headers: Headers): DocumentKind {
  if (isAttachment(headers.get("content-disposition"))) return "blocked";
  // No sniffing yet: a missing type keeps the historical HTML default.
  const mime = mimeEssence(headers.get("content-type") ?? "");
  if (mime === "" || mime === "text/html" || mime === "application/xhtml+xml") {
    return "html";
  }
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "image/svg+xml") return "svg";
  if (RASTER_MIMES.has(mime)) return "image";
  if (mime.startsWith("text/") || TEXT_APPLICATION_MIMES.has(mime)) return "text";
  if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
  return "blocked";
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function imageDocumentTitle(url: string, bytes: Uint8Array): string {
  let name = "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
      try {
        name = decodeURIComponent(last);
      } catch {
        name = last;
      }
      if (!name) name = u.hostname;
    }
  } catch {}
  const dims = sniffImageDims(bytes);
  const size = dims ? `${dims.width}\u00d7${dims.height}` : "";
  if (name && size) return `${name} (${size})`;
  return name || size;
}

export function imageDocumentHtml(
  bytes: Uint8Array,
  base64: string,
  contentType: string,
  url: string,
): string {
  const src = `data:${mimeEssence(contentType)};base64,${base64}`;
  return (
    "<!doctype html><html><head>" +
    '<meta name="viewport" content="width=device-width, minimum-scale=0.1">' +
    `<title>${escapeHtml(imageDocumentTitle(url, bytes))}</title>` +
    "<style>" +
    "html,body{height:100%}" +
    "body{margin:0;background-color:rgb(14,14,14);display:flex;align-items:center;justify-content:center}" +
    "img{display:block;max-width:100%;max-height:100%;min-width:0;min-height:0;user-select:none;background-color:hsl(0,0%,90%)}" +
    "</style></head><body>" +
    `<img src="${src}">` +
    "</body></html>"
  );
}

function svgRootStart(source: string): number {
  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt < 0) return -1;
    const rest = source.slice(lt);
    if (rest.startsWith("<!--")) {
      const close = source.indexOf("-->", lt + 4);
      if (close < 0) return -1;
      at = close + 3;
    } else if (rest.startsWith("<?")) {
      const close = source.indexOf("?>", lt + 2);
      if (close < 0) return -1;
      at = close + 2;
    } else if (/^<!doctype/i.test(rest)) {
      const bracket = source.indexOf("[", lt);
      const gt = source.indexOf(">", lt);
      if (gt < 0) return -1;
      if (bracket >= 0 && bracket < gt) {
        const closeBracket = source.indexOf("]", bracket);
        if (closeBracket < 0) return -1;
        const gtAfter = source.indexOf(">", closeBracket);
        if (gtAfter < 0) return -1;
        at = gtAfter + 1;
      } else {
        at = gt + 1;
      }
    } else if (/^<svg[\s>]/i.test(rest)) {
      return lt;
    } else if (rest.startsWith("<") && /^<[a-z!?/]/i.test(rest)) {
      return -1;
    } else {
      at = lt + 1;
    }
  }
  return -1;
}

export function svgDocumentHtml(
  svgSource: string,
  viewport: { width: number; height: number },
): string {
  const rootStart = svgRootStart(svgSource);
  let svg = rootStart >= 0 ? svgSource.slice(rootStart) : svgSource;

  const spans = htmlTagSpans(svg, "meta", false);
  const lifted = spans.map(([start, end]) => svg.slice(start, end));
  svg = removeHtmlTagSpans(svg, spans);

  let rootTag = svg.slice(0, svg.indexOf(">") + 1 || undefined);

  const hasAbsoluteSize = (attr: string): boolean => {
    const m = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
    return !!m && !/%$/.test(m[1] ?? "");
  };
  if (
    !/[\s"']viewBox\s*=/i.test(rootTag) &&
    !(hasAbsoluteSize("width") && hasAbsoluteSize("height"))
  ) {
    const vb = `viewBox="0 0 ${viewport.width} ${viewport.height}"`;
    svg = svg.replace("<svg", `<svg ${vb}`);
    rootTag = svg.slice(0, svg.indexOf(">") + 1 || undefined);
  }
  const hasViewBox = /[\s"']viewBox\s*=/i.test(rootTag);

  const axisRule = (attr: "width" | "height", unit: "vw" | "vh"): string => {
    const m = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
    if (!m) return hasViewBox ? `${attr}:100${unit};` : "";
    const pct = (m[1] ?? "").match(/^([\d.]+)%$/);
    if (!pct) return "";
    return hasViewBox ? `${attr}:${pct[1]}${unit};` : "";
  };

  return (
    "<!doctype html><html><head><style>" +
    "html,body{margin:0;padding:0}" +
    `body>svg{display:block;${axisRule("width", "vw")}${axisRule("height", "vh")}}` +
    "</style>" +
    lifted.join("") +
    "</head><body>" +
    svg +
    "</body></html>"
  );
}

// Measured on representative API payloads, the parsed tree is 11x-19x the body it expands, and a
// document may be as large as MAX_DOCUMENT_BYTES (16 MiB). Above this many characters the viewer
// keeps the raw body, so its output stays a few times the document instead of 16x it.
export const JSON_PARSED_MAX_CHARS = 1 << 20;

function jsonRawDocument(text: string, url: string): string {
  return `<html><head><title>${escapeHtml(url)}</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

export function jsonViewerHtml(text: string, url: string): string {
  if (text.length > JSON_PARSED_MAX_CHARS) return jsonRawDocument(text, url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonRawDocument(text, url);
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(url)}</title>
<style>
  :root { color-scheme: light; }
  html, body {
    margin: 0;
    background: #fff;
    color: #111;
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  body { padding: 16px 24px 32px; }
  .json-toolbar {
    position: fixed;
    top: 12px;
    right: 20px;
    display: inline-flex;
    border: 1px solid #aaa;
    border-radius: 3px;
    overflow: hidden;
    background: linear-gradient(#fdfdfd, #dadada);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
    z-index: 1;
  }
  .json-toolbar button {
    min-width: 70px;
    padding: 6px 14px;
    border: 0;
    border-left: 1px solid #aaa;
    background: transparent;
    color: #333;
    font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
  }
  .json-toolbar button:first-child { border-left: 0; }
  .json-toolbar button.active { background: linear-gradient(#d8d8d8, #f5f5f5); }
  .json-panel { padding-right: 200px; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
   /* Reserve a gutter on every row so leaf text aligns with disclosure controls. */
  .json-row {
    position: relative;
    padding-left: 14px;
    white-space: pre;
    min-height: 1.4em;
  }
  .json-row > .json-toggle {
    position: absolute;
    left: 0;
    top: 0;
    width: 12px;
    color: #aaa;
    cursor: pointer;
    user-select: none;
    font-size: 10px;
    line-height: 1.4em;
  }
   /* Fixed indentation keeps child rows aligned regardless of key length. */
  .json-children { margin-left: 14px; }
  .json-collapsed > .json-children,
  .json-collapsed > .json-close { display: none; }
   /* Show the preview only while the row is collapsed. */
  .json-preview { color: #888; }
  .json-row:not(.json-collapsed) > .json-summary > .json-preview { display: none; }
  .json-key { color: #881391; }
  .json-string { color: #c41a16; }
  .json-number { color: #1a01cc; }
  .json-bool { color: #1a01cc; font-weight: 600; }
  .json-null { color: #808080; font-weight: 600; }
  .json-punct { color: #444; }
</style>
</head>
<body>
<div class="json-toolbar" role="tablist" aria-label="JSON view mode">
  <button type="button" class="active" data-view="parsed" role="tab" aria-selected="true">Parsed</button>
  <button type="button" data-view="raw" role="tab" aria-selected="false">Raw</button>
</div>
<main>
  <section id="json-parsed" class="json-panel">${renderJsonRoot(parsed)}</section>
  <section id="json-raw" class="json-panel" style="display:none"><pre>${escapeHtml(text)}</pre></section>
</main>
<script>
  (function () {
    var parsedPanel = document.getElementById("json-parsed");
    var rawPanel = document.getElementById("json-raw");
    var buttons = document.querySelectorAll(".json-toolbar button");
    // The DOM shim does not reflect hidden into paint; use style.display.
    function show(view) {
      parsedPanel.style.display = view === "parsed" ? "" : "none";
      rawPanel.style.display = view === "raw" ? "" : "none";
      buttons.forEach(function (button) {
        var active = button.getAttribute("data-view") === view;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        show(button.getAttribute("data-view"));
      });
    });
    parsedPanel.addEventListener("click", function (ev) {
      var summary = ev.target.closest && ev.target.closest(".json-summary");
      if (!summary) return;
      var row = summary.parentElement;
      if (!row || !row.classList.contains("json-collapsible")) return;
      row.classList.toggle("json-collapsed");
    });
  })();
</script>
</body>
</html>`;
}

function renderJsonRoot(value: unknown): string {
  return renderJsonRow(value, null, true);
}

function renderJsonRow(value: unknown, keyJson: string | null, last: boolean): string {
  const keyHtml =
    keyJson === null
      ? ""
      : `<span class="json-key">${escapeHtml(keyJson)}</span><span class="json-punct">: </span>`;
  const trailing = last ? "" : `<span class="json-punct">,</span>`;

  if (value === null || typeof value !== "object") {
    return `<div class="json-row">${keyHtml}${renderJsonScalar(value)}${trailing}</div>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `<div class="json-row">${keyHtml}<span class="json-punct">[]</span>${trailing}</div>`;
    }
    const children = value
      .map((item, index) => renderJsonRow(item, null, index === value.length - 1))
      .join("");
    return (
      `<div class="json-row json-collapsible">` +
      `<span class="json-toggle" aria-hidden="true">\u25bc</span>` +
      `<span class="json-summary">${keyHtml}<span class="json-punct">[</span>` +
      `<span class="json-preview">\u2026]${last ? "" : ","}</span></span>` +
      `<div class="json-children">${children}</div>` +
      `<div class="json-close"><span class="json-punct">]</span>${trailing}</div>` +
      `</div>`
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return `<div class="json-row">${keyHtml}<span class="json-punct">{}</span>${trailing}</div>`;
  }
  const children = entries
    .map(([k, v], index) => renderJsonRow(v, JSON.stringify(k), index === entries.length - 1))
    .join("");
  return (
    `<div class="json-row json-collapsible">` +
    `<span class="json-toggle" aria-hidden="true">\u25bc</span>` +
    `<span class="json-summary">${keyHtml}<span class="json-punct">{</span>` +
    `<span class="json-preview">\u2026}${last ? "" : ","}</span></span>` +
    `<div class="json-children">${children}</div>` +
    `<div class="json-close"><span class="json-punct">}</span>${trailing}</div>` +
    `</div>`
  );
}

function renderJsonScalar(value: unknown): string {
  if (value === null) return `<span class="json-null">null</span>`;
  switch (typeof value) {
    case "string":
      return `<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    case "number":
      return `<span class="json-number">${escapeHtml(JSON.stringify(value))}</span>`;
    case "boolean":
      return `<span class="json-bool">${value ? "true" : "false"}</span>`;
    default:
      return `<span class="json-null">null</span>`;
  }
}
