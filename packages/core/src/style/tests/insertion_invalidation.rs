// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Inserting a child restyles only the siblings whose structural selectors can change.

#![cfg(test)]

use crate::DomHandle;

const RED: &str = "rgb(255, 0, 0)";
const GREEN: &str = "rgb(0, 128, 0)";

fn styled(css: &str, body: &str) -> DomHandle {
    let html = format!("<!DOCTYPE html><style>{css}</style><body>{body}");
    let dom = DomHandle::new(&html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn id(dom: &DomHandle, selector: &str) -> u32 {
    let id = dom.query_selector(selector).expect("query ok");
    assert!(id > 0, "{selector} found");
    id as u32
}

fn color(dom: &DomHandle, node: u32) -> String {
    dom.computed_style_value(node, "color").expect("color")
}

fn insert_li(dom: &DomHandle, parent: u32, before: Option<u32>) -> u32 {
    let li = dom.create_element("li");
    let inserted = match before {
        Some(reference) => dom.insert_before_node(parent, li, reference),
        None => dom.append_child_node(parent, li),
    };
    assert!(inserted);
    li
}

#[test]
fn prepend_restyles_the_old_first_child() {
    let dom = styled(
        "li { color: red } li:first-child { color: green }",
        r#"<ul id="u"><li id="a">a</li><li id="b">b</li></ul>"#,
    );
    let (u, a) = (id(&dom, "#u"), id(&dom, "#a"));
    assert_eq!(color(&dom, a), GREEN);
    let li = insert_li(&dom, u, Some(a));
    assert_eq!(color(&dom, li), GREEN);
    assert_eq!(color(&dom, a), RED);
}

#[test]
fn append_restyles_the_old_last_child() {
    let dom = styled(
        "li { color: red } li:last-child { color: green }",
        r#"<ul id="u"><li id="a">a</li><li id="b">b</li></ul>"#,
    );
    let (u, b) = (id(&dom, "#u"), id(&dom, "#b"));
    assert_eq!(color(&dom, b), GREEN);
    let li = insert_li(&dom, u, None);
    assert_eq!(color(&dom, li), GREEN);
    assert_eq!(color(&dom, b), RED);
}

#[test]
fn prepend_restyles_later_siblings_and_their_descendants() {
    let dom = styled(
        "span { color: red } li + li span, li:nth-child(3) > span { color: green }",
        r#"<ul id="u"><li id="a"><span id="sa">a</span></li><li id="b"><span id="sb">b</span></li></ul>"#,
    );
    let (u, a) = (id(&dom, "#u"), id(&dom, "#a"));
    let (sa, sb) = (id(&dom, "#sa"), id(&dom, "#sb"));
    assert_eq!(color(&dom, sa), RED);
    insert_li(&dom, u, Some(a));
    assert_eq!(
        color(&dom, sa),
        GREEN,
        "`li + li` now matches the old first child"
    );
    assert_eq!(
        color(&dom, sb),
        GREEN,
        "`:nth-child(3)` now matches the old second child"
    );
}

#[test]
fn append_restyles_every_child_for_from_end_selectors() {
    let dom = styled(
        "li { color: red } li:nth-last-child(3) { color: green }",
        r#"<ul id="u"><li id="a">a</li><li id="b">b</li></ul>"#,
    );
    let (u, a) = (id(&dom, "#u"), id(&dom, "#a"));
    assert_eq!(color(&dom, a), RED);
    insert_li(&dom, u, None);
    assert_eq!(color(&dom, a), GREEN);
}

#[test]
fn first_insertion_restyles_an_empty_parent() {
    let dom = styled(
        "ul { color: red } ul:empty { color: green }",
        r#"<ul id="u"></ul>"#,
    );
    let u = id(&dom, "#u");
    assert_eq!(color(&dom, u), GREEN);
    insert_li(&dom, u, None);
    assert_eq!(color(&dom, u), RED);
}

#[test]
fn reinserted_element_inherits_from_its_new_parent() {
    let dom = styled(
        "#p { color: red } #q { color: green }",
        r#"<div id="p"><span id="s">s</span></div><div id="q"></div>"#,
    );
    let (q, s) = (id(&dom, "#q"), id(&dom, "#s"));
    assert_eq!(color(&dom, s), RED);
    assert!(dom.append_child_node(q, s));
    assert_eq!(color(&dom, s), GREEN);
}

#[test]
fn appending_a_sibling_restyles_an_earlier_has_anchor() {
    let dom = styled(
        ".a { color: red } .a:has(+ .b) { color: green }",
        r#"<div id="p"><span class="a" id="a">a</span></div>"#,
    );
    let (p, a) = (id(&dom, "#p"), id(&dom, "#a"));
    assert_eq!(color(&dom, a), RED);
    let b = dom.create_element("i");
    assert!(dom.set_attribute(b, "class", "b"));
    assert!(dom.append_child_node(p, b));
    assert_eq!(color(&dom, a), GREEN);
}

#[test]
fn appending_a_later_sibling_restyles_an_earlier_has_tilde_anchor() {
    let dom = styled(
        ".a { color: red } .a:has(~ .b) { color: green }",
        r#"<div id="p"><span class="a" id="a">a</span></div>"#,
    );
    let (p, a) = (id(&dom, "#p"), id(&dom, "#a"));
    assert_eq!(color(&dom, a), RED);
    let b = dom.create_element("i");
    assert!(dom.set_attribute(b, "class", "b"));
    assert!(dom.append_child_node(p, b));
    assert_eq!(color(&dom, a), GREEN);
}
