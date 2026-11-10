// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the CDP Runtime domain over per-target PageScript sessions.

import type { CdpRequest, FrameState, TargetState } from "./types.ts";
import { ISOLATED_WORLD_CONTEXT_ID } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import {
  consoleEntryToCdpEvent,
  pageScriptResultToCdp,
  type PageScriptStub,
} from "../eval/page-script.ts";
import type { ConsoleEntry } from "@kitesurf/jsrpc-types/shared";
import { emitScriptParsed, hasDebuggerListeners, makeCompiledScriptMeta } from "./debugger.ts";
import { emitMutations } from "./dom.ts";
import { sessionOf } from "./page-session.ts";
import { jarForTarget } from "./target.ts";
import { emitFrameDclComplete, emitFrameLoadComplete } from "./page.ts";
import { traceSpan } from "../tracing.ts";
import type { Protocol } from "devtools-protocol";

const EXEC_CONTEXT_ID = 1;

function readyPageScript(
  ctx: DispatchCtx,
  target: TargetState | null | undefined,
): Promise<PageScriptStub | null> {
  if (!target) return Promise.resolve(null);
  return sessionOf(ctx, target).ready();
}

function resolveExecutionContextFrame(
  target: TargetState | null | undefined,
  contextId: number | undefined,
): FrameState | null | false {
  if (!contextId || contextId === EXEC_CONTEXT_ID || contextId === ISOLATED_WORLD_CONTEXT_ID) {
    return null;
  }
  if (!target) return false;
  if ((target.isolatedWorlds ?? []).some((w) => w.id === contextId)) {
    return null;
  }
  for (const f of target.frames.values()) {
    if (f.execContextId === contextId) {
      return f;
    }
  }
  return false;
}

function assertLiveContextId(target: TargetState | null | undefined, id: unknown): void {
  if (typeof id !== "number" || !target) return;
  if (target.retiredContextIds?.has(id)) {
    throw new Error("Cannot find context with specified id");
  }
}

function throwIfContextDestroyed(
  owner: { pageScript?: unknown } | null | undefined,
  ps: unknown,
): void {
  if (owner && owner.pageScript !== ps) {
    throw new Error("Execution context was destroyed.");
  }
}

export function emitOopifExecutionContext(ctx: DispatchCtx, frame: FrameState): void {
  if (!frame.pageScript || frame.execContextId <= 0) return;
  for (const sid of ctx.browser.runtimeEnabledSessions) {
    ctx.emit({
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: frame.execContextId,
          origin: originOf(frame.url),
          name: frame.url,
          uniqueId: `ctx-oopif-${frame.execContextId}`,
          auxData: {
            isDefault: false,
            type: "default",
            frameId: frame.frameId,
          },
        },
      },
      sessionId: sid || undefined,
    });
  }
}

export function emitOopifExecutionContextDestroyed(ctx: DispatchCtx, execContextId: number): void {
  if (execContextId <= 0) return;
  for (const sid of ctx.browser.runtimeEnabledSessions) {
    ctx.emit({
      method: "Runtime.executionContextDestroyed",
      params: {
        executionContextId: execContextId,
        executionContextUniqueId: `ctx-oopif-${execContextId}`,
      },
      sessionId: sid || undefined,
    });
  }
}

