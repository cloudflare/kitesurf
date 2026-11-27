// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Emulation.setEmulatedMedia with prefers-color-scheme must update both CSS
// @media (prefers-color-scheme: ...) rules and window.matchMedia on the live
// document and across navigations.
// https://drafts.csswg.org/mediaqueries-5/#prefers-color-scheme
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const HTML = `<!doctype html><html><head><style>
  #box { background-color: rgb(255, 255, 255); }
  @media (prefers-color-scheme: dark) {
    #box { background-color: rgb(17, 17, 17); }
  }
</style></head><body><div id="box">theme</div></body></html>`;

test("Emulation.setEmulatedMedia applies prefers-color-scheme to CSS and matchMedia", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, HTML, { waitUntil: "load" });
  const readState = () =>
    page.evaluate(() => ({
      bg: getComputedStyle(document.getElementById("box")!).backgroundColor,
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      light: window.matchMedia("(prefers-color-scheme: light)").matches,
    }));

  expect(await readState()).toEqual({
    bg: "rgb(255, 255, 255)",
    dark: false,
    light: true,
  });

  await cdpSession.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  expect(await readState()).toEqual({
    bg: "rgb(17, 17, 17)",
    dark: true,
    light: false,
  });

  await cdpSession.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  expect(await readState()).toEqual({
    bg: "rgb(255, 255, 255)",
    dark: false,
    light: true,
  });

  // Persists across a subsequent navigation.
  await cdpSession.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await setContent(page, HTML, { waitUntil: "load" });
  expect(await readState()).toEqual({
    bg: "rgb(17, 17, 17)",
    dark: true,
    light: false,
  });
});
