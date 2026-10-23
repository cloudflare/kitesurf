// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::{DomHandle, test_support::query_selector_id};

#[test]
fn dom_selection_uses_text_after_dropped_leading_whitespace() {
    let dom = DomHandle::new(
        concat!(
            "<!DOCTYPE html><html><body style='margin:0;font:16px/20px sans-serif'>",
            "<p style='margin:0'> <span id='target'>x</span></p></body></html>",
        ),
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let span_id = query_selector_id(&dom, "#target");
    let text_id = dom.child_ids(span_id)[0];
    assert!(dom.set_dom_selection(text_id, 0, text_id, 1));

    let doc = dom.doc.borrow();
    assert_eq!(doc.get_selected_text().as_deref(), Some("x"));
}
