// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin

export declare function initSync(opts: { module: WebAssembly.Module }): unknown;

export declare function set_ks_tracing(enabled: boolean): void;
export declare function set_ks_trace_parent(spanIdHex: string): void;
export declare function ks_set_emit_hook(callback: ((spanRecord: string) => void) | null): void;

export declare class SceneRasterizer {
  constructor();
  missingResources(scene: Uint8Array): Uint8Array;
  putResources(batch: Uint8Array): number;
  pendingFontAssets(): string;
  putFontAsset(path: string, bytes: Uint8Array): number;
  pendingImages(): string[];
  putImageBytes(key: string, bytes: Uint8Array): number;
  abandonImage(key: string): number;
  resetResources(): void;
  missingResourcesPdf(envelope: Uint8Array): Uint8Array;
  // eslint-disable-next-line max-params -- Keep the generated wasm-bindgen ABI.
  renderPdf(
    envelope: Uint8Array,
    paperWidth: number,
    paperHeight: number,
    omitBackground: boolean,
    marginTop: number,
    marginRight: number,
    marginBottom: number,
    marginLeft: number,
  ): Uint8Array;
  rasterize(
    scene: Uint8Array,
    format: string,
    quality: number,
    omitBackground: boolean,
  ): Uint8Array;
  rasterizeAndRetain(
    scene: Uint8Array,
    format: string,
    quality: number,
    omitBackground: boolean,
    key: string,
  ): Uint8Array;
  rasterizePartial(
    scene: Uint8Array,
    dstX: number,
    dstY: number,
    format: string,
    quality: number,
    key: string,
  ): Uint8Array;
  shiftRetained(key: string, dx: number, dy: number): boolean;
  blitPartial(scene: Uint8Array, dstX: number, dstY: number, key: string): boolean;
  encodeRetained(format: string, quality: number, key: string): Uint8Array;
  retainedFrameKey(): string;
  reserveFrame(width: number, height: number): void;
  lastRasterizeInfo(): string;
}
