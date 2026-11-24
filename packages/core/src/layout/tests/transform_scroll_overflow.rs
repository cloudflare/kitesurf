// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Scrollable overflow uses a box's transformed border box rather than its
// pre-transform layout box per CSS Overflow 3 §2.2.
// https://drafts.csswg.org/css-overflow-3/#scrollable

use crate::DomHandle;

#[test]
fn centered_translatex_abspos_does_not_inflate_document_scroll_width() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #bg {
        position: absolute;
        left: 50%;
        top: 0;
        width: 1220px;
        height: 200px;
        transform: translateX(-50%);
      }
    </style></head><body><div id="bg"></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(1280, 900);
    dom.resolve_layout();

    let root_id = dom.query_selector("html").expect("html") as u32;
    let info = dom.read_scroll_info(root_id).expect("root scroll info");
    assert!(
        info.scroll_width < 1.0,
        "centered translateX(-50%) box must not inflate document scroll_width; got {}",
        info.scroll_width
    );
}

#[test]
fn positive_translatex_contributes_to_scroll_width() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #scroller { width: 200px; height: 100px; overflow: auto; position: relative; }
      #shifted { width: 100px; height: 40px; transform: translateX(250px); }
    </style></head><body><div id="scroller"><div id="shifted"></div></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let scroller_id = dom.query_selector("#scroller").expect("#scroller") as u32;
    let info = dom.read_scroll_info(scroller_id).expect("scroller info");
    // Box sits at x=250..350 inside a 200px container -> 150px excess scroll_width.
    assert!(
        (info.scroll_width - 150.0).abs() <= 2.0,
        "translateX(250px) 100px box in 200px container should have ~150px scroll_width; got {}",
        info.scroll_width
    );
}

#[test]
fn transformed_child_inside_overflow_hidden_does_not_leak_to_document() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #clip { width: 300px; height: 100px; overflow: hidden; }
      #wide { width: 200px; height: 40px; transform: translateX(1000px); }
    </style></head><body><div id="clip"><div id="wide"></div></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let root_id = dom.query_selector("html").expect("html") as u32;
    let info = dom.read_scroll_info(root_id).expect("root scroll info");
    assert!(
        info.scroll_width < 1.0,
        "overflow:hidden must prevent transformed descendant from inflating document scroll_width; got {}",
        info.scroll_width
    );
}
