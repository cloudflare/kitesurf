// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; width: 800px; }
  #head { position: sticky; top: 0; height: 60px; background: #eee; }
  #tall { height: 6000px; }
</style></head><body>
<div id="head">header</div><div id="tall">content</div>
</body></html>"#;

fn head_y(dom: &DomHandle, id: u32) -> f32 {
    let doc = dom.doc.borrow();
    doc.as_ref()
        .get_node(crate::blitz_node_id(id))
        .unwrap()
        .final_layout()
        .location
        .y
}

#[test]
fn a_sticky_box_returns_to_its_origin_after_scrolling_away_and_back() {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    let head = dom.query_selector("#head").unwrap() as u32;
    let origin = head_y(&dom, head);

    let tall = dom.query_selector("#tall").unwrap() as u32;
    let mut tick = 0u32;
    let mut nudge = |dom: &DomHandle| {
        tick += 1;
        dom.set_attribute(
            tall,
            "style",
            &format!("background: rgb({}, 0, 0)", tick % 200),
        );
    };

    for y in [600.0, 1800.0, 3000.0, 4200.0] {
        dom.set_page_scroll(0.0, y);
        nudge(&dom);
        dom.resolve_layout();
    }
    let scrolled = head_y(&dom, head);

    for y in [3000.0, 1800.0, 600.0, 0.0] {
        dom.set_page_scroll(0.0, y);
        nudge(&dom);
        dom.resolve_layout();
    }
    let back = head_y(&dom, head);

    assert!(
        scrolled > origin,
        "sticky box should shift down while scrolled: origin={origin} scrolled={scrolled}"
    );
    assert!(
        (back - origin).abs() < 0.5,
        "sticky box must return to its origin: origin={origin} scrolled={scrolled} back={back}"
    );
}

const DEPART_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; width: 800px; }
  #head { position: sticky; top: 0; height: 60px; }
  #cb { height: 400px; }
  #rel { position: relative; top: 25%; height: 20px; }
  #tall { height: 6000px; }
</style></head><body>
<div id="head"></div><div id="cb"><div id="rel"></div></div><div id="tall"></div>
</body></html>"#;

fn departure_dom() -> DomHandle {
    let dom = DomHandle::new(DEPART_PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    dom
}

#[test]
fn a_box_that_stops_being_sticky_gives_its_pin_back() {
    let dom = departure_dom();
    let head = dom.query_selector("#head").unwrap() as u32;
    let origin = head_y(&dom, head);

    dom.set_page_scroll(0.0, 1200.0);
    dom.resolve_layout();
    assert!(
        head_y(&dom, head) > origin,
        "sticky box should be shifted while scrolled"
    );

    dom.set_attribute(head, "style", "position: static");
    dom.resolve_layout();
    assert_eq!(
        head_y(&dom, head),
        origin,
        "a box that left the sticky set kept its pin baked in"
    );
}

#[test]
fn taffy_resolves_and_clears_relative_percentage_insets() {
    let dom = departure_dom();
    let rel = dom.query_selector("#rel").unwrap() as u32;
    let shifted = head_y(&dom, rel);
    assert_eq!(shifted, 100.0, "relative percentage inset resolved twice");

    dom.set_attribute(rel, "style", "top: auto");
    dom.resolve_layout();
    assert_eq!(
        head_y(&dom, rel),
        0.0,
        "top:auto should clear the relative percentage shift"
    );
}

const PIN_PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; width: 800px; }
  #head { position: sticky; top: 0; height: 60px; }
  #fix { position: fixed; top: 10px; height: 20px; }
  #box { height: 400px; position: relative; }
  #rel { position: relative; top: 10%; height: 20px; }
  #tall { height: 6000px; }
</style></head><body>
<div id="head">header</div>
<div id="fix">fixed</div>
<div id="box"><div id="rel">relative</div></div>
<div id="tall">content</div>
</body></html>"#;

