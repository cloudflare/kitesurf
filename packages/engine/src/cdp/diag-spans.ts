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

export class DiagSpanTracker {
  private open = new Map<
    string,
    {
      finish: (tags?: SpanTags) => void;
      timer: ReturnType<typeof setTimeout>;
      startT: number | null;
    }
  >();

  constructor(
    private tracer: Tracer,
    private parent: SpanContext | null,
  ) {}

  handle(params: Record<string, unknown>): void {
    const ev = typeof params.ev === "string" ? params.ev : "";
    const op = typeof params.op === "string" ? params.op : "";
    const safeOp = op.slice(0, MAX_DIAG_NAME_CHARS).replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!safeOp) return;
    const t = typeof params.t === "number" ? params.t : null;
    if (ev === "start") this.start(safeOp, t);
    else if (ev === "end") {
      const entry = this.open.get(safeOp);
      const childMs = t !== null && entry?.startT != null ? +(t - entry.startT).toFixed(1) : null;
      const tags: SpanTags = {};
      let n = 0;
      for (const [k, v] of Object.entries(params)) {
        if (k === "ev" || k === "op" || k === "t") continue;
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        if (++n > MAX_DIAG_SPAN_TAGS) break;
        const key = k.slice(0, MAX_DIAG_NAME_CHARS).replace(/[^a-zA-Z0-9_.-]/g, "");
        tags[key] = v;
      }
      if (childMs !== null) tags.child_ms = childMs;
      this.end(safeOp, Object.keys(tags).length ? tags : undefined);
    }
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
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const stem = SUMMARY_PHASE_RE.exec(key)?.[1];
      if (stem === undefined) continue;
      const op = stem.replace(/([A-Z])/g, "_$1").toLowerCase();
      if (this.closed.has(op)) continue;
      if (!this.open.has(op)) {
        this.start(op);
        if (!this.open.has(op)) continue;
      }
      this.end(op, { child_ms: value, from_summary: true });
    }
  }

  closeAll(reason: string): void {
    for (const op of [...this.open.keys()]) {
      this.end(op, { abandoned: true, reason });
    }
  }
}
