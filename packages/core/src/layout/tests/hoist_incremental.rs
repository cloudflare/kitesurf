// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Incremental layout must retain out-of-flow containing-block claims and viewport-fixed
//! geometry across skipped resolves.

#![cfg(test)]

use crate::DomHandle;

const FULL_PAGE: &str = include_str!("../../../tests_data/radar-page.html");

fn oof_containing_blocks(inc: bool, resolves: usize) -> Vec<(u32, u32)> {
    let dom = DomHandle::new(FULL_PAGE, "https://radar.cloudflare.com/");
    dom.set_viewport(1436, 900);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(inc);
    for _ in 0..resolves {
        dom.resolve_layout();
    }
    dom.test_oof_containing_blocks()
}

const TOGGLE_PAGE: &str = r#"<!doctype html><html><head><style>
 #nav{position:fixed;top:0;left:0;width:300px;height:60px}
 #nav.off{position:static}
 #filler{height:3000px}
</style></head><body><div id="wrap"><div id="nav">nav</div></div>
<div id="filler"></div></body></html>"#;

/// Un-fixing the box must drop the root's claim on it.
#[test]
fn unfixing_a_hoisted_box_detaches_it_from_the_root() {
    let dom = DomHandle::new(TOGGLE_PAGE, "https://example.test/");
    dom.set_viewport(1200, 800);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let root = dom.query_selector("html").unwrap_or(-1) as u32;
    let nav = dom.query_selector("#nav").unwrap_or(-1) as u32;
    let wrap = dom.query_selector("#wrap").unwrap_or(-1) as u32;

    dom.resolve_layout();
    dom.resolve_layout();
    assert_eq!(
        dom.test_containing_block(nav),
        Some(root),
        "fixed box should be hoisted to the root"
    );
    assert!(
        dom.test_layout_children(wrap).contains(&nav),
        "fixed box left its flow parent's layout children"
    );

    dom.set_attribute(nav, "class", "off");
    dom.resolve_layout();
    assert_eq!(
        dom.test_containing_block(nav),
        None,
        "static box is still hoisted to the root"
    );
    assert!(
        dom.test_layout_children(wrap).contains(&nav),
        "static box is not a layout child of its parent"
    );
}

#[test]
fn hoisted_boxes_stay_attached_when_their_parent_is_skipped() {
    let base = oof_containing_blocks(false, 3);
    let inc = oof_containing_blocks(true, 3);

    assert!(!base.is_empty(), "radar should carry hoisted chrome");
    assert_eq!(
        base, inc,
        "incremental layout lost a containing block's claim on a hoisted box"
    );
}

const SCROLL_ANCHOR_PAGE: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0}
 #bar{position:fixed;top:10px;left:20px;width:200px;height:40px}
 #outside{height:20px}
 #filler{height:3000px}
</style></head><body><div id="wrap"><div id="bar">bar</div></div>
<div id="outside">o</div>
<div id="filler"></div></body></html>"#;

/// A fixed box's doc-space rect carries the page scroll once: a resolve
/// that skips the box must not add it again.
#[test]
fn a_skipped_fixed_box_does_not_take_the_scroll_twice() {
    let dom = DomHandle::new(SCROLL_ANCHOR_PAGE, "https://example.test/");
    dom.set_viewport(600, 300);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let bar = dom.query_selector("#bar").unwrap_or(-1) as u32;
    let outside = dom.query_selector("#outside").unwrap_or(-1) as u32;

    dom.resolve_layout();
    dom.resolve_layout();
    let (x, y, ..) = dom.test_get_inline_aware_rect(bar);
    assert_eq!((x, y), (20.0, 10.0), "unscrolled fixed box is misplaced");

    // Rects are document-space, so a viewport-pinned box at top:10 reads
    // 10 + scroll.
    dom.set_page_scroll(0.0, 500.0);
    let (x, y, ..) = dom.test_get_inline_aware_rect(bar);
    assert_eq!((x, y), (20.0, 510.0), "scroll was not anchored");

    dom.set_attribute(outside, "style", "height:24px");
    dom.resolve_layout();
    let (x, y, ..) = dom.test_get_inline_aware_rect(bar);
    assert_eq!(
        (x, y),
        (20.0, 510.0),
        "a resolve that skipped the fixed box re-applied the scroll"
    );
}

/// A fixed box with a z-index paints from the root's stacking context, at
/// the hoisted offset. That offset must cancel the page scroll the scene
/// translates by, or a z-indexed fixed header scrolls away with the page.
#[test]
fn a_z_indexed_fixed_box_paints_pinned_to_the_viewport() {
    let dom = DomHandle::new(
        r#"<!doctype html><body style="margin:0">
<div id="f" style="position:fixed;z-index:5;top:0;width:300px;height:40px"></div>
<div style="height:3000px"></div>"#,
        "https://example.test/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom.set_page_scroll(0.0, 700.0);
    dom.resolve_layout();
    let f = crate::blitz_node_id(dom.query_selector("#f").unwrap() as u32);
    let doc = dom.doc.borrow();
    let base = doc.as_ref();
    let root = base.root_element();
    let position = root
        .stacking_context()
        .and_then(|sc| {
            sc.children
                .iter()
                .find(|child| child.node_id == f)
                .map(|child| child.position(base.tree(), root.id()))
        })
        .expect("the z-indexed fixed box is hoisted into the root's stacking context");
    assert_eq!(position.y, 700.0);
}

const INSET_PAGE: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0}
 #cb{position:relative;width:400px;height:200px}
 #host{width:200px;height:100px}
 #box{position:absolute;top:5px;left:7px;width:50px;height:50px}
