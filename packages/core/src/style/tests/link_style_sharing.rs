// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

/// Whether the first two elements matching `selector` hold the same computed style.
fn share_style(html: &str, selector: &str) -> bool {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let ids = dom.query_selector_all(selector).unwrap_or_default();
    assert!(ids.len() >= 2, "{selector} must match twice");
    let doc = dom.doc.borrow();
    let computed_style = |id: i32| {
        let node = doc.get_node(crate::blitz_node_id(id as u32)).expect("node");
        node.primary_styles().map(|s| (*s).clone()).expect("styled")
    };
    servo_arc::Arc::ptr_eq(&computed_style(ids[0]), &computed_style(ids[1]))
}

// The spans differ in class, so they share by rule node, which rules out cousin sharing for their
// children. Visited styles are off, so the links share by rule node too.
#[test]
fn cousin_links_share_style_by_rule_node() {
    let html = r##"<style>a { color: green }</style><div>
        <span class="x"><a href="#1">one</a></span><span class="y"><a href="#2">two</a></span>
    </div>"##;
    assert!(share_style(html, "a"));
}

#[test]
fn links_differing_in_rules_do_not_share() {
    let html = r##"<style>a { color: green } .y > a { color: red }</style><div>
        <span class="x"><a href="#1">one</a></span><span class="y"><a href="#2">two</a></span>
    </div>"##;
    assert!(!share_style(html, "a"));
}
