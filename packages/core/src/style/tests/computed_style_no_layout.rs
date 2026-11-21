// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

//! A computed-style read must not relayout the document. Scripts poll
//! `getComputedStyle(el).getPropertyValue(...)` in animation loops; paying for
//! style + layout on every poll is what made a 1,600-node page spend 12 s of CPU
//! in 437 reads.

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html><html><head><style>
html { color: rgb(1, 2, 3); }
#box { width: 120px; }
#box.rtl { direction: rtl; }
</style></head><body><div id="box">x</div></body></html>"#;

fn setup() -> (DomHandle, u32, u32) {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let html = dom.query_selector("html").expect("html") as u32;
    let box_id = dom.query_selector("#box").expect("box") as u32;
    (dom, html, box_id)
}

#[test]
fn computed_style_value_does_not_force_layout() {
    let (dom, html, box_id) = setup();
    let epoch = dom.layout_epoch();

    assert_eq!(
        dom.computed_style_value(html, "direction").as_deref(),
        Some("ltr"),
        "direction resolves from the cascade"
    );
    assert_eq!(
        dom.layout_epoch(),
        epoch,
        "a computed-style read on a clean document must not lay out"
    );

    // A mutation dirties the document. The next style read must restyle (the new
    // value is visible) without laying out.
    assert!(dom.set_attribute(box_id, "class", "rtl"));
    assert_eq!(
        dom.computed_style_value(box_id, "direction").as_deref(),
        Some("rtl"),
        "the read sees the post-mutation cascade"
    );
    assert_eq!(
        dom.layout_epoch(),
        epoch,
        "a computed-style read after a mutation must not lay out"
    );

    // The style read left layout dirty, so the next full resolve still lays out.
    dom.resolve_layout();
    assert!(
        dom.layout_epoch() > epoch,
        "the full path must still lay out after a style-only resolve"
    );
}

#[test]
fn computed_custom_property_does_not_force_layout() {
    let (dom, _, box_id) = setup();
    assert!(dom.set_attribute(box_id, "style", "--gap: 12px"));
    dom.resolve_layout();
    let epoch = dom.layout_epoch();

    assert!(dom.set_attribute(box_id, "style", "--gap: 16px"));
    assert_eq!(
        dom.computed_style_value(box_id, "--gap").as_deref(),
        Some("16px")
    );
    assert_eq!(
        dom.layout_epoch(),
        epoch,
        "a custom-property read must not lay out"
    );
}
