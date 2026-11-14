// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Outside list markers are shaped when painted rather than kept per item.

use crate::DomHandle;
use blitz_dom::node::ListItemLayout;
use blitz_dom::{BaseDocument, NodeId};

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

/// The list item data of the element `selector` matches, with its internal id.
fn list_item<'a>(
    dom: &DomHandle,
    doc: &'a BaseDocument,
    selector: &str,
) -> (NodeId, &'a ListItemLayout) {
    let external = dom.query_selector(selector).expect("query parses") as u32;
    let id = dom.resolve_node_id(external).expect("mapped list item");
    let item = doc
        .get_node(id)
        .expect("list item node")
        .element_data()
        .expect("element data")
        .list_item_data()
        .expect("list item data");
    (id, item)
}

fn marker_width(dom: &DomHandle, doc: &BaseDocument, selector: &str) -> f32 {
    let (id, item) = list_item(dom, doc, selector);
    let layout = item
        .outside_marker_layout(doc.tree(), id)
        .expect("outside marker");
    assert_eq!(layout.lines().count(), 1);
    assert!(
        layout.lines().flat_map(|line| line.items()).count() > 0,
        "marker has glyphs"
    );
    layout.full_width()
}

#[test]
fn an_outside_marker_is_shaped_from_its_items_style() {
    let dom = page("disc outside");
    let doc = dom.doc.borrow();
    let disc = marker_width(&dom, doc.as_ref(), "#a");
    let number = marker_width(&dom, doc.as_ref(), "#b");
    assert!(disc > 0.0 && number > 0.0);
    assert_ne!(
        disc, number,
        "each item's marker text and font size are used"
    );
}

#[test]
fn outside_markers_are_painted() {
    let scene = |list_style| page(list_style).render_scene(0, 0, 0, 0, false, true);
    let disc = scene("disc outside");
    assert_ne!(disc, scene("none"));
    assert_ne!(scene("square outside"), disc);

    let dom = page("disc inside");
    let doc = dom.doc.borrow();
    let (id, item) = list_item(&dom, doc.as_ref(), "#a");
    assert!(
        item.outside_marker_layout(doc.tree(), id).is_none(),
        "inside markers are inline text"
    );
}
