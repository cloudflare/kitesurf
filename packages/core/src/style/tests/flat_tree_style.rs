// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! An unstyled element gets an on-demand style only inside a `display: none` subtree.

#![cfg(test)]

use crate::DomHandle;

#[test]
fn slot_fallback_beside_assigned_nodes_has_no_computed_style() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><div id=host>slotted</div><div style=display:none><p id=hidden>x</p></div>",
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    let host = dom.query_selector("#host").unwrap() as u32;
    let hidden = dom.query_selector("#hidden").unwrap() as u32;
    let root = dom.attach_shadow(host, "open") as u32;
    dom.apply_ops(&format!(
        r#"[{{"kind":"setInnerHtml","node":{root},"html":"<slot><b id=fallback>x</b></slot>"}}]"#
    ))
    .unwrap();
    let fallback = dom
        .query_selector_all_in_subtree(root, "#fallback")
        .unwrap()[0] as u32;
    dom.resolve_layout();

    assert_eq!(dom.computed_style_value(fallback, "direction"), None);
    assert_eq!(
        dom.computed_style_value(hidden, "display"),
        Some("block".into())
    );
}

#[test]
fn slotted_element_under_a_hidden_slot_container_keeps_its_computed_style() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><div id=host><span id=slotted>x</span></div>",
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    let host = dom.query_selector("#host").unwrap() as u32;
    let slotted = dom.query_selector("#slotted").unwrap() as u32;
    let root = dom.attach_shadow(host, "open") as u32;
    dom.apply_ops(&format!(
        r#"[{{"kind":"setInnerHtml","node":{root},"html":"<div style=display:none><slot></slot></div>"}}]"#
    ))
    .unwrap();
    dom.resolve_layout();

    assert_eq!(
        dom.computed_style_value(slotted, "display"),
        Some("inline".into())
    );
}
