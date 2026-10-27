// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Supplies document.currentScript values while PageScript runs classic scripts.

import { getInternalState } from "./internal-state.js";
import { ELEMENT_NODE } from "./constants.js";

const syntheticScriptCache: Map<string, Record<string, unknown>> = new Map();

export function getOrMakeSyntheticScript(src: string, rawSrc?: string): Record<string, unknown> {
  const attrSrc = typeof rawSrc === "string" && rawSrc.length > 0 ? rawSrc : src;
  const cached = syntheticScriptCache.get(src);
  if (cached) return cached;
  const el: Record<string, unknown> = {
    tagName: "SCRIPT",
    nodeName: "SCRIPT",
    nodeType: ELEMENT_NODE,
    src,
    type: "",
    async: false,
    defer: false,
    text: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    parentElement: null,
    parentNode: null,
    ownerDocument: null,
    children: [],
    childNodes: [],
    getAttribute(name: string): string | null {
      if (name === "src") return attrSrc || null;
      return null;
    },
    hasAttribute(name: string): boolean {
      return name === "src" && !!attrSrc;
    },
    hasAttributes(): boolean {
      return !!attrSrc;
    },
    getAttributeNames(): string[] {
      return attrSrc ? ["src"] : [];
    },
    setAttribute() {},
    removeAttribute() {},
  };
  syntheticScriptCache.set(src, el);
  return el;
}

export function installCurrentScriptHook(): void {
  const cs = getInternalState();
  if (typeof cs.setCurrentScript === "function") return;
  cs.setCurrentScript = (src: unknown, domIndex?: unknown, bodyKey?: unknown, rawSrc?: unknown) => {
    if (src === null || src === undefined) {
      cs.currentScriptSrc = undefined;
      cs.currentScriptDomIndex = undefined;
      cs.currentScriptBodyKey = undefined;
      cs.currentScriptRawSrc = undefined;
    } else {
      cs.currentScriptSrc = String(src);
      cs.currentScriptDomIndex =
        typeof domIndex === "number" && domIndex >= 0 ? domIndex : undefined;
      cs.currentScriptBodyKey =
        typeof bodyKey === "string" && bodyKey.length > 0 ? bodyKey : undefined;
      cs.currentScriptRawSrc =
        typeof rawSrc === "string" && rawSrc.length > 0 ? String(rawSrc) : undefined;
    }
  };
}
