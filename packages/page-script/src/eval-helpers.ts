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
const MAX_ANCHOR_WRAPPER_AREA_RATIO = 4;

function parentElementOf(element: ShimElement): ShimElement | null {
  return (element.parentNode as ShimElement | null) || element.parentElement || null;
}

function isAnchorElement(element: ShimElement): boolean {
  const name = element.tagName;
  return typeof name === "string" && name.toUpperCase() === "A";
}

export function findAnchorAncestor(el: ShimElement | null): ShimElement | null {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    if (isAnchorElement(currentElement)) return currentElement;
    currentElement = parentElementOf(currentElement);
  }
  return null;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function unnamespacedAnchorHref(anchor: ShimElement): string | null {
  return anchor.getAttribute?.("href") ?? null;
}

function xlinkAnchorHref(anchor: ShimElement): string | null {
  return anchor.getAttribute?.("xlink:href") ?? null;
}

export function anchorHrefAttribute(anchor: ShimElement): string | null {
  const href = unnamespacedAnchorHref(anchor);
  if (href !== null) return href;
  if (anchor.namespaceURI !== SVG_NAMESPACE) return href;
  return xlinkAnchorHref(anchor);
}

function tagNameOf(element: ShimElement): string {
  return typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
}

function isFormControlTag(tag: string): boolean {
  switch (tag) {
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
    case "BUTTON":
      return true;
    default:
      return false;
  }
}

function hasDisabledAttribute(element: ShimElement): boolean {
  return !!element.hasAttribute && element.hasAttribute("disabled");
}

function isFocusableAnchor(element: ShimElement, tag: string): boolean {
  return tag === "A" && !!element.hasAttribute && element.hasAttribute("href");
}

function hasContentEditableValue(value: string | null): boolean {
  return value != null && value.toLowerCase() !== "false";
}

function hasNonnegativeTabIndex(value: string | null): boolean {
  if (value == null) return false;
  const index = parseInt(value, 10);
  return Number.isFinite(index) && index >= 0;
}

function hasFocusableAttribute(element: ShimElement): boolean {
  if (!element.getAttribute) return false;
  if (hasContentEditableValue(element.getAttribute("contenteditable"))) return true;
  return hasNonnegativeTabIndex(element.getAttribute("tabindex"));
}

function isFocusableElement(element: ShimElement, tag: string): boolean {
  if (isFormControlTag(tag)) return !hasDisabledAttribute(element);
  if (isFocusableAnchor(element, tag)) return true;
  return hasFocusableAttribute(element);
}

export function findFocusableAncestor(el: ShimElement | null): ShimElement | null {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    if (isFocusableElement(currentElement, tagNameOf(currentElement))) return currentElement;
    currentElement = parentElementOf(currentElement);
  }
  return null;
}

function isInteractiveTag(tag: string): boolean {
  return tag === "BUTTON" || tag === "SUMMARY";
}

function isInteractiveRole(role: string): boolean {
  switch (role.toLowerCase()) {
    case "button":
    case "tab":
    case "link":
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
    case "switch":
    case "checkbox":
    case "radio":
    case "option":
      return true;
    default:
      return false;
  }
}

function hasInteractiveRole(element: ShimElement): boolean {
  if (!element.getAttribute) return false;
  const role = element.getAttribute("role");
  return !!role && isInteractiveRole(role);
}

function hasInteractiveNonAnchorAncestor(el: ShimElement | null): boolean {
  let currentElement: ShimElement | null = el;
  for (let i = 0; currentElement && i < INPUT_ANCESTOR_DEPTH; i++) {
    if (isInteractiveTag(tagNameOf(currentElement))) return true;
    if (hasInteractiveRole(currentElement)) return true;
    currentElement = parentElementOf(currentElement);
  }
  return false;
}

function isExcludedAnchorTarget(element: ShimElement | null): boolean {
  if (!element) return false;
  const tag = tagNameOf(element);
  if (isExcludedAnchorTag(tag)) return true;
  if (hasLabeledTarget(element, tag)) return true;
  return typeof element.isContentEditable === "boolean" && element.isContentEditable;
}

