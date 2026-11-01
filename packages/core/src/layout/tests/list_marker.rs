// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Outside list markers are shaped when painted rather than kept per item.

use crate::DomHandle;

fn page(list_style: &str) -> DomHandle {
    let dom = DomHandle::new(
        &format!(
            "<!DOCTYPE html><body style='margin:0 40px'><ul style='list-style:{list_style}'>\
             <li id=a style='font-size:30px'>one</li><li>two</li></ul>\
             <ol><li id=b>three</li></ol></body>"
        ),
        "https://example.com/",
    );
    dom.set_viewport(400, 300);
    dom.resolve_layout();
    dom
}

#[test]
fn an_outside_marker_is_shaped_from_its_items_style() {
    let dom = page("disc outside");
    let doc = dom.doc.borrow();
    let width = |selector: &str| {
        let id = dom
            .resolve_node_id(dom.query_selector(selector).unwrap() as u32)
            .unwrap();
        let item = doc
            .get_node(id)
            .unwrap()
            .element_data()
            .unwrap()
            .list_item_data()
            .unwrap();
        let layout = item
            .outside_marker_layout(doc.tree(), id)
            .expect("outside marker");
        assert_eq!(layout.lines().count(), 1);
        assert!(
            layout.lines().flat_map(|line| line.items()).count() > 0,
            "marker has glyphs"
        );
        layout.full_width()
    };
    let (disc, number) = (width("#a"), width("#b"));
    assert!(disc > 0.0 && number > 0.0);
    assert_ne!(
        disc, number,
        "each item's marker text and font size are used"
    );
}

#[test]
fn outside_markers_are_painted() {
    let scene = |list_style| page(list_style).render_scene(0, 0, 0, 0, false, true);
    let none = scene("none");
    assert_ne!(scene("disc outside"), none);
    assert_ne!(scene("square outside"), scene("disc outside"));
    let dom = page("disc inside");
    let doc = dom.doc.borrow();
    let id = dom
        .resolve_node_id(dom.query_selector("#a").unwrap() as u32)
        .unwrap();
    let item = doc
        .get_node(id)
        .unwrap()
        .element_data()
        .unwrap()
        .list_item_data()
        .unwrap();
    assert!(
        item.outside_marker_layout(doc.tree(), id).is_none(),
        "inside markers are inline text"
    );
}