#[test]
fn sticky_shift_reports_sticky_shifts_only() {
    let dom = DomHandle::new(PIN_PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    dom.set_page_scroll(0.0, 1200.0);
    dom.resolve_layout();

    let id = |sel: &str| dom.query_selector(sel).unwrap() as u32;
    let pin = |sel: &str| {
        let n = dom.query_selector(sel).unwrap() as u32;
        let doc = dom.doc.borrow();
        let p = doc
            .as_ref()
            .get_node(crate::blitz_node_id(n))
            .unwrap()
            .pin_offset();
        (p.x, p.y)
    };

    assert_ne!(pin("#head").1, 0.0, "sticky must be shifted while scrolled");

    assert_ne!(
        dom.sticky_shift(id("#head"))[1],
        0.0,
        "a sticky node reports its shift"
    );
    assert_eq!(
        dom.sticky_shift(id("#fix")),
        vec![0.0, 0.0],
        "a fixed node's scroll anchor is not a sticky shift"
    );
    assert_eq!(
        dom.sticky_shift(id("#rel")),
        vec![0.0, 0.0],
        "a relative percentage inset is not a sticky shift"
    );
}

#[test]
fn fixed_percentage_height_parent_resolves_inline_child_inset() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; width: 800px; height: 600px }
  #overlay { position: fixed; top: 0; height: 50%; }
  #icon { display: inline-block; position: relative; top: 50%; height: 20px; width: 20px; }
</style></head><body>
<div id="overlay"><span id="icon"></span></div>
</body></html>"#,
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    let icon = dom.query_selector("#icon").unwrap() as u32;
    let doc = dom.doc.borrow();
    let pos = doc
        .as_ref()
        .get_node(crate::blitz_node_id(icon))
        .unwrap()
        .absolute_position(0.0, 0.0);
    drop(doc);
    assert_eq!(
        pos.y, 150.0,
        "inline child percentage inset vs fixed parent height"
    );

    dom.set_attribute(
        icon,
        "style",
        "display: inline-block; position: relative; top: auto; height: 20px; width: 20px",
    );
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let pos = doc
        .as_ref()
        .get_node(crate::blitz_node_id(icon))
        .unwrap()
        .absolute_position(0.0, 0.0);
    drop(doc);
    assert_eq!(
        pos.y, 0.0,
        "removing the relative inset must clear the shift"
    );
}

#[test]
fn fixed_percentage_height_parent_resolves_block_child_inset() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; }
  #overlay { position: fixed; inset: 0; height: 50%; }
  #form { position: relative; top: 50%; height: 40px; }
  #content { height: 4000px; }
</style></head><body>
<div id="overlay"><div id="form"></div></div><div id="content"></div>
</body></html>"#,
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    let form = dom.query_selector("#form").unwrap() as u32;
    let doc = dom.doc.borrow();
    let pos = doc
        .as_ref()
        .get_node(crate::blitz_node_id(form))
        .unwrap()
        .absolute_position(0.0, 0.0);
    drop(doc);
    assert_eq!(
        pos.y, 150.0,
        "block child should resolve against the fixed viewport percentage"
    );
}

#[test]
fn plain_inline_percentage_inset_is_not_shifted() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; font-size: 16px; }
  #b2 { height: 100px; width: 40px; }
</style></head><body>
<div id="b2"><span id="s2" style="position: relative; top: 50%">aaa bbb ccc ddd eee fff ggg hhh</span></div>
</body></html>"#,
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    let doc = dom.doc.borrow();
    let pos = |sel: &str| {
        let id = dom.query_selector(sel).unwrap() as u32;
        let n = doc.as_ref().get_node(crate::blitz_node_id(id)).unwrap();
        n.absolute_position(0.0, 0.0)
    };
    let box2 = pos("#b2");
    let s2 = pos("#s2");
    drop(doc);
    assert!(
        (s2.y - box2.y).abs() < 1.0,
        "plain inline percentage inset must not shift the reported box: box2={:.1} s2={:.1}",
        box2.y,
        s2.y
    );
}

#[test]
fn replaced_inline_percentage_inset_shifts_with_its_box() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; }
  #b { height: 100px; width: 40px; }
</style></head><body>
<div id="b"><canvas id="c" width="20" height="20" style="position: relative; top: 50%"></canvas></div>
</body></html>"#,
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();

    let doc = dom.doc.borrow();
    let pos = |sel: &str| {
        let id = dom.query_selector(sel).unwrap() as u32;
        doc.as_ref()
            .get_node(crate::blitz_node_id(id))
            .unwrap()
            .absolute_position(0.0, 0.0)
    };
    let b = pos("#b");
    let c = pos("#c");
    drop(doc);
    assert!(
        (c.y - (b.y + 50.0)).abs() < 1.0,
        "replaced inline percentage inset must shift: box={:.1} canvas={:.1}",
        b.y,
        c.y
    );
}
