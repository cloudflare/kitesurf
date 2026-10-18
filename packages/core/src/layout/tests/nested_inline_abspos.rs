// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const NESTED: &str = r#"<!DOCTYPE html><style>
.parent { position: relative; }
.inline-content {
  display: inline-block; top: 0; left: 0;
  width: 100px; height: 100px; position: absolute; background-color: green;
}
</style>
<p>Test passes if there is a filled green square.</p>
<div><span><span><span><span><span><span><span><span class=parent>
<div class=inline-content></div>
</span></span></span></span></span></span></span></div>"#;

const FLAT: &str = r#"<!DOCTYPE html><style>
.parent { position: relative; }
.inline-content {
  display: inline-block; top: 0; left: 0;
  width: 100px; height: 100px; position: absolute; background-color: green;
}
</style>
<p>Test passes if there is a filled green square.</p>
<div><span class=parent>
<div class=inline-content></div>
</span></div>"#;

const REF: &str = r#"<!DOCTYPE html>
<p>Test passes if there is a filled green square.</p>
<div style="width:100px; height:100px; background:green;"></div>"#;

fn green_square(html: &str, selector: &str, inc: bool) -> (f32, f32, f32, f32) {
    let dom = DomHandle::new(html, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(inc);
    let node = dom.query_selector(selector).unwrap_or(-1);
    assert!(node > 0, "{selector} must exist");
    dom.resolve_layout();
    dom.test_get_inline_aware_rect(node as u32)
}

#[test]
fn nesting_depth_does_not_offset_an_abspos_child_of_a_relative_inline() {
    for inc in [false, true] {
        let flat = green_square(FLAT, ".inline-content", inc);
        let nested = green_square(NESTED, ".inline-content", inc);
        assert_eq!(
            flat, nested,
            "incremental={inc}: nesting empty spans moved the abspos box \
             from {flat:?} to {nested:?}"
        );
    }
}

#[test]
fn abspos_child_of_a_relative_inline_matches_the_reference_square() {
    for inc in [false, true] {
        let want = green_square(REF, "div", inc);
        for (name, html) in [("flat", FLAT), ("nested", NESTED)] {
            let got = green_square(html, ".inline-content", inc);
            assert_eq!(
                want, got,
                "incremental={inc} {name}: green square at {got:?}, \
                 reference has it at {want:?}"
            );
        }
    }
}

#[test]
fn an_empty_bidi_isolated_inline_makes_no_line_box() {
    for (label, span) in [
        (
            "dir",
            r#"<span dir="ltr"><div style="position:absolute;inset:0"></div></span>"#,
        ),
        ("isolate", r#"<span style="unicode-bidi:isolate"></span>"#),
        ("embed", r#"<span style="unicode-bidi:embed"></span>"#),
    ] {
        let html = format!(
            r#"<!DOCTYPE html><body style="margin:0"><div style="position:relative;line-height:1.6">{span}<div id="after" style="height:10px"></div></div>"#
        );
        let dom = DomHandle::new(&html, "https://example.test/");
        dom.set_viewport(800, 600);
        dom.resolve_layout();
        let node = dom.query_selector("#after").unwrap();
        let (_, y, _, _) = dom.test_get_inline_aware_rect(node as u32);
        assert_eq!(y, 0.0, "{label}: the empty inline grew a line box");
    }
}

#[test]
fn a_bidi_isolated_inline_with_text_keeps_its_line() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><body style="margin:0"><div style="line-height:20px"><span dir="ltr">x</span><div id="after" style="height:10px"></div></div>"#,
        "https://example.test/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let node = dom.query_selector("#after").unwrap();
    let (_, y, _, _) = dom.test_get_inline_aware_rect(node as u32);
    assert_eq!(y, 20.0);
}
