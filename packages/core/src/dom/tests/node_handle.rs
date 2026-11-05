// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::{DomHandle, NodeHandleMap, NodeId};

/// Frees a node and its slot, as a script dropping it does; returns whether it
/// was there.
fn remove_and_drop(dom: &DomHandle, id: NodeId) -> bool {
    dom.doc
        .borrow_mut()
        .mutate()
        .remove_and_drop_node(id)
        .is_some()
}

#[test]
fn external_handle_does_not_alias_a_reused_slot() {
    let dom = DomHandle::new("<p>seed</p>", "https://example.test/");
    assert_eq!(dom.document_node_id(), 0);
    let stale_handle = dom.create_element("div");
    let stale_id = dom.resolve_node_id(stale_handle).expect("mapped node");

    assert!(remove_and_drop(&dom, stale_id));

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

    let mut handles = dom.node_handles.borrow_mut();
    assert_eq!(handles.existing_external(stale_id), Some(stale_handle));
    assert_eq!(handles.external_for(stale_id), stale_handle);
    assert_eq!(
        handles.external_for_opaque(live_id.as_u64() as usize),
        Some(live_handle)
    );
    // An opaque key carries the generation on 64-bit, and only the slot on wasm32.
    if usize::BITS == 64 {
        assert_eq!(
            handles.external_for_opaque(live_id.as_u64() as u32 as usize),
            None
        );
    }
    handles.retire(live_id);
    assert_eq!(handles.resolve(live_handle), None);
    assert_eq!(handles.resolve(stale_handle), Some(stale_id));
    assert_eq!(handles.existing_external(stale_id), Some(stale_handle));
    assert_eq!(handles.external_for_opaque(live_id.as_u64() as usize), None);
    if usize::BITS == 32 {
        assert_eq!(
            handles.external_for_opaque(stale_id.as_u64() as usize),
            None
        );
    } else {
        assert_eq!(
            handles.external_for_opaque(stale_id.as_u64() as usize),
            Some(stale_handle)
        );
    }
    handles.retire(stale_id);
    assert_eq!(handles.resolve(stale_handle), None);
}

#[test]
fn retiring_a_displaced_generation_keeps_the_latest_handle_registered() {
    let dom = DomHandle::new("", "https://example.test/");
    let old = dom.create_element("div");
    let old_id = dom.resolve_node_id(old).expect("mapped old node");
    assert!(remove_and_drop(&dom, old_id));

    let live = dom.create_element("span");
    let live_id = dom.resolve_node_id(live).expect("mapped replacement");
    assert_eq!(old_id.as_u64() as u32, live_id.as_u64() as u32);

    let mut handles = dom.node_handles.borrow_mut();
    handles.retire(old_id);
    assert_eq!(handles.resolve(old), None);
    assert_eq!(handles.resolve(live), Some(live_id));
    assert_eq!(handles.existing_external(live_id), Some(live));
    assert_eq!(
        handles.external_for_opaque(live_id.as_u64() as usize),
        Some(live)
    );
}

#[test]
fn seeded_handles_keep_tree_iteration_order_with_dense_storage() {
    let html = "<span>x</span>".repeat(512);
    let dom = DomHandle::new(&html, "https://example.test/");
    let doc = dom.doc.borrow();
    let handles = dom.node_handles.borrow();
    let root = doc.root_node().id();
    let expected: Vec<_> = std::iter::once(root)
        .chain(doc.tree().iter().map(|(id, _)| id).filter(|&id| id != root))
        .collect();

    for (external, id) in expected.into_iter().enumerate() {
        assert_eq!(handles.resolve(external as u32), Some(id));
        assert_eq!(handles.existing_external(id), Some(external as u32));
    }
    assert_eq!(handles.seeded_versions.len(), doc.tree().len());
    assert!(handles.latest_beyond.is_empty() && handles.sparse_latest.is_empty());
}

