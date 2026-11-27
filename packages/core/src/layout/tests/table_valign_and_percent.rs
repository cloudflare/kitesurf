// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Verifies HTML `valign` presentational hints on table cells/rows and
// percentage column widths under `table-layout: auto`.
// https://html.spec.whatwg.org/multipage/rendering.html#tables-2
// https://drafts.csswg.org/css-tables-3/#distributing-width-to-columns

use crate::DomHandle;

#[test]
fn table_cell_valign_top_aligns_content_to_top() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      table { border-collapse: collapse; }
      td { padding: 0; }
      #tall { height: 200px; width: 40px; }
      #box { height: 20px; width: 40px; }
    </style></head><body>
      <table>
        <tr>
          <td id="cell-top" valign="top"><div id="box"></div></td>
          <td><div id="tall"></div></td>
        </tr>
      </table>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 300);
    dom.resolve_layout();

    let cell_id = dom.query_selector("#cell-top").expect("#cell-top") as u32;
    let box_id = dom.query_selector("#box").expect("#box") as u32;
    let (_, cell_top, _, cell_h) = dom.test_get_inline_aware_rect(cell_id);
    let (_, box_top, _, _) = dom.test_get_inline_aware_rect(box_id);

    assert!(
        cell_h >= 199.0,
        "row should be stretched by tall sibling; got cell_h={cell_h}"
    );
    assert!(
        (box_top - cell_top).abs() < 2.0,
        "valign=top must place #box at the top of #cell-top (cell_top={cell_top}, box_top={box_top})"
    );
}

#[test]
fn auto_table_honours_percentage_column_width() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      table { width: 800px; border-collapse: collapse; table-layout: auto; }
      td { padding: 0; }
      .w25 { width: 25%; }
    </style></head><body>
      <table>
        <tr>
          <td id="c1" class="w25">Version 17</td>
          <td id="c2">Documentation and release notes for the current series</td>
        </tr>
      </table>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(1000, 400);
    dom.resolve_layout();

    let c1_id = dom.query_selector("#c1").expect("#c1") as u32;
    let c2_id = dom.query_selector("#c2").expect("#c2") as u32;
    let (_, _, c1_w, _) = dom.test_get_inline_aware_rect(c1_id);
    let (_, _, c2_w, _) = dom.test_get_inline_aware_rect(c2_id);

    assert!(
        (c1_w - 200.0).abs() <= 4.0,
        "25% column in 800px auto table should be ~200px; got c1_w={c1_w}, c2_w={c2_w}"
    );
    assert!(
        (c2_w - 600.0).abs() <= 4.0,
        "remaining auto column should take ~600px; got c1_w={c1_w}, c2_w={c2_w}"
    );
}

fn laid_out(html: &str) -> DomHandle {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn rect(dom: &DomHandle, selector: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(selector).unwrap_or(-1);
    assert!(id > 0, "selector must match: {selector}");
    dom.test_get_inline_aware_rect(id as u32)
}

const PERCENT_CELL_TABLE: &str = concat!(
    "<!doctype html><html><head><style>",
    "body { margin: 0 } table { border-collapse: collapse } td { padding: 0 }",
    "</style></head><body><table id=\"t\" {table}><tr>",
    "<td id=\"a\" width=\"50%\">alpha beta gamma delta</td>",
    "<td id=\"b\" width=\"50%\">epsilon zeta eta</td>",
    "</tr></table></body></html>",
);

/// A percentage cell width resolves against the table's inline size. With an
/// auto width the table is sized from its content, so the percentage must not
/// collapse the column to its `min-content` width and wrap the text.
#[test]
fn auto_width_table_keeps_percentage_cells_on_one_line() {
    let dom = laid_out(&PERCENT_CELL_TABLE.replace("{table}", ""));
    let (_, _, table_w, _) = rect(&dom, "#t");
    let (_, _, a_w, a_h) = rect(&dom, "#a");
    assert!(
        a_h < 30.0,
        "a percentage cell wrapped to {a_h}px in an auto-width table"
    );
    assert!(
        table_w > 250.0 && a_w > 120.0,
        "the auto-width table collapsed to table_w={table_w}, a_w={a_w}"
    );
}

/// Floated and absolutely positioned tables shrink to fit too, so their
/// percentage cells must keep the content width for the same reason.
#[test]
fn out_of_flow_auto_width_table_keeps_percentage_cells_on_one_line() {
    for (name, table) in [
        ("floated", "style=\"float: left\""),
        ("absolute", "style=\"position: absolute; top: 0; left: 0\""),
    ] {
        let dom = laid_out(&PERCENT_CELL_TABLE.replace("{table}", table));
        let (_, _, table_w, _) = rect(&dom, "#t");
        let (_, _, a_w, a_h) = rect(&dom, "#a");
        assert!(
            a_h < 30.0,
            "a percentage cell wrapped to {a_h}px in a {name} auto-width table"
        );
        assert!(
            table_w > 250.0 && a_w > 120.0,
            "the {name} auto-width table collapsed to table_w={table_w}, a_w={a_w}"
        );
    }
}

/// `width: max-content` is not a definite inline size, so a percentage cell
/// width must not constrain the column: the table keeps its content sizing and
/// the cell stays on one line.
/// https://drafts.csswg.org/css-tables-3/#distributing-width-to-columns
#[test]
fn max_content_width_table_keeps_percentage_cells_on_one_line() {
    let html = concat!(
        "<!doctype html><html><head><style>",
        "body { margin: 0 } table { border-collapse: collapse } td { padding: 0 }",
        "</style></head><body><div style=\"float: left\">",
        "<table id=\"t\" style=\"width: max-content\"><tr>",
        "<td id=\"a\" style=\"width: 20%\">alpha beta gamma delta</td>",
        "</tr></table></div></body></html>",
    );
    let dom = laid_out(html);
    let (_, _, a_w, a_h) = rect(&dom, "#a");
    assert!(
        a_h < 30.0,
        "a percentage cell wrapped to {a_h}px in a max-content-width table"
    );
    assert!(
        a_w > 120.0,
        "the max-content table collapsed the column to a_w={a_w}"
    );
}

/// The negative control: a definite table width still resolves the percentage
/// against it, so a narrow column stays narrow.
#[test]
fn definite_width_table_honours_percentage_cell_width() {
    let html = concat!(
        "<!doctype html><html><head><style>",
        "body { margin: 0 } table { border-collapse: collapse } td { padding: 0 }",
        "</style></head><body><table id=\"t\" width=\"100%\"><tr>",
        "<td id=\"a\" width=\"1%\"></td><td id=\"b\">rest</td>",
        "</tr></table></body></html>",
    );
    let dom = laid_out(html);
    let (_, _, a_w, _) = rect(&dom, "#a");
    assert!(
        (a_w - 8.0).abs() <= 1.0,
        "1% of an 800px table should be ~8px; got {a_w}"
    );
}
