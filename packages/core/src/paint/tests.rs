// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Tests for the paint stage; they use crate internals.

mod box_shadow_blur_accuracy;
mod counter_damage_gate;
mod damaged_subtree_skip;
mod glyph_cache_panic;
mod ink_rect;
mod inline_block_border;
mod paint_damage;
mod paint_damage_layout_cache;
mod rbi_image_cache;
mod render_scene_resolve_loop;
mod scene_determinism;
mod svg_geometry_properties;
mod svg_mutation_resnapshot;
mod svg_sprite_use;
mod svg_view_fragment;
mod svg_zero_viewbox;
