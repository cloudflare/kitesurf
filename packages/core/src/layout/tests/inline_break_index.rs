// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const WRAP_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 400px; font-size: 16px; line-height: 20px; }
p { width: 400px; }
</style></head>
<body>
<p id="para">The quick brown fox jumps over the lazy dog while the
quick brown fox keeps on jumping over that same lazy dog again and
again <span id="tail">until the paragraph finally wraps</span> across
a good number of separate lines.</p>
</body></html>"##;

fn height_of(dom: &DomHandle, selector: &str) -> f32 {
    let id = dom.query_selector(selector).expect("query parses");
    assert!(id > 0, "{selector} must exist");
    dom.test_get_inline_aware_rect(id as u32).3
}

#[test]
fn reconstructed_paragraph_keeps_its_wrapped_lines() {
    let dom = DomHandle::new(WRAP_HTML, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let before = height_of(&dom, "p#para");
    assert!(
        before > 40.0,
        "fixture must wrap to 3+ lines to be meaningful; got h={before}"
    );

    let tail = dom.query_selector("span#tail").expect("query parses") as u32;
    dom.set_attribute(tail, "style", "display:inline-block");
    dom.resolve_layout();
    dom.set_attribute(tail, "style", "display:inline");
    dom.resolve_layout();

    let after = height_of(&dom, "p#para");
    assert!(
        (after - before).abs() < 1.0,
        "paragraph lost its lines after re-collect: h {before} -> {after}"
    );
}

#[test]
fn removing_the_last_block_child_clears_the_inline_parents_layout_children() {
    let html = r##"<!DOCTYPE html>
<html><body><span id="inline"><div id="block">block</div></span></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let inline = dom.query_selector("#inline").expect("query parses") as u32;
    let block = dom.query_selector("#block").expect("query parses") as u32;
    assert_eq!(
        dom.test_layout_children(inline),
        vec![block],
        "the inline parent must own the block child's box"
    );

    assert!(dom.remove_node(block));
    dom.resolve_layout();

    assert!(
        !dom.test_layout_children(inline).contains(&block),
        "the flattened inline parent kept its removed child's box"
    );

    assert!(dom.drop_node(block));
    dom.resolve_layout();
    assert!(
        dom.test_layout_children(inline).is_empty(),
        "the dropped child's slot stayed referenced"
    );

    let replacement = dom.create_element("div");
    assert!(dom.append_child_node(inline, replacement));
    dom.resolve_layout();
    assert_eq!(
        dom.test_layout_children(inline),
        vec![replacement],
        "the inline parent did not recover its box after a block child returned"
    );
}

#[test]
fn narrowing_and_restoring_width_rebreaks_both_ways() {
    let dom = DomHandle::new(WRAP_HTML, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let wide = height_of(&dom, "p#para");
    let para = dom.query_selector("p#para").expect("query parses") as u32;

    dom.set_attribute(para, "style", "width:200px");
    dom.resolve_layout();
    let narrow = height_of(&dom, "p#para");
    assert!(
        narrow > wide + 10.0,
        "halving the width must add lines; h {wide} -> {narrow}"
    );

    dom.set_attribute(para, "style", "width:400px");
    dom.resolve_layout();
    let restored = height_of(&dom, "p#para");
    assert!(
        (restored - wide).abs() < 1.0,
        "restoring the width must restore the line count; h {wide} -> {narrow} -> {restored}"
    );
}
