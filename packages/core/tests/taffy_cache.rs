// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use taffy::geometry::{Line, Size};
use taffy::style::AvailableSpace;
use taffy::tree::{Cache, LayoutInput, LayoutOutput, RequestedAxis, RunMode, SizingMode};

fn input(width: f32) -> LayoutInput {
    LayoutInput {
        run_mode: RunMode::ComputeSize,
        sizing_mode: SizingMode::InherentSize,
        axis: RequestedAxis::Both,
        known_dimensions: Size {
            width: Some(width),
            height: None,
        },
        known_dimensions_are_definite: Size {
            width: true,
            height: true,
        },
        parent_size: Size::NONE,
        available_space: Size {
            width: AvailableSpace::MaxContent,
            height: AvailableSpace::MaxContent,
        },
        vertical_margins_are_collapsible: Line::FALSE,
    }
}

fn output(width: f32) -> LayoutOutput {
    LayoutOutput::from_outer_size(Size {
        width,
        height: width,
    })
}

#[test]
fn growing_measurements_keep_first_matching_slot_and_clock_order() {
    // The pinned cache has nine measurement slots; fill it before exercising replacement.
    const MEASUREMENT_SLOTS: usize = 9;
    let mut cache = Cache::new();
    let both = input(1.0);
    let horizontal = LayoutInput {
        axis: RequestedAxis::Horizontal,
        ..both
    };
    cache.store(&horizontal, output(11.0));
    cache.store(&both, output(12.0));
    for width in 2..MEASUREMENT_SLOTS {
        cache.store(&input(width as f32), output(width as f32));
    }
    assert_eq!(cache.get(&horizontal), Some(output(11.0)));
    assert_eq!(cache.get(&both), Some(output(12.0)));
    // A tenth measurement overflows the nine slots.
    cache.store(&input(20.0), output(20.0));
    assert_eq!(cache.get(&horizontal), Some(output(12.0)));
    assert_eq!(cache.get(&both), Some(output(12.0)));
    cache.clear();
    assert_eq!(cache.get(&horizontal), None);
    cache.store(&both, output(13.0));
    assert_eq!(cache.get(&horizontal), Some(output(13.0)));
}
