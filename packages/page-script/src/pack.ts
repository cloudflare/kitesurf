// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Converts page values and exceptions into bounded CDP result records.

import { mintHandle } from "./handles.ts";
import type { PackedException, PackedResult, PackedResultType } from "@kitesurf/jsrpc-types/shared";

export type ClassifyTag =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "function"
  | "object"
  | "array";

export function classify(value: unknown): ClassifyTag {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "function") return "function";
  if (t === "object") return Array.isArray(value) ? "array" : "object";
  return t as ClassifyTag;
}

export function safeReplacer(): (_key: string, val: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (_key, val) {
    if (typeof val === "bigint") return { __bigint: val.toString() };
    if (typeof val === "function") {
      const name = (val as { name?: string }).name || "anonymous";
      return { __fn: name };
    }
    if (typeof val === "symbol") {
      return { __sym: (val as symbol).description ?? "" };
    }
    if (val instanceof Error) {
      return { __err: { name: val.name, message: val.message, stack: val.stack } };
    }
    if (val !== null && typeof val === "object") {
      if (seen.has(val as object)) return { __circular: true };
      seen.add(val as object);
    }
    return val;
  };
}

export function describe(value: unknown): string | undefined {
  const sub = classify(value);
  if (sub === "string") return undefined;
  if (sub === "boolean") return undefined;
  if (sub === "null") return "null";
  if (sub === "undefined") return "undefined";
  if (sub === "function") {
    const MAX_FUNCTION_DESCRIPTION_CHARS = 200;
    try {
      const text: unknown = (value as { toString(): unknown }).toString();
      return typeof text === "string" ? text.slice(0, MAX_FUNCTION_DESCRIPTION_CHARS) : "function";
    } catch {
      return "function";
    }
  }
  if (sub === "array") {
    const len = (value as { length?: number }).length ?? 0;
    return "Array(" + len + ")";
  }
  if (sub === "object") {
    try {
      if (value instanceof Error) {
        const stack = value.stack;
        if (typeof stack === "string" && stack) return stack;
        const name = value.name;
        const message = value.message;
        return `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : ""}`;
      }
      const ctor = (value as { constructor?: { name?: unknown } }).constructor;
      const name = ctor?.name;
      return typeof name === "string" && name ? name : "Object";
    } catch {
      return "Object";
    }
  }
  return String(value);
}

export const SERIALIZATION_BUDGET_EXCEEDED = Symbol("ks-serialization-budget-exceeded");

export function packResult(
  value: unknown,
  returnByValue: boolean,
  nodeBudget?: number,
): PackedResult {
  const sub = classify(value);
  let className: string | undefined;
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    const fallback = sub === "array" ? "Array" : sub === "function" ? "Function" : "Object";
    try {
      const name: unknown = value.constructor?.name;
      className = typeof name === "string" && name ? name : fallback;
    } catch {
      className = fallback;
    }
  }
  const isPrimitive =
    sub === "string" ||
    sub === "number" ||
    sub === "boolean" ||
    sub === "bigint" ||
    sub === "symbol" ||
    sub === "null" ||
    sub === "undefined";
  const wantValue = isPrimitive || returnByValue;
  let serialized: unknown;
  let serializationError: string | null = null;
  if (wantValue) {
    try {
      const inner = safeReplacer();
      let budgetLeft = nodeBudget ?? Infinity;
      const replacer = (key: string, val: unknown): unknown => {
        if (--budgetLeft < 0) throw SERIALIZATION_BUDGET_EXCEEDED;
        return inner(key, val);
      };
      serialized = JSON.parse(JSON.stringify(value, replacer));
    } catch (err) {
      serializationError =
        err === SERIALIZATION_BUDGET_EXCEEDED
          ? "value exceeds serialization budget"
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
  let objectId: string | undefined;
  if (!returnByValue && (sub === "object" || sub === "function" || sub === "array")) {
    objectId = mintHandle(value);
  }
  const type: PackedResultType = sub === "null" || sub === "array" ? "object" : sub;
  let subtype: "null" | "array" | "error" | undefined;
  if (sub === "null") subtype = "null";
  else if (sub === "array") subtype = "array";
  else if (sub === "object" && value instanceof Error) subtype = "error";
  return {
    ok: true,
    type,
    subtype,
    className,
    description: describe(value),
    valueJson: serialized === undefined ? undefined : JSON.stringify(serialized),
    serializationError,
    objectId,
  };
}

export function packException(err: unknown): PackedException {
  let message: string;
  let stack: string | undefined;
  if (err instanceof Error) {
    message = err.message;
    stack = err.stack;
  } else {
    message = String(err);
  }
  let className = "Error";
  if (err instanceof Error) {
    try {
      const name: unknown = err.constructor?.name;
      if (typeof name === "string" && name) className = name;
    } catch {}
  }
  return {
    ok: false,
    exception: {
      text: "Uncaught",
      message,
      stack: stack || null,
      className,
    },
  };
}
