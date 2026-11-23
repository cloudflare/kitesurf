// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

//! Child-list changes must restyle only what a child-list-dependent selector can
//! match. The selector flags recorded during matching decide that; these tests
//! cover each flag family so a missing one shows up as a stale colour.

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html><html><head><style>
#first:first-child { color: rgb(1, 1, 1); }
#last:last-child { color: rgb(2, 2, 2); }
.nth:nth-child(2n) { color: rgb(3, 3, 3); }
.a + .b { color: rgb(4, 4, 4); }
.a ~ .c { color: rgb(5, 5, 5); }
#empty:empty { color: rgb(6, 6, 6); }
#has:has(> .x) { color: rgb(7, 7, 7); }
</style></head><body>
<div id="first">first</div>
<p id="u">unrelated</p>
<div class="nth" id="n1">n1</div>
<div class="nth" id="n2">n2</div>
<div class="a" id="a">a</div>
<div class="b" id="b">b</div>
<div class="c" id="c">c</div>
<div id="empty"></div>
<div id="has"></div>
<div id="last">last</div>
</body></html>"#;

const SIMPLE_PAGE: &str = r#"<!DOCTYPE html><html><head><style>
#u { color: rgb(8, 8, 8); }
</style></head><body><p id="u">unrelated</p></body></html>"#;

