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

function classifyType(type: string, value: unknown): ClassifyTag {
  if (type === "function") return "function";
  if (type === "object") return Array.isArray(value) ? "array" : "object";
  return type as ClassifyTag;
}

export function classify(value: unknown): ClassifyTag {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return classifyType(typeof value, value);
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

function describeFunction(value: unknown): string {
  const MAX_FUNCTION_DESCRIPTION_CHARS = 200;
  try {
    return (value as { toString(): string }).toString().slice(0, MAX_FUNCTION_DESCRIPTION_CHARS);
  } catch {
    return "function";
  }
}

function describeArray(value: unknown): string {
  const len = (value as { length?: number }).length ?? 0;
  return "Array(" + len + ")";
}

function describeObject(value: unknown): string {
  if (value instanceof Error) return value.stack || value.name + ": " + value.message;
  return describeObjectConstructor(value);
}

function describeObjectConstructor(value: unknown): string {
  try {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    return ctor?.name || "Object";
  } catch {
    return "Object";
  }
}

export function describe(value: unknown): string | undefined {
  const sub = classify(value);
  switch (sub) {
    case "string":
    case "boolean":
      return undefined;
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "function":
      return describeFunction(value);
    case "array":
      return describeArray(value);
    case "object":
      return describeObject(value);
    default:
      return String(value);
  }
}

export const SERIALIZATION_BUDGET_EXCEEDED = Symbol("ks-serialization-budget-exceeded");

function isObjectOrFunction(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function classNameFallback(sub: ClassifyTag): string {
  return sub === "array" ? "Array" : sub === "function" ? "Function" : "Object";
}

function classNameFor(value: unknown, sub: ClassifyTag): string | undefined {
  if (!isObjectOrFunction(value)) return undefined;
  const fallback = classNameFallback(sub);
  try {
    return value.constructor?.name || fallback;
  } catch {
    return fallback;
  }
}

function isPrimitiveTag(sub: ClassifyTag): boolean {
  switch (sub) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "undefined":
      return true;
    default:
      return false;
  }
}

function serializationErrorMessage(error: unknown): string {
  if (error === SERIALIZATION_BUDGET_EXCEEDED) return "value exceeds serialization budget";
  if (error instanceof Error) return error.message;
  return String(error);
}

function serializeByValue(
  value: unknown,
  nodeBudget: number | undefined,
): { serialized: unknown; serializationError: string | null } {
  try {
    const inner = safeReplacer();
    let budgetLeft = nodeBudget ?? Infinity;
    const replacer = (key: string, val: unknown): unknown => {
      if (--budgetLeft < 0) throw SERIALIZATION_BUDGET_EXCEEDED;
      return inner(key, val);
    };
    return {
      serialized: JSON.parse(JSON.stringify(value, replacer)),
      serializationError: null,
    };
  } catch (error) {
    return { serialized: undefined, serializationError: serializationErrorMessage(error) };
  }
}

function hasObjectHandle(sub: ClassifyTag): boolean {
  return sub === "object" || sub === "function" || sub === "array";
}

function shouldMintObjectId(returnByValue: boolean, sub: ClassifyTag): boolean {
  return !returnByValue && hasObjectHandle(sub);
}

function resultType(sub: ClassifyTag): PackedResultType {
  return sub === "null" || sub === "array" ? "object" : sub;
}

function serializeResultValue(
  value: unknown,
  returnByValue: boolean,
  sub: ClassifyTag,
  nodeBudget: number | undefined,
): { serialized: unknown; serializationError: string | null } {
  return isPrimitiveTag(sub) || returnByValue
    ? serializeByValue(value, nodeBudget)
    : { serialized: undefined, serializationError: null };
}

function valueJson(serialized: unknown): string | undefined {
  return serialized === undefined ? undefined : JSON.stringify(serialized);
}

function packedSubtype(sub: ClassifyTag, value: unknown): "null" | "array" | "error" | undefined {
  switch (sub) {
    case "null":
      return "null";
    case "array":
      return "array";
    case "object":
      if (value instanceof Error) return "error";
  }
  return undefined;
}

export function packResult(
  value: unknown,
  returnByValue: boolean,
  nodeBudget?: number,
): PackedResult {
  const sub = classify(value);
  const className = classNameFor(value, sub);
  const serialization = serializeResultValue(value, returnByValue, sub, nodeBudget);
  const objectId = shouldMintObjectId(returnByValue, sub) ? mintHandle(value) : undefined;
  return {
    ok: true,
    type: resultType(sub),
    subtype: packedSubtype(sub, value),
    className,
    description: describe(value),
    valueJson: valueJson(serialization.serialized),
    serializationError: serialization.serializationError,
    objectId,
  };
}

function exceptionMessageAndStack(err: unknown): { message: string; stack: string | undefined } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err), stack: undefined };
}

function exceptionClassName(err: unknown): string {
  return err instanceof Error ? err.constructor?.name || "Error" : "Error";
}

export function packException(err: unknown): PackedException {
  const { message, stack } = exceptionMessageAndStack(err);
  const className = exceptionClassName(err);
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
