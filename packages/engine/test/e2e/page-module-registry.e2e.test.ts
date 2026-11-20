// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The page isolate's module registry also holds the isolate's own modules under
// file:///bundle/. Page code must only reach its own http(s) modules.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PRIVATE = "file:///bundle/internal-state.js";

const report = (how: string) =>
  `(ns) => { document.title = "${how}:" + typeof ns.getInternalState; }`;

test("a page module cannot statically import the isolate's own modules", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>start</title><script type="module">
      import * as ns from "${PRIVATE}";
      (${report("static")})(ns);
    </script>`,
  );
  await page.waitForFunction(() => document.readyState === "complete");
  expect(await page.evaluate(() => document.title)).toBe("start");
});

test("a classic script cannot import the isolate's own modules", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>start</title><script>
      import("${PRIVATE}").then(${report("dynamic")}, () => { document.title = "refused"; });
    </script>`,
  );
  await expect.poll(() => page.evaluate(() => document.title)).toBe("refused");
});

test("the runtime module loader does not load the isolate's own modules", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>start</title><script>
      try {
        const internals = globalThis[Symbol.for("kitesurf.internals")];
        Promise.resolve(internals.nativeImport("${PRIVATE}"))
          .then(${report("loader")}, () => { document.title = "refused"; });
      } catch {
        document.title = "refused";
      }
    </script>`,
  );
  await expect.poll(() => page.evaluate(() => document.title)).toBe("refused");
});

test("an inserted script cannot import the isolate's own modules", async ({ page }) => {
  // Inserted inline scripts run on the embedded interpreter, whose loader asks the isolate first.
  await setContent(
    page,
    `<!doctype html><title>start</title><script>
      const s = document.createElement("script");
      s.textContent = 'import("${PRIVATE}").then(' + ${JSON.stringify(report("inserted"))} +
        ', () => { document.title = "refused"; });';
      document.body.appendChild(s);
    </script>`,
  );
  await expect.poll(() => page.evaluate(() => document.title)).toBe("refused");
});

test("a classic script the module lexer misreads cannot import the isolate's own modules", async ({
  page,
}) => {
  // The lexer stops at a regex after a block, which is valid in a script.
  await setContent(
    page,
    `<!doctype html><title>start</title><script>
      {}
      /}/.test("");
      import("./internal-state.js").then(${report("lexer")}, () => { document.title = "refused"; });
    </script>`,
  );
  await expect.poll(() => page.evaluate(() => document.title)).toBe("refused");
});
