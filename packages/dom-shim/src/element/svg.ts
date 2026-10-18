// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs shim-side SVG geometry methods and checks each receiver's namespace and tag.

import { Element } from "./element.js";
import { SVG_NS } from "../constants.js";

const SVG_GEOMETRY_LOCALS = new Set([
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
]);
// An HTML element named path must not receive the SVG geometry API.
const isSvgNsElement = (el: Element): boolean => String(el?.namespaceURI || "") === SVG_NS;
// Installed on every Element: there are no SVG element classes (see
// page-script's SVG constructor stubs), so the receiver is checked here.
Reflect.set(Element.prototype, "getTotalLength", function getTotalLength(this: Element) {
  if (
    !isSvgNsElement(this) ||
    !SVG_GEOMETRY_LOCALS.has(String(this.localName || "").toLowerCase())
  ) {
    throw new TypeError("getTotalLength is only defined on SVG geometry elements");
  }
  const num = (name: string, fallback = 0): number => {
    const raw = this.getAttribute(name);
    if (raw === null) return fallback;
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const points = (): Array<[number, number]> => {
    const raw = String(this.getAttribute("points") || "").trim();
    if (raw === "") return [];
    const parts = raw.split(/[\s,]+/).map((v: string) => parseFloat(v));
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const x = parts[i];
      const y = parts[i + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
    return out;
  };
  const polylineLength = (pts: Array<[number, number]>, close: boolean): number => {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    if (close && pts.length > 2) {
      total += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    }
    return total;
  };

  switch (String(this.localName).toLowerCase()) {
    case "circle": {
      const radius = num("r");
      return radius > 0 ? 2 * Math.PI * radius : 0;
    }
    case "ellipse": {
      const rx = num("rx");
      const ry = num("ry");
      if (rx <= 0 || ry <= 0) return 0;
      const h = ((rx - ry) * (rx - ry)) / ((rx + ry) * (rx + ry));
      return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    }
    case "line":
      return Math.hypot(num("x2") - num("x1"), num("y2") - num("y1"));
    case "rect": {
      const width = num("width");
      const height = num("height");
      return width > 0 && height > 0 ? 2 * (width + height) : 0;
    }
    case "polyline":
      return polylineLength(points(), false);
    case "polygon":
      return polylineLength(points(), true);
    default:
      return 0;
  }
});

const SVG_VIEWBOX_LOCALS = new Set(["svg", "symbol", "marker", "pattern", "view"]);
Object.defineProperty(Element.prototype, "viewBox", {
  configurable: true,
  get(this: Element) {
    // Keep this attribute-backed because usvg reads viewBox during its next snapshot.
    if (
      !isSvgNsElement(this) ||
      !SVG_VIEWBOX_LOCALS.has(String(this.localName || "").toLowerCase())
    ) {
      return undefined;
    }
    const el = this;
    const parse = (): number[] => {
      const raw = String(el.getAttribute("viewBox") ?? "");
      const n = raw
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      return n.length === 4 && n.every(Number.isFinite) ? n : [0, 0, 0, 0];
    };
    const write = (i: number, v: unknown) => {
      const n = parse();
      n[i] = Number(v) || 0;
      el.setAttribute("viewBox", n.join(" "));
    };
    const mkRect = () => ({
      get x() {
        return parse()[0];
      },
      set x(v: unknown) {
        write(0, v);
      },
      get y() {
        return parse()[1];
      },
      set y(v: unknown) {
        write(1, v);
      },
      get width() {
        return parse()[2];
      },
      set width(v: unknown) {
        write(2, v);
      },
      get height() {
        return parse()[3];
      },
      set height(v: unknown) {
        write(3, v);
      },
    });
    return { baseVal: mkRect(), animVal: mkRect() };
  },
});
