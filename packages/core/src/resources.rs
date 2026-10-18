// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Fetched page inputs: the shared font context and network resources.

pub(crate) mod fonts;
pub(crate) mod net;
pub(crate) mod delivery;

#[cfg(test)]
mod tests;
