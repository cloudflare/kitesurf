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
type EvaluationRequest = Extract<
  CdpRequest,
  { method: "Runtime.evaluate" | "Runtime.callFunctionOn" }
>;

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
    case "Runtime.enable":
      return enableRuntime(ctx, req);

    case "Runtime.disable":
    case "Runtime.discardConsoleEntries":
    case "Runtime.runIfWaitingForDebugger":
    case "Runtime.setAsyncCallStackDepth":
    case "Runtime.setCustomObjectFormatterEnabled":
      return {};

    case "Runtime.getHeapUsage":
      return getHeapUsage(ctx, req.sessionId);

    case "Runtime.addBinding":
      return addBinding(ctx, req);
    case "Runtime.removeBinding":
      return removeBinding(ctx, req);

    case "Runtime.evaluate":
      return evaluateExpression(ctx, req);

    case "Runtime.callFunctionOn":
      return callFunctionOn(ctx, req);

    case "Runtime.getProperties":
      return getProperties(ctx, req);

    case "Runtime.releaseObject":
      return releaseObject(ctx, req);

    case "Runtime.compileScript":
      return compileScript(ctx, req);

    case "Runtime.runScript":
      return runScript(ctx, req);

    case "Runtime.releaseObjectGroup":
    case "Runtime.awaitPromise":
    case "Runtime.queryObjects":
      return {};

    default:
      return {};
  }
}

function enableRuntime(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.enable" }>,
): Record<string, never> {
  const target = pickTarget(ctx, req.sessionId);
  const sessionKey = req.sessionId ?? "";
  ctx.browser.runtimeEnabledSessions.add(sessionKey);
  if (target && target.defaultContextId === 0) target.defaultContextId = EXEC_CONTEXT_ID;
  emitDefaultExecutionContext(ctx, target, req.sessionId);
  emitIsolatedExecutionContexts(ctx, target, req.sessionId);
  emitOopifExecutionContexts(ctx, target, req.sessionId);
  return {};
}

function emitDefaultExecutionContext(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  sessionId: string | undefined,
): void {
  const defaultId = defaultExecutionContextId(target);
  ctx.emit({
    method: "Runtime.executionContextCreated",
    params: {
      context: {
        id: defaultId,
        origin: executionContextOrigin(target),
        name: "",
        uniqueId: `ctx-${defaultId}`,
        auxData: {
          isDefault: true,
          type: "default",
          frameId: defaultExecutionContextFrameId(target),
        },
      },
    },
    sessionId,
  });
}

function defaultExecutionContextId(target: TargetState | undefined): number {
  return target?.defaultContextId || EXEC_CONTEXT_ID;
}

function executionContextOrigin(target: TargetState | undefined): string {
  return target ? originOf(target.url) : "";
}

function defaultExecutionContextFrameId(target: TargetState | undefined): string {
  return target?.frameId ?? "browser";
}

function emitIsolatedExecutionContexts(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  sessionId: string | undefined,
): void {
  const worlds = isolatedWorlds(target);
  for (const world of worlds) {
    ctx.emit({
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: world.id,
          origin: executionContextOrigin(target),
          name: world.name,
          uniqueId: isolatedWorldUniqueId(target, world.id),
          auxData: { isDefault: false, type: "isolated", frameId: world.frameId },
        },
      },
      sessionId,
    });
  }
}

function isolatedWorlds(target: TargetState | undefined) {
  return target?.isolatedWorlds ?? [];
}

function isolatedWorldUniqueId(target: TargetState | undefined, worldId: number): string {
  return `cs-iso-${target?.targetId ?? "?"}-${worldId}`;
}

function emitOopifExecutionContexts(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  sessionId: string | undefined,
): void {
  if (!target) return;
  for (const frame of target.frames.values()) {
    if (!frame.pageScript || frame.execContextId <= 0) continue;
    ctx.emit({
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: frame.execContextId,
          origin: originOf(frame.url),
          name: frame.url,
          uniqueId: `ctx-oopif-${frame.execContextId}`,
          auxData: { isDefault: false, type: "default", frameId: frame.frameId },
        },
      },
      sessionId,
    });
  }
}

async function getHeapUsage(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): Promise<{ usedSize: number; totalSize: number }> {
  const target = pickTarget(ctx, sessionId);
  if (!isPageTarget(target)) return { usedSize: 0, totalSize: 0 };
  const memory = await sessionOf(ctx, target).callIfLive.getMemoryStats({});
  const usedSize = typeof memory?.bytes === "number" ? memory.bytes : 0;
  return { usedSize, totalSize: usedSize };
}

function isPageTarget(target: TargetState | undefined): target is TargetState {
  return target !== undefined && target.type === "page";
}

