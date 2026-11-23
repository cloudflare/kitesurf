// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Every expected string is what Chrome's XMLSerializer returns for the same node, recorded
// from Chrome rather than derived from the specification.

use crate::DomHandle;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

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
    r#"<svg id="other" xmlns="urn:x"><g></g></svg>"#,
    r##"<svg id="wrong" xmlns:xlink="urn:wrong"><use xlink:href="#a"/></svg>"##,
    r#"<svg id="lang" xml:lang="en"><g xml:space="preserve"/></svg>"#,
    "</body></html>",
);

fn fixture() -> DomHandle {
    DomHandle::new(FIXTURE, "https://example.test/")
}

fn element(dom: &DomHandle, id: &str) -> u32 {
    u32::try_from(dom.get_element_by_id(id)).expect("element")
}

fn xml(dom: &DomHandle, id: &str) -> String {
    dom.serialize_xml(element(dom, id), "")
}

// What the shim sends for an attribute it set with setAttributeNS, which the tree stores under
// `stored` alone: one line of element id, stored name, prefix, local name and namespace.
fn scripted(element: u32, stored: &str, prefix: &str, local: &str, ns: &str) -> String {
    format!("{element}\t{stored}\t{prefix}\t{local}\t{ns}\n")
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
fn keeps_a_carried_declaration_only_when_it_names_the_right_namespace() {
    let dom = fixture();

    assert_eq!(
        xml(&dom, "declared"),
        concat!(
            r#"<svg id="declared" xmlns="http://www.w3.org/2000/svg" "#,
            r##"xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>"##,
        )
    );
    // A default declaration for another namespace is dropped, since it would put the element
    // there when the output is parsed again.
    assert_eq!(
        xml(&dom, "other"),
        r#"<svg xmlns="http://www.w3.org/2000/svg" id="other"><g/></svg>"#
    );
    // The xlink prefix is bound to another namespace on the svg, so it cannot name xlink:href
    // and a prefix is generated.
    assert_eq!(
        xml(&dom, "wrong"),
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" id="wrong" xmlns:xlink="urn:wrong">"#,
            r##"<use xmlns:ns1="http://www.w3.org/1999/xlink" ns1:href="#a"/></svg>"##,
        )
    );

    // The same declarations set from script: a default one stands where it names the element's
    // namespace, wherever it is, and is dropped elsewhere.
    let svg = dom.create_element_ns(SVG_NS, "svg");
    let (same, other) = (
        dom.create_element_ns(SVG_NS, "g"),
        dom.create_element_ns(SVG_NS, "g"),
    );
    assert!(dom.append_child_node(svg, same) && dom.append_child_node(svg, other));
    assert!(dom.set_attribute(svg, "id", "i") && dom.set_attribute(svg, "xmlns", SVG_NS));
    assert!(dom.set_attribute(same, "xmlns", SVG_NS) && dom.set_attribute(other, "xmlns", "urn:y"));
    let names = [svg, same, other]
        .map(|e| scripted(e, "xmlns", "", "xmlns", XMLNS_NS))
        .concat();
    assert_eq!(
        dom.serialize_xml(svg, &names),
        concat!(
            r#"<svg id="i" xmlns="http://www.w3.org/2000/svg">"#,
            r#"<g xmlns="http://www.w3.org/2000/svg"/><g/></svg>"#,
        )
    );
}

#[test]
fn writes_a_plain_xmlns_attribute_and_honours_it_only_for_the_elements_namespace() {
    let dom = fixture();
    let svg_with = |value: &str| {
        let svg = dom.create_element_ns(SVG_NS, "svg");
        assert!(dom.set_attribute(svg, "xmlns", value));
        svg
    };

    assert_eq!(
        dom.serialize_xml(svg_with(SVG_NS), ""),
        r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#
    );
    assert_eq!(
        dom.serialize_xml(svg_with("urn:x"), ""),
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns="urn:x"/>"#
    );

    // A plain xmlns:q attribute, set with setAttribute, is written but declares nothing, so the
    // child still needs a prefix for urn:q.
    let root = dom.create_element_ns("uri1", "r");
    let child = dom.create_element_ns("uri1", "e");
    assert!(dom.append_child_node(root, child));
    assert!(dom.set_attribute(root, "xmlns:q", "urn:q") && dom.set_attribute(child, "a", "1"));
    assert_eq!(
        dom.serialize_xml(root, &scripted(child, "a", "", "a", "urn:q")),
        r#"<r xmlns="uri1" xmlns:q="urn:q"><e xmlns:ns1="urn:q" ns1:a="1"/></r>"#
    );
}

