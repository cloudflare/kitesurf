// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses terminal style, cell-size, and color-scheme options from navigation URLs.

export interface TtyNavState {
  ttyUaCss?: number;
  ttyCellW?: number;
  ttyCellH?: number;
  darkColorScheme?: boolean;
}

export const TTY_CELL_PX_MIN = 1;
export const TTY_CELL_PX_MAX = 64;
export const DEFAULT_TTY_CELL_WIDTH_PX = 8;
export const DEFAULT_TTY_CELL_HEIGHT_PX = 17;

const PARAMS = ["ks_tty_css", "ks_tty_cell", "ks_color_scheme"] as const;

export function applyTtyNavParams(params: URLSearchParams, state: TtyNavState): boolean {
  let seen = false;

  if (params.has("ks_tty_css")) {
    seen = true;
    const level = Number(params.get("ks_tty_css"));
    state.ttyUaCss =
      Number.isFinite(level) && level > 0 ? Math.min(2, Math.floor(level)) : undefined;
  }

  if (params.has("ks_color_scheme")) {
    seen = true;
    state.darkColorScheme = params.get("ks_color_scheme") === "dark" ? true : undefined;
  }

  if (params.has("ks_tty_cell")) {
    seen = true;
    const cell = parseCell(params.get("ks_tty_cell") ?? "");
    state.ttyCellW = cell?.w;
    state.ttyCellH = cell?.h;
  }

  if (seen) {
    for (const p of PARAMS) params.delete(p);
  }
  return seen;
}

function parseCell(value: string): { w: number; h: number } | undefined {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const inRange = (n: number) => n >= TTY_CELL_PX_MIN && n <= TTY_CELL_PX_MAX;
  return inRange(w) && inRange(h) ? { w, h } : undefined;
}