async function addBinding(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.addBinding" }>,
): Promise<Record<string, never>> {
  const name = bindingName(req.params?.name);
  if (name === null) return {};
  ctx.browser.pendingBindings.add(name);
  await installBinding(ctx, req.sessionId, name);
  return {};
}

function bindingName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

async function installBinding(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  name: string,
): Promise<void> {
  try {
    const target = pickTarget(ctx, sessionId);
    await waitForBlankPageScript(target);
    const pageScript = target?.pageScript;
    if (pageScript?.installBindings) await pageScript.installBindings([name]);
  } catch {}
}

async function waitForBlankPageScript(target: TargetState | undefined): Promise<void> {
  const blankReady = target?.blankReady;
  if (blankReady) await blankReady;
}

function removeBinding(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.removeBinding" }>,
): Record<string, never> {
  const name = req.params?.name;
  if (typeof name === "string") ctx.browser.pendingBindings.delete(name);
  return {};
}

async function evaluateExpression(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.evaluate" }>,
): Promise<unknown> {
  const params = req.params!;
  const expression = params.expression;
  const contextId = params.contextId;
  assertLiveContextId(contextCheckTarget(ctx, req.sessionId), contextId);
  const target = pickTarget(ctx, req.sessionId);
  const oopifFrame = resolveExecutionContextFrame(target, contextId);
  if (isInvalidExecutionContextFrame(oopifFrame)) {
    return loaderFailureResponse(
      new Error(`Runtime.evaluate: unknown or destroyed contextId ${contextId}`),
    );
  }
  const trivial = tryTrivial(expression);
  if (trivial !== undefined) return remoteObjectFromValue(trivial, Boolean(params.returnByValue));
  const pageScript = await pageScriptForContext(ctx, target, oopifFrame);
  if (!pageScript) {
    return loaderFailureResponse(new Error("Runtime.evaluate requires an attached page target"));
  }
  return runEvaluation(ctx, req, target, oopifFrame, pageScript);
}

function contextCheckTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | null | undefined {
  try {
    return pickTarget(ctx, sessionId);
  } catch {
    return null;
  }
}

function isInvalidExecutionContextFrame(
  frame: FrameState | null | false,
): frame is false | (FrameState & { pageScript: null }) {
  if (frame === false) return true;
  return frame !== null && !frame.pageScript;
}

async function pageScriptForContext(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  frame: FrameState | null,
): Promise<PageScriptStub | null> {
  if (frame) return frame.pageScript;
  return readyPageScript(ctx, target);
}

async function runEvaluation(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.evaluate" }>,
  target: TargetState | undefined,
  frame: FrameState | null,
  pageScript: PageScriptStub,
): Promise<unknown> {
  const params = req.params!;
  try {
    const result = await traceSpan(
      ctx.env.HOST_TRACER,
      "eval.pagescript_rpc",
      () =>
        pageScript.evaluate(params.expression, {
          returnByValue: Boolean(params.returnByValue),
          awaitPromise: Boolean(params.awaitPromise),
        }),
      {
        exprBytes: params.expression.length,
        returnByValue: Boolean(params.returnByValue),
        awaitPromise: Boolean(params.awaitPromise),
      },
    );
    return completeEvaluation(ctx, req, target, frame, result);
  } catch (error) {
    throwIfContextDestroyed(frame || target, pageScript);
    return loaderFailureResponse(error);
  }
}

function completeEvaluation(
  ctx: DispatchCtx,
  req: EvaluationRequest,
  target: TargetState | undefined,
  frame: FrameState | null,
  result: Awaited<ReturnType<PageScriptStub["evaluate"]>>,
): Protocol.Runtime.EvaluateResponse {
  const returnByValue = Boolean(req.params!.returnByValue);
  emitCapturedConsole(ctx, result.console, req.sessionId);
  if (frame === null) replayReopenedLifecycle(ctx, target, result, req.sessionId);
  applyCookieWrites(ctx, target, result.cookieWrites, frame ? frame.url : undefined);
  if (frame === null && target) emitMutations(ctx, target, result.cdpMutations);
  return pageScriptResultToCdp(result, returnByValue);
}

async function callFunctionOn(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.callFunctionOn" }>,
): Promise<unknown> {
  const params = req.params!;
  const target = pickTarget(ctx, req.sessionId);
  const executionContextId = params.executionContextId;
  assertLiveContextId(target, executionContextId);
  const oopifFrame = resolveExecutionContextFrame(target, executionContextId);
  if (isInvalidExecutionContextFrame(oopifFrame)) {
    return loaderFailureResponse(
      new Error(
        `Runtime.callFunctionOn: unknown or destroyed executionContextId ${executionContextId}`,
      ),
    );
  }
  const pageScript = await pageScriptForContext(ctx, target, oopifFrame);
  if (!pageScript) {
    return loaderFailureResponse(
      new Error("Runtime.callFunctionOn requires an attached page target"),
    );
  }
  const argSpecs = encodeArgSpecs(params.arguments);
  const thisObjectId = pageScriptObjectId(params.objectId);
  return runFunctionOn(ctx, req, target, oopifFrame, pageScript, argSpecs, thisObjectId);
}

