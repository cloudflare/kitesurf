// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Relays PageScript tail logs, spans, limit notices, and token-checked exceptions.

import { WorkerEntrypoint } from "cloudflare:workers";
import { getTailTrace } from "./tail-trace-registry.ts";
import { attachChunked } from "./carrier-spans.ts";
import { notifyIsolateLimit } from "./limit-registry.ts";
import { parseKsErrLine, type TailExceptionReport } from "../engine-errors.ts";
import type { Tracer } from "../tracing.ts";
import type { IsolateKillMarker } from "@kitesurf/jsrpc-types/shared";

const ISOLATE_KILL_MARKER: IsolateKillMarker = "[ks-kill]";
/** workerd's message when an invocation can no longer produce a result. */
const HUNG_INVOCATION_TEXT = "detected that your Worker's code had hung";

export interface PageScriptTailProps {
  scriptName: string;
  /**
   * Hostname of the generation's navigate URL, for error reports.
   * Unset for the renderer (not page-bound).
   */
  pageDomain?: string;
  ksErrToken?: string;
  /**
   * The owning CDP session's connectionId, used to join error reports
   * with engine events and analytics rows.
   */
  sessionId?: string;
}

// Cap mirrored lines; one marker reports any dropped remainder.
const SPAN_LOG_CAP = 100;

// Keep page console output from starving later DOM and wasm span records.
const SPAN_REC_CAP = 250;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MAX_PAGE_SCRIPT_TAIL_LOG_LINE_CHARS = 256;

const OTEL_SEVERITY: Record<string, number> = {
  debug: 5,
  log: 9,
  info: 9,
  warn: 13,
  error: 17,
  exception: 17,
};

function otelLogRecord(b: { level: string; msg: string; t_ms: number }): string {
  return JSON.stringify({
    timeUnixNano: String(b.t_ms * NANOSECONDS_PER_MILLISECOND),
    severityNumber: OTEL_SEVERITY[b.level] ?? 9,
    severityText: b.level === "exception" ? "ERROR" : b.level.toUpperCase(),
    body: { stringValue: b.msg },
  });
}

export class PageScriptTail extends WorkerEntrypoint<
  { HOST_TRACER?: Tracer },
  PageScriptTailProps
