// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines PageRenderer RPC calls and its pull port into a PageScript generation.

import type { QueryDomArgs, QueryDomResult } from "./query-dom.ts";

export type RenderStage = "record" | "resources" | "raster";

export interface RenderFrameOpts {
  format: string;
  quality: number;
  omitBackground: boolean;
  sinceSeq?: number;
  clip?: { x: number; y: number; width: number; height: number };
  partialKey?: string;
  // "encoded" opts out of the renderer's default raw RGBA transport.
  images?: "raw" | "encoded";
  traced?: boolean;
  tp?: string;
}

export interface RenderFrameReply {
  bytes?: Uint8Array;
  unchanged?: boolean;
  error?: string;
  stage?: RenderStage;
  info?: string;
  phases?: string[];
  seq: number;
  scrollX: number;
  scrollY: number;
}

export interface RenderPdfOpts {
  paperWidth: number;
  paperHeight: number;
  omitBackground: boolean;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  traced?: boolean;
  tp?: string;
}

export interface RenderPdfReply {
  bytes?: Uint8Array;
  error?: string;
  stage?: RenderStage;
  info?: string;
  phases?: string[];
}

type RenderPortMethod = "recordScene" | "getPaintResources" | "getFontUrlData" | "recordPdfScenes";

/** Lets PageRenderer pull scene records and paint resources from PageScript. */
export type RenderPort = {
  [M in RenderPortMethod]: (args: QueryDomArgs<M>) => Promise<QueryDomResult<M>>;
};

/** The engine owns this stub and disposes it with the retained PageScript session. */
export type RenderPortStub = Rpc.Stub<RenderPort & Rpc.RpcTargetBranded>;

export type FetchAsset = (path: string) => Promise<Uint8Array | ArrayBuffer>;
export type FetchImage = (key: string) => Promise<Uint8Array | ArrayBuffer>;
export type FetchFont = (key: string) => Promise<Uint8Array | ArrayBuffer>;

export interface PageRendererRpc {
  ping(): { pong: number };
  memoryStats(): { bytes: number; initialBytes: number; deltaBytes: number };
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
  killIsolate(reason?: string): void;
}

export type PageRendererEntrypoint = PageRendererRpc & Rpc.WorkerEntrypointBranded;
