// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { TailExceptionReport } from "../src/engine-errors.ts";
import { PageScriptTail, type PageScriptTailProps } from "../src/eval/page-script-tail.ts";

const TOKEN = "tail-token";
const HUNG =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

class RecordingTail extends PageScriptTail {
  readonly reports: TailExceptionReport[] = [];
  protected override reportException(report: TailExceptionReport): void {
    this.reports.push(report);
  }
}

function invocation(lines: string[], exception: string): TailExceptionReport[] {
  const props: PageScriptTailProps = { scriptName: "page-test", ksErrToken: TOKEN };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- props-only ExecutionContext fixture.
  const ctx = { props } as unknown as ExecutionContext;
  const tail = new RecordingTail(ctx, {});
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- the handler ignores the onset event.
  const handler = tail.tailStream({} as unknown as TailStream.TailEvent<TailStream.Onset>);
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- the engine tail returns its handler object.
  const events = handler as unknown as {
    log(ev: unknown): void;
    exception(ev: unknown): void;
    outcome(ev: unknown): void;
  };
  const timestamp = new Date(0);
  for (const message of lines) events.log({ event: { level: "log", message }, timestamp });
  events.exception({ event: { name: "Error", message: exception }, timestamp });
  events.outcome({ event: { outcome: "exception", cpuTime: 0, wallTime: 0 }, timestamp });
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
