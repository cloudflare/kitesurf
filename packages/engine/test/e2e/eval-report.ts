// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

interface CdpSender {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function isEvalReply(
  v: unknown,
): v is { result?: { value?: unknown }; exceptionDetails?: unknown } {
  return typeof v === "object" && v !== null;
}

export async function readJsonReport(
  cdp: CdpSender,
  expression: string,
): Promise<Record<string, unknown>> {
  const reply: unknown = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (!isEvalReply(reply)) {
    throw new Error(`Runtime.evaluate returned a non-object reply for ${expression}`);
  }
  if (reply.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate threw for ${expression}: ${JSON.stringify(reply.exceptionDetails)}`,
    );
  }
  const raw = reply.result?.value;
  if (typeof raw !== "string") {
    throw new Error(
      `${expression} is ${typeof raw}, not the expected JSON string ` +
        "(did the fixture script throw before assigning it?)",
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${expression} parsed to ${typeof parsed}, expected an object`);
  }
  return parsed as Record<string, unknown>;
}
