// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! kitesurf-core's terminal grid; `modes` is a stub with the one image mode the byte ABI
//! uses.

#[allow(
    dead_code,
    reason = "The byte ABI uses halfblock paths; kitesurf-core checks the full TTY renderer."
)]
#[path = "../../core/src/tty/grid.rs"]
pub(crate) mod grid;

pub(crate) mod modes {
    #[derive(Clone, Copy, PartialEq, Eq, Default)]
    pub enum ImageMode {
        #[default]
        Halfblocks,
        Kitty,
    }
}
