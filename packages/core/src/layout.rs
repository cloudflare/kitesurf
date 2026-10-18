// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Layout geometry: element rects, scroll state, hit testing, and sticky offsets.

pub(crate) mod sticky;
pub(crate) mod geometry;
pub(crate) mod scroll;
pub(crate) mod hit_test;
pub(crate) mod debug;

#[cfg(test)]
mod tests;
