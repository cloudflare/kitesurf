// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines session timing, telemetry events, and host-provided analytics sinks.

export interface HostClockTimer {
  readonly timeOrigin: number;
  now(): number;
}

export class SafePerformance {
  #clock?: HostClockTimer;
  readonly timeOrigin: number;

  constructor(clock?: HostClockTimer) {
    this.#clock = clock;
    this.timeOrigin = clock?.timeOrigin ?? performance.timeOrigin;
  }

  now(): number {
    return this.#clock?.now() ?? performance.now();
  }
}

// Host-defined analytics label for how a session was opened.
export type SessionEntrypoint = string;

// Returned on the CDP upgrade response and by Kitesurf.getSessionInfo.
// Never forwarded to origins.
export const SESSION_ID_HEADER = "x-kitesurf-session-id";

// Identify DevTools page URLs when the host supplies no entrypoint label.
export function resolveEntrypoint(request: Request): SessionEntrypoint {
  try {
    if (new URL(request.url).pathname.startsWith("/devtools/page/")) {
      return "devtools";
    }
  } catch {}
  return "puppeteer";
}

export interface SessionMeta {
  sessionId: string;
  entrypoint: string;
  connectionMode: "page" | "browser";
  environment: string;
  buildVersion: string;
  colo: string;
}

export interface SessionStartFields {
  totalMs: number;
  preSpawnWaitMs: number;
  bakeMs: number;
  wsUpgradeMs: number;
  navRpcMs: number;
  parseMs: number;
  shimMs: number;
  fontsMs: number;
  regularScriptsMs: number;
  moduleScriptsMs: number;
  teardownMs: number;
  spawnKind: string;
  host: string;
}

export interface SessionEndFields {
  endReason: string;
  closeCode: number;
  wasClean: number;
}

export type TelemetryEvent =
  | { name: "session_start"; fields: SessionStartFields }
  | {
      name: "session_end";
      fields: SessionEndFields & { durationMs: number };
    };

export interface SessionTelemetry {
  emit(event: TelemetryEvent): void;
}

export interface TelemetryInit {
  meta: SessionMeta;
  request: Request;
  props: unknown;
  env: Env;
  waitUntil(p: Promise<unknown>): void;
  sessionAgeMs(): number;
  reportException(err: unknown): void;
}

export type TelemetryFactory = (init: TelemetryInit) => SessionTelemetry | undefined;

export class KitesurfAnalytics {
  #sink: SessionTelemetry | undefined;
  #meta: SessionMeta;
  #perf: SafePerformance;
  #startedAt: number;
  #onceKeys = new Set<string>();
  #reportException: (err: unknown) => void;

  constructor(
    meta: SessionMeta,
    perf: SafePerformance,
    open?: {
      factory: TelemetryFactory | undefined;
      request: Request;
      props: unknown;
      env: Env;
      waitUntil(p: Promise<unknown>): void;
    },
    reportException: (err: unknown) => void = (err) => console.warn("[kitesurf-telemetry]", err),
  ) {
    this.#meta = meta;
    this.#perf = perf;
    this.#startedAt = perf.now();
    this.#reportException = reportException;
    try {
      this.#sink = open?.factory?.({
        meta,
        request: open.request,
        props: open.props,
        env: open.env,
        waitUntil: open.waitUntil,
        sessionAgeMs: () => this.sessionAgeMs(),
        reportException,
      });
    } catch (err) {
      reportException(err);
    }
  }

  get meta(): SessionMeta {
    return this.#meta;
  }

  now(): number {
    return this.#perf.now();
  }

  sessionAgeMs(): number {
    return this.#perf.now() - this.#startedAt;
  }

  once(key: string): boolean {
    if (this.#onceKeys.has(key)) return false;
    this.#onceKeys.add(key);
    return true;
  }

  emit(event: TelemetryEvent): void {
    if (this.#sink === undefined) return;
    try {
      this.#sink.emit(event);
    } catch (err) {
      this.#reportException(err);
    }
  }
}

export function emitSessionStart(analytics: KitesurfAnalytics, fields: SessionStartFields): void {
  if (!analytics.once("session_start")) return;
  analytics.emit({ name: "session_start", fields });
}

export function emitSessionEnd(analytics: KitesurfAnalytics, fields: SessionEndFields): void {
  if (!analytics.once("session_end")) return;
  analytics.emit({
    name: "session_end",
    fields: { ...fields, durationMs: analytics.sessionAgeMs() },
  });
}
