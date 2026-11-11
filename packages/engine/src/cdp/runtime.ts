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

// PageScript stamps its own isolate into every handle (`ps:<stamp>:<seq>`) and compiled script
// (`cs:<stamp>:<seq>`), so an id names the isolate that minted it. Isolate sequences restart at
// one, so the stamp is what keeps a replaced or sibling isolate's ids from being reused.
const STAMPED_REMOTE_ID = /^(?:ps|cs):([^:]+):(\d+)$/;

function stubForStamp(
  target: TargetState | null | undefined,
  stamp: string,
  mainStub: PageScriptStub | null,
): PageScriptStub | null {
  if (mainStub?.isolateStamp === stamp) return mainStub;
  if (!target) return null;
  for (const frame of target.frames.values()) {
    if (frame.pageScript?.isolateStamp === stamp) return frame.pageScript;
  }
  return null;
}

// Resolves an id to the isolate that minted it: the ready main stub or a live child frame stub.
// A stamp that names any other isolate belongs to one that was replaced or destroyed, so its ids
// must not be replayed in the isolate that answers now.
function liveOwnerStubOfId(
  target: TargetState | null | undefined,
  id: unknown,
  mainStub: PageScriptStub | null,
): PageScriptStub | null {
  if (typeof id !== "string") return null;
  const match = STAMPED_REMOTE_ID.exec(id);
  return match ? stubForStamp(target, match[1]!, mainStub) : null;
}

function ownerStubOfId(target: TargetState | null | undefined, id: unknown): PageScriptStub | null {
  return liveOwnerStubOfId(target, id, target?.pageScript ?? null);
}

