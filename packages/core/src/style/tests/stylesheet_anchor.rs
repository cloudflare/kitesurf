// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use ::style::stylesheets::Origin;

#[test]
fn insert_before_an_unregistered_anchor_appends() {
    let html = r##"<!DOCTYPE html>
<html><head><style>.a { color: red; }</style></head><body><p class="a">x</p></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let mut doc = dom.doc.borrow_mut();
    let doc = doc.as_mut();
    let before = doc.stylist.sheet_count(Origin::Author);
    let ghost = doc.make_stylesheet(".ghost { color: blue; }", Origin::Author);
    let sheet = doc.make_stylesheet(".b { color: green; }", Origin::Author);
    let lock = sheet.0.shared_lock.clone();
    doc.stylist
        .insert_stylesheet_before(sheet, ghost, &lock.read());
    assert_eq!(doc.stylist.sheet_count(Origin::Author), before + 1);
}
