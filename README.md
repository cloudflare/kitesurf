# Kitesurf

Kitesurf is an experimental browser engine that runs on Cloudflare Workers. It
parses HTML, applies CSS, lays out and paints pages, and runs page scripts, all
inside Workers. There is no Chrome and no browser container.

You drive it with the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
(CDP), so tools that already speak CDP can use it:

- **Puppeteer** and other CDP clients can navigate, run JavaScript, send input,
  and capture screenshots, PDFs, and screencast frames.
- **AI agents** can use it through the Chrome DevTools MCP adapter.
- **Chrome DevTools** can inspect a live page and show its screencast.
- **Your terminal** can browse with the [terminal client](packages/kitesurf-cli/README.md).

Kitesurf is a proof of concept with gaps in web compatibility. See
[what works and what doesn't](#what-works-and-what-doesnt) before you rely on it.

## Quick start

You need:

- Node 22 and pnpm 9. Run `corepack enable` to get the pinned pnpm.
- Rust through [rustup](https://rustup.rs/). The repository pins its nightly
  toolchain and wasm target in `rust-toolchain.toml`, and rustup fetches both.
  Put `~/.cargo/bin` before any other Rust install (including Homebrew) on your
  `PATH`.

Then build and start the engine:

```bash
git clone https://github.com/cloudflare/kitesurf
cd kitesurf
pnpm install
pnpm run build:wasm   # builds the Rust core; skipped when it is up to date
pnpm run dev          # serves on http://127.0.0.1:8787
```

The first wasm build installs a matching `wasm-bindgen-cli` and caches it under
`~/.cache/kitesurf/`. Open `http://127.0.0.1:8787/health` to check the engine is
up. The root URL returns 404 on purpose: there is no web UI.

Now connect a client. With `puppeteer-core` installed:

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

Each WebSocket owns a separate browser session; disconnecting ends it. HTTP
discovery is at `http://127.0.0.1:8787/json/version`.

### MCP tools

Kitesurf speaks CDP, not MCP. Run
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) as a
local adapter and point it at the engine:

```json
{
  "mcpServers": {
    "kitesurf": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@1.11.0",
        "--wsEndpoint=ws://127.0.0.1:8787/devtools/browser",
        "--no-usage-statistics",
        "--no-performance-crux"
      ]
    }
  }
}
```

The adapter officially supports Chrome. Kitesurf implements part of CDP, so
profiling, audits, and other Chrome-specific tools may not work.

### Chrome DevTools

1. Open `chrome://inspect/#devices` and enable **Discover network targets**.
2. Choose **Configure** and add `127.0.0.1:8787`.
3. Click **inspect** next to **kitesurf**, then enter a URL above the screencast.

## Deploying

Self-hosting is not supported yet; run the engine locally with `wrangler dev`.
When it is, you will need a Workers Paid account, because Kitesurf runs page code
in [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/)
through the Worker Loader binding.

## How it works

Each CDP connection gets its own session in the engine Worker. The engine starts
two loaded Workers for it: **PageScript** runs the page's DOM, layout, and
scripts, and **PageRenderer** turns recorded paint scenes into images and PDFs.
Both use Rust compiled to WebAssembly, built on the
[Blitz](https://github.com/DioxusLabs/blitz) stack. Every page request goes
through a CORS gateway, and runtime `eval` runs in [boa](https://boajs.dev/), a
JavaScript engine compiled into the wasm module, never in the engine itself.

## What works and what doesn't

Kitesurf measures itself against a curated set of
[Web Platform Tests](https://github.com/web-platform-tests/wpt). Current results
are on the [WPT dashboard](https://kitesurf.dev/wpt).

Known limits:

- **Iframes** take one of two paths. Same-origin frames without scripts render
  in-process. Cross-origin or scripted frames run in their own isolate, so
  same-origin scripted frames lose synchronous cross-frame access, and
  `sandbox` is not enforced.
- **ES modules** are fetched and bundled at navigation. Import maps must be
  inline, computed dynamic imports run in boa, and TypeScript, JSX, and CSS
  modules are not supported.
- **SVG** renders from snapshots, not a live SVG DOM, and `<foreignObject>` HTML
  does not render. AVIF is not supported.
- **Bot challenges** are not bypassed. Outbound requests are plain `fetch()`, so
  sites behind a bot challenge serve the challenge page.
- **Sessions end with the WebSocket.** Cookies, page state, timers, and
  listeners do not survive a disconnect.
- **Not implemented:** WebGL, WebGPU, Web Audio, WebRTC, and service workers.

## Repository layout

| Path                                                  | What it is                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/engine/`                                    | The engine Worker: CDP, sessions, and rendering. Its e2e suite and fixture Worker live under `test/`. |
| `packages/page-script/`                               | The per-page Worker that runs the page.                                                               |
| `packages/page-renderer/`                             | The stateless Worker that rasterizes scenes.                                                          |
| `packages/dom-shim/`                                  | The page's `window`, `document`, and DOM APIs, in TypeScript.                                         |
| `packages/core/`                                      | The Rust core: Blitz wrapper, layout, paint, fonts, and boa eval.                                     |
| `packages/renderer-core/`                             | The smaller Rust module that replays scenes for PageRenderer.                                         |
| `packages/kitesurf-cli/`, `packages/scene-host-wasm/` | The terminal client and its local rasterizer.                                                         |
| `packages/script-gate/`                               | Shared script policy: SRI, CSP, and MIME checks.                                                      |
| `scripts/`, `tests/`                                  | Build and test runners, vendored-crate patches, and the WPT allow-list.                               |

## Building with Bazel

The repository is also a Bazel module, so another Bazel workspace can depend on
the engine. The pnpm workflow above is the main way to build and test, and it is
what CI runs. To use Bazel instead, install
[Bazelisk](https://github.com/bazelbuild/bazelisk); it reads `.bazelversion` and
fetches the pinned Bazel. Then, from the repository root:

```bash
bazel build //packages/engine:dist     # builds the engine Worker bundle
bazel test //packages/engine:types     # type-checks the engine
bazel test //packages/engine:vitest    # runs the engine's unit tests
bazel test //packages/core:core_test   # runs the Rust core's tests
```

Bazel downloads the vendored crates and applies the patch series under
`scripts/patches/` itself, so `pnpm run build:wasm` is not needed first.

## Contributing

We welcome bug reports and focused fixes. Open an
[issue](https://github.com/cloudflare/kitesurf/issues) first and wait for a
maintainer to agree on the scope: pull requests from contributors who have not
been vouched for are closed automatically. [CONTRIBUTING.md](CONTRIBUTING.md)
explains the process, and [AGENTS.md](AGENTS.md) has the development rules.

Report security issues as described in [SECURITY.md](SECURITY.md), not in public
issues.

## License

Kitesurf's own code is licensed under [Apache 2.0](LICENSE). Bundled fonts, data,
and dependencies keep their own licenses; see [NOTICE](NOTICE). Keep `LICENSE`,
`NOTICE`, and the license texts they reference with any artifact you distribute,
and generate Rust notices for the exact lockfile and target you ship (the
`cargo about` steps in `.github/workflows/`).
