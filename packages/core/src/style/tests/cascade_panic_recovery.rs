// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

#[test]
fn should_process_descendants_tolerates_missing_primary() {
    use ::style::data::ElementData;
    use ::style::invalidation::element::state_and_attributes::should_process_descendants;

    let unstyled = ElementData::default();
    assert!(
        !should_process_descendants(&unstyled),
        "data without primary styles must be skipped, not unwrapped"
    );
}

#[test]
fn clear_style_snapshots_resets_pending_snapshots() {
    let html = r##"<!DOCTYPE html>
<html><head><style>.x { color: rgb(1, 2, 3); }</style></head>
<body><div id="a" class="x">hi</div></body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#a").expect("query ok");
    assert!(id >= 0, "#a found");
    let id = id as u32;

    assert!(dom.set_attribute(id, "class", "y"));
    {
        let doc = dom.doc.borrow();
        assert!(
            doc.get_node(crate::blitz_node_id(id))
                .expect("node")
                .has_snapshot(),
            "set_attribute on a styled element must mint a snapshot"
        );
    }

    {
        let mut doc = dom.doc.borrow_mut();
        doc.as_mut().clear_style_snapshots();
    }
    {
        let doc = dom.doc.borrow();
        assert!(
            !doc.get_node(crate::blitz_node_id(id))
                .expect("node")
                .has_snapshot(),
            "clear_style_snapshots must reset per-node has_snapshot flags"
        );
    }

    dom.layout_dirty.set(true);
    dom.resolve_layout();
}
