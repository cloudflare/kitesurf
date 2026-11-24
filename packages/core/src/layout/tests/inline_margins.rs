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

#[test]
fn text_after_inline_margin_span_shifts_without_overlapping() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 24px monospace; }
      #b { margin-left: 80px; }
    </style></head><body><p id="p">AA <span id="b">BB</span> CC</p></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let p_id = dom.query_selector("#p").expect("#p") as u32;
    let b_id = dom.query_selector("#b").expect("#b") as u32;
    let (p_left, _p_top, p_width, _p_height) = dom.test_get_inline_aware_rect(p_id);
    let (b_left, _b_top, b_width, _b_height) = dom.test_get_inline_aware_rect(b_id);

    // Check the recorded per-item shifts on the paragraph's line:
    // item 0 ("AA ") has shift 0; item 1 ("BB") has shift 80; item 2 (" CC") also has shift 80.
    let doc = dom.doc.borrow();
    let p_node = doc.as_ref().get_node(crate::blitz_node_id(p_id)).unwrap();
    let inline = p_node.element_data().unwrap().inline_layout_data().unwrap();
    let offsets = inline.line_item_offsets();
    assert_eq!(offsets.len(), 1, "single line expected");
    assert!(offsets[0].len() >= 3, "expected 3 runs: {:?}", offsets[0]);
    assert_eq!(offsets[0][0], 0.0, "text before span must stay at shift 0");
    assert!(
        (offsets[0][1] - 80.0).abs() < 0.5,
        "span run must shift by 80px: {:?}",
        offsets[0]
    );
    assert!(
        (offsets[0][2] - 80.0).abs() < 0.5,
        "trailing text run after span must keep the 80px shift: {:?}",
        offsets[0]
    );
    assert!(
        p_left + p_width > b_left + b_width + 10.0,
        "trailing text must extend past the shifted span: p=({p_left},{p_width}) b=({b_left},{b_width})"
    );
}

#[test]
fn wrapped_inline_span_applies_start_margin_only_on_first_fragment_and_end_margin_only_on_last() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 16px monospace; }
      #w { margin-left: 40px; margin-right: 30px; }
    </style></head><body><p id="p">AA <span id="w">first<br>second</span> <span id="after">CC</span></p></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let p_id = dom.query_selector("#p").expect("#p") as u32;
    let doc = dom.doc.borrow();
    let p_node = doc.as_ref().get_node(crate::blitz_node_id(p_id)).unwrap();
    let inline = p_node.element_data().unwrap().inline_layout_data().unwrap();
    let offsets = inline.line_item_offsets();
    assert_eq!(offsets.len(), 2, "expected 2 lines: {offsets:?}");
    // Line 0: "AA " at 0, "first" at +40.
    assert_eq!(offsets[0][0], 0.0);
    assert!(
        (offsets[0][1] - 40.0).abs() < 0.5,
        "line 0: {:?}",
        offsets[0]
    );
    // Line 1: "second" starts at 0 (no repeated margin-left), trailing runs shift by +30.
    assert_eq!(
        offsets[1][0], 0.0,
        "wrapped fragment must not re-apply margin-left: {:?}",
        offsets[1]
    );
    assert!(
        offsets[1].last().is_some_and(|&s| (s - 30.0).abs() < 0.5),
        "text after last fragment must shift by margin-right: {:?}",
        offsets[1]
    );
}

#[test]
fn scrolled_clip_path_container_hits_visible_descendant() {
    let html = r#"<html><head><style>
      body { margin: 0; }
      #scroller {
        width: 200px;
        height: 200px;
        overflow: auto;
        clip-path: inset(20px);
      }
      #spacer { height: 400px; }
      #btn { width: 180px; height: 100px; }
    </style></head><body>
      <div id="scroller"><div id="spacer"></div><button id="btn">click</button></div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let scroller = dom.query_selector("#scroller").expect("#scroller") as u32;
    let btn = dom.query_selector("#btn").expect("#btn");
    dom.doc
        .borrow_mut()
        .as_mut()
        .get_node_mut(crate::blitz_node_id(scroller))
        .expect("#scroller node")
        .set_scroll_offset(blitz_dom::Point { x: 0.0, y: 400.0 });

    // Point (50, 50) is inside inset(20px) on the 200x200 scroller and lands on #btn.
    assert_eq!(
        dom.element_from_point(50.0, 50.0),
        btn,
        "visible button inside scrolled clip-path must be hittable"
    );
    // Negative control: point (5, 5) is outside inset(20px), so it must NOT hit #btn or #scroller.
    let outside = dom.element_from_point(5.0, 5.0);
    assert_ne!(outside, btn);
    assert_ne!(outside, scroller as i32);
}

