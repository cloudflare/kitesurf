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

interface ExceptionDetails {
  className: string;
  message: string;
  stack: string;
}

type ThrownObject = { name?: unknown; message?: unknown; stack?: unknown };

function exceptionClassName(thrown: ThrownObject): string {
  if (typeof thrown.name === "string" && thrown.name) return thrown.name;
  return "Error";
}

function exceptionMessage(thrown: ThrownObject): string {
  return typeof thrown.message === "string" ? thrown.message : "";
}

function exceptionStack(thrown: ThrownObject): string {
  return typeof thrown.stack === "string" ? thrown.stack : "";
}

function exceptionDetails(err: unknown): ExceptionDetails {
  if (err && typeof err === "object") {
    const thrown = err as ThrownObject;
    return {
      className: exceptionClassName(thrown),
      message: exceptionMessage(thrown),
      stack: exceptionStack(thrown),
    };
  }
  return { className: "Error", message: String(err), stack: "" };
}

function completeExceptionStack(details: ExceptionDetails): string {
  if (!details.stack) return `${details.className}: ${details.message}`;
  if (/^[A-Z][A-Za-z]*Error/.test(details.stack) || details.stack.startsWith("Error")) {
    return details.stack;
  }
  return `${details.className}: ${details.message}\n${details.stack}`;
}

export function pushException(err: unknown, opts: PushExceptionOptions): void {
  if (__exceptionBuffer.length >= EXCEPTION_BUFFER_CAP) return;
  const details = exceptionDetails(err);
  const { className, message } = details;
  const stack = completeExceptionStack(details);

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
