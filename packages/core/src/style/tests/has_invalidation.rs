// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use ::style::properties::LonghandId;

use crate::DomHandle;

const BLUE: &str = "rgb(0, 0, 255)";
const RED: &str = "rgb(255, 0, 0)";
const RED_FREE: &str = "rgba(0, 0, 0, 0)";

fn background(dom: &DomHandle, node_id: u32) -> String {
    let doc = dom.doc.borrow();
    let node = doc
        .get_node(crate::blitz_node_id(node_id))
        .expect("node exists");
    let styles = node.primary_styles().expect("node has primary styles");
    let mut out = String::new();
    styles
        .computed_or_resolved_value(LonghandId::BackgroundColor, None, &mut out)
        .expect("longhand serializes");
    out
}

const HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
#p1, #p2, #p3, #ps, #pa { background-color: rgb(0, 0, 255) }
#p1:has(.t), #p2:has(.t), #p3:has(.t) { background-color: rgb(255, 0, 0) }
#ps:has(~ .t) { background-color: rgb(255, 0, 0) }
#pa:has(+ .t) { background-color: rgb(255, 0, 0) }
</style></head>
<body>
<div id="p1"><div id="c1">x</div></div>
<div id="p2"><div><div id="c2">x</div></div></div>
<div id="p3"><div><div><div id="c3">x</div></div></div></div>
<div id="ps"></div><div id="filler"></div><div id="sib">x</div>
<div id="pa"></div><div id="adj">x</div>
</body></html>"##;

fn dom_and(selector: &str) -> (DomHandle, u32) {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector(selector).expect("query ok");
    assert!(id >= 0, "{selector} found");
    (dom, id as u32)
}

fn assert_anchor_tracks(dom: &DomHandle, anchor: u32, target: u32, depth: &str) {
    assert_eq!(
        background(dom, anchor),
        BLUE,
        "{depth}: anchor must start unmatched"
    );

    assert!(dom.set_attribute(target, "class", "t"));
    dom.resolve_layout();
    assert_eq!(
        background(dom, anchor),
        RED,
        "{depth}: adding .t must invalidate the :has() anchor. Pre-fix this \
         only worked when the anchor was the mutated node's direct parent, \
         because blitz never ran stylo's relative-selector invalidator and \
         relied on the blunt parent restyle_subtree() hint"
    );

    assert!(dom.set_attribute(target, "class", ""));
    dom.resolve_layout();
    assert_eq!(
        background(dom, anchor),
        BLUE,
        "{depth}: removing .t must invalidate the anchor back"
    );
}

#[test]
fn has_invalidates_anchor_at_depth_1() {
    let (dom, anchor) = dom_and("#p1");
    let target = dom.query_selector("#c1").unwrap() as u32;
    assert_anchor_tracks(&dom, anchor, target, "depth 1");
}

#[test]
fn has_invalidates_anchor_at_depth_2() {
    let (dom, anchor) = dom_and("#p2");
    let target = dom.query_selector("#c2").unwrap() as u32;
    assert_anchor_tracks(&dom, anchor, target, "depth 2");
}

#[test]
fn has_invalidates_anchor_at_depth_3() {
    let (dom, anchor) = dom_and("#p3");
    let target = dom.query_selector("#c3").unwrap() as u32;
    assert_anchor_tracks(&dom, anchor, target, "depth 3");
}

#[test]
fn has_invalidates_anchor_for_general_sibling() {
    let (dom, anchor) = dom_and("#ps");
    let target = dom.query_selector("#sib").unwrap() as u32;
    assert_anchor_tracks(&dom, anchor, target, "general sibling");
}

#[test]
fn has_invalidates_anchor_for_adjacent_sibling() {
    let (dom, anchor) = dom_and("#pa");
    let target = dom.query_selector("#adj").unwrap() as u32;
    assert_anchor_tracks(&dom, anchor, target, "adjacent sibling");
}

#[test]
fn has_invalidates_anchor_when_attribute_is_removed() {
    let (dom, anchor) = dom_and("#p2");
    let target = dom.query_selector("#c2").unwrap() as u32;

    assert!(dom.set_attribute(target, "class", "t"));
    dom.resolve_layout();
    assert_eq!(background(&dom, anchor), RED, "depth 2: adding .t matches");

    assert!(dom.remove_attribute(target, "class"));
    dom.resolve_layout();
    assert_eq!(
        background(&dom, anchor),
        BLUE,
        "depth 2: removeAttribute must invalidate the anchor back"
    );
}

const STRUCT_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
#s1, #s2, #s3 { background-color: rgb(0, 0, 255) }
#s1:has(.t), #s2:has(.t), #s3:has(.t) { background-color: rgb(255, 0, 0) }
</style></head>
<body>
<div id="s1"></div>
<div id="s2"><div id="w2"></div></div>
<div id="s3"><div><div id="w3"></div></div></div>
</body></html>"##;

fn assert_anchor_tracks_structurally(anchor_sel: &str, mount_sel: &str, label: &str) {
    let dom = DomHandle::new(STRUCT_HTML, "https://test.example/");
    dom.resolve_layout();
    let anchor = dom.query_selector(anchor_sel).unwrap() as u32;
    let mount = dom.query_selector(mount_sel).unwrap() as u32;

    assert_eq!(background(&dom, anchor), BLUE, "{label}: starts unmatched");

    let el = dom.create_element("div");
    dom.set_attribute(el, "class", "t");
    dom.append_child_node(mount, el);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, anchor),
        RED,
        "{label}: inserting a matching element must invalidate the anchor. \
         Structural mutations take no snapshot, so they invalidate at \
         mutation time rather than from the snapshot pass"
    );

    dom.remove_node(el);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, anchor),
        BLUE,
        "{label}: removing it must invalidate the anchor back"
    );
}

