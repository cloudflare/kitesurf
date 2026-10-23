// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::{DomHandle, test_support::query_selector_id};

#[test]
fn nested_nowrap_does_not_break_after_its_leading_inline_box() {
    let dom = DomHandle::new(
        concat!(
            "<!DOCTYPE html><html><body style='margin:0;font:16px/20px sans-serif'>",
            "<div id='container' style='width:15px'><span style='white-space:nowrap'>",
            "<span style='display:inline-block;width:10px;height:8px'></span>x</span>",
            "</div></body></html>",
        ),
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let container = query_selector_id(&dom, "#container");
    let height = dom.test_get_inline_aware_rect(container).3;
    assert!(
        (height - 20.0).abs() < 1.0,
        "nowrap content should stay on one line, got height {height}"
    );
}
