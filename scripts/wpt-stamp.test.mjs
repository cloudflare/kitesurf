// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { stamp } from "./wpt-stamp.mjs";

test("stamping changes top-level run metadata only", () => {
  const input = {
    commit: "unknown",
    date: "2020-01-01T00:00:00.000Z",
    ref: "local",
    byFile: { "/x.html": { ref: "local", date: "keep" } },
  };
  const output = JSON.parse(
    stamp(Buffer.from(JSON.stringify(input, null, 2)), {
      commit: "abc123",
      ref: "main",
      date: "2026-10-15T00:00:00.000Z",
    }),
  );
  assert.deepEqual(output, {
    ...input,
    commit: "abc123",
    ref: "main",
    date: "2026-10-15T00:00:00.000Z",
  });
  const full = {
    date: "old",
    base: "b",
    ws: "",
    commit: null,
    slice: "ci-full",
    results: [{ test: "/r.html", ref: "/r-ref.html" }],
  };
  const stamped = JSON.parse(
    stamp(Buffer.from(JSON.stringify(full, null, 2)), {
      commit: "abc123",
      ref: "main",
      date: "now",
    }),
  );
  assert.deepEqual(stamped, { ...full, commit: "abc123", date: "now" });
  assert.throws(() => stamp(Buffer.from("{}"), { date: "now" }), /not a merged WPT report/);
});
