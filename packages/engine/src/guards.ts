// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Narrowing for values that cross a trust boundary (wire params, env, JSON replies): each
// helper checks at runtime what its type claims, so a caller never needs an `as` to use it.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function oneOf<T extends string>(allowed: readonly T[], v: unknown): T | undefined {
  return allowed.find((a) => a === v);
}

// An env var the generated Env does not declare (a secret, a .dev.vars-only knob): read it
// as the binding object holds it, and only a string counts as set.
export function stringProp(obj: object, key: string): string | undefined {
  const v: unknown = Reflect.get(obj, key);
  return typeof v === "string" ? v : undefined;
}
