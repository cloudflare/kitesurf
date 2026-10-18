// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("matchmedia-demo", async ({ page }) => {
  await page.goto("data:text/html,<!doctype html><html><body>x</body></html>", {
    waitUntil: "load",
  });

  const r = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const m = (q) => window.matchMedia(q).matches;
    return {
      w,
      h,
      minBelow: m(`(min-width: ${w - 100}px)`),
      minAt: m(`(min-width: ${w}px)`),
      minAbove: m(`(min-width: ${w + 100}px)`),
      maxBelow: m(`(max-width: ${w - 100}px)`),
      maxAbove: m(`(max-width: ${w + 100}px)`),
      heightMin: m(`(min-height: 1px)`),
      landscape: m("(orientation: landscape)"),
      portrait: m("(orientation: portrait)"),
      light: m("(prefers-color-scheme: light)"),
      dark: m("(prefers-color-scheme: dark)"),
      noMotion: m("(prefers-reduced-motion: no-preference)"),
      reduceMotion: m("(prefers-reduced-motion: reduce)"),
      hoverYes: m("(hover: hover)"),
      hoverNo: m("(hover: none)"),
      pointerFine: m("(pointer: fine)"),
      pointerCoarse: m("(pointer: coarse)"),
      res1dppx: m("(min-resolution: 1dppx)"),
      res2dppx: m("(min-resolution: 2dppx)"),
      screen: m("screen"),
      print: m("print"),
      notScreen: m("not screen"),
      andTrue: m(`screen and (min-width: 1px)`),
      andFalse: m(`screen and (min-width: ${w + 100}px)`),
      orTrue: m(`(min-width: ${w + 100}px), (min-width: 1px)`),
      orFalse: m(`(min-width: ${w + 100}px), (min-width: ${w + 200}px)`),
      notInverts: m(`not (min-width: ${w + 100}px)`),
      bogus: m("(this-feature-does-not-exist: 42)"),
      empty: m(""),
      hasMatches: typeof window.matchMedia("screen").matches === "boolean",
      mediaText: window.matchMedia("(min-width: 100px)").media,
      canAddListener: typeof window.matchMedia("screen").addEventListener === "function",
    };
  });

  console.log(`viewport ${r.w}x${r.h}`);
  expect(r.minBelow, "(min-width: w-100) matches").toBeTruthy();
  expect(r.minAt, "(min-width: w) matches").toBeTruthy();
  expect(!r.minAbove, "(min-width: w+100) does not match").toBeTruthy();
  expect(!r.maxBelow, "(max-width: w-100) does not match").toBeTruthy();
  expect(r.maxAbove, "(max-width: w+100) matches").toBeTruthy();
  expect(r.heightMin, "(min-height: 1px) matches").toBeTruthy();
  const expectedLandscape = r.w >= r.h;
  expect(
    r.landscape === expectedLandscape,
    `(orientation: landscape) matches viewport ratio (${expectedLandscape})`,
  ).toBeTruthy();
  expect(r.portrait === !expectedLandscape, "(orientation: portrait) is the inverse").toBeTruthy();
  expect(r.light && !r.dark, "(prefers-color-scheme) defaults to light").toBeTruthy();
  expect(
    r.noMotion && !r.reduceMotion,
    "(prefers-reduced-motion) defaults to no-preference",
  ).toBeTruthy();
  expect(r.hoverYes && !r.hoverNo, "(hover) defaults to hover").toBeTruthy();
  expect(r.pointerFine && !r.pointerCoarse, "(pointer) defaults to fine").toBeTruthy();
  expect(r.res1dppx, "(min-resolution: 1dppx) matches default DPR=1").toBeTruthy();
  expect(!r.res2dppx, "(min-resolution: 2dppx) does not match default DPR=1").toBeTruthy();
  expect(r.screen, "media type 'screen' matches").toBeTruthy();
  expect(!r.print, "media type 'print' does not match").toBeTruthy();
  expect(!r.notScreen, "'not screen' inverts to false").toBeTruthy();
  expect(r.andTrue, "'screen and (min-width: 1px)' matches").toBeTruthy();
  expect(!r.andFalse, "'screen and (min-width: w+100)' does not match").toBeTruthy();
  expect(r.orTrue, "comma-OR with one matching branch matches").toBeTruthy();
  expect(!r.orFalse, "comma-OR with no matching branches does not match").toBeTruthy();
  expect(r.notInverts, "'not (...)' inverts a failing query").toBeTruthy();
  expect(!r.bogus, "unknown feature → false").toBeTruthy();
  expect(r.empty, "empty query → true").toBeTruthy();
  expect(r.hasMatches, "MediaQueryList.matches is boolean").toBeTruthy();
  expect(r.mediaText === "(min-width: 100px)", "MediaQueryList.media echoes input").toBeTruthy();
  expect(r.canAddListener, "MediaQueryList.addEventListener exists").toBeTruthy();
});
