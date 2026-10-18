// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

#[test]
fn external_handle_does_not_alias_a_reused_slot() {
    let dom = DomHandle::new("<p>seed</p>", "https://example.test/");
    assert_eq!(dom.document_node_id(), 0);
    let stale_handle = dom.create_element("div");
    let stale_id = dom.resolve_node_id(stale_handle).expect("mapped node");

    {
        let mut doc = dom.doc.borrow_mut();
        let dropped = doc.mutate().remove_and_drop_node(stale_id);
        assert!(dropped.is_some());
    }

    let live_handle = dom.create_element("span");
    let live_id = dom
        .resolve_node_id(live_handle)
        .expect("mapped replacement");

    assert_eq!(stale_id.as_u64() as u32, live_id.as_u64() as u32);
    assert_ne!(stale_id, live_id);
    assert!(live_handle > stale_handle);
    assert_eq!(
        dom.node_handles
            .borrow()
            .external_for_opaque(live_id.as_u64() as usize),
        Some(live_handle)
    );

    assert!(dom.set_attribute(live_handle, "data-live", "yes"));
    assert_eq!(
        dom.outer_html(live_handle),
        "<span data-live=\"yes\"></span>"
    );

    assert!(!dom.set_attribute(stale_handle, "data-stale", "no"));
    assert_eq!(dom.outer_html(stale_handle), "");
    assert_eq!(dom.resolve_node_id(stale_handle), Some(stale_id));
}

#[test]
fn stale_handle_matches_and_closest_do_not_error() {
    let dom = DomHandle::new(
        "<div id=host><a id=link>x</a></div>",
        "https://example.test/",
    );
    let link = dom.query_selector("#link").unwrap() as u32;
    let link_id = dom.resolve_node_id(link).expect("mapped link");
    assert!(dom.matches_in_subtree(link, "a").unwrap());

    {
        let mut doc = dom.doc.borrow_mut();
        assert!(doc.mutate().remove_and_drop_node(link_id).is_some());
    }

    assert!(!dom
        .matches_in_subtree(link, "actions-caches-filter")
        .unwrap());
    assert_eq!(dom.closest_in_tree(link, "div").unwrap(), -1);
    assert!(dom
        .query_selector_all_in_subtree(link, "*")
        .unwrap()
        .is_empty());
}

#[test]
fn stale_checkbox_handle_returns_false_before_snapshot() {
    let dom = DomHandle::new("", "https://example.test/");
    let stale_handle = dom.create_element("input");
    let stale_id = dom.resolve_node_id(stale_handle).expect("mapped input");

    {
        let mut doc = dom.doc.borrow_mut();
        let dropped = doc.mutate().remove_and_drop_node(stale_id);
        assert!(dropped.is_some());
    }

    let replacement = dom.create_element("input");
    let replacement_id = dom
        .resolve_node_id(replacement)
        .expect("mapped replacement");
    assert_eq!(stale_id.as_u64() as u32, replacement_id.as_u64() as u32);
    assert_ne!(stale_id, replacement_id);
    assert!(!dom.set_checkbox_checked(stale_handle, true));
    assert!(dom.set_checkbox_checked(replacement, true));
}

#[test]
fn drop_node_frees_unwrapped_text_without_reusing_external_handle() {
    let dom = DomHandle::new("<div id=parent></div>", "https://example.test/");
    let parent = dom.query_selector("#parent").expect("parent found") as u32;
    let text = dom.create_text_node("discarded");
    assert!(dom.append_child_node(parent, text));
    let before_drop = dom.node_count();

    assert!(dom.drop_node(text));
    assert_eq!(dom.node_count(), before_drop - 1);
    assert!(dom.child_ids(parent).is_empty());
    assert!(!dom.drop_node(text), "a dropped external handle is stale");
    assert_eq!(dom.resolve_node_id(text), None);

    let replacement = dom.create_text_node("replacement");
    assert!(replacement > text, "external handles are never reused");
}

#[test]
fn detached_text_survives_until_explicitly_dropped() {
    let dom = DomHandle::new("<div id=parent></div>", "https://example.test/");
    let parent = dom.query_selector("#parent").expect("parent found") as u32;
    let text = dom.create_text_node("held");
    assert!(dom.append_child_node(parent, text));
    let before_remove = dom.node_count();

    assert!(dom.remove_node(text));
    assert_eq!(dom.node_count(), before_remove);
    assert_eq!(dom.text_content(text), "held");
    assert!(dom.drop_node(text));
    assert_eq!(dom.node_count(), before_remove - 1);
}

#[test]
fn dropping_a_subtree_retires_descendant_handle_metadata() {
    let dom = DomHandle::new("", "https://example.test/");
    let parent = dom.create_element("div");
    let child = dom.create_element("span");
    let parent_id = dom.resolve_node_id(parent).expect("mapped parent");
    let child_id = dom.resolve_node_id(child).expect("mapped child");
    assert!(dom.append_child_node(parent, child));

    assert!(dom.drop_node(parent));
    assert_eq!(dom.resolve_node_id(parent), None);
    assert_eq!(dom.resolve_node_id(child), None);
    let handles = dom.node_handles.borrow();
    assert!(!handles.external_by_internal.contains_key(&parent_id));
    assert!(!handles.external_by_internal.contains_key(&child_id));
    assert!(!handles
        .external_by_opaque
        .contains_key(&(parent_id.as_u64() as usize)));
    assert!(!handles
        .external_by_opaque
        .contains_key(&(child_id.as_u64() as usize)));
}

#[test]
fn dropping_a_host_retires_shadow_tree_handle_metadata() {
    let dom = DomHandle::new("", "https://example.test/");
    let host = dom.create_element("div");
    let root = dom.attach_shadow(host, "open") as u32;
    let child = dom.create_element("span");
    let root_id = dom.resolve_node_id(root).expect("mapped shadow root");
    let child_id = dom.resolve_node_id(child).expect("mapped shadow child");
    assert!(dom.append_child_node(root, child));

    assert!(dom.drop_node(host));
    assert_eq!(dom.resolve_node_id(root), None);
    assert_eq!(dom.resolve_node_id(child), None);
    let handles = dom.node_handles.borrow();
    assert!(!handles.external_by_internal.contains_key(&root_id));
    assert!(!handles.external_by_internal.contains_key(&child_id));
}
