// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { bigPngBytes } from "../png.ts";
import { intQuery, KIB, MIB } from "../util.ts";

export const bench = new Hono();

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

const IMAGE_SIDE = { fallback: 1024, min: 16, max: 2048 };

const PARAGRAPHS_PER_SECTION = 4;
const ROWS_PER_TABLE = 10;
const ITEMS_PER_LIST = 8;
bench.all("/bench-heavy.html", (c) => {
  const sectionCount = intQuery(c, "sections", { fallback: 40, min: 1, max: 120 });
  const toc = range(sectionCount).map(
    (section) => `<li><a href="#sec${section}">Section ${section}</a></li>`,
  );
  const sections = range(sectionCount).map((section) => {
    const paragraphs = range(PARAGRAPHS_PER_SECTION).map(
      (paragraph) => `<p>Body ${section}.${paragraph}: reference-style prose with <b>emphasis</b>,
  <i>variants</i>, <span class="tag">tag-${section}-${paragraph}</span> and a
  citation-like <a href="#ref${section}">[${section}]</a> marker repeated
  across the section to mimic encyclopedic density.</p>`,
    );
    const rows = range(ROWS_PER_TABLE).map(
      (row) =>
        `<tr><td>r${row}</td><td>${section * 100 + row}</td><td>alpha</td><td>beta</td><td>${(section * row) % 97}</td></tr>`,
    );
    const items = range(ITEMS_PER_LIST).map(
      (item) => `<li>Item ${section}.${item} with <em>inline</em> detail</li>`,
    );
    return `<h2 id="sec${section}">Section ${section}</h2>
${paragraphs.join("\n")}
<table>
<thead><tr><th>row</th><th>id</th><th>a</th><th>b</th><th>mod</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
<ul>
${items.join("\n")}
</ul>`;
  });
  const mutate =
    c.req.query("mutate") === "1"
      ? `<script>
(function () {
  var dark = false;
  setInterval(function () {
    dark = !dark;
    document.body.style.color = dark ? "#111111" : "#222222";
  }, 100);
})();
</script>`
      : "";
  return c.html(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bench heavy ${sectionCount}</title>
<style>
  body { font-family: sans-serif; max-width: 60em; margin: 1em auto; }
  table { border-collapse: collapse; margin: 1em 0; }
  td, th { border: 1px solid #bbb; padding: 2px 8px; font-size: 13px; }
  .tag { background: #eef; border-radius: 3px; padding: 0 4px; }
  h2 { border-bottom: 1px solid #ccc; }
</style>
</head>
<body>
<h1>Scene-record bench: heavy DOM (${sectionCount} sections)</h1>
<ol id="toc">
${toc.join("\n")}
</ol>
${sections.join("\n")}
${mutate}
</body>
</html>`);
});

bench.all("/bench-animate.html", (c) => {
  const boxCount = intQuery(c, "n", { fallback: 60, min: 1, max: 300 });
  return c.html(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bench animate ${boxCount}</title>
<style>
  body { margin: 0; background: #111; overflow: hidden; }
  .b {
    position: absolute; width: 40px; height: 40px; border-radius: 6px;
    color: #fff; font: 10px sans-serif; text-align: center; line-height: 40px;
  }
  #hud { position: absolute; top: 4px; left: 8px; color: #0f0; font: 14px monospace; z-index: 10; }
</style>
</head>
<body>
<div id="hud">tick 0</div>
<script>
(function () {
  var BOX_COUNT = ${boxCount};
  var CENTER_X = 620, CENTER_Y = 340;
  var HUE_STEP = 47;
  var boxes = [];
  for (var i = 0; i < BOX_COUNT; i++) {
    var box = document.createElement("div");
    box.className = "b";
    box.textContent = String(i);
    box.style.background = "hsl(" + ((i * HUE_STEP) % 360) + ",70%,50%)";
    document.body.appendChild(box);
    boxes.push(box);
  }
  var hud = document.getElementById("hud");
  var frame = 0;
  function tick() {
    frame++;
    for (var i = 0; i < BOX_COUNT; i++) {
      var angle = frame / 20 + i * 0.7;
      var radiusX = 120 + (i % 9) * 40;
      var radiusY = 90 + (i % 7) * 30;
      var x = CENTER_X + Math.cos(angle) * radiusX;
      var y = CENTER_Y + Math.sin(angle * 1.3) * radiusY;
      boxes[i].style.left = (x | 0) + "px";
      boxes[i].style.top = (y | 0) + "px";
    }
    hud.textContent = "tick " + frame;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
</script>
</body>
</html>`);
});

bench.all("/big-doc.html", (c) => {
  const rowCount = intQuery(c, "rows", { fallback: 4000, min: 1, max: 40_000 });
  const seed = intQuery(c, "seed", { fallback: 0 });
  const rows = range(rowCount).map(
    (row) =>
      `<p class="r${row}" data-seed="${seed}" data-i="${row}"><span class="a">row ${row}</span> <em>of seed ${seed}</em> <span class="b">lorem ipsum dolor sit amet consectetur</span></p>`,
  );
  return c.html(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>big-doc ${seed}</title>
<style>p { margin: 0; font-size: 12px; } .a { color: #036; } .b { color: #630; }</style>
</head>
<body>
<h1>big-doc ${seed}</h1>
${rows.join("\n")}
</body>
</html>`);
});

bench.all("/big-image.png", async (c) => {
  const png = await bigPngBytes(
    intQuery(c, "side", IMAGE_SIDE),
    intQuery(c, "seed", { fallback: 0 }),
    c.req.query("noise") === "1",
  );
  return c.body(png, 200, { "content-type": "image/png" });
});

bench.all("/image-heavy.html", (c) => {
  const imageCount = intQuery(c, "n", { fallback: 12, min: 1, max: 64 });
  const side = intQuery(c, "side", IMAGE_SIDE);
  const imgs = range(imageCount)
    .map((seed) => `<img id="i${seed}" src="/__fixtures/big-image.png?seed=${seed}&side=${side}">`)
    .join("\n");
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>image-heavy fixture (${imageCount} x ${side}px)</title>
<style>img { display: block; margin: 4px; max-width: 100%; }</style></head>
<body>
<h1>image-heavy: ${imageCount} unique ${side}x${side} images</h1>
${imgs}
</body>
</html>`);
});

const EMOJI_ROWS = 20;
bench.all("/emoji-page.html", (c) => {
  const withEmoji = c.req.query("emoji") !== "0";
  const line = withEmoji ? "😀🎉🚀🔥💯🌍🐙🍕⚽🎸🧭🛰️🦄🌈☕🎨" : "plain text placeholder line";
  const block = range(EMOJI_ROWS)
    .map((row) => `<p>row ${row}: ${line}</p>`)
    .join("\n");
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>emoji-page fixture (emoji=${withEmoji ? 1 : 0})</title></head>
<body>
<h1>emoji-page: ${withEmoji ? "with" : "without"} emoji</h1>
${block}
</body>
</html>`);
});

const BODY_BYTES = { min: 64, max: MIB };

bench.all("/chatty-json", (c) => {
  const bytes = intQuery(c, "bytes", { fallback: 4 * KIB, ...BODY_BYTES });
  const seed = intQuery(c, "seed", { fallback: 0 });
  const head = `{"seed":${seed},"filler":"`;
  const tail = `"}`;
  const fillerLength = Math.max(0, bytes - head.length - tail.length);
  const filler = "ks".repeat(Math.ceil(fillerLength / 2)).slice(0, fillerLength);
  return c.body(head + filler + tail, 200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
});

bench.all("/chatty-xhr.html", (c) => {
  const fetchCount = intQuery(c, "n", { fallback: 50, min: 1, max: 2000 });
  const bytes = intQuery(c, "bytes", { fallback: 200_000, ...BODY_BYTES });
  const lanes = intQuery(c, "conc", { fallback: 4, min: 1, max: 16 });
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>chatty-xhr</title></head>
<body><h1 id="h">chatty</h1>
<script>
window.__done = false;
window.__fetched = 0;
window.__failed = 0;
(function () {
  var FETCH_COUNT = ${fetchCount}, BYTES = ${bytes}, LANES = ${lanes};
  var issued = 0;
  function next() {
    if (issued >= FETCH_COUNT) return Promise.resolve();
    var seed = issued++;
    return fetch("/__fixtures/chatty-json?bytes=" + BYTES + "&seed=" + seed)
      .then(function (res) { return res.text(); })
      .then(function () { window.__fetched++; })
      .catch(function () { window.__failed++; })
      .then(next);
  }
  var lanes = [];
  for (var lane = 0; lane < LANES; lane++) lanes.push(next());
  Promise.all(lanes).then(function () {
    window.__done = true;
    document.getElementById("h").textContent = "done " + window.__fetched;
    var marker = document.createElement("div");
    marker.id = "done";
    document.body.appendChild(marker);
  });
})();
</script>
</body></html>`);
});
