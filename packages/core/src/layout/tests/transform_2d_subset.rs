// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn icon_transform(css_transform: &str) -> Option<kurbo::Affine> {
    let html = format!(
        r##"<html><head><style>
            li {{ position: relative; height: 42px; display: block; }}
            .icon {{ position: absolute; top: 50%; transform: {css_transform}; }}
        </style></head><body><ul><li>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>
            <span>Bots</span>
        </li></ul></body></html>"##
    );
    let dom = DomHandle::new(&html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector(".icon").unwrap_or(-1);
    assert!(id > 0, ".icon must match");
    let doc = dom.doc.borrow();
    doc.get_node(crate::blitz_node_id(id as u32))
        .expect("node")
        .transform()
        .as_deref()
        .copied()
}

#[test]
fn translate3d_2d_subset_is_kept() {
    let t = icon_transform("translate3d(0, -50%, 0)").expect("transform must survive");
    let c = t.as_coeffs();
    assert_eq!(c, [1.0, 0.0, 0.0, 1.0, 0.0, -10.0]);
}

#[test]
fn plain_2d_translate_still_works() {
    let t = icon_transform("translate(5px, -10px)").expect("transform must survive");
    assert_eq!(t.as_coeffs()[4..], [5.0, -10.0]);
}

#[test]
fn transformed_ancestor_moves_client_rect() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="position:fixed;transform:translate(111px,392px)">
            <div id="t" style="width:104px;height:32px"></div>
          </div>
        </body>"#,
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    let id = dom.query_selector("#t").expect("target must match");
    assert_eq!(
        dom.test_get_inline_aware_rect(id as u32),
        (111.0, 392.0, 104.0, 32.0)
    );
}

#[test]
fn transformed_ancestor_moves_inline_client_rect() {
    let rect = |transform: &str| {
        let dom = DomHandle::new(
            &format!(
                r#"<!DOCTYPE html><body style="margin:0">
                  <div style="position:fixed;transform:{transform}">
                    <div id="scroller" style="width:40px;overflow:auto;white-space:nowrap">
                      <span id="t">inline text that overflows</span>
                    </div>
                  </div>
                </body>"#
            ),
            "https://example.com/",
        );
        dom.set_viewport(800, 600);
        let scroller = dom
            .query_selector("#scroller")
            .expect("scroller must match");
        let scroller = dom
            .resolve_node_id(scroller as u32)
            .expect("scroller handle must resolve");
        dom.doc
            .borrow_mut()
            .get_node_mut(scroller)
            .expect("scroller node")
            .scroll_offset_mut()
            .x = 20.0;
        let id = dom.query_selector("#t").expect("target must match");
        dom.test_get_inline_aware_rect(id as u32)
    };

    let plain = rect("none");
    let moved = rect("translate(111px,392px)");
    assert!((moved.0 - plain.0 - 111.0).abs() < 0.01);
    assert!((moved.1 - plain.1 - 392.0).abs() < 0.01);
    assert!((moved.2 - plain.2).abs() < 0.01);
    assert!((moved.3 - plain.3).abs() < 0.01);
}

#[test]
fn rotated_multiline_inline_unions_transformed_fragments() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><body style="margin:0">
          <div style="position:fixed;transform:rotate(30deg);transform-origin:0 0">
            <span id="target"><span id="first">wide first line</span><br><span id="second">short</span></span>
          </div>
          <div style="position:fixed;top:100px">
            <span id="plain">wide first line<br>short</span>
          </div>
        </body>"#,
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    let rect = |selector: &str| {
        let id = dom
            .query_selector(selector)
            .expect("inline target must match");
        dom.test_get_inline_aware_rect(id as u32)
    };
    let first = rect("#first");
    let second = rect("#second");
    let expected = (
        first.0.min(second.0),
        first.1.min(second.1),
        (first.0 + first.2).max(second.0 + second.2),
        (first.1 + first.3).max(second.1 + second.3),
    );
    let target = rect("#target");
    let plain = rect("#plain");
    assert!((target.2 - plain.2).abs() > 0.01);
    assert!((target.3 - plain.3).abs() > 0.01);
    assert!((target.0 - expected.0).abs() < 0.01);
    assert!((target.1 - expected.1).abs() < 0.01);
    assert!((target.0 + target.2 - expected.2).abs() < 0.01);
    assert!((target.1 + target.3 - expected.3).abs() < 0.01);
}

#[test]
fn true_3d_transform_is_still_dropped() {
    assert!(icon_transform("rotateX(45deg)").is_none());
}
