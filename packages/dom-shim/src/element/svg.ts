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
  return svgTotalLength(this);
});

function svgTotalLength(element: Element): number {
  if (!isSvgGeometryElement(element)) {
    throw new TypeError("getTotalLength is only defined on SVG geometry elements");
  }
  return svgLengthForElement(element);
}

function isSvgGeometryElement(element: Element): boolean {
  return (
    isSvgNsElement(element) &&
    SVG_GEOMETRY_LOCALS.has(String(element.localName || "").toLowerCase())
  );
}

function svgLengthForElement(element: Element): number {
  switch (String(element.localName).toLowerCase()) {
    case "circle": {
      return circleLength(element);
    }
    case "ellipse": {
      return ellipseLength(element);
    }
    case "line":
      return lineLength(element);
    case "rect": {
      return rectLength(element);
    }
    case "polyline":
      return polylineLength(parseSvgPoints(svgPointsAttribute(element)), false);
    case "polygon":
      return polylineLength(parseSvgPoints(svgPointsAttribute(element)), true);
    default:
      return 0;
  }
}

function svgNumber(element: Element, name: string, fallback = 0): number {
  const raw = element.getAttribute(name);
  if (raw === null) return fallback;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function circleLength(element: Element): number {
  const radius = svgNumber(element, "r");
  return radius > 0 ? 2 * Math.PI * radius : 0;
}

function ellipseLength(element: Element): number {
  const rx = svgNumber(element, "rx");
  const ry = svgNumber(element, "ry");
  if (rx <= 0 || ry <= 0) return 0;
  const h = ((rx - ry) * (rx - ry)) / ((rx + ry) * (rx + ry));
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function lineLength(element: Element): number {
  return Math.hypot(
    svgNumber(element, "x2") - svgNumber(element, "x1"),
    svgNumber(element, "y2") - svgNumber(element, "y1"),
  );
}

function rectLength(element: Element): number {
  const width = svgNumber(element, "width");
  const height = svgNumber(element, "height");
  return width > 0 && height > 0 ? 2 * (width + height) : 0;
}

function svgPointsAttribute(element: Element): string {
  return String(element.getAttribute("points") || "").trim();
}

function parseSvgPoints(raw: string): Array<[number, number]> {
  if (raw === "") return [];
  const parts = raw.split(/[\s,]+/).map((value: string) => parseFloat(value));
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const x = parts[i];
    const y = parts[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

function polylineLength(points: Array<[number, number]>, close: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  if (close && points.length > 2) {
    total += Math.hypot(
      points[0][0] - points[points.length - 1][0],
      points[0][1] - points[points.length - 1][1],
    );
  }
  return total;
}

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