fn setup() -> DomHandle {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn setup_simple() -> DomHandle {
    let dom = DomHandle::new(SIMPLE_PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn id(dom: &DomHandle, selector: &str) -> u32 {
    dom.query_selector(selector).expect(selector) as u32
}

fn color(dom: &DomHandle, selector: &str) -> String {
    dom.computed_style_value(id(dom, selector), "color")
        .unwrap_or_default()
}

fn style_ptr(dom: &DomHandle, selector: &str) -> *const () {
    let node_id = crate::blitz_node_id(id(dom, selector));
    let kept = {
        let doc = dom.doc.borrow();
        let node = doc.get_node(node_id).expect("node exists");
        node.primary_styles().map(|styles| (*styles).clone())
    };
    match kept {
        Some(styles) => {
            // Keep the old value alive so the allocator cannot reuse its address.
            let leaked: &'static _ = Box::leak(Box::new(styles));
            &**leaked as *const _ as *const ()
        }
        None => std::ptr::null(),
    }
}

fn div(dom: &DomHandle, class: &str) -> u32 {
    let node = dom.create_element("div");
    if !class.is_empty() {
        dom.set_attribute(node, "class", class);
    }
    node
}

#[test]
fn appending_under_body_keeps_unrelated_styles() {
    let dom = setup_simple();
    let _ = color(&dom, "#u");
    let idle = style_ptr(&dom, "#u");
    let _ = color(&dom, "#u");
    assert_eq!(
        idle,
        style_ptr(&dom, "#u"),
        "an idle read must not change style identity"
    );
    let before = style_ptr(&dom, "#u");

    let body = id(&dom, "body");
    let added = div(&dom, "plain");
    assert!(dom.append_child_node(body, added));
    let _ = color(&dom, "#u");

    assert_eq!(
        before,
        style_ptr(&dom, "#u"),
        "a plain append must not restyle unrelated body descendants"
    );
}

const HAS_PAGE: &str = r#"<!DOCTYPE html><html><head><style>
#u { color: rgb(8, 8, 8); }
.a:has(+ .b) { color: rgb(9, 9, 9); }
.p:has(> .x) { color: rgb(10, 10, 10); }
</style></head><body><p id="u">unrelated</p><div id="tail"></div></body></html>"#;

/// Inserting or removing a plain child of a parent whose children no `:has()` reads must not
/// recascade the parent's other children, even when the document has sibling and child `:has()`.
#[test]
fn child_list_changes_under_has_keep_unrelated_styles() {
    let dom = DomHandle::new(HAS_PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let body = id(&dom, "body");

    let _ = color(&dom, "#u");
    let before = style_ptr(&dom, "#u");
    let added = div(&dom, "plain");
    assert!(dom.append_child_node(body, added));
    let _ = color(&dom, "#u");
    assert_eq!(
        before,
        style_ptr(&dom, "#u"),
        "an append restyled an unrelated sibling"
    );

    let before = style_ptr(&dom, "#u");
    assert!(dom.remove_node(added));
    let _ = color(&dom, "#u");
    assert_eq!(
        before,
        style_ptr(&dom, "#u"),
        "a removal restyled an unrelated sibling"
    );

    let before = style_ptr(&dom, "#u");
    let moved = div(&dom, "plain");
    assert!(dom.append_child_node(id(&dom, "#tail"), moved));
    let _ = color(&dom, "#u");
    let before_move = style_ptr(&dom, "#u");
    assert_eq!(before, before_move, "an append into a sibling restyled #u");
    assert!(dom.append_child_node(body, moved));
    let _ = color(&dom, "#u");
    assert_eq!(
        before_move,
        style_ptr(&dom, "#u"),
        "a move restyled an unrelated sibling"
    );
}

#[test]
fn first_child_updates_after_insert_before() {
    let dom = setup();
    assert_eq!(color(&dom, "#first"), "rgb(1, 1, 1)");

    let body = id(&dom, "body");
    let added = div(&dom, "");
    assert!(dom.insert_before_node(body, added, id(&dom, "#first")));

    assert_ne!(color(&dom, "#first"), "rgb(1, 1, 1)");
}

#[test]
fn last_child_updates_after_append() {
    let dom = setup();
    assert_eq!(color(&dom, "#last"), "rgb(2, 2, 2)");

    let body = id(&dom, "body");
    let added = div(&dom, "");
    assert!(dom.append_child_node(body, added));

    assert_ne!(color(&dom, "#last"), "rgb(2, 2, 2)");
}

#[test]
fn nth_child_updates_after_insert() {
    let dom = setup();
    assert_eq!(color(&dom, "#n2"), "rgb(3, 3, 3)");
    let body = id(&dom, "body");
    let added = div(&dom, "");
    assert!(dom.insert_before_node(body, added, id(&dom, "#n2")));

    assert_ne!(color(&dom, "#n2"), "rgb(3, 3, 3)");
}

#[test]
fn adjacent_sibling_updates_after_insert_between() {
    let dom = setup();
    assert_eq!(color(&dom, "#b"), "rgb(4, 4, 4)");

    let body = id(&dom, "body");
    let added = div(&dom, "");
    assert!(dom.insert_before_node(body, added, id(&dom, "#b")));

    assert_ne!(color(&dom, "#b"), "rgb(4, 4, 4)");
}

#[test]
fn general_sibling_updates_after_removal() {
    let dom = setup();
    assert_eq!(color(&dom, "#c"), "rgb(5, 5, 5)");

    assert!(dom.remove_node(id(&dom, "#a")));

    assert_ne!(color(&dom, "#c"), "rgb(5, 5, 5)");
}

#[test]
fn empty_updates_after_append() {
    let dom = setup();
    assert_eq!(color(&dom, "#empty"), "rgb(6, 6, 6)");

    let added = div(&dom, "");
    assert!(dom.append_child_node(id(&dom, "#empty"), added));

    assert_ne!(color(&dom, "#empty"), "rgb(6, 6, 6)");
}

#[test]
fn has_updates_after_append() {
    let dom = setup();
    assert_ne!(color(&dom, "#has"), "rgb(7, 7, 7)");

    let added = div(&dom, "x");
    assert!(dom.append_child_node(id(&dom, "#has"), added));

    assert_eq!(color(&dom, "#has"), "rgb(7, 7, 7)");
}

#[test]
fn has_updates_after_removal() {
    let dom = setup();
    let added = div(&dom, "x");
    assert!(dom.append_child_node(id(&dom, "#has"), added));
    assert_eq!(color(&dom, "#has"), "rgb(7, 7, 7)");

    assert!(dom.remove_node(added));

    assert_ne!(color(&dom, "#has"), "rgb(7, 7, 7)");
}

#[test]
fn has_adjacent_sibling_and_only_child_update_on_child_list_mutations() {
    let html = r#"<!doctype html><style>
        #p { color: rgb(0, 128, 0); }
        #p:has(> .a + .b) { color: rgb(255, 0, 0); }
        #q { color: rgb(0, 128, 0); }
        #q:has(> .a:only-child) { color: rgb(255, 0, 0); }
    </style>
    <div id="p"><span class="a"></span><span class="b"></span></div>
    <div id="q"><span class="a"></span><span id="q2" class="b"></span></div>"#;
    let dom = DomHandle::new(html, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    assert_eq!(color(&dom, "#p"), "rgb(255, 0, 0)");
    let spacer = dom.create_element("span");
    dom.insert_before_node(id(&dom, "#p"), spacer, id(&dom, "#p > .b"));
    assert_eq!(color(&dom, "#p"), "rgb(0, 128, 0)");

    assert_eq!(color(&dom, "#q"), "rgb(0, 128, 0)");
    assert!(dom.remove_node(id(&dom, "#q2")));
    assert_eq!(color(&dom, "#q"), "rgb(255, 0, 0)");
}

#[test]
fn appending_under_a_body_has_anchor_keeps_unrelated_styles() {
    let html = r#"<!doctype html><style>
        #u { color: rgb(8, 8, 8); }
        body:has(> .banner) { outline: 1px solid rgb(1, 2, 3); }
    </style><body><p id="u">unrelated</p></body>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let body = id(&dom, "body");
    let _ = color(&dom, "#u");
    let before = style_ptr(&dom, "#u");

    let added = div(&dom, "plain");
    assert!(dom.append_child_node(body, added));
    let _ = color(&dom, "#u");

    assert_eq!(
        before,
        style_ptr(&dom, "#u"),
        "a body :has() anchor must not recascade unrelated descendants"
    );
}

#[test]
fn body_has_non_subject_insert_between_keeps_unrelated_styles() {
    // `body` carries ANCHORS_RELATIVE_SELECTOR_NON_SUBJECT for any non-subject `:has()`, even
    // without a sibling combinator inside it. An insert between two elements must not walk up to
    // that anchor and restyle the whole document.
    let html = r#"<!doctype html><style>
        #u { color: rgb(8, 8, 8); }
        body:has(.modal) .x { color: rgb(255, 0, 0); }
    </style>
    <body><div id="list"><p id="one">1</p><p id="two">2</p></div><p id="u">unrelated</p><i class="x"></i></body>"#;
    let dom = DomHandle::new(html, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let _ = color(&dom, "#u");
    let before = style_ptr(&dom, "#u");
    let added = div(&dom, "plain");
    assert!(dom.insert_before_node(id(&dom, "#list"), added, id(&dom, "#two")));
    let _ = color(&dom, "#u");
    assert_eq!(
        before,
        style_ptr(&dom, "#u"),
        "a body :has() anchor must not recascade the document on an insert between elements"
    );
}

#[test]
fn is_pseudo_sibling_in_has_updates_on_middle_removal() {
    let html = r#"<!doctype html><style>
        #c > div { background-color: rgb(0, 128, 0); }
        #t9:has(:is(:where(:is(.item + .item + .item) > .child) + .child + .child)) { background-color: rgb(255, 0, 0); }
        .item + .item + .item {
            #t19:has(:is(& > .child + .child + .child)) { background-color: rgb(255, 0, 0); }
        }
        .item + .item + .item > .child {
            #t20:has(:is(& + .child + .child)) { background-color: rgb(255, 0, 0); }
        }
    </style><div id="c">
        <div id="t9"><div class="item"></div><div class="item" id="i9"></div><div class="item"><span class="child"></span><span class="child"></span><span class="child"></span></div></div>
        <div id="t19"><div class="item"></div><div class="item" id="i19"></div><div class="item"><span class="child"></span><span class="child"></span><span class="child"></span></div></div>
        <div id="t20"><div class="item"></div><div class="item" id="i20"></div><div class="item"><span class="child"></span><span class="child"></span><span class="child"></span></div></div>
    </div>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    for (target, item) in [("#t9", "#i9"), ("#t19", "#i19"), ("#t20", "#i20")] {
        assert_eq!(
            dom.computed_style_value(id(&dom, target), "background-color")
                .as_deref(),
            Some("rgb(255, 0, 0)"),
            "{target} initially red"
        );
        assert!(dom.remove_node(id(&dom, item)));
        assert_eq!(
            dom.computed_style_value(id(&dom, target), "background-color")
                .as_deref(),
            Some("rgb(0, 128, 0)"),
            "{target} updates to green after middle sibling removal"
        );
    }
}

#[test]
fn non_subject_has_adjacent_sibling_updates_on_insert_between() {
    // The anchor is not the subject here: `.y` is. Re-matching the anchor alone leaves `.y`
    // with the style from the previous match, because nothing reaches it.
    let html = r#"<!doctype html><style>
        .y { color: rgb(0, 128, 0); }
        .p:has(> .a + .b) .y { color: rgb(255, 0, 0); }
    </style>
    <div class="p"><i class="y" id="y"></i><span class="a"></span><span class="b" id="b"></span></div>"#;
    let dom = DomHandle::new(html, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    assert_eq!(color(&dom, "#y"), "rgb(255, 0, 0)");
    let spacer = dom.create_element("span");
    assert!(dom.insert_before_node(id(&dom, ".p"), spacer, id(&dom, "#b")));
    assert_eq!(color(&dom, "#y"), "rgb(0, 128, 0)");
}

#[test]
fn non_subject_has_descendant_adjacent_sibling_updates_on_insert_between() {
    // Same, with the anchor above the inserted node's parent (`.p:has(.a + .b) .y`).
    let html = r#"<!doctype html><style>
        .y { color: rgb(0, 128, 0); }
        .p:has(.a + .b) .y { color: rgb(255, 0, 0); }
    </style>
    <div class="p"><div class="w"><i class="y" id="y"></i><span class="a"></span><span class="b" id="b"></span></div></div>"#;
    let dom = DomHandle::new(html, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    assert_eq!(color(&dom, "#y"), "rgb(255, 0, 0)");
    let spacer = dom.create_element("span");
    assert!(dom.insert_before_node(id(&dom, ".w"), spacer, id(&dom, "#b")));
    assert_eq!(color(&dom, "#y"), "rgb(0, 128, 0)");
}
