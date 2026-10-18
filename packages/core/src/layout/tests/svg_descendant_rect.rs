// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn rect_of(dom: &DomHandle, selector: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(selector).expect("query parses");
    assert!(id >= 0, "{selector} not found");
    dom.test_get_inline_aware_rect(id as u32)
}

fn assert_rect(got: (f32, f32, f32, f32), want: (f32, f32, f32, f32), what: &str) {
    let close = |a: f32, b: f32| (a - b).abs() <= 0.5;
    assert!(
        close(got.0, want.0)
            && close(got.1, want.1)
            && close(got.2, want.2)
            && close(got.3, want.3),
        "{what}: got {got:?}, want {want:?}"
    );
}

const WPT_HTML: &str = r#"<!DOCTYPE html>
<style>body { margin: 8px }</style>
<svg width="8000" height="8000">
  <rect width="100" height="100" fill="blue" y="1950" id="geometry"/>
  <rect width="100" height="100" fill="blue" transform="translate(0, 2950)" id="translated"/>
  <rect width="100" height="100" fill="blue" transform="rotate(45, 50, 3950)" id="rotated"/>
</svg>"#;

#[test]
fn shape_with_id_reports_its_geometry() {
    let dom = DomHandle::new(WPT_HTML, "https://test.example/");
    dom.resolve_layout();
    assert_rect(
        rect_of(&dom, "#geometry"),
        (8.0, 1958.0, 100.0, 100.0),
        "geometry",
    );
    assert_rect(
        rect_of(&dom, "#translated"),
        (8.0, 2958.0, 100.0, 100.0),
        "translated",
    );
}

#[test]
fn rotated_shape_reports_the_bounds_of_its_transformed_box() {
    let dom = DomHandle::new(WPT_HTML, "https://test.example/");
    dom.resolve_layout();
    let (x, y, w, h) = rect_of(&dom, "#rotated");
    let side = 100.0f32 * std::f32::consts::SQRT_2;
    assert!(
        (w - side).abs() < 0.5 && (h - side).abs() < 0.5,
        "size {w}x{h}"
    );
    let s = std::f32::consts::FRAC_1_SQRT_2;
    let cx = 8.0 + 50.0 + 3900.0 * s;
    let cy = 8.0 + 3950.0 - 3900.0 * s;
    assert!(
        ((x + w / 2.0) - cx).abs() < 0.5,
        "centre x {} want {cx}",
        x + w / 2.0
    );
    assert!(
        ((y + h / 2.0) - cy).abs() < 0.5,
        "centre y {} want {cy}",
        y + h / 2.0
    );
}

#[test]
fn shape_without_id_is_found_through_the_stamped_id() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><style>body { margin: 0 }</style>
        <svg width="300" height="200">
          <g transform="translate(20, 30)">
            <circle cx="50" cy="50" r="40"/>
          </g>
        </svg>"#,
        "https://test.example/",
    );
    dom.resolve_layout();
    assert_rect(rect_of(&dom, "circle"), (30.0, 40.0, 80.0, 80.0), "circle");
    assert_rect(rect_of(&dom, "g"), (30.0, 40.0, 80.0, 80.0), "g");
}

#[test]
fn viewbox_scales_user_units_into_the_content_box() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><style>body { margin: 0 }</style>
        <svg width="200" height="200" viewBox="0 0 100 100">
          <rect x="10" y="20" width="30" height="40"/>
        </svg>"#,
        "https://test.example/",
    );
    dom.resolve_layout();
    assert_rect(rect_of(&dom, "rect"), (20.0, 40.0, 60.0, 80.0), "rect");
}

#[test]
fn flattened_wrapper_unions_its_children() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><style>body { margin: 0 }</style>
        <svg width="300" height="300">
          <a href="#x">
            <rect x="10" y="10" width="20" height="20"/>
            <rect x="100" y="150" width="50" height="50"/>
          </a>
        </svg>"##,
        "https://test.example/",
    );
    dom.resolve_layout();
    assert_rect(rect_of(&dom, "a"), (10.0, 10.0, 140.0, 190.0), "a");
}

#[test]
fn identical_icons_at_different_positions_measure_independently() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><style>body { margin: 0 } svg { display: block }</style>
        <svg width="50" height="50"><path d="M10 10h20v20h-20z"/></svg>
        <svg width="50" height="50"><path d="M10 10h20v20h-20z"/></svg>"#,
        "https://test.example/",
    );
    dom.resolve_layout();
    let first = dom
        .query_selector("svg:first-of-type path")
        .expect("query parses");
    let second = dom
        .query_selector("svg:last-of-type path")
        .expect("query parses");
    assert_rect(
        dom.test_get_inline_aware_rect(first as u32),
        (10.0, 10.0, 20.0, 20.0),
        "first",
    );
    assert_rect(
        dom.test_get_inline_aware_rect(second as u32),
        (10.0, 60.0, 20.0, 20.0),
        "second",
    );
}

#[test]
fn shape_usvg_dropped_reports_no_box() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html>
        <svg width="100" height="100">
          <defs><rect id="hidden" width="10" height="10"/></defs>
        </svg>"#,
        "https://test.example/",
    );
    dom.resolve_layout();
    assert_eq!(rect_of(&dom, "#hidden"), (0.0, 0.0, 0.0, 0.0));
}
