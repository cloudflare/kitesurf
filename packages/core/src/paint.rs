// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Paint scenes (record, decode, replay), canvas rasterization, and PDF and image
//! output.

pub(crate) mod scene_record;
pub(crate) mod scene_decode;
#[cfg_attr(
    not(feature = "scene-rasterizer-wasm"),
    allow(
        dead_code,
        reason = "Shared with renderer-core/scene-host-wasm, which use the raster paths core does not export."
    )
)]
pub(crate) mod scene_replay;
pub(crate) mod font_container;
#[cfg_attr(
    not(feature = "scene-rasterizer-wasm"),
    allow(
        dead_code,
        reason = "Shared with renderer-core/scene-host-wasm, which use the raster paths core does not export."
    )
)]
pub(crate) mod screenshot;
pub(crate) mod canvas2d;
pub(crate) mod pdf;
#[cfg(feature = "pdf")]
pub(crate) mod pdf_paint;
pub(crate) mod render;
pub(crate) mod canvas;
pub(crate) mod print;

#[cfg(test)]
mod tests;
