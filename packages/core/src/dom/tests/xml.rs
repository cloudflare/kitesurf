// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Every expected string is what Chrome's XMLSerializer returns for the same node, recorded
// from Chrome rather than derived from the specification.

use crate::DomHandle;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

const FIXTURE: &str = concat!(
    "<html><head></head><body>",
    r#"<p id="p" class="x y" data-q='he said "hi" &amp; &lt;left&gt;' title="a&#9;b">"#,
    r#"text &amp; more<br><img alt=""><input disabled></p>"#,
    r##"<svg id="svg" width="10" height="10"><circle r="4"/><a xlink:href="#x">l</a>"##,
    "<foreignObject><div>h</div></foreignObject></svg>",
    r#"<math id="math"><mi>x</mi></math>"#,
    r#"<div id="raw"><script>var a = 1 < 2 && "x";</script><style>p > b { color: red }</style>"#,
    "<textarea>raw &lt;b&gt;</textarea><!-- note --></div>",
    r#"<template id="tpl"><b>in</b></template><div id="empty"></div>"#,
    r#"<svg id="declared" xmlns="http://www.w3.org/2000/svg" "#,
    r##"xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>"##,
    "</body></html>",
);

fn fixture() -> DomHandle {
    DomHandle::new(FIXTURE, "https://example.test/")
}

fn xml(dom: &DomHandle, id: &str) -> String {
    let node = u32::try_from(dom.get_element_by_id(id)).expect("element");
    dom.serialize_xml(node, "")
}

#[test]
fn declares_the_namespace_on_the_root_and_wherever_it_changes() {
    let dom = fixture();

    assert_eq!(
        xml(&dom, "svg"),
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" id="svg" width="10" height="10">"#,
            r#"<circle r="4"/>"#,
            r##"<a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#x">l</a>"##,
            r#"<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">h</div></foreignObject>"#,
            "</svg>",
        )
    );
    assert_eq!(
        xml(&dom, "math"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" id="math"><mi>x</mi></math>"#
    );
}

#[test]
fn closes_an_empty_element_by_its_namespace_and_name() {
    let dom = fixture();

    // An HTML void element takes " />", another empty HTML element an end tag, and an
    // empty element of any other namespace "/>", as the circle in the test above.
    assert_eq!(
        xml(&dom, "p"),
        concat!(
            r#"<p xmlns="http://www.w3.org/1999/xhtml" id="p" class="x y" "#,
            r#"data-q="he said &quot;hi&quot; &amp; &lt;left&gt;" title="a&#9;b">"#,
            r#"text &amp; more<br /><img alt="" /><input disabled="" /></p>"#,
        )
    );
    assert_eq!(
        xml(&dom, "empty"),
        r#"<div xmlns="http://www.w3.org/1999/xhtml" id="empty"></div>"#
    );
}

#[test]
fn escapes_the_text_of_script_and_style_which_html_leaves_raw() {
    let dom = fixture();

    assert_eq!(
        xml(&dom, "raw"),
        concat!(
            r#"<div xmlns="http://www.w3.org/1999/xhtml" id="raw">"#,
            r#"<script>var a = 1 &lt; 2 &amp;&amp; "x";</script>"#,
            "<style>p &gt; b { color: red }</style>",
            "<textarea>raw &lt;b&gt;</textarea><!-- note --></div>",
        )
    );
}

#[test]
fn leaves_a_declaration_the_element_carries_where_it_is() {
    let dom = fixture();

    assert_eq!(
        xml(&dom, "declared"),
        concat!(
            r#"<svg id="declared" xmlns="http://www.w3.org/2000/svg" "#,
            r##"xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>"##,
        )
    );

    // A plain attribute named xmlns stands for the declaration only when it names the
    // element's own namespace; with another value both are written.
    let same = dom.create_element_ns(SVG_NS, "svg");
    assert!(dom.set_attribute(same, "xmlns", SVG_NS));
    assert_eq!(
        dom.serialize_xml(same, ""),
        r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#
    );
    let other = dom.create_element_ns(SVG_NS, "svg");
    assert!(dom.set_attribute(other, "xmlns", "urn:x"));
    assert_eq!(
        dom.serialize_xml(other, ""),
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns="urn:x"/>"#
    );
}