#[test]
fn seeded_handles_name_their_slots_across_freed_slots() {
    let html = format!("<i id=gap></i>{}", "<span>x</span>".repeat(512));
    let dom = DomHandle::new(&html, "https://example.test/");
    let gap = dom.query_selector("#gap").expect("gap node") as u32;
    assert!(dom.drop_node(gap));
    let doc = dom.doc.borrow();
    let slots = doc
        .tree()
        .iter()
        .map(|(id, _)| id.as_u64() as u32 as usize)
        .max();
    assert!(slots.expect("document root") > doc.tree().len());

    let handles = NodeHandleMap::seeded(&doc);
    assert_eq!(
        handles.resolve(gap),
        None,
        "the freed slot's handle names nothing"
    );
    for (id, _) in doc.tree().iter() {
        let external = handles.existing_external(id).expect("seeded node");
        assert_eq!(external, (id.as_u64() as u32) - 1);
        assert_eq!(handles.resolve(external), Some(id));
    }
    assert!(handles.next_external as usize >= handles.seeded_versions.len());
    drop(doc);
}

#[test]
fn seeding_a_slot_past_its_first_version_names_that_version() {
    let html = format!("<i id=gap></i>{}", "<span>x</span>".repeat(64));
    let dom = DomHandle::new(&html, "https://example.test/");
    let gap = dom.query_selector("#gap").expect("gap node") as u32;
    let gap_id = dom.resolve_node_id(gap).expect("seeded id");
    assert!(dom.drop_node(gap));
    let reused = dom.create_element("b");
    let reused_id = dom.resolve_node_id(reused).expect("mapped node");
    assert_eq!(
        gap_id.as_u64() as u32,
        reused_id.as_u64() as u32,
        "the slot is reused"
    );
    assert_ne!(gap_id, reused_id, "at a later version");

    let doc = dom.doc.borrow();
    let mut handles = NodeHandleMap::seeded(&doc);
    for (id, _) in doc.tree().iter() {
        let external = handles.existing_external(id).expect("seeded node");
        assert_eq!(external, (id.as_u64() as u32) - 1);
        assert_eq!(handles.resolve(external), Some(id));
    }
    assert_eq!(
        handles.seeded_versions.other.len(),
        1,
        "only the reused slot is stored apart"
    );
    handles.retire(reused_id);
    assert_eq!(handles.resolve(gap), None);
    assert!(handles.seeded_versions.other.is_empty());
    let next = doc
        .tree()
        .iter()
        .map(|(id, _)| id)
        .find(|&id| id != reused_id && id != doc.root_node().id());
    let next = next.expect("another node");
    assert_eq!(handles.resolve((next.as_u64() as u32) - 1), Some(next));
    drop(doc);
}

#[test]
fn a_reused_seeded_slot_keeps_both_generations_apart() {
    // An empty element frees one slot, which the next node then reuses.
    let dom = DomHandle::new("<p id=old></p><p>b</p>", "https://example.test/");
    let old = dom.query_selector("#old").expect("seeded node") as u32;
    let old_id = dom.resolve_node_id(old).expect("seeded id");
    assert!(remove_and_drop(&dom, old_id));
    let live = dom.create_element("div");
    let live_id = dom.resolve_node_id(live).expect("mapped replacement");
    assert_eq!(
        old_id.as_u64() as u32,
        live_id.as_u64() as u32,
        "the slot is reused"
    );
    assert_ne!(old, live);

    let mut handles = dom.node_handles.borrow_mut();
    assert_eq!(handles.existing_external(old_id), Some(old));
    assert_eq!(handles.existing_external(live_id), Some(live));
    assert_eq!(
        handles.external_for_opaque(live_id.as_u64() as usize),
        Some(live)
    );

    handles.retire(live_id);
    assert_eq!(handles.resolve(live), None);
    assert_eq!(handles.resolve(old), Some(old_id));
    assert_eq!(handles.existing_external(old_id), Some(old));
    assert_eq!(
        handles.latest(old_id.as_u64() as u32 as usize),
        None,
        "the displaced seeded handle does not become the slot's latest again"
    );

    handles.retire(old_id);
    assert_eq!(handles.resolve(old), None);
    assert!(handles.sparse_latest.is_empty() && handles.displaced.is_empty());
}

#[test]
fn new_slots_past_the_seeded_range_grow_a_small_reverse_vector() {
    let dom = DomHandle::new(&"<span>x</span>".repeat(512), "https://example.test/");
    let seeded = dom.node_handles.borrow().seeded_versions.len();
    let created: Vec<_> = (0..64).map(|_| dom.create_element("b")).collect();
    let handles = dom.node_handles.borrow();
    assert_eq!(handles.latest_beyond.len(), 64);
    assert!(handles.latest_beyond.capacity() < seeded / 4);
    for external in created {
        let id = handles.resolve(external).expect("created node");
        assert!(id.as_u64() as u32 as usize > seeded);
        assert_eq!(handles.existing_external(id), Some(external));
    }
}

