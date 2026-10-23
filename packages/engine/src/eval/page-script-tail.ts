// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Relays PageScript tail logs, spans, limit notices, and token-checked exceptions.

import { WorkerEntrypoint } from "cloudflare:workers";
import { getTailTrace } from "./tail-trace-registry.ts";
import { attachChunked } from "./carrier-spans.ts";
import { notifyIsolateLimit } from "./limit-registry.ts";
import { parseKsErrLine, type TailExceptionReport } from "../engine-errors.ts";
import type { SpanContext, Tracer } from "../tracing.ts";
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

interface TailInvocationState {
  scriptName: string;
  pageDomain: string | undefined;
  ksErrToken: string | undefined;
  sessionId: string | undefined;
  tag: string;
  buffered: Array<{ level: string; msg: string; t_ms: number }>;
  spanRecs: string[];
  spanRecsDropped: number;
  dropped: number;
  killRequested: boolean;
  lastPanicBlob: string | undefined;
}

interface TailInvocationIdentity {
  scriptName: string;
  pageDomain: string | undefined;
  ksErrToken: string | undefined;
  sessionId: string | undefined;
}

function optionalTailField(value: string | undefined): string | undefined {
  return value || undefined;
}

function tailInvocationIdentity(props: PageScriptTailProps | undefined): TailInvocationIdentity {
  const { scriptName: configuredScriptName, pageDomain, ksErrToken, sessionId } = props ?? {};
  return {
    scriptName: configuredScriptName ?? "page-script",
    pageDomain: optionalTailField(pageDomain),
    ksErrToken: optionalTailField(ksErrToken),
    sessionId: optionalTailField(sessionId),
  };
}

function createTailInvocationState(props: PageScriptTailProps | undefined): TailInvocationState {
  const identity = tailInvocationIdentity(props);
  const { scriptName } = identity;
  return {
    ...identity,
    tag: `[${scriptName}]`,
    buffered: [],
    spanRecs: [],
    spanRecsDropped: 0,
    dropped: 0,
    killRequested: false,
    lastPanicBlob: undefined,
  };
}

function bufferTailLog(state: TailInvocationState, level: string, line: string, tMs: number): void {
  if (state.buffered.length >= SPAN_LOG_CAP) {
    state.dropped++;
    return;
  }
  state.buffered.push({
    level,
    msg: line.slice(0, MAX_PAGE_SCRIPT_TAIL_LOG_LINE_CHARS),
    t_ms: tMs,
  });
}

function isEmptyTailSpanBatch(state: TailInvocationState): boolean {
  return state.buffered.length === 0 && state.dropped === 0 && state.spanRecs.length === 0;
}

function tailSpanLogs(state: TailInvocationState): Array<{ key: string; value: string }> {
  return [
    ...state.buffered.map((entry) => ({ key: "otel.log", value: otelLogRecord(entry) })),
    ...state.spanRecs.map((record) => ({ key: "otel.span", value: record })),
    ...(state.dropped > 0
      ? [
          {
            key: "otel.log",
            value: otelLogRecord({
              level: "warn",
              msg: `truncated: dropped ${state.dropped} lines after ${SPAN_LOG_CAP}`,
              t_ms: Date.now(),
            }),
          },
        ]
      : []),
  ];
}

function tailSpanAttributes(state: TailInvocationState): {
  logCount: number;
  dropped: number;
  wasmSpansDropped?: number;
} {
  return {
    logCount: state.buffered.length,
    dropped: state.dropped,
    ...(state.spanRecsDropped > 0 ? { wasmSpansDropped: state.spanRecsDropped } : {}),
  };
}

function tailErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tailSpanTarget(scriptName: string): { tracer: Tracer; parent: SpanContext } | null {
  const entry = getTailTrace(scriptName);
  if (!entry) return null;
  const parent = entry.parent;
  if (!parent) return null;
  return { tracer: entry.tracer, parent };
}

function flushTailSpan(state: TailInvocationState): void {
  if (isEmptyTailSpanBatch(state)) return;
  const target = tailSpanTarget(state.scriptName);
  if (!target) return;
  try {
    target.tracer.runWithSpanContext(target.parent, () => {
      attachChunked(
        target.tracer,
        "child.console",
        { scriptName: state.scriptName },
        tailSpanLogs(state),
        tailSpanAttributes(state),
      );
    });
  } catch (error) {
    console.warn(
      `[page-script-tail] span submit failed for ${state.scriptName}: ` + tailErrorMessage(error),
    );
  }
}

function handleTailKillMarker(state: TailInvocationState, log: TraceLog, line: string): boolean {
  const killPrefix = `${ISOLATE_KILL_MARKER} ${state.ksErrToken} `;
  if (!(state.ksErrToken && line.startsWith(killPrefix))) return false;
  state.killRequested = true;
  const note = `${ISOLATE_KILL_MARKER} ${line.slice(killPrefix.length)}`;
  bufferTailLog(state, log.level, note, log.timestamp);
  console.log(state.tag, note);
  return true;
}

