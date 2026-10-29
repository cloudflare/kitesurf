// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! `get_element_by_id` must match a tree query across mutations that add, move or remove ids.

use crate::DomHandle;

fn by_query(dom: &DomHandle, id: &str) -> i32 {
    dom.query_selector(&format!("[id=\"{id}\"]"))
        .expect("query ok")
}

fn assert_same(dom: &DomHandle, ids: &[&str], step: &str) {
    for id in ids {
        assert_eq!(
            dom.get_element_by_id(id),
            by_query(dom, id),
            "{step}: #{id}"
        );
    }
}

#[test]
fn id_map_matches_a_tree_query_across_mutations() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body>
<div id="a"><p id="b"></p></div><template><i id="t"></i></template>
<div id="host"></div></body></html>"##,
        "https://test.example/",
    );
    let ids = ["a", "b", "c", "dup", "s"];
    assert_same(&dom, &ids, "parsed");
    assert_eq!(
        dom.get_element_by_id("t"),
        -1,
        "template contents are not in the document"
    );

    let a = by_query(&dom, "a") as u32;
    let b = by_query(&dom, "b") as u32;
    let host = by_query(&dom, "host") as u32;

    assert!(dom.set_attribute(b, "id", "c"));
    assert_same(&dom, &ids, "renamed b -> c");

    assert!(dom.remove_node(a));
    assert_same(&dom, &ids, "removed a subtree");
    assert!(dom.set_attribute(a, "id", "dup"));
    assert_same(&dom, &ids, "renamed while detached");
    assert!(dom.append_child_node(host, a));
    assert_same(&dom, &ids, "reinserted");

    // A later duplicate must not win over the earlier one in tree order.
    let early = dom.create_element("span");
    assert!(dom.set_attribute(early, "id", "dup"));
    assert!(dom.insert_before_node(host, early, a));
    assert_same(&dom, &ids, "earlier duplicate inserted");
    assert!(dom.remove_attribute(early, "id"));
    assert_same(&dom, &ids, "earlier duplicate cleared");

    // Shadow-tree ids stay invisible to document lookups, including one
    // set after the node is already inside a connected shadow tree.
    let root = dom.attach_shadow(host, "open") as u32;
    let inner = dom.create_element("span");
    assert!(dom.append_child_node(root, inner));
    assert!(dom.set_attribute(inner, "id", "s"));
    assert_same(&dom, &ids, "id set inside a shadow tree");
}

/// Connected-to-connected moves across a shadow boundary never flip
/// `is_in_document`, so the id map must be updated from the boundary change.
#[test]
fn id_map_tracks_moves_across_a_shadow_boundary() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body><div id="host"></div></body></html>"##,
        "https://test.example/",
    );
    let ids = ["inner", "mv", "out"];
    let host = by_query(&dom, "host") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;

    let c = dom.create_element("div");
    assert!(dom.append_child_node(root, c));
    let ops = format!(r#"[{{"kind":"setInnerHtml","node":{c},"html":"<span id=inner></span>"}}]"#);
    dom.apply_ops(&ops).expect("ops applied");
    assert_eq!(
        dom.get_element_by_id("inner"),
        -1,
        "innerHTML inside a shadow tree"
    );

    let mv = dom.create_element("p");
    assert!(dom.set_attribute(mv, "id", "mv"));
    assert!(dom.append_child_node(body, mv));
    assert_same(&dom, &ids, "light element inserted");
    assert!(dom.append_child_node(root, mv));
    assert_eq!(
        dom.get_element_by_id("mv"),
        -1,
        "light element moved into a shadow tree"
    );

    let out = dom.create_element("p");
    assert!(dom.set_attribute(out, "id", "out"));
    assert!(dom.append_child_node(root, out));
    assert!(dom.append_child_node(body, out));
    assert_ne!(
        dom.get_element_by_id("out"),
        -1,
        "shadow element moved to the light tree"
    );
    assert_same(&dom, &ids, "after shadow boundary moves");
}

#[test]
fn id_map_skips_template_contents_moved_out_of_a_shadow_tree() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body><div id="host"></div></body></html>"##,
        "https://test.example/",
    );
    let host = by_query(&dom, "host") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;
    let wrap = dom.create_element("div");
    assert!(dom.append_child_node(root, wrap));
    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{wrap},"html":"<template><i id=tpl></i></template>"}}]"#
    );
    dom.apply_ops(&ops).expect("ops applied");
    assert!(dom.append_child_node(body, wrap));
    assert_eq!(
        dom.get_element_by_id("tpl"),
        -1,
        "template contents are inert"
    );
}
