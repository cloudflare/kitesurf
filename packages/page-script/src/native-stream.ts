// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Keeps engine byte streams on the captured constructor. A stream crosses Workers RPC as the
// reply to a CDP call, and RPC refuses to serialize an instance of a class a page installed over
// the shared global, so the call fails instead of returning the page's data.

export const NativeReadableStream: typeof ReadableStream = ReadableStream;
