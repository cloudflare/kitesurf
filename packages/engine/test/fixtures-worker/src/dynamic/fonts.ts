// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import ksTestMonoWoff2 from "../../assets/ks-test-mono.woff2";
import shapingMetricsHtml from "../../assets/shaping-metrics.html";
import webfontHtml from "../../assets/webfont.html";
import { intQuery, sleep } from "../util.ts";

export const fonts = new Hono();

const WOFF2_HEADERS = { "content-type": "font/woff2" };

const fontDeferHits = new Map<string, number>();

fonts.all("/font-defer-probe.woff2", async (c) => {
  const probe = c.req.query("probe") ?? "";
  fontDeferHits.set(probe, (fontDeferHits.get(probe) ?? 0) + 1);
  const ms = intQuery(c, "ms", { fallback: 0, min: 0, max: 5000 });
  if (ms > 0) await sleep(ms);
  return c.body(ksTestMonoWoff2, 200, WOFF2_HEADERS);
});

fonts.all("/font-defer-probe-hits", (c) =>
  c.json({ hits: fontDeferHits.get(c.req.query("probe") ?? "") ?? 0 }),
);

const FONT_DEFER_SCRIPTS: Record<string, string> = {
  measure: `
    var early = document.getElementById("wf").getBoundingClientRect().width;
    window.addEventListener("load", function () {
      var wf = document.getElementById("wf").getBoundingClientRect().width;
      var fb = document.getElementById("fallback").getBoundingClientRect().width;
      document.body.setAttribute("data-early", String(early));
      document.body.setAttribute("data-wf", String(wf));
      document.body.setAttribute("data-fb", String(fb));
      var marker = document.createElement("div");
      marker.id = "done";
      document.body.appendChild(marker);
    });`,
  canvas: `
    var ctx = document.createElement("canvas").getContext("2d");
    ctx.font = "24px sans-serif";
    var beforeReady = ctx.measureText("WebFont123.test");
    document.body.setAttribute("data-mt1", String(beforeReady.width));
    document.fonts.ready.then(function () {
      var afterReady = ctx.measureText("WebFont123.test");
      document.body.setAttribute("data-mt2", String(afterReady.width));
    });`,
  ready: `
    document.fonts.ready.then(function () {
      var wf = document.getElementById("wf").getBoundingClientRect().width;
      var fb = document.getElementById("fallback").getBoundingClientRect().width;
      document.body.setAttribute("data-wf", String(wf));
      document.body.setAttribute("data-fb", String(fb));
      var marker = document.createElement("div");
      marker.id = "ready";
      document.body.appendChild(marker);
    });`,
};

fonts.all("/font-defer.html", (c) => {
  const probe = c.req.query("probe") ?? "p";
  const ms = intQuery(c, "ms", { fallback: 0 });
  const script = FONT_DEFER_SCRIPTS[c.req.query("mode") ?? ""];
  const src = `/__fixtures/font-defer-probe.woff2?probe=${probe}${ms > 0 ? `&ms=${ms}` : ""}`;
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8" /><title>font-defer</title>
<style>
  @font-face { font-family: KsDeferMono; src: url(${src}); }
  body { margin: 0; background: #fff; font-size: 24px; }
  span { display: inline-block; }
  #wf { font-family: KsDeferMono; }
</style>
</head>
<body>
  <div><span id="fallback">WebFont123.test</span></div>
  <div><span id="wf">WebFont123.test</span></div>
  ${script ? `<script>${script}\n  </script>` : ""}
</body>
</html>`);
});

fonts.all("/font-heavy.html", (c) => {
  const declared = intQuery(c, "declared", { fallback: 12, min: 1, max: 64 });
  const used = intQuery(c, "used", { fallback: 3, min: 0, max: declared });
  const faces = Array.from(
    { length: declared },
    (_, face) => `@font-face {
  font-family: "wf-${face}";
  src: url("/__fixtures/noto-var-latin-subset.woff2?v=${face}") format("woff2");
}`,
  ).join("\n");
  const paras = Array.from(
    { length: used },
    (_, face) =>
      `<p style="font-family: 'wf-${face}', sans-serif">used family wf-${face}: lorem ipsum dolor</p>`,
  ).join("\n");
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>font-heavy fixture (${declared} declared / ${used} used)</title>
<style>
${faces}
p { font-size: 18px; margin: 4px; }
</style></head>
<body>
<h1>font-heavy: ${declared} declared, ${used} used</h1>
${paras}
<p style="font-family: sans-serif">control paragraph (UA font)</p>
</body>
</html>`);
});

fonts.all("/cors-font.woff2", (c) => {
  const origin = c.req.header("origin");
  if (c.req.query("acao") === "1" && origin) {
    return c.body(ksTestMonoWoff2, 200, {
      ...WOFF2_HEADERS,
      "access-control-allow-origin": origin,
      vary: "Origin",
    });
  }
  return c.body(ksTestMonoWoff2, 200, WOFF2_HEADERS);
});

const percentEncodedFontUri = Array.from(
  new Uint8Array(ksTestMonoWoff2),
  (byte) => "%" + byte.toString(16).padStart(2, "0"),
).join("");
const webfontPage = webfontHtml.replace(
  "__KS_PCT_URI__",
  `data:font/woff2,${percentEncodedFontUri}`,
);
fonts.all("/webfont.html", (c) => c.html(webfontPage));

fonts.all("/shaping-metrics.html", (c) =>
  c.html(
    c.req.query("canvas") === "1"
      ? shapingMetricsHtml.replace("</body>", '<canvas width="10" height="10"></canvas></body>')
      : shapingMetricsHtml,
  ),
);
