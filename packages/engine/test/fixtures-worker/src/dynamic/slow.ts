// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono, type Context } from "hono";
import solidRedPng from "../../assets/solid-red.png";
import { intQuery, sleep } from "../util.ts";

export const slow = new Hono();

function trickle(rest: Uint8Array, ms: number, head?: Uint8Array) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head) controller.enqueue(head);
      timer = setTimeout(() => {
        controller.enqueue(rest);
        controller.close();
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}

const delayMs = (c: Context, fallback: number, max: number) =>
  intQuery(c, "ms", { fallback, min: 0, max });

slow.all("/slow-document.html", async (c) => {
  await sleep(delayMs(c, 12_000, 20_000));
  return c.html("<!doctype html><title>Slow document</title><p>arrived</p>");
});

slow.all("/slow-headers-red.png", async (c) => {
  await sleep(delayMs(c, 1500, 5000));
  return c.body(solidRedPng, 200, { "content-type": "image/png" });
});

slow.all("/slow-red.png", (c) =>
  c.body(trickle(new Uint8Array(solidRedPng), delayMs(c, 1500, 5000)), 200, {
    "content-type": "image/png",
  }),
);

const DRIP_HEAD_BYTES = 8;
const RED_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
);
const dripping = (bytes: Uint8Array, contentType: string) => (c: Context) => {
  const body = trickle(
    bytes.slice(DRIP_HEAD_BYTES),
    delayMs(c, 30_000, 60_000),
    bytes.slice(0, DRIP_HEAD_BYTES),
  );
  return c.body(body, 200, { "content-type": contentType });
};
slow.all("/dripping-red.png", dripping(new Uint8Array(solidRedPng), "image/png"));
slow.all("/dripping-red.svg", dripping(RED_SVG, "image/svg+xml"));

slow.all("/slow-iframe-child", async (c) => {
  await sleep(delayMs(c, 600, 3000));
  return c.html('<!doctype html><html><body><p id="slow">slow child</p></body></html>');
});

slow.all("/slow-css", (c) => {
  const css = new TextEncoder().encode("#measured { width: 111px; height: 30px; }");
  return c.body(trickle(css, delayMs(c, 300, 2000)), 200, {
    "content-type": "text/css; charset=utf-8",
  });
});

slow.all("/slow-script", async (c) => {
  await sleep(delayMs(c, 1000, 3000));
  return c.body("window.__slowScriptRan = true;", 200, {
    "content-type": "text/javascript; charset=utf-8",
  });
});
