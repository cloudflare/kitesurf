// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  disposeStub,
  publishStub,
  retireStub,
  type RetireIntent,
  type StubHolder,
} from "../src/cdp/page-script-generation.ts";
import { DynamicWorkerBudget } from "../src/eval/worker-budget.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";

function makeStub(opts: { failClose?: boolean; failUnload?: boolean } = {}) {
  const events: string[] = [];
  let releaseUnload = () => {};
  const gate = new Promise<void>((r) => (releaseUnload = r));
  const stub = {
    events,
    releaseUnload: () => releaseUnload(),
    async unload() {
      events.push("unload:start");
      await gate;
      events.push("unload:done");
      if (opts.failUnload) throw new Error("unload failed");
      return {
        ok: true as const,
        console: [{ type: "log", args: ["bye"] }],
        cookieWrites: ["k=v"],
      };
    },
    close(_reason?: string) {
      if (opts.failClose) {
        events.push("close:threw");
        throw new Error("close failed");
      }
      events.push("close");
    },
    killIsolate(_reason?: string, opts?: { atOnce?: boolean }) {
      events.push(opts?.atOnce ? "kill:atOnce" : "kill");
    },
  };
  return stub as typeof stub & PageScriptStub;
}

function makeHolder(over: Partial<StubHolder> = {}): StubHolder {
  return { pageScript: null, pageScriptLease: null, blankReady: null, ...over };
}

function spawnedHolder(budget: DynamicWorkerBudget, stub: PageScriptStub) {
  const holder = makeHolder({
    pageScript: stub,
    pageScriptLease: budget.acquire("pageScript"),
    blankReady: Promise.resolve(),
  });
  return holder;
}

