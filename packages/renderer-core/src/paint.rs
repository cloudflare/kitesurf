// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The paint files shared with kitesurf-core, in core's module tree so `crate::paint::*`
//! paths resolve here too.

#[allow(
    dead_code,
    reason = "PageRenderer uses the decode path; kitesurf-core checks the full decoder."
)]
#[path = "../../core/src/paint/scene_decode.rs"]
pub(crate) mod scene_decode;
#[allow(
    dead_code,
    reason = "PageRenderer borrows codec definitions; kitesurf-core checks the full recorder."
)]
#[path = "../../core/src/paint/scene_record.rs"]
pub(crate) mod scene_record;
#[allow(
    unexpected_cfgs,
    reason = "Shared with kitesurf-core, where `blitz` enables HTML-to-image exports."
)]
#[path = "../../core/src/paint/screenshot.rs"]
pub(crate) mod screenshot;
#[allow(
    dead_code,
    reason = "PageRenderer exposes a replay subset; kitesurf-core checks the full replay module."
)]
#[path = "../../core/src/paint/scene_replay.rs"]
pub(crate) mod scene_replay;
#[path = "../../core/src/paint/font_container.rs"]
pub(crate) mod font_container;
#[path = "../../core/src/paint/pdf_paint.rs"]
pub(crate) mod pdf_paint;