function pageScriptObjectId(value: string | undefined): string | undefined {
  if (typeof value === "string" && value.startsWith("ps:")) return value;
  return undefined;
}

async function runFunctionOn(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.callFunctionOn" }>,
  target: TargetState | undefined,
  frame: FrameState | null,
  pageScript: PageScriptStub,
  argSpecs: Array<{ json?: string; objectId?: string }>,
  thisObjectId: string | undefined,
): Promise<unknown> {
  const params = req.params!;
  try {
    const result = await traceSpan(
      ctx.env.HOST_TRACER,
      "eval.pagescript_rpc",
      () =>
        pageScript.callFunctionOn(params.functionDeclaration, argSpecs, {
          returnByValue: Boolean(params.returnByValue),
          awaitPromise: Boolean(params.awaitPromise),
          thisObjectId,
        }),
      {
        fnBytes: params.functionDeclaration.length,
        argCount: argSpecs.length,
        returnByValue: Boolean(params.returnByValue),
        awaitPromise: Boolean(params.awaitPromise),
      },
    );
    return completeEvaluation(ctx, req, target, frame, result);
  } catch (error) {
    throwIfContextDestroyed(frame || target, pageScript);
    return loaderFailureResponse(error);
  }
}

async function getProperties(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.getProperties" }>,
): Promise<{ result: Record<string, unknown>[] }> {
  const objectId = runtimeObjectId(req.params?.objectId);
  if (objectId === null) return { result: [] };
  const pageScript = pageScriptForTarget(pickTarget(ctx, req.sessionId));
  if (!pageScript) return { result: [] };
  try {
    const { result: descriptors } = await pageScript.getProperties(objectId, {
      ownProperties: req.params?.ownProperties !== false,
    });
    return { result: descriptors.map(propertyDescriptorToCdp) };
  } catch {
    return { result: [] };
  }
}

function runtimeObjectId(value: string | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("ps:")) return null;
  return value;
}

function pageScriptForTarget(target: TargetState | undefined): PageScriptStub | null {
  return target?.pageScript ?? null;
}

type PropertyDescriptor = Awaited<ReturnType<PageScriptStub["getProperties"]>>["result"][number];

function propertyDescriptorToCdp(descriptor: PropertyDescriptor): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: descriptor.name,
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    isOwn: descriptor.isOwn,
  };
  if (descriptor.value) output.value = pageScriptResultToCdp(descriptor.value, false).result;
  if (descriptor.get) output.get = pageScriptResultToCdp(descriptor.get, false).result;
  if (descriptor.set) output.set = pageScriptResultToCdp(descriptor.set, false).result;
  if (typeof descriptor.writable === "boolean") output.writable = descriptor.writable;
  return output;
}

async function releaseObject(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.releaseObject" }>,
): Promise<Record<string, never>> {
  const objectId = req.params!.objectId;
  if (objectId.startsWith("ps:")) await releasePageScriptObject(ctx, req.sessionId, objectId);
  return {};
}

async function releasePageScriptObject(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  objectId: string,
): Promise<void> {
  const pageScript = pageScriptForTarget(pickTarget(ctx, sessionId));
  if (!pageScript) return;
  try {
    await pageScript.releaseObject(objectId);
  } catch {}
}

async function compileScript(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.compileScript" }>,
): Promise<unknown> {
  const params = req.params!;
  const target = pickTarget(ctx, req.sessionId);
  const pageScript = await readyPageScript(ctx, target);
  if (!pageScript) {
    return loaderFailureResponse(
      new Error("Runtime.compileScript requires an attached page target"),
    );
  }
  try {
    const result = await pageScript.compileScript(
      params.expression,
      params.sourceURL,
      params.persistScript,
    );
    return registerCompiledScript(ctx, target, params.expression, params.sourceURL, result);
  } catch (error) {
    return loaderFailureResponse(error);
  }
}

function registerCompiledScript(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  expression: string,
  sourceURL: string,
  result: Awaited<ReturnType<PageScriptStub["compileScript"]>>,
): unknown {
  if (!result.ok) return compileScriptException(result.exception);
  if (result.scriptId === null) return {};
  const meta = makeCompiledScriptMeta(result.scriptId, expression, sourceURL);
  registerScriptMeta(ctx, target, meta);
  return { scriptId: result.scriptId };
}

