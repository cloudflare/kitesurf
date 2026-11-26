// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// Relative positioning shifts a floated box after float placement; surrounding
// floats still flow around its unshifted box.
// https://drafts.csswg.org/css2/#relative-positioning

use crate::DomHandle;

fn rect(dom: &DomHandle, selector: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(selector).expect(selector) as u32;
    dom.test_get_inline_aware_rect(id)
}

#[test]
fn floated_relative_box_resolves_percentage_insets() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #row { width: 400px; height: 100px }
      #first { float: left; width: 50%; height: 40px; position: relative; left: 50%; top: 10% }
      #second { float: left; width: 50%; height: 40px; position: relative; right: 50% }
    </style></head><body><div id="row"><div id="first"></div><div id="second"></div></div></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let (x1, y1, _, _) = rect(&dom, "#first");
    let (x2, y2, _, _) = rect(&dom, "#second");
    assert_eq!(x1, 200.0, "left: 50% of 400px pushes first float to 200px");
    assert_eq!(
        y1, 10.0,
        "top: 10% of 100px shifts first float down by 10px"
    );
    assert_eq!(
        x2, 0.0,
        "right: 50% of 400px pulls second float from 200px to 0px"
    );
    assert_eq!(
        y2, 0.0,
        "second float stays on the same row as the unshifted first float"
    );
}
