// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import baseCss from "../src/tty/stylesheet.css";
import { ttyUaStylesheet } from "../src/tty/stylesheet.ts";

const CELL_H = 19;
const CELL_W = 9;

describe("ttyUaStylesheet", () => {
  it("ships valid defaults for loading directly in a browser", () => {
    expect(baseCss).toContain("--ks-tty-font-px: 13.3333px !important");
    expect(baseCss).toContain("--ks-tty-cell-w: 8px !important");
    expect(baseCss).toContain("--ks-tty-cell-h: 17px !important");
    expect(baseCss).not.toContain("{{");
  });

  it("pins one line box per terminal row", () => {
    const css = ttyUaStylesheet(1, CELL_H, CELL_W);
    expect(css).toContain(`--ks-tty-cell-w: ${CELL_W}px`);
    expect(css).toContain(`--ks-tty-cell-h: ${CELL_H}px`);
    expect(css).toContain("line-height: var(--ks-tty-cell-h) !important");
    expect(css.indexOf("--ks-tty-cell-h: 17px")).toBeLessThan(
      css.indexOf(`--ks-tty-cell-h: ${CELL_H}px`),
    );
    expect(css).not.toContain("{{CELL_H}}");
  });

  it("leaves the font size open for the isolate to substitute", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    expect(css).toContain("--ks-tty-font-px: {{FONT_PX}}px");
    expect(css).toContain("font-size: var(--ks-tty-font-px) !important");
    expect(css.indexOf("--ks-tty-font-px: 13.3333px")).toBeLessThan(
      css.indexOf("--ks-tty-font-px: {{FONT_PX}}px"),
    );
  });

  it("strips what a cell grid cannot represent only at level 2", () => {
    const level1 = ttyUaStylesheet(1, CELL_H);
    const level2 = ttyUaStylesheet(2, CELL_H);
    expect(level1).not.toContain("filter: none !important");
    expect(level1).not.toContain("border-radius: 0 !important");
    expect(level1).not.toContain("writing-mode: horizontal-tb !important");
    expect(level2).toContain("filter: none !important");
    expect(level2).toContain("border-radius: 0 !important");
    expect(level2).toContain("writing-mode: horizontal-tb !important");
  });

  it("preserves text semantics that the terminal renderer supports", () => {
    const css = ttyUaStylesheet(2, CELL_H);
    for (const property of ["font-weight", "font-style", "text-decoration", "text-align"]) {
      expect(css).not.toContain(`${property}:`);
    }
  });

  it("keeps superscripts from expanding terminal line boxes", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    const rule = css.match(/sup,\s*sub\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain("vertical-align: baseline !important");
  });

  it("puts placeholder text on the grid with everything else", () => {
    expect(ttyUaStylesheet(1, CELL_H)).toContain("::placeholder");
  });

  it("clamps a checkable control to one cell without giving it a floor", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    const checkableRule = css.match(
      /input\[type="checkbox"\],\s*input\[type="radio"\]\s*\{([^}]+)\}/,
    )?.[1];
    expect(checkableRule).toContain("max-width: 1ch !important");
    expect(checkableRule).toContain("max-height: 1lh !important");
    expect(checkableRule).toContain("min-width: 0 !important");
    expect(checkableRule).toContain("min-height: 0 !important");
    expect(checkableRule).not.toContain("min-width: 1ch");
    expect(checkableRule).not.toContain("min-height: 1lh");
  });

  it("hides a graphical copy beside a native checkable control", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    expect(css).toContain('input[type="checkbox"] + [class*="icon" i]');
    expect(css).toContain('input[type="radio"] + [class*="icon" i]');
    expect(css).toContain("display: none !important");
    expect(css).toContain('input[type="radio"] ~ label');
    expect(css).toContain("padding-inline-start: 2ch !important");
  });

  it("keeps a toggle-all control clear of its text field", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    expect(css).toContain('input[type="checkbox"][class*="toggle-all" i] + label');
    expect(css).toContain("font-size: 0 !important");
    expect(css).toContain('input[type="checkbox"][class*="toggle-all" i] + label::before');
    expect(css).toContain("content: none !important");
    expect(css).toContain('input:not([type="checkbox"]):not([type="radio"]).new-todo');
    expect(css).toContain("padding-inline-start: 3ch !important");
  });

  it("turns aria-expanded state into disclosure text", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    expect(css).toContain(
      "[aria-expanded],\n[aria-expanded] > * {\n  background: transparent !important",
    );
    expect(css).toContain(
      "[aria-expanded] {\n  transform: none !important;\n  box-shadow: none !important",
    );
    expect(css).toContain(
      "button[aria-expanded] {\n  align-items: center !important;\n" +
        "  display: inline-flex !important",
    );
    expect(css).toContain('[aria-expanded="false"]::before');
    expect(css).toContain('content: "\\25b8" !important');
    expect(css).toContain('[aria-expanded="true"]::before');
    expect(css).toContain('content: "\\25be" !important');
    expect(css.match(/margin-inline-end: 1ch !important/g)).toHaveLength(2);
    expect(css).not.toContain("[aria-controls");
  });

  it("removes solid fallback rectangles from masked icons", () => {
    const css = ttyUaStylesheet(1, CELL_H);
    expect(css).toContain(
      '[class*="icon" i],\n[class*="icon" i]::before,\n' +
        '[class*="icon" i]::after {\n' +
        "  background: transparent !important",
    );
  });

  describe("block rhythm", () => {
    it("states vertical spacing in rows, never in ems", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      const rhythm = css.slice(css.indexOf("margin-block"));
      expect(rhythm).toContain("margin-block: 1lh !important");
      expect(rhythm).not.toMatch(/margin-block:\s*[\d.]+em/);
    });

    it("states indents in columns, never in px", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain("padding-inline-start: 2ch !important");
      expect(css).toContain("padding-inline-start: 3ch !important");
      expect(css).not.toMatch(/padding-inline-start:\s*\d+px/);
    });

    it("covers the elements whose UA margin is em-based", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      for (const tag of ["p", "h1", "h6", "ul", "ol", "blockquote", "pre", "table"]) {
        expect(css).toMatch(new RegExp(`(^|[\\s,])${tag}[\\s,]`, "m"));
      }
    });

    it("does not put a row of air around a nested list", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain("li > ul");
      expect(css.slice(css.indexOf("li > ul"))).toContain("margin-block: 0 !important");
    });

    it("expresses browser spacing defaults in rows and columns", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain("body {\n  margin: 0 !important");
      expect(css).toContain("border-spacing: 0 !important");
      const cellRule = css.match(/td,\s*th\s*\{([^}]+)\}/)?.[1];
      expect(cellRule).toContain("padding-block: 0 !important");
      const verticalBorderRule = css.match(/(\*:not\(table\)[^{]+)\{([^}]+)\}/);
      for (const tag of [
        "table",
        "caption",
        "colgroup",
        "col",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
      ]) {
        expect(verticalBorderRule?.[1]).toMatch(new RegExp(`:not\\(\\s*${tag}\\s*\\)`));
      }
      expect(verticalBorderRule?.[2]).toContain("border-left-width: 0 !important");
      expect(verticalBorderRule?.[2]).toContain("border-right-width: 0 !important");
      expect(css).toContain("th br {");
      expect(css.slice(css.indexOf("th br {"))).toContain("display: inline-block !important");
      expect(css.slice(css.indexOf("th br {"))).toContain("width: 1ch !important");
      expect(css).toContain("padding: 1lh 1ch !important");
      expect(css).toContain("padding-inline: 1ch !important");
    });

    it("removes fractional block spacing from navigation rows", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain('nav *,\n[role="navigation"] *,\naside *');
      expect(css).toContain("padding-block: 0 !important");
      expect(css).toContain('nav [class*="radio" i]');
      expect(css).toContain("margin-block: 0 !important");
      expect(css).toContain("min-height: 1lh !important");
      expect(css).toContain('nav [class*="header" i]');
      expect(css).toContain("height: 1lh !important");
    });

    it("fits single-line controls into one row", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain('input:not([type="checkbox"]):not([type="radio"])');
      expect(css).toContain("height: 1lh !important");
      expect(css).toContain("padding-block: 0 !important");
    });

    it("removes fractional-row heading and caption insets", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain('figcaption,\ncaption,\n[class$="caption" i]');
      expect(css).toContain("padding-block: 0 !important");
      expect(css).not.toMatch(/figure,\nfigcaption,/);
    });

    it("uses whole-cell margins for explicit floats", () => {
      const css = ttyUaStylesheet(1, CELL_H);
      expect(css).toContain('[style*="float: left" i]');
      expect(css).toContain("margin: 0 1ch 0 0 !important");
      expect(css).toContain('[style*="float: right" i]');
      expect(css).toContain("margin: 0 0 0 1ch !important");
    });
  });
});
