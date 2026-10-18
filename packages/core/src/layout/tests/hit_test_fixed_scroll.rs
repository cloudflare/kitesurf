// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A `position: fixed` box stays hittable at its viewport position after the
//! page scrolls. elementFromPoint takes document coordinates, so blitz's
//! hit test has to cancel the viewport scroll for fixed boxes of the root.

#![cfg(test)]

use crate::DomHandle;

const HTML: &str = r##"<!DOCTYPE html>
<html><body style="margin:0">
<div style="height:5000px"></div>
<button id="plain" style="position:fixed;left:10px;top:10px;width:60px;height:30px">a</button>
<button id="indexed" style="position:fixed;left:100px;top:10px;width:60px;height:30px;z-index:1">b</button>
</body></html>"##;

#[test]
fn fixed_boxes_stay_hittable_after_the_page_scrolls() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();
    let plain = dom.query_selector("#plain").expect("query parses");
    let indexed = dom.query_selector("#indexed").expect("query parses");
    assert!(plain > 0 && indexed > 0);

    for scroll_y in [0.0f32, 240.0] {
        dom.set_page_scroll(0.0, scroll_y as f64);
        assert_eq!(
            dom.element_from_point(20.0, 20.0 + scroll_y),
            plain,
            "fixed box without z-index at scrollY={scroll_y}"
        );
        assert_eq!(
            dom.element_from_point(110.0, 20.0 + scroll_y),
            indexed,
            "z-indexed fixed box at scrollY={scroll_y}"
        );
    }
}
