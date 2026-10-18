// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn rect_of(html: &str, sel: &str) -> (f32, f32, f32, f32) {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {sel}");
    dom.test_get_inline_aware_rect(id as u32)
}

#[test]
fn abspos_under_body_resolves_against_the_icb() {
    let (x, y, w, h) = rect_of(
        r#"<!DOCTYPE html><div id="t" style="position:absolute;top:8px;left:8px;width:46px;height:46px;border:4px solid blue"></div>"#,
        "#t",
    );
    assert_eq!(
        (x, y),
        (8.0, 8.0),
        "anchored to body content box, not the ICB"
    );
    assert_eq!((w, h), (54.0, 54.0));
}

#[test]
fn abspos_skips_unpositioned_parent_to_positioned_grandparent() {
    let (x, y, _, _) = rect_of(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="position:relative;margin:50px;width:300px;height:300px">
            <div style="padding:30px">
              <div id="t" style="position:absolute;top:10px;left:10px;width:20px;height:20px"></div>
            </div>
          </div>"#,
        "#t",
    );
    assert_eq!(
        (x, y),
        (60.0, 60.0),
        "must anchor to the relative grandparent"
    );
}

#[test]
fn abspos_with_auto_insets_keeps_its_static_position() {
    let (x, y, _, _) = rect_of(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="height:40px"></div>
          <div style="padding-left:25px">
            <div id="t" style="position:absolute;width:20px;height:20px"></div>
          </div>"#,
        "#t",
    );
    assert_eq!((x, y), (25.0, 40.0), "static position lost");
}

#[test]
fn abspos_with_one_axis_auto_is_not_hoisted() {
    let (x, _, _, _) = rect_of(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="padding-left:25px">
            <div id="t" style="position:absolute;top:100px;width:20px;height:20px"></div>
          </div>"#,
        "#t",
    );
    assert_eq!(x, 25.0, "static X sacrificed by a partial hoist");
}

#[test]
fn abspos_inside_positioned_parent_is_untouched() {
    let (x, y, _, _) = rect_of(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="position:relative;margin:30px;width:200px;height:200px">
            <div id="t" style="position:absolute;top:5px;left:5px;width:20px;height:20px"></div>
          </div>"#,
        "#t",
    );
    assert_eq!((x, y), (35.0, 35.0));
}

#[test]
fn fixed_hoist_still_works() {
    let (x, y, _, _) = rect_of(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="position:relative;margin:50px">
            <div id="t" style="position:fixed;top:12px;left:12px;width:20px;height:20px"></div>
          </div>"#,
        "#t",
    );
    assert_eq!((x, y), (12.0, 12.0));
}

#[test]
fn abspos_replaced_svg_derives_block_size_from_aspect_ratio() {
    let dom = crate::DomHandle::new(
        r##"<!DOCTYPE html><style>
          #container { width: 200px; height: 300px; position: relative; }
          #target { position: absolute; top: 0; left: 0; bottom: 0; right: 0; }
        </style>
        <div id="container">
          <svg id="target" viewBox="0 0 50 50"><circle cx="50%" cy="50%" r="50%"/></svg>
        </div>"##,
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom.resolve_layout();
    let id = dom.query_selector("#target").unwrap();
    let (_, _, w, h) = dom.test_get_inline_aware_rect(id as u32);
    assert_eq!(
        (w, h),
        (200.0, 200.0),
        "abspos svg stretched to insets instead of keeping ratio"
    );
}

#[test]
fn abspos_inside_an_unpositioned_inline_fills_the_positioned_ancestor() {
    let html = r#"<!DOCTYPE html><body style="margin:0">
      <div style="position:relative;width:400px;height:300px;margin-top:20px;line-height:1.6">
        <span><div id="t" style="position:absolute;inset:0;width:100%;height:100%"></div></span>
        <div style="height:50px"></div>
      </div>"#;
    for incremental in [false, true] {
        let dom = crate::DomHandle::new(html, "https://example.com/");
        dom.set_viewport(800, 600);
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        dom.resolve_layout();
        dom.resolve_layout();
        let id = dom.query_selector("#t").unwrap();
        assert_eq!(
            dom.test_get_inline_aware_rect(id as u32),
            (0.0, 20.0, 400.0, 300.0),
            "incremental={incremental}"
        );
    }
}

#[test]
fn an_unhoisted_abspos_in_a_span_keeps_its_static_position() {
    let cases = [
        ("auto insets", "", "position:absolute"),
        (
            "positioned root, one inset",
            "position:relative;",
            "position:absolute;top:100%",
        ),
    ];
    for (label, root, target) in cases {
        let html = format!(
            r#"<!DOCTYPE html><body style="margin:0"><div style="{root}font-size:20px;line-height:20px"><span id="text">xxxxx</span><span><b id="t" style="{target}">X</b></span></div>"#
        );
        for incremental in [false, true] {
            let dom = crate::DomHandle::new(&html, "https://example.com/");
            dom.set_viewport(800, 600);
            dom.doc
                .borrow_mut()
                .as_mut()
                .set_incremental_layout(incremental);
            dom.resolve_layout();
            dom.resolve_layout();
            let text = dom.query_selector("#text").unwrap();
            let (text_x, _, text_w, _) = dom.test_get_inline_aware_rect(text as u32);
            let id = dom.query_selector("#t").unwrap();
            let (x, _, _, _) = dom.test_get_inline_aware_rect(id as u32);
            assert!(text_w > 0.0, "{label}: the text has no width");
            assert!(
                (x - (text_x + text_w)).abs() < 1.0,
                "{label} incremental={incremental}: box at x={x}, text ends at {}",
                text_x + text_w
            );
        }
    }
}
