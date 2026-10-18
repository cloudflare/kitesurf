// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn text_of(inner: &str) -> String {
    let html = format!("<html><body>{inner}</body></html>");
    let dom = DomHandle::new(&html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = {
        let sel = dom.query_selector("#t").unwrap_or(-1);
        if sel > 0 {
            sel
        } else {
            dom.query_selector("body > *").unwrap_or(-1)
        }
    };
    assert!(id > 0, "target element must exist for {inner:?}");
    let doc = dom.doc.borrow();
    crate::dom::inner_text::inner_text(&doc, crate::blitz_node_id(id as u32)).expect("rendered")
}

#[test]
fn collapses_whitespace_in_normal_mode() {
    assert_eq!(text_of("<div>abc"), "abc");
    assert_eq!(text_of("<div> abc"), "abc");
    assert_eq!(text_of("<div>abc "), "abc");
    assert_eq!(text_of("<div>abc  def"), "abc def");
    assert_eq!(text_of("<div>abc\ndef"), "abc def");
    assert_eq!(text_of("<div>abc\rdef"), "abc def");
    assert_eq!(text_of("<div>abc\tdef"), "abc def");
}

#[test]
fn hard_breaks_swallow_collapsible_space() {
    assert_eq!(text_of("<div>abc <br>def"), "abc\ndef");
    assert_eq!(text_of("<div>abc<br> def"), "abc\ndef");
    assert_eq!(text_of("<div><br>"), "\n");
}

#[test]
fn pre_preserves_and_pre_line_keeps_newlines() {
    assert_eq!(text_of("<pre id=t> abc</pre>"), " abc");
    assert_eq!(text_of("<pre id=t>abc </pre>"), "abc ");
    assert_eq!(text_of("<pre id=t>abc  def</pre>"), "abc  def");
    assert_eq!(text_of("<pre id=t>abc\ndef</pre>"), "abc\ndef");
    assert_eq!(text_of("<pre id=t>abc\rdef</pre>"), "abc\ndef");
    assert_eq!(text_of("<pre id=t>abc\tdef</pre>"), "abc\tdef");
    assert_eq!(
        text_of("<div id=t><pre>abc</pre><pre>def</pre></div>"),
        "abc\ndef"
    );
    assert_eq!(
        text_of("<div id=t style='white-space:pre-line'>abc \ndef</div>"),
        "abc\ndef"
    );
    assert_eq!(
        text_of("<div id=t style='white-space:pre-line'>abc\tdef</div>"),
        "abc def"
    );
}

#[test]
fn collapse_crosses_element_boundaries() {
    assert_eq!(text_of("<div id=t><span>abc </span> def</div>"), "abc def");
    assert_eq!(
        text_of("<div id=t><span>abc </span><span></span> def</div>"),
        "abc def"
    );
}

#[test]
fn atomic_inlines_are_collapse_barriers() {
    assert_eq!(text_of("<div id=t>abc <input> def</div>"), "abc  def");
    assert_eq!(
        text_of("<div id=t>abc <span style='display:inline-block'></span> def</div>"),
        "abc  def"
    );
    assert_eq!(
        text_of("<div id=t>abc <span style='display:inline-block'> def </span> ghi</div>"),
        "abc def ghi"
    );
}

#[test]
fn block_boundaries_emit_required_breaks() {
    assert_eq!(
        text_of("<div id=t><div>abc</div><div>def</div></div>"),
        "abc\ndef"
    );
    assert_eq!(
        text_of("<div id=t><p>abc</p><p>def</p></div>"),
        "abc\n\ndef"
    );
    assert_eq!(
        text_of("<div id=t>abc<div>def</div>ghi</div>"),
        "abc\ndef\nghi"
    );
    assert_eq!(text_of("<div id=t><p>abc</p></div>"), "abc");
}

#[test]
fn hidden_content_is_excluded() {
    assert_eq!(
        text_of("<div id=t>abc<span style='display:none'>def</span>ghi</div>"),
        "abcghi"
    );
    assert_eq!(
        text_of("<div id=t>abc<span style='visibility:hidden'>def</span>ghi</div>"),
        "abcghi"
    );
    assert_eq!(
        text_of(
            "<div id=t>a<span style='visibility:hidden'>b<span \
             style='visibility:visible'>c</span>d</span>e</div>"
        ),
        "ace"
    );
}

#[test]
fn table_cells_and_rows_separate() {
    assert_eq!(
        text_of("<table id=t><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>"),
        "a\tb\nc"
    );
}

#[test]
fn text_transform_applies() {
    assert_eq!(
        text_of("<div id=t style='text-transform:uppercase'>abc</div>"),
        "ABC"
    );
    assert_eq!(
        text_of("<div id=t style='text-transform:capitalize'>abc def</div>"),
        "Abc Def"
    );
}

#[test]
fn value_backed_hosts_contribute_nothing() {
    assert_eq!(text_of("<div id=t>a<textarea>hi</textarea>b</div>"), "ab");
    assert_eq!(text_of("<div id=t>abc <img> def</div>"), "abc  def");
    assert_eq!(text_of("<div id=t><svg>abc</svg></div>"), "");
}

#[test]
fn select_options_render_as_block_rows() {
    assert_eq!(
        text_of("<div id=t>a<select><option>x</option></select>b</div>"),
        "a\nx\nb"
    );
    assert_eq!(
        text_of("<select id=t size=2><option>abc</option><option>def</option></select>"),
        "abc\ndef"
    );
    assert_eq!(text_of("<div id=t>a<optgroup></optgroup>bc</div>"), "a\nbc");
}

#[test]
fn p_keeps_blank_lines_even_inline_block() {
    assert_eq!(
        text_of("<div id=t>123<p style='display:inline-block'>abc</p></div>"),
        "123\n\nabc"
    );
}

#[test]
fn table_container_whitespace_is_dropped() {
    assert_eq!(
        text_of("<div id=t><table style='white-space:pre'> <td>abc</td> </table></div>"),
        "abc"
    );
}

#[test]
fn display_none_root_is_not_rendered() {
    let dom = DomHandle::new(
        "<html><body><div id=t style='display:none'>abc</div></body></html>",
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector("#t").unwrap_or(-1);
    assert!(id > 0);
    let doc = dom.doc.borrow();
    assert!(crate::dom::inner_text::inner_text(&doc, crate::blitz_node_id(id as u32)).is_none());
}