export async function handleRuntime(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Runtime.enable": {
      const target = pickTarget(ctx, req.sessionId);
      const sidKey = req.sessionId ?? "";
      ctx.browser.runtimeEnabledSessions.add(sidKey);
      if (target && target.defaultContextId === 0) {
        target.defaultContextId = EXEC_CONTEXT_ID;
      }
      const defaultId = target?.defaultContextId || EXEC_CONTEXT_ID;
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: defaultId,
            origin: target ? originOf(target.url) : "",
            name: "",
            uniqueId: `ctx-${defaultId}`,
            auxData: {
              isDefault: true,
              type: "default",
              frameId: target?.frameId ?? "browser",
            },
          },
        },
        sessionId: req.sessionId,
      });
      for (const w of target?.isolatedWorlds ?? []) {
        ctx.emit({
          method: "Runtime.executionContextCreated",
          params: {
            context: {
              id: w.id,
              origin: target ? originOf(target.url) : "",
              name: w.name,
              uniqueId: `cs-iso-${target?.targetId ?? "?"}-${w.id}`,
              auxData: { isDefault: false, type: "isolated", frameId: w.frameId },
            },
          },
          sessionId: req.sessionId,
        });
      }
      if (target) {
        for (const f of target.frames.values()) {
          if (!f.pageScript || f.execContextId <= 0) continue;
          ctx.emit({
            method: "Runtime.executionContextCreated",
            params: {
              context: {
                id: f.execContextId,
                origin: originOf(f.url),
                name: f.url,
                uniqueId: `ctx-oopif-${f.execContextId}`,
                auxData: {
                  isDefault: false,
                  type: "default",
                  frameId: f.frameId,
                },
              },
            },
            sessionId: req.sessionId,
          });
        }
      }
      return {};
    }

    case "Runtime.disable":
    case "Runtime.discardConsoleEntries":
    case "Runtime.runIfWaitingForDebugger":
    case "Runtime.setAsyncCallStackDepth":
    case "Runtime.setCustomObjectFormatterEnabled":
      return {};

    case "Runtime.getHeapUsage": {
      const target = pickTarget(ctx, req.sessionId);
      if (!target || target.type !== "page") {
        return { usedSize: 0, totalSize: 0 };
      }
      const mem = await sessionOf(ctx, target).callIfLive.getMemoryStats({});
      const usedSize = typeof mem?.bytes === "number" ? mem.bytes : 0;
      return { usedSize, totalSize: usedSize };
    }

    case "Runtime.addBinding": {
      const name = (req.params as { name?: string } | undefined)?.name;
      if (typeof name === "string" && name.length > 0) {
        ctx.browser.pendingBindings.add(name);
        try {
          const target = pickTarget(ctx, req.sessionId);
          if (target?.blankReady) await target.blankReady;
          const ps = target?.pageScript;
          if (ps?.installBindings) await ps.installBindings([name]);
        } catch {}
      }
      return {};
    }
    case "Runtime.removeBinding": {
      const name = (req.params as { name?: string } | undefined)?.name;
      if (typeof name === "string") {
        ctx.browser.pendingBindings.delete(name);
      }
      return {};
    }

    case "Runtime.evaluate": {
      const expression = req.params!.expression;
      assertLiveContextId(
        (() => {
          try {
            return pickTarget(ctx, req.sessionId);
          } catch {
            return null;
          }
        })(),
        req.params?.contextId,
      );
      const returnByValue = Boolean(req.params?.returnByValue);
      const awaitPromise = Boolean(req.params?.awaitPromise);

      const target = pickTarget(ctx, req.sessionId);
      const requestedCtx = (req.params as { contextId?: number } | undefined)?.contextId;
      const oopifFrame = resolveExecutionContextFrame(target, requestedCtx);
      if (oopifFrame === false || (oopifFrame && !oopifFrame.pageScript)) {
        return loaderFailureResponse(
          new Error(`Runtime.evaluate: unknown or destroyed contextId ${requestedCtx}`),
        );
      }
      const oopifStub = oopifFrame ? oopifFrame.pageScript : null;

      const trivial = tryTrivial(expression);
      if (trivial !== undefined) {
        return remoteObjectFromValue(trivial, returnByValue);
      }
      const ps = oopifStub ?? (await readyPageScript(ctx, target));
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.evaluate requires an attached page target"),
        );
      }
      try {
        const result = await traceSpan(
          ctx.env.HOST_TRACER,
          "eval.pagescript_rpc",
          () => ps.evaluate(expression, { returnByValue, awaitPromise }),
          { exprBytes: expression.length, returnByValue, awaitPromise },
        );
        emitCapturedConsole(ctx, result.console, req.sessionId);
        if (!oopifStub) {
          replayReopenedLifecycle(ctx, target, result, req.sessionId);
        }
        applyCookieWrites(ctx, target, result.cookieWrites, ps, oopifFrame);
        if (!oopifStub && target) {
          emitMutations(ctx, target, result.cdpMutations);
        }
        return pageScriptResultToCdp(result, returnByValue);
      } catch (err) {
        throwIfContextDestroyed(oopifFrame || target, ps);
        return loaderFailureResponse(err);
      }
    }

    case "Runtime.callFunctionOn": {
      const functionDeclaration = req.params!.functionDeclaration;
      const returnByValue = Boolean(req.params?.returnByValue);
      const awaitPromise = Boolean(req.params?.awaitPromise);
      const argSpecs = encodeArgSpecs(req.params?.arguments);
      const objectId = req.params?.objectId;
      const thisObjectId =
        typeof objectId === "string" && objectId.startsWith("ps:") ? objectId : undefined;

      const target = pickTarget(ctx, req.sessionId);
      const requestedCtxCfn = (req.params as { executionContextId?: number } | undefined)
        ?.executionContextId;
      assertLiveContextId(target, requestedCtxCfn);
      const oopifFrameCfn = resolveExecutionContextFrame(target, requestedCtxCfn);
      if (oopifFrameCfn === false || (oopifFrameCfn && !oopifFrameCfn.pageScript)) {
        return loaderFailureResponse(
          new Error(
            `Runtime.callFunctionOn: unknown or destroyed executionContextId ${requestedCtxCfn}`,
          ),
        );
      }
      const oopifStubCfn = oopifFrameCfn ? oopifFrameCfn.pageScript : null;
      const ps = oopifStubCfn ?? (await readyPageScript(ctx, target));
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.callFunctionOn requires an attached page target"),
        );
      }
      try {
        const result = await traceSpan(
          ctx.env.HOST_TRACER,
          "eval.pagescript_rpc",
          () =>
            ps.callFunctionOn(functionDeclaration, argSpecs, {
              returnByValue,
              awaitPromise,
              thisObjectId,
            }),
          {
            fnBytes: functionDeclaration.length,
            argCount: argSpecs.length,
            returnByValue,
            awaitPromise,
          },
        );
        emitCapturedConsole(ctx, result.console, req.sessionId);
        if (!oopifStubCfn) {
          replayReopenedLifecycle(ctx, target, result, req.sessionId);
        }
        applyCookieWrites(ctx, target, result.cookieWrites, ps, oopifFrameCfn);
        if (!oopifStubCfn && target) {
          emitMutations(ctx, target, result.cdpMutations);
        }
        return pageScriptResultToCdp(result, returnByValue);
      } catch (err) {
        throwIfContextDestroyed(oopifFrameCfn || target, ps);
        return loaderFailureResponse(err);
      }
    }

    case "Runtime.getProperties": {
      const objectId = req.params?.objectId as string | undefined;
      if (typeof objectId !== "string" || !objectId.startsWith("ps:")) {
        return { result: [] };
      }
      const target = pickTarget(ctx, req.sessionId);
      const ps = target?.pageScript;
      if (!ps) return { result: [] };
      try {
        const { result: descriptors } = await ps.getProperties(objectId, {
          ownProperties: req.params?.ownProperties !== false,
        });
        const result = descriptors.map((d) => {
          const out: Record<string, unknown> = {
            name: d.name,
            configurable: d.configurable,
            enumerable: d.enumerable,
            isOwn: d.isOwn,
          };
          if (d.value) out.value = pageScriptResultToCdp(d.value, false).result;
          if (d.get) out.get = pageScriptResultToCdp(d.get, false).result;
          if (d.set) out.set = pageScriptResultToCdp(d.set, false).result;
          if (typeof d.writable === "boolean") out.writable = d.writable;
          return out;
        });
        return { result };
      } catch {
        return { result: [] };
      }
    }

    case "Runtime.releaseObject": {
      const objectId = req.params!.objectId;
      if (objectId.startsWith("ps:")) {
        const target = pickTarget(ctx, req.sessionId);
        const ps = target?.pageScript;
        if (ps) {
          try {
            await ps.releaseObject(objectId);
          } catch {}
        }
      }
      return {};
    }

    case "Runtime.compileScript": {
      const expression = req.params!.expression;
      const sourceURL = req.params!.sourceURL;
      const persistScript = req.params!.persistScript;
      const target = pickTarget(ctx, req.sessionId);
      const ps = await readyPageScript(ctx, target);
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.compileScript requires an attached page target"),
        );
      }
      try {
        const res = await ps.compileScript(expression, sourceURL, persistScript);
        if (!res.ok) {
          return {
            exceptionDetails: {
              exceptionId: 1,
              text: res.exception.text,
              lineNumber: 0,
              columnNumber: 0,
              exception: {
                type: "object",
                subtype: "error",
                className: res.exception.className,
                description: res.exception.stack || res.exception.message,
              },
            },
          };
        }
        if (res.scriptId === null) return {};
        const meta = makeCompiledScriptMeta(res.scriptId, expression, sourceURL);
        if (target) {
          target.compiledScripts.push(meta);
          if (hasDebuggerListeners(target)) {
            emitScriptParsedToSessions(ctx, target, meta);
          }
        }
        return { scriptId: res.scriptId };
      } catch (err) {
        return loaderFailureResponse(err);
      }
    }

    case "Runtime.runScript": {
      const scriptId = req.params!.scriptId;
      const returnByValue = Boolean(req.params?.returnByValue);
      const awaitPromise = Boolean(req.params?.awaitPromise);
      const target = pickTarget(ctx, req.sessionId);
      const ps = await readyPageScript(ctx, target);
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.runScript requires an attached page target"),
        );
      }
      try {
        const result = await ps.runScript(scriptId, {
          returnByValue,
          awaitPromise,
        });
        emitCapturedConsole(ctx, result.console, req.sessionId);
        replayReopenedLifecycle(ctx, target, result, req.sessionId);
        applyCookieWrites(ctx, target, result.cookieWrites, ps, null);
        if (target) emitMutations(ctx, target, result.cdpMutations);
        return pageScriptResultToCdp(result, returnByValue);
      } catch (err) {
        return loaderFailureResponse(err);
      }
    }

    case "Runtime.releaseObjectGroup":
    case "Runtime.awaitPromise":
    case "Runtime.queryObjects":
      return {};

    default:
      return {};
  }
}