#[test]
fn prefixes_an_attribute_a_script_gave_a_namespace() {
    let dom = fixture();
    let in_ns = |ns: &str, name: &str| dom.create_element_ns(ns, name);

    // An attribute keeps its own prefix when that is free, and gets a generated one when the
    // element has already bound the prefix to another namespace.
    let two = in_ns(SVG_NS, "use");
    assert!(dom.set_attribute(two, "p:a", "1") && dom.set_attribute(two, "p:b", "2"));
    let names = scripted(two, "p:a", "p", "a", XLINK_NS) + &scripted(two, "p:b", "p", "b", "urn:z");
    assert_eq!(
        dom.serialize_xml(two, &names),
        concat!(
            r#"<use xmlns="http://www.w3.org/2000/svg" xmlns:p="http://www.w3.org/1999/xlink" "#,
            r#"p:a="1" xmlns:ns1="urn:z" ns1:b="2"/>"#,
        )
    );

    // No prefix: one in scope for the namespace if there is one, else ns1, ns2... counted
    // across the whole call, and never one already bound.
    let b = in_ns("uri1", "b");
    assert!(dom.set_attribute(b, "foo", "v") && dom.set_attribute(b, "bar", "w"));
    let names = scripted(b, "foo", "", "foo", "urn:x") + &scripted(b, "bar", "", "bar", "urn:y");
    assert_eq!(
        dom.serialize_xml(b, &names),
        r#"<b xmlns="uri1" xmlns:ns1="urn:x" ns1:foo="v" xmlns:ns2="urn:y" ns2:bar="w"/>"#
    );
    let root = in_ns("uri1", "r");
    let (first, second) = (in_ns("uri1", "a"), in_ns("uri1", "b"));
    assert!(dom.append_child_node(root, first) && dom.append_child_node(root, second));
    assert!(dom.set_attribute(first, "foo", "a") && dom.set_attribute(second, "foo", "b"));
    let names = [first, second]
        .map(|e| scripted(e, "foo", "", "foo", "urn:x"))
        .concat();
    assert_eq!(
        dom.serialize_xml(root, &names),
        concat!(
            r#"<r xmlns="uri1"><a xmlns:ns1="urn:x" ns1:foo="a"/>"#,
            r#"<b xmlns:ns2="urn:x" ns2:foo="b"/></r>"#,
        )
    );
    let above = in_ns("uri1", "r");
    let under = in_ns("uri1", "e");
    assert!(dom.append_child_node(above, under));
    assert!(dom.set_attribute(above, "xmlns:q", "urn:q") && dom.set_attribute(under, "a", "1"));
    assert!(dom.set_attribute(above, "xmlns:ns1", "urn:taken"));
    assert!(dom.set_attribute(under, "c", "2"));
    let names = scripted(above, "xmlns:q", "xmlns", "q", XMLNS_NS)
        + &scripted(above, "xmlns:ns1", "xmlns", "ns1", XMLNS_NS)
        + &scripted(under, "a", "", "a", "urn:q")
        + &scripted(under, "c", "", "c", "urn:x");
    assert_eq!(
        dom.serialize_xml(above, &names),
        concat!(
            r#"<r xmlns="uri1" xmlns:q="urn:q" xmlns:ns1="urn:taken">"#,
            r#"<e q:a="1" xmlns:ns2="urn:x" ns2:c="2"/></r>"#,
        )
    );

    // An attribute in the element's own default namespace still needs a prefix, since a default
    // namespace never applies to attributes.
    let own = in_ns("uri1", "e");
    assert!(dom.set_attribute(own, "a", "1"));
    assert_eq!(
        dom.serialize_xml(own, &scripted(own, "a", "", "a", "uri1")),
        r#"<e xmlns="uri1" xmlns:ns1="uri1" ns1:a="1"/>"#
    );
}

#[test]
fn writes_the_xml_namespace_with_its_reserved_prefix_and_never_declares_it() {
    let dom = fixture();

    assert_eq!(
        xml(&dom, "lang"),
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" id="lang" xml:lang="en">"#,
            r#"<g xml:space="preserve"/></svg>"#,
        )
    );
    let foo = dom.create_element_ns(XML_NS, "foo");
    assert_eq!(dom.serialize_xml(foo, ""), "<xml:foo/>");
    let bar = dom.create_element_ns(XML_NS, "bar");
    let text = dom.create_text_node("t");
    assert!(dom.append_child_node(foo, bar) && dom.append_child_node(foo, text));
    assert_eq!(dom.serialize_xml(foo, ""), "<xml:foo><xml:bar/>t</xml:foo>");

    let svg = dom.create_element_ns(SVG_NS, "svg");
    assert!(dom.set_attribute(svg, "abc:foo", "test"));
    assert_eq!(
        dom.serialize_xml(svg, &scripted(svg, "abc:foo", "abc", "foo", XML_NS)),
        r#"<svg xmlns="http://www.w3.org/2000/svg" xml:foo="test"/>"#
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
    let template = element(&dom, "tpl");
    let contents = dom.create_element("#document-fragment");
    for child in dom.child_ids(template) {
        assert!(dom.remove_node(child) && dom.append_child_node(contents, child));
    }
    assert!(dom.set_template_contents(template, contents));
    assert_eq!(xml(&dom, "tpl"), expected);

    // The shim refuses to put a template inside its own content, as Chrome does; if the core gets
    // that tree anyway, the writer must still end.
    assert!(dom.remove_node(template) && dom.append_child_node(contents, template));
    assert_eq!(
        dom.serialize_xml(template, ""),
        concat!(
            r#"<template xmlns="http://www.w3.org/1999/xhtml" id="tpl"><b>in</b>"#,
            r#"<template id="tpl"></template></template>"#,
        )
    );
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
    let empty = element(&dom, "empty");
    assert!(dom.drop_node(empty));

    assert_eq!(dom.serialize_xml(empty, ""), "");
}
