// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! `attributeList` must report exactly `nodeInfo`'s `attributes` and `attributeNamespaces`.

use crate::dom::cdp::describe_node;
use crate::dom::tree::NodeRead;
use crate::DomHandle;
use serde_json::{json, Value};

fn node_info(dom: &DomHandle, node: u32) -> Value {
    let id = dom.resolve_node_id(node).expect("live node");
    let doc = dom.doc.borrow();
    let mut handles = dom.node_handles.borrow_mut();
    let info = describe_node(&doc, id, "https://test.example/", None, &mut handles);
    serde_json::to_value(info.expect("described")).expect("serializes")
}

fn attribute_list(dom: &DomHandle, node: u32) -> Value {
    match dom.read_attribute_list(node) {
        NodeRead::Read(list) => serde_json::to_value(list).expect("serializes"),
        NodeRead::Missing => panic!("node {node} missing"),
        NodeRead::Busy => panic!("document busy"),
    }
}

fn assert_matches_node_info(dom: &DomHandle, node: u32, step: &str) {
    let info = node_info(dom, node);
    let list = attribute_list(dom, node);
    assert_eq!(
        list.get("attributes"),
        info.get("attributes"),
        "{step}: attributes"
    );
    assert_eq!(
        list.get("attributeNamespaces"),
        info.get("attributeNamespaces"),
        "{step}: attributeNamespaces"
    );
}

fn first(dom: &DomHandle, selector: &str) -> u32 {
    let id = dom.query_selector(selector).expect("query ok");
    assert!(id >= 0, "{selector} matches");
    id as u32
}

#[test]
fn attribute_list_matches_node_info_across_mutations() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><body><p id="a" class="x y" data-k="v">t</p><div></div>
<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="#h" xml:lang="en"></a></svg>
</body>"##,
        "https://test.example/",
    );
    let p = first(&dom, "p");
    let div = first(&dom, "div");
    let svg_a = first(&dom, "svg a");
    let text = dom.child_ids(p)[0];
    for (node, step) in [(p, "p"), (div, "div"), (svg_a, "svg a"), (text, "text")] {
        assert_matches_node_info(&dom, node, step);
    }
    assert_eq!(
        attribute_list(&dom, p)["attributes"],
        json!(["id", "a", "class", "x y", "data-k", "v"])
    );
    assert_eq!(
        attribute_list(&dom, div),
        json!({}),
        "no attributes, no keys"
    );
    assert_eq!(
        attribute_list(&dom, text),
        json!({}),
        "a text node has none"
    );
    assert_eq!(
        attribute_list(&dom, svg_a)["attributeNamespaces"],
        json!([
            {"qualifiedName": "xlink:href", "namespaceURI": "http://www.w3.org/1999/xlink",
             "prefix": "xlink", "localName": "href"},
            {"qualifiedName": "xml:lang", "namespaceURI": "http://www.w3.org/XML/1998/namespace",
             "prefix": "xml", "localName": "lang"},
        ])
    );

    assert!(dom.set_attribute(div, "title", "new"));
    assert!(dom.set_attribute(p, "class", "z"));
    assert!(dom.remove_attribute(p, "data-k"));
    assert_matches_node_info(&dom, div, "div after set");
    assert_matches_node_info(&dom, p, "p after set and remove");
    assert_eq!(
        attribute_list(&dom, p)["attributes"],
        json!(["id", "a", "class", "z"])
    );
    assert!(dom.remove_attribute(div, "title"));
    assert_eq!(
        attribute_list(&dom, div),
        json!({}),
        "removal empties the list"
    );
}

#[test]
fn attribute_list_reports_a_missing_node_like_node_info() {
    let dom = DomHandle::new("<p>x</p>", "https://test.example/");
    assert!(matches!(
        dom.read_attribute_list(u32::MAX),
        NodeRead::Missing
    ));
}
