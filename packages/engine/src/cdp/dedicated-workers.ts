// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracks page-created dedicated workers and routes their events into CDP sessions.

import type {
  WorkerEventParams,
  WorkerNavigatorInfo,
  WorkerStartReply,
  WorkerUpstreamMessage,
} from "@kitesurf/jsrpc-types/dedicated-worker";
import type { ReceivedUpstreamParams, UpstreamEventName } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "./dispatch.ts";
import type { TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import type { DynamicWorkerBudget, WorkerLease } from "../eval/worker-budget.ts";
import type { DedicatedWorkerHandle } from "../eval/dedicated-worker.ts";
import { originOf, pageIsolateCaps } from "../eval/page-script.ts";
import {
  registerIsolateLimitListener,
  unregisterIsolateLimitListener,
} from "../eval/limit-registry.ts";
import type { IsolateLimitKind } from "../eval/limit-registry.ts";
import { cookieKeyFor } from "./cookie-jar-registry.ts";
import { effectiveExtraHeaders } from "./network.ts";

const WORKER_TARGET_ID_LABEL_CHARS = 8;
const MAX_WORKER_URL_PREVIEW_CHARS = 80;

export interface WorkerOwner {
  target: TargetState;
  frameId: string;
  documentKey: string;
  url: string;
  origin: string;
  loaderId: string;
  stub: PageScriptStub;
  targetEpoch: number;
  frameEpoch: number;
}

interface WorkerEntry {
  key: string;
  connectionId: string;
  label: string;
  workerId: number;
  owner: WorkerOwner;
  lease: WorkerLease;
  handle: DedicatedWorkerHandle | null;
  started: boolean;
  pending: unknown[];
  dead: boolean;
  wallTimer: ReturnType<typeof setTimeout> | null;
}

interface WorkerLaunch {
  url: string;
  source: string;
  name: string;
  origin: string;
  baseUrl: string;
}

type WorkerDestination = Pick<WorkerLaunch, "origin" | "baseUrl">;

const ISOLATE_LIMIT_DESCRIPTIONS: Record<IsolateLimitKind, string> = {
  cpu: "CPU time limit",
  memory: "memory limit",
  wall: "wall-clock time limit",
  gone: "isolate (reclaimed by the platform)",
  crashed: "isolate (reclaimed by the platform)",
};

let nextDocumentSerial = 1;

export function isWorkerUpstreamEvent(event: UpstreamEventName): boolean {
  return (
    event === "kitesurf.workerCreate" ||
    event === "kitesurf.workerPostMessage" ||
    event === "kitesurf.workerTerminate"
  );
}

function workerLabel(owner: WorkerOwner, workerId: number): string {
  const targetPrefix = owner.target.targetId.slice(0, WORKER_TARGET_ID_LABEL_CHARS);
  return `worker-${targetPrefix}-${owner.documentKey}-${workerId}`;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown, fallback: string): string {
  return error instanceof Error ? (error.stack ?? fallback) : fallback;
}

function workerScriptSource(params: ReceivedUpstreamParams): Pick<WorkerLaunch, "source" | "name"> {
  return {
    source: typeof params.source === "string" ? params.source : "",
    name: typeof params.name === "string" ? params.name : "",
  };
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function readNavigator(raw: unknown): WorkerNavigatorInfo {
  const field = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const languages = field("languages");
  return {
    userAgent: str(field("userAgent")),
    language: str(field("language"), "en-US"),
    languages: Array.isArray(languages)
      ? languages.filter((l): l is string => typeof l === "string")
      : ["en-US"],
    platform: str(field("platform")),
  };
}

export class DedicatedWorkers {
  private workers = new Map<string, WorkerEntry>();
  private targetEpochs = new Map<string, number>();
  private frameEpochs = new Map<string, number>();

  constructor(
    private readonly budget: DynamicWorkerBudget,
    private readonly waitUntil: (promise: Promise<unknown>) => void,
  ) {}

  get live(): number {
    return this.workers.size;
  }

  ownerFor(
    target: TargetState,
    frameId: string,
    stub: PageScriptStub,
    url: string,
    loaderId: string,
  ): WorkerOwner {
    return {
      target,
      frameId,
      documentKey: String(nextDocumentSerial++),
      url,
      origin: originOf(url),
      loaderId,
      stub,
      targetEpoch: this.targetEpochs.get(target.targetId) ?? 0,
      frameEpoch: this.frameEpochs.get(`${target.targetId}|${frameId}`) ?? 0,
    };
  }

  handle(
    ctx: DispatchCtx,
    owner: WorkerOwner,
    event: UpstreamEventName,
    params: ReceivedUpstreamParams,
  ): void {
    if (ctx.browser.wsClosing) return;
    const workerId = typeof params.workerId === "number" ? params.workerId : -1;
    if (workerId <= 0) return;
    const key = `${owner.target.targetId}|${owner.frameId}|${owner.documentKey}|${workerId}`;
    if (event === "kitesurf.workerCreate") {
      this.create(ctx, owner, key, workerId, params);
      return;
    }
    const entry = this.workers.get(key);
    if (!entry || entry.dead) return;
    if (event === "kitesurf.workerTerminate") {
      this.retire(entry, "Worker.terminate()");
      return;
    }
    if (event === "kitesurf.workerPostMessage") {
      if (!entry.started) {
        entry.pending.push(params.data);
        return;
      }
      this.deliver(entry, params.data);
    }
  }

  terminateTarget(targetId: string, reason: string): void {
    this.targetEpochs.set(targetId, (this.targetEpochs.get(targetId) ?? 0) + 1);
    for (const entry of [...this.workers.values()]) {
      if (entry.owner.target.targetId === targetId) this.retire(entry, reason);
    }
  }

  terminateFrame(targetId: string, frameId: string, reason: string): void {
    const frameKey = `${targetId}|${frameId}`;
    this.frameEpochs.set(frameKey, (this.frameEpochs.get(frameKey) ?? 0) + 1);
    for (const entry of [...this.workers.values()]) {
      if (entry.owner.target.targetId === targetId && entry.owner.frameId === frameId) {
        this.retire(entry, reason);
      }
    }
  }

  terminateAll(reason: string): void {
    for (const entry of [...this.workers.values()]) this.retire(entry, reason);
  }

  private ownerAlive(ctx: DispatchCtx, owner: WorkerOwner): boolean {
    const targetId = owner.target.targetId;
    return (
      ctx.browser.targets.get(targetId) === owner.target &&
      (this.targetEpochs.get(targetId) ?? 0) === owner.targetEpoch &&
      (this.frameEpochs.get(`${targetId}|${owner.frameId}`) ?? 0) === owner.frameEpoch
    );
  }

  private create(
    ctx: DispatchCtx,
    owner: WorkerOwner,
    key: string,
    workerId: number,
    params: ReceivedUpstreamParams,
  ): void {
    if (this.workers.has(key)) return;
    const launch = this.prepareLaunch(ctx, owner, workerId, params);
    if (!launch) return;
    const lease = this.acquireWorkerLease(ctx, owner, workerId, launch.url);
    if (!lease) {
      return;
    }
    const caps = pageIsolateCaps(ctx.env, ctx.browser.isolateCapOverrides);
    const entry = this.registerEntry(ctx, owner, key, workerId, lease);
    this.configureWorkerLimits(entry, launch.url, caps);
    const navigator = readNavigator(params.navigator);
    const timeOrigin = Date.now();
    void this.startWorker(ctx, entry, launch, navigator, caps.cpuMs, timeOrigin);
  }

  private prepareLaunch(
    ctx: DispatchCtx,
    owner: WorkerOwner,
    workerId: number,
    params: ReceivedUpstreamParams,
  ): WorkerLaunch | null {
    const url = typeof params.url === "string" ? params.url : "";
    if (!this.ownerAlive(ctx, owner)) {
      this.fail(owner, workerId, url, "the creating document is gone");
      return null;
    }
    const destination = this.workerDestination(owner, workerId, url);
    if (!destination) return null;
    return {
      url,
      ...workerScriptSource(params),
      ...destination,
    };
  }

  private workerDestination(
    owner: WorkerOwner,
    workerId: number,
    url: string,
  ): WorkerDestination | null {
    const protocol = protocolOf(url);
    if (isHttpProtocol(protocol)) return this.sameOriginDestination(owner, workerId, url);
    if (protocol === "blob:") return { origin: owner.origin, baseUrl: owner.url };
    if (protocol === "data:") return { origin: "", baseUrl: "" };
    this.fail(owner, workerId, url, "unsupported worker URL scheme");
    return null;
  }

  private sameOriginDestination(
    owner: WorkerOwner,
    workerId: number,
    url: string,
  ): WorkerDestination | null {
    if (!owner.origin || originOf(url) !== owner.origin) {
      this.fail(owner, workerId, url, "worker script is not same-origin with its creator");
      return null;
    }
    return { origin: owner.origin, baseUrl: url };
  }

  private acquireWorkerLease(
    ctx: DispatchCtx,
    owner: WorkerOwner,
    workerId: number,
    url: string,
  ): WorkerLease | null {
    const lease = this.budget.acquire("worker");
    if (lease) return lease;
    console.warn(
      `[kitesurf-worker] connection ${ctx.connectionId}: budget full, ` +
        `new Worker(${url.slice(0, MAX_WORKER_URL_PREVIEW_CHARS)}) fails ` +
        `(${this.budget.describe()})`,
    );
    this.fail(owner, workerId, url, "no isolate slot is free for this worker");
    return null;
  }

  private registerEntry(
    ctx: DispatchCtx,
    owner: WorkerOwner,
    key: string,
    workerId: number,
    lease: WorkerLease,
  ): WorkerEntry {
    const entry: WorkerEntry = {
      key,
      connectionId: ctx.connectionId,
      label: workerLabel(owner, workerId),
      workerId,
      owner,
      lease,
      handle: null,
      started: false,
      pending: [],
      dead: false,
      wallTimer: null,
    };
    this.workers.set(key, entry);
    return entry;
  }

  private configureWorkerLimits(
    entry: WorkerEntry,
    url: string,
    caps: ReturnType<typeof pageIsolateCaps>,
  ): void {
    if (caps.wallMs > 0) {
      entry.wallTimer = setTimeout(() => {
        entry.wallTimer = null;
        this.kill(
          entry,
          url,
          `Kitesurf: worker exceeded its wall-clock time limit (${caps.wallMs} ms) and was terminated.`,
        );
      }, caps.wallMs);
    }
    registerIsolateLimitListener(entry.label, (notice) =>
      this.handleLimitNotice(entry, url, notice.kind),
    );
  }

  private handleLimitNotice(entry: WorkerEntry, url: string, kind: IsolateLimitKind): void {
    if (entry.dead) return;
    const description = ISOLATE_LIMIT_DESCRIPTIONS[kind];
    this.kill(entry, url, `Kitesurf: worker exceeded its ${description} and was terminated.`);
  }

  private async startWorker(
    ctx: DispatchCtx,
    entry: WorkerEntry,
    launch: WorkerLaunch,
    navigator: WorkerNavigatorInfo,
    cpuMs: number,
    timeOrigin: number,
  ): Promise<void> {
    try {
      const reply = await this.spawnAndStart(ctx, entry, launch, navigator, cpuMs, timeOrigin);
      if (reply === null) return;
      this.handleStartReply(entry, reply);
    } catch (err) {
      this.reportStartFailure(entry, launch.url, err);
    }
  }

  private async spawnAndStart(
    ctx: DispatchCtx,
    entry: WorkerEntry,
    launch: WorkerLaunch,
    navigator: WorkerNavigatorInfo,
    cpuMs: number,
    timeOrigin: number,
  ): Promise<WorkerStartReply | null> {
    const { spawnDedicatedWorker } = await import("../eval/dedicated-worker.ts");
    if (entry.dead) return null;
    const cookieKey = cookieKeyFor(ctx.connectionId, entry.owner.target.browserContextId);
    const handle = spawnDedicatedWorker(ctx.env, ctx.ctx, {
      connectionId: ctx.connectionId,
      cookieKey,
      label: entry.label,
      origin: launch.origin,
      creatorUrl: entry.owner.url,
      frameId: entry.owner.frameId,
      loaderId: entry.owner.loaderId,
      extraHeaders: effectiveExtraHeaders(entry.owner.target),
      cpuMs,
      source: launch.source,
      sandboxOutbound: ctx.browser.sandboxOutbound,
      onUpstream: (message) => this.fromWorker(entry, message),
    });
    entry.handle = handle;
    const reply = await handle.start({
      url: launch.url,
      baseUrl: launch.baseUrl,
      name: launch.name,
      navigator,
      connectionId: ctx.connectionId,
      frameId: entry.owner.frameId,
      cookieKey,
      timeOrigin,
    });
    return entry.dead ? null : reply;
  }

  private handleStartReply(entry: WorkerEntry, reply: WorkerStartReply): void {
    if (reply.parseError) {
      this.toPage(entry, { workerId: entry.workerId, type: "loadError" });
      this.retire(entry, "worker script failed to parse");
      return;
    }
    entry.started = true;
    if (reply.error) {
      this.toPage(entry, { workerId: entry.workerId, type: "error", ...reply.error });
    }
    const pending = entry.pending;
    entry.pending = [];
    for (const data of pending) this.deliver(entry, data);
  }

  private reportStartFailure(entry: WorkerEntry, url: string, err: unknown): void {
    if (entry.dead) return;
    const detail = errorMessage(err);
    console.warn(
      `[kitesurf-worker] ${entry.label} (connection ${entry.connectionId}): ` +
        `spawn failed for ${url.slice(0, MAX_WORKER_URL_PREVIEW_CHARS)}:`,
      errorStack(err, detail),
    );
    this.kill(entry, url, `Failed to start worker: ${detail}`);
  }

  private deliver(entry: WorkerEntry, data: unknown): void {
    void entry.handle?.deliverMessage(data).catch((err) => {
      if (entry.dead) return;
      const detail = err instanceof Error ? err.message : String(err);
      this.kill(entry, "", `Kitesurf: the worker stopped unexpectedly (${detail}).`);
    });
  }

  private fromWorker(entry: WorkerEntry, message: WorkerUpstreamMessage): void {
    if (entry.dead) return;
    const workerId = entry.workerId;
    if (message.event === "worker.message") {
      this.toPage(entry, { workerId, type: "message", data: message.params.data });
    } else if (message.event === "worker.error") {
      const params = message.params;
      this.toPage(entry, {
        workerId,
        type: "error",
        message: String(params.message ?? ""),
        filename: String(params.filename ?? ""),
        lineno: Number(params.lineno ?? 0) | 0,
        colno: Number(params.colno ?? 0) | 0,
      });
    } else if (message.event === "worker.closed") {
      this.toPage(entry, { workerId, type: "closed" });
      this.retire(entry, "self.close()");
    }
  }

  private toPage(entry: WorkerEntry, params: WorkerEventParams): void {
    void entry.owner.stub.deliverWorkerEvent(params).catch((err: unknown) => {
      console.debug(
        `[kitesurf-worker] ${entry.label} (connection ${entry.connectionId}): ` +
          `dropped a ${params.type} event for a gone document:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private kill(entry: WorkerEntry, filename: string, message: string): void {
    const workerId = entry.workerId;
    this.toPage(entry, { workerId, type: "error", message, filename, lineno: 0, colno: 0 });
    this.toPage(entry, { workerId, type: "closed" });
    this.retire(entry, message);
  }

  private fail(owner: WorkerOwner, workerId: number, url: string, reason: string): void {
    const stub = owner.stub;
    const label = workerLabel(owner, workerId);
    void stub
      .deliverWorkerEvent({
        workerId,
        type: "error",
        message: `Failed to start worker: ${reason}`,
        filename: url,
        lineno: 0,
        colno: 0,
      })
      .then(() => stub.deliverWorkerEvent({ workerId, type: "closed" }))
      .catch((err: unknown) => {
        console.debug(
          `[kitesurf-worker] ${label}: could not report "${reason}" to a gone document:`,
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  private retire(entry: WorkerEntry, reason: string): void {
    if (entry.dead) return;
    entry.dead = true;
    entry.pending = [];
    if (entry.wallTimer) clearTimeout(entry.wallTimer);
    entry.wallTimer = null;
    unregisterIsolateLimitListener(entry.label);
    this.workers.delete(entry.key);
    entry.lease.release();
    const handle = entry.handle;
    if (!handle) return;
    this.waitUntil(handle.terminate(reason).then(() => this.budget.noteIsolateKilled()));
  }
}
