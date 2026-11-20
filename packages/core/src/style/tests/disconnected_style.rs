// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

//! A `<style>` element that is not connected has no sheet (HTML "update a `style` block"), so
//! writing its text must neither apply its rules nor change the document's stylesheet set,
//! which would recascade every element on the next style read.

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html><html><head></head>
<body><p id="u">unrelated</p><p id="t" class="t">target</p></body></html>"#;

const SHEET: &str = ".t { color: rgb(9, 9, 9); }";

fn setup() -> (DomHandle, u32, u32) {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let u = dom.query_selector("#u").expect("u") as u32;
    let t = dom.query_selector("#t").expect("t") as u32;
    (dom, u, t)
}

/// Identity of the element's computed values. The old Arc is leaked so the allocator cannot
/// hand its address to a restyled value: a changed pointer means the element was recascaded.
fn style_ptr(dom: &DomHandle, id: u32) -> *const () {
    let kept = {
        let doc = dom.doc.borrow();
        let node = doc.get_node(crate::blitz_node_id(id)).expect("node exists");
        node.primary_styles().map(|styles| (*styles).clone())
    };
    match kept {
        Some(styles) => {
            let leaked: &'static _ = Box::leak(Box::new(styles));
            &**leaked as *const _ as *const ()
        }
        None => std::ptr::null(),
    }
}

fn color(dom: &DomHandle, id: u32) -> String {
    dom.computed_style_value(id, "color").unwrap_or_default()
}

/// A detached `<noscript><style>` subtree, its text written while detached.
fn detached_style(dom: &DomHandle) -> u32 {
    let noscript = dom.create_element("noscript");
    let style = dom.create_element("style");
    assert!(dom.append_child_node(noscript, style));
    assert!(dom.set_node_text(style, SHEET));
    style
}

#[test]
fn detached_style_text_neither_applies_nor_restyles() {
    let (dom, u, t) = setup();
    let base = color(&dom, t);
    let before = style_ptr(&dom, u);

    let _ = detached_style(&dom);
    let _ = dom.create_element("div");
    assert_eq!(color(&dom, t), base, "a detached sheet applied");
    assert_eq!(
        before,
        style_ptr(&dom, u),
        "a detached sheet recascaded the document"
    );

    let lone = dom.create_element("style");
    let text = dom.create_text_node(SHEET);
    assert!(dom.append_child_node(lone, text));
    assert_eq!(
        color(&dom, t),
        base,
        "a detached sheet built by appending text applied"
    );
    assert_eq!(
        before,
        style_ptr(&dom, u),
        "appending text to a detached style restyled"
    );
}

#[test]
fn detached_style_applies_once_connected_and_stops_when_removed() {
    let (dom, _, t) = setup();
    let base = color(&dom, t);
    let style = detached_style(&dom);
    let head = dom.query_selector("head").expect("head") as u32;

    assert!(dom.append_child_node(head, style));
    assert_eq!(color(&dom, t), "rgb(9, 9, 9)", "a connected style applies");

    assert!(dom.remove_node(style));
    assert_eq!(color(&dom, t), base, "a removed style stops applying");

    assert!(dom.set_node_text(style, ".t { color: rgb(7, 7, 7); }"));
    assert_eq!(color(&dom, t), base, "text written after removal applied");

    assert!(dom.append_child_node(head, style));
    assert_eq!(
        color(&dom, t),
        "rgb(7, 7, 7)",
        "reconnecting applies the current text"
    );
}
