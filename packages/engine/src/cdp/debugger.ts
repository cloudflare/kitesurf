// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Debugger commands and events for PageScript execution.

import type { CdpRequest, CompiledScriptMeta, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { RetainedText } from "../retained-text.ts";

const EXEC_CONTEXT_ID = 1;

export async function handleDebugger(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Debugger.enable": {
      const sessionId = req.sessionId;
      for (const target of ctx.browser.targets.values()) {
        if (target.type !== "page") continue;
        if (sessionId && target.sessions.has(sessionId)) {
          target.debuggerEnabledSessions.add(sessionId);
          for (const meta of target.compiledScripts) {
            emitScriptParsed(
              ctx,
              meta,
              sessionId,
              target.frameId,
              target.defaultContextId || undefined,
            );
          }
        } else if (!sessionId) {
          target.debuggerEnabledSessions.add("");
          for (const meta of target.compiledScripts) {
            emitScriptParsed(
              ctx,
              meta,
              undefined,
              target.frameId,
              target.defaultContextId || undefined,
            );
          }
        }
      }
      return { debuggerId: `dbg-${sessionId ?? "browser"}` };
    }

    case "Debugger.disable": {
      const sessionId = req.sessionId;
      for (const target of ctx.browser.targets.values()) {
        if (sessionId) target.debuggerEnabledSessions.delete(sessionId);
        else target.debuggerEnabledSessions.delete("");
      }
      return {};
    }

    // Accept unsupported methods commonly sent during attach.
    case "Debugger.setSkipAllPauses":
    case "Debugger.setBreakpointsActive":
    case "Debugger.setPauseOnExceptions":
    case "Debugger.setAsyncCallStackDepth":
    case "Debugger.setBlackboxPatterns":
    case "Debugger.setBlackboxedRanges":
      return {};

    case "Debugger.getScriptSource": {
      const scriptId = req.params!.scriptId;
      for (const target of ctx.browser.targets.values()) {
        for (const meta of target.compiledScripts) {
          if (meta.scriptId === scriptId) {
            return { scriptSource: meta.source?.text() ?? "" };
          }
        }
      }
      return { scriptSource: "" };
    }

    default:
      return {};
  }
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
    source: opts.source === undefined ? undefined : new RetainedText(opts.source),
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