#[test]
fn declares_the_prefix_of_an_attribute_a_script_gave_a_namespace() {
    let dom = fixture();
    let use_with = |href: &str| {
        let element = dom.create_element_ns(SVG_NS, "use");
        assert!(dom.set_attribute(element, "xlink:href", href));
        element
    };
    let scripted = |element: u32| format!("{element}\txlink:href\t{XLINK_NS}");

    // setAttributeNS gives the attribute a namespace, which the caller passes in; the same
    // name set with setAttribute has none and is written as a plain attribute.
    let namespaced = use_with("#a");
    assert_eq!(
        dom.serialize_xml(namespaced, &scripted(namespaced)),
        concat!(
            r#"<use xmlns="http://www.w3.org/2000/svg" "#,
            r##"xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>"##,
        )
    );
    assert_eq!(
        dom.serialize_xml(use_with("#a"), ""),
        r##"<use xmlns="http://www.w3.org/2000/svg" xlink:href="#a"/>"##
    );

    // A declaration generated for one element does not reach its sibling, and one that an
    // ancestor carries covers them both.
    let (first, second) = (use_with("#a"), use_with("#b"));
    let group = dom.create_element_ns(SVG_NS, "g");
    assert!(dom.append_child_node(group, first) && dom.append_child_node(group, second));
    let hints = format!("{}\n{}", scripted(first), scripted(second));
    assert_eq!(
        dom.serialize_xml(group, &hints),
        concat!(
            r#"<g xmlns="http://www.w3.org/2000/svg">"#,
            r##"<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>"##,
            r##"<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#b"/></g>"##,
        )
    );
    assert!(dom.set_attribute(group, "xmlns:xlink", XLINK_NS));
    assert_eq!(
        dom.serialize_xml(group, &hints),
        concat!(
            r#"<g xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">"#,
            r##"<use xlink:href="#a"/><use xlink:href="#b"/></g>"##,
        )
    );
}

#[test]
fn writes_a_templates_content_before_and_after_it_is_moved() {
    let dom = fixture();
    let expected =
        r#"<template xmlns="http://www.w3.org/1999/xhtml" id="tpl"><b>in</b></template>"#;
    assert_eq!(xml(&dom, "tpl"), expected);

    // What the DOM shim does the first time a script reads template.content: the children
    // move to a detached node, and the core is told which.
    let template = u32::try_from(dom.get_element_by_id("tpl")).expect("template");
    let contents = dom.create_element("#document-fragment");
    for child in dom.child_ids(template) {
        assert!(dom.remove_node(child) && dom.append_child_node(contents, child));
    }
    assert!(dom.set_template_contents(template, contents));
    assert_eq!(xml(&dom, "tpl"), expected);
}

const DEEP_NESTING: usize = 8_000;
// Recursive serialization of this many levels overflows the stack below, as it would the
// wasm call stack.
const SMALL_STACK_BYTES: usize = 1024 * 1024;

#[test]
fn serializes_a_subtree_nested_deeper_than_the_call_stack() {
    let html = format!(
        "<html><head></head><body>{}leaf{}</body></html>",
        "<div>".repeat(DEEP_NESTING),
        "</div>".repeat(DEEP_NESTING)
    );
    let out = std::thread::Builder::new()
        .stack_size(SMALL_STACK_BYTES)
        .spawn(move || DomHandle::new(&html, "https://example.test/").serialize_xml(0, ""))
        .expect("spawn serializer thread")
        .join()
        .expect("serializer thread");

    assert_eq!(out.matches("<div>").count(), DEEP_NESTING);
    assert!(out.starts_with(r#"<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>"#));
    assert!(out.contains("<div>leaf</div>"));
    assert!(out.ends_with("</div></body></html>"));
}

#[test]
fn returns_nothing_for_a_node_that_is_gone() {
    let dom = fixture();
    let empty = u32::try_from(dom.get_element_by_id("empty")).expect("element");
    assert!(dom.drop_node(empty));

    assert_eq!(dom.serialize_xml(empty, ""), "");
}
