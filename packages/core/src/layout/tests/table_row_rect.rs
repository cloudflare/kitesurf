// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Table rows and row groups have no layout box of their own, so geometry reads them as the
//! union of their cells, the box an agent aims at when it clicks a row.

#![cfg(test)]

use crate::{test_support::query_selector_id, DomHandle};

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn rect(dom: &DomHandle, sel: &str) -> (f32, f32, f32, f32) {
    dom.test_bounding_rect(query_selector_id(dom, sel))
}

const SECTIONS: &str = r#"<!DOCTYPE html><body style="margin:0">
<style>td { padding: 0 }</style>
<table style="border-spacing:4px;border:2px solid black">
<thead id="head"><tr id="hr">
<td style="width:50px;height:20px"></td><td style="width:70px;height:20px"></td>
</tr></thead>
<tbody id="body"><tr id="r1"><td style="height:30px"></td><td style="height:30px"></td></tr></tbody>
</table>"#;

#[test]
fn rows_and_sections_span_from_the_first_cell_to_the_last() {
    let dom = laid_out(SECTIONS);
    // The table border is 2px and the spacing 4px, so cells start at 6; the columns are 50 and
    // 70 with 4px between them, and the body row sits below the 20px head row and a gap.
    assert_eq!(rect(&dom, "#hr"), (6.0, 6.0, 124.0, 20.0));
    assert_eq!(rect(&dom, "#head"), (6.0, 6.0, 124.0, 20.0));
    assert_eq!(rect(&dom, "#r1"), (6.0, 30.0, 124.0, 30.0));
    assert_eq!(rect(&dom, "#body"), (6.0, 30.0, 124.0, 30.0));
}

// The tall cell's 60px make two 30px rows. The first row ends where the second starts, as in
// Chrome; the second is its one cell, which Blitz does not stretch to the row.
#[test]
fn a_row_spanning_cell_widens_its_row_but_does_not_deepen_it() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0; width: 40px }</style>
<table style="border-spacing:0"><tbody id="body">
<tr id="r1">
<td id="tall" rowspan="2" style="height:60px"></td><td id="c1" style="height:20px"></td>
</tr>
<tr id="r2"><td id="c2" style="height:20px"></td></tr>
</tbody></table>"#,
    );
    assert_eq!(rect(&dom, "#tall"), (0.0, 0.0, 40.0, 60.0));
    assert_eq!(rect(&dom, "#r1"), (0.0, 0.0, 80.0, 30.0));
    assert_eq!(rect(&dom, "#r2"), (40.0, 30.0, 40.0, 20.0));
    assert_eq!(rect(&dom, "#r2"), rect(&dom, "#c2"));
    assert_eq!(rect(&dom, "#body"), (0.0, 0.0, 80.0, 60.0));
}

#[test]
fn a_row_of_spanning_cells_ends_where_the_next_row_starts() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0; width: 40px }</style>
<table style="border-spacing:0 4px"><tbody>
<tr id="r1"><td rowspan="2" style="height:60px"></td></tr>
<tr id="r2"><td id="c2" style="height:20px"></td></tr>
</tbody></table>"#,
    );
    let (_, r1y, _, r1h) = rect(&dom, "#r1");
    let (_, c2y, _, _) = rect(&dom, "#c2");
    assert!(r1h > 0.0, "the row keeps a box: {r1h}");
    assert_eq!(
        r1y + r1h,
        c2y - 4.0,
        "the row stops a spacing short of the next"
    );
}

// Blitz runs a rowspan past the end of its row group, where HTML stops it: the head would
// otherwise reach over the body's first row.
#[test]
fn a_span_out_of_a_row_group_does_not_carry_the_group_over_the_next() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0; width: 40px }</style>
<table style="border-spacing:0">
<thead id="head"><tr><td rowspan="2" style="height:60px"></td><td style="height:20px"></td></tr></thead>
<tbody id="body"><tr><td id="first" style="height:20px"></td></tr></tbody>
</table>"#,
    );
    let (_, head_y, _, head_h) = rect(&dom, "#head");
    let (_, body_y, _, _) = rect(&dom, "#body");
    assert_eq!(body_y, rect(&dom, "#first").1);
    assert!(
        head_y + head_h <= body_y,
        "head ends at {} over a body at {body_y}",
        head_y + head_h
    );
}