// Writes go under the url of the document that answered. target.url may already name the next
// document while the old isolate still answers, so a main-frame reply uses the isolate's sealed
// url and a frame reply uses the url sealed with its installed stub, and a reply from an isolate
// that was replaced while it ran is dropped.
function applyCookieWrites(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  cookieWrites: string[] | undefined,
  ps: PageScriptStub,
  oopifFrame: FrameState | null,
): void {
  if (!target || !cookieWrites || cookieWrites.length === 0) return;
  if ((oopifFrame ?? target).pageScript !== ps) return;
  const url = oopifFrame ? oopifFrame.pageScriptUrl : target.pageScriptUrl;
  if (!url) return;
  const jar = jarForTarget(ctx, target);
  for (const raw of cookieWrites) {
    jar.setFromDocumentCookie(url, raw);
  }
}

function emitCapturedConsole(
  ctx: DispatchCtx,
  entries: ConsoleEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  const target = pickTarget(ctx, sessionId);
  const ctxId = target?.defaultContextId || 1;
  for (const e of entries) {
    const ev = consoleEntryToCdpEvent(e, ctxId);
    ctx.emit({ method: ev.method, params: ev.params, sessionId });
  }
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined) {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function tryTrivial(expr: string): unknown {
  const e = expr.trim().replace(/;$/, "");
  if (e === "1+1") return 2;
  if (e === "true") return true;
  if (e === "false") return false;
  if (e === "null") return null;
  const lit = /^"([^"\\]*)"$/.exec(e) ?? /^'([^'\\]*)'$/.exec(e);
  if (lit) return lit[1];
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  return undefined;
}

