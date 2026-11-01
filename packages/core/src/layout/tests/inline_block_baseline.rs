// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Inline-block baseline uses its last line box, including a block child's line.
//! See CSS 2.1 §10.8.1.

#![cfg(test)]

use crate::DomHandle;

/// Line baselines of `sel`'s inline formatting context, in its own
/// coordinates.
fn line_baselines(dom: &DomHandle, sel: &str) -> Vec<f32> {
    let id = dom.query_selector(sel).unwrap() as u32;
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id)).expect("node exists");
    let text = node
        .element_data()
        .and_then(|e| e.inline_layout_data())
        .expect("an inline formatting context");
    text.layout.lines().map(|l| l.metrics().baseline).collect()
}

#[test]
fn inline_block_with_block_child_aligns_on_its_last_line() {
    for (shape, html) in [
        (
            "block child",
            r#"<!DOCTYPE html><ul><li id="li"><div style="display:inline-block"><span><div id="lines">line1<br>line2</div></span></div></li></ul>"#,
        ),
        (
            "own lines",
            r#"<!DOCTYPE html><ul><li id="li"><div id="lines" style="display:inline-block">line1<br>line2</div></li></ul>"#,
        ),
    ] {
        let dom = DomHandle::new(html, "https://test.example/");
        dom.resolve_layout();
        // Every box here starts at the li's origin, so the coordinates agree.
        let inner = line_baselines(&dom, "#lines");
        assert_eq!(inner.len(), 2, "{shape}: two lines");
        let outer = line_baselines(&dom, "#li");
        assert_eq!(
            outer.first().copied(),
            inner.last().copied(),
            "{shape}: the li's line must sit on the inline-block's last line"
        );
    }
}
