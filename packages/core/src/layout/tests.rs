// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Tests for the layout stage; they use crate internals.
mod abs_filters_width;
mod abspos_containing_block;
mod box_decorations;
mod float_cache_incremental;
mod float_with_trailing_comment;
mod grid_minmax;
mod hit_test_block_axis;
mod hit_test_fixed_scroll;
mod hit_test_line_ripple;
mod hit_test_paint_order;
mod hit_test_pointer_events;
mod hit_test_transform;
mod hoist_incremental;
mod inline_block_baseline;
mod inline_break_index;
mod inline_break_restore;
mod inline_flow_rect;
mod nested_inline_abspos;
mod radar_grid_repro;
mod rehomed_reach;
mod sticky_reset;
mod stylo_extraction;
mod svg_descendant_rect;
mod svg_natural_size;
mod tab_expansion;
mod text_node_rect;
mod transform_2d_subset;
