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
  if (len === 1) return normalizeOptionsArg(argsList[0], fnName);
  // 2+ args: numeric (x, y) form. WebIDL coerces to double.
  const x = Number(argsList[0]);
  const y = Number(argsList[1]);
  return {
    left: Number.isFinite(x) ? x : 0,
    top: Number.isFinite(y) ? y : 0,
    behavior: "auto",
  };
}

function normalizeOptionsArg(arg: unknown, fnName: string): NormalizedScrollArgs {
  if (arg == null || typeof arg !== "object") {
    throw new TypeError(fnName + ": single argument must be a ScrollToOptions dictionary");
  }
  // ScrollToOptions, whose behavior must be a ScrollBehavior value.
  const options = arg as { behavior?: unknown; left?: unknown; top?: unknown };
  const behavior = options.behavior;
  if (isInvalidBehavior(behavior)) {
    throw new TypeError(
      fnName +
        ": behavior must be 'auto', 'instant', or 'smooth' (got " +
        JSON.stringify(behavior) +
        ")",
    );
  }
  const left = optionCoordinateNumber(options, "left");
  const top = optionCoordinateNumber(options, "top");
  return {
    left: normalizedOptionCoordinate(left, options.left),
    top: normalizedOptionCoordinate(top, options.top),
    behavior: typeof behavior === "string" ? behavior : "auto",
  };
}

function optionCoordinateNumber(
  options: { left?: unknown; top?: unknown },
  property: "left" | "top",
): number | null {
  return options[property] == null ? null : Number(options[property]);
}

function isInvalidBehavior(behavior: unknown): boolean {
  return (
    behavior !== undefined && behavior !== "auto" && behavior !== "instant" && behavior !== "smooth"
  );
}

function normalizedOptionCoordinate(value: number | null, original: unknown): number | null {
  return value != null && Number.isFinite(value) ? value : original == null ? null : 0;
}
