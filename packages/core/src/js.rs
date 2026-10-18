// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Boa evaluation of page expressions and its bridge to the V8 page isolate.

#[cfg(target_arch = "wasm32")]
pub(crate) mod boa_eval;
#[cfg(target_arch = "wasm32")]
pub(crate) mod boa_bridge;
#[cfg(target_arch = "wasm32")]
pub(crate) mod dom_fastpath;
#[cfg(target_arch = "wasm32")]
pub(crate) mod exports;

#[cfg(test)]
mod tests;
