// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

fn width(dom: &DomHandle, selector: &str) -> f32 {
    let id = dom.query_selector(selector).expect("query parses");
    assert!(id > 0, "{selector} must exist");
    dom.test_get_inline_aware_rect(id as u32).2
}

#[test]
fn a_span_with_its_own_font_family_is_shaped_in_that_family() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><html><body style="margin: 0">
<div style="font: 20px serif">
<div id=mixed style="display: inline-block">iiiiiiii<span style="font-family: monospace">iiiiiiii</span>iiiiiiii</div>
</div>
<div style="font: 20px serif">
<div id=serif style="display: inline-block">iiiiiiiiiiiiiiiiiiiiiiii</div>
</div>
</body></html>"#,
        "https://test.example/",
    );
    dom.resolve_layout();
    let mixed = width(&dom, "#mixed");
    let serif = width(&dom, "#serif");
    assert!(
        mixed > serif + 10.0,
        "monospace i is wider than serif i, so the mixed line is wider ({mixed} vs {serif})"
    );
}
