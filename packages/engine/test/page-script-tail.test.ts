// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { TailExceptionReport } from "../src/engine-errors.ts";
import {
  registerIsolateLimitListener,
  unregisterIsolateLimitListener,
  type IsolateLimitNotice,
} from "../src/eval/limit-registry.ts";
import { PageScriptTail, type PageScriptTailProps } from "../src/eval/page-script-tail.ts";

const TOKEN = "tail-token";
const SCRIPT = "page-test";
const HUNG =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

class RecordingTail extends PageScriptTail {
  readonly reports: TailExceptionReport[] = [];
  protected override reportException(report: TailExceptionReport): void {
    this.reports.push(report);
  }
}

function newTail(): RecordingTail {
  const props: PageScriptTailProps = { scriptName: SCRIPT, ksErrToken: TOKEN };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- props-only ExecutionContext fixture.
  const ctx = { props } as unknown as ExecutionContext;
  return new RecordingTail(ctx, {});
}

function traceItem(logs: TraceLog[], exceptions: TraceException[], outcome: string): TraceItem {
  return {
    event: null,
    eventTimestamp: null,
    logs,
    exceptions,
    diagnosticsChannelEvents: [],
    scriptName: SCRIPT,
    outcome,
    executionModel: "stateless",
    truncated: false,
    cpuTime: 0,
    wallTime: 0,
  };
}

function log(message: string, timestamp = 0): TraceLog {
  return { level: "log", message: [message], timestamp };
}

function exception(message: string, timestamp = 0): TraceException {
  return { name: "Error", message, timestamp };
}

function invocation(lines: string[], thrown: string): TailExceptionReport[] {
  const tail = newTail();
  tail.tail([
    traceItem(
      lines.map((line) => log(line)),
      [exception(thrown)],
      "exception",
    ),
  ]);
  return tail.reports;
}

describe("PageScriptTail isolate kills", () => {
  it("does not report the hung cancellation of an authenticated kill", () => {
    expect(invocation([`[ks-kill] ${TOKEN} engine WS closed`], HUNG)).toEqual([]);
  });

  it("reports a hung invocation without a kill line", () => {
    expect(invocation([], HUNG)).toHaveLength(1);
  });

  it("reports a hung invocation whose kill line has the wrong token", () => {
    expect(invocation(["[ks-kill] forged engine WS closed"], HUNG)).toHaveLength(1);
  });

  it("reports other exceptions after a kill line", () => {
    expect(invocation([`[ks-kill] ${TOKEN} engine WS closed`], "boom")).toHaveLength(1);
  });
});

describe("PageScriptTail event order", () => {
  it("attaches a panic line logged before the exception", () => {
    const tail = newTail();
    tail.tail([traceItem([log("panicked at core.rs", 1)], [exception("boom", 2)], "exception")]);
    expect(tail.reports).toHaveLength(1);
    expect(tail.reports[0]?.panicStack).toBe("panicked at core.rs");
  });

  it("does not attach a panic line logged after the exception", () => {
    const tail = newTail();
    tail.tail([traceItem([log("panicked at core.rs", 2)], [exception("boom", 1)], "exception")]);
    expect(tail.reports).toHaveLength(1);
    expect(tail.reports[0]?.panicStack).toBeUndefined();
  });

  it("keeps kill state separate for each invocation in a batch", () => {
    const tail = newTail();
    tail.tail([
      traceItem([log(`[ks-kill] ${TOKEN} engine WS closed`)], [exception(HUNG)], "exception"),
      traceItem([], [exception(HUNG)], "exception"),
    ]);
    expect(tail.reports).toHaveLength(1);
  });
});

describe("PageScriptTail limit notices", () => {
  const record = (): IsolateLimitNotice[] => {
    const notices: IsolateLimitNotice[] = [];
    registerIsolateLimitListener(SCRIPT, (notice) => notices.push(notice));
    return notices;
  };

  it("reports an exceeded CPU limit from the invocation outcome", () => {
    const notices = record();
    newTail().tail([traceItem([], [], "exceededCpu")]);
    expect(notices).toEqual([{ kind: "cpu", capMs: 0, fromTail: true }]);
  });

  it("reports an exceeded memory limit from the invocation outcome", () => {
    const notices = record();
    newTail().tail([traceItem([], [], "exceededMemory")]);
    expect(notices).toEqual([{ kind: "memory", capMs: 0, fromTail: true }]);
  });

  it("sends no notice for a successful invocation", () => {
    const notices = record();
    newTail().tail([traceItem([], [], "ok")]);
    unregisterIsolateLimitListener(SCRIPT);
    expect(notices).toEqual([]);
  });
});
