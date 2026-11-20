// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; width: 800px; font: 16px/1.2 monospace; }
  .theme p::before { content: "A-"; }
  .theme.alt p::before { content: "B-"; }
  .inl { display: inline; }
</style></head><body>
<div id="root" class="theme">
  <div id="wrap">
    <p id="para">lead in <span class="inl" id="tail">tail text</span> trailing</p>
  </div>
</div>
</body></html>"#;

fn setup() -> DomHandle {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    dom
}

fn rect(dom: &DomHandle, sel: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(sel).unwrap() as u32;
    dom.test_get_inline_aware_rect(id)
}

#[test]
fn construct_damage_under_a_warm_ancestor_keeps_its_lines() {
    let dom = setup();
    let before = rect(&dom, "#tail");
    assert!(
        before.2 > 0.0 && before.3 > 0.0,
        "precondition: inline span should have a bbox from parley span fragments, got {before:?}"
    );

    let root = dom.query_selector("#root").unwrap() as u32;
    dom.set_attribute(root, "class", "theme alt");
    dom.resolve_layout();

    let after = rect(&dom, "#tail");
    assert!(
        after.2 > 0.0 && after.3 > 0.0,
        "inline span lost its lines after a construct-only rebuild; \
         the paragraph is sized but blank (got {after:?}, was {before:?})"
    );
}

#[test]
fn construct_damage_under_a_warm_ancestor_keeps_its_height() {
    let dom = setup();
    let before = rect(&dom, "#para").3;
    assert!(before > 0.0, "precondition: paragraph has height");

    let root = dom.query_selector("#root").unwrap() as u32;
    dom.set_attribute(root, "class", "theme alt");
    dom.resolve_layout();

    let after = rect(&dom, "#para").3;
    assert!(
        (after - before).abs() < 0.5,
        "paragraph height changed after a construct-only rebuild: {before} -> {after}"
    );
}

#[test]
fn panic_recovery_rebuilds_a_stranded_inline_root() {
    let dom = setup();
    let para = dom
        .resolve_node_id(dom.query_selector("#para").unwrap() as u32)
        .expect("node handle is live");
    let before = rect(&dom, "#para").3;

    {
        let mut doc = dom.doc.borrow_mut();
        let node = doc.as_mut().get_node_mut(para).unwrap();
        assert!(node.flags.is_inline_root());
        assert!(
            node.data
                .downcast_element_mut()
                .unwrap()
                .take_inline_layout_data()
                .is_some(),
            "precondition: inline layout exists before the simulated unwind"
        );
        doc.as_mut().recover_from_layout_panic();
    }
    dom.layout_dirty.set(true);
    dom.resolve_layout();

    let after = rect(&dom, "#para").3;
    assert!(
        after > 0.0 && (after - before).abs() < 0.5,
        "stranded inline root was not reconstructed: {before} -> {after}"
    );
}
