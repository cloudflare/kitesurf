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
// Imported statically so it binds the native console before the page's worker script loads.
import { setTailToken, writeIsolateKillLine } from "@kitesurf/page-script/tail-channel";
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

const ISOLATE_KILL_MARKER: IsolateKillMarker = "[ks-kill]";

let started = false;

// Props, not env: the page's worker script runs here and can import env.
interface DedicatedWorkerProps {
  KS_TAIL_TOKEN?: unknown;
}

export class DedicatedWorker extends WorkerEntrypoint<unknown, DedicatedWorkerProps> {
  killIsolate(reason?: string): void {
    const why = reason || "worker terminated";
    setTailToken(this.ctx.props?.KS_TAIL_TOKEN);
    writeIsolateKillLine(ISOLATE_KILL_MARKER, why);
    abortIsolate(`kitesurf: ${why}`);
  }

  openSession(init: ReceivedInit | undefined): RetainedWorkerSession {
    // Duplicate these callback stubs; openSession arguments expire when the call returns.
    const upstream = init?.upstream?.dup ? init.upstream.dup() : (init?.upstream ?? null);
    const outbound = init?.outbound?.dup ? init.outbound.dup() : (init?.outbound ?? null);
    if (outbound) setSessionOutbound(outbound);
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
    const disposeStub = (name: string, stub: { [Symbol.dispose]?: () => void } | null) => {
      try {
        stub?.[Symbol.dispose]?.();
      } catch (error) {
        console.debug(`[kitesurf-worker] ${name} stub dispose failed:`, error);
      }
    };
    const closeSession = () => {
      if (closed) return;
      closed = true;
      disposeStub("upstream", upstream);
      if (outbound) {
        clearSessionOutbound(outbound);
        disposeStub("outbound", outbound);
      }
    };

    class WorkerSession extends RpcTarget implements RetainedWorkerSession {
      async start(params: WorkerStartParams): Promise<WorkerStartReply> {
        if (started) return { ok: false };
        started = true;
        state.pageUrl = params.baseUrl;
        state.connectionId = params.connectionId;
        state.mainFrameId = params.frameId;
        state.cookieKey = params.cookieKey;
        installFetchShim();
        installScope(params, send);
        let mod: typeof import("./__ks_worker_script.js");
        try {
          mod = await import("./__ks_worker_script.js");
        } catch (error) {
          try {
            console.error(errorInfo(error, params.url).message);
          } catch {}
          return { ok: false, parseError: true };
        }
        try {
          const run = mod?.default?.run ?? mod?.run;
          if (typeof run === "function") await run.call(globalThis);
          return { ok: true };
        } catch (error) {
          const info = errorInfo(error, params.url);
          const handled = dispatchOnScope(
            "error",
            new ErrorEventClass("error", { ...info, error }),
          );
          try {
            console.error(info.message);
          } catch {}
          return handled ? { ok: true } : { ok: false, error: info };
        }
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
}

export default {
  fetch(): Response {
    return new Response("dedicated worker", { status: 404 });
  },
};
