// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Classifies engine exceptions and validates token-protected PageScript reports.

export type ErrorOrigin = "page" | "wasm" | "shim" | "runtime" | "unknown";

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
    const field = (name: string): unknown =>
      raw === null || raw === undefined ? undefined : Reflect.get(Object(raw), name, raw);
    if (field("token") !== expectedToken) return null;
    const message = field("message");
    const origin = field("origin");
    if (
      typeof message !== "string" ||
      (origin !== "wasm" && origin !== "shim" && origin !== "runtime")
    ) {
      return null;
    }
    const name = field("name");
    const stack = field("stack");
    const pageUrl = field("pageUrl");
    return {
      origin,
      name: (typeof name === "string" && name ? name : "Error").slice(0, 64),
      message: message.slice(0, 1024),
      stack: typeof stack === "string" ? stack.slice(0, 8192) : undefined,
      pageUrl: typeof pageUrl === "string" ? pageUrl.slice(0, 512) : undefined,
    };
  } catch {
    return null;
  }
}
