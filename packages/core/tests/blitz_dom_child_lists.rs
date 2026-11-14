// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use blitz_dom::{local_name, ns, BaseDocument, DocumentConfig, QualName};

#[test]
fn box_child_lists_preserve_empty_state_and_reset_on_clone() {
    let mut doc = BaseDocument::new(DocumentConfig::default());
    let element = doc
        .mutate()
        .create_element(QualName::new(None, ns!(html), local_name!("div")), vec![]);
    let text = doc.create_text_node("text");

    let node = doc.get_node(element).unwrap();
    assert!(node.layout_children().is_none());
    node.set_layout_children(Some(Default::default()));
    node.set_paint_children(Some([text].into_iter().collect()));
    let layout = node.layout_children().unwrap();
    let paint = node.paint_children().unwrap();
    assert!(layout.is_empty());
    assert_eq!(&paint[..], &[text]);
    drop(paint);
    drop(layout);

    let clone = doc.deep_clone_node(element);
    assert!(doc.get_node(clone).unwrap().layout_children().is_none());
    assert!(doc.get_node(clone).unwrap().paint_children().is_none());

    let node = doc.get_node(element).unwrap();
    assert!(node.take_layout_children().unwrap().is_empty());
    assert!(node.take_layout_children().is_none());

    let text = doc.get_node(text).unwrap();
    assert!(text.layout_children().is_none());
    assert!(text.paint_children().is_none());
    assert!(text.take_layout_children().is_none());
    assert!(text.take_paint_children().is_none());
}
