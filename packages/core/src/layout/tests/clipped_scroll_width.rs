// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// A box that clips its overflow does not extend the document's scrollable
// area: its hidden content is reachable only by scrolling the box itself.
// https://drafts.csswg.org/css-overflow-3/#scrollable-overflow-region

use crate::DomHandle;

const PAGE: &str = r#"<html><head><style>
  body { margin: 0 }
  #panel { overflow: hidden; width: 375px; height: 100px }
  #inner { width: 2000px; height: 10px }
</style></head><body>
  <div id="panel"><div id="inner"></div></div>
</body></html>"#;

fn scroll_widths(html: &str) -> (f64, f64) {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(375, 812);
    dom.resolve_layout();
    let root = dom.query_selector("html").expect("html") as u32;
    let panel = dom.query_selector("#panel").expect("#panel") as u32;
    let root_info = dom.read_scroll_info(root).expect("root scroll info");
    let panel_info = dom.read_scroll_info(panel).expect("panel scroll info");
    (root_info.scroll_width, panel_info.scroll_width)
}

#[test]
fn a_clipping_box_does_not_widen_the_document() {
    let (document_width, panel_width) = scroll_widths(PAGE);
    assert_eq!(
        document_width, 0.0,
        "the clipped content must not widen the document (panel scroll width {panel_width})"
    );
    // The box keeps its hidden content reachable: scroll_width is the maximum
    // scroll offset, so 2000px of content in a 375px box is 1625.
    assert_eq!(
        panel_width, 1625.0,
        "the clipping box keeps its own scrollable content"
    );
}

#[test]
fn visible_overflow_still_widens_the_document() {
    let page = PAGE.replace("overflow: hidden", "overflow: visible");
    let (document_width, _) = scroll_widths(&page);
    assert!(
        document_width >= 1625.0,
        "visible overflow reaches the document, got {document_width}"
    );
}
