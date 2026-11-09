// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "tail-token";
const { error: realError, log: realLog } = console;

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("page-script engine error channel", () => {
  it("keeps the tail token away from page-overwritten console methods", async () => {
    const nativeError = vi.spyOn(console, "error").mockImplementation(() => {});
    const nativeLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportEngineError, setTailToken, writeIsolateKillLine } =
      await import("../../page-script/src/engine-error.ts");
    setTailToken(TOKEN);

    // Page JS can assign over the members of the console it shares.
    const seenByPage: unknown[] = [];
    const capture = (...args: unknown[]) => seenByPage.push(...args);
    console.error = capture;
    console.log = capture;

    reportEngineError("shim", new Error("boom"));
    writeIsolateKillLine("[ks-kill]", "generation retired");
    console.error = nativeError;
    console.log = nativeLog;

    expect(seenByPage).toEqual([]);
    expect(String(nativeError.mock.calls[0]?.[0])).toContain(`"token":"${TOKEN}"`);
    expect(nativeLog.mock.calls[0]?.[0]).toBe(`[ks-kill] ${TOKEN} generation retired`);
  });
});
