// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A text field with no width of its own is `size` characters wide, 20 by default, counted
//! in the font's average character width as Blink counts them.

#![cfg(test)]

use crate::DomHandle;

// Each field sits alone in a block, where it keeps its own inline width: as a block itself
// it would fill the viewport whatever its size.
const FIELDS: &str = concat!(
    "<!DOCTYPE html><body style=\"margin:0\">",
    "<style>input { padding: 0 2px; border: 1px solid; font: 16px sans-serif }</style>",
    "<div><input id=default></div><div><input id=ten size=10></div>",
    "<div><input id=forty size=40></div><div><input id=zero size=0></div>",
    "<div><input id=word size=abc></div><div><input id=huge size=3000000000></div>",
    "<div style=\"width:200px\"><input id=boxed size=60></div>",
);

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn width(dom: &DomHandle, selector: &str) -> f32 {
    let id = dom.query_selector(selector).unwrap_or(-1);
    assert!(id > 0, "selector must match: {selector}");
    dom.test_get_inline_aware_rect(id as u32).2
}

#[test]
fn a_text_field_is_as_wide_as_its_size_attribute_asks() {
    let dom = laid_out(FIELDS);
    let default = width(&dom, "#default");
    let ten = width(&dom, "#ten");
    let forty = width(&dom, "#forty");
    assert!(
        ten < default && default < forty,
        "{ten} < {default} < {forty}"
    );
    // The content width is `size` average characters plus a constant, so equal steps in size
    // are equal steps in width: 10, 20 and 40 put the default a third of the way up.
    let step = (default - ten) / 10.0;
    assert!(
        ((forty - default) / 20.0 - step).abs() < 0.5,
        "{ten} {default} {forty}"
    );
}

#[test]
fn a_size_html_does_not_accept_falls_back_to_the_default() {
    let dom = laid_out(FIELDS);
    let default = width(&dom, "#default");
    for id in ["#zero", "#word", "#huge"] {
        assert_eq!(width(&dom, id), default, "{id}");
    }
}

#[test]
fn a_text_field_shrinks_into_its_container_borders_included() {
    let dom = laid_out(FIELDS);
    assert_eq!(width(&dom, "#boxed"), 200.0);
}

// Layout reads the attribute outside the style diff, so a change needs its own damage: the
// field kept the width of its first layout.
#[test]
fn a_size_set_after_layout_resizes_the_field() {
    let dom = laid_out(FIELDS);
    let field = dom.query_selector("#default").unwrap() as u32;
    assert!(dom.set_attribute(field, "size", "10"));
    dom.resolve_layout();
    assert_eq!(width(&dom, "#default"), width(&dom, "#ten"));
}
