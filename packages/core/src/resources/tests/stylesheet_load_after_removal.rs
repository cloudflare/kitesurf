// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A `<link rel=stylesheet>` removed while its sheet is in flight must not apply it. A dropped
//! link once left a stale slotmap key that panicked on delivery, and the panic stranded the
//! document's event receiver so every later resolve panicked too (blitz-dom patches 0150, 0151).

use crate::DomHandle;

const PAGE: &str = r##"<!DOCTYPE html>
<html><head></head><body><p id="p">x</p></body></html>"##;

/// A detached link with rel then href starts its fetch. A data: URL
/// decodes during that fetch, so the Resource::Css sits in the channel
/// until the next handle_messages, the same as a slow network sheet.
fn queue_link(dom: &DomHandle, css: &str) -> u32 {
    let link = dom.create_element("link");
    assert!(dom.set_attribute(link, "rel", "stylesheet"));
    assert!(dom.set_attribute(link, "href", &format!("data:text/css,{css}")));
    link
}

fn color_of_p(dom: &DomHandle) -> String {
    dom.layout_dirty.set(true);
    dom.resolve_layout();
    let p = dom.query_selector("#p").expect("query ok");
    assert!(p >= 0, "#p found");
    dom.computed_style_value(p as u32, "color").expect("color")
}

#[test]
fn a_dropped_link_drops_its_sheet() {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.resolve_layout();
    let head = dom.query_selector("head").expect("query ok") as u32;

    let link = queue_link(&dom, "p{color:rgb(1,2,3)}");
    assert!(dom.append_child_node(head, link));
    assert!(dom.drop_node(link));
    dom.pump_resource_messages();
    assert_ne!(
        color_of_p(&dom),
        "rgb(1, 2, 3)",
        "a dropped link's sheet applied"
    );

    // The channel still delivers: a sheet that arrives afterwards applies.
    let link = queue_link(&dom, "p{color:rgb(4,5,6)}");
    assert!(dom.append_child_node(head, link));
    dom.pump_resource_messages();
    assert_eq!(color_of_p(&dom), "rgb(4, 5, 6)");
}

#[test]
fn a_detached_link_drops_its_sheet() {
    // Removed but still held by a page wrapper: the node is live, so
    // nothing panics, but its sheet must not style the document.
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.resolve_layout();
    let head = dom.query_selector("head").expect("query ok") as u32;

    let link = queue_link(&dom, "p{color:rgb(1,2,3)}");
    assert!(dom.append_child_node(head, link));
    assert!(dom.remove_node(link));
    dom.pump_resource_messages();
    assert_ne!(
        color_of_p(&dom),
        "rgb(1, 2, 3)",
        "a detached link's sheet applied"
    );

    // Inserting it again fetches again, and that sheet applies.
    assert!(dom.append_child_node(head, link));
    dom.pump_resource_messages();
    assert_eq!(color_of_p(&dom), "rgb(1, 2, 3)");
}
