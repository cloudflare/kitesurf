![Kitesurf logo](.github/assets/kitesurf_logo.png)

# Kitesurf

Kitesurf is an experimental browser engine that runs on Cloudflare Workers. It
parses HTML, applies CSS, runs page JavaScript, and renders screenshots without
Chrome or a browser container.

Kitesurf speaks the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/),
so you can use it with CDP clients such as Puppeteer.

> [!IMPORTANT]
> Kitesurf requires Cloudflare Dynamic Workers to create isolated workers for
> pages. Dynamic Workers are part of the [Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
> Local development uses `wrangler dev`. A Cloudflare Workers Paid plan is
> required to run Kitesurf on Cloudflare.

## Requirements

- [Bazelisk](https://github.com/bazelbuild/bazelisk), installed as `bazel`.
  Bazel builds everything. It downloads the pinned Bazel, Rust toolchains,
  wasm-bindgen, and binaryen itself.
- Node.js 22 or newer
- pnpm 9.15.4, which the repository pins in `package.json`
- On macOS, GNU tar (`brew install gnu-tar`)
- Rust through [rustup](https://rustup.rs/), only for editing the vendored
  crate patches. `rust-toolchain.toml` pins the same nightly that Bazel uses.

Install pnpm separately if it is not already available:

```bash
npm install --global pnpm@9.15.4
```

## Build and run locally

Clone the repository and install its dependencies:

```bash
git clone https://github.com/cloudflare/kitesurf.git
cd kitesurf
pnpm install --frozen-lockfile
```

Build and start the local engine:

```bash
pnpm run dev
```

The engine listens on `http://127.0.0.1:8787`. Visit
`http://127.0.0.1:8787/health` to confirm that it is running.

The root URL has the same Chrome DevTools instructions as this README. Kitesurf
speaks CDP and has no web UI.

`pnpm run dev` builds the WebAssembly modules and the page and renderer bundles
with Bazel, then starts `wrangler dev`. The first build compiles the Rust core
and its vendored crates, which takes a while; later builds reuse Bazel's cache.

Set `KITESURF_PORT` when port `8787` is already in use:

```bash
KITESURF_PORT=8799 pnpm run dev
```

## Connect with Puppeteer

Install `puppeteer-core` in the project that will control Kitesurf. Then connect
to the browser WebSocket endpoint:

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://127.0.0.1:8787/devtools/browser",
});

const page = await browser.newPage();
await page.goto("https://example.com/");
await page.screenshot({ path: "page.png" });

await browser.disconnect();
```

Use the port from `KITESURF_PORT` if you selected a different port. HTTP
discovery is available at `http://127.0.0.1:8787/json/version`.

## Use Chrome DevTools

1. Open `chrome://inspect/#devices` in Chrome. Type or paste it into the address
   bar because web pages cannot link to it.
2. Select **Discover network targets**.
3. Select **Configure...** and add `127.0.0.1:8787`.
4. Under **Remote Target**, select **inspect** next to **kitesurf**.
5. Enter a page URL in the address bar above the screencast.

Use the port from `KITESURF_PORT` when you select a different local port. Chrome
discovers targets with plain HTTP and WebSocket connections. The `chrome://inspect`
workflow cannot reach an HTTPS engine. Use it with a local engine instead.

Kitesurf provides a CDP endpoint, not a full Chrome implementation. Some Chrome
DevTools features do not work yet. We are working to add more support over time.
Puppeteer and other CDP clients can connect to
`ws://127.0.0.1:8787/devtools/browser`.

## Build and test

The pnpm scripts are front ends to Bazel:

```bash
pnpm run build                    # bazel run //packages/engine:dev_build
pnpm run check                    # type checks, bundles, and repository checks
pnpm run test:unit                # engine vitest and Rust host tests
pnpm run test:e2e <file-substring>
pnpm run format:check             # oxfmt; pnpm run format rewrites the same files
pnpm run format:rust              # format Rust with Bazel's pinned rustfmt
pnpm run lint                     # oxlint, the custom lint rules, and Rust lint
```

The Rust formatter rewrites tracked and non-ignored untracked files, excluding
paths in `.oxfmtrc.json`.

`pnpm run build` copies the Bazel-built WebAssembly, bundles, and RBI files into
the source tree, where `wrangler dev` reads them. Other targets run directly,
for example `bazel test //tests/e2e:gate` for the full e2e suite. Another Bazel
workspace can depend on this repository as a module.

## Technology stack

Kitesurf combines several open-source Rust projects:

- [Blitz](https://github.com/DioxusLabs/blitz) provides HTML parsing, the DOM,
  layout, and painting. It is licensed under `MIT OR Apache-2.0`.
- [Stylo](https://github.com/servo/stylo) provides CSS parsing, cascading, and
  computed styles. It is licensed under `MPL-2.0`.
- [Boa](https://github.com/boa-dev/boa) runs page JavaScript inside WebAssembly.
  It is licensed under `Unlicense OR MIT`.
- [Linebender](https://linebender.org/) libraries provide text layout and 2D
  graphics, including [Parley](https://github.com/linebender/parley),
  [Vello](https://github.com/linebender/vello),
  [Kurbo](https://github.com/linebender/kurbo), and
  [Peniko](https://github.com/linebender/peniko). These libraries are licensed
  under `Apache-2.0 OR MIT`.
- [Krilla](https://github.com/LaurenzV/krilla) generates PDF output. It is
  licensed under `MIT OR Apache-2.0`.

Kitesurf patches its Rust dependencies. The patch series are in
[`scripts/patches/`](scripts/patches/), and Bazel applies them itself.

## Cloudflare deployment

The repository supports local development with Wrangler. A complete self-hosting
workflow is not available yet.

The engine configuration includes a Worker Loader binding. Kitesurf uses this
binding to start a separate worker for each page and renderer. Cloudflare
Dynamic Workers provide this capability, and they require the Workers Paid plan.
See the [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
documentation before planning a Cloudflare deployment.

## Packages

| Package                                        | Description                                    |
| ---------------------------------------------- | ---------------------------------------------- |
| [`engine`](packages/engine/)                   | Cloudflare Worker and CDP server               |
| [`page-script`](packages/page-script/)         | Page DOM and JavaScript runtime                |
| [`page-renderer`](packages/page-renderer/)     | Renderer for recorded page scenes              |
| [`dom-shim`](packages/dom-shim/)               | DOM APIs inside the page worker                |
| [`core`](packages/core/)                       | Rust layout, paint, and JavaScript engine code |
| [`renderer-core`](packages/renderer-core/)     | Rust scene rasterizer for page rendering       |
| [`scene-host-wasm`](packages/scene-host-wasm/) | Local scene rasterizer for the terminal client |
| [`kitesurf-cli`](packages/kitesurf-cli/)       | Terminal client                                |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.
Report security problems as described in [SECURITY.md](SECURITY.md).

## License

Kitesurf is licensed under [Apache 2.0](LICENSE). Bundled fonts, data, and
dependencies keep their own licenses. See [NOTICE](NOTICE).
