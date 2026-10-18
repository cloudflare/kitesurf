// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export {};

declare global {
  interface Uint8ArrayConstructor {
    fromBase64(value: string): Uint8Array<ArrayBuffer>;
  }

  interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
    toBase64(): string;
  }
}
