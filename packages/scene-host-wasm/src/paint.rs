// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The paint files shared with kitesurf-core, in core's module tree so `crate::paint::*`
//! paths resolve here too.

#[allow(
    dead_code,
    reason = "The byte ABI uses decode paths; kitesurf-core checks the full decoder."
)]
#[path = "../../core/src/paint/scene_decode.rs"]
pub(crate) mod scene_decode;
#[allow(
    dead_code,
    reason = "The byte ABI borrows codec definitions; kitesurf-core checks the full recorder."
)]
#[path = "../../core/src/paint/scene_record.rs"]
pub(crate) mod scene_record;
#[allow(
    dead_code,
    reason = "The byte ABI exposes a replay subset; kitesurf-core checks the full replay module."
)]
#[path = "../../core/src/paint/scene_replay.rs"]
pub(crate) mod scene_replay;
#[allow(
    dead_code,
    reason = "The byte ABI uses PNG/RGBA paths; kitesurf-core checks retained JPEG support."
)]
#[path = "../../core/src/paint/screenshot.rs"]
pub(crate) mod screenshot;
