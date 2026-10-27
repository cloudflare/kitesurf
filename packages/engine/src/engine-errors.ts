// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Classifies engine exceptions and validates token-protected PageScript reports.

export type ErrorOrigin = "page" | "wasm" | "shim" | "runtime" | "unknown";

type AuthenticatedOrigin = Extract<ErrorOrigin, "wasm" | "shim" | "runtime">;

function isAuthenticatedOrigin(value: unknown): value is AuthenticatedOrigin {
  return value === "wasm" || value === "shim" || value === "runtime";
}

function reportField(raw: unknown, name: string): unknown {
  return raw === null || raw === undefined ? undefined : Reflect.get(Object(raw), name, raw);
}

function boundedErrorName(value: unknown): string {
  return (typeof value === "string" && value ? value : "Error").slice(0, 64);
}

function boundedOptionalString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function parseAuthenticatedReport(raw: unknown): Omit<TailExceptionReport, "scriptName"> | null {
  const message = reportField(raw, "message");
  const origin = reportField(raw, "origin");
  if (typeof message !== "string" || !isAuthenticatedOrigin(origin)) return null;
  return {
    origin,
    name: boundedErrorName(reportField(raw, "name")),
    message: message.slice(0, 1024),
    stack: boundedOptionalString(reportField(raw, "stack"), 8192),
    pageUrl: boundedOptionalString(reportField(raw, "pageUrl"), 512),
  };
}

// Classify uncaught exceptions by PageScript module and wasm panic frames.
export function classifyOrigin(name: string, message: string, stack?: string): ErrorOrigin {
  const s = stack ?? "";
  // Page bundle frames identify exceptions that escaped page-error handling.
  if (s.includes("__ks_user_")) return "page";
  if (name === "RuntimeError" || /panicked at|unreachable/.test(message)) {
    return "wasm";
  }
  if (s.includes("core_bg.wasm") || s.includes("wasm-glue.js")) return "wasm";
  if (s.includes("dom-shim.js")) return "shim";
  if (/\bpage\.js:/.test(s) || s.includes("(page.js")) return "runtime";
  return "unknown";
}

export interface TailExceptionReport {
  scriptName: string;
  name: string;
  message: string;
  stack?: string;
  // Explicit for authenticated engine errors; otherwise classified from the stack.
  origin?: ErrorOrigin;
  pageUrl?: string;
  // Navigate-time domain; a later pageUrl takes precedence after SPA routing.
  pageDomain?: string;
  // Owning CDP connection ID for joining isolate events to engine logs.
  sessionId?: string;
  // Panic-hook stack captured before unwinding, while wasm frames are live.
  panicStack?: string;
}

// Console output is page-visible. Accept engine errors only with the load-time
// token, and cap fields before forwarding them to an error reporter.
export function parseKsErrLine(
  line: string,
  expectedToken: string | undefined,
): Omit<TailExceptionReport, "scriptName"> | null {
  if (!expectedToken) return null;
  if (!line.startsWith("[ks-err] ")) return null;
  try {
    const raw: unknown = JSON.parse(line.slice("[ks-err] ".length));
    if (reportField(raw, "token") !== expectedToken) return null;
    return parseAuthenticatedReport(raw);
  } catch {
    return null;
  }
}
