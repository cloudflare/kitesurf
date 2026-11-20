// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Boa evaluation of page expressions and its bridge to the V8 page isolate.

#[cfg(target_arch = "wasm32")]
pub(crate) mod boa_eval;
#[cfg(target_arch = "wasm32")]
pub(crate) mod boa_bridge;
pub(crate) mod boa_cc_graph;
#[cfg(target_arch = "wasm32")]
pub(crate) mod dom_fastpath;
#[cfg(target_arch = "wasm32")]
pub(crate) mod exports;
// Only the wasm-only boa bridge and the wasm clock read it.
#[cfg(target_arch = "wasm32")]
pub(crate) mod internals;

#[cfg(test)]
mod tests;
