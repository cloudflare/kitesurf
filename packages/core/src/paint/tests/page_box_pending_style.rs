// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn width_pt(json: String) -> f64 {
    serde_json::from_str::<serde_json::Value>(&json).unwrap()["widthPt"]
        .as_f64()
        .unwrap()
}

#[test]
fn page_box_observes_a_style_edit_since_the_last_resolve() {
    let dom = DomHandle::new(
        "<html><head><style id=s>@page { size: 100px 200px; }</style></head>\
         <body><p>x</p></body></html>",
        "https://test.example/",
    );
    dom.set_media_type("print");
    dom.resolve_layout();
    assert_eq!(width_pt(dom.page_box_json()), 75.0);

    let style = dom.query_selector("#s").unwrap() as u32;
    let text = dom.create_text_node("\n@page { size: 200px 300px; }");
    assert!(dom.append_child_node(style, text));
    assert_eq!(width_pt(dom.page_box_json()), 150.0);
}