describe("retireStub", () => {
  it("navigate: awaits unload, harvests, then close→kill, then detach+release", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub();
    const holder = spawnedHolder(budget, stub);
    stub.releaseUnload();
    const harvest = await retireStub(holder, "navigate", "gen bump", { budget });
    expect(stub.events).toEqual(["unload:start", "unload:done", "close", "kill"]);
    expect(harvest?.console).toHaveLength(1);
    expect(harvest?.cookieWrites).toEqual(["k=v"]);
    expect(holder.pageScript).toBeNull();
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    expect(holder.blankReady).not.toBeNull();
  });

  it("kills on EVERY intent — the drift that leaked isolates", async () => {
    const intents: RetireIntent[] = [
      "navigate",
      "closeTarget",
      "wsClosed",
      "renderFailure",
      "frameTeardown",
    ];
    for (const intent of intents) {
      const budget = new DynamicWorkerBudget();
      const stub = makeStub();
      const holder = spawnedHolder(budget, stub);
      stub.releaseUnload();
      await retireStub(holder, intent, "test", { budget });
      await vi.waitFor(() => expect(stub.events.some((e) => e.startsWith("kill"))).toBe(true));
      expect(budget.isolatesKilled, intent).toBe(1);
      const final = intent === "closeTarget" || intent === "wsClosed";
      expect(stub.events.includes("kill:atOnce"), `${intent} skips the close grace`).toBe(final);
    }
  });

  it("non-navigate intents drop blankReady so no eval awaits a retired generation", async () => {
    const budget = new DynamicWorkerBudget();
    const holder = spawnedHolder(budget, makeStub());
    await retireStub(holder, "closeTarget", "test", { budget });
    expect(holder.blankReady).toBeNull();
  });

  it("closeTarget releases its slot before asynchronous teardown settles", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub();
    let releaseKill = () => {};
    stub.killIsolate = () => {
      stub.events.push("kill");
      return new Promise<void>((resolve) => (releaseKill = resolve));
    };
    const holder = spawnedHolder(budget, stub);

    const done = retireStub(holder, "closeTarget", "test", { budget });
    expect(holder.pageScript).toBeNull();
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    expect(budget.isolatesKilled).toBe(0);

    releaseKill();
    await done;
    expect(budget.isolatesKilled).toBe(1);
  });

  it("frameTeardown: slot back synchronously, verbs in the background", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub();
    const holder = spawnedHolder(budget, stub);
    const done = retireStub(holder, "frameTeardown", "src change", { budget });
    expect(holder.pageScript).toBeNull();
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    expect(stub.events).not.toContain("close");
    await done;
    stub.releaseUnload();
    await vi.waitFor(() =>
      expect(stub.events).toEqual(["unload:start", "unload:done", "close", "kill"]),
    );
  });

  it("a throwing verb never skips the later verbs or the lease", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub({ failClose: true });
    const holder = spawnedHolder(budget, stub);
    await retireStub(holder, "wsClosed", "test", { budget });
    expect(stub.events).toEqual(["close:threw", "kill:atOnce"]);
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
  });

  it("stub-less holder: no verbs, but a held lease still goes back", async () => {
    const budget = new DynamicWorkerBudget();
    const holder = makeHolder({
      pageScriptLease: budget.acquire("pageScript"),
    });
    const harvest = await retireStub(holder, "closeTarget", "test", { budget });
    expect(harvest).toBeNull();
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    expect(budget.isolatesKilled).toBe(0);
  });

  it("double retire is a no-op", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub();
    const holder = spawnedHolder(budget, stub);
    stub.releaseUnload();
    await retireStub(holder, "navigate", "gen bump", { budget });
    const eventsAfterFirst = [...stub.events];
    await retireStub(holder, "navigate", "gen bump", { budget });
    expect(stub.events).toEqual(eventsAfterFirst);
    expect(budget.isolatesKilled).toBe(1);
    expect(budget.liveOf("pageScript")).toBe(0);
  });

  it("navigate: a failing unload still closes, kills and releases", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const budget = new DynamicWorkerBudget();
      const stub = makeStub({ failUnload: true });
      const holder = spawnedHolder(budget, stub);
      stub.releaseUnload();
      const harvest = await retireStub(holder, "navigate", "gen bump", { budget });
      expect(harvest).toBeNull();
      expect(stub.events).toEqual(["unload:start", "unload:done", "close", "kill"]);
      expect(holder.pageScriptLease).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("publishStub", () => {
  it("fresh: assigns, accounts the lease at publish, drops the gate", () => {
    const budget = new DynamicWorkerBudget();
    const holder = makeHolder({ blankReady: Promise.resolve() });
    const stub = makeStub();
    const ok = publishStub(holder, stub, { isStale: () => false }, { budget });
    expect(ok).toBe(true);
    expect(holder.pageScript).toBe(stub);
    expect(holder.pageScriptLease?.kind).toBe("pageScript");
    expect(budget.liveOf("pageScript")).toBe(1);
    expect(holder.blankReady).toBeNull();
    expect(stub.events).toEqual([]);
  });

  it("stale: holder untouched, no lease, stub disposed in the background", async () => {
    const budget = new DynamicWorkerBudget();
    const holder = makeHolder();
    const stub = makeStub();
    const ok = publishStub(holder, stub, { isStale: () => true }, { budget });
    expect(ok).toBe(false);
    expect(holder.pageScript).toBeNull();
    expect(holder.pageScriptLease).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    stub.releaseUnload();
    await vi.waitFor(() => expect(stub.events).toContain("kill"));
    expect(budget.isolatesKilled).toBe(1);
  });

  it("re-publish over a defensive stale lease never over-credits the ledger", () => {
    const budget = new DynamicWorkerBudget();
    const holder = makeHolder({
      pageScriptLease: budget.acquire("pageScript"),
    });
    publishStub(holder, makeStub(), {}, { budget });
    expect(budget.liveOf("pageScript")).toBe(1);
  });
});

describe("disposeStub", () => {
  it("unload:none runs close→kill synchronously", async () => {
    const budget = new DynamicWorkerBudget();
    const stub = makeStub();
    await disposeStub(stub, { unload: "none", reason: "test" }, { budget });
    expect(stub.events).toEqual(["close", "kill"]);
    expect(budget.isolatesKilled).toBe(1);
  });

  it("counts kills only when a ledger is in scope", async () => {
    const stub = makeStub();
    await disposeStub(stub, { unload: "none", reason: "no connection" });
    expect(stub.events).toEqual(["close", "kill"]);
  });

  it("keeps asynchronous isolate kills in the caller's lifetime", async () => {
    const stub = makeStub();
    let releaseKill = () => {};
    const killing = new Promise<void>((resolve) => (releaseKill = resolve));
    stub.killIsolate = () => {
      stub.events.push("kill");
      return killing;
    };
    const background: Promise<unknown>[] = [];

    await disposeStub(
      stub,
      { unload: "none", reason: "test" },
      {
        waitUntil: (promise) => background.push(promise),
      },
    );

    expect(background).toHaveLength(1);
    let backgroundSettled = false;
    void background[0]?.then(() => {
      backgroundSettled = true;
    });
    await Promise.resolve();
    expect(backgroundSettled).toBe(false);
    releaseKill();
    await background[0];
    expect(backgroundSettled).toBe(true);
  });
});
