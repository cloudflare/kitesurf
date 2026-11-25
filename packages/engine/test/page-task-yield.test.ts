// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Engine replies give due page tasks a bounded number of task turns, but skip the
// turn when no page task is due. Each turn is a native setTimeout(0) round trip.
// The page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  pageTurns: 0,
  bridgeJobs: 0,
}));

vi.mock("../../page-script/src/wasm-glue.js", () => ({
  ks_bridge_ever_minted: () => true,
  ks_run_page_jobs: () => {
    hoisted.bridgeJobs++;
  },
}));

vi.mock("../../page-script/src/dom-shim.js", () => ({
  setAnimationTaskScheduler: () => {},
  setModelContextTaskScheduler: () => {},
  setWrapperSweepScheduler: () => {},
}));

vi.mock("../../page-script/src/intersection-observer.ts", () => ({
  installIntersectionObserver: () => {},
  recheckIntersectionObservers: () => {},
}));

vi.mock("../../page-script/src/native-scheduling.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    yieldToPageTasks: (ms?: number) => {
      hoisted.pageTurns++;
      return actual.yieldToPageTasks(ms);
    },
  };
});

let pageTasks: any;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

beforeAll(async () => {
  pageTasks = await vi.importActual("../../page-script/src/page-tasks.ts");
  // Route page timers through the wheel, as page-script does for a real page.
  pageTasks.installPageTaskGlobals(null, () => {});
});

beforeEach(() => {
  hoisted.pageTurns = 0;
  hoisted.bridgeJobs = 0;
});

afterEach(async () => {
  // Leave no wheel entry behind for the next case.
  for (let i = 0; i < 8 && pageTasks.pageTimerDueWithin(0); i++) {
    await pageTasks.yieldToDuePageTasks(1);
  }
});

describe("yieldToDuePageTasks", () => {
  it("skips the task turn when no page task is due", async () => {
    await pageTasks.yieldToDuePageTasks(3);
    expect(hoisted.pageTurns).toBe(0);
    // The skipped turn's remaining effect, the boa job drain, still runs.
    expect(hoisted.bridgeJobs).toBeGreaterThan(0);
  });

  it("does not wait for a timer that is not yet due", async () => {
    let fired = false;
    const id = globalThis.setTimeout(() => {
      fired = true;
    }, 60_000);
    try {
      await pageTasks.yieldToDuePageTasks(3);
      expect(hoisted.pageTurns).toBe(0);
      expect(fired).toBe(false);
    } finally {
      globalThis.clearTimeout(id);
    }
  });

  it("still yields to a due timer before returning", async () => {
    let fired = false;
    globalThis.setTimeout(() => {
      fired = true;
    }, 0);
    await pageTasks.yieldToDuePageTasks(3);
    expect(fired).toBe(true);
    expect(hoisted.pageTurns).toBeGreaterThan(0);
    expect(hoisted.pageTurns).toBeLessThanOrEqual(3);
  });

  it("yields to a timer scheduled by a pending microtask", async () => {
    let fired = false;
    void Promise.resolve().then(() =>
      globalThis.setTimeout(() => {
        fired = true;
      }, 0),
    );
    await pageTasks.yieldToDuePageTasks(3);
    expect(fired).toBe(true);
    expect(hoisted.pageTurns).toBeGreaterThan(0);
  });

  it("lets a microtask chain longer than the settle drain finish", async () => {
    let finished = false;
    void (async () => {
      for (let i = 0; i < 200; i++) await null;
      finished = true;
    })();
    await pageTasks.yieldToDuePageTasks(3);
    expect(finished).toBe(true);
    expect(hoisted.pageTurns).toBe(0);
  });

  it("treats a queued port task as due", async () => {
    let ran = false;
    pageTasks.queuePortTask(() => {
      ran = true;
    });
    await pageTasks.yieldToDuePageTasks(3);
    expect(ran).toBe(true);
    expect(hoisted.pageTurns).toBeGreaterThan(0);
  });

  it("leaves the boa job drain to a paused pump", async () => {
    const resume = await pageTasks.pausePageTaskPump();
    try {
      await pageTasks.yieldToDuePageTasks(3);
      expect(hoisted.pageTurns).toBe(0);
      expect(hoisted.bridgeJobs).toBe(0);
    } finally {
      resume();
    }
  });

  it("caps an endless zero-delay chain at maxTurns", async () => {
    let running = true;
    let level = 0;
    const step = () => {
      level++;
      if (running) globalThis.setTimeout(step, 0);
    };
    globalThis.setTimeout(step, 0);
    try {
      await pageTasks.yieldToDuePageTasks(3);
      expect(hoisted.pageTurns).toBe(3);
      expect(level).toBeGreaterThan(0);
    } finally {
      running = false;
    }
  });
});

afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