> {
  /**
   * An embedding Worker can subclass PageScriptTail and export it under the
   * same name to forward reports to its error tracker.
   */
  protected reportException(_report: TailExceptionReport): void {}

  override tailStream(
    _onset: TailStream.TailEvent<TailStream.Onset>,
  ): TailStream.TailEventHandlerType {
    const scriptName = this.ctx.props?.scriptName ?? "page-script";
    const pageDomain = this.ctx.props?.pageDomain || undefined;
    const ksErrToken = this.ctx.props?.ksErrToken || undefined;
    const sessionId = this.ctx.props?.sessionId || undefined;
    const tag = `[${scriptName}]`;

    const buffered: Array<{ level: string; msg: string; t_ms: number }> = [];
    const spanRecs: string[] = [];
    let spanRecsDropped = 0;
    let dropped = 0;
    // Set when this invocation is the engine's `killIsolate` call.
    let killRequested = false;
    // Preserve the latest panic-hook line for error reports with empty wasm stacks.
    let lastPanicBlob: string | undefined;

    const buffer = (level: string, line: string, ts: Date) => {
      if (buffered.length >= SPAN_LOG_CAP) {
        dropped++;
        return;
      }
      buffered.push({
        level,
        msg: line.slice(0, MAX_PAGE_SCRIPT_TAIL_LOG_LINE_CHARS),
        t_ms: ts.getTime(),
      });
    };

    const flushSpan = () => {
      if (buffered.length === 0 && dropped === 0 && spanRecs.length === 0) return;
      const entry = getTailTrace(scriptName);
      const tracer = entry?.tracer;
      const parent = entry?.parent ?? null;
      if (!tracer || !parent) return;
      try {
        const logs = [
          ...buffered.map((b) => ({ key: "otel.log", value: otelLogRecord(b) })),
          ...spanRecs.map((r) => ({ key: "otel.span", value: r })),
          ...(dropped > 0
            ? [
                {
                  key: "otel.log",
                  value: otelLogRecord({
                    level: "warn",
                    msg: `truncated: dropped ${dropped} lines after ${SPAN_LOG_CAP}`,
                    t_ms: Date.now(),
                  }),
                },
              ]
            : []),
        ];
        tracer.runWithSpanContext(parent, () => {
          attachChunked(tracer, "child.console", { scriptName }, logs, {
            logCount: buffered.length,
            dropped,
            ...(spanRecsDropped > 0 ? { wasmSpansDropped: spanRecsDropped } : {}),
          });
        });
      } catch (err) {
        console.warn(
          `[page-script-tail] span submit failed for ${scriptName}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };

    return {
      log: (ev: TailStream.TailEvent<TailStream.Log>) => {
        const line = renderMessage(ev.event.message);
        const killPrefix = `${ISOLATE_KILL_MARKER} ${ksErrToken} `;
        if (ksErrToken && line.startsWith(killPrefix)) {
          killRequested = true;
          const note = `${ISOLATE_KILL_MARKER} ${line.slice(killPrefix.length)}`;
          buffer(ev.event.level, note, ev.timestamp);
          console.log(tag, note);
          return;
        }
        if (line.startsWith("[ks-otel-span] ")) {
          if (spanRecs.length >= SPAN_REC_CAP) spanRecsDropped++;
          else spanRecs.push(line.slice("[ks-otel-span] ".length));
          return;
        }
        // Retain panic-hook output for error reports, then mirror it as console output.
        if (line.startsWith("[cs panic]") || line.startsWith("panicked at")) {
          lastPanicBlob = line;
        }
        // Authenticated engine errors enter the error channel, then follow normal console handling.
        const ksErr = parseKsErrLine(line, ksErrToken);
        if (ksErr) {
          this.reportException({
            scriptName,
            pageDomain,
            sessionId,
            ...ksErr,
            panicStack: lastPanicBlob,
          });
          lastPanicBlob = undefined;
        }

        buffer(ev.event.level, line, ev.timestamp);
        switch (ev.event.level) {
          case "error":
            console.error(tag, line);
            break;
          case "warn":
            console.warn(tag, line);
            break;
          case "debug":
            console.debug(tag, line);
            break;
          default:
            console.log(tag, line);
        }
      },
      exception: (ev: TailStream.TailEvent<TailStream.Exception>) => {
        // The requested abort cancels its own RPC; that is the kill, not a page error.
        if (killRequested && ev.event.message.includes(HUNG_INVOCATION_TEXT)) {
          buffer("log", "isolate killed on engine request", ev.timestamp);
          return;
        }
        const stack = ev.event.stack ? `\n${ev.event.stack}` : "";
        buffer("exception", `${ev.event.name}: ${ev.event.message}`, ev.timestamp);
        console.error(`${tag} ${ev.event.name}: ${ev.event.message}${stack}`);
        // Uncaught tail exceptions indicate a missed error boundary; the
        // report carries the stack for classifying page versus engine origin.
        this.reportException({
          scriptName,
          pageDomain,
          sessionId,
          name: ev.event.name,
          message: ev.event.message,
          stack: ev.event.stack,
          panicStack: lastPanicBlob,
        });
        lastPanicBlob = undefined;
      },
      outcome: (ev: TailStream.TailEvent<TailStream.Outcome>) => {
        flushSpan();
        if (ev.event.outcome === "ok") return;
        if (killRequested && ev.event.outcome === "exception") return;
        if (ev.event.outcome === "exceededCpu" || ev.event.outcome === "exceededMemory") {
          notifyIsolateLimit(scriptName, {
            kind: ev.event.outcome === "exceededCpu" ? "cpu" : "memory",
            capMs: 0,
            fromTail: true,
          });
        }
        console.warn(
          `${tag} invocation outcome=${ev.event.outcome}` +
            ` cpu=${ev.event.cpuTime}ms wall=${ev.event.wallTime}ms`,
        );
      },
    };
  }
}

function renderMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
  }
  if (typeof message === "string") return message;
  return safeStringify(message);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