function isExcludedAnchorTag(tag: string): boolean {
  switch (tag) {
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
    case "OPTION":
    case "BUTTON":
      return true;
    default:
      return false;
  }
}

function hasLabeledTarget(element: ShimElement, tag: string): boolean {
  return tag === "LABEL" && !!(element.getAttribute && element.getAttribute("for"));
}

function hasPositiveRectArea(rect: DomRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function containsHorizontalPoint(rect: DomRect, px: number): boolean {
  return px >= rect.left && px <= rect.right;
}

function containsVerticalPoint(rect: DomRect, py: number): boolean {
  return py >= rect.top && py <= rect.bottom;
}

function rectContains(rect: DomRect | null | undefined, px: number, py: number): boolean {
  return (
    !!rect &&
    hasPositiveRectArea(rect) &&
    containsHorizontalPoint(rect, px) &&
    containsVerticalPoint(rect, py)
  );
}

function rectArea(rect: DomRect | null | undefined): number {
  return rect && rect.width > 0 && rect.height > 0 ? rect.width * rect.height : 0;
}

function hasUsableHref(anchor: ShimElement): boolean {
  const href = anchorHrefAttribute(anchor);
  return !!href && href !== "" && !/^javascript:/i.test(href);
}

function directAnchorAtPoint(anchor: ShimElement, x: number, y: number): boolean {
  if (!anchor.getBoundingClientRect) return false;
  if (!rectContains(anchor.getBoundingClientRect(), x, y)) return false;
  return hasUsableHref(anchor);
}

function findDirectAnchor(
  anchors: ArrayLike<ShimElement>,
  x: number,
  y: number,
): ShimElement | null {
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index];
    if (anchor && directAnchorAtPoint(anchor, x, y)) return anchor;
  }
  return null;
}

interface WrapperRects {
  parentRect: DomRect | null;
  anchorRect: DomRect | null;
}

function wrapperParent(anchor: ShimElement): ShimElement | null {
  return (anchor.parentElement as ShimElement | null) || (anchor.parentNode as ShimElement | null);
}

function wrapperRects(anchor: ShimElement, x: number, y: number): WrapperRects | null {
  const parent = wrapperParent(anchor);
  if (!parent || !parent.getBoundingClientRect || !anchor.getBoundingClientRect) return null;
  const parentRect = parent.getBoundingClientRect();
  if (!rectContains(parentRect, x, y)) return null;
  return { parentRect, anchorRect: anchor.getBoundingClientRect() };
}

function wrapperAnchorAtPoint(anchor: ShimElement, x: number, y: number): boolean {
  const rects = wrapperRects(anchor, x, y);
  if (!rects) return false;
  const anchorArea = rectArea(rects.anchorRect);
  const parentArea = rectArea(rects.parentRect);
  if (anchorArea <= 0 || parentArea > anchorArea * MAX_ANCHOR_WRAPPER_AREA_RATIO) return false;
  return hasUsableHref(anchor);
}

function findWrapperAnchor(
  anchors: ArrayLike<ShimElement>,
  x: number,
  y: number,
): ShimElement | null {
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index];
    if (anchor && wrapperAnchorAtPoint(anchor, x, y)) return anchor;
  }
  return null;
}

function findAnchorInSubtree(element: ShimElement, x: number, y: number): ShimElement | null {
  if (!element.querySelectorAll) return null;
  // `[href]` excludes namespaced SVG hrefs, so include `*|`; anchorHrefAttribute
  // still ignores namespaced hrefs on HTML anchors.
  const anchors = element.querySelectorAll("a[*|href]");
  if (!anchors || anchors.length === 0) return null;
  const direct = findDirectAnchor(anchors, x, y);
  if (direct) return direct;
  return findWrapperAnchor(anchors, x, y);
}

export function findAnchorViaSingleChild(
  targetEl: ShimElement | null,
  x: number,
  y: number,
): ShimElement | null {
  if (!isAnchorSearchTarget(targetEl)) return null;
  return findAnchorInAncestors(targetEl, x, y);
}