#[test]
fn has_invalidates_anchor_structurally_at_depth_1() {
    assert_anchor_tracks_structurally("#s1", "#s1", "structural depth 1");
}

#[test]
fn has_invalidates_anchor_structurally_at_depth_2() {
    assert_anchor_tracks_structurally("#s2", "#w2", "structural depth 2");
}

#[test]
fn has_invalidates_anchor_structurally_at_depth_3() {
    assert_anchor_tracks_structurally("#s3", "#w3", "structural depth 3");
}

#[test]
fn has_invalidates_anchor_for_inserted_subtree() {
    let dom = DomHandle::new(STRUCT_HTML, "https://test.example/");
    dom.resolve_layout();
    let anchor = dom.query_selector("#s2").unwrap() as u32;
    let mount = dom.query_selector("#w2").unwrap() as u32;

    let wrapper = dom.create_element("div");
    let inner = dom.create_element("span");
    dom.set_attribute(inner, "class", "t");
    dom.append_child_node(wrapper, inner);
    dom.append_child_node(mount, wrapper);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, anchor),
        RED,
        "inserting a subtree whose descendant matches must invalidate"
    );

    dom.remove_node(wrapper);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, anchor),
        BLUE,
        "removing that subtree must invalidate the anchor back"
    );
}

#[test]
fn remove_node_recascades_the_parent() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
#e { background-color: rgb(0, 0, 255) }
#e:empty { background-color: rgb(255, 0, 0) }
#n > :nth-child(2) { background-color: rgb(255, 0, 0) }
</style></head>
<body>
<div id="e"><span id="ex">x</span></div>
<div id="n"><span id="n1">1</span><span id="n2">2</span><span id="n3">3</span></div>
</body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();

    let empty_parent = dom.query_selector("#e").unwrap() as u32;
    let only_child = dom.query_selector("#ex").unwrap() as u32;
    assert_eq!(background(&dom, empty_parent), BLUE, ":empty starts off");
    dom.remove_node(only_child);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, empty_parent),
        RED,
        "removing the last child must recascade the parent for :empty"
    );

    let second = dom.query_selector("#n2").unwrap() as u32;
    let third = dom.query_selector("#n3").unwrap() as u32;
    assert_eq!(background(&dom, third), RED_FREE, ":nth-child starts off");
    dom.remove_node(second);
    dom.resolve_layout();
    assert_eq!(
        background(&dom, third),
        RED,
        "removing a sibling must recascade the parent's children for :nth-child"
    );
}

#[test]
fn has_invalidates_anchor_for_focus_state() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
#f1, #f2 { background-color: rgb(0, 0, 255) }
#f1:has(:focus), #f2:has(:focus) { background-color: rgb(255, 0, 0) }
</style></head>
<body>
<div id="f1"><input id="i1" /></div>
<div id="f2"><div><input id="i2" /></div></div>
</body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();

    for (anchor_sel, input_sel, depth) in [
        ("#f1", "#i1", "focus depth 1"),
        ("#f2", "#i2", "focus depth 2"),
    ] {
        let anchor = dom.query_selector(anchor_sel).unwrap() as u32;
        let input = dom.query_selector(input_sel).unwrap() as u32;

        assert_eq!(background(&dom, anchor), BLUE, "{depth}: starts unmatched");

        dom.set_focus(input);
        dom.resolve_layout();
        assert_eq!(
            background(&dom, anchor),
            RED,
            "{depth}: focusing the input must invalidate the :has(:focus) anchor"
        );

        dom.clear_focus();
        dom.resolve_layout();
        assert_eq!(
            background(&dom, anchor),
            BLUE,
            "{depth}: blurring must invalidate the anchor back"
        );
    }
}

/// WPT `has-in-parent-position`: a `:has()` anchor styles its child subject,
/// while the removed match sits deeper under that subject. Removal marking
/// stops at `dirty_descendants` on the anchor; it must also mark the anchor's
/// ancestors so invalidation reaches the subject.
#[test]
fn has_removal_invalidates_the_anchors_child_subject() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
div { background-color: rgb(0, 0, 255) }
#a:has(.t) > #subject { background-color: rgb(255, 0, 0) }
</style></head>
<body>
<div id="a"><div id="subject"><div id="child"><div id="desc"></div></div></div></div>
</body></html>"##;
    for (ref_sel, depth) in [("#child", "before child"), ("#desc", "before descendant")] {
        let dom = DomHandle::new(html, "https://test.example/");
        dom.resolve_layout();
        let subject = dom.query_selector("#subject").unwrap() as u32;
        let reference = dom.query_selector(ref_sel).unwrap() as u32;
        let parent = dom.parent_id(reference) as u32;
        assert_eq!(background(&dom, subject), BLUE, "{depth}: starts unmatched");

        let el = dom.create_element("div");
        dom.set_attribute(el, "class", "t");
        dom.insert_before_node(parent, el, reference);
        dom.resolve_layout();
        assert_eq!(background(&dom, subject), RED, "{depth}: insertion matches");

        dom.remove_node(el);
        dom.resolve_layout();
        assert_eq!(
            background(&dom, subject),
            BLUE,
            "{depth}: removing the .t element must restyle the anchor's subject"
        );
    }
}
