// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracks diagnostic operations and attaches their timing tags to the active trace.

import type { Tracer, Span, SpanContext, SpanTags } from "../tracing.ts";

const MAX_DIAG_NAME_CHARS = 32;
const MAX_DIAG_SPAN_TAGS = 12;
const MAX_OPEN_DIAG_SPANS = 16;
const ABANDONED_DIAG_SPAN_TIMEOUT_MS = 60_000;
const SUMMARY_PHASE_RE = new RegExp(`^([a-zA-Z]{1,${MAX_DIAG_NAME_CHARS}})Ms$`);

type OpenDiagSpan = {
  finish: (tags?: SpanTags) => void;
  timer: ReturnType<typeof setTimeout>;
  startT: number | null;
};

export class DiagSpanTracker {
  private open = new Map<string, OpenDiagSpan>();

  constructor(
    private tracer: Tracer,
    private parent: SpanContext | null,
  ) {}

  handle(params: Record<string, unknown>): void {
    const ev = stringField(params, "ev");
    const safeOp = diagnosticName(stringField(params, "op"));
    if (!safeOp) return;
    const t = numericField(params, "t");
    if (ev === "start") this.start(safeOp, t);
    else if (ev === "end") this.end(safeOp, tagsForEnd(params, t, this.open.get(safeOp)));
  }

  private start(op: string, startT: number | null = null): void {
    if (this.open.has(op) || this.open.size >= MAX_OPEN_DIAG_SPANS) return;
    let finish: (tags?: SpanTags) => void = () => {};
    this.tracer.runWithSpanContext(this.parent, () => {
      this.tracer.enterSpan("child." + op, (s: Span) => {
        return new Promise<void>((resolve) => {
          finish = (tags?: SpanTags) => {
            if (tags) s.setTags(tags);
            resolve();
          };
        });
      });
    });
    const timer = setTimeout(
      () => this.end(op, { abandoned: true }),
      ABANDONED_DIAG_SPAN_TIMEOUT_MS,
    );
    this.open.set(op, { finish, timer, startT });
  }

  end(op: string, tags?: SpanTags): void {
    const entry = this.open.get(op);
    if (!entry) return;
    this.open.delete(op);
    this.closed.add(op);
    clearTimeout(entry.timer);
    entry.finish(tags);
  }

  private closed = new Set<string>();

  settleFromSummary(phases: Record<string, number>): void {
    for (const [key, value] of Object.entries(phases)) {
      this.settleSummaryEntry(key, value);
    }
  }

  private settleSummaryEntry(key: string, value: number): void {
    if (!isFiniteNumber(value)) return;
    const op = operationFromSummaryKey(key);
    if (!op || this.closed.has(op)) return;
    if (!this.ensureSummarySpan(op)) return;
    this.end(op, { child_ms: value, from_summary: true });
  }

  private ensureSummarySpan(op: string): boolean {
    if (this.open.has(op)) return true;
    this.start(op);
    return this.open.has(op);
  }

  closeAll(reason: string): void {
    for (const op of [...this.open.keys()]) {
      this.end(op, { abandoned: true, reason });
    }
  }
}

function stringField(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function numericField(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  return typeof value === "number" ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function diagnosticName(name: string): string {
  return name.slice(0, MAX_DIAG_NAME_CHARS).replace(/[^a-zA-Z0-9_.-]/g, "");
}

function tagsForEnd(
  params: Record<string, unknown>,
  time: number | null,
  entry: OpenDiagSpan | undefined,
): SpanTags | undefined {
  const tags: SpanTags = {};
  let n = 0;
  for (const [key, value] of Object.entries(params)) {
    if (!isDiagnosticTag(key, value)) continue;
    if (++n > MAX_DIAG_SPAN_TAGS) break;
    tags[diagnosticName(key)] = value;
  }
  const childMs = diagnosticChildMs(time, entry);
  if (childMs !== null) tags.child_ms = childMs;
  return nonEmptyTags(tags);
}

function nonEmptyTags(tags: SpanTags): SpanTags | undefined {
  return Object.keys(tags).length ? tags : undefined;
}

function isDiagnosticTag(key: string, value: unknown): value is number {
  return (
    key !== "ev" &&
    key !== "op" &&
    key !== "t" &&
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function diagnosticChildMs(time: number | null, entry: OpenDiagSpan | undefined): number | null {
  return time !== null && entry?.startT != null ? +(time - entry.startT).toFixed(1) : null;
}

function operationFromSummaryKey(key: string): string | null {
  const stem = SUMMARY_PHASE_RE.exec(key)?.[1];
  return stem === undefined ? null : stem.replace(/([A-Z])/g, "_$1").toLowerCase();
}
