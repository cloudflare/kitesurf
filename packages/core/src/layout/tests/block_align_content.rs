// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Block children are placed as laid out, or held for `align-content` to shift first.

use crate::DomHandle;

fn rects(body: &str, selectors: &[&str]) -> Vec<(f32, f32, f32, f32)> {
    let dom = DomHandle::new(
        &format!("<!DOCTYPE html><body style='margin:0'>{body}</body>"),
        "https://example.com/",
    );
    dom.set_viewport(400, 600);
    dom.resolve_layout();
    selectors
        .iter()
        .map(|selector| {
            let id = dom.query_selector(selector).expect("query parses");
            assert!(id > 0, "selector must match: {selector}");
            dom.test_get_inline_aware_rect(id as u32)
        })
        .collect()
}

#[test]
fn align_content_shifts_children_floats_and_static_positions() {
    let body = |align: &str| {
        format!(
            "<div style='position:relative;height:200px;align-content:{align}'>\
             <div id=f style='float:left;width:20px;height:20px'></div>\
             <div id=c style='height:40px'></div>\
             <div><span id=a style='position:absolute'>a</span></div></div>"
        )
    };
    let start = rects(&body("normal"), &["#f", "#c", "#a"]);
    let center = rects(&body("center"), &["#f", "#c", "#a"]);
    // Only the 40px child is in-flow content: the float and the empty wrapper add no height.
    let shift = (200.0 - 40.0) / 2.0;
    for (index, name) in ["float", "child", "static position"].iter().enumerate() {
        assert_eq!(
            center[index].1 - start[index].1,
            shift,
            "{name} moves with the content"
        );
        assert_eq!(
            center[index].0, start[index].0,
            "{name} keeps its inline position"
        );
    }
}

#[test]
fn an_absolute_box_anchors_inside_its_laid_out_ancestor() {
    let r = rects(
        "<div style='position:relative'><div id=gap style='height:30px'></div>\
         <div id=p style='margin-left:15px;padding-top:7px'><div style='height:5px'></div>\
         <span id=a style='position:absolute'>a</span></div></div>",
        &["#p", "#a"],
    );
    assert_eq!((r[1].0, r[1].1), (15.0, 30.0 + 7.0 + 5.0));
}
