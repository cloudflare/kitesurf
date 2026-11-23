// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// Horizontal margins apply to an inline, non-replaced box: they shift the box's
// text and shorten the line it sits on.
// https://drafts.csswg.org/css2/#inline-box-dimensions

use crate::DomHandle;

const PAGE: &str = r#"<html><head><style>
  body { margin: 0; font: 16px sans-serif }
  #before { display: inline-block; width: 10px; height: 10px }
  #padded { margin-left: 30px; margin-right: 30px }
  #after { display: inline-block; width: 10px; height: 10px }
</style></head><body><div id="line">
  <span id="before"></span><span id="padded">text</span><span id="after"></span>
</div></body></html>"#;

fn rects(html: &str) -> (f64, f64, f64) {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let left = |sel: &str| {
        let id = dom.query_selector(sel).expect(sel) as u32;
        dom.test_get_inline_aware_rect(id).0 as f64
    };
    let before = left("#before");
    let padded = left("#padded");
    let after = left("#after");
    (before, padded, after)
}

#[test]
fn inline_horizontal_margins_shift_the_box() {
    let (before, padded, after) = rects(PAGE);
    assert!(
        padded - before >= 29.0,
        "margin-left must shift the inline box: before={before} padded={padded}"
    );
    // 30px of margin-right plus the width of "text" (about 29px at 16px).
    assert!(
        after - padded >= 55.0,
        "margin-right must shorten the line: padded={padded} after={after}"
    );
}

#[test]
fn inline_horizontal_margin_hit_tests_at_shifted_rect() {
    let html = r##"<html><head><style>
      body { margin: 0; font: 16px monospace; }
      #box { width: 200px; padding: 16px; }
      #link { margin-left: 80px; }
    </style></head><body><div id="box"><a id="link" href="#x">123321</a></div></body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let box_id = dom.query_selector("#box").expect("#box");
    let link_id = dom.query_selector("#link").expect("#link");
    let (left, top, width, height) = dom.test_get_inline_aware_rect(link_id as u32);
    let hit_on_link = dom.element_from_point(left + width / 2.0, top + height / 2.0);
    assert_eq!(
        hit_on_link, link_id,
        "hit test at shifted inline box center must hit #link"
    );

    let hit_in_margin = dom.element_from_point(left - 40.0, top + height / 2.0);
    assert_eq!(
        hit_in_margin, box_id,
        "hit test inside margin-left gap must hit container #box, not #link"
    );
}
