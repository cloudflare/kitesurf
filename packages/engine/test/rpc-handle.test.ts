// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import { disposeRpcHandle } from "../src/eval/rpc-handle.ts";

it("disposes callable RPC handles with the handle as their receiver", () => {
  const receivers: unknown[] = [];
  const handle = Object.assign(() => {}, {
    [Symbol.dispose]() {
      receivers.push(this);
    },
  });

  disposeRpcHandle(handle);

  expect(receivers).toEqual([handle]);
});