function compileScriptException(
  exception: Extract<
    Awaited<ReturnType<PageScriptStub["compileScript"]>>,
    { ok: false }
  >["exception"],
): unknown {
  return {
    exceptionDetails: {
      exceptionId: 1,
      text: exception.text,
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: "object",
        subtype: "error",
        className: exception.className,
        description: exception.stack || exception.message,
      },
    },
  };
}

function registerScriptMeta(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  meta: ReturnType<typeof makeCompiledScriptMeta>,
): void {
  if (!target) return;
  target.compiledScripts.push(meta);
  if (hasDebuggerListeners(target)) emitScriptParsedToSessions(ctx, target, meta);
}

async function runScript(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.runScript" }>,
): Promise<unknown> {
  const params = req.params!;
  const target = pickTarget(ctx, req.sessionId);
  const pageScript = await readyPageScript(ctx, target);
  if (!pageScript) {
    return loaderFailureResponse(new Error("Runtime.runScript requires an attached page target"));
  }
  try {
    const result = await pageScript.runScript(params.scriptId, {
      returnByValue: Boolean(params.returnByValue),
      awaitPromise: Boolean(params.awaitPromise),
    });
    return completeRunScript(ctx, req, target, result);
  } catch (error) {
    return loaderFailureResponse(error);
  }
}

function completeRunScript(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Runtime.runScript" }>,
  target: TargetState | undefined,
  result: Awaited<ReturnType<PageScriptStub["runScript"]>>,
): Protocol.Runtime.EvaluateResponse {
  const returnByValue = Boolean(req.params!.returnByValue);
  emitCapturedConsole(ctx, result.console, req.sessionId);
  replayReopenedLifecycle(ctx, target, result, req.sessionId);
  applyCookieWrites(ctx, target, result.cookieWrites);
  if (target) emitMutations(ctx, target, result.cdpMutations);
  return pageScriptResultToCdp(result, returnByValue);
}

function applyCookieWrites(
  ctx: DispatchCtx,
  target: TargetState | undefined,
  cookieWrites: string[] | undefined,
  urlOverride?: string,
): void {
  if (!target) return;
  if (!hasCookieWrites(cookieWrites)) return;
  const url = cookieWriteUrl(target, urlOverride);
  if (!url) return;
  const jar = jarForTarget(ctx, target);
  for (const raw of cookieWrites) {
    jar.setFromDocumentCookie(url, raw);
  }
}

function cookieWriteUrl(target: TargetState, urlOverride: string | undefined): string {
  return urlOverride || target.url;
}

function hasCookieWrites(cookieWrites: string[] | undefined): cookieWrites is string[] {
  return cookieWrites !== undefined && cookieWrites.length > 0;
}

function emitCapturedConsole(
  ctx: DispatchCtx,
  entries: ConsoleEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!hasConsoleEntries(entries)) return;
  const target = pickTarget(ctx, sessionId);
  const ctxId = target?.defaultContextId || 1;
  for (const entry of entries) {
    const ev = consoleEntryToCdpEvent(entry, ctxId);
    ctx.emit({ method: ev.method, params: ev.params, sessionId });
  }
}

function hasConsoleEntries(entries: ConsoleEntry[] | undefined): entries is ConsoleEntry[] {
  return entries !== undefined && entries.length > 0;
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined) {
  return findSessionTarget(ctx, sessionId) ?? firstPageTarget(ctx);
}

function findSessionTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | undefined {
  if (!sessionId) return undefined;
  for (const target of ctx.browser.targets.values()) {
    if (target.sessions.has(sessionId)) return target;
  }
  return undefined;
}

function firstPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const target of ctx.browser.targets.values()) {
    if (target.type === "page") return target;
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
  args: Protocol.Runtime.CallArgument[] | undefined,
): Array<{ json?: string; objectId?: string }> {
  if (!args) return [];
  return args.map(encodeArgSpec);
}

function encodeArgSpec(argument: Protocol.Runtime.CallArgument): {
  json?: string;
  objectId?: string;
} {
  const objectId = pageScriptObjectId(argument.objectId);
  if (objectId) return { objectId };
  if ("value" in argument) return jsonArgValue(argument.value);
  if (hasUnserializableArgReference(argument)) return { json: "null" };
  return {};
}

function jsonArgValue(value: unknown): { json?: string } {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? {} : { json };
  } catch {
    return { json: "null" };
  }
}

function hasUnserializableArgReference(argument: Protocol.Runtime.CallArgument): boolean {
  return typeof argument.objectId === "string" || typeof argument.unserializableValue === "string";
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
