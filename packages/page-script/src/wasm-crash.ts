// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A trap poisons the wasm module and every later call throws "Module terminated". Report the trap
// once and have the engine end the page, as Chrome ends a page whose renderer died.

import { __setOnTerminated } from "./wasm-glue.js";
import { noteWasmTerminated, reportEngineError } from "./engine-error.ts";
import { sendUpstreamEvent } from "./internal-state.js";

const MAX_TRAP_MESSAGE_CHARS = 200;
let terminated = false;

export function installWasmTerminatedHandler(): void {
  __setOnTerminated((err) => {
    if (terminated) return;
    terminated = true;
    reportEngineError("wasm", err, "wasm module terminated");
    noteWasmTerminated();
    const message = err instanceof Error ? err.message : String(err);
    sendUpstreamEvent({
      event: "kitesurf.wasmTerminated",
      params: { message: message.slice(0, MAX_TRAP_MESSAGE_CHARS) },
    });
  });
}
