// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Normalizes supported scrollTo/scrollBy argument forms into one scroll request.

export interface NormalizedScrollArgs {
  left: number | null;
  top: number | null;
  behavior: string;
}

export function normalizeScrollArgs(
  argsList: ArrayLike<unknown>,
  fnName: string,
): NormalizedScrollArgs | null {
  const len = argsList.length;
  if (len === 0) return null;
  if (len === 1) {
    const arg = argsList[0];
    if (arg == null || typeof arg !== "object") {
      throw new TypeError(fnName + ": single argument must be a ScrollToOptions dictionary");
    }
    // ScrollToOptions, whose behavior must be a ScrollBehavior value.
    const a = arg as { behavior?: unknown; left?: unknown; top?: unknown };
    const behavior = a.behavior;
    if (
      behavior !== undefined &&
      behavior !== "auto" &&
      behavior !== "instant" &&
      behavior !== "smooth"
    ) {
      throw new TypeError(
        fnName +
          ": behavior must be 'auto', 'instant', or 'smooth' (got " +
          JSON.stringify(behavior) +
          ")",
      );
    }
    const left = a.left == null ? null : Number(a.left);
    const top = a.top == null ? null : Number(a.top);
    return {
      left: left != null && Number.isFinite(left) ? left : a.left == null ? null : 0,
      top: top != null && Number.isFinite(top) ? top : a.top == null ? null : 0,
      behavior: typeof behavior === "string" ? behavior : "auto",
    };
  }
  // 2+ args: numeric (x, y) form. WebIDL coerces to double.
  const x = Number(argsList[0]);
  const y = Number(argsList[1]);
  return {
    left: Number.isFinite(x) ? x : 0,
    top: Number.isFinite(y) ? y : 0,
    behavior: "auto",
  };
}
