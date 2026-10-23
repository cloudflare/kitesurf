// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn hit_within(dom: &DomHandle, x: f32, y: f32, target: i32) -> bool {
    let mut cur = dom.element_from_point(x, y);
    for _ in 0..16 {
        if cur == target {
            return true;
        }
        if cur <= 0 {
            return false;
        }
        cur = dom.parent_id(cur as u32);
    }
    false
}

fn assert_hits(html: &str, selector: &str, x: f32, y: f32) {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(1280, 800);
    dom.resolve_layout();
    let target = dom.query_selector(selector).expect("query parses");
    assert!(target > 0, "{selector} must exist");
    assert!(
        hit_within(&dom, x, y, target),
        "({x},{y}) should hit {selector}; got node #{}",
        dom.element_from_point(x, y),
    );
}

#[test]
fn translated_abspos_box_hits_where_it_paints() {
    assert_hits(
        r#"<!DOCTYPE html><body style="margin:0">
          <div id="t" style="position:absolute;left:0;top:0;transform:translate(600px,200px);width:100px;height:50px"></div>"#,
        "#t",
        650.0,
        225.0,
    );
}

#[test]
fn translated_popup_inside_a_static_portal_hits_where_it_paints() {
    assert_hits(
        r#"<!DOCTYPE html><body style="margin:0">
          <header style="height:57px"></header>
          <div id="portal">
            <div style="position:absolute;left:0;top:0;transform:translate(840px,48px)">
              <div role="menu" style="width:144px">
                <div id="item" style="height:33px">Appearance</div>
              </div>
            </div>
          </div>"#,
        "#item",
        912.0,
        64.0,
    );
}

#[test]
fn popup_after_its_fixed_backdrop_takes_the_hit() {
    let html = r#"<!DOCTYPE html><html style="height:100%"><body style="margin:0;height:100%;overflow:hidden">
          <div id="app" style="height:100%"><header style="height:57px"></header></div>
          <div id="portal">
            <div id="backdrop" role="presentation" style="position:fixed;inset:0;user-select:none"></div>
            <div style="position:absolute;left:0;top:0;transform:translate(840px,48px)">
              <div role="menu" style="width:144px">
                <div id="item" style="height:33px">Appearance</div>
              </div>
            </div>
          </div>"#;
    assert_hits(html, "#item", 912.0, 64.0);
    assert_hits(html, "#backdrop", 300.0, 300.0);
}

#[test]
fn submenu_in_a_nested_portal_takes_the_hit_over_the_backdrop() {
    let html = r#"<!DOCTYPE html><html style="height:100%"><body style="margin:0;height:100%;overflow:hidden">
          <div id="app" style="height:100%"></div>
          <div id="portal">
            <div id="backdrop" style="position:fixed;inset:0"></div>
            <div style="position:absolute;left:0;top:0;transform:translate(1060px,53px)">
              <div role="menu" style="width:204px"><div id="appearance" style="height:33px">Appearance</div></div>
            </div>
            <div id="subportal">
              <div style="position:absolute;left:0;top:0;transform:translate(910px,162px)">
                <div role="menu" style="width:144px"><div id="light" style="height:33px">Light mode</div></div>
              </div>
            </div>
          </div>"#;
    assert_hits(html, "#light", 982.0, 178.0);
    assert_hits(html, "#appearance", 1162.0, 69.0);
    assert_hits(html, "#backdrop", 300.0, 300.0);
}

#[test]
fn z_index_inside_an_isolated_root_stays_under_a_later_popup() {
    let html = r#"<!DOCTYPE html><html style="height:100%"><body style="margin:0;height:100%">
          <div id="app" style="isolation:isolate;height:100%">
            <input id="search" style="position:relative;z-index:1;display:block;margin-top:200px;width:1000px;height:40px">
          </div>
          <div id="portal">
            <div style="position:absolute;left:0;top:0;transform:translate(910px,162px)">
              <div role="menu" style="width:144px"><div style="height:40px"></div><div id="dark" style="height:40px">Dark mode</div></div>
            </div>
          </div>"#;
    assert_hits(html, "#dark", 982.0, 220.0);
    assert_hits(html, "#search", 300.0, 220.0);
}

#[test]
fn transform_written_after_first_layout_moves_the_hit_target() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><body style="margin:0">
          <div id="portal"><div id="pos" style="position:absolute;left:0;top:0"><div id="item" style="width:144px;height:33px"></div></div></div>"#,
        "https://test.example/",
    );
    dom.set_viewport(1000, 600);
    dom.resolve_layout();
    let pos = dom.query_selector("#pos").unwrap();
    let item = dom.query_selector("#item").unwrap();
    assert!(
        hit_within(&dom, 10.0, 10.0, item),
        "untransformed popup hits at the origin"
    );

    dom.set_attribute(
        pos as u32,
        "style",
        "position:absolute;left:0;top:0;transform:translate(840px,48px)",
    );
    dom.resolve_layout();
    assert!(
        hit_within(&dom, 912.0, 64.0, item),
        "translated popup should hit where it paints; got node #{}",
        dom.element_from_point(912.0, 64.0),
    );
    assert!(
        !hit_within(&dom, 10.0, 10.0, item),
        "translated popup must no longer hit at its layout origin",
    );
}

#[test]
fn tiny_invertible_transform_remains_hit_testable() {
    assert_hits(
        r#"
        <!doctype html>
        <html>
          <head>
            <style>
              #target {
                position: absolute;
                top: 0;
                left: 0;
                width: 100px;
                height: 100px;
                transform-origin: 0 0;
                transform: scale(0.000001);
              }
            </style>
          </head>
          <body style="margin: 0"><div id="target"></div></body>
        </html>
        "#,
        "#target",
        0.0000005,
        0.0000005,
    );
    assert_hits(
        r#"
        <!doctype html>
        <html>
          <head>
            <style>
              #target {
                position: absolute;
                top: 0;
                left: 0;
                width: 100px;
                height: 100px;
                transform-origin: 0 0;
                transform: scale(0.00000001);
              }
            </style>
          </head>
          <body style="margin: 0"><div id="target"></div></body>
        </html>
        "#,
        "#target",
        0.0000005,
        0.0000005,
    );
}
