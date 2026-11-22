// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Records which client set each request and emulation override on a target, so a client that
// leaves a shared session takes its overrides with it.

import type { DispatchCtx } from "./dispatch.ts";
import type { TargetOverride, TargetOverrideValues, TargetState } from "./types.ts";
import { sessionOf } from "./page-session.ts";
import { DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "./viewport.ts";

const OVERRIDE_KINDS: readonly TargetOverride[] = [
  "extraHttpHeaders",
  "userAgent",
  "emulatedMedia",
  "deviceMetrics",
];

function defaultOverride<K extends TargetOverride>(kind: K): TargetOverrideValues[K] {
  const defaults: TargetOverrideValues = {
    extraHttpHeaders: {},
    userAgent: "",
    emulatedMedia: "screen",
    deviceMetrics: { width: null, height: null, scale: 1 },
  };
  return defaults[kind];
}

const APPLY: { [K in TargetOverride]: (t: TargetState, value: TargetOverrideValues[K]) => void } = {
  extraHttpHeaders: (t, value) => {
    t.extraHttpHeaders = value;
  },
  userAgent: (t, value) => {
    t.userAgentOverride = value;
  },
  emulatedMedia: (t, value) => {
    t.emulatedMedia = value;
  },
  deviceMetrics: (t, value) => {
    t.viewportWidth = value.width;
    t.viewportHeight = value.height;
    t.deviceScaleFactor = value.scale;
  },
};

/** Sets an override on the target and records it as the client's latest value of that kind. */
export function setTargetOverride<K extends TargetOverride>(
  target: TargetState,
  kind: K,
  clientId: string,
  value: TargetOverrideValues[K],
): void {
  const writers: Map<string, TargetOverrideValues[K]> = target.overrideWriters[kind] ?? new Map();
  target.overrideWriters[kind] = writers as (typeof target.overrideWriters)[K];
  writers.delete(clientId);
  writers.set(clientId, value);
  APPLY[kind](target, value);
}

// A loaded document keeps the media and viewport it was given, so they are pushed to it.
function pushToLivePage(ctx: DispatchCtx, target: TargetState, kind: TargetOverride): void {
  const live = sessionOf(ctx, target).callIfLive;
  if (kind === "emulatedMedia") {
    void live.setMediaType({ media: target.emulatedMedia }).catch(() => {});
  } else if (kind === "deviceMetrics") {
    void live
      .setViewport({
        width: target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
        height: target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
      })
      .catch(() => {});
  }
}

function releaseOverride<K extends TargetOverride>(
  ctx: DispatchCtx,
  target: TargetState,
  kind: K,
  clientId: string,
): void {
  const writers: Map<string, TargetOverrideValues[K]> | undefined = target.overrideWriters[kind];
  if (!writers?.has(clientId)) return;
  const wasNewest = Array.from(writers.keys()).at(-1) === clientId;
  writers.delete(clientId);
  if (!wasNewest) return;
  APPLY[kind](target, Array.from(writers.values()).at(-1) ?? defaultOverride(kind));
  pushToLivePage(ctx, target, kind);
}

/**
 * Drops the overrides a departed client set. Where it was the newest writer, the newest value
 * of a client that remains applies, or the default, so its headers do not ride on their requests.
 */
export function releaseClientOverrides(ctx: DispatchCtx, clientId: string): void {
  for (const target of ctx.browser.targets.values()) {
    for (const kind of OVERRIDE_KINDS) releaseOverride(ctx, target, kind, clientId);
  }
}
