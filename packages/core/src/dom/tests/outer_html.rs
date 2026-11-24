// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::dom::tree::{matches_leading_doctype, OuterHtmlBytes, OuterHtmlStream};
use crate::DomHandle;

const DEEP_NESTING: usize = 8_000;
// Recursive serialization of DEEP_NESTING levels overflows this stack, as it did the wasm one.
const SMALL_STACK_BYTES: usize = 1024 * 1024;

#[test]
fn serializes_a_document_nested_deeper_than_the_call_stack() {
    let html = format!(
        "{}leaf{}",
        "<div>".repeat(DEEP_NESTING),
        "</div>".repeat(DEEP_NESTING)
    );
    // DomHandle is not Send, so it is built on the small-stack thread too.
    let out = std::thread::Builder::new()
        .stack_size(SMALL_STACK_BYTES)
        .spawn(move || DomHandle::new(&html, "https://example.test/").outer_html(0))
        .expect("spawn serializer thread")
        .join()
        .expect("serializer thread");

    assert_eq!(out.matches("<div>").count(), DEEP_NESTING);
    assert_eq!(out.matches("</div>").count(), DEEP_NESTING);
    assert!(out.contains("<div>leaf</div>"));
    assert!(out.ends_with("</div></body></html>"));
}

#[test]
fn sizes_serialized_html_exactly_for_escapes_and_multibyte_text() {
    let dom = DomHandle::new(
        "<body><p title='\"q\" &amp; é'>a&nbsp;&lt;b&gt; 𝔽 é</p>\
         <script>if (a < b) {}</script><input type=checkbox checked><!--ü--></body>",
        "https://example.test/",
    );
    let body = dom.query_selector("body").expect("query ok") as u32;
    let outer = dom.outer_html(0);
    let inner = dom.inner_html(body);

    assert!(outer.contains("<p title=\"&quot;q&quot; &amp; é\">a&nbsp;&lt;b&gt; 𝔽 é</p>"));
    assert!(outer.contains("<script>if (a < b) {}</script>"));
    assert!(outer.ends_with("<!--ü--></body></html>"));
    assert!(outer.ends_with(&format!("{inner}</body></html>")));
    assert_eq!(outer.capacity(), outer.len());
    assert_eq!(inner.capacity(), inner.len());
}

#[test]
fn spliced_source_parses_like_the_joined_source() {
    let url = "https://example.test/";
    let spliced = DomHandle::new_spliced("<!DOCTYPE html>", "<!--marker-->", "<p>é</p>", url);
    let joined = DomHandle::new("<!DOCTYPE html><!--marker--><p>é</p>", url);

    assert_eq!(spliced.outer_html(0), joined.outer_html(0));
    assert!(spliced.outer_html(0).starts_with("<!--marker--><html>"));
    assert_eq!(spliced.node_count(), joined.node_count());
}

#[test]
fn utf8_source_parses_like_the_string_source() {
    let url = "https://example.test/";
    let source = "<!DOCTYPE html><p>é</p>";
    let doctype_end = "<!DOCTYPE html>".len();
    let spliced = DomHandle::new_utf8(
        source.as_bytes(),
        doctype_end,
        "<!--marker-->",
        url,
        None,
        None,
    );
    let joined = DomHandle::new("<!DOCTYPE html><!--marker--><p>é</p>", url);
    assert_eq!(spliced.outer_html(0), joined.outer_html(0));

    let plain = DomHandle::new(source, url);
    assert_eq!(
        DomHandle::new_utf8(source.as_bytes(), 0, "", url, None, None).outer_html(0),
        plain.outer_html(0)
    );
    // An offset inside "é" is not a char boundary, so nothing is spliced in.
    let inside = source.find('é').expect("source has é") + 1;
    let unspliced =
        DomHandle::new_utf8(source.as_bytes(), inside, "<!--marker-->", url, None, None);
    assert_eq!(unspliced.outer_html(0), plain.outer_html(0));
}

