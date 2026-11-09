// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs CDP expressions through the native probe or Boa fallback and packs the result.

import { packException, packResult } from "./pack.ts";
import { ks_eval_cdp } from "./wasm-glue.js";
import type { EvalResult } from "@kitesurf/jsrpc-types/page-script";
import { drainEvalResult, type EvalResultBody } from "./eval-results.ts";
import type { DomRect, ShimElement } from "./types.ts";

// Native eval is only a probe; workerd's code-generation EvalError falls back to Boa.
const NATIVE_INDIRECT_EVAL: (source: string) => unknown = globalThis.eval;

export const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export const SyncFunction = function () {}.constructor as new (
  ...args: string[]
) => (...args: unknown[]) => unknown;

const INPUT_ANCESTOR_DEPTH = 32;
const ANCHOR_SEARCH_DEPTH = 8;

export function findAnchorAncestor(el: ShimElement | null): ShimElement | null {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    const name = currentElement.tagName;
    if (typeof name === "string" && name.toUpperCase() === "A") return currentElement;
    currentElement =
      (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
  }
  return null;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The link under (`x`, `y`) inside an inline `<svg>` target. Inline SVG paints from a snapshot,
 * so hit testing stops at the `<svg>` and never reaches the shape inside a link. Later links
 * paint on top, so they are checked first.
 */
export function findSvgAnchorAtPoint(
  targetEl: ShimElement | null,
  x: number,
  y: number,
): ShimElement | null {
  if (!targetEl || targetEl.namespaceURI !== SVG_NAMESPACE || targetEl.tagName !== "svg") {
    return null;
  }
  // `[href]` matches only a no-namespace href (Selectors 3 §6.3.4); `*|` also finds xlink:href.
  const anchors = targetEl.querySelectorAll?.("a[*|href]");
  if (!anchors) return null;
  for (let k = anchors.length - 1; k >= 0; k--) {
    const anchor = anchors[k];
    const rect = anchor.getBoundingClientRect?.();
    if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return anchor;
    }
  }
  return null;
}

export function anchorHrefAttribute(anchor: ShimElement): string | null {
  const href = anchor.getAttribute?.("href") ?? null;
  if (href !== null || anchor.namespaceURI !== SVG_NAMESPACE) return href;
  return anchor.getAttribute?.("xlink:href") ?? null;
}

/**
 * A link whose own box is under (`x`, `y`) among the children of an ancestor of the hit target.
 * Hit testing returns the nearest painted box, so a link that wraps across lines can be missed
 * when its bounding rect's centre lands on the surrounding text; its bounding rect is the union
 * of its line boxes, so containment still finds it. A link merely near the click is not a hit.
 */
export function findAnchorViaSingleChild(
  targetEl: ShimElement | null,
  x: number,
  y: number,
): ShimElement | null {
  if (targetEl) {
    const tag = typeof targetEl.tagName === "string" ? targetEl.tagName.toUpperCase() : "";
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "OPTION" ||
      tag === "BUTTON" ||
      (tag === "LABEL" && !!(targetEl.getAttribute && targetEl.getAttribute("for"))) ||
      (typeof targetEl.isContentEditable === "boolean" && targetEl.isContentEditable)
    ) {
      return null;
    }
  }
  if (hasInteractiveNonAnchorAncestor(targetEl)) return null;

  const rectContains = (rect: DomRect | null | undefined, px: number, py: number) =>
    !!rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    px >= rect.left &&
    px <= rect.right &&
    py >= rect.top &&
    py <= rect.bottom;
  let currentElement: ShimElement | null = targetEl;
  for (let i = 0; currentElement && i < ANCHOR_SEARCH_DEPTH; i++) {
    if (currentElement.querySelectorAll) {
      // `[href]` matches only a no-namespace href (Selectors 3 §6.3.4), so an
      // SVG <a> with only xlink:href needs `*|`. anchorHrefAttribute still
      // ignores namespaced hrefs on HTML anchors.
      const anchors = currentElement.querySelectorAll("a[*|href]");
      if (!anchors || anchors.length === 0) {
        currentElement =
          (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
        continue;
      }
      for (let k = 0; k < anchors.length; k++) {
        const anchor = anchors[k];
        if (!anchor.getBoundingClientRect) continue;
        const rect = anchor.getBoundingClientRect();
        if (!rectContains(rect, x, y)) continue;
        const href = anchorHrefAttribute(anchor);
        if (href && href !== "" && !/^javascript:/i.test(href)) return anchor;
      }
    }
    currentElement =
      (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
  }
  return null;
}

function hasInteractiveNonAnchorAncestor(el: ShimElement | null): boolean {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    const tag =
      typeof currentElement.tagName === "string" ? currentElement.tagName.toUpperCase() : "";
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (currentElement.getAttribute) {
      const role = currentElement.getAttribute("role");
      if (role) {
        const name = role.toLowerCase();
        if (
          name === "button" ||
          name === "tab" ||
          name === "link" ||
          name === "menuitem" ||
          name === "menuitemcheckbox" ||
          name === "menuitemradio" ||
          name === "switch" ||
          name === "checkbox" ||
          name === "radio" ||
          name === "option"
        ) {
          return true;
        }
      }
    }
    currentElement =
      (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
  }
  return false;
}

export function findFocusableAncestor(el: ShimElement | null): ShimElement | null {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    const tag =
      typeof currentElement.tagName === "string" ? currentElement.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") {
      if (currentElement.hasAttribute && currentElement.hasAttribute("disabled")) {
        currentElement =
          (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
        continue;
      }
      return currentElement;
    }
    if (tag === "A" && currentElement.hasAttribute && currentElement.hasAttribute("href"))
      return currentElement;
    if (currentElement.getAttribute) {
      const contentEditable = currentElement.getAttribute("contenteditable");
      if (contentEditable != null && contentEditable.toLowerCase() !== "false")
        return currentElement;
      const tabIndex = currentElement.getAttribute("tabindex");
      if (tabIndex != null) {
        const value = parseInt(tabIndex, 10);
        if (Number.isFinite(value) && value >= 0) return currentElement;
      }
    }
    currentElement =
      (currentElement.parentNode as ShimElement | null) || currentElement.parentElement || null;
  }
  return null;
}

