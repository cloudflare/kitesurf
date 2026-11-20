# Test examples for the Docker image

These examples run end-to-end tests against the Kitesurf Docker image. Both
suites test the same small app:

- [`app/`](app/server.ts): a todo list. It loads its items from a JSON API
  and adds items with a form.
- [`playwright/`](playwright/): Playwright Test. The fixtures in
  [`tests/fixtures.ts`](playwright/tests/fixtures.ts) connect to the engine
  instead of launching a browser.
- [`puppeteer/`](puppeteer/): Puppeteer with the Node.js test runner.

Neither suite downloads a browser. `@playwright/test` and `puppeteer-core` only
connect to the engine over CDP.

The examples use `ghcr.io/cloudflare/kitesurf:latest`. To use an image that you
built with [`docker/Dockerfile`](../Dockerfile), set `KITESURF_IMAGE`, for
example `KITESURF_IMAGE=kitesurf`.

## Run with Docker Compose

[`compose.yml`](compose.yml) puts the engine, the app and the test suites on
one network, as a CI job does. The tests reach the engine at `kitesurf:8787`,
and the engine reaches the app at `app:3000`. Run these commands from the
repository root:

```bash
docker compose -f docker/examples/compose.yml run --rm playwright
docker compose -f docker/examples/compose.yml run --rm puppeteer
docker compose -f docker/examples/compose.yml down
```

The test containers install the packages into a copy of the suite, so the run
writes nothing into your checkout.

## Run on your machine

You need Node.js 22.18 or newer, which runs the TypeScript files without a
build step. Start the engine and the app in separate terminals:

```bash
docker run --rm -p 127.0.0.1:8787:8787 --add-host=host.docker.internal:host-gateway \
  ghcr.io/cloudflare/kitesurf
node docker/examples/app/server.ts
```

Then run a suite:

```bash
cd docker/examples/playwright   # or docker/examples/puppeteer
npm install
npm test
```

To typecheck a suite or the app, run `npm run types` in its directory.

The engine runs in the container, so it reaches the app on your machine at
`http://host.docker.internal:3000/`. Docker Desktop provides this name. On
Linux, the `--add-host` option above adds it.

The suites read two environment variables:

- `KITESURF_WS`: the engine's browser endpoint. The default is
  `ws://127.0.0.1:8787/devtools/browser`.
- `APP_URL`: the app's URL, as the engine sees it. The default is
  `http://host.docker.internal:3000/`.

Playwright writes its screenshot to `test-results/`. The Puppeteer suite writes
a screenshot and a PDF to `output/`.

## Run in GitHub Actions

Run the engine as a service container, and start the app on the runner:

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    services:
      kitesurf:
        image: ghcr.io/cloudflare/kitesurf:latest
        ports:
          - 8787:8787
        options: --add-host=host.docker.internal:host-gateway
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node docker/examples/app/server.ts &
      - run: npm install
        working-directory: docker/examples/playwright
      - run: npm test
        working-directory: docker/examples/playwright
```

The runner reaches the engine at `127.0.0.1:8787`, which the defaults use. The
app must listen on all interfaces, because the engine connects to it through
the Docker bridge.

## Limits

- Kitesurf has one browser context. The Playwright fixtures share it between
  tests, clear its cookies after each test and run one test at a time.
  Playwright keeps a trace and a screenshot of each failed test in
  `test-results/`.
- `page.pdf()` in Puppeteer and Playwright reads the PDF through CDP's IO
  streams, which Kitesurf does not have yet. The Puppeteer suite sends
  `Page.printToPDF` itself and reads the inline PDF.
- Kitesurf is not Chrome. Use it for most of your tests, and keep a smaller
  suite on real browsers for browser compatibility.
