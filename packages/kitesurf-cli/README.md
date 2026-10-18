# Kitesurf CLI

Kitesurf opens websites in your terminal. It receives scenes over
CDP and renders them locally using Kitty graphics; use `--mode=ansi` for
selectable text in any terminal.

## How it works

![End-to-end flow from website through the engine and CLI to the terminal](architecture.svg)

The engine sends drawing commands over CDP. The CLI replays them with the
server-matched Wasm rasterizer, displays Kitty graphics or ANSI text, and
acknowledges each scene so the engine can send the next one.

The engine supplies the scene-host manifest and bounded Wasm chunks over CDP.
The CLI verifies the artifact size and SHA-256 before caching it by hash.
Built-in fonts use an origin-scoped HTTP client and a bounded, ETag-validated
cache.

The Rust package also exposes the `kitesurf_playback` library. `play` accepts a
connected `CdpSocket`, validated `PlaybackOptions`, and a `FontSource` containing
the font origin and its HTTP client. Endpoint selection and authentication stay
with the frontend; `PlaybackOptions::new` enforces the 1-60 FPS limit.

In graphics mode, localized changes arrive as damage-rectangle scenes. The
downloaded rasterizer composites them into a retained viewport, so the CLI
replays only the changed region. It still displays a complete image using
ordinary Kitty image placement, including on Ghostty. Navigation, resize,
or a missing base frame triggers a full scene. Older rasterizers and ANSI
mode use full scenes.

For example, `<p style="font-family: sans-serif">Hello</p>` uses Kitesurf's
built-in Noto Sans font even though the page provides no font file. The CDP
resource batch identifies it as `/fonts/NotoSans.ttf`. If the rasterizer needs
it, the CLI fetches `/rbi/fonts/NotoSans.ttf` over HTTP and supplies the bytes
to the Wasm. A font loaded by the page with `@font-face` instead travels in
the CDP resource batch. The separately downloaded `scene_host.wasm` is the
rasterizer program, not a bundle of fonts.

[Mermaid source](architecture.mmd) · [PNG](architecture.png)

## Install

From a checkout of this repository, with Rust installed:

```sh
cargo install --path packages/kitesurf-cli --locked
```

This installs `kitesurf` in Cargo's bin directory (usually `~/.cargo/bin`).

## Run

Start a local Kitesurf engine on port 8787, then run:

```sh
kitesurf https://example.com/
```

The client defaults to your local engine, not the hosted Kitesurf service.
Set `KITESURF_SERVER=https://<your-worker-host>` to use another engine. A remote engine
requires HTTPS; plain HTTP is allowed only for loopback.

For selectable text, use `kitesurf --mode=ansi https://example.com/`.

## Running locally

Start the Kitesurf engine from the repo root, then run
the client in another terminal:

```sh
KITESURF_PORT=8799 KITESURF_INSPECTOR_PORT=9239 pnpm run dev
KITESURF_SERVER=http://127.0.0.1:8799 kitesurf https://example.com/
```

Running `kitesurf` without a URL shows command-line help. Local Kitty mode
needs a Kitty-graphics terminal such as Ghostty; ANSI mode works without one.

## Options

| Option                     | Description                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode=kitty\|ansi`       | Choose Kitty graphics (default) or ANSI text.                                                                                                                                                |
| `--fps N`                  | Cap the scene rate (1–60; default 60).                                                                                                                                                       |
| `--seconds N`              | Stop replay after N seconds and print measurements.                                                                                                                                          |
| `--no-display`             | Measure replay without drawing to the terminal.                                                                                                                                              |
| `--debug` (or `--verbose`) | Log connection, artifact/cache, font download and scene-stream events to stderr. With the full-screen display, later events print after it closes; use `--no-display --debug` for live logs. |
| `--version`                | Print the CLI version.                                                                                                                                                                       |
| `-h`, `--help`             | Show command-line help.                                                                                                                                                                      |

## Environment variables

| Variable             | Description                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KITESURF_SERVER`    | Engine URL. Defaults to `http://127.0.0.1:8787`. Remote engines require HTTPS; HTTP is allowed on loopback for local development.                  |
| `CF_ACCESS_TOKEN`    | Cloudflare Access token for a protected engine. Sent on the WebSocket handshake and same-origin font downloads; off-origin redirects are rejected. |
| `KITESURF_KITTY_PNG` | Use PNG instead of raw RGBA files in local Ghostty; useful for comparing rendering speed.                                                          |

For example, to use an engine behind Cloudflare Access:

```sh
cloudflared access login -app=https://kitesurf.example.com
CF_ACCESS_TOKEN=$(cloudflared access token -app=https://kitesurf.example.com) \
  KITESURF_SERVER=https://kitesurf.example.com \
  kitesurf https://example.com/
```

The stats bar is on by default. Press Ctrl-B to toggle it, or Ctrl-C to exit. Its `acct` value is
the server's accounted memory across the engine, page isolates, and renderer;
it omits untracked allocations and is not the Worker's total memory use.
