#![cfg(test)]
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

fn used_columns(html: &str) -> Vec<f32> {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let doc = dom.doc_for_test();
    let doc = doc.borrow();
    let base: &blitz_dom::BaseDocument = doc.as_ref();
    for (id, _) in base.tree().iter() {
        if let Some(info) = base.grid_track_info(id) {
            return info
                .columns
                .positions
                .iter()
                .map(|track| track.end - track.start)
                .collect();
        }
    }
    Vec::new()
}

#[test]
fn minmax_auto_zero_floors_to_min_content() {
    let sizes = used_columns(
        r##"<!DOCTYPE html><style>
          .grid { display: grid; grid-template-columns: minmax(auto, 0px); width: 300px; }
          .item { width: 30px; height: 10px; }
        </style><div class="grid"><div class="item"></div></div>"##,
    );
    assert!(!sizes.is_empty(), "no grid track info captured");
    assert!(
        (sizes[0] - 30.0).abs() < 1.0,
        "minmax(auto, 0px) should floor max to min-content (30px), got {:?}",
        sizes
    );
}

#[test]
fn minmax_min_content_small_fixed_max_floors() {
    let sizes = used_columns(
        r##"<!DOCTYPE html><style>
          .grid { display: grid; grid-template-columns: minmax(min-content, 2px); width: 300px; }
          .item { width: 30px; height: 10px; }
        </style><div class="grid"><div class="item"></div></div>"##,
    );
    assert!(!sizes.is_empty(), "no grid track info captured");
    assert!(
        (sizes[0] - 30.0).abs() < 1.0,
        "minmax(min-content, 2px) should floor max to min-content (30px), got {:?}",
        sizes
    );
}

#[test]
fn min_content_keeps_nowrap_together_after_a_leading_inline_box() {
    let sizes = used_columns(
        r##"<!DOCTYPE html><style>
          .grid { display: grid; grid-template-columns: minmax(min-content, 2px); width: 300px; font: 16px/20px sans-serif; }
          .item { white-space: nowrap; }
          .box { display: inline-block; width: 10px; height: 8px; }
        </style><div class="grid"><div class="item"><span class="box"></span>x</div></div>"##,
    );
    assert!(!sizes.is_empty(), "no grid track info captured");
    assert!(
        sizes[0] > 15.0,
        "min-content should include the no-wrap box and text, got {:?}",
        sizes
    );
}