#[test]
fn leading_doctype_check_matches_the_js_regex() {
    // Expected values follow /^(?:\s|<!--(?:(?!-->)[\s\S])*-->)*<!doctype\b/i in JS.
    let cases = [
        ("<!DOCTYPE html>", true),
        (" \n\t<!doctype html>", true),
        ("<!--a--> <!--b--><!DocType html>", true),
        (" \n<!-- a --><!----><!DOCTYPE html>", true),
        ("<!-- --!> --><!doctype html>", true),
        ("<!-- a --> x --><!doctype html>", false),
        ("<!-- open", false),
        ("<!--a--> x<!doctype html>", false),
        ("<!doctype", true),
        ("<!doctype-x>", true),
        ("<!doctypes>", false),
        ("<!doctype_>", false),
        ("\u{FEFF}\u{3000}<!doctype html>", true),
        ("\u{0085}<!doctype html>", false),
        ("<!---><!doctype html>", false),
        ("<!----><!doctype html>", true),
        ("<html><!doctype html>", false),
        ("<!--<!doctype html>", false),
        ("", false),
    ];
    for (input, expected) in cases {
        assert_eq!(matches_leading_doctype(input), expected, "{input:?}");
    }
}

#[test]
fn utf8_outer_html_strips_the_marker_and_restores_the_doctype() {
    let url = "https://example.test/";
    let dom = DomHandle::new("<!DOCTYPE html><!--m--><!--c--><p title=\"é\">𝔽</p>", url);
    let plain = dom.outer_html(0);
    let serialize =
        |marker: &str, doctype: &str| drain(dom.outer_html_bytes(0, marker, doctype), 3);

    assert!(plain.starts_with("<!--m--><!--c--><html>"));
    assert_eq!(serialize("", ""), plain);
    assert_eq!(serialize("", "<!DOCTYPE html>"), plain);
    assert_eq!(serialize("<!--m-->", ""), plain.replacen("<!--m-->", "", 1));
    assert_eq!(
        serialize("<!--m-->", "<!DOCTYPE html>"),
        format!("<!DOCTYPE html>{}", plain.replacen("<!--m-->", "", 1))
    );
    assert_eq!(serialize("<!--absent-->", "<!DOCTYPE html>"), plain);

    let prefixed = DomHandle::new("<!--m--><!--<!doctype x>--><p></p>", url);
    let kept = drain(
        prefixed.outer_html_bytes(0, "<!--m-->", "<!DOCTYPE html>"),
        1 << 20,
    );
    assert!(kept.starts_with("<!DOCTYPE html><!--<!doctype x>-->"));
}

/// Reads every chunk, checking each against `max` and the total against `byteLength`.
fn drain(mut bytes: OuterHtmlBytes, max: usize) -> String {
    let mut out = Vec::new();
    loop {
        let chunk = bytes.next_chunk(max);
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= max);
        out.extend_from_slice(&chunk);
    }
    assert_eq!(out.len(), bytes.byte_length());
    assert!(bytes.next_chunk(max).is_empty());
    String::from_utf8(out).expect("valid UTF-8")
}

#[test]
fn outer_html_bytes_split_multibyte_text_across_chunks() {
    let dom = DomHandle::new("<p>é𝔽ü</p>", "https://example.test/");
    let whole = dom.outer_html(0);

    for max in [1, 2, 5, whole.len(), whole.len() + 1] {
        assert_eq!(
            drain(dom.outer_html_bytes(0, "", ""), max),
            whole,
            "max {max}"
        );
    }
}

#[test]
fn a_zero_chunk_size_still_emits_a_byte() {
    let dom = DomHandle::new("<p>é𝔽ü</p>", "https://example.test/");

    assert_eq!(dom.outer_html_bytes(0, "", "").next_chunk(0).len(), 1);
}

#[test]
fn an_unknown_node_streams_no_bytes() {
    let dom = DomHandle::new("", "https://example.test/");

    assert!(dom.outer_html_bytes(9_999, "", "").next_chunk(8).is_empty());
}

/// Reads `stream` to the end, `max` bytes at a time, then calls `between` before each pull.
fn drain_stream(
    dom: &DomHandle,
    mut stream: OuterHtmlStream,
    max: usize,
    mut between: impl FnMut(usize),
) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    for pull in 0.. {
        if pull > 0 {
            between(pull);
        }
        let chunk = stream.next_chunk(dom, max);
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= max);
        out.extend_from_slice(&chunk);
    }
    assert!(stream.next_chunk(dom, max).is_empty());
    (out, stream.byte_length())
}

fn check_chunk_sizes(
    dom: &DomHandle,
    node: u32,
    marker: &str,
    doctype: &str,
    expected: &str,
    source_len: usize,
) {
    for max in [1, 3, 7, 64, 256 * 1024] {
        // Byte-at-a-time drains of the long sources dominate the suite runtime.
        if max < 7 && source_len > 10_000 {
            continue;
        }
        let stream = dom
            .outer_html_stream(node, marker, doctype)
            .expect("marker within the prefix");
        let (out, len) = drain_stream(dom, stream, max, |_| {});
        assert_eq!(len, expected.len());
        assert_eq!(String::from_utf8(out).unwrap(), expected, "{node} {max}");
    }
}