#[test]
fn scrolled_and_transformed_clip_path_keeps_hits() {
    let html = r#"<html><head><style>
      body { margin: 0; }
      #under { position: absolute; left: 0; top: 0; width: 300px; height: 300px; }
      #scroller {
        position: absolute; left: 0; top: 0;
        width: 100px; height: 100px;
        overflow: auto;
        clip-path: inset(10px);
        transform: scale(2);
        transform-origin: 0 0;
      }
      #tall { height: 400px; }
    </style></head><body>
      <div id="under"></div>
      <div id="scroller"><div id="tall"></div></div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let scroller = dom.query_selector("#scroller").expect("#scroller") as u32;
    let tall = dom.query_selector("#tall").expect("#tall");
    dom.doc
        .borrow_mut()
        .as_mut()
        .get_node_mut(crate::blitz_node_id(scroller))
        .expect("#scroller node")
        .set_scroll_offset(blitz_dom::Point { x: 0.0, y: 100.0 });

    // (30, 30) maps through scale(2)^-1 to border-box (15, 15), inside inset(10px).
    let hit = dom.element_from_point(30.0, 30.0);
    assert!(
        hit == tall || hit == scroller as i32,
        "scrolled + transformed clip-path must stay hittable, got {hit}"
    );
}

#[test]
fn ellipse_closest_side_clip_path_uses_matching_axis() {
    let html = r#"<html><head><style>
      body { margin: 0; }
      #under { position: absolute; left: 0; top: 0; width: 200px; height: 100px; }
      #clipped { position: absolute; left: 0; top: 0; width: 200px; height: 100px; clip-path: ellipse(); }
    </style></head><body><div id="under"></div><div id="clipped"></div></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let clipped = dom.query_selector("#clipped").expect("#clipped");
    let under = dom.query_selector("#under").expect("#under");
    // (160, 50) is inside ellipse(rx=100, ry=50) centered at (100, 50).
    assert_eq!(dom.element_from_point(160.0, 50.0), clipped);
    // Corner (5, 5) is outside the ellipse and hits #under.
    assert_eq!(dom.element_from_point(5.0, 5.0), under);
}

#[test]
fn caret_from_point_lands_on_shifted_inline_span() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 16px monospace; }
      #b { margin-left: 80px; }
    </style></head><body><p id="p">AA <span id="b">BB</span> CC</p></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let b = dom.query_selector("#b").expect("#b") as u32;
    let (b_left, b_top, b_width, b_height) = dom.test_get_inline_aware_rect(b);
    let doc = dom.doc.borrow();
    // Click the center of the shifted span's text ("BB"), between 'B' and 'B'.
    let (text_node, offset) = doc
        .dom_caret_from_point(b_left + b_width / 2.0, b_top + b_height / 2.0)
        .expect("caret from point");
    let text = doc.get_node(text_node).expect("text node");
    assert_eq!(
        text.parent_id(),
        Some(crate::blitz_node_id(b)),
        "clicking shifted span must place caret in span's text node"
    );
    assert_eq!(offset, 1);
}

#[test]
fn percentage_inline_margin_resolves_against_content_box_width() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 16px monospace; }
      #box { width: 200px; padding: 50px; }
      #s { margin-left: 10%; }
    </style></head><body><div id="box"><span id="s">BB</span></div></body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let box_id = dom.query_selector("#box").expect("#box") as u32;
    let doc = dom.doc.borrow();
    let node = doc.as_ref().get_node(crate::blitz_node_id(box_id)).unwrap();
    let inline = node.element_data().unwrap().inline_layout_data().unwrap();
    let offsets = inline.line_item_offsets();
    assert_eq!(offsets.len(), 1);
    // 10% of 200px content-box width = 20px (not 30px from 300px border-box width).
    assert!(
        (offsets[0][0] - 20.0).abs() < 0.5,
        "expected 20px margin from content box width, got {:?}",
        offsets[0]
    );
}
