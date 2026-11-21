// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Loads one page isolate from a loopback request that ends when the page is retired.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { OpenSessionInit, PageScriptEntrypoint } from "@kitesurf/jsrpc-types/page-script";
import type {
  FetchAsset,
  FetchFont,
  FetchImage,
  PageRendererEntrypoint,
  RenderFrameOpts,
  RenderFrameReply,
  RenderPdfOpts,
  RenderPdfReply,
  RenderPort,
} from "@kitesurf/jsrpc-types/page-renderer";
import type { RpcSessionCallable, RpcSessionEntrypoint } from "./page-script-rpc-session.ts";
import { addStaticPageModules } from "./page-script.ts";
import { addStaticRendererModules } from "./page-renderer.ts";

/** One page isolate: per-navigation modules only, since the host adds the shared ones. */
export interface PageIsolateSpec {
  code: WorkerLoaderWorkerCode;
  entrypoint: string;
  props: Record<string, unknown>;
}

/** One renderer isolate spec passed through PageIsolateHost so disposal frees its IoContext. */
export interface RendererIsolateSpec {
  code: WorkerLoaderWorkerCode;
}

export interface RendererIsolateCallable {
  renderFrame(
    port: RenderPort,
    opts: RenderFrameOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderFrameReply>;
  renderPdf(
    port: RenderPort,
    opts: RenderPdfOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderPdfReply>;
  killIsolate?(reason?: string): Promise<unknown>;
  [Symbol.dispose]?: () => void;
}

// Intra-isolate handoff for pure module sources avoids JSRPC structured-cloning up to tens of MiB
// of prefetched scripts (which hits workerd's 32 MiB JSRPC argument cap on large pages), while I/O
// bindings (globalOutbound, tails, env) still travel over JSRPC into PageIsolateHost's IoContext.
const STASH_TTL_MS = 60_000;
const stashedPageModules = new Map<
  string,
  { modules: WorkerLoaderWorkerCode["modules"]; createdAt: number }
>();

export function stashPageModules(modules: WorkerLoaderWorkerCode["modules"]): string {
  const now = Date.now();
  for (const [key, entry] of stashedPageModules) {
    if (now - entry.createdAt > STASH_TTL_MS) stashedPageModules.delete(key);
  }
  const id = crypto.randomUUID();
  stashedPageModules.set(id, { modules, createdAt: now });
  return id;
}

export function dropStashedPageModules(id: string): void {
  stashedPageModules.delete(id);
}

// What a caller sees of the loopback export. Rpc.Provider loses generic call/reply correlation
// and annotates cloneable replies with Disposable, so this states the wire contract the engine
// relies on; PageIsolateHandle and RendererIsolateHandle serve it at runtime.
export type PageIsolateHostExport = {
  open(
    spec: PageIsolateSpec,
    modulesId?: string,
  ): Promise<RpcSessionEntrypoint> & RpcSessionEntrypoint;
  openRenderer(
    spec: RendererIsolateSpec,
  ): Promise<RendererIsolateCallable> & RendererIsolateCallable;
};

// A dynamic worker belongs to the IoContext of the request that loaded it, so the load runs in
// this loopback request instead of the caller's connection: the request stays open while the
// caller holds the returned handle, and disposing the handle ends it, releasing the isolate's
// heap, wasm memory and compiled code.
export class PageIsolateHost extends WorkerEntrypoint<{ LOADER: WorkerLoader }> {
  open(spec: PageIsolateSpec, modulesId?: string): PageIsolateHandle {
    if (modulesId !== undefined) {
      const entry = stashedPageModules.get(modulesId);
      stashedPageModules.delete(modulesId);
      if (!entry) throw new Error("PageIsolateHost.open: missing stashed page modules");
      spec.code.modules = entry.modules;
    }
    addStaticPageModules(spec.code.modules);
    const loaded = this.env.LOADER.load(spec.code).getEntrypoint<PageScriptEntrypoint>(
      spec.entrypoint,
      { props: spec.props },
    );
    // SAFETY: WorkerLoader follows the PageScript JSRPC contract, but Rpc.Provider loses generic
    // call/reply correlation and annotates cloneable reply objects with Disposable.
    // Runtime replies remain PageScriptReply data.
    // Verified by: packages/engine/test/e2e/demos/page-script-demo.e2e.test.ts.
    return new PageIsolateHandle(loaded as RpcSessionEntrypoint);
  }

  openRenderer(spec: RendererIsolateSpec): RendererIsolateHandle {
    addStaticRendererModules(spec.code.modules);
    const loaded = this.env.LOADER.load(spec.code).getEntrypoint<PageRendererEntrypoint>(
      "PageRenderer",
    );
    return new RendererIsolateHandle(loaded);
  }
}

// Forwards the calls the engine makes on a page isolate; the session stub it returns keeps this
// request open the same way the handle does.
export class PageIsolateHandle extends RpcTarget {
  private entrypoint: RpcSessionEntrypoint;

  constructor(entrypoint: RpcSessionEntrypoint) {
    super();
    this.entrypoint = entrypoint;
  }

  openSession(init: OpenSessionInit): Promise<RpcSessionCallable> {
    return this.entrypoint.openSession(init);
  }

  killIsolate(reason?: string): Promise<unknown> {
    return this.entrypoint.killIsolate?.(reason) ?? Promise.resolve();
  }
}

function disposeRpcValue(value: unknown): void {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    !(Symbol.dispose in value)
  ) {
    return;
  }
  const dispose = (value as { [Symbol.dispose]?: unknown })[Symbol.dispose];
  if (typeof dispose === "function") {
    try {
      Reflect.apply(dispose, value, []);
    } catch {}
  }
}

// Forwards render calls to a hosted PageRenderer isolate; disposing this handle ends the loopback
// request and releases the renderer's wasm linear memory and V8 heap.
export class RendererIsolateHandle extends RpcTarget {
  private entrypoint: Fetcher<PageRendererEntrypoint>;

  constructor(entrypoint: Fetcher<PageRendererEntrypoint>) {
    super();
    this.entrypoint = entrypoint;
  }

  async renderFrame(
    port: RenderPort,
    opts: RenderFrameOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderFrameReply> {
    try {
      return await this.entrypoint.renderFrame(port, opts, fetchAsset, fetchImage, fetchFont);
    } finally {
      disposeRpcValue(port);
      disposeRpcValue(fetchAsset);
      disposeRpcValue(fetchImage);
      disposeRpcValue(fetchFont);
    }
  }

  async renderPdf(
    port: RenderPort,
    opts: RenderPdfOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderPdfReply> {
    try {
      return await this.entrypoint.renderPdf(port, opts, fetchAsset, fetchImage, fetchFont);
    } finally {
      disposeRpcValue(port);
      disposeRpcValue(fetchAsset);
      disposeRpcValue(fetchImage);
      disposeRpcValue(fetchFont);
    }
  }

  killIsolate(reason?: string): Promise<unknown> {
    return Promise.resolve(this.entrypoint.killIsolate(reason));
  }
}