</style></head><body>
<div id="cb"><div id="host"><div id="sib">s</div><div id="box">b</div></div></div>
</body></html>"#;

/// An inset write is not box-tree damage, so the box's flow parent can skip
/// its pass. A box whose insets go auto must still drop to its static
/// position, after #sib, while #cb keeps it as an out-of-flow child.
#[test]
fn an_abspos_that_loses_an_inset_falls_back_to_its_static_position() {
    let dom = DomHandle::new(INSET_PAGE, "https://example.test/");
    dom.set_viewport(1200, 800);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let cb = dom.query_selector("#cb").unwrap_or(-1) as u32;
    let sib = dom.query_selector("#sib").unwrap_or(-1) as u32;
    let b = dom.query_selector("#box").unwrap_or(-1) as u32;

    dom.resolve_layout();
    dom.resolve_layout();
    assert_eq!(
        dom.test_containing_block(b),
        Some(cb),
        "abspos box was not hoisted to its containing block"
    );
    let (x, y, ..) = dom.test_get_inline_aware_rect(b);
    assert_eq!((x, y), (7.0, 5.0), "inset box is misplaced");

    dom.set_attribute(b, "style", "top:auto;left:auto");
    dom.resolve_layout();
    let (_, sib_y, _, sib_h) = dom.test_get_inline_aware_rect(sib);
    let (x, y, ..) = dom.test_get_inline_aware_rect(b);
    assert_eq!(
        (x, y),
        (0.0, sib_y + sib_h),
        "auto-inset box did not fall back to its static position"
    );
}

const ZINDEX_PAGE: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0}
 #cb{position:relative;width:400px;height:200px}
 #host{width:200px;height:100px}
 #box{position:absolute;top:5px;left:7px;width:50px;height:50px}
</style></head><body>
<div id="cb"><div id="host"><div id="box">b</div></div></div>
</body></html>"#;

#[test]
fn a_hoisted_abspos_that_grows_a_z_index_loses_its_paint_override() {
    let dom = DomHandle::new(ZINDEX_PAGE, "https://example.test/");
    dom.set_viewport(1200, 800);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let host = dom.query_selector("#host").unwrap_or(-1) as u32;
    let b = dom.query_selector("#box").unwrap_or(-1) as u32;

    dom.resolve_layout();
    dom.resolve_layout();
    assert!(
        dom.test_rehomed_paint_children(host).contains(&b),
        "auto-z abspos box was not re-homed for paint"
    );

    dom.set_attribute(b, "style", "z-index:5");
    dom.resolve_layout();
    assert!(
        !dom.test_rehomed_paint_children(host).contains(&b),
        "z-indexed box kept its paint re-home"
    );
}

const PSEUDO_PAGE: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0}
 #spacer{height:50px}
 #cb{position:relative;padding:10px 30px 10px 40px;width:300px}
 #cb p{margin:0}
 #cb p::before{content:'x';position:absolute;top:-20px;left:3px;width:5px;height:5px}
</style></head><body><div id="spacer"></div>
<div id="cb"><p id="para">text</p></div></body></html>"#;

/// An abspos inline-root child must retain its containing-block claim and root offset.
/// TodoMVC's quote marks exposed the double-counted root offset.
#[test]
fn an_inline_rebuild_does_not_steal_a_hoisted_pseudo() {
    let dom = DomHandle::new(PSEUDO_PAGE, "https://example.test/");
    dom.set_viewport(1200, 800);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let cb = dom.query_selector("#cb").unwrap_or(-1) as u32;
    let para = dom.query_selector("#para").unwrap_or(-1) as u32;
    dom.resolve_layout();
    let pseudo = dom
        .doc
        .borrow()
        .as_ref()
        .get_node(crate::blitz_node_id(para))
        .and_then(|n| n.before())
        .map(crate::wasm_node_id)
        .expect("::before must be generated");

    let expected = (3.0, 30.0);
    // Also hands the pseudo an external handle, which the rect reads need.
    assert!(
        dom.test_oof_containing_blocks().contains(&(pseudo, cb)),
        "abspos pseudo was not hoisted to its containing block"
    );
    let (x, y, ..) = dom.test_get_inline_aware_rect(pseudo);
    assert_eq!((x, y), expected, "wrong on the resolve that constructs it");

    dom.set_attribute(para, "style", "font-weight:bold");
    dom.resolve_layout();
    let (x, y, ..) = dom.test_get_inline_aware_rect(pseudo);
    assert_eq!((x, y), expected, "wrong after an inline reconstruction");
}

/// Structural churn elsewhere makes the root re-collect while #wrap, the
/// fixed box's flow parent, carries no damage. The root's claim must hold.
#[test]
fn clean_owner_still_reoffers_its_hoist_when_the_target_recollects() {
    let dom = DomHandle::new(TOGGLE_PAGE, "https://example.test/");
    dom.set_viewport(1200, 800);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let root = dom.query_selector("html").unwrap_or(-1) as u32;
    let nav = dom.query_selector("#nav").unwrap_or(-1) as u32;
    let body = dom.query_selector("body").unwrap_or(-1) as u32;

    dom.resolve_layout();
    dom.resolve_layout();
    assert_eq!(
        dom.test_containing_block(nav),
        Some(root),
        "fixed box should be hoisted to the root"
    );

    for i in 0..3 {
        let el = dom.create_element("div");
        dom.append_child_node(body, el);
        dom.resolve_layout();
        assert_eq!(
            dom.test_containing_block(nav),
            Some(root),
            "hoisted box lost on structural churn {i}"
        );
    }
}
