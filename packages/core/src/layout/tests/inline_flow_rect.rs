// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const FILTERS_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
.footer {
  position: relative;
  height: 40px;
  padding: 10px 15px;
}
.filters {
  position: absolute;
  left: 0; right: 0;
  list-style: none;
  text-align: center;
}
.filters li { display: inline; }
.filters li a {
  /* Match real todomvc-react: display defaults to inline (so the
     <a> doesn't get its own taffy final_layout). border + padding
     trigger parley SpanFragment emission. */
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 3px 7px;
  margin: 3px;
  text-decoration: none;
}
</style></head>
<body>
<footer class="footer">
  <ul class="filters">
    <li><a href="#/">All</a></li>
    <li><a href="#/active">Active</a></li>
    <li><a href="#/completed">Completed</a></li>
  </ul>
</footer>
</body></html>"##;

#[test]
fn filter_anchor_completed_has_nonzero_bbox() {
    let dom = DomHandle::new(FILTERS_HTML, "https://test.example/");
    dom.resolve_layout();

    let a_id = dom
        .query_selector("a[href='#/completed']")
        .expect("query parses");
    assert!(a_id > 0, "<a href='#/completed'> must exist");
    let a_id = a_id as u32;

    let dump = dom.debug_dump_node_layout(a_id);
    eprintln!("anchor layout dump: {}", dump);

    let rect = dom.test_get_inline_aware_rect(a_id);
    eprintln!(
        "inline-aware rect: x={} y={} w={} h={}",
        rect.0, rect.1, rect.2, rect.3
    );
    assert!(
        rect.2 > 0.0 && rect.3 > 0.0,
        "expected non-zero bbox for inline-flow <a>; got w={} h={}",
        rect.2,
        rect.3,
    );

    assert!(
        rect.0 > 350.0 && rect.0 < 550.0,
        "rightmost pill x should fall in (350, 550); got x={} (full rect: {:?})",
        rect.0,
        rect,
    );
    assert!(
        rect.1 < 100.0 && rect.1 >= 0.0,
        "anchor y should land near the ul.filters paint y (≈11); got y={}",
        rect.1,
    );
}

const PLAIN_LINK_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; font-size: 16px; }
p { margin: 20px 0 0 0; }
</style></head>
<body><p>lead text <a id="plain" href="/more">More information</a> trailing</p></body>
</html>"##;

#[test]
fn undecorated_inline_anchor_has_nonzero_bbox() {
    let dom = DomHandle::new(PLAIN_LINK_HTML, "https://test.example/");
    dom.resolve_layout();

    let a_id = dom.query_selector("a#plain").expect("query parses");
    assert!(a_id > 0, "<a id='plain'> must exist");
    let rect = dom.test_get_inline_aware_rect(a_id as u32);
    eprintln!("plain anchor rect: {:?}", rect);

    assert!(
        rect.2 > 0.0 && rect.3 > 0.0,
        "expected non-zero bbox for undecorated inline <a>; got w={} h={}",
        rect.2,
        rect.3,
    );
    assert!(
        rect.2 > 60.0 && rect.2 < 300.0,
        "anchor width should span the link text; got w={} (rect {:?})",
        rect.2,
        rect,
    );
    assert!(
        rect.0 > 20.0 && rect.0 < 200.0,
        "anchor x should follow the leading text; got x={} (rect {:?})",
        rect.0,
        rect,
    );
    assert!(
        rect.1 >= 15.0 && rect.1 < 60.0,
        "anchor y should sit on the <p>'s first line; got y={} (rect {:?})",
        rect.1,
        rect,
    );
    assert!(
        rect.3 > 8.0 && rect.3 < 40.0,
        "anchor height should be one line box; got h={} (rect {:?})",
        rect.3,
        rect,
    );
}

#[test]
fn atomic_inline_wrapper_uses_its_child_box() {
    let dom = DomHandle::new(
        r#"<!doctype html><style>* { margin: 0; padding: 0 }</style>
        <span id="wrapper"><input style="width: 50px; height: 20px"></span>"#,
        "https://test.example/",
    );
    dom.resolve_layout();

    let wrapper_id = dom.query_selector("#wrapper").expect("query parses") as u32;
    let input_id = dom.query_selector("input").expect("query parses") as u32;
    let wrapper = dom.test_get_inline_aware_rect(wrapper_id);
    let input = dom.test_get_inline_aware_rect(input_id);

    assert!(
        wrapper.2 > 0.0 && wrapper.3 > 0.0,
        "wrapper rect: {wrapper:?}"
    );
    assert_eq!(wrapper, input);
}

#[test]
fn all_three_filter_anchors_ordered_left_to_right() {
    let dom = DomHandle::new(FILTERS_HTML, "https://test.example/");
    dom.resolve_layout();

    let mut rects = vec![];
    for href in &["#/", "#/active", "#/completed"] {
        let id = dom
            .query_selector(&format!("a[href='{}']", href))
            .expect("query parses");
        assert!(id > 0, "anchor {} must exist", href);
        let r = dom.test_get_inline_aware_rect(id as u32);
        eprintln!("anchor {}: rect={:?}", href, r);
        rects.push(r);
    }

    for r in &rects {
        assert!(
            r.2 > 0.0 && r.3 > 0.0,
            "every anchor must have non-zero bbox; got {:?}",
            r
        );
    }
    assert!(
        rects[0].0 < rects[1].0,
        "All.x ({}) < Active.x ({})",
        rects[0].0,
        rects[1].0
    );
    assert!(
        rects[1].0 < rects[2].0,
        "Active.x ({}) < Completed.x ({})",
        rects[1].0,
        rects[2].0
    );
    assert!(
        (rects[0].1 - rects[1].1).abs() < 2.0 && (rects[1].1 - rects[2].1).abs() < 2.0,
        "all three anchors should share a y-row; got {:?}",
        rects,
    );
}

#[test]
fn detached_inline_child_does_not_keep_a_freed_anonymous_parent() {
    let html = r##"<!DOCTYPE html>
<html><body><div id="p">text <span id="s">x</span><div>block</div></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let span = dom.query_selector("#s").expect("query ok") as u32;
    dom.resolve_layout();
    let id = dom.resolve_node_id(span).expect("span still alive");
    assert!(dom.remove_node(span));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let _ = doc.get_node(id).unwrap().absolute_position(0.0, 0.0);
}
