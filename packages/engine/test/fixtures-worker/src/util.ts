// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { z } from "zod";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const KIB = 1024;
export const MIB = 1024 * KIB;

interface IntQueryOptions {
  fallback: number;
  min?: number;
  max?: number;
}

const intQueryValue = z.preprocess(
  (value) => (value === undefined || value === "" ? Number.NaN : value),
  z.coerce.number().finite().transform(Math.trunc),
);

export function intQuery(
  c: Context,
  name: string,
  { fallback, min = -Infinity, max = Infinity }: IntQueryOptions,
): number {
  const value = intQueryValue.catch(fallback).parse(c.req.query(name));
  return Math.min(Math.max(value, min), max);
}

// JSON.stringify leaves `<` unchanged, so `</script>` can end the element.
// Escape `<`, U+2028 and U+2029 while preserving the parsed JS value.
// Use for every script interpolation.
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// `wrangler types` declares `*.wasm` as `ArrayBuffer | WebAssembly.Module`,
// because workerd's default CompiledWasm rule also matches the extension.
// Our Data rule for assets/*.wasm wins at runtime, so this only narrows.
export function dataModule(value: ArrayBuffer | WebAssembly.Module): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new TypeError("expected a Data module (ArrayBuffer)");
  return value;
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