#[test]
fn reverse_vector_consumes_headroom_before_growing_again() {
    let dom = DomHandle::new("", "https://example.test/");
    let mut handles = dom.node_handles.borrow_mut();
    let seeded = handles.seeded_versions.len();
    let mut used_headroom = false;

    for _ in 0..1024 {
        let len = handles.latest_beyond.len();
        let capacity = handles.latest_beyond.capacity();
        let id = NodeId::from_u64((1u64 << 32) | (seeded + len + 1) as u64);
        let external = handles.external_for(id);
        assert_eq!(handles.resolve(external), Some(id));
        if len < capacity {
            used_headroom = true;
            assert_eq!(
                handles.latest_beyond.capacity(),
                capacity,
                "an existing spare slot must be used before reserving again"
            );
        }
    }
    assert!(
        used_headroom,
        "the fixture must exercise reserved spare slots"
    );
}

#[test]
fn zero_internal_id_is_a_dynamic_mapping_not_a_seed_tombstone() {
    let dom = DomHandle::new("", "https://example.test/");
    let mut handles = dom.node_handles.borrow_mut();
    let invalid = NodeId::default();
    assert_eq!(invalid.as_u64(), 0);

    let external = handles.external_for(invalid);
    assert_eq!(handles.resolve(external), Some(invalid));
    assert_eq!(handles.existing_external(invalid), Some(external));

    handles.retire(invalid);
    assert_eq!(handles.resolve(external), None);
}

#[test]
fn out_of_range_slots_do_not_expand_the_dense_reverse_index() {
    let dom = DomHandle::new("", "https://example.test/");
    let mut handles = dom.node_handles.borrow_mut();
    let dense_len = handles.latest_beyond.len();
    let slot = u32::MAX - 1;
    let older = NodeId::from_u64((1u64 << 32) | u64::from(slot));
    let newer = NodeId::from_u64((2u64 << 32) | u64::from(slot));

    let old_external = handles.external_for(older);
    let new_external = handles.external_for(newer);
    assert_eq!(handles.latest_beyond.len(), dense_len);
    assert_eq!(handles.resolve(old_external), Some(older));
    assert_eq!(handles.existing_external(older), Some(old_external));
    assert_eq!(handles.existing_external(newer), Some(new_external));

    handles.retire(newer);
    assert_eq!(handles.resolve(old_external), Some(older));
    if usize::BITS == 32 {
        assert_eq!(handles.external_for_opaque(slot as usize), None);
    }
    handles.retire(older);
    assert!(handles.sparse_latest.is_empty());
    assert!(handles.displaced.is_empty());
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

    assert!(remove_and_drop(&dom, link_id));

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
fn matches_in_subtree_bytes_decodes_utf8_and_rejects_invalid_bytes() {
    let dom = DomHandle::new(
        "<div id=host><a id=link title=\"caf\u{e9}\">x</a></div>",
        "https://example.test/",
    );
    let link = dom.query_selector("#link").unwrap() as u32;

    assert!(dom.matches_in_subtree_bytes(link, b"a").unwrap());
    assert!(dom
        .matches_in_subtree_bytes(link, "a[title=\"caf\u{e9}\"]".as_bytes())
        .unwrap());
    assert!(!dom.matches_in_subtree_bytes(link, b"div > span").unwrap());
    // Invalid UTF-8 is not a selector, and must not match.
    assert!(!dom.matches_in_subtree_bytes(link, &[0xff, 0xfe]).unwrap());
}

#[test]
fn stale_checkbox_handle_returns_false_before_snapshot() {
    let dom = DomHandle::new("", "https://example.test/");
    let stale_handle = dom.create_element("input");
    let stale_id = dom.resolve_node_id(stale_handle).expect("mapped input");

    assert!(remove_and_drop(&dom, stale_id));

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
    assert_eq!(handles.existing_external(parent_id), None);
    assert_eq!(handles.existing_external(child_id), None);
    assert_eq!(
        handles.external_for_opaque(parent_id.as_u64() as usize),
        None
    );
    assert_eq!(
        handles.external_for_opaque(child_id.as_u64() as usize),
        None
    );
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
    assert_eq!(handles.existing_external(root_id), None);
    assert_eq!(handles.existing_external(child_id), None);
}
