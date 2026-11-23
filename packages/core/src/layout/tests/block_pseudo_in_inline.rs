// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// An in-flow `display: block` pseudo-element inside an inline box occupies its
// own line above the following inline content.
// https://drafts.csswg.org/css2/#anonymous-block-level

use crate::DomHandle;

fn rect(dom: &DomHandle, selector: &str) -> (f32, f32, f32, f32) {
    let id = dom.query_selector(selector).expect(selector) as u32;
    dom.test_get_inline_aware_rect(id)
}

#[test]
fn block_before_pseudo_in_inline_pushes_text_to_next_line() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #wrap { width: 300px; font: 20px/40px sans-serif }
      #link::before { content: ""; display: block; height: 20px; margin-bottom: 10px }
    </style></head><body>
      <div id="wrap"><a id="link"><span id="label">On this page</span></a></div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let (_, _, _, wrap_h) = rect(&dom, "#wrap");
    let (_, label_y, _, _) = rect(&dom, "#label");
    // 20px block height + 10px margin-bottom = 30px line 1, plus 40px line 2 = 70px.
    assert!(
        wrap_h >= 69.0,
        "wrapper must include both the block ::before and the text line: got {wrap_h}"
    );
    assert!(
        label_y >= 29.0,
        "text span must sit below the 30px ::before box: got y={label_y}"
    );
}