function isAnchorSearchTarget(targetEl: ShimElement | null): boolean {
  return !isExcludedAnchorTarget(targetEl) && !hasInteractiveNonAnchorAncestor(targetEl);
}

function findAnchorInAncestors(
  targetEl: ShimElement | null,
  x: number,
  y: number,
): ShimElement | null {
  let currentElement: ShimElement | null = targetEl;
  for (let i = 0; currentElement && i < ANCHOR_SEARCH_DEPTH; i++) {
    const anchor = findAnchorInSubtree(currentElement, x, y);
    if (anchor) return anchor;
    currentElement = parentElementOf(currentElement);
  }
  return null;
}

export interface RunExpressionOpts {
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export type RunExpressionResult = EvalResult;

interface BoaResultEnvelope {
  k: string;
  j?: string;
  v?: string;
  d?: string;
  message?: string;
  name?: string;
}

type BoaResultPacker = (envelope: BoaResultEnvelope) => EvalResultBody;

function packBoaThrown(envelope: BoaResultEnvelope): EvalResultBody {
  const error = new Error(envelope.message || "boa error");
  if (envelope.name) error.name = envelope.name;
  return packException(error);
}

function packBoaBigInt(envelope: BoaResultEnvelope): EvalResultBody {
  try {
    return packResult(BigInt(envelope.v as string), true);
  } catch {
    return packResult(envelope.v, true);
  }
}

function packBoaFunction(envelope: BoaResultEnvelope): EvalResultBody {
  const syntheticFunction = function boaFunction(): void {};
  try {
    syntheticFunction.toString = () => envelope.d || "function () { [boa] }";
  } catch {}
  return packResult(syntheticFunction, true);
}

function packBoaJsonValue(envelope: BoaResultEnvelope): EvalResultBody {
  let value: unknown = null;
  try {
    value = JSON.parse(envelope.j as string);
  } catch {
    value = null;
  }
  return packResult(value, true);
}

const BOA_RESULT_PACKERS = new Map<string, BoaResultPacker>([
  ["throw", packBoaThrown],
  ["undef", () => packResult(undefined, true)],
  ["big", packBoaBigInt],
  ["sym", (envelope) => packResult(Symbol(envelope.d || ""), true)],
  ["fn", packBoaFunction],
]);

function packParsedBoaResult(envelope: BoaResultEnvelope): EvalResultBody {
  const packer = BOA_RESULT_PACKERS.get(envelope.k);
  return packer ? packer(envelope) : packBoaJsonValue(envelope);
}

export function packBoaResult(raw: unknown, returnByValue: boolean): EvalResultBody {
  if (!returnByValue) return packResult(raw, false);
  let envelope: BoaResultEnvelope;
  try {
    envelope = JSON.parse(String(raw));
  } catch {
    return packResult(raw, true);
  }
  return packParsedBoaResult(envelope);
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
  const expr = expressionSource(expression);
  let result: EvalResultBody;
  try {
    const { value } = await evaluateExpressionValue(expr, awaitPromise);
    result = packResult(value, returnByValue);
  } catch (error) {
    result = isNativeEvalCodeGenerationError(error)
      ? await boaEvalFallback(expr, awaitPromise, returnByValue)
      : packException(error);
  }
  return drainEvalResult(result);
}

function expressionSource(expression: string): string {
  return typeof expression === "string" ? expression : "undefined";
}

function isThenable(value: unknown): boolean {
  return value !== null && typeof (value as { then?: unknown })?.then === "function";
}

async function evaluateExpressionValue(
  expression: string,
  awaitPromise: boolean,
): Promise<{ value: unknown }> {
  let value: unknown;
  if (/\bawait\b/.test(expression)) {
    const asyncFunction = new AsyncFunction("return (" + expression + ");");
    value = await asyncFunction();
  } else {
    value = NATIVE_INDIRECT_EVAL(expression);
  }
  if (awaitPromise && isThenable(value)) value = await (value as Promise<unknown>);
  return { value };
}

function isNativeEvalCodeGenerationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== "EvalError") return false;
  if (typeof error.message !== "string") return false;
  return error.message.includes("Code generation from strings disallowed");
}
