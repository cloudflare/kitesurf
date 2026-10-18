// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  .theme p::before { content: "A-"; }
  .theme.alt p::before { content: "B-"; }
  body { margin: 0; font: 16px/1.2 monospace; }
</style></head><body>
<div id="root" class="theme">
  <section><article><p>one</p></article></section>
  <div class="deep"><section><article id="anc"><span id="buried">x</span></article></section></div>
</div>
<div id="other"><p>untouched</p></div>
</body></html>"#;

fn setup() -> DomHandle {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    dom
}

fn height(dom: &DomHandle, sel: &str) -> f32 {
    let id = dom.query_selector(sel).unwrap() as u32;
    dom.test_get_inline_aware_rect(id).3
}

#[test]
fn deep_mutation_reflows_undamaged_ancestors() {
    let dom = setup();
    let before = height(&dom, "#anc");
    let root_before = height(&dom, "#root");

    let span = dom.query_selector("#buried").unwrap() as u32;
    dom.set_attribute(span, "style", "font-size: 80px");
    dom.resolve_layout();

    let after = height(&dom, "#anc");
    let root_after = height(&dom, "#root");
    assert!(
        after > before + 10.0,
        "undamaged ancestor must reflow: {before} -> {after}"
    );
    assert!(
        root_after > root_before + 10.0,
        "reflow must reach the root: {root_before} -> {root_after}"
    );
}

#[test]
fn pseudo_restyle_survives_the_skip() {
    let dom = setup();
    let txt = dom.debug_dump_inline_layouts();
    assert!(txt.contains("A-"), "baseline pseudo: {txt}");

    let root = dom.query_selector("#root").unwrap() as u32;
    dom.set_attribute(root, "class", "theme alt");
    dom.resolve_layout();
    let txt = dom.debug_dump_inline_layouts();
    assert!(
        txt.contains("B-"),
        "pseudo must restyle through skip: {txt}"
    );
}

#[test]
fn repeated_clean_resolves_are_stable() {
    let dom = setup();
    let first = dom.render_scene(0, 0, 0, 0, false, true);
    for _ in 0..4 {
        dom.resolve_layout();
    }
    let again = dom.render_scene(0, 0, 0, 0, false, true);
    assert_eq!(first, again, "undamaged resolves must not change the scene");
}
