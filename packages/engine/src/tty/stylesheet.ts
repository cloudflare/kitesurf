// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds terminal user-agent and focus stylesheets from cell dimensions.

import baseCss from "./stylesheet.css";
import level2Css from "./stylesheet-level2.css";
import focusCss from "./focus.css";
import { DEFAULT_TTY_CELL_WIDTH_PX } from "./nav-params.ts";

export const ttyFocusStylesheet = focusCss;

export function ttyUaStylesheet(
  level: number,
  cellH: number,
  cellW = DEFAULT_TTY_CELL_WIDTH_PX,
): string {
  const runtimeProperties = `:root {
  --ks-tty-font-px: {{FONT_PX}}px !important;
  --ks-tty-cell-w: ${cellW}px !important;
  --ks-tty-cell-h: ${cellH}px !important;
}`;
  const css = `${baseCss}\n${runtimeProperties}`;
  return level >= 2 ? `${css}\n${level2Css}` : css;
}
