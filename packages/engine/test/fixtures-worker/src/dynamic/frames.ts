// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import iframeReferrerHostHtml from "../../assets/iframe-referrer-host.html";
import iframeReferrerNestedHtml from "../../assets/iframe-referrer-nested.html";
import { intQuery, jsonForScript } from "../util.ts";

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
