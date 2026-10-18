// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Adds drained console, cookie, exception, and DOM effects to evaluation results.

import type { EvalResult } from "@kitesurf/jsrpc-types/page-script";
import type { PackedException, PackedResult } from "@kitesurf/jsrpc-types/shared";
import { drainCdpMutations, drainConsole } from "./console-buffer.ts";
import { takeDocumentReopened } from "./internal-state.js";
import { yieldToPageTasks } from "./native-scheduling.ts";
import { state } from "./state.ts";

const POST_EVAL_TASK_TURNS = 3;

export type EvalResultBody = PackedResult | PackedException;

export async function drainEvalResult(result: EvalResultBody): Promise<EvalResult> {
  for (let i = 0; i < POST_EVAL_TASK_TURNS; i++) {
    await yieldToPageTasks();
  }
  return Object.assign(result, {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    documentReopened: takeDocumentReopened(),
  });
}
