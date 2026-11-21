// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Tests for the style stage; they use crate internals.

mod animation_clock;
mod animation_fill_mode;
mod calc_resolution;
mod child_list_restyle;
mod cascade_panic_recovery;
mod color_serialization;
mod computed_style_no_layout;
mod disconnected_style;
mod flat_tree_style;
mod font_family_parse;
mod focus_pseudoclass;
mod has_invalidation;
mod insertion_invalidation;
mod link_style_sharing;
mod resolved_transform;
mod single_value_used;
mod style_only_flush;
mod stylesheet_anchor;
mod stylesheet_removal_invalidation;
mod svg_css_fill;
mod svg_css_opacity;
mod svg_currentcolor;
