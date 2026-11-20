// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The document tree: DOM queries, mutation, shadow roots, input state, and the HTML
//! pre-scan.

pub(crate) mod inner_text;
pub(crate) mod scan;
pub(crate) mod tree;
pub(crate) mod mutate;
pub(crate) mod shadow;
pub(crate) mod input;
pub(crate) mod cdp;
pub(crate) mod accessibility;

#[cfg(test)]
mod tests;
