// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Buffers page exceptions for parent-side CDP Runtime.exceptionThrown events.

import type { ExceptionEntry } from "@kitesurf/jsrpc-types/shared";

const __exceptionBuffer: ExceptionEntry[] = [];
const EXCEPTION_BUFFER_CAP = 200;

export interface PushExceptionOptions {
  scriptId: string;
  url: string;
  text?: string;
}

export function pushException(err: unknown, opts: PushExceptionOptions): void {
  if (__exceptionBuffer.length >= EXCEPTION_BUFFER_CAP) return;

  let className = "Error";
  let message = "";
  let stack = "";
  if (err && typeof err === "object") {
    const thrown = err as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof thrown.name === "string" && thrown.name) className = thrown.name;
    if (typeof thrown.message === "string") message = thrown.message;
    if (typeof thrown.stack === "string") stack = thrown.stack;
  } else {
    message = String(err);
  }
  if (!stack) {
    stack = `${className}: ${message}`;
  } else if (!/^[A-Z][A-Za-z]*Error/.test(stack) && !stack.startsWith("Error")) {
    stack = `${className}: ${message}\n${stack}`;
  }

  __exceptionBuffer.push({
    timestamp: Date.now(),
    text: opts.text ?? "Uncaught",
    scriptId: opts.scriptId,
    url: opts.url,
    className,
    message,
    stack,
  });
}

export function drainExceptions(): ExceptionEntry[] {
  if (__exceptionBuffer.length === 0) return [];
  const out = __exceptionBuffer.slice();
  __exceptionBuffer.length = 0;
  return out;
}

export function resetExceptionBuffer(): void {
  __exceptionBuffer.length = 0;
}
