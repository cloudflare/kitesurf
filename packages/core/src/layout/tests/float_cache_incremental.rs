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

// The float and the paragraphs are siblings, as on Wikipedia, so the
// paragraphs place no floats and keep their taffy cache entries.
const SIBLING_FLOAT: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0;font:10px/10px monospace}
 #wrap{width:300px}
 #f{float:right;width:100px}
 p{margin:0}
</style></head><body>
<div id="wrap">
 <div id="f"><div id="grow" style="height:10px"></div></div>
 <p id="near">near near near near near near near near near near near near near near near near near near near near near near near near near near near near near near near near near</p>
 <p id="far">far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far far</p>
</div></body></html>"#;

#[test]
fn paragraphs_rewrap_when_a_sibling_float_resizes() {
    let heights = |incremental: bool, grow: &str| {
        let dom = DomHandle::new(SIBLING_FLOAT, "https://example.test/");
        dom.set_viewport(800, 600);
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        let grow_id = dom.query_selector("#grow").unwrap_or(-1) as u32;
        let near = dom.query_selector("#near").unwrap_or(-1) as u32;
        let far = dom.query_selector("#far").unwrap_or(-1) as u32;
        dom.resolve_layout();
        dom.set_attribute(grow_id, "style", grow);
        dom.resolve_layout();
        let (.., near_height) = dom.test_get_inline_aware_rect(near);
        let (.., far_height) = dom.test_get_inline_aware_rect(far);
        (near_height, far_height)
    };

    for grow in ["height:400px", "height:0"] {
        let full = heights(false, grow);
        assert_eq!(
            heights(true, grow),
            full,
            "incremental layout kept line breaks from the old float ({grow})"
        );
    }
    assert!(
        heights(false, "height:400px").1 > heights(false, "height:0").1,
        "control: the tall float must narrow the far paragraph"
    );
}

// The first section's float hangs into the second, as Wikipedia's lead
// figures hang into the History section.
const HANGING_FLOAT: &str = r#"<!doctype html><html><head><style>
 html,body{margin:0;font:10px/10px monospace}
 #wrap{width:300px}
 .f{float:right;clear:right;width:100px}
 p{margin:0}
</style></head><body>
<div id="wrap">
 <section><div class="f" style="height:100px"></div><p>first</p></section>
 <section><div class="f" id="second" style="height:50px"></div><p>second</p></section>
 <section><p id="last">last</p></section>
</div></body></html>"#;

#[test]
fn a_cached_block_still_registers_its_floats() {
    let second_y = |incremental: bool| {
        let dom = DomHandle::new(HANGING_FLOAT, "https://example.test/");
        dom.set_viewport(800, 600);
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        let second = dom.query_selector("#second").unwrap_or(-1) as u32;
        let last = dom.query_selector("#last").unwrap_or(-1) as u32;
        dom.resolve_layout();
        dom.set_attribute(last, "style", "height:20px");
        dom.resolve_layout();
        dom.test_get_inline_aware_rect(second).1
    };

    let full = second_y(false);
    assert!(
        full >= 100.0,
        "control: the second float must clear the first ({full})"
    );
    assert_eq!(
        second_y(true),
        full,
        "the first section hit the cache and left its float out of the context"
    );
}

// A flex item measures its children before it lays them out. A box with a
// fixed height returns its size from that pass without visiting its float.
fn measured_hanging_float(first_section: &str) -> String {
    format!(
        r#"<!doctype html><html><head><style>
 html,body{{margin:0;font:10px/10px monospace}}
 #wrap{{display:flex;width:300px}}
 #item{{flex:1}}
 .f{{float:right;clear:right;width:100px}}
 p{{margin:0}}
</style></head><body>
<div id="wrap"><div id="item">
 <section style="height:20px">{first_section}</section>
 <section><div class="f" id="second" style="height:50px"></div><p>second</p></section>
 <section><p id="last">last</p></section>
</div></div></body></html>"#
    )
}

#[test]
fn a_size_only_pass_keeps_a_float_holder_out_of_the_cache() {
    let second_y = |html: &str, incremental: bool| {
        let dom = DomHandle::new(html, "https://example.test/");
        dom.set_viewport(800, 600);
        dom.doc
            .borrow_mut()
            .as_mut()
            .set_incremental_layout(incremental);
        let second = dom.query_selector("#second").unwrap_or(-1) as u32;
        let last = dom.query_selector("#last").unwrap_or(-1) as u32;
        dom.resolve_layout();
        dom.set_attribute(last, "style", "height:20px");
        dom.resolve_layout();
        dom.test_get_inline_aware_rect(second).1
    };

    let stale: Vec<_> = [
        (
            "block child",
            r#"<div class="f" style="height:100px"></div>"#,
        ),
        (
            "inline content",
            r#"first <span class="f" style="height:100px"></span> text"#,
        ),
    ]
    .into_iter()
    .filter_map(|(kind, first_section)| {
        let html = measured_hanging_float(first_section);
        let full = second_y(&html, false);
        assert!(
            full >= 100.0,
            "control: the second float must clear the first ({kind}: {full})"
        );
        let incremental = second_y(&html, true);
        (incremental != full).then_some((kind, incremental, full))
    })
    .collect();
    assert!(
        stale.is_empty(),
        "the size-only pass let the float's box hit the cache: {stale:?}"
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
