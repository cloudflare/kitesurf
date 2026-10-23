// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs page-created dedicated workers in their own loaded-worker isolate.
// The script runs on V8 as sloppy CJS, without native eval or a boa fallback; there is no DOM or
// core wasm. `fetch` uses the page's fetch shim, so worker requests take the page's gateway route.

import { WorkerEntrypoint, RpcTarget, abortIsolate } from "cloudflare:workers";
import type {
  OpenWorkerSessionInit,
  RetainedWorkerSession,
  WorkerStartParams,
  WorkerStartReply,
  WorkerUpstreamMessage,
} from "@kitesurf/jsrpc-types/dedicated-worker";
import type { IsolateKillMarker } from "@kitesurf/jsrpc-types/shared";
import { installFetchShim } from "@kitesurf/page-script/fetch-shim";
import {
  clearSessionOutbound,
  setSessionOutbound,
  type OutboundStub,
} from "@kitesurf/page-script/session-outbound";
import { state } from "@kitesurf/page-script/state";
import {
  deliverToScope,
  errorInfo,
  ErrorEventClass,
  dispatchOnScope,
  installScope,
  isClosing,
} from "./scope.ts";

type ReceivedInit = {
  upstream?: Rpc.Stub<OpenWorkerSessionInit["upstream"]>;
  outbound?: OutboundStub;
};
type UpstreamStub = NonNullable<ReceivedInit["upstream"]>;

const ISOLATE_KILL_MARKER: IsolateKillMarker = "[ks-kill]";

let started = false;

interface DedicatedWorkerEnv {
  KS_TAIL_TOKEN?: unknown;
}

function retainUpstream(upstream: ReceivedInit["upstream"]): UpstreamStub | null {
  return upstream?.dup ? upstream.dup() : (upstream ?? null);
}

function retainOutbound(outbound: ReceivedInit["outbound"]): OutboundStub | null {
  return outbound?.dup ? outbound.dup() : (outbound ?? null);
}

function disposeStub(name: string, stub: { [Symbol.dispose]?: () => void } | null): void {
  try {
    stub?.[Symbol.dispose]?.();
  } catch (error) {
    console.debug(`[kitesurf-worker] ${name} stub dispose failed:`, error);
  }
}

function createSessionCallbacks(
  upstream: UpstreamStub | null,
  outbound: OutboundStub | null,
): { send: (message: WorkerUpstreamMessage) => void; close: () => void } {
  let closed = false;
  const send = (message: WorkerUpstreamMessage): void => {
    if (closed || !upstream) return;
    const dropped = (error: unknown) => {
      console.debug(`[kitesurf-worker] dropped ${message.event}: the engine is gone:`, error);
    };
    try {
      Promise.resolve(upstream(message)).catch(dropped);
    } catch (error) {
      dropped(error);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    disposeStub("upstream", upstream);
    if (outbound) {
      clearSessionOutbound(outbound);
      disposeStub("outbound", outbound);
    }
  };
  return { send, close };
}

async function loadWorkerScript(
  scriptUrl: string,
): Promise<typeof import("./__ks_worker_script.js") | null> {
  try {
    return await import("./__ks_worker_script.js");
  } catch (error) {
    try {
      console.error(errorInfo(error, scriptUrl).message);
    } catch {}
    return null;
  }
}

function reportWorkerRunError(error: unknown, scriptUrl: string): WorkerStartReply {
  const info = errorInfo(error, scriptUrl);
  const handled = dispatchOnScope("error", new ErrorEventClass("error", { ...info, error }));
  try {
    console.error(info.message);
  } catch {}
  return handled ? { ok: true } : { ok: false, error: info };
}

function defaultWorkerRun(mod: typeof import("./__ks_worker_script.js")) {
  return mod?.default?.run;
}

function namedWorkerRun(mod: typeof import("./__ks_worker_script.js")) {
  return mod?.run;
}

function callableWorkerRun(run: (typeof import("./__ks_worker_script.js"))["run"]) {
  return typeof run === "function" ? run : null;
}

function selectedWorkerRun(mod: typeof import("./__ks_worker_script.js")) {
  return callableWorkerRun(defaultWorkerRun(mod) ?? namedWorkerRun(mod));
}

async function runWorkerScript(
  mod: typeof import("./__ks_worker_script.js"),
  scriptUrl: string,
): Promise<WorkerStartReply> {
  try {
    const run = selectedWorkerRun(mod);
    if (run) await run.call(globalThis);
    return { ok: true };
  } catch (error) {
    return reportWorkerRunError(error, scriptUrl);
  }
}

async function startWorker(
  params: WorkerStartParams,
  send: (message: WorkerUpstreamMessage) => void,
): Promise<WorkerStartReply> {
  if (started) return { ok: false };
  started = true;
  state.pageUrl = params.baseUrl;
  state.connectionId = params.connectionId;
  state.mainFrameId = params.frameId;
  state.cookieKey = params.cookieKey;
  installFetchShim();
  installScope(params, send);
  const mod = await loadWorkerScript(params.url);
  if (mod === null) return { ok: false, parseError: true };
  return runWorkerScript(mod, params.url);
}

function createWorkerSession(
  send: (message: WorkerUpstreamMessage) => void,
  closeSession: () => void,
): RetainedWorkerSession {
  class WorkerSession extends RpcTarget implements RetainedWorkerSession {
    start(params: WorkerStartParams): Promise<WorkerStartReply> {
      return startWorker(params, send);
    }
    async deliverMessage(data: unknown): Promise<void> {
      if (isClosing()) return;
      deliverToScope(data);
    }
    async close(): Promise<void> {
      closeSession();
    }
    [Symbol.dispose]() {
      closeSession();
    }
  }
  return new WorkerSession();
}

export class DedicatedWorker extends WorkerEntrypoint<DedicatedWorkerEnv> {
  killIsolate(reason?: string): void {
    const why = reason || "worker terminated";
    const token = this.env.KS_TAIL_TOKEN;
    if (typeof token === "string" && token) console.log(`${ISOLATE_KILL_MARKER} ${token} ${why}`);
    abortIsolate(`kitesurf: ${why}`);
  }

  openSession(init: ReceivedInit | undefined): RetainedWorkerSession {
    // Duplicate these callback stubs; openSession arguments expire when the call returns.
    const upstream = retainUpstream(init?.upstream);
    const outbound = retainOutbound(init?.outbound);
    if (outbound) setSessionOutbound(outbound);
    const callbacks = createSessionCallbacks(upstream, outbound);
    return createWorkerSession(callbacks.send, callbacks.close);
  }
}

export default {
  fetch(): Response {
    return new Response("dedicated worker", { status: 404 });
  },
};
