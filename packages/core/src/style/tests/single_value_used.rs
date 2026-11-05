// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! `computedStyleValue` answers used-value longhands (margins, sizes, insets) itself, with the
//! bulk list's exact value, so a script reading one property does not serialize every longhand.

#![cfg(test)]

use crate::DomHandle;

const USED_VALUE_LONGHANDS: &[&str] = &[
    "grid-template-columns",
    "grid-template-rows",
    "transform",
    "transform-origin",
    "perspective-origin",
    "width",
    "height",
    "inline-size",
    "block-size",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "margin-block-start",
    "margin-block-end",
    "margin-inline-start",
    "margin-inline-end",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "padding-block-start",
    "padding-block-end",
    "padding-inline-start",
    "padding-inline-end",
    "min-width",
    "min-height",
    "min-inline-size",
    "min-block-size",
    "top",
    "right",
    "bottom",
    "left",
    "inset-block-start",
    "inset-block-end",
    "inset-inline-start",
    "inset-inline-end",
];

const PAGE: &str = r#"<!DOCTYPE html><body style="margin:0;height:3000px">
<div id="pct" style="width:50%;margin:5% auto 10px;padding:2% 3px"></div>
<div id="auto" style="width:200px;margin:0 auto;box-sizing:border-box;padding:0 10%"></div>
<p><span id="inline" style="margin:0 4%;padding:1em">x</span></p>
<div id="float" style="float:left;width:30%;margin:2%">f</div>
<div style="position:relative;height:100px"><div id="abs" style="position:absolute;left:10%;top:5px;right:auto;width:40px"></div></div>
<div id="sticky" style="position:sticky;top:10%;height:20px"></div>
<div id="none" style="display:none;margin:7%;width:10px"></div>
<div id="contents" style="display:contents;margin:3%"></div>
<div id="grid" style="display:grid;grid-template-columns:1fr 2fr;grid-template-rows:auto"><i>a</i><i>b</i></div>
<div id="xf" style="width:80px;height:40px;transform:rotate(45deg) translate(10%);transform-origin:20% 30%;perspective-origin:10% 90%"></div>
<div style="display:flex"><div id="flexitem" style="min-width:auto;margin:auto">m</div></div>
<div id="vertical" style="writing-mode:vertical-rl;width:100px;height:120px;margin:1px 2px 3px 4px;padding:5% 6px"></div>
</body>"#;

const IDS: &[&str] = &[
    "pct", "auto", "inline", "float", "abs", "sticky", "none", "contents", "grid", "xf",
    "flexitem", "vertical",
];

#[test]
fn single_value_matches_bulk_for_used_value_longhands() {
    let dom = DomHandle::new(PAGE, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    for id in IDS {
        let node = dom.query_selector(&format!("#{id}")).expect("query ok");
        assert!(node > 0, "#{id} found");
        let node = node as u32;
        let bulk = dom.computed_props(node).expect("document not borrowed");
        for name in USED_VALUE_LONGHANDS {
            let expected = bulk
                .iter()
                .find(|p| p.name == *name)
                .map(|p| p.value.clone());
            assert_eq!(
                dom.computed_style_value(node, name),
                expected,
                "#{id} {name}"
            );
        }
    }
}
