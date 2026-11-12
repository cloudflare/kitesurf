// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

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
         <p title=\"a&lt;b&gt;c&amp;d&quot;e&nbsp;f\">x</p></body></html>",
        "https://example.test/",
    );

    assert_eq!(
        dom.outer_html(0),
        "<html><head></head><body>\
         <p title=\"a&lt;b&gt;c&amp;d&quot;e&nbsp;f\">x</p></body></html>"
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
