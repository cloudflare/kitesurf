// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Terminal rendering: maps paint scenes to cells and handles terminal input and
//! chrome.

pub(crate) mod ansi;
pub(crate) mod grid;
pub(crate) mod input;
// The render-mode model (pixels vs characters, and what happens to
// images) and the modal that picks one.
pub(crate) mod modes;
pub(crate) mod omni;

#[cfg(test)]
mod tests;
