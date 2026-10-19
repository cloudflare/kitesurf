![Kitesurf logo](kitesurf_logo.png)

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

## Project status

Kitesurf is a proof of concept. Web compatibility is incomplete, and many browser
features are not implemented. Do not use it as a general-purpose browser yet.

## Requirements

- Node.js 22 or newer
- pnpm 9.15.4, which the repository pins in `package.json`
- Rust through [rustup](https://rustup.rs/)

The repository pins the Rust nightly toolchain and the
`wasm32-unknown-unknown` target in `rust-toolchain.toml`. Rustup installs them
when you build the project.

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

Build the Rust and WebAssembly core:

```bash
pnpm run build:wasm
```

Start the local engine:

```bash
pnpm run dev
```

The engine listens on `http://127.0.0.1:8787`. Visit
`http://127.0.0.1:8787/health` to confirm that it is running.

The root URL has the same Chrome DevTools instructions as this README. Kitesurf
speaks CDP and has no web UI.

The first build downloads the pinned `wasm-bindgen` tools. The development
server builds the remaining JavaScript and renderer bundles before it starts.

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
[`scripts/patches/`](scripts/patches/).

## Cloudflare deployment

The repository supports local development with Wrangler. A complete self-hosting
workflow is not available yet.

The engine configuration includes a Worker Loader binding. Kitesurf uses this
binding to start a separate worker for each page and renderer. Cloudflare
Dynamic Workers provide this capability, and they require the Workers Paid plan.
See the [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
documentation before planning a Cloudflare deployment.

## Packages

| Package | Description |
| --- | --- |
| [`engine`](packages/engine/) | Cloudflare Worker and CDP server |
| [`page-script`](packages/page-script/) | Page DOM and JavaScript runtime |
| [`page-renderer`](packages/page-renderer/) | Renderer for recorded page scenes |
| [`dom-shim`](packages/dom-shim/) | DOM APIs inside the page worker |
| [`core`](packages/core/) | Rust layout, paint, and JavaScript engine code |
| [`renderer-core`](packages/renderer-core/) | Rust scene rasterizer for page rendering |
| [`scene-host-wasm`](packages/scene-host-wasm/) | Local scene rasterizer for the terminal client |
| [`kitesurf-cli`](packages/kitesurf-cli/) | Terminal client |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.
Report security problems as described in [SECURITY.md](SECURITY.md).

## License

Kitesurf is licensed under [Apache 2.0](LICENSE). Bundled fonts, data, and
dependencies keep their own licenses. See [NOTICE](NOTICE).
