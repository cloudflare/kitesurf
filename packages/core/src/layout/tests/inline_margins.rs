// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// Horizontal margins apply to an inline, non-replaced box: they shift the box's
// text and shorten the line it sits on.
// https://drafts.csswg.org/css2/#inline-box-dimensions

use crate::DomHandle;
use blitz_dom::node::TextBrush;

/// `(offset, advance)` of each glyph run on `line`, in layout order. Inline
/// boxes (including margin spacers) are skipped.
fn run_spans(line: &parley::layout::Line<'_, TextBrush>) -> Vec<(f32, f32)> {
    line.items()
        .filter_map(|item| match item {
            parley::layout::PositionedLayoutItem::GlyphRun(run) => {
                Some((run.offset(), run.advance()))
            }
            _ => None,
        })
        .collect()
}

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

    // The span's margin is a Parley spacer, so the glyph runs after it are
    // positioned by the line breaker and no separate offset is applied.
    let doc = dom.doc.borrow();
    let p_node = doc.as_ref().get_node(crate::blitz_node_id(p_id)).unwrap();
    let inline = p_node.element_data().unwrap().inline_layout_data().unwrap();
    let layout = inline.layout(p_node.tree());
    let lines: Vec<_> = layout.lines().collect();
    assert_eq!(lines.len(), 1, "single line expected");
    let spans = run_spans(&lines[0]);
    assert_eq!(spans.len(), 3, "expected 3 runs: {spans:?}");
    assert_eq!(spans[0].0, 0.0, "text before span must stay at x=0");
    let expected_second = spans[0].0 + spans[0].1 + 80.0;
    assert!(
        (spans[1].0 - expected_second).abs() < 0.5,
        "span run must start after the preceding text plus 80px: {spans:?}"
    );
    let expected_third = spans[1].0 + spans[1].1;
    assert!(
        (spans[2].0 - expected_third).abs() < 0.5,
        "trailing text must continue after the span: {spans:?}"
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
    let layout = inline.layout(p_node.tree());
    let lines: Vec<_> = layout.lines().collect();
    assert_eq!(lines.len(), 2, "expected 2 lines");
    // Line 0: "AA " at 0, "first" after the 40px start margin.
    let line0 = run_spans(&lines[0]);
    assert_eq!(line0[0].0, 0.0);
    let expected_first = line0[0].0 + line0[0].1 + 40.0;
    assert!(
        (line0[1].0 - expected_first).abs() < 0.5,
        "line 0: {line0:?}"
    );
    // Line 1: "second" starts at 0 (no repeated margin-left); the next run
    // begins after the 30px end margin.
    let line1 = run_spans(&lines[1]);
    assert_eq!(
        line1[0].0, 0.0,
        "wrapped fragment must not re-apply margin-left: {line1:?}"
    );
    let expected_after = line1[0].0 + line1[0].1 + 30.0;
    assert!(
        (line1[1].0 - expected_after).abs() < 0.5,
        "text after the last fragment must start after margin-right: {line1:?}"
    );
}

/// A span's start margin is charged to the line breaker, so a line that only
/// fits with the margin is not laid out past the box edge.
#[test]
fn wrapped_line_accounts_for_inline_start_margin() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 20px monospace; }
      #box { width: 240px; }
      #s { margin-left: 60px; }
    </style></head><body>
      <div id="box">AAAA <span id="s">BBBB</span> CCCC DDDD EEEE</div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let box_id = dom.query_selector("#box").expect("#box") as u32;
    let s_id = dom.query_selector("#s").expect("#s") as u32;
    let (box_left, _, box_width, _) = dom.test_get_inline_aware_rect(box_id);
    let (s_left, _, s_width, _) = dom.test_get_inline_aware_rect(s_id);
    let box_right = box_left + box_width;
    assert!(
        s_left + s_width <= box_right + 0.5,
        "span must not spill past the box: span right={} box right={box_right}",
        s_left + s_width
    );

    let doc = dom.doc.borrow();
    let node = doc.as_ref().get_node(crate::blitz_node_id(box_id)).unwrap();
    let inline = node.element_data().unwrap().inline_layout_data().unwrap();
    let layout = inline.layout(node.tree());
    assert!(
        layout.width() <= 240.5,
        "line breaking must include the 60px margin: width={}",
        layout.width()
    );
}

/// Right alignment shifts the whole line, margin included, so the span's right
/// edge still lands on the box's right edge instead of spilling past it.
#[test]
fn right_aligned_line_keeps_inline_start_margin_inside_box() {
    let html = r#"<html><head><style>
      body { margin: 0; font: 20px monospace; }
      #box { width: 240px; text-align: right; }
      #s { margin-left: 60px; }
    </style></head><body>
      <div id="box">x <span id="s">RRRR</span></div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let box_id = dom.query_selector("#box").expect("#box") as u32;
    let s_id = dom.query_selector("#s").expect("#s") as u32;
    let (box_left, _, box_width, _) = dom.test_get_inline_aware_rect(box_id);
    let (s_left, _, s_width, _) = dom.test_get_inline_aware_rect(s_id);
    let box_right = box_left + box_width;
    assert!(
        (s_left + s_width - box_right).abs() < 1.0,
        "right-aligned span must end at the box edge: span right={} box right={box_right}",
        s_left + s_width
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
    let layout = inline.layout(node.tree());
    let lines: Vec<_> = layout.lines().collect();
    assert_eq!(lines.len(), 1);
    let spans = run_spans(&lines[0]);
    // 10% of 200px content-box width = 20px (not 30px from 300px border-box width).
    assert!(
        (spans[0].0 - 20.0).abs() < 0.5,
        "expected 20px margin from content box width, got {spans:?}"
    );
}
