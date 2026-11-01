// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

fn assert_released(dom: &DomHandle, id: u32) {
    let doc = dom.doc.borrow();
    let node = doc.get_node(dom.resolve_node_id(id).unwrap()).unwrap();
    let element = node.element_data().unwrap();
    assert!(
        element.layout_data.is_none(),
        "hidden descendant keeps box data"
    );
    assert!(
        element.inline_layout_data().is_none(),
        "hidden descendant keeps shaped text"
    );
    assert!(
        element.list_item_data().is_none(),
        "hidden descendant keeps its marker"
    );
    assert_eq!(
        node.layout_parent.get(),
        None,
        "hidden descendant keeps a box parent"
    );
    drop(doc);
}

#[test]
fn hidden_descendants_release_boxes_but_still_report_style_and_restore_layout() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><div id=outer>bare text<p id=p>some <b>bold</b> text</p>\
         <ul><li id=item>marker</li></ul></div>",
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let outer = dom.query_selector("#outer").unwrap() as u32;
    let p = dom.query_selector("#p").unwrap() as u32;
    let item = dom.query_selector("#item").unwrap() as u32;
    let before = dom.test_bounding_rect(p);
    assert!(before.2 > 0.0 && before.3 > 0.0);
    assert!(dom.set_attribute(outer, "style", "display:none"));
    dom.resolve_layout();
    assert_released(&dom, p);
    assert_released(&dom, item);
    assert_eq!(dom.computed_style_value(p, "display"), Some("block".into()));
    assert!(dom.set_attribute(outer, "style", ""));
    dom.resolve_layout();
    assert_eq!(dom.test_bounding_rect(p), before);
}

#[test]
fn hiding_a_slot_container_releases_assigned_nodes_and_restores_layout() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><div id=host><p id=p>some <b>slotted</b> text</p></div>",
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    let host = dom.query_selector("#host").unwrap() as u32;
    let p = dom.query_selector("#p").unwrap() as u32;
    let root = dom.attach_shadow(host, "open") as u32;
    dom.apply_ops(&format!(
        r#"[{{"kind":"setInnerHtml","node":{root},"html":"<div id=wrap><slot></slot></div>"}}]"#
    ))
    .unwrap();
    let wrap = dom.query_selector_all_in_subtree(root, "#wrap").unwrap()[0] as u32;
    dom.resolve_layout();
    let before = dom.test_bounding_rect(p);
    assert!(before.2 > 0.0 && before.3 > 0.0);
    assert!(dom.set_attribute(wrap, "style", "display:none"));
    dom.resolve_layout();
    assert_released(&dom, p);
    assert!(dom.set_attribute(wrap, "style", ""));
    dom.resolve_layout();
    assert_eq!(dom.test_bounding_rect(p), before);
}

#[test]
fn hiding_a_flattened_inline_releases_its_atomic_descendant() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><p>before <span id=outer>inline \
         <span id=p style=display:inline-block>atomic <b>text</b></span></span> after</p>",
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let outer = dom.query_selector("#outer").unwrap() as u32;
    let p = dom.query_selector("#p").unwrap() as u32;
    {
        let doc = dom.doc.borrow();
        let node = doc.get_node(dom.resolve_node_id(outer).unwrap()).unwrap();
        assert!(
            node.layout_children.borrow().is_none(),
            "the inline is flattened"
        );
        drop(doc);
    }
    let before = dom.test_bounding_rect(p);
    assert!(before.2 > 0.0 && before.3 > 0.0);
    assert!(dom.set_attribute(outer, "style", "display:none"));
    dom.resolve_layout();
    assert_released(&dom, p);
    assert!(dom.set_attribute(outer, "style", ""));
    dom.resolve_layout();
    assert_eq!(dom.test_bounding_rect(p), before);
}
