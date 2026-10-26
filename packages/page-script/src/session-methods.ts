// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Maps retained-session wire calls to typed PageScript methods and per-call context.

import type {
  PageScriptArgBuilders,
  PageScriptMethod,
  PageScriptReply,
  PageScriptSession,
  PageScriptWireParams,
  WireMeta,
} from "@kitesurf/jsrpc-types/page-script";
import { drainDeferParked } from "./defer-shim.ts";
import { state } from "./state.ts";
import { noteSyncOp } from "./lag-monitor.ts";
import { set_ks_trace_parent } from "./wasm-glue.js";
import { ksInternals } from "./internals.ts";

type ReceivedMeta = Partial<WireMeta>;
type MethodArguments<M extends PageScriptMethod> = Parameters<PageScriptSession[M]>;

export function updateClockFloor(timestamp: unknown): void {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
  if (!ksInternals.clockFloorMs || timestamp > ksInternals.clockFloorMs) {
    ksInternals.clockFloorMs = timestamp;
  }
}

export function enterMethodScope(meta: ReceivedMeta): void {
  const traceParent = typeof meta.tp === "string" ? meta.tp : "";
  ksInternals.traceParent = traceParent;
  try {
    set_ks_trace_parent(traceParent);
  } catch {}
  updateClockFloor(meta.t);

  // Upgrade callbacks before parked I/O; connected callbacks can start requests.
  try {
    state.drainCustomElementUpgrades?.();
  } catch {}

  drainDeferParked();
}

export const PAGE_SCRIPT_METHODS: PageScriptArgBuilders = {
  navigate: (params): MethodArguments<"navigate"> => [params.html, params.url, params.opts],
  awaitLoad: (): MethodArguments<"awaitLoad"> => [],
  unload: (): MethodArguments<"unload"> => [],
  drainConsole: (): MethodArguments<"drainConsole"> => [],
  syncCookies: (params): MethodArguments<"syncCookies"> => [params.cookies],
  installBindings: (params): MethodArguments<"installBindings"> => [params.names],
  installIframeContent: (params): MethodArguments<"installIframeContent"> => [params],
  iframeInstallsSettled: (): MethodArguments<"iframeInstallsSettled"> => [],
  setFrameBitmap: (params): MethodArguments<"setFrameBitmap"> => [params],
  deliverMessage: (params): MethodArguments<"deliverMessage"> => [params],
  deliverWorkerEvent: (params): MethodArguments<"deliverWorkerEvent"> => [params],
  evaluate: (params): MethodArguments<"evaluate"> => [params.expression, params.opts ?? {}],
  callFunctionOn: (params): MethodArguments<"callFunctionOn"> => [
    params.functionDeclaration,
    params.argSpecs ?? [],
    params.opts ?? {},
  ],
  releaseObject: (params): MethodArguments<"releaseObject"> => [params.objectId],
  getProperties: (params): MethodArguments<"getProperties"> => [params.objectId, params.opts ?? {}],
  compileScript: (params): MethodArguments<"compileScript"> => [
    params.expression,
    params.sourceURL,
    params.persistScript,
  ],
  runScript: (params): MethodArguments<"runScript"> => [params.scriptId, params.opts ?? {}],
  queryDom: (params): MethodArguments<"queryDom"> => [params.method, params.args ?? {}],
  dispatchMouseEvent: (params): MethodArguments<"dispatchMouseEvent"> => [
    params.type,
    params.init ?? {},
  ],
  dispatchKeyEvent: (params): MethodArguments<"dispatchKeyEvent"> => [
    params.type,
    params.init ?? {},
  ],
};

export async function invokeSessionMethod<M extends PageScriptMethod>(
  self: PageScriptSession,
  method: M,
  params: PageScriptWireParams[M],
  meta: ReceivedMeta = {},
): Promise<PageScriptReply<M>> {
  enterMethodScope(meta);
  const argBuilder = PAGE_SCRIPT_METHODS[method];
  if (!argBuilder) throw new Error("unknown method: " + method);
  noteSyncOp(
    method === "queryDom"
      ? `rpc:queryDom:${(params as PageScriptWireParams["queryDom"]).method}`
      : `rpc:${method}`,
  );
  try {
    const args = argBuilder(params);
    const methodHandler = self[method];
    if (typeof methodHandler !== "function") {
      throw new Error("method not callable: " + method);
    }
    type Handler = (
      ...handlerArgs: Parameters<PageScriptSession[M]>
    ) => Promise<PageScriptReply<M>>;
    return await (methodHandler as Handler).apply(self, args);
  } finally {
    if (method === "navigate") state.settleLoadCompletionArmed();
  }
}