function handleTailSpanRecord(state: TailInvocationState, line: string): boolean {
  if (!line.startsWith("[ks-otel-span] ")) return false;
  if (state.spanRecs.length >= SPAN_REC_CAP) state.spanRecsDropped++;
  else state.spanRecs.push(line.slice("[ks-otel-span] ".length));
  return true;
}

function rememberTailPanic(state: TailInvocationState, line: string): void {
  if (line.startsWith("[cs panic]") || line.startsWith("panicked at")) {
    state.lastPanicBlob = line;
  }
}

function reportAuthenticatedTailError(
  state: TailInvocationState,
  line: string,
  reportException: (report: TailExceptionReport) => void,
): void {
  const error = parseKsErrLine(line, state.ksErrToken);
  if (!error) return;
  reportException({
    scriptName: state.scriptName,
    pageDomain: state.pageDomain,
    sessionId: state.sessionId,
    ...error,
    panicStack: state.lastPanicBlob,
  });
  state.lastPanicBlob = undefined;
}

function mirrorTailConsole(state: TailInvocationState, level: string, line: string): void {
  switch (level) {
    case "error":
      console.error(state.tag, line);
      break;
    case "warn":
      console.warn(state.tag, line);
      break;
    case "debug":
      console.debug(state.tag, line);
      break;
    default:
      console.log(state.tag, line);
  }
}

function relayTailLog(
  state: TailInvocationState,
  log: TraceLog,
  reportException: (report: TailExceptionReport) => void,
): void {
  const line = renderMessage(log.message);
  if (handleTailKillMarker(state, log, line)) return;
  if (handleTailSpanRecord(state, line)) return;
  rememberTailPanic(state, line);
  reportAuthenticatedTailError(state, line, reportException);
  bufferTailLog(state, log.level, line, log.timestamp);
  mirrorTailConsole(state, log.level, line);
}

function relayTailException(
  state: TailInvocationState,
  exception: TraceException,
  reportException: (report: TailExceptionReport) => void,
): void {
  if (state.killRequested && exception.message.includes(HUNG_INVOCATION_TEXT)) {
    bufferTailLog(state, "log", "isolate killed on engine request", exception.timestamp);
    return;
  }
  const stack = exception.stack ? `\n${exception.stack}` : "";
  bufferTailLog(state, "exception", `${exception.name}: ${exception.message}`, exception.timestamp);
  console.error(`${state.tag} ${exception.name}: ${exception.message}${stack}`);
  reportException({
    scriptName: state.scriptName,
    pageDomain: state.pageDomain,
    sessionId: state.sessionId,
    name: exception.name,
    message: exception.message,
    stack: exception.stack,
    panicStack: state.lastPanicBlob,
  });
  state.lastPanicBlob = undefined;
}

function replayTailEntries(
  item: TraceItem,
  state: TailInvocationState,
  reportException: (report: TailExceptionReport) => void,
): void {
  const entries: TailEntry[] = [
    ...item.logs.map((log): TailEntry => ({ at: log.timestamp, log })),
    ...item.exceptions.map((exception): TailEntry => ({ at: exception.timestamp, exception })),
  ].sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    if ("log" in entry) relayTailLog(state, entry.log, reportException);
    else relayTailException(state, entry.exception, reportException);
  }
}

function shouldIgnoreTailOutcome(item: TraceItem, state: TailInvocationState): boolean {
  return item.outcome === "ok" || (state.killRequested && item.outcome === "exception");
}

function notifyTailLimit(scriptName: string, outcome: TraceItem["outcome"]): void {
  if (outcome === "exceededCpu" || outcome === "exceededMemory") {
    notifyIsolateLimit(scriptName, {
      kind: outcome === "exceededCpu" ? "cpu" : "memory",
      capMs: 0,
      fromTail: true,
    });
  }
}

function finishTailInvocation(item: TraceItem, state: TailInvocationState): void {
  if (shouldIgnoreTailOutcome(item, state)) return;
  notifyTailLimit(state.scriptName, item.outcome);
  console.warn(
    `${state.tag} invocation outcome=${item.outcome}` +
      ` cpu=${item.cpuTime}ms wall=${item.wallTime}ms`,
  );
}

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

  // Events for an invocation arrive together once it ends. The outcome, and
  // with it any limit notice, is always the last thing an invocation reports.
  override tail(events: TraceItem[]): void {
    for (const item of events) this.relayInvocation(item);
  }

  private relayInvocation(item: TraceItem): void {
    const state = createTailInvocationState(this.ctx.props);
    const reportException = (report: TailExceptionReport) => this.reportException(report);
    replayTailEntries(item, state, reportException);
    flushTailSpan(state);
    finishTailInvocation(item, state);
  }
}

type TailEntry = { at: number; log: TraceLog } | { at: number; exception: TraceException };

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
