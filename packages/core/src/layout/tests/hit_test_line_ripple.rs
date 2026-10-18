// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A transformed box with a collapsed axis must not be hit, including its descendants.

#![cfg(test)]

use crate::DomHandle;

fn hit_is_within(dom: &DomHandle, x: f32, y: f32, target: u32) -> (bool, i32) {
    let hit = dom.element_from_point(x, y);
    if hit < 0 {
        return (false, hit);
    }
    let mut cur = hit as u32;
    for _ in 0..16 {
        if cur == target {
            return (true, hit);
        }
        match dom.parent_id(cur) {
            p if p < 0 => return (false, hit),
            p => cur = p as u32,
        }
    }
    (false, hit)
}

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(1280, 720);
    dom.resolve_layout();
    dom
}

fn id_of(dom: &DomHandle, sel: &str) -> u32 {
    let id = dom.query_selector(sel).expect("query parses");
    assert!(id > 0, "{sel} must exist");
    id as u32
}

// A singular transform's inverse is non-finite; bounds checks must reject the box.
#[test]
fn a_box_collapsed_by_its_transform_is_never_hit() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0;height:700px">
        <div id="z" style="position:absolute;left:0;top:0;width:100px;height:10px;transform:scaleX(0)"></div>
        <button id="b" style="position:absolute;left:450px;top:480px;width:100px;height:40px">Search</button></body>"#,
    );
    let (z, b) = (id_of(&dom, "#z"), id_of(&dom, "#b"));
    let (ok, hit) = hit_is_within(&dom, 500.0, 500.0, b);
    assert!(ok, "(500,500) should hit the button #{b}, got #{hit}");
    let (inside, hit) = hit_is_within(&dom, 50.0, 5.0, z);
    assert!(
        !inside,
        "(50,5) lies in the collapsed box's untransformed area but must not hit #{z}, got #{hit}"
    );
}

// A hoisted ripple has a page-sized stacking context but still collapses to no hit.
#[test]
fn a_collapsed_line_ripple_does_not_cover_the_page() {
    let dom = laid_out(
        r#"<!DOCTYPE html><html><head><style>
        body { margin: 0; height: 700px; }
        .combo { display: flex; position: relative; width: 137px; height: 36px; margin: 100px 0 0 100px; }
        .rip { display: block; }
        .rip::after, .rip::before { position: absolute; bottom: 0; left: 0; width: 100%; border-bottom-style: solid; content: ""; }
        .rip::before { z-index: 1; border-bottom-width: 1px; }
        .rip::after { transform: scaleX(0); opacity: 0; z-index: 2; border-bottom-width: 2px; }
        .wide { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
        #b { position: absolute; left: 450px; top: 480px; width: 100px; height: 40px; }
        </style></head><body>
        <div class="wide"></div>
        <div class="combo" id="round" role="combobox"><span class="label">Round trip</span><span class="rip"></span></div>
        <button id="b">Search</button></body></html>"#,
    );
    let (round, b) = (id_of(&dom, "#round"), id_of(&dom, "#b"));
    for (name, x, y, target) in [
        ("button", 500.0, 500.0, b),
        ("combobox", 168.5, 118.0, round),
    ] {
        let (ok, hit) = hit_is_within(&dom, x, y, target);
        assert!(ok, "({x},{y}) should hit the {name} #{target}, got #{hit}");
    }
}

// Descendants of a collapsed box are not rendered or hittable.
#[test]
fn nothing_inside_a_collapsed_box_is_hit() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0;height:700px">
        <div style="position:absolute;left:0;top:0;width:100px;height:10px;transform:scaleY(0)">
        <a id="in" href="/x" style="position:absolute;left:450px;top:480px;width:100px;height:40px;display:block">Inside</a></div></body>"#,
    );
    let inside = id_of(&dom, "#in");
    let (ok, hit) = hit_is_within(&dom, 500.0, 500.0, inside);
    assert!(
        !ok,
        "a link inside a scaleY(0) box must not be hit, got #{hit}"
    );
}
