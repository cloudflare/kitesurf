# Vendored copy of wasm-memprof

Source: https://github.com/kateinoigakukun/wasm-memprof
Upstream commit: ecab678215b83e1c59d8e80967f96d03e9a62db6
Vendored: 2026-06-05

Used by the kitesurf `KITESURF_MEMPROF=1` build for build-time
WebAssembly heap profiling.

The `instrumentor/` crate's library API (`instrument(bytes, &[Tracee])`)
is used by `scripts/memprof-rewriter/`. We do not use the npm package —
we wrote our own minimal recorder baked into the page-script bundle
because the `WMProf.wrap()` pattern in wasm-memprof's npm package does
not work with workerd's precompiled WebAssembly.Module loading model
(the kitesurf core wasm is loaded inside a sub-isolate via Worker
Loader and instantiated synchronously by wasm-bindgen's `initSync`).

## What we kept vs upstream

Upstream provides four things; we only vendor the first:

  - `instrumentor/` — Rust crate, walrus-based wasm rewriter (KEPT)
  - `bindgen/` — wasm-bindgen wrapper that runs the rewriter in JS (DELETED)
  - `src/` + `dist/` — TS/JS source + pre-built bundle of npm package (DELETED)
  - `examples/`, `test/`, `docs/` (DELETED)

## kitesurf-specific note: panic=abort

kitesurf's production wasm is built with `panic = "unwind"`, which
emits the modern Wasm exception-handling instructions (`try_table`,
`throw_ref`). walrus 0.23.3 — the parser this instrumentor depends on —
does NOT support those ops (it `unimplemented!()`s on them). So the
memprof build path in `scripts/build-wasm.mjs` overrides the crate to
`panic = "abort"` (no EH instructions) via the `release-memprof`
profile + cargo `--config` rustflags. A diagnostic build doesn't need
unwinding, so this is harmless.

To re-vendor: `rm -rf vendor/wasm-memprof && cd vendor && git clone \
  --depth 1 https://github.com/kateinoigakukun/wasm-memprof.git && \
  rm -rf wasm-memprof/.git wasm-memprof/.github`
