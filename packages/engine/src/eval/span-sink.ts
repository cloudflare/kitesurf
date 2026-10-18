// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Accepts worker span records and attaches bounded log chunks to the active trace.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Tracer, SpanContext } from "../tracing.ts";
import { attachChunked } from "./carrier-spans.ts";
import { bindLocalFlushCtx, LocalTracer, localTracerSingleton } from "../tracing-local.ts";

const MAX_RECORDS_PER_CALL = 2000;
const MAX_BYTES_PER_CALL = 4 * 1024 * 1024;

interface SinkEnv {
  HOST_TRACER?: Tracer;
}

interface SinkProps {
  kind?: string;
  localTraceParent?: SpanContext;
}

export class SpanSink extends WorkerEntrypoint<SinkEnv, SinkProps> {
  emit(records: string[]): number {
    let tracer = this.env.HOST_TRACER;
    const stamped = this.ctx.props?.localTraceParent;
    const local = tracer instanceof LocalTracer ? tracer : tracer ? null : localTracerSingleton();
    if (local && stamped) {
      tracer = local;
      bindLocalFlushCtx(this.ctx);
    }
    const activeTracer = tracer;
    if (!activeTracer || !Array.isArray(records) || records.length === 0) return 0;
    const attach = () => this.#attach(activeTracer, records);
    return local && stamped ? local.runWithSpanContext(stamped, attach) : attach();
  }

  #attach(tracer: Tracer, records: string[]): number {
    if (tracer.getSpanContext() === null) return 0;
    const kept: string[] = [];
    let bytes = 0;
    for (const r of records) {
      if (typeof r !== "string") continue;
      if (kept.length >= MAX_RECORDS_PER_CALL || bytes + r.length > MAX_BYTES_PER_CALL) {
        break;
      }
      kept.push(r);
      bytes += r.length;
    }
    const kind = this.ctx.props?.kind;
    const result = attachChunked(
      tracer,
      "child.spans",
      typeof kind === "string" ? { kind } : {},
      kept.map((value) => ({ key: "otel.span", value })),
      records.length > kept.length ? { recordsDropped: records.length - kept.length } : {},
    );
    return result.attached;
  }
}
