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
    let spliced = DomHandle::new_utf8(source.as_bytes(), doctype_end, "<!--marker-->", url);
    let joined = DomHandle::new("<!DOCTYPE html><!--marker--><p>é</p>", url);
    assert_eq!(spliced.outer_html(0), joined.outer_html(0));

    let plain = DomHandle::new(source, url);
    assert_eq!(
        DomHandle::new_utf8(source.as_bytes(), 0, "", url).outer_html(0),
        plain.outer_html(0)
    );
    // An offset inside "é" is not a char boundary, so nothing is spliced in.
    let inside = source.find('é').unwrap_or(0) + 1;
    let unspliced = DomHandle::new_utf8(source.as_bytes(), inside, "<!--marker-->", url);
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
    let utf8 = |marker: &str, doctype: &str| drain(dom.outer_html_bytes(0, marker, doctype), 3);

    assert!(plain.starts_with("<!--m--><!--c--><html>"));
    assert_eq!(utf8("", ""), plain);
    assert_eq!(utf8("", "<!DOCTYPE html>"), plain);
    assert_eq!(utf8("<!--m-->", ""), plain.replacen("<!--m-->", "", 1));
    assert_eq!(
        utf8("<!--m-->", "<!DOCTYPE html>"),
        format!("<!DOCTYPE html>{}", plain.replacen("<!--m-->", "", 1))
    );
    assert_eq!(utf8("<!--absent-->", "<!DOCTYPE html>"), plain);

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
    let mut zero = dom.outer_html_bytes(0, "", "");
    assert_eq!(zero.next_chunk(0).len(), 1);
    assert!(DomHandle::new("", "https://example.test/")
        .outer_html_bytes(9_999, "", "")
        .next_chunk(8)
        .is_empty());
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
    let cases = [("<!--m-->", "<!DOCTYPE html>"), ("<!--m-->", ""), ("", "")];
    for source in &sources {
        let dom = DomHandle::new(source, url);
        let p = dom.query_selector("p").ok().filter(|&id| id > 0);
        let nodes = [Some(0), p.map(|id| id as u32)];
        for node in nodes.into_iter().flatten() {
            for (marker, doctype) in cases {
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

#[test]
fn a_tree_changed_between_pulls_ends_the_stream_short() {
    let url = "https://example.test/";
    let source =
        "<div id=\"a\" title=\"one\"><p id=\"b\">text</p><i id=\"c\">c</i></div><b>end</b>";
    // (id, mutation): same-length attribute, longer and shorter text, removal, insertion.
    type Change = fn(&DomHandle, u32);
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
