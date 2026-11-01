// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Table cells rebuild their grid style on each read; these pin what that style sets.

#![cfg(test)]

use crate::DomHandle;

fn layout(body: &str) -> DomHandle {
    let dom = DomHandle::new(
        &format!(
            "<!DOCTYPE html><html><head><style>body {{ margin: 0 }} td {{ padding: 0 }}\
             table {{ border-spacing: 0 }}</style></head><body>{body}</body></html>"
        ),
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn rect(dom: &DomHandle, sel: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {sel}");
    dom.test_get_inline_aware_rect(id as u32)
}

#[test]
fn spans_place_cells_around_earlier_rowspans() {
    let dom = layout(
        "<table><tr><td id=a rowspan=2 style='width:50px;height:40px'></td>\
         <td id=b colspan=2 style='width:100px;height:20px'></td></tr>\
         <tr><td id=c style='width:50px;height:20px'></td><td id=d style='width:50px'></td></tr></table>",
    );
    let (a, b, c, d) = (
        rect(&dom, "#a"),
        rect(&dom, "#b"),
        rect(&dom, "#c"),
        rect(&dom, "#d"),
    );
    assert_eq!(a.3, c.1 + c.3 - b.1, "the rowspan covers both rows");
    assert_eq!(c.0, a.0 + a.2, "the second row skips the rowspan's column");
    assert_eq!(b.2, c.2 + d.2, "the colspan covers both columns");
    assert_eq!(d.0, c.0 + c.2);
}

#[test]
fn cell_margins_and_widths_do_not_size_the_grid_area() {
    let dom = layout(
        "<table><tr><td id=a style='margin:30px;width:40px;height:10px'></td>\
         <td id=b style='width:10px;height:10px'></td></tr>\
         <tr><td id=c style='width:90px'></td><td></td></tr></table>",
    );
    let (a, b, c) = (rect(&dom, "#a"), rect(&dom, "#b"), rect(&dom, "#c"));
    assert_eq!((a.0, a.1), (0.0, 0.0), "margins do not apply to cells");
    assert_eq!(a.2, c.2, "a cell fills its column, not its own width");
    assert_eq!(b.0, a.2);
}

#[test]
fn collapsed_borders_are_gutters_not_cell_borders() {
    let dom = layout(
        "<table style='border-collapse:collapse'><tr>\
         <td id=a style='border:6px solid;width:20px;height:20px'></td>\
         <td id=b style='border:6px solid;width:20px;height:20px'></td></tr></table>",
    );
    let (a, b) = (rect(&dom, "#a"), rect(&dom, "#b"));
    let separate = layout(
        "<table><tr><td id=a style='border:6px solid;width:20px;height:20px'></td></tr></table>",
    );
    assert_eq!(
        rect(&separate, "#a").3,
        a.3 + 12.0,
        "collapsed cells carry no border box"
    );
    assert_eq!((a.0, a.1), (6.0, 6.0), "the outer border is a gutter");
    assert_eq!(
        b.0,
        a.0 + a.2 + 6.0,
        "the shared border is a gutter between cells"
    );
}

#[test]
fn fixed_layout_cells_do_not_widen_their_columns() {
    let dom = layout(
        "<table style='table-layout:fixed;width:200px'><col style='width:44px'><col>\
         <tr><td id=a style='height:10px'></td><td></td></tr>\
         <tr><td id=b style='min-width:80px;height:10px'></td><td id=c></td></tr></table>",
    );
    assert_eq!(rect(&dom, "#a").2, 44.0);
    assert_eq!(
        rect(&dom, "#b").2,
        44.0,
        "a cell's min-width does not widen a fixed column"
    );
    assert_eq!(rect(&dom, "#c").0, 44.0);
}

#[test]
fn anonymous_cells_and_captions_take_their_grid_areas() {
    let dom = layout(
        "<table style='width:300px'><caption id=cap style='height:10px'>c</caption>\
         <tr><td id=a style='height:20px'>a</td><td>b</td></tr></table>\
         <div style='display:table'><div style='display:table-row'>\
         <div id=cell style='display:table-cell;width:40px'>x</div><span id=loose>y</span></div></div>",
    );
    let (cap, a) = (rect(&dom, "#cap"), rect(&dom, "#a"));
    assert_eq!(cap.2, 300.0, "the caption spans every column");
    assert_eq!(a.1, cap.1 + cap.3, "the caption sits above the first row");
    let (cell, loose) = (rect(&dom, "#cell"), rect(&dom, "#loose"));
    assert!(
        loose.0 >= cell.0 + cell.2,
        "loose content gets the next column's anonymous cell"
    );
}
