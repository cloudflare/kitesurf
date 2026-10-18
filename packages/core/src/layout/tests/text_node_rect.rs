// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Text-node geometry backs CDP quad queries; comments still return zero rects.

#![cfg(test)]

use crate::DomHandle;

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

// Chrome and parley both give text the font's content area (ascent +
// descent), centred on the line box, so it can overhang the line-height.
fn assert_on_line(y: f32, h: f32, line_top: f32, line_height: f32) {
    assert!(h > 0.0, "text height {h}");
    let centre = y + h / 2.0;
    let want = line_top + line_height / 2.0;
    assert!(
        (centre - want).abs() <= 1.0,
        "text centre {centre}, line centre {want}"
    );
}

fn first_child(dom: &DomHandle, sel: &str) -> u32 {
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {sel}");
    dom.child_ids(id as u32)[0]
}

#[test]
fn text_node_gets_the_box_of_its_text() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><p id="p" style="margin:0;padding:10px;font:16px/20px sans-serif">hello world</p>"#,
    );
    let text = first_child(&dom, "#p");
    let (x, y, w, h) = dom.test_bounding_rect(text);
    // Starts at the padding edge, sits on the first line, and is
    // narrower than the 780px content box because it covers only glyphs.
    assert_eq!(x, 10.0);
    assert_on_line(y, h, 10.0, 20.0);
    assert!(w > 0.0 && w < 780.0, "text width {w}");
}

#[test]
fn text_node_beside_an_element_covers_only_itself() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><div id="d" style="font:16px/20px sans-serif"><b>bold</b>tail</div>"#,
    );
    let d = dom.query_selector("#d").unwrap() as u32;
    let kids = dom.child_ids(d);
    let (bx, _, bw, _) = dom.test_bounding_rect(kids[0]);
    let (tx, ty, tw, th) = dom.test_bounding_rect(kids[1]);
    assert!(
        tx >= bx + bw - 0.5,
        "tail starts after <b>: {tx} vs {}",
        bx + bw
    );
    assert_on_line(ty, th, 0.0, 20.0);
    assert!(tw > 0.0);
}

#[test]
fn loose_text_in_an_anonymous_block_is_measured() {
    // The text shares a parent with a block, so blitz wraps it in an
    // anonymous block that only the layout chain can see.
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><div id="d" style="font:16px/20px sans-serif">loose<div style="height:30px"></div></div>"#,
    );
    let text = first_child(&dom, "#d");
    let (_, y, w, h) = dom.test_bounding_rect(text);
    assert_on_line(y, h, 0.0, 20.0);
    assert!(w > 0.0);
}

#[test]
fn comment_and_collapsed_text_have_no_box_and_do_not_panic() {
    let dom =
        laid_out(r#"<!DOCTYPE html><body><div id="c"><!-- note --></div><div id="w">   </div>"#);
    assert_eq!(
        dom.test_bounding_rect(first_child(&dom, "#c")),
        (0.0, 0.0, 0.0, 0.0)
    );
    assert_eq!(
        dom.test_bounding_rect(first_child(&dom, "#w")),
        (0.0, 0.0, 0.0, 0.0)
    );
}

#[test]
fn text_under_display_none_keeps_the_boxless_sentinel() {
    let dom = laid_out(r#"<!DOCTYPE html><body><div id="n" style="display:none">hidden</div>"#);
    let (_, _, w, h) = dom.test_bounding_rect(first_child(&dom, "#n"));
    assert_eq!((w, h), (-1.0, -1.0));
}
