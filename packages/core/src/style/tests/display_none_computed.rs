// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// getComputedStyle inside a display:none subtree: the element is not laid out,
// but the cascade still computes its values.
// https://drafts.csswg.org/cssom/#resolved-values

use crate::DomHandle;

fn value(html: &str, selector: &str, name: &str) -> Option<String> {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector(selector).unwrap_or(-1);
    assert!(id > 0, "{selector} must match");
    dom.computed_style_value(id as u32, name)
}

const PAGE: &str = r#"<html><head><style>
  #hidden { display: none; }
  #inner { color: rgb(1, 2, 3); font-size: 21px; }
</style></head><body>
  <div id="hidden"><span id="inner">x</span></div>
  <span id="shown">y</span>
</body></html>"#;

#[test]
fn display_none_subtree_still_has_computed_values() {
    assert_eq!(
        value(PAGE, "#inner", "color").as_deref(),
        Some("rgb(1, 2, 3)"),
        "color inside display:none"
    );
    assert_eq!(
        value(PAGE, "#inner", "font-size").as_deref(),
        Some("21px"),
        "font-size inside display:none"
    );
}

#[test]
fn a_rendered_sibling_keeps_its_values() {
    assert_eq!(
        value(PAGE, "#shown", "color").as_deref(),
        Some("rgb(0, 0, 0)")
    );
}
