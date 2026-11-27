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

/// The width of the `display: block` pseudo's inline box in `root`'s inline layout.
fn block_pseudo_box_width(dom: &DomHandle, root_selector: &str) -> f32 {
    let root_id = dom.query_selector(root_selector).expect(root_selector) as u32;
    let doc = dom.doc.borrow();
    let root = doc
        .as_ref()
        .get_node(crate::blitz_node_id(root_id))
        .expect("root node");
    let pseudo_id = root.before().or_else(|| root.after()).expect("pseudo");
    let inline = root
        .element_data()
        .and_then(|el| el.inline_layout_data())
        .expect("inline layout");
    let layout = inline.layout(root.tree());
    let width = layout
        .inline_boxes()
        .find(|ibox| ibox.id == pseudo_id.as_u64())
        .map(|ibox| ibox.width)
        .expect("pseudo inline box");
    width
}

/// A shrink-to-fit container measures the block pseudo at its own content width
/// during intrinsic sizing, so the container does not fill the line.
fn shrink_to_fit_width(html: &str, selector: &str) -> (f32, f32) {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let (_, _, width, height) = rect(&dom, selector);
    (width, height)
}

#[test]
fn block_after_pseudo_inside_inline_block_stays_shrink_to_fit() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #row { width: 600px; font: 20px/20px monospace }
      #ib { display: inline-block }
      #ib::after { content: ""; display: block; height: 2px }
    </style></head><body>
      <div id="row"><span id="ib">x</span></div>
    </body></html>"#;
    let (width, height) = shrink_to_fit_width(html, "#ib");
    assert!(
        width < 100.0,
        "inline-block must shrink to its text, not fill the 600px line: got {width}"
    );
    assert!(
        height >= 20.0,
        "inline-block height must include the 2px block pseudo: got {height}"
    );
}

#[test]
fn block_after_pseudo_inside_float_stays_shrink_to_fit() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #row { width: 600px; font: 20px/20px monospace }
      #fl { float: left }
      #fl::after { content: ""; display: block; height: 2px }
    </style></head><body>
      <div id="row"><div id="fl">x</div></div>
    </body></html>"#;
    let (width, height) = shrink_to_fit_width(html, "#fl");
    assert!(
        width < 100.0,
        "float must shrink to its text, not fill the 600px line: got {width}"
    );
    assert!(
        height >= 20.0,
        "float height must include the 2px block pseudo: got {height}"
    );
}

#[test]
fn block_after_pseudo_inside_abspos_stays_shrink_to_fit() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #row { width: 600px; font: 20px/20px monospace }
      #ab { position: absolute; top: 0; left: 0 }
      #ab::after { content: ""; display: block; height: 2px }
    </style></head><body>
      <div id="row"><div id="ab">x</div></div>
    </body></html>"#;
    let (width, height) = shrink_to_fit_width(html, "#ab");
    assert!(
        width < 100.0,
        "abspos box must shrink to its text, not fill the line: got {width}"
    );
    assert!(
        height >= 20.0,
        "abspos box height must include the 2px block pseudo: got {height}"
    );
}

#[test]
fn definite_width_container_still_stretches_block_pseudo() {
    let html = r#"<html><head><style>
      body { margin: 0 }
      #wrap { width: 300px; font: 20px/40px sans-serif }
      #wrap::before { content: ""; display: block; height: 20px }
    </style></head><body>
      <div id="wrap"><a id="link"><span>text</span></a></div>
    </body></html>"#;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let width = block_pseudo_box_width(&dom, "#wrap");
    assert!(
        (width - 300.0).abs() < 1.0,
        "a definite-width container must stretch the auto-width block pseudo to 300px: got {width}"
    );
}
