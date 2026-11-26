// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A zero-sized block reports its own box, not the text overflowing it.

use crate::DomHandle;

fn rect(body: &str) -> (f32, f32, f32, f32) {
    let dom = DomHandle::new(
        &format!("<!DOCTYPE html><body style='margin:0'>{body}</body>"),
        "https://example.com/",
    );
    dom.set_viewport(400, 600);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query parses");
    assert!(id > 0, "#t must exist");
    dom.test_get_inline_aware_rect(id as u32)
}

#[test]
fn zero_width_block_keeps_its_line_height_and_no_width() {
    let (x, y, width, height) = rect("<div id=t style='width:0'>text</div>");
    assert_eq!((x, y, width), (0.0, 0.0, 0.0));
    assert!(
        height > 0.0,
        "the line still gives the block its height, got {height}"
    );
}

#[test]
fn zero_height_block_keeps_its_width_and_no_height() {
    let (_, _, width, height) = rect("<div id=t style='height:0'>text</div>");
    assert_eq!((width, height), (400.0, 0.0));
}

#[test]
fn inline_element_still_takes_its_rect_from_its_lines() {
    let (_, _, width, height) = rect("<p style='margin:0'><span id=t>text</span></p>");
    assert!(
        width > 0.0 && width < 400.0,
        "the span covers its text, got width {width}"
    );
    assert!(height > 0.0, "got height {height}");
}
