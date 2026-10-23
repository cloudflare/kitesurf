// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Debugger commands and events for PageScript execution.

import type { CdpRequest, CompiledScriptMeta, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";

const EXEC_CONTEXT_ID = 1;

type DebuggerHandler = (ctx: DispatchCtx, req: CdpRequest) => unknown;
type GetScriptSourceRequest = Extract<CdpRequest, { method: "Debugger.getScriptSource" }>;

function isGetScriptSourceRequest(req: CdpRequest): req is GetScriptSourceRequest {
  return req.method === "Debugger.getScriptSource";
}

const DEBUGGER_HANDLERS = new Map<string, DebuggerHandler>([
  ["Debugger.enable", (ctx, req) => enableDebugger(ctx, req.sessionId)],
  ["Debugger.disable", (ctx, req) => disableDebugger(ctx, req.sessionId)],
  [
    "Debugger.getScriptSource",
    (ctx, req) =>
      isGetScriptSourceRequest(req) ? getScriptSource(ctx, req) : { scriptSource: "" },
  ],
]);

export async function handleDebugger(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  return DEBUGGER_HANDLERS.get(req.method)?.(ctx, req) ?? {};
}

function enableDebugger(ctx: DispatchCtx, sessionId: string | undefined): { debuggerId: string } {
  for (const target of ctx.browser.targets.values()) {
    if (target.type === "page") enableTargetDebugger(ctx, target, sessionId);
  }
  return { debuggerId: `dbg-${sessionId ?? "browser"}` };
}

function enableTargetDebugger(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  if (sessionId && target.sessions.has(sessionId)) {
    target.debuggerEnabledSessions.add(sessionId);
    emitCompiledScripts(ctx, target, sessionId);
    return;
  }
  if (!sessionId) {
    target.debuggerEnabledSessions.add("");
    emitCompiledScripts(ctx, target, undefined);
  }
}

function emitCompiledScripts(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  for (const meta of target.compiledScripts) {
    emitScriptParsed(ctx, meta, sessionId, target.frameId, target.defaultContextId || undefined);
  }
}

function disableDebugger(ctx: DispatchCtx, sessionId: string | undefined): Record<string, never> {
  for (const target of ctx.browser.targets.values()) {
    target.debuggerEnabledSessions.delete(sessionId ?? "");
  }
  return {};
}

function getScriptSource(ctx: DispatchCtx, req: GetScriptSourceRequest): { scriptSource: string } {
  const scriptId = scriptSourceId(req);
  for (const target of ctx.browser.targets.values()) {
    for (const meta of target.compiledScripts) {
      if (meta.scriptId === scriptId) return { scriptSource: meta.source ?? "" };
    }
  }
  return { scriptSource: "" };
}

function scriptSourceId(req: GetScriptSourceRequest): string | undefined {
  if (req.params === undefined) {
    throw new TypeError("Cannot read properties of undefined (reading 'scriptId')");
  }
  return req.params.scriptId;
}

export function emitScriptParsed(
  ctx: DispatchCtx,
  meta: CompiledScriptMeta,
  sessionId: string | undefined,
  frameId?: string,
  executionContextId?: number,
): void {
  ctx.emit({
    method: "Debugger.scriptParsed",
    params: {
      scriptId: meta.scriptId,
      url: meta.url,
      startLine: meta.startLine,
      startColumn: meta.startColumn,
      endLine: meta.endLine,
      endColumn: meta.endColumn,
      executionContextId: executionContextId ?? EXEC_CONTEXT_ID,
      hash: meta.hash,
      buildId: "",
      isLiveEdit: false,
      sourceMapURL: meta.sourceMapURL,
      hasSourceURL: meta.hasSourceURL,
      isModule: meta.isModule,
      length: meta.length,
      executionContextAuxData: {
        isDefault: true,
        type: "default",
        frameId: frameId ?? "browser",
      },
    },
    sessionId,
  });
}

export function hasDebuggerListeners(target: TargetState): boolean {
  return target.debuggerEnabledSessions.size > 0;
}

export function makeCompiledScriptMeta(
  scriptId: string,
  expression: string,
  sourceURL: string,
  opts: {
    isModule?: boolean;
    sourceMapURL?: string;
    source?: string;
  } = {},
): CompiledScriptMeta {
  const lines = expression.split("\n");
  const endLine = lines.length - 1;
  const endColumn = lines[endLine]?.length ?? 0;
  return {
    scriptId,
    url: sourceURL,
    hasSourceURL: sourceURL.length > 0,
    startLine: 0,
    startColumn: 0,
    endLine,
    endColumn,
    length: expression.length,
    hash: fnv1aHex(expression),
    sourceMapURL: opts.sourceMapURL ?? "",
    isModule: opts.isModule === true,
    source: opts.source,
  };
}

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