#[test]
fn streamed_output_equals_the_one_pass_output() {
    let url = "https://example.test/";
    let long = "é𝔽x".repeat(30_000);
    let sources = [
        "<!DOCTYPE html><!--m-->\n<!-- é --><p title=\"𝔽\">é𝔽 &amp; ü</p>".to_string(),
        "<!--m--><!--<!doctype x>--><p>é</p>".to_string(),
        "<!--a--><!--m--><!-- --><!-- --><!DOCTYPE html><p>é</p>".to_string(),
        "<!--m--><!doctypes><p>x</p>".to_string(),
        "<p>no marker 𝔽</p><script>a < b</script><br><template><i>t</i></template>".to_string(),
        format!("<!--m--><div id=\"long\"><p>{long}</p><textarea>{long}</textarea></div>"),
        String::new(),
    ];
    let marker_and_doctype = [("<!--m-->", "<!DOCTYPE html>"), ("<!--m-->", ""), ("", "")];
    for source in &sources {
        let dom = DomHandle::new(source, url);
        let paragraph = dom.query_selector("p").ok().filter(|&id| id > 0);
        let nodes = [Some(0), paragraph.map(|id| id as u32)];
        for node in nodes.into_iter().flatten() {
            for (marker, doctype) in marker_and_doctype {
                let expected = drain(dom.outer_html_bytes(node, marker, doctype), 1 << 30);
                check_chunk_sizes(&dom, node, marker, doctype, &expected, source.len());
            }
        }
    }
}

#[test]
fn stream_declines_a_marker_past_the_prefix() {
    let source = format!("<p>{}</p><!--m-->", "x".repeat(70 * 1024));
    let dom = DomHandle::new(&source, "https://example.test/");
    assert!(dom.outer_html_stream(0, "<!--m-->", "").is_none());
    assert!(dom.outer_html_stream(0, "<!--absent-->", "").is_some());
    assert!(dom.outer_html_stream(9_999, "", "").is_none());
}

#[test]
fn stream_declines_when_the_doctype_rule_needs_more_than_the_prefix() {
    let comment = "x".repeat(70 * 1024);
    let source = format!("<!--m--><!--{comment}--><!doctype html><p></p>");
    let dom = DomHandle::new(&source, "https://example.test/");
    // The prefix ends inside a leading comment, so whether a doctype follows is unknown.
    assert!(dom
        .outer_html_stream(0, "<!--m-->", "<!DOCTYPE html>")
        .is_none());
    assert!(dom.outer_html_stream(0, "<!--m-->", "").is_some());
}

#[test]
fn a_text_node_larger_than_a_chunk_streams_whole() {
    let script = "é".repeat(300 * 1024);
    let source = format!("<script>{script}</script><p>after</p>");
    let dom = DomHandle::new(&source, "https://example.test/");
    let expected = drain(dom.outer_html_bytes(0, "", ""), 1 << 30);
    let stream = dom.outer_html_stream(0, "", "").unwrap();
    let (out, _) = drain_stream(&dom, stream, 4093, |_| {});
    assert_eq!(String::from_utf8(out).unwrap(), expected);
}

/// Mutates the tree at `at_pull`, then checks the stream tore or matched the call-time snapshot.
fn assert_stream_torn_by_mutation(source: &str, selector: &str, change: Change, at_pull: usize) {
    let url = "https://example.test/";
    let dom = DomHandle::new(source, url);
    let full = dom.outer_html(0);
    let id = dom.query_selector(selector).unwrap() as u32;
    let stream = dom.outer_html_stream(0, "", "").unwrap();
    let (out, len) = drain_stream(&dom, stream, 1, |pull| {
        if pull == at_pull {
            change(&dom, id);
        }
    });

    assert_eq!(len, full.len());
    // A change to bytes already read leaves the rest as the call-time snapshot.
    let torn = out.len() < len;
    assert!(
        torn || out == full.as_bytes(),
        "{selector} at pull {at_pull}"
    );
    if at_pull == 1 {
        assert!(torn, "{selector} at pull {at_pull}");
    }
}

type Change = fn(&DomHandle, u32);

