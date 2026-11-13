// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A fixed table layout gives its length columns their width first; its percentage columns
//! share what is left.

#![cfg(test)]

use crate::DomHandle;

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn span(dom: &DomHandle, selector: &str) -> (f32, f32) {
    let id = dom.query_selector(selector).unwrap_or(-1);
    assert!(id > 0, "selector must match: {selector}");
    let (x, _, width, _) = dom.test_get_inline_aware_rect(id as u32);
    (x, x + width)
}

fn assert_close(got: f32, want: f32, what: &str) {
    assert!((got - want).abs() < 0.05, "{what}: got {got}, want {want}");
}

fn row(table: &str) -> String {
    format!(
        concat!(
            "<!DOCTYPE html><body style=\"margin:0\"><style>",
            "* {{ box-sizing: border-box }} td {{ padding: 0; height: 20px }}",
            "table {{ table-layout: fixed; border-spacing: 0; {table} }}",
            "</style><table id=t><tr>",
            "<td id=a style=\"width:20px; padding:0 16px\"></td>",
            "<td id=b style=\"width:100px\"></td>",
            "<td id=c style=\"width:60%\"></td>",
            "<td id=d style=\"width:30%\"></td>",
            "</tr></table>",
        ),
        table = table
    )
}

// 32px and 100px of length columns leave 270px of a 402px table, less than the 361.8px its
// percentages ask for: they shrink two to one, and the row ends at the table's edge.
#[test]
fn percentage_columns_shrink_into_what_the_length_columns_leave() {
    let dom = laid_out(&row("width: 402px"));
    let edges = ["#a", "#b", "#c", "#d"].map(|cell| span(&dom, cell));
    let want = [0.0, 32.0, 132.0, 312.0, 402.0];
    for (index, (left, right)) in edges.into_iter().enumerate() {
        assert_close(left, want[index], "left edge");
        assert_close(right, want[index + 1], "right edge");
    }
    assert_close(span(&dom, "#t").1, 402.0, "the table keeps its width");
}

#[test]
fn percentage_columns_that_fit_keep_their_share_of_the_table() {
    let dom = laid_out(&row("width: 2000px"));
    let (c, d) = (span(&dom, "#c"), span(&dom, "#d"));
    assert_close(c.1 - c.0, 1200.0, "60% of 2000px");
    assert_close(d.1 - d.0, 600.0, "30% of 2000px");
}

#[test]
fn percentages_past_the_whole_table_shrink_to_it() {
    let dom = laid_out(concat!(
        "<!DOCTYPE html><body style=\"margin:0\">",
        "<table id=t style=\"table-layout:fixed; width:300px; border-spacing:0\"><tr>",
        "<td id=a style=\"width:80%; padding:0\"></td><td id=b style=\"width:70%; padding:0\"></td>",
        "</tr></table>",
    ));
    let (a, b) = (span(&dom, "#a"), span(&dom, "#b"));
    assert_close(a.1 - a.0, 160.0, "80 of 150 parts");
    assert_close(b.1, 300.0, "the row ends at the table's edge");
}
