// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { definePlugin } from "@oxlint/plugins";
import { conciseCommentsRule } from "./rules/concise-comments.ts";
import { explicitBoundaryReturnsRule } from "./rules/explicit-boundary-returns.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noUnnecessaryUnknownRule } from "./rules/no-unnecessary-unknown.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

export default definePlugin({
  meta: { name: "kitesurf" },
  rules: {
    "concise-comments": conciseCommentsRule,
    "explicit-boundary-returns": explicitBoundaryReturnsRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-unnecessary-unknown": noUnnecessaryUnknownRule,
    "no-widen-then-assert": noWidenThenAssertRule,
  },
});
