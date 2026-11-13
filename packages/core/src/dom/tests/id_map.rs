// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! `get_element_by_id` must match a tree query across mutations that add, move or remove ids.

use crate::DomHandle;

fn query_id(dom: &DomHandle, id: &str) -> i32 {
    dom.query_selector(&format!("[id=\"{id}\"]"))
        .expect("query ok")
}

fn assert_id_map_matches_query(dom: &DomHandle, ids: &[&str], mutation: &str) {
    for id in ids {
        assert_eq!(
            dom.get_element_by_id(id),
            query_id(dom, id),
            "{mutation}: #{id}"
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
    assert_id_map_matches_query(&dom, &ids, "parsed");
    assert_eq!(
        dom.get_element_by_id("t"),
        -1,
        "template contents are not in the document"
    );

    let a = query_id(&dom, "a") as u32;
    let b = query_id(&dom, "b") as u32;
    let host = query_id(&dom, "host") as u32;

    assert!(dom.set_attribute(b, "id", "c"));
    assert_id_map_matches_query(&dom, &ids, "renamed b -> c");

    assert!(dom.remove_node(a));
    assert_id_map_matches_query(&dom, &ids, "removed a subtree");
    assert!(dom.set_attribute(a, "id", "dup"));
    assert_id_map_matches_query(&dom, &ids, "renamed while detached");
    assert!(dom.append_child_node(host, a));
    assert_id_map_matches_query(&dom, &ids, "reinserted");

    // A later duplicate must not win over the earlier one in tree order.
    let early = dom.create_element("span");
    assert!(dom.set_attribute(early, "id", "dup"));
    assert!(dom.insert_before_node(host, early, a));
    assert_id_map_matches_query(&dom, &ids, "earlier duplicate inserted");
    assert!(dom.remove_attribute(early, "id"));
    assert_id_map_matches_query(&dom, &ids, "earlier duplicate cleared");

    // Shadow-tree ids stay invisible to document lookups, including one
    // set after the node is already inside a connected shadow tree.
    let root = dom.attach_shadow(host, "open") as u32;
    let inner = dom.create_element("span");
    assert!(dom.append_child_node(root, inner));
    assert!(dom.set_attribute(inner, "id", "s"));
    assert_id_map_matches_query(&dom, &ids, "id set inside a shadow tree");
}

#[test]
fn id_map_keeps_the_remaining_duplicates_when_the_first_one_goes() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body>
<p id="x" class="one"></p><p id="x" class="two"></p><p id="x" class="three"></p>
</body></html>"##,
        "https://test.example/",
    );
    let ids = ["x"];
    assert_id_map_matches_query(&dom, &ids, "parsed");
    let node_id = |selector: &str| dom.query_selector(selector).expect("query ok") as u32;
    let (one, three, body) = (node_id(".one"), node_id(".three"), node_id("body"));
    // The first one added holds the main entry; removing it leaves two duplicates.
    assert!(dom.remove_node(one));
    assert_id_map_matches_query(&dom, &ids, "first removed");
    assert!(dom.set_attribute(three, "id", "y"));
    assert_id_map_matches_query(&dom, &["x", "y"], "last renamed");
    assert!(dom.append_child_node(body, one));
    assert_id_map_matches_query(&dom, &ids, "first reinserted after the others");
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
    let host = query_id(&dom, "host") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;

    let container = dom.create_element("div");
    assert!(dom.append_child_node(root, container));
    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{container},"html":"<span id=inner></span>"}}]"#
    );
    dom.apply_ops(&ops).expect("ops applied");
    assert_eq!(
        dom.get_element_by_id("inner"),
        -1,
        "innerHTML inside a shadow tree"
    );

    let moved = dom.create_element("p");
    assert!(dom.set_attribute(moved, "id", "mv"));
    assert!(dom.append_child_node(body, moved));
    assert_id_map_matches_query(&dom, &ids, "light element inserted");
    assert!(dom.append_child_node(root, moved));
    assert_eq!(
        dom.get_element_by_id("mv"),
        -1,
        "light element moved into a shadow tree"
    );

    let returned = dom.create_element("p");
    assert!(dom.set_attribute(returned, "id", "out"));
    assert!(dom.append_child_node(root, returned));
    assert!(dom.append_child_node(body, returned));
    assert_ne!(
        dom.get_element_by_id("out"),
        -1,
        "shadow element moved to the light tree"
    );
    assert_id_map_matches_query(&dom, &ids, "after shadow boundary moves");
}

/// A moved subtree derives containment from its root: deep light descendants follow the move,
/// while ids inside a nested host's shadow tree stay hidden in both directions.
#[test]
fn id_map_tracks_deep_subtrees_with_nested_hosts_across_a_shadow_boundary() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body><div id="host"></div></body></html>"##,
        "https://test.example/",
    );
    let ids = ["outer", "deep", "nested", "after"];
    let host = query_id(&dom, "host") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;

    let outer = dom.create_element("div");
    assert!(dom.set_attribute(outer, "id", "outer"));
    let inner_host = dom.create_element("section");
    assert!(dom.append_child_node(outer, inner_host));
    let deep = dom.create_element("b");
    assert!(dom.set_attribute(deep, "id", "deep"));
    assert!(dom.append_child_node(inner_host, deep));
    let after = dom.create_element("i");
    assert!(dom.set_attribute(after, "id", "after"));
    assert!(dom.append_child_node(outer, after));
    let nested_root = dom.attach_shadow(inner_host, "open") as u32;
    let nested = dom.create_element("span");
    assert!(dom.set_attribute(nested, "id", "nested"));
    assert!(dom.append_child_node(nested_root, nested));

    assert!(dom.append_child_node(body, outer));
    assert_id_map_matches_query(&dom, &ids, "light subtree inserted");
    assert_eq!(dom.get_element_by_id("nested"), -1, "nested shadow id");

    assert!(dom.append_child_node(root, outer));
    for id in ids {
        assert_eq!(
            dom.get_element_by_id(id),
            -1,
            "moved into a shadow tree: #{id}"
        );
    }

    assert!(dom.append_child_node(body, outer));
    assert_id_map_matches_query(&dom, &ids, "moved back to the light tree");
    for id in ["outer", "deep", "after"] {
        assert_ne!(dom.get_element_by_id(id), -1, "light id restored: #{id}");
    }
    assert_eq!(
        dom.get_element_by_id("nested"),
        -1,
        "nested shadow id after moves"
    );
}

#[test]
fn id_map_skips_template_contents_moved_out_of_a_shadow_tree() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body><div id="host"></div></body></html>"##,
        "https://test.example/",
    );
    let host = query_id(&dom, "host") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;
    let wrapper = dom.create_element("div");
    assert!(dom.append_child_node(root, wrapper));
    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{wrapper},"html":"<template><i id=tpl></i></template>"}}]"#
    );
    dom.apply_ops(&ops).expect("ops applied");
    assert!(dom.append_child_node(body, wrapper));
    assert_eq!(
        dom.get_element_by_id("tpl"),
        -1,
        "template contents are inert"
    );
}
