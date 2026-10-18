// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements progress and meter values, range defaults, and label lookup.

import type * as Idl from "../../idl/types.generated.js";
import { labelsForControl } from "./labelable.js";
import { HTMLElement } from "../html-element.js";

function htmlParseDouble(raw: string): number | null {
  const m = /^[\t\n\f\r ]*([+-]?(?:\d+\.\d+|\d+\.|\.\d+|\d+)(?:[eE][+-]?\d+)?)/.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

class HTMLProgressElement extends HTMLElement implements Idl.HTMLProgressElement {
  get value() {
    const v = this.getAttribute("value");
    if (v == null) return 0;
    const n = htmlParseDouble(v);
    if (n == null || n < 0) return 0;
    return Math.min(n, this.max);
  }
  set value(v) {
    this.setAttribute("value", String(v));
  }
  get max() {
    const v = this.getAttribute("max");
    if (v == null) return 1;
    const n = htmlParseDouble(v);
    if (n == null || n <= 0) return 1;
    return n;
  }
  set max(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    this.setAttribute("max", String(v));
  }
  get position() {
    if (!this.hasAttribute("value")) return -1;
    return this.value / this.max;
  }
  get labels() {
    return labelsForControl(this);
  }
}
class HTMLMeterElement extends HTMLElement implements Idl.HTMLMeterElement {
  get value() {
    const v = this.getAttribute("value");
    const n = v == null ? 0 : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  set value(v) {
    this.setAttribute("value", String(v));
  }
  get min() {
    const v = this.getAttribute("min");
    const n = v == null ? 0 : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  set min(v) {
    this.setAttribute("min", String(v));
  }
  get max() {
    const v = this.getAttribute("max");
    const n = v == null ? 1 : parseFloat(v);
    return Number.isFinite(n) ? n : 1;
  }
  set max(v) {
    this.setAttribute("max", String(v));
  }
  get low() {
    const v = this.getAttribute("low");
    if (v == null) return this.min;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : this.min;
  }
  set low(v) {
    this.setAttribute("low", String(v));
  }
  get high() {
    const v = this.getAttribute("high");
    if (v == null) return this.max;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : this.max;
  }
  set high(v) {
    this.setAttribute("high", String(v));
  }
  get optimum() {
    const v = this.getAttribute("optimum");
    if (v == null) return (this.min + this.max) / 2;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : (this.min + this.max) / 2;
  }
  set optimum(v) {
    this.setAttribute("optimum", String(v));
  }
  get labels() {
    return labelsForControl(this);
  }
}

export { HTMLMeterElement, HTMLProgressElement };
