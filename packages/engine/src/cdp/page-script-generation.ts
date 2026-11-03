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
  opts: { unload: "awaited" | "background" | "none"; reason: string; killAtOnce?: boolean },
  deps: GenerationDeps = {},
): Promise<UnloadHarvest | null> {
  const closeAndEnd = (): Promise<void> | null => {
    try {
      stub.close?.(opts.reason);
    } catch (err) {
      console.warn(
        `kitesurf: PageScript.close() failed (${opts.reason}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (typeof stub.killIsolate === "function") {
      const kill = (): Promise<void> | null => {
        try {
          const killing = stub.killIsolate?.(opts.reason, { atOnce: opts.killAtOnce === true });
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
      };
      const killing = kill();
      if (killing) deps.waitUntil?.(killing);
      return killing;
    }
    return null;
  };
  if (opts.unload === "none") {
    const teardown = closeAndEnd();
    if (deps.awaitTeardown && teardown) await teardown;
    return null;
  }
  if (opts.unload === "background") {
    void (async () => {
      try {
        await stub.unload();
      } catch {}
      closeAndEnd();
    })();
    return null;
  }
  // Navigation consumes the console/cookie harvest; other awaited unloads are cleanup-only.
  let harvest: UnloadHarvest | null = null;
  try {
    const result = await stub.unload();
    harvest = {
      console: Array.isArray(result?.console) ? result.console : [],
      cookieWrites: Array.isArray(result?.cookieWrites) ? result.cookieWrites : [],
    };
  } catch (err) {
    console.warn(
      `kitesurf: PageScript.unload() failed (${opts.reason}, continuing):`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const teardown = closeAndEnd();
  if (deps.awaitTeardown && teardown) await teardown;
  return harvest;
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
      await disposeStub(stub, { unload: "none", reason, killAtOnce: true }, deps);
    }
    return null;
  }

  let harvest: UnloadHarvest | null = null;
  if (stub) {
    harvest = await disposeStub(
      stub,
      {
        unload: intent === "navigate" ? "awaited" : "none",
        reason,
        killAtOnce: intent === "wsClosed",
      },
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
  if (opts.isStale?.()) {
    void disposeStub(
      stub,
      { unload: "background", reason: opts.reason ?? "publish: superseded" },
      deps,
    );
    return false;
  }
  holder.pageScript = stub;
  holder.pageScriptLease?.release();
  holder.pageScriptLease = deps.budget.acquire(opts.kind ?? "pageScript");
  holder.blankReady = null;
  return true;
}

function releaseLease(holder: StubHolder): void {
  holder.pageScriptLease?.release();
  holder.pageScriptLease = null;
}
