// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Table cells rebuild their grid style on each read; these pin what that style sets.

use crate::DomHandle;

fn layout_page(body: &str) -> DomHandle {
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

fn rect(dom: &DomHandle, selector: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(selector).expect("query parses");
    assert!(id > 0, "selector must match: {selector}");
    dom.test_get_inline_aware_rect(id as u32)
}

#[test]
fn spans_place_cells_around_earlier_rowspans() {
    let dom = layout_page(
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
    let dom = layout_page(
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
    let dom = layout_page(
        "<table style='border-collapse:collapse'><tr>\
         <td id=a style='border:6px solid;width:20px;height:20px'></td>\
         <td id=b style='border:6px solid;width:20px;height:20px'></td></tr></table>",
    );
    let (a, b) = (rect(&dom, "#a"), rect(&dom, "#b"));
    let separate = layout_page(
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
    let dom = layout_page(
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
    let dom = layout_page(
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

// css-tables-3 §3.9.4: a cell's width raises its column's max-content width,
// not its min-content width, so an auto table still shrinks to its container.
#[test]
fn cell_widths_do_not_hold_an_auto_table_wider_than_its_container() {
    let row = "<tr><td id=a style='width:100px'>a</td>\
               <td id=b style='width:400px'>words that can wrap</td></tr>";
    let narrow = layout_page(&format!(
        "<div style='width:300px'><table id=t>{row}</table></div>"
    ));
    let (t, a, b) = (
        rect(&narrow, "#t"),
        rect(&narrow, "#a"),
        rect(&narrow, "#b"),
    );
    assert_eq!(t.2, 300.0, "the table shrinks to its container");
    assert!(
        a.2 < 100.0 && b.2 < 400.0,
        "both columns give up width ({a:?} {b:?})"
    );
    assert!(
        a.2 > 50.0,
        "each column gives up width in proportion ({a:?} {b:?})"
    );

    let wide = layout_page(&format!("<table id=t>{row}</table>"));
    let (a, b) = (rect(&wide, "#a"), rect(&wide, "#b"));
    assert_eq!(
        (a.2, b.2),
        (100.0, 400.0),
        "with room, the columns take their widths"
    );

    let beside = layout_page(&format!(
        "<div style='width:500px'><div style='float:right;width:200px;height:50px'></div>\
         <table id=t>{row}</table></div>"
    ));
    assert_eq!(
        rect(&beside, "#t").2,
        300.0,
        "the table shrinks beside the float"
    );
}

#[test]
fn a_cell_width_does_not_cap_the_column_of_a_wider_cell() {
    let table = |width: &str| {
        layout_page(&format!(
            "<table><tr><td style='{width}'>a</td></tr>\
             <tr><td id=b>words that fit on one line when there is room</td></tr></table>"
        ))
    };
    assert_eq!(
        rect(&table("width:50px"), "#b"),
        rect(&table(""), "#b"),
        "the column still grows to the max-content width of its other cells"
    );
}

#[test]
fn cell_min_and_max_widths_bound_a_cell_width() {
    let column = |style: &str, text: &str| {
        let dom = layout_page(&format!(
            "<table><tr><td id=a style='{style}'>{text}</td><td id=b>b</td></tr></table>"
        ));
        (rect(&dom, "#a").2, rect(&dom, "#b").0)
    };
    assert_eq!(column("width:100px;max-width:80px", "a"), (80.0, 80.0));
    assert_eq!(column("width:100px;min-width:200px", "a"), (200.0, 200.0));
    assert_eq!(
        column("width:100px;max-width:20px", "unbreakable"),
        (20.0, 20.0),
        "max-width also caps the cell's min-content width"
    );

    let squeezed = layout_page(
        "<div style='width:1px'><table><tr><td id=a style='width:100px;max-width:5px;\
         padding:0 10px;box-sizing:border-box'></td><td id=b>b</td></tr></table></div>",
    );
    assert_eq!(
        (rect(&squeezed, "#a").2, rect(&squeezed, "#b").0),
        (20.0, 20.0),
        "the column is never narrower than the cell's padding"
    );
}

// A grid item's `min-width`, or a scroll container, replaces its content-based minimum.
// A table cell is never narrower than its content.
#[test]
fn a_cell_min_width_or_overflow_keeps_the_content_minimum() {
    let column = |a_style: &str, b_style: &str| {
        let dom = layout_page(&format!(
            "<table><tr><td id=a style='width:100px;{a_style}'>unbreakableunbreakable</td>\
             <td id=b style='{b_style}'>b</td></tr></table>"
        ));
        (rect(&dom, "#a").2, rect(&dom, "#b").0)
    };
    let content = column("", "");
    assert!(
        content.0 > 100.0,
        "control: the text is wider than the cell width ({content:?})"
    );
    for (a_style, b_style) in [
        ("min-width:10px", ""),
        ("overflow:hidden", ""),
        ("min-width:10px", "width:50px"),
    ] {
        assert_eq!(column(a_style, b_style), content, "{a_style} / {b_style}");
    }
}

// The cell's layout cache keeps the content measurement, so a change in the cell drops it.
#[test]
fn a_cell_content_minimum_follows_a_change_in_the_cell() {
    let widths = |incremental: bool| {
        let dom = layout_page(
            "<div style='width:1px'><table><tr><td id=a style='width:100px'>\
             <div id=inner style='width:10px;height:10px'></div></td><td>b</td></tr></table></div>",
        );
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        let before = rect(&dom, "#a").2;
        let inner = dom.query_selector("#inner").expect("query parses") as u32;
        dom.set_attribute(inner, "style", "width:200px;height:10px");
        dom.resolve_layout();
        (before, rect(&dom, "#a").2)
    };
    assert_eq!(widths(false), (10.0, 200.0), "control");
    assert_eq!(widths(true), widths(false));
}

// css-tables-3 §3.9.4: the spare width of a table goes to the columns without a
// cell width while there are any.
#[test]
fn spare_table_width_goes_to_columns_without_a_cell_width() {
    let widths = |b_style: &str| {
        let dom = layout_page(&format!(
            "<table style='width:400px'><tr><td id=a style='width:100px'>a</td>\
             <td id=b style='{b_style}'>b</td></tr></table>"
        ));
        (rect(&dom, "#a").2, rect(&dom, "#b").2)
    };
    assert_eq!(widths(""), (100.0, 300.0));

    let (a, b) = widths("width:200px");
    assert_eq!(a + b, 400.0, "with no other column, these columns share it");
    assert!(a > 100.0 && b > 200.0, "both columns grow ({a} {b})");
}

#[test]
fn a_cell_width_widens_a_column_that_has_a_min_width() {
    let dom = layout_page(
        "<table><col style='min-width:50px'>\
         <tr><td id=a style='width:100px'>a</td><td id=b>b</td></tr></table>",
    );
    assert_eq!((rect(&dom, "#a").2, rect(&dom, "#b").0), (100.0, 100.0));
}

// Taffy keeps one sizing mode per layout cache and drops the entries when the
// mode changes, so a cell must not be measured in a second mode through its cache.
#[cfg(debug_assertions)]
#[test]
fn measuring_a_cell_without_its_width_keeps_its_layout_cache() {
    let evictions = taffy::tree::cache_mode_change_evictions();
    layout_page(
        "<div style='width:300px'><table><tr><td style='width:100px'>a</td>\
         <td style='width:400px'><p>words that can wrap</p></td></tr></table></div>",
    );
    assert_eq!(taffy::tree::cache_mode_change_evictions(), evictions);
}
