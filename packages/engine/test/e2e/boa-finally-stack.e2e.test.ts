// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("try/finally keeps the value stack aligned", async ({ page }) => {
  await page.goto(
    "data:text/html," + encodeURIComponent("<!doctype html><html><body></body></html>"),
    {
      waitUntil: "domcontentloaded",
    },
  );

  const results = await page.evaluate(() => ({
    nestedFinally: (function () {
      try {
        return "r";
      } finally {
        try {
        } finally {
        }
      }
    })(),
    caughtInFinally: (function () {
      try {
        return "r";
      } finally {
        try {
          // oxlint-disable-next-line no-unsafe-finally -- Boa must honor this throw in finally.
          throw new Error("x");
        } catch {}
      }
    })(),
    finallyWins: (function () {
      try {
        return "r";
      } finally {
        try {
          // oxlint-disable-next-line no-unsafe-finally -- Boa must honor a return from finally.
          return "f";
        } finally {
        }
      }
    })(),
    breakThroughFinally: (function () {
      let i = 0;
      for (; i < 3; i++) {
        try {
          if (i === 1) break;
        } finally {
          try {
            // oxlint-disable-next-line no-unsafe-finally -- Boa must preserve break through finally.
            throw new Error("x");
          } catch {}
        }
      }
      return i;
    })(),
    rethrown: (function () {
      try {
        try {
          throw new Error("boom");
        } finally {
          try {
          } finally {
          }
        }
      } catch (err) {
        return (err as Error).message;
      }
      // oxlint-disable-next-line no-unreachable -- Boa corpus retains code after the caught throw.
      return "not thrown";
    })(),
  }));

  expect(results).toEqual({
    nestedFinally: "r",
    caughtInFinally: "r",
    finallyWins: "f",
    breakThroughFinally: 1,
    rethrown: "boom",
  });
});

// boa 0.22 left the callee frame and any half-built call on the stack when a caller caught
// the callee's throw: wrong returns through finally, then a RuntimeLimitError.
test("a throw from a called function, caught by its caller, leaves the stack clean", async ({
  page,
}) => {
  await page.goto(
    "data:text/html," + encodeURIComponent("<!doctype html><html><body></body></html>"),
    {
      waitUntil: "domcontentloaded",
    },
  );

  const sync = await page.evaluate(() => {
    const fail = () => {
      throw new Error("close failed");
    };
    const take = (...args: unknown[]) => args.length;
    let caught = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        fail();
      } catch {
        caught++;
      }
    }
    let halfBuilt = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        take(1, 2, fail());
      } catch {
        halfBuilt++;
      }
    }
    let sameFrame = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        JSON.parse("{bad");
      } catch {
        sameFrame++;
      }
    }
    return {
      finallyCallsCallee: (function () {
        try {
          return "DATA";
        } finally {
          take(1, 2);
        }
      })(),
      finallyCatchesCallee: (function () {
        try {
          return "DATA";
        } finally {
          try {
            fail();
          } catch {}
        }
      })(),
      forOfReturnThroughFinally: (function () {
        for (const x of [7, 8]) {
          try {
            return x;
          } finally {
            try {
              fail();
            } catch {}
          }
        }
        return -1;
      })(),
      caught,
      halfBuilt,
      sameFrame,
    };
  });
  expect(sync).toEqual({
    finallyCallsCallee: "DATA",
    finallyCatchesCallee: "DATA",
    forOfReturnThroughFinally: 7,
    caught: 5000,
    halfBuilt: 5000,
    sameFrame: 5000,
  });

  const asyncResults = await page.evaluate(async () => {
    let caught = 0;
    for (let i = 0; i < 5000; i++) {
      await null;
      try {
        (function () {
          throw 1;
        })();
      } catch {
        caught++;
      }
    }
    async function* values() {
      yield 7;
      yield 8;
    }
    const forAwaitReturn = await (async () => {
      for await (const x of values()) {
        try {
          return x;
        } finally {
          await null;
        }
      }
      return -1;
    })();
    return { caught, forAwaitReturn };
  });
  expect(asyncResults).toEqual({ caught: 5000, forAwaitReturn: 7 });
}, 120_000);
