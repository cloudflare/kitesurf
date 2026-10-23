// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::{DomHandle, test_support::query_selector_id};

const PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  #box { counter-reset: n 0; }
  #box p { counter-increment: n 1; }
  #box p::before { content: "[" counter(n) "] "; }
</style></head><body>
<ol id="list"><li>alpha</li><li>beta</li></ol>
<div id="box"><p>one</p><p>two</p></div>
<div id="paint">paint-only</div>
</body></html>"#;

const SHARED_COUNTER_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { counter-reset: n 0; }
  .item { counter-increment: n 1; }
  .item::before { content: "[" counter(n) "] "; }
</style></head><body>
<div id="a"><p class="item">one</p></div>
<div id="b"><p class="item">two</p></div>
</body></html>"#;

fn setup(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    dom
}

fn assert_counter_order(text: &str, first: &str, second: &str) {
    assert!(
        matches!((text.find(first), text.find(second)), (Some(a), Some(b)) if a < b),
        "expected {first:?} before {second:?}:\n{text}"
    );
}

#[test]
fn counter_text_renders() {
    let txt = setup(PAGE).debug_dump_inline_layouts();
    assert!(txt.contains("[1]") && txt.contains("[2]"), "{txt}");
}

#[test]
fn structural_insert_renumbers() {
    let dom = setup(PAGE);
    let box_id = query_selector_id(&dom, "#box");
    let p = dom.create_element("p");
    dom.append_child_node(box_id, p);
    dom.resolve_layout();
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("[3]"), "insert must renumber: {txt}");
}

#[test]
fn counter_reset_restyle_renumbers() {
    let dom = setup(PAGE);
    let box_id = query_selector_id(&dom, "#box");
    dom.set_attribute(box_id, "style", "counter-reset: n 10");
    dom.resolve_layout();
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("[11]") && txt.contains("[12]"), "{txt}");
}

#[test]
fn renumber_reaches_an_undamaged_subtree() {
    let dom = setup(SHARED_COUNTER_PAGE);
    let a = query_selector_id(&dom, "#a");
    let p = dom.create_element("p");
    dom.set_attribute(p, "class", "item");
    dom.append_child_node(a, p);
    dom.resolve_layout();
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("[3]"), "sibling subtree must renumber: {txt}");
}

const ATTR_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  #label::before { content: attr(data-label); }
</style></head><body>
<div id="label" data-label="one">x</div>
</body></html>"#;

#[test]
fn an_attribute_write_reresolves_attr_content() {
    let dom = setup(ATTR_PAGE);
    let label = query_selector_id(&dom, "#label");
    assert!(dom.debug_dump_inline_layouts().contains("one"));

    dom.set_attribute(label, "data-label", "two");
    dom.resolve_layout();
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("two"), "attr() content froze: {txt}");
}

#[test]
fn paint_only_write_keeps_counters() {
    let dom = setup(PAGE);
    let paint = query_selector_id(&dom, "#paint");
    for i in 0..3 {
        let bg = if i % 2 == 0 {
            "background:#f00"
        } else {
            "background:#0f0"
        };
        dom.set_attribute(paint, "style", bg);
        dom.resolve_layout();
    }
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("[1]") && txt.contains("[2]"), "{txt}");
}

const LIST_VALUE_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  li::before { content: "[" counter(list-item) "] "; }
</style></head><body>
<ol id="list"><li id="first">one</li><li>two</li></ol>
</body></html>"#;

#[test]
fn li_value_attribute_write_reresolves_list_item_counters() {
    let dom = setup(LIST_VALUE_PAGE);
    let first = query_selector_id(&dom, "#first");
    let initial = dom.debug_dump_inline_layouts();
    assert_counter_order(&initial, "[1]", "[2]");

    dom.set_attribute(first, "value", "7");
    dom.resolve_layout();
    let updated = dom.debug_dump_inline_layouts();
    assert_counter_order(&updated, "[7]", "[8]");

    dom.remove_attribute(first, "value");
    dom.resolve_layout();
    let restored = dom.debug_dump_inline_layouts();
    assert_counter_order(&restored, "[1]", "[2]");
}

#[test]
fn ol_reversed_attribute_write_and_removal_reresolve_list_item_counters() {
    let dom = setup(LIST_VALUE_PAGE);
    let list = query_selector_id(&dom, "#list");

    dom.set_attribute(list, "reversed", "");
    dom.resolve_layout();
    let reversed = dom.debug_dump_inline_layouts();
    assert_counter_order(&reversed, "[2]", "[1]");

    dom.remove_attribute(list, "reversed");
    dom.resolve_layout();
    let forward = dom.debug_dump_inline_layouts();
    assert_counter_order(&forward, "[1]", "[2]");
}

#[test]
fn ol_start_attribute_write_reresolves_list_item_counters() {
    let dom = setup(LIST_VALUE_PAGE);
    let list = query_selector_id(&dom, "#list");
    let initial = dom.debug_dump_inline_layouts();
    assert_counter_order(&initial, "[1]", "[2]");

    dom.set_attribute(list, "start", "5");
    dom.resolve_layout();
    let updated = dom.debug_dump_inline_layouts();
    assert_counter_order(&updated, "[5]", "[6]");

    dom.remove_attribute(list, "start");
    dom.resolve_layout();
    let restored = dom.debug_dump_inline_layouts();
    assert_counter_order(&restored, "[1]", "[2]");
}