export interface RunExpressionOpts {
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export type RunExpressionResult = EvalResult;

export function packBoaResult(raw: unknown, returnByValue: boolean): EvalResultBody {
  if (!returnByValue) return packResult(raw, false);
  let envelope: {
    k: string;
    j?: string;
    v?: string;
    d?: string;
    message?: string;
    name?: string;
  };
  try {
    envelope = JSON.parse(String(raw));
  } catch {
    return packResult(raw, true);
  }
  switch (envelope.k) {
    case "throw": {
      const error = new Error(envelope.message || "boa error");
      if (envelope.name) error.name = envelope.name;
      return packException(error);
    }
    case "undef":
      return packResult(undefined, true);
    case "big":
      try {
        return packResult(BigInt(envelope.v as string), true);
      } catch {
        return packResult(envelope.v, true);
      }
    case "sym":
      return packResult(Symbol(envelope.d || ""), true);
    case "fn": {
      const syntheticFunction = function boaFunction(): void {};
      try {
        syntheticFunction.toString = () => envelope.d || "function () { [boa] }";
      } catch {}
      return packResult(syntheticFunction, true);
    }
    default: {
      let value: unknown = null;
      try {
        value = JSON.parse(envelope.j as string);
      } catch {
        value = null;
      }
      return packResult(value, true);
    }
  }
}

export async function boaEvalFallback(
  expression: string,
  awaitPromise: boolean | undefined,
  returnByValue: boolean,
): Promise<EvalResultBody> {
  try {
    const boaResult = await ks_eval_cdp(expression, awaitPromise !== false, returnByValue);
    return packBoaResult(boaResult, returnByValue);
  } catch (error) {
    return packException(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function runExpression(
  expression: string,
  options: RunExpressionOpts,
): Promise<RunExpressionResult> {
  const returnByValue = !!options?.returnByValue;
  const awaitPromise = options === undefined ? true : options.awaitPromise !== false;
  let result: EvalResultBody;
  try {
    const expr = typeof expression === "string" ? expression : "undefined";
    const hasTopLevelAwait = /\bawait\b/.test(expr);
    let value: unknown;
    if (!hasTopLevelAwait) {
      value = NATIVE_INDIRECT_EVAL(expr);
      if (
        awaitPromise &&
        value !== null &&
        typeof (value as { then?: unknown })?.then === "function"
      ) {
        value = await (value as Promise<unknown>);
      }
    } else {
      const asyncFunction = new AsyncFunction("return (" + expr + ");");
      value = await asyncFunction();
      if (
        awaitPromise &&
        value !== null &&
        typeof (value as { then?: unknown })?.then === "function"
      ) {
        value = await (value as Promise<unknown>);
      }
    }
    result = packResult(value, returnByValue);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "EvalError" &&
      typeof error.message === "string" &&
      error.message.includes("Code generation from strings disallowed")
    ) {
      result = await boaEvalFallback(
        typeof expression === "string" ? expression : "undefined",
        awaitPromise,
        returnByValue,
      );
    } else {
      result = packException(error);
    }
  }
  return drainEvalResult(result);
}
