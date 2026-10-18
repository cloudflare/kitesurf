// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines the session, message, and fetch contracts shared by worker RPC callers.

import type { SessionOutbound } from "./page-script.ts";

export interface WorkerStartParams {
  url: string;
  baseUrl: string;
  name: string;
  navigator: WorkerNavigatorInfo;
  connectionId: string;
  frameId: string;
  cookieKey: string;
  timeOrigin: number;
}

export interface WorkerNavigatorInfo {
  userAgent: string;
  language: string;
  languages: string[];
  platform: string;
}

export interface WorkerErrorInfo {
  message: string;
  filename: string;
  lineno: number;
  colno: number;
}

export interface WorkerStartReply {
  ok: boolean;
  error?: WorkerErrorInfo;
  parseError?: boolean;
}

export interface WorkerUpstreamEvents {
  "worker.message": { data: unknown };
  "worker.error": WorkerErrorInfo;
  "worker.closed": Record<never, never>;
}

export type WorkerUpstreamEventName = keyof WorkerUpstreamEvents;

export type WorkerUpstreamMessage<E extends WorkerUpstreamEventName = WorkerUpstreamEventName> = {
  [K in E]: { event: K; params: WorkerUpstreamEvents[K] };
}[E];

export interface OpenWorkerSessionInit {
  upstream: (message: WorkerUpstreamMessage) => void;
  /** Engine egress capability used by the worker's fetch shim. */
  outbound?: SessionOutbound;
}

export interface RetainedWorkerSession {
  start(params: WorkerStartParams): Promise<WorkerStartReply>;
  deliverMessage(data: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface DedicatedWorkerEntrypoint {
  openSession(init: OpenWorkerSessionInit): RetainedWorkerSession;
  killIsolate(reason?: string): void;
}

export type DedicatedWorkerEntrypointStub = DedicatedWorkerEntrypoint & Rpc.WorkerEntrypointBranded;

export type WorkerEventParams =
  | { workerId: number; type: "message"; data: unknown }
  | ({ workerId: number; type: "error" } & WorkerErrorInfo)
  | { workerId: number; type: "loadError" }
  | { workerId: number; type: "closed" };
