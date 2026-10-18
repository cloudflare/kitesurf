// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! CSS for the page's JavaScript style APIs, computed styles, and CSS animations.

pub(crate) mod cssom;
pub(crate) mod transitions;
pub(crate) mod waapi;
pub(crate) mod computed;
pub(crate) mod animation;

#[cfg(test)]
mod tests;