#[test]
fn footers_empty_rows_and_moved_cells_report_their_cells() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0; width: 40px; height: 20px }</style>
<table style="border-spacing:0">
<tfoot id="foot"><tr id="fr"><td></td></tr></tfoot>
<tbody><tr id="r1"><td></td><td id="moved" style="transform:translateX(100px)"></td></tr>
<tr id="empty"></tr></tbody>
</table>"#,
    );
    // The footer is laid out after the body whatever its place in the markup, so its row
    // starts below the body's 20px row and not at the table's top.
    assert_eq!(rect(&dom, "#foot"), (0.0, 20.0, 40.0, 20.0));
    assert_eq!(rect(&dom, "#fr"), rect(&dom, "#foot"));
    // The client rect follows a cell its transform moved, as a click does; the observer box
    // is the layout size, which a transform leaves alone.
    assert_eq!(rect(&dom, "#moved"), (140.0, 0.0, 40.0, 20.0));
    assert_eq!(rect(&dom, "#r1"), (0.0, 0.0, 180.0, 20.0));
    let row = query_selector_id(&dom, "#r1");
    assert_eq!(
        dom.resize_observer_boxes(row, true),
        vec![80.0, 20.0, 80.0, 20.0]
    );
    let (_, _, w, h) = rect(&dom, "#empty");
    assert_eq!((w, h), (0.0, 0.0));
}

// An observed target's ancestors are asked for their box only when they clip: a row's box is
// worked out from every cell of its section, once per target per pass.
#[test]
fn an_observed_target_in_a_cell_does_not_measure_its_row() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0">
<table><tr><td><i id="target" style="display:block;width:10px;height:10px"></i></td><td></td></tr>
<tr><td></td><td></td></tr></table>"#,
    );
    let target = query_selector_id(&dom, "#target");
    crate::layout::geometry::take_table_part_rects();
    let geometry = dom
        .intersection_geometry(target, -1, vec![0.0; 8], vec![0.0; 8], 0.0, 0.0, true)
        .unwrap_or_else(|_| panic!("intersection geometry failed"));
    assert!(geometry.contains(r#""isIntersecting":true"#), "{geometry}");
    assert_eq!(crate::layout::geometry::take_table_part_rects(), 0);
}

#[test]
fn the_centre_of_a_row_hits_one_of_its_cells() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0; height: 40px }</style>
<table style="border-spacing:0"><tr><td></td></tr>
<tr id="row"><td style="width:100px"></td><td id="wide" style="width:300px"></td></tr></table>"#,
    );
    let (x, y, w, h) = rect(&dom, "#row");
    assert_eq!((x, y, w, h), (0.0, 40.0, 400.0, 40.0));
    let hit = dom.element_from_point(x + w / 2.0, y + h / 2.0);
    assert_eq!(hit, query_selector_id(&dom, "#wide") as i32);
}

#[test]
fn a_row_in_a_nested_table_reports_the_inner_cells() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><style>td { padding: 0 }</style>
<table style="border-spacing:0"><tr><td style="width:300px;height:100px">
<table style="border-spacing:0">
<tr id="inner"><td id="cell" style="width:50px;height:10px"></td></tr>
</table>
</td></tr></table>"#,
    );
    let (_, _, w, h) = rect(&dom, "#inner");
    assert_eq!((w, h), (50.0, 10.0));
    assert_eq!(rect(&dom, "#inner"), rect(&dom, "#cell"));
}

#[test]
fn a_misparented_row_reports_its_cells() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><div style="padding:10px">
<div id="row" style="display:table-row">
<div id="cell" style="display:table-cell;width:50px;height:20px"></div>
</div>
</div>"#,
    );
    assert_eq!(rect(&dom, "#row"), (10.0, 10.0, 50.0, 20.0));
    assert_eq!(rect(&dom, "#row"), rect(&dom, "#cell"));
}

#[test]
fn resize_observer_sees_the_row_size() {
    let dom = laid_out(SECTIONS);
    let row = query_selector_id(&dom, "#r1");
    assert_eq!(
        dom.resize_observer_boxes(row, true),
        vec![124.0, 30.0, 124.0, 30.0]
    );
}

#[test]
fn a_row_below_the_viewport_does_not_intersect_it() {
    let dom = laid_out(
        r#"<!DOCTYPE html><body style="margin:0"><div style="height:2000px"></div>
<table><tr id="row"><td style="height:20px"></td></tr></table>"#,
    );
    let row = query_selector_id(&dom, "#row");
    let geometry = dom
        .intersection_geometry(row, -1, vec![0.0; 8], vec![0.0; 8], 0.0, 0.0, true)
        .unwrap_or_else(|_| panic!("intersection geometry failed"));
    assert!(geometry.contains(r#""isIntersecting":false"#), "{geometry}");
    let (_, y, _, h) = rect(&dom, "#row");
    assert!(y >= 2000.0 && h > 0.0, "row at {y} height {h}");
}
