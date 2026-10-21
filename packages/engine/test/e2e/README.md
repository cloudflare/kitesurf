# e2e demo tests

These drive the **real kitesurf engine** — built to a dist and booted
in-process by `@cloudflare/vitest-plugin` (miniflare) as an auxiliary worker —
over the Chrome DevTools Protocol via **`@cloudflare/puppeteer`**. No dev
server, no port, no network: fixtures are served by the engine itself
through the `outboundService` loopback, so the suite is hermetic and
deterministic in CI.

## Layout

```
test/e2e/
  global-setup.ts   builds the engine dist (reuses the wasm-build artifact)
  vitest.e2e.config.mts (../../)  loads the dist as a pool aux worker
  connect.ts        wraps the engine's /devtools/browser WS as a puppeteer transport
  harness.ts        the shared `test` (browser/page/cdpSession fixtures) + `expect`
  smoke.e2e.test.ts foundation smoke (connect + navigate + evaluate)
  demos/*.e2e.test.ts  one gating test per demo
```

## Writing a new test

Create `test/e2e/demos/<name>.e2e.test.ts`:

```ts
import { expect, test } from "../harness";

test("<name>", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/<fixture>.html", {
    waitUntil: "domcontentloaded",
  });
  const title = await page.evaluate(() => document.title);
  expect(title).toContain("kitesurf");
});
```

- Import `test` and `expect` from the harness, not from `vitest`.
- Destructure the fixtures you need: `browser` (an `@cloudflare/puppeteer`
  Browser connected to the engine), `page` (its initial page) or
  `cdpSession` (a CDP session on `page`). Each is torn down after the
  test.
- When the connection needs upgrade headers, a query string, another
  binding, or there must be more than one, call `browserFactory`:
  `await browserFactory({ headers: { "x-kitesurf-skip-raster": "1" } })`.
  It disconnects every browser it opened when the test ends, so the test
  needs no `try`/`finally`.
- Navigate self-served fixtures at `http://127.0.0.1:8787/__fixtures/*`
  (the host is irrelevant — the loopback serves by pathname). Real
  external URLs won't load in the hermetic pool.
- **Assert with vitest `expect()`** — not a hand-rolled `check()` /
  `process.exitCode`.
- `page.evaluate(fn)` runs `fn` in the page (browser globals: `document`,
  `window`, …). Under the pool, page eval goes through **boa** (the prod
  path), not native V8 — write assertions that hold under boa.

## Fixtures

Add HTML/JS/binary fixtures under `packages/engine/test/fixtures-worker/assets/`
and list them in `packages/engine/test/fixtures-worker/src/static.ts` (served at
`/__fixtures/<name>`). Keep them minimal + self-contained.

## Running

```
pnpm --filter @kitesurf/engine test:e2e     # full suite (builds the dist)
KS_E2E_SKIP_BUILD=1 pnpm --filter @kitesurf/engine test:e2e   # reuse dist (fast)
pnpm --filter @kitesurf/engine exec vitest run --config vitest.e2e.config.mts \
  test/e2e/demos/<name>.e2e.test.ts         # one file
```

CI does not run this suite; run the files you touch locally. Only the harness (top-level
`*.ts`) is typechecked; the demo bodies under `demos/` are transpiled +
run (the run is the gate).

## Migration note

The `demos/*.e2e.test.ts` here were mechanically converted from earlier
standalone scripts. Many still carry their original assert
helpers (`process.exitCode`, a local `check()` / `expect()`); those are
being cleaned to vitest `expect()` over time. New tests should use
`expect()` from the start.
