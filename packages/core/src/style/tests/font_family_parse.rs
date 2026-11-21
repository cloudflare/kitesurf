// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

//! A `-webkit-`-prefixed function token is a family name, not a generic. Chrome keeps the
//! declaration and lets an unmatched `-webkit-generic(...)` fall through to the next family;
//! dropping the declaration instead would silently change the used font.

use crate::DomHandle;

fn family_of(style: &str) -> String {
    let html = format!(
        r#"<!DOCTYPE html><html><body><div id="t" style="font-family: {style}"></div></body></html>"#
    );
    let dom = DomHandle::new(&html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("target") as u32;
    dom.computed_style_value(id, "font-family")
        .unwrap_or_default()
}

#[test]
fn webkit_prefixed_function_is_a_family_name() {
    // The unmatched legacy name falls through to Ahem, so the declaration is kept.
    assert!(
        family_of("-webkit-generic(fangsong), Ahem").contains("Ahem"),
        "expected the declaration to survive: {:?}",
        family_of("-webkit-generic(fangsong), Ahem")
    );
}

#[test]
fn unprefixed_generic_function_stays_unparsed() {
    // No `generic()` support yet, so the declaration is dropped and the inherited value wins.
    assert_eq!(family_of("generic(fangsong), Ahem"), family_of("serif"));
}

#[test]
fn webkit_keyword_family_names_still_parse() {
    for name in ["-webkit-body", "-webkit-standard", "-webkit-pictograph"] {
        let value = family_of(&format!("{name}, Ahem"));
        assert!(
            value.contains(name) && value.contains("Ahem"),
            "{name} should parse as a family name, got {value:?}"
        );
    }
}
