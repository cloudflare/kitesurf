// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { applyTtyNavParams, TTY_CELL_PX_MAX, type TtyNavState } from "../src/tty/nav-params.ts";

function apply(
  url: string,
  state: TtyNavState = {},
): { state: TtyNavState; url: string; seen: boolean } {
  const u = new URL(url);
  const seen = applyTtyNavParams(u.searchParams, state);
  return { state, url: u.toString(), seen };
}

describe("applyTtyNavParams", () => {
  it("leaves the URL and the state alone when no flag is present", () => {
    const before: TtyNavState = { ttyUaCss: 2, ttyCellW: 7, ttyCellH: 15, darkColorScheme: true };
    const r = apply("https://example.com/a?b=1#f", { ...before });
    expect(r.seen).toBe(false);
    expect(r.url).toBe("https://example.com/a?b=1#f");
    expect(r.state).toEqual(before);
  });

  it("strips its own flags and keeps everyone else's", () => {
    const r = apply(
      "https://example.com/?ks_tty_css=1&q=x&ks_color_scheme=dark&ks_tty_cell=8x17&page=2",
    );
    expect(r.seen).toBe(true);
    expect(r.url).toBe("https://example.com/?q=x&page=2");
  });

  it("ks_tty_css takes level 1 or 2 and clamps above", () => {
    expect(apply("https://e.com/?ks_tty_css=1").state.ttyUaCss).toBe(1);
    expect(apply("https://e.com/?ks_tty_css=2").state.ttyUaCss).toBe(2);
    expect(apply("https://e.com/?ks_tty_css=7").state.ttyUaCss).toBe(2);
    expect(apply("https://e.com/?ks_tty_css=1.9").state.ttyUaCss).toBe(1);
  });

  it("ks_tty_css=0 (or nonsense) turns the mode off", () => {
    for (const v of ["0", "-1", "abc", ""]) {
      const r = apply(`https://e.com/?ks_tty_css=${v}`, { ttyUaCss: 2 });
      expect(r.state.ttyUaCss, `value ${JSON.stringify(v)}`).toBeUndefined();
      expect(r.seen).toBe(true);
    }
  });

  it("ks_color_scheme=dark emulates dark; anything else restores the default", () => {
    expect(apply("https://e.com/?ks_color_scheme=dark").state.darkColorScheme).toBe(true);
    expect(
      apply("https://e.com/?ks_color_scheme=light", { darkColorScheme: true }).state
        .darkColorScheme,
    ).toBeUndefined();
    expect(
      apply("https://e.com/?ks_color_scheme=", { darkColorScheme: true }).state.darkColorScheme,
    ).toBeUndefined();
  });

  it("ks_tty_cell=WxH sets the cell, fractions included", () => {
    expect(apply("https://e.com/?ks_tty_cell=8x17").state).toMatchObject({
      ttyCellW: 8,
      ttyCellH: 17,
    });
    expect(apply("https://e.com/?ks_tty_cell=7.5x15.5").state).toMatchObject({
      ttyCellW: 7.5,
      ttyCellH: 15.5,
    });
  });

  it("ks_tty_cell has a way back to the default cell", () => {
    for (const v of ["0", "", "8", "8x", "axb"]) {
      const r = apply(`https://e.com/?ks_tty_cell=${v}`, { ttyCellW: 7, ttyCellH: 15 });
      expect(r.state.ttyCellW, `value ${JSON.stringify(v)}`).toBeUndefined();
      expect(r.state.ttyCellH, `value ${JSON.stringify(v)}`).toBeUndefined();
      expect(r.seen).toBe(true);
    }
  });

  it("ks_tty_cell refuses a cell the renderer would refuse", () => {
    const tooBig = `${TTY_CELL_PX_MAX + 1}x17`;
    expect(
      apply(`https://e.com/?ks_tty_cell=${tooBig}`, { ttyCellW: 7, ttyCellH: 15 }).state.ttyCellW,
    ).toBeUndefined();
    expect(apply("https://e.com/?ks_tty_cell=0x17").state.ttyCellW).toBeUndefined();
    expect(
      apply(`https://e.com/?ks_tty_cell=${TTY_CELL_PX_MAX}x${TTY_CELL_PX_MAX}`).state,
    ).toMatchObject({
      ttyCellW: TTY_CELL_PX_MAX,
      ttyCellH: TTY_CELL_PX_MAX,
    });
  });

  it("is a session mode: a later navigate without flags keeps it", () => {
    const state: TtyNavState = {};
    apply("https://e.com/?ks_tty_css=2&ks_color_scheme=dark&ks_tty_cell=8x17", state);
    apply("https://e.com/next", state);
    expect(state).toEqual({ ttyUaCss: 2, darkColorScheme: true, ttyCellW: 8, ttyCellH: 17 });
    apply("https://e.com/off?ks_tty_css=0", state);
    expect(state.ttyUaCss).toBeUndefined();
    expect(state).toMatchObject({ darkColorScheme: true, ttyCellW: 8, ttyCellH: 17 });
  });
});
