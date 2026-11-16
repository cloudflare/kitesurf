// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use blitz_dom::node::NodeData;
use serde_json::json;

use crate::DomHandle;

const BASE: &str = "https://test.example/";

const FALLBACKS: &str = concat!(
    "<head><noscript><img src=x><link rel=stylesheet href=a.css></noscript>",
    "<meta name=m></head>",
    "<body><noscript><p id=f>fb</p></noscript></body>",
);

const COVER: &str = r##"<!DOCTYPE html>
<html><head><style>
* { margin: 0; padding: 0; }
#go { position: absolute; top: 100px; left: 100px; width: 120px; height: 40px; }
.cover {
  display: block; position: fixed; inset: 0; width: 100%; height: 100%;
  background: #fff; z-index: 999999;
}
</style></head>
<body><button id=go>Go</button><div id=host></div>
<noscript class=cover><p id=fallback>JS required</p></noscript>
</body></html>"##;

fn element(dom: &DomHandle, selector: &str) -> Option<u32> {
    let id = dom.query_selector(selector).expect("selector parses");
    (id > 0).then_some(id as u32)
}

fn is_text(dom: &DomHandle, id: u32) -> bool {
    let doc = dom.doc.borrow();
    let internal = dom.resolve_node_id(id).expect("mapped node");
    let text = matches!(
        doc.get_node(internal).map(|n| &n.data),
        Some(NodeData::Text(_))
    );
    drop(doc);
    text
}

fn hit_reaches(dom: &DomHandle, x: f32, y: f32, target: u32) -> bool {
    let mut cur = dom.element_from_point(x, y);
    for _ in 0..16 {
        if cur < 0 {
            return false;
        }
        if cur as u32 == target {
            return true;
        }
        cur = dom.parent_id(cur as u32);
    }
    false
}

fn assert_inert(dom: &DomHandle, noscript: u32) {
    let go = element(dom, "#go").expect("#go exists");
    assert!(
        hit_reaches(dom, 160.0, 120.0, go),
        "the button is under the pointer"
    );
    assert!(
        !hit_reaches(dom, 160.0, 120.0, noscript),
        "the noscript takes no hit"
    );
    assert_eq!(
        dom.computed_style_value(noscript, "display").as_deref(),
        Some("none")
    );
}

#[test]
fn scripted_document_parses_noscript_as_raw_text() {
    let dom = DomHandle::scripted(FALLBACKS, BASE);
    assert_eq!(element(&dom, "#f"), None);
    assert_eq!(element(&dom, "img"), None);
    assert!(
        element(&dom, "head > meta[name=m]").is_some(),
        "the head was not ended"
    );

    let head_noscript = element(&dom, "head > noscript").expect("head noscript");
    let children = dom.child_ids(head_noscript);
    assert_eq!(children.len(), 1);
    assert!(is_text(&dom, children[0]));
    assert_eq!(
        dom.inner_html(head_noscript),
        "<img src=x><link rel=stylesheet href=a.css>"
    );

    let body_noscript = element(&dom, "body > noscript").expect("body noscript");
    assert_eq!(
        dom.outer_html(body_noscript),
        "<noscript><p id=f>fb</p></noscript>"
    );
}

#[test]
fn scripted_document_gives_noscript_no_box() {
    let dom = DomHandle::scripted(COVER, BASE);
    dom.resolve_layout();
    assert_eq!(element(&dom, "#fallback"), None);
    assert_inert(
        &dom,
        element(&dom, "noscript.cover").expect("parsed noscript"),
    );
}

#[test]
fn scripted_document_gives_inserted_noscript_no_box() {
    let html = COVER.replace(
        "<noscript class=cover><p id=fallback>JS required</p></noscript>",
        "",
    );
    let dom = DomHandle::scripted(&html, BASE);
    let host = element(&dom, "#host").expect("#host exists");
    let ops = json!([{
        "kind": "setInnerHtml",
        "node": host,
        "html": "<noscript class=cover><img id=dyn src=x.png></noscript>",
    }]);
    assert_eq!(
        dom.apply_ops(&ops.to_string()).expect("innerHTML applied"),
        1
    );
    dom.resolve_layout();
    assert_eq!(element(&dom, "#dyn"), None);
    let parsed = element(&dom, "#host > noscript").expect("noscript from innerHTML");
    assert_inert(&dom, parsed);

    dom.remove_node(parsed);
    let created = dom.create_element("noscript");
    assert!(dom.set_attribute(created, "class", "cover"));
    assert!(dom.append_child_node(host, created));
    dom.resolve_layout();
    assert_inert(&dom, created);
}

// A document from createHTMLDocument lives in the page's handle but has no browsing context:
// its nodes parse and serialize with scripting off while the page's own keep it on.
#[test]
fn scripted_handle_parses_and_serializes_a_scriptless_node_with_scripting_off() {
    let dom = DomHandle::scripted("<body></body>", BASE);
    let detached = dom.create_element("div");
    let page = dom.create_element("div");
    let html = "<noscript><p id=a>&lt;b&gt;</p>a &amp; b</noscript>";
    let ops = json!([
        { "kind": "setInnerHtml", "node": detached, "html": html, "scriptingOff": true },
        { "kind": "setInnerHtml", "node": page, "html": html },
    ]);
    assert_eq!(
        dom.apply_ops(&ops.to_string()).expect("innerHTML applied"),
        2
    );

    let fallback = dom.child_ids(dom.child_ids(detached)[0]);
    assert_eq!(fallback.len(), 2, "markup: an element and a text node");
    assert!(!is_text(&dom, fallback[0]));
    assert_eq!(
        dom.inner_html_without_scripting(detached),
        "<noscript><p id=\"a\">&lt;b&gt;</p>a &amp; b</noscript>"
    );
    assert_eq!(
        dom.outer_html_without_scripting(dom.child_ids(detached)[0]),
        "<noscript><p id=\"a\">&lt;b&gt;</p>a &amp; b</noscript>"
    );

    let inert = dom.child_ids(dom.child_ids(page)[0]);
    assert_eq!(inert.len(), 1, "the page's own noscript is one text node");
    assert!(is_text(&dom, inert[0]));
    assert_eq!(
        dom.inner_html(page),
        html,
        "its markup is that text, as written"
    );
}

#[test]
fn unscripted_document_keeps_noscript_markup() {
    let dom = DomHandle::new("<body><noscript><p id=f>fb</p></noscript>", BASE);
    assert!(element(&dom, "#f").is_some(), "fallback markup is live");

    let dom = DomHandle::new(COVER, BASE);
    dom.resolve_layout();
    let cover = element(&dom, "noscript.cover").expect("parsed noscript");
    assert_eq!(
        dom.computed_style_value(cover, "display").as_deref(),
        Some("block")
    );
    assert!(
        hit_reaches(&dom, 160.0, 120.0, cover),
        "the fallback covers the page"
    );
}
