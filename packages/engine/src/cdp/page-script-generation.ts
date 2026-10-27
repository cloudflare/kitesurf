// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Publishes and retires PageScript generations while releasing worker leases.

import type { ConsoleEntry } from "@kitesurf/jsrpc-types/shared";
import type { PageScriptStub } from "../eval/page-script.ts";
import type { DynamicWorkerBudget, DynamicWorkerKind, WorkerLease } from "../eval/worker-budget.ts";

export interface StubHolder {
  pageScript: PageScriptStub | null;
  pageScriptLease?: WorkerLease | null;
  blankReady?: Promise<void> | null;
}

export type RetireIntent =
  | "navigate"
  | "closeTarget"
  | "wsClosed"
  | "renderFailure"
  | "frameTeardown";

export interface UnloadHarvest {
  console: ConsoleEntry[];
  cookieWrites: string[];
}

export interface GenerationDeps {
  budget?: DynamicWorkerBudget;
  waitUntil?: (promise: Promise<unknown>) => void;
  awaitTeardown?: boolean;
}

/** `awaited` returns console and cookie writes on success, or `null` if unload fails.
 * `background` unloads asynchronously; `none` skips unload. Both return `null`.
 * Only `awaited` and `none` honor `deps.awaitTeardown` before returning.
 */
export async function disposeStub(
  stub: PageScriptStub,
  opts: { unload: "awaited" | "background" | "none"; reason: string },
  deps: GenerationDeps = {},
): Promise<UnloadHarvest | null> {
  switch (opts.unload) {
    case "none": {
      const teardown = closeStubAndEnd(stub, opts.reason, deps);
      if (shouldAwaitTeardown(deps, teardown)) await teardown;
      return null;
    }
    case "background":
      void (async () => {
        try {
          await stub.unload();
        } catch {}
        closeStubAndEnd(stub, opts.reason, deps);
      })();
      return null;
    case "awaited":
      break;
  }
  // Navigation consumes the console/cookie harvest; other awaited unloads are cleanup-only.
  const harvest = await unloadStub(stub, opts.reason);
  const teardown = closeStubAndEnd(stub, opts.reason, deps);
  if (shouldAwaitTeardown(deps, teardown)) await teardown;
  return harvest;
}

function shouldAwaitTeardown(
  deps: GenerationDeps,
  teardown: Promise<void> | null,
): teardown is Promise<void> {
  return deps.awaitTeardown === true && teardown !== null;
}

function closeStubAndEnd(
  stub: PageScriptStub,
  reason: string,
  deps: GenerationDeps,
): Promise<void> | null {
  try {
    stub.close?.(reason);
  } catch (err) {
    console.warn(
      `kitesurf: PageScript.close() failed (${reason}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const killing = killStub(stub, reason, deps);
  trackKill(deps, killing);
  return killing;
}

function trackKill(deps: GenerationDeps, killing: Promise<void> | null): void {
  if (killing) deps.waitUntil?.(killing);
}

function killStub(
  stub: PageScriptStub,
  reason: string,
  deps: GenerationDeps,
): Promise<void> | null {
  if (typeof stub.killIsolate !== "function") return null;
  return invokeKill(stub, reason, deps);
}

function invokeKill(
  stub: PageScriptStub,
  reason: string,
  deps: GenerationDeps,
): Promise<void> | null {
  try {
    const killing = stub.killIsolate?.(reason);
    if (!killing) {
      deps.budget?.noteIsolateKilled();
      return null;
    }
    return Promise.resolve(killing).then(
      () => deps.budget?.noteIsolateKilled(),
      () => deps.budget?.noteIsolateKilled(),
    );
  } catch {
    return null;
  }
}

async function unloadStub(stub: PageScriptStub, reason: string): Promise<UnloadHarvest | null> {
  try {
    const result = await stub.unload();
    return unloadHarvestFromResult(result);
  } catch (err) {
    console.warn(
      `kitesurf: PageScript.unload() failed (${reason}, continuing):`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function unloadHarvestFromResult(
  result: Awaited<ReturnType<PageScriptStub["unload"]>>,
): UnloadHarvest {
  return {
    console: Array.isArray(result?.console) ? result.console : [],
    cookieWrites: Array.isArray(result?.cookieWrites) ? result.cookieWrites : [],
  };
}

/**
 * Clears the holder and releases its lease using the teardown timing for `intent`.
 * Only `navigate` awaits unload and can return a console/cookie harvest.
 */
export async function retireStub(
  holder: StubHolder,
  intent: RetireIntent,
  reason: string,
  deps: GenerationDeps = {},
): Promise<UnloadHarvest | null> {
  const stub = holder.pageScript;

  if (intent === "frameTeardown") {
    holder.pageScript = null;
    // Return the shared worker slot before background unload can wait on RPC.
    releaseLease(holder);
    if (stub) void disposeStub(stub, { unload: "background", reason }, deps);
    return null;
  }

  if (intent === "closeTarget") {
    holder.pageScript = null;
    holder.blankReady = null;
    releaseLease(holder);
    if (stub) {
      await disposeStub(stub, { unload: "none", reason }, deps);
    }
    return null;
  }

  let harvest: UnloadHarvest | null = null;
  if (stub) {
    harvest = await disposeStub(
      stub,
      { unload: intent === "navigate" ? "awaited" : "none", reason },
      deps,
    );
  }
  holder.pageScript = null;
  if (intent !== "navigate") holder.blankReady = null;
  releaseLease(holder);
  return harvest;
}

/** Publishes a stub unless it is already stale; stale stubs are disposed and return `false`. */
export function publishStub(
  holder: StubHolder,
  stub: PageScriptStub,
  opts: {
    isStale?: () => boolean;
    kind?: DynamicWorkerKind;
    reason?: string;
  },
  deps: { budget: DynamicWorkerBudget },
): boolean {
  if (isStaleStub(opts)) {
    void disposeStub(stub, { unload: "background", reason: staleStubReason(opts) }, deps);
    return false;
  }
  holder.pageScript = stub;
  holder.pageScriptLease?.release();
  holder.pageScriptLease = deps.budget.acquire(opts.kind ?? "pageScript");
  holder.blankReady = null;
  return true;
}

function isStaleStub(opts: { isStale?: () => boolean }): boolean {
  return opts.isStale?.() ?? false;
}

function staleStubReason(opts: { reason?: string }): string {
  return opts.reason ?? "publish: superseded";
}

function releaseLease(holder: StubHolder): void {
  holder.pageScriptLease?.release();
  holder.pageScriptLease = null;
}