function frameOfStub(
  target: TargetState | null | undefined,
  stub: PageScriptStub,
): FrameState | null {
  if (!target) return null;
  for (const frame of target.frames.values()) {
    if (frame.pageScript === stub) return frame;
  }
  return null;
}

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
  const world = (target.isolatedWorlds ?? []).find((w) => w.id === contextId);
  if (world) {
    // A world belongs to a frame. Only an out-of-process child has its own isolate; the root
    // frame and frames the main isolate hosts keep using the main isolate. A cross-origin frame
    // without a live isolate must not fall back to its embedder's.
    const frame = target.frames.get(world.frameId);
    // A world names a frame the target must still know; otherwise the context is gone.
    if (!frame) return false;
    if (frame.frameId !== target.frameId) {
      if (frame.pageScript) return frame;
      if (frame.isCrossOrigin) return false;
    }
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
          origin: frame.sandbox.sameOrigin ? originOf(frame.url) : "://",
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
                origin: f.sandbox.sameOrigin ? originOf(f.url) : "://",
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
      const objectId = req.params?.objectId;

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
      // A main-isolate call must use the ready stub: a pending about:blank setup or a navigation
      // can still replace target.pageScript after this request arrives. An explicit child isolate
      // answers for itself and is not gated on the main one.
      const childStub = oopifFrameCfn ? oopifFrameCfn.pageScript : null;
      const mainStub = childStub
        ? (target?.pageScript ?? null)
        : await readyPageScript(ctx, target);
      const receiverStub =
        typeof objectId === "string" && objectId.startsWith("ps:")
          ? liveOwnerStubOfId(target, objectId, mainStub)
          : null;
      if (typeof objectId === "string" && objectId.startsWith("ps:") && !receiverStub) {
        return loaderFailureResponse(
          new Error("Runtime.callFunctionOn: unknown or destroyed objectId"),
        );
      }
      const contextStub = childStub ?? mainStub;
      if (receiverStub && typeof requestedCtxCfn === "number" && requestedCtxCfn > 0) {
        if (contextStub !== receiverStub) {
          return loaderFailureResponse(
            new Error("Runtime.callFunctionOn: objectId belongs to another execution context"),
          );
        }
      }
      const ps = receiverStub ?? contextStub;
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.callFunctionOn requires an attached page target"),
        );
      }
      const argSpecs = encodeArgSpecs(req.params?.arguments, target, ps);
      if (!argSpecs) {
        return loaderFailureResponse(
          new Error("Runtime.callFunctionOn: argument belongs to another execution context"),
        );
      }
      const thisObjectId = receiverStub ? objectId : undefined;
      const childFrame =
        ps === target?.pageScript ? null : (oopifFrameCfn ?? frameOfStub(target, ps));
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
        if (!childFrame) {
          replayReopenedLifecycle(ctx, target, result, req.sessionId);
        }
        applyCookieWrites(ctx, target, result.cookieWrites, ps, childFrame);
        if (!childFrame && target) {
          emitMutations(ctx, target, result.cdpMutations);
        }
        return pageScriptResultToCdp(result, returnByValue);
      } catch (err) {
        throwIfContextDestroyed(childFrame || target, ps);
        return loaderFailureResponse(err);
      }
    }

    case "Runtime.getProperties": {
      const objectId = req.params?.objectId as string | undefined;
      if (typeof objectId !== "string" || !objectId.startsWith("ps:")) {
        return { result: [] };
      }
      const target = pickTarget(ctx, req.sessionId);
      const ps = ownerStubOfId(target, objectId);
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
        const ps = ownerStubOfId(pickTarget(ctx, req.sessionId), objectId);
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
      const requestedCtxCompile = (req.params as { executionContextId?: number } | undefined)
        ?.executionContextId;
      const oopifFrameCompile = resolveExecutionContextFrame(target, requestedCtxCompile);
      if (oopifFrameCompile === false || (oopifFrameCompile && !oopifFrameCompile.pageScript)) {
        return loaderFailureResponse(
          new Error(
            `Runtime.compileScript: unknown or destroyed executionContextId ${requestedCtxCompile}`,
          ),
        );
      }
      const ps = oopifFrameCompile?.pageScript ?? (await readyPageScript(ctx, target));
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
            emitScriptParsedToSessions(ctx, target, meta, oopifFrameCompile);
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
      const requestedCtxRun = (req.params as { executionContextId?: number } | undefined)
        ?.executionContextId;
      const oopifFrameRun = resolveExecutionContextFrame(target, requestedCtxRun);
      if (oopifFrameRun === false || (oopifFrameRun && !oopifFrameRun.pageScript)) {
        return loaderFailureResponse(
          new Error(
            `Runtime.runScript: unknown or destroyed executionContextId ${requestedCtxRun}`,
          ),
        );
      }
      // A persisted script runs in the isolate that compiled it; a supplied context cannot move
      // it to another one. The main isolate must be the ready stub, so a script minted by an
      // isolate a pending navigation replaced is rejected instead of running in the outgoing one.
      const childStub = oopifFrameRun ? oopifFrameRun.pageScript : null;
      const mainStub = childStub
        ? (target?.pageScript ?? null)
        : await readyPageScript(ctx, target);
      const stampedScript = typeof scriptId === "string" && STAMPED_REMOTE_ID.test(scriptId);
      const scriptOwner = stampedScript ? liveOwnerStubOfId(target, scriptId, mainStub) : null;
      if (stampedScript && !scriptOwner) {
        return loaderFailureResponse(new Error("Runtime.runScript: unknown or destroyed scriptId"));
      }
      if (scriptOwner && typeof requestedCtxRun === "number" && requestedCtxRun > 0) {
        const contextStub = childStub ?? mainStub;
        if (contextStub !== scriptOwner) {
          return loaderFailureResponse(
            new Error("Runtime.runScript: script belongs to another execution context"),
          );
        }
      }
      const ps = scriptOwner ?? childStub ?? mainStub;
      if (!ps) {
        return loaderFailureResponse(
          new Error("Runtime.runScript requires an attached page target"),
        );
      }
      const childFrame =
        ps === target?.pageScript ? null : (oopifFrameRun ?? frameOfStub(target, ps));
      try {
        const result = await ps.runScript(scriptId, {
          returnByValue,
          awaitPromise,
        });
        emitCapturedConsole(ctx, result.console, req.sessionId);
        if (!childFrame) replayReopenedLifecycle(ctx, target, result, req.sessionId);
        applyCookieWrites(ctx, target, result.cookieWrites, ps, childFrame);
        if (!childFrame && target) emitMutations(ctx, target, result.cdpMutations);
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
  target: TargetState | undefined,
  owner: PageScriptStub,
): Array<{ json?: string; objectId?: string }> | null {
  if (!args) return [];
  const specs: Array<{ json?: string; objectId?: string }> = [];
  for (const a of args) {
    if (typeof a.objectId === "string" && a.objectId.startsWith("ps:")) {
      // An argument object must live in the isolate the function runs in.
      if (ownerStubOfId(target, a.objectId) !== owner) return null;
      specs.push({ objectId: a.objectId });
      continue;
    }
    if ("value" in a) {
      try {
        const json = JSON.stringify(a.value);
        specs.push(json === undefined ? {} : { json });
      } catch {
        specs.push({ json: "null" });
      }
      continue;
    }
    if (typeof a.objectId === "string" || typeof a.unserializableValue === "string") {
      specs.push({ json: "null" });
      continue;
    }
    specs.push({});
  }
  return specs;
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
  frame?: FrameState | null,
): void {
  for (const sessionId of target.debuggerEnabledSessions) {
    emitScriptParsed(
      ctx,
      meta,
      sessionId === "" ? undefined : sessionId,
      frame?.frameId ?? target.frameId,
      frame ? frame.execContextId || undefined : target.defaultContextId || undefined,
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
