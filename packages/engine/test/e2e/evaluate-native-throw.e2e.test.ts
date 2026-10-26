// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runtime.evaluate runs on boa, but a page function the classic bundle baked runs in V8. Its
// throw used to cross back as a bridged proxy that formatted as "Error: {\n\n}", losing the class
// and the message.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an exception thrown by native page code keeps its class and message", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `<script>window.fail = () => { throw new TypeError("broken styles"); };</script>`,
  );
  for (const expression of ["fail()", "[1].map(() => fail())", "(async () => fail())()"]) {
    const r = await cdpSession.send("Runtime.evaluate", { expression, awaitPromise: true });
    expect(r.exceptionDetails?.exception?.className, expression).toBe("TypeError");
    expect(r.exceptionDetails?.exception?.description, expression).toMatch(
      /^TypeError: broken styles\n/,
    );
  }
});