#[test]
fn a_tree_changed_between_pulls_ends_the_stream_short() {
    let source =
        "<div id=\"a\" title=\"one\"><p id=\"b\">text</p><i id=\"c\">c</i></div><b>end</b>";
    // (selector, mutation): same-length attribute, longer and shorter text, removal, insertion.
    let changes: [(&str, Change); 5] = [
        ("#a", |d, id| assert!(d.set_attribute(id, "title", "two"))),
        ("#b", |d, id| assert!(d.set_node_text(id, "longer text"))),
        ("#b", |d, id| assert!(d.set_node_text(id, "t"))),
        ("#c", |d, id| assert!(d.remove_node(id))),
        ("b", |d, id| {
            let child = d.create_element("u");
            assert!(d.append_child_node(id, child));
        }),
    ];

    for (selector, change) in changes {
        // Early pulls change emitted output, late pulls output still to come.
        for at_pull in [1, 20, 60] {
            assert_stream_torn_by_mutation(source, selector, change, at_pull);
        }
    }
}

#[test]
fn serializes_siblings_void_raw_text_and_comments_in_document_order() {
    let dom = DomHandle::new(
        "<html><head><style>a > b { color: red }</style></head>\
         <body><p class=\"x\">a &amp; b</p><!--note--><br><span>c</span></body></html>",
        "https://example.test/",
    );

    assert_eq!(
        dom.outer_html(0),
        "<html><head><style>a > b { color: red }</style></head>\
         <body><p class=\"x\">a &amp; b</p><!--note--><br><span>c</span></body></html>"
    );
}

#[test]
fn escapes_markup_characters_and_no_break_space_in_attribute_values() {
    let dom = DomHandle::new(
        "<html><head></head><body>\
         <p title=\"a&lt;b&gt;c&amp;d&quot;e&nbsp;f\u{a9}\">x</p></body></html>",
        "https://example.test/",
    );

    assert_eq!(
        dom.outer_html(0),
        "<html><head></head><body>\
         <p title=\"a&lt;b&gt;c&amp;d&quot;e&nbsp;f\u{a9}\">x</p></body></html>"
    );
}

#[test]
fn keeps_the_prefix_of_a_namespaced_attribute() {
    let dom = DomHandle::new(
        "<html><head></head><body><svg xmlns:xlink=\"http://www.w3.org/1999/xlink\">\
         <use xlink:href=\"#a\" xml:lang=\"en\"></use></svg></body></html>",
        "https://example.test/",
    );

    assert_eq!(
        dom.outer_html(0),
        "<html><head></head><body><svg xmlns:xlink=\"http://www.w3.org/1999/xlink\">\
         <use xlink:href=\"#a\" xml:lang=\"en\"></use></svg></body></html>"
    );
}

#[test]
fn writes_a_bare_xmlns_on_svg_and_math_without_a_prefix() {
    let html = "<html><head></head><body>\
                <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\">\
                <circle r=\"4\"></circle></svg>\
                <math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mi>x</mi></math>\
                </body></html>";
    let dom = DomHandle::new(html, "https://example.test/");

    assert_eq!(dom.outer_html(0), html);
}

#[test]
fn writes_the_checked_attribute_and_leaves_checkedness_to_the_snapshot() {
    let dom = DomHandle::new(
        "<html><head></head><body>\
         <input type=\"checkbox\" id=\"a\"><input type=\"checkbox\" id=\"b\" checked=\"checked\">\
         </body></html>",
        "https://example.test/",
    );
    let handle = |id: &str| u32::try_from(dom.get_element_by_id(id)).expect("element");
    // What a script or a click does: the first becomes checked and the second unchecked,
    // and neither touches an attribute.
    assert!(dom.set_checkbox_checked(handle("a"), true));
    assert!(dom.set_checkbox_checked(handle("b"), false));

    assert_eq!(
        dom.outer_html(0),
        "<html><head></head><body>\
         <input type=\"checkbox\" id=\"a\"><input type=\"checkbox\" id=\"b\" checked=\"checked\">\
         </body></html>"
    );
    assert_eq!(
        dom.snapshot_html(0),
        "<html><head></head><body>\
         <input checked=\"\" type=\"checkbox\" id=\"a\"><input type=\"checkbox\" id=\"b\">\
         </body></html>"
    );
    assert_eq!(
        dom.inner_html(handle("a")),
        "",
        "an input has no content either way"
    );
}

