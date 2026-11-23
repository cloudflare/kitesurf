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
