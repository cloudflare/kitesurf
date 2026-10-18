// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const TWO_FLOATS: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0;font:16px monospace}
 #wrap{width:200px}
 #first{float:left;width:200px}
 #grow{height:10px}
 #second{float:left;width:200px;height:50px}
</style></head><body>
<div id="wrap">
 <div id="a"><div id="first"><div id="grow"></div></div>a</div>
 <div id="b"><div id="second"></div>b</div>
</div></body></html>"#;

#[test]
fn a_grown_float_still_pushes_the_next_float_down() {
    let second_y = |incremental: bool| {
        let dom = DomHandle::new(TWO_FLOATS, "https://example.test/");
        dom.set_viewport(800, 600);
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        let grow = dom.query_selector("#grow").unwrap_or(-1) as u32;
        let second = dom.query_selector("#second").unwrap_or(-1) as u32;
        dom.resolve_layout();
        let (_, before, ..) = dom.test_get_inline_aware_rect(second);
        dom.set_attribute(grow, "style", "height:40px");
        dom.resolve_layout();
        let (_, after, ..) = dom.test_get_inline_aware_rect(second);
        (before, after)
    };

    let (before, full) = second_y(false);
    assert!(
        full > before,
        "control: the grown float must push the second one down ({before} -> {full})"
    );
    assert_eq!(
        second_y(true),
        (before, full),
        "incremental layout kept the pre-growth float bands"
    );
}

const ONE_FLOAT: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0}
 #c{width:400px}
 #f{float:left;width:50px;height:50px}
</style></head><body>
<div id="c"><div id="f"></div>text that wraps beside the float</div>
</body></html>"#;

#[test]
fn the_cache_bust_clears_once_the_float_is_gone() {
    let dom = DomHandle::new(ONE_FLOAT, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    let c = dom.query_selector("#c").unwrap_or(-1) as u32;
    let f = dom.query_selector("#f").unwrap_or(-1) as u32;

    dom.resolve_layout();
    assert!(
        dom.test_placed_floats(c),
        "the container that placed the float must bust its cache"
    );

    dom.set_attribute(f, "style", "float:none");
    dom.resolve_layout();
    assert!(
        !dom.test_placed_floats(c),
        "float-free container never rejoins the layout cache"
    );
}
