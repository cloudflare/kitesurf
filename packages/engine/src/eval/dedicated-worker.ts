// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Loads page-created dedicated workers and bridges their RPC and upstream events.

import { WORKER_SCRIPT_SOURCE } from "@kitesurf/worker-script";
import {
  extractTopLevelDecls,
  hasUseStrictDirective,
  predeclareVarsHead,
} from "@kitesurf/script-gate";
import type {
  DedicatedWorkerEntrypointStub,
  OpenWorkerSessionInit,
  WorkerStartParams,
  WorkerStartReply,
  WorkerUpstreamEventName,
  WorkerUpstreamMessage,
} from "@kitesurf/jsrpc-types/dedicated-worker";
import type { SandboxOutboundOverride } from "./outbound.ts";
import {
  PAGE_SCRIPT_COMPAT_DATE,
  PAGE_SCRIPT_COMPAT_FLAGS,
  PAGE_SCRIPT_SUBREQUEST_CAP,
} from "./page-script.ts";
import { localTraceParentProps } from "../tracing-local.ts";

const TEARDOWN_GRACE_MS = 1_000;

export type WorkerUpstreamHandler = (message: WorkerUpstreamMessage) => void;

const UPSTREAM_EVENTS: ReadonlySet<string> = new Set<WorkerUpstreamEventName>([
  "worker.message",
  "worker.error",
  "worker.closed",
]);

function isWorkerUpstreamMessage(value: unknown): value is WorkerUpstreamMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("event" in value) || typeof value.event !== "string" || !UPSTREAM_EVENTS.has(value.event)) {
    return false;
  }
  return "params" in value && typeof value.params === "object" && value.params !== null;
}

export interface SpawnDedicatedWorkerOptions {
  connectionId: string;
  cookieKey: string;
  label: string;
  origin: string;
  creatorUrl: string;
  frameId: string;
  loaderId: string;
  extraHeaders: Record<string, string>;
  // The page's own budget (pageIsolateCaps): a worker does the page's
  // background work, and must not be a way around a deployment cap.
  cpuMs: number;
  source: string;
  sandboxOutbound: SandboxOutboundOverride;
  onUpstream: WorkerUpstreamHandler;
}

export interface DedicatedWorkerHandle {
  start(params: WorkerStartParams): Promise<WorkerStartReply>;
  deliverMessage(data: unknown): Promise<void>;
  terminate(reason: string): Promise<void>;
}

export const WORKER_SCRIPT_LINE_OFFSET = 3;

export function buildWorkerScriptModule(source: string): string {
  const scan = extractTopLevelDecls(source);
  const blocked = new Set(["module", "exports", "require"]);
  let body = source;
  if (scan.varSites.length > 0) {
    const parts: string[] = [];
    let last = 0;
    for (const at of scan.varSites) {
      parts.push(body.slice(last, at), "   ");
      last = at + 3;
    }
    parts.push(body.slice(last));
    body = parts.join("");
  }
  const varNames = scan.varNames.filter((n) => !blocked.has(n));
  const varSet = new Set(varNames);
  const promote = scan.names
    .filter((n) => !varSet.has(n) && !blocked.has(n))
    .map((n) => `try { if (typeof ${n} !== "undefined") globalThis.${n} = ${n}; } catch (e) {}`)
    .join("\n");
  const strict = hasUseStrictDirective(source) ? '"use strict"; ' : "";
  return (
    `module.exports.run = async function () { ${strict}\n` +
    "var module=undefined,exports=undefined,require=undefined;\n" +
    `${predeclareVarsHead(varNames, "globalThis")}\n` +
    `${body}\n${promote}\n};\n`
  );
}

function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function disposeStub(stub: unknown): void {
  if (typeof stub !== "object" || stub === null || !(Symbol.dispose in stub)) return;
  const dispose = stub[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    dispose.call(stub);
  } catch {}
}

export function spawnDedicatedWorker(
  env: { LOADER: WorkerLoader },
  ctx: ExecutionContext,
  opts: SpawnDedicatedWorkerOptions,
): DedicatedWorkerHandle {
  const outboundProps = {
    ...localTraceParentProps(),
    pageOrigin: opts.origin,
    pageUrl: opts.creatorUrl || undefined,
    mainFrameId: opts.frameId,
    mainLoaderId: opts.loaderId,
    extraHeaders: opts.extraHeaders,
    connectionId: opts.connectionId,
    cookieKey: opts.cookieKey,
  };
  const tailToken = crypto.randomUUID();
  const stub = env.LOADER.load({
    compatibilityDate: PAGE_SCRIPT_COMPAT_DATE,
    compatibilityFlags: [...PAGE_SCRIPT_COMPAT_FLAGS],
    mainModule: "worker.js",
    modules: {
      "worker.js": WORKER_SCRIPT_SOURCE,
      "__ks_worker_script.js": { cjs: buildWorkerScriptModule(opts.source) },
    },
    env: { KS_TAIL_TOKEN: tailToken },
    globalOutbound: opts.sandboxOutbound.loaded(outboundProps),
    tails: [
      ctx.exports.PageScriptTail({
        props: { scriptName: opts.label, ksErrToken: tailToken, sessionId: opts.connectionId },
      }),
    ],
    limits: { cpuMs: opts.cpuMs, subRequests: PAGE_SCRIPT_SUBREQUEST_CAP },
  });
  const entrypoint = stub.getEntrypoint<DedicatedWorkerEntrypointStub>("DedicatedWorker");
  const init: OpenWorkerSessionInit = {
    outbound: opts.sandboxOutbound.session(outboundProps),
    upstream: (message: unknown) => {
      if (!isWorkerUpstreamMessage(message)) {
        console.warn(
          `[kitesurf-worker] ${opts.label} (connection ${opts.connectionId}): dropped a malformed upstream message`,
        );
        return;
      }
      try {
        opts.onUpstream(message);
      } catch (err) {
        console.warn(
          `[kitesurf-worker] ${opts.label} (connection ${opts.connectionId}): upstream handler threw for ${message.event}:`,
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
    },
  };
  const sessionReady = Promise.resolve(entrypoint.openSession(init));
  sessionReady.catch(() => {});
  let terminated: Promise<void> | null = null;
  return {
    async start(params) {
      const session = await sessionReady;
      return await session.start(params);
    },
    async deliverMessage(data) {
      const session = await sessionReady;
      await session.deliverMessage(data);
    },
    terminate(reason) {
      if (terminated) return terminated;
      terminated = (async () => {
        await settleWithin(
          sessionReady.then(async (session) => {
            try {
              await session.close();
            } finally {
              disposeStub(session);
            }
          }),
          TEARDOWN_GRACE_MS,
        );
        await settleWithin(
          Promise.resolve().then(() => entrypoint.killIsolate(reason)),
          TEARDOWN_GRACE_MS,
        );
        disposeStub(entrypoint);
      })();
      return terminated;
    },
  };
}