function encodeArgSpecs(
  args:
    | Array<{
        value?: unknown;
        objectId?: string;
        unserializableValue?: string;
      }>
    | undefined,
): Array<{ json?: string; objectId?: string }> {
  if (!args) return [];
  return args.map((a) => {
    if (typeof a.objectId === "string" && a.objectId.startsWith("ps:")) {
      return { objectId: a.objectId };
    }
    if ("value" in a) {
      try {
        const json = JSON.stringify(a.value);
        return json === undefined ? {} : { json };
      } catch {
        return { json: "null" };
      }
    }
    if (typeof a.objectId === "string" || typeof a.unserializableValue === "string") {
      return { json: "null" };
    }
    return {};
  });
}

function loaderFailureResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    result: {
      type: "object",
      subtype: "error",
      className: "EvalLoaderError",
      description: message,
    },
    exceptionDetails: {
      exceptionId: 1,
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: "object",
        subtype: "error",
        className: "EvalLoaderError",
        description: message,
      },
    },
  };
}

export function remoteObjectFromValue(
  value: unknown,
  returnByValue: boolean,
): Protocol.Runtime.EvaluateResponse {
  const type = typeOf(value);
  if (returnByValue) {
    return { result: { type, value } };
  }
  if (type !== "object" && type !== "function") {
    return { result: { type, value } };
  }
  return {
    result: {
      type,
      value,
      objectId: crypto.randomUUID(),
      description: type,
    },
  };
}

function typeOf(v: unknown): Protocol.Runtime.RemoteObject["type"] {
  if (v === null) return "object";
  switch (typeof v) {
    case "object":
      return "object";
    case "function":
      return "function";
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "symbol":
      return "symbol";
    case "bigint":
      return "bigint";
    default:
      throw new Error("Unexpected JavaScript typeof result");
  }
}

function emitScriptParsedToSessions(
  ctx: DispatchCtx,
  target: TargetState,
  meta: ReturnType<typeof makeCompiledScriptMeta>,
): void {
  for (const sessionId of target.debuggerEnabledSessions) {
    emitScriptParsed(
      ctx,
      meta,
      sessionId === "" ? undefined : sessionId,
      target.frameId,
      target.defaultContextId || undefined,
    );
  }
}

export function replayReopenedLifecycle(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  result: { documentReopened?: boolean },
  sessionId: string | undefined,
): void {
  if (!result.documentReopened || !target || target.type !== "page") return;
  const frame = target.frames.get(target.frameId);
  if (!frame) return;
  emitFrameDclComplete(ctx, target, frame, sessionId);
  emitFrameLoadComplete(ctx, target, frame, sessionId);
}