// What the DOM shim does the first time a script reads template.content: the children move to
// a detached node, and the core is told which.
fn move_template_content(dom: &DomHandle, template: u32) -> u32 {
    let contents = dom.create_element("#document-fragment");
    for child in dom.child_ids(template) {
        assert!(dom.remove_node(child));
        assert!(dom.append_child_node(contents, child));
    }
    assert!(dom.set_template_contents(template, contents));
    contents
}

fn element(dom: &DomHandle, id: &str) -> u32 {
    u32::try_from(dom.get_element_by_id(id)).expect("element")
}

#[test]
fn writes_a_templates_content_from_the_node_it_was_moved_to() {
    let dom = DomHandle::new(
        "<html><head></head><body>\
         <template id=\"t\"><b>in</b><template><i>deep</i></template></template>\
         </body></html>",
        "https://example.test/",
    );
    let template = element(&dom, "t");
    move_template_content(&dom, template);

    assert_eq!(
        dom.outer_html(template),
        "<template id=\"t\"><b>in</b><template><i>deep</i></template></template>"
    );
    assert_eq!(
        dom.inner_html(template),
        "<b>in</b><template><i>deep</i></template>"
    );
    let whole = "<html><head></head><body>\
                 <template id=\"t\"><b>in</b><template><i>deep</i></template></template>\
                 </body></html>";
    assert_eq!(dom.outer_html(0), whole);
    let stream = dom.outer_html_stream(0, "", "").expect("stream");
    let (streamed, _) = drain_stream(&dom, stream, 7, |_| {});
    assert_eq!(String::from_utf8(streamed).unwrap(), whole);

    // A node appended to the template element itself is not its content, and a browser
    // leaves it out of the serialization.
    let stray = dom.create_element("u");
    assert!(dom.append_child_node(template, stray));
    assert_eq!(
        dom.outer_html(template),
        "<template id=\"t\"><b>in</b><template><i>deep</i></template></template>"
    );
}

#[test]
fn a_template_inside_its_own_content_still_serializes() {
    let dom = DomHandle::new(
        "<html><head></head><body>\
         <template id=\"t\"><b>in</b></template><template id=\"a\"></template>\
         <template id=\"b\"></template></body></html>",
        "https://example.test/",
    );
    // The shim refuses both inserts, as Chrome does; if the core gets these trees anyway, the
    // serializer must still end.
    let t = element(&dom, "t");
    let contents = move_template_content(&dom, t);
    assert!(dom.remove_node(t) && dom.append_child_node(contents, t));
    let (a, b) = (element(&dom, "a"), element(&dom, "b"));
    let (a_contents, b_contents) = (
        move_template_content(&dom, a),
        move_template_content(&dom, b),
    );
    assert!(dom.remove_node(b) && dom.append_child_node(a_contents, b));
    assert!(dom.remove_node(a) && dom.append_child_node(b_contents, a));

    assert_eq!(
        dom.outer_html(t),
        "<template id=\"t\"><b>in</b><template id=\"t\"></template></template>"
    );
    assert_eq!(dom.inner_html(t), "<b>in</b><template id=\"t\"></template>");
    assert_eq!(
        dom.outer_html(a),
        "<template id=\"a\"><template id=\"b\"><template id=\"a\"></template></template></template>"
    );
}

#[test]
fn forgets_a_template_once_it_is_dropped() {
    let dom = DomHandle::new(
        "<html><head></head><body><div id=\"one\"><template id=\"a\"></template></div>\
         <div id=\"two\"><template id=\"b\"></template></div></body></html>",
        "https://example.test/",
    );
    move_template_content(&dom, element(&dom, "a"));
    move_template_content(&dom, element(&dom, "b"));
    assert_eq!(dom.template_contents.borrow().len(), 2);

    // innerHTML detaches the old children, which a script may still hold; the shim drops them
    // later through dropNode, which reports each node.
    let (one, a) = (element(&dom, "one"), element(&dom, "a"));
    let ops = format!(r#"[{{"kind":"setInnerHtml","node":{one},"html":"<p>x</p>"}}]"#);
    assert_eq!(dom.apply_ops(&ops).ok(), Some(1));
    assert_eq!(dom.template_contents.borrow().len(), 2);
    assert!(dom.drop_node(a));
    assert_eq!(dom.template_contents.borrow().len(), 1);
    // Setting an element's text drops its children without reporting them, so the core has to
    // notice that the template is gone.
    assert!(dom.set_node_text(element(&dom, "two"), "y"));
    assert!(dom.template_contents.borrow().is_empty());
}
