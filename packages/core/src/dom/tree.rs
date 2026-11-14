// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! DOM reads: selectors, node info, serialization, and tree walks.

use std::panic;

use blitz_dom::{local_name, ns, BaseDocument, LocalName, Namespace, Node, NodeData};
use blitz_traits::NodeId;
use ::style::context::QuirksMode;
use ::style::dom_apis::{
    element_closest, element_matches, query_selector, MayUseInvalidation, QueryAll,
};
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode, NodeHandleMap};
use crate::dom::cdp::{
    check_node_budget, check_subtree_budget, describe_node, describe_node_identity, subtree_size,
    Subtree, SubtreeBudgetError, SUBTREE_BUDGET_BYTES,
};

/// A budget error as JS, or null when the reply fits.
fn budget_error_json(error: Option<SubtreeBudgetError>) -> Result<JsValue, JsError> {
    let Some(error) = error else {
        return Ok(JsValue::NULL);
    };
    serde_wasm_bindgen::to_value(&error).map_err(|e| JsError::new(&e.to_string()))
}

/// The reply-budget error for `root`'s subtree, when the document and handle map can be borrowed.
fn subtree_budget_error(
    dom: &DomHandle,
    root: NodeId,
    subtree: Subtree,
) -> Option<SubtreeBudgetError> {
    let doc = dom.doc.try_borrow().ok()?;
    let handles = dom.node_handles.borrow();
    let error = check_subtree_budget(&doc, root, &dom.base_url, subtree, &handles);
    drop(handles);
    drop(doc);
    error
}

/// The reply-budget error for `root`'s own description, without its children.
fn node_budget_error(dom: &DomHandle, root: NodeId) -> Option<SubtreeBudgetError> {
    let doc = dom.doc.try_borrow().ok()?;
    let handles = dom.node_handles.borrow();
    let error = check_node_budget(&doc, root, &dom.base_url, &handles);
    drop(handles);
    drop(doc);
    error
}

fn find_html_title(doc: &BaseDocument) -> Option<&Node> {
    let mut stack = vec![doc.root_node().id()];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        if let Some(el) = node.element_data() {
            if el.name.local == local_name!("title") && *el.namespace() == ns!(html) {
                return Some(node);
            }
        }
        stack.extend(node.children().iter().rev());
    }
    None
}

fn find_title<'a>(doc: &'a BaseDocument) -> Option<&'a Node> {
    let is = |n: &Node, local: LocalName, ns: Namespace| {
        n.element_data()
            .is_some_and(|el| el.name.local == local && *el.namespace() == ns)
    };
    let elements = |n: &Node| -> Vec<&'a Node> {
        n.children()
            .iter()
            .filter_map(|id| doc.get_node(id))
            .filter(|c| c.element_data().is_some())
            .collect()
    };
    let svg_title = |svg: &Node| -> Option<&'a Node> {
        elements(svg)
            .into_iter()
            .find(|n| is(n, local_name!("title"), ns!(svg)))
    };
    let root = elements(doc.root_node()).into_iter().next()?;
    if is(root, local_name!("svg"), ns!(svg)) {
        return svg_title(root);
    }
    find_html_title(doc).or_else(|| {
        let body = elements(root)
            .into_iter()
            .find(|n| is(n, local_name!("body"), ns!(html)))?;
        match elements(body).as_slice() {
            [only] if is(only, local_name!("svg"), ns!(svg)) => svg_title(only),
            _ => None,
        }
    })
}

// Pre-order with an explicit stack, as write_outer_html: page-chosen depth must not
// overflow the wasm call stack.
fn collect_preorder(
    doc: &BaseDocument,
    start: NodeId,
    out: &mut Vec<u32>,
    node_handles: &mut NodeHandleMap,
    with_pseudos: bool,
) {
    let mut stack: Vec<NodeId> = Vec::new();
    let push_children = |id: NodeId, stack: &mut Vec<NodeId>| {
        let Some(node) = doc.get_node(id) else {
            return;
        };
        let after = if with_pseudos {
            node.pe_by_index(0)
        } else {
            None
        };
        let before = if with_pseudos {
            node.pe_by_index(1)
        } else {
            None
        };
        stack.extend(after);
        stack.extend(node.children().into_iter().rev());
        stack.extend(before);
    };
    push_children(start, &mut stack);
    while let Some(id) = stack.pop() {
        out.push(node_handles.external_for(id));
        push_children(id, &mut stack);
    }
}

pub(crate) fn collect_descendants(
    doc: &BaseDocument,
    start: NodeId,
    out: &mut Vec<u32>,
    node_handles: &mut NodeHandleMap,
) {
    collect_preorder(doc, start, out, node_handles, false);
}

pub(crate) fn collect_descendants_with_pseudos(
    doc: &BaseDocument,
    start: NodeId,
    out: &mut Vec<u32>,
    node_handles: &mut NodeHandleMap,
) {
    collect_preorder(doc, start, out, node_handles, true);
}

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

fn is_raw_text_element(local: &str) -> bool {
    matches!(
        local,
        "script" | "style" | "xmp" | "iframe" | "noembed" | "noframes" | "plaintext"
    )
}

pub(crate) fn has_layout_data(node: &Node) -> bool {
    matches!(
        node.data,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) | NodeData::Document(_)
    )
}

/// The node and every ancestor generate a box, and the chain reaches the document root.
/// display_constructed_as persists from the style flush, so it stays valid mid-measure
/// (unlike primary_styles).
pub(crate) fn generates_box(doc: &BaseDocument, node: &Node) -> bool {
    let no_box = |d: ::style::values::specified::box_::Display| {
        use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
        d.outside() == DisplayOutside::None && d.inside() == DisplayInside::None
    };
    if no_box(node.display_constructed_as()) {
        return false;
    }
    let root_id = doc.root_node().id();
    if node.id() == root_id {
        return true;
    }
    let mut cur = node.parent_id();
    while let Some(pid) = cur {
        let Some(p) = doc.get_node(pid) else { break };
        if p.is_element() && no_box(p.display_constructed_as()) {
            return false;
        }
        if pid == root_id {
            return true;
        }
        cur = p.parent_id();
    }
    false
}

enum SerializeStep<'a> {
    Open(&'a Node),
    Close(&'a str),
}

/// A step of a serialization that resumes across calls, so it holds ids rather than borrows.
#[derive(Clone, Copy)]
enum StreamStep {
    Open(NodeId),
    Close(NodeId),
}

/// Where [`write_node_open`] queues the children and end tag still to write.
trait StepStack<'a> {
    fn open(&mut self, node: &'a Node);
    fn close(&mut self, node: &'a Node, local: &'a str);
}

impl<'a> StepStack<'a> for Vec<SerializeStep<'a>> {
    fn open(&mut self, node: &'a Node) {
        self.push(SerializeStep::Open(node));
    }
    fn close(&mut self, _node: &'a Node, local: &'a str) {
        self.push(SerializeStep::Close(local));
    }
}

impl<'a> StepStack<'a> for Vec<StreamStep> {
    fn open(&mut self, node: &'a Node) {
        self.push(StreamStep::Open(node.id()));
    }
    fn close(&mut self, node: &'a Node, _local: &'a str) {
        self.push(StreamStep::Close(node.id()));
    }
}

/// Serializer output. A [`ByteCount`] pass sizes the `String` exactly, because growing a
/// document-sized `String` by doubling raised the Wasm high-water mark by about twice its size.
trait HtmlSink {
    fn push_str(&mut self, s: &str);
    fn push(&mut self, ch: char) {
        self.push_str(ch.encode_utf8(&mut [0; 4]));
    }
}

impl HtmlSink for String {
    #[inline]
    fn push_str(&mut self, s: &str) {
        String::push_str(self, s);
    }
    #[inline]
    fn push(&mut self, ch: char) {
        String::push(self, ch);
    }
}

struct ByteCount(usize);

impl HtmlSink for ByteCount {
    #[inline]
    fn push_str(&mut self, s: &str) {
        self.0 += s.len();
    }
    #[inline]
    fn push(&mut self, ch: char) {
        self.0 += ch.len_utf8();
    }
}

/// `outerHTML` of `node`; a document serializes its children.
fn write_node_outer_html<S: HtmlSink>(doc: &BaseDocument, node: &Node, out: &mut S) {
    if matches!(node.data, NodeData::Document(_)) {
        for cid in node.children() {
            if let Some(c) = doc.get_node(cid) {
                write_outer_html(doc, c, out);
            }
        }
    } else {
        write_outer_html(doc, node, out);
    }
}

fn write_inner_html<S: HtmlSink>(doc: &BaseDocument, node: &Node, out: &mut S) {
    let raw_text = match &node.data {
        NodeData::Element(data) => is_raw_text_element(&data.name.local),
        _ => false,
    };
    for cid in node.children() {
        if let Some(c) = doc.get_node(cid) {
            if raw_text {
                if let NodeData::Text(t) = &c.data {
                    out.push_str(&t.content);
                }
            } else {
                write_outer_html(doc, c, out);
            }
        }
    }
}

/// Runs the same writer twice: once to count bytes, then into a `String` with that capacity
/// plus `spare` bytes.
fn serialize_exact(
    doc: &BaseDocument,
    node: &Node,
    count: fn(&BaseDocument, &Node, &mut ByteCount),
    write: fn(&BaseDocument, &Node, &mut String),
    spare: usize,
) -> String {
    let mut bytes = ByteCount(0);
    count(doc, node, &mut bytes);
    let mut out = String::with_capacity(bytes.0 + spare);
    write(doc, node, &mut out);
    debug_assert_eq!(out.len(), bytes.0);
    out
}

/// Whether `s` matches the JS regex `/^(?:\s|<!--(?:(?!-->)[\s\S])*-->)*<!doctype\b/i`, the
/// page-script source scan: whitespace and comments, each comment ending at its first `-->`.
pub(crate) fn matches_leading_doctype(s: &str) -> bool {
    leading_doctype(s, true) == Some(true)
}

/// [`matches_leading_doctype`] where `s` may be only a prefix (`complete` false) of the input;
/// `None` when that prefix is too short to decide.
fn leading_doctype(s: &str, complete: bool) -> Option<bool> {
    // "<!doctype" plus the byte that must not continue the word.
    const LOOKAHEAD: usize = 10;
    // Running out of input decides only when `s` is the whole input.
    let undecided = if complete { Some(false) } else { None };
    let bytes = s.as_bytes();
    let mut i = 0;
    loop {
        let rest = &bytes[i..];
        if !complete && rest.len() < LOOKAHEAD {
            return None;
        }
        if rest.len() >= 9
            && rest[..9].eq_ignore_ascii_case(b"<!doctype")
            && !rest
                .get(9)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            return Some(true);
        }
        if rest.starts_with(b"<!--") {
            // The body starts after the opener, so `<!---->` is one empty comment.
            let Some(end) = rest[4..].windows(3).position(|w| w == b"-->") else {
                return undecided;
            };
            i += 4 + end + 3;
            continue;
        }
        match s[i..].chars().next() {
            Some(ch) if is_js_whitespace(ch) => i += ch.len_utf8(),
            Some(_) => return Some(false),
            None => return undecided,
        }
    }
}

/// JS `\s` outside Unicode mode.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

// An explicit stack, not recursion: a deeply nested DOM overflowed the wasm call stack.
fn write_outer_html<S: HtmlSink>(doc: &BaseDocument, node: &Node, out: &mut S) {
    let mut stack = vec![SerializeStep::Open(node)];
    while let Some(step) = stack.pop() {
        match step {
            SerializeStep::Open(node) => write_node_open(doc, node, out, &mut stack),
            SerializeStep::Close(local) => {
                out.push_str("</");
                out.push_str(local);
                out.push('>');
            }
        }
    }
}

fn push_children<'a>(doc: &'a BaseDocument, node: &'a Node, stack: &mut impl StepStack<'a>) {
    for cid in node.children().iter().rev() {
        if let Some(c) = doc.get_node(cid) {
            stack.open(c);
        }
    }
}

fn write_node_open<'a, S: HtmlSink>(
    doc: &'a BaseDocument,
    node: &'a Node,
    out: &mut S,
    stack: &mut impl StepStack<'a>,
) {
    use blitz_dom::node::{Attribute, SpecialElementData};
    match &node.data {
        NodeData::Document(_) | NodeData::ShadowRoot(_) => push_children(doc, node, stack),
        NodeData::Comment { contents } => {
            out.push_str("<!--");
            out.push_str(contents);
            out.push_str("-->");
        }
        NodeData::Text(data) => {
            escape_text_content(&data.content, out);
        }
        NodeData::Element(data) | NodeData::AnonymousBlock(data) => {
            let local: &str = &data.name.local;
            out.push('<');
            out.push_str(local);
            let mut emit_synth_checked = false;
            let mut suppress_attr_checked = false;
            if let SpecialElementData::CheckboxInput(true) = data.special_data() {
                emit_synth_checked = true;
                suppress_attr_checked = true;
            } else if let SpecialElementData::CheckboxInput(false) = data.special_data() {
                suppress_attr_checked = true;
            }
            if emit_synth_checked {
                out.push_str(" checked=\"\"");
            }
            for Attribute { name, value, .. } in data.attrs.iter() {
                if suppress_attr_checked && &*name.local == "checked" {
                    continue;
                }
                out.push(' ');
                out.push_str(&name.local);
                out.push_str("=\"");
                escape_attr_value(value, out);
                out.push('"');
            }
            out.push('>');

            let is_void = VOID_ELEMENTS.contains(&local);
            if is_void {
                return;
            }

            stack.close(node, local);
            if is_raw_text_element(local) {
                for cid in node.children() {
                    let Some(child) = doc.get_node(cid) else {
                        continue;
                    };
                    let NodeData::Text(text) = &child.data else {
                        continue;
                    };
                    out.push_str(&text.content);
                }
            } else {
                push_children(doc, node, stack);
            }
        }
    }
}

fn escape_attr_value<S: HtmlSink>(s: &str, out: &mut S) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
}

fn escape_text_content<S: HtmlSink>(s: &str, out: &mut S) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{00a0}' => out.push_str("&nbsp;"),
            _ => out.push(ch),
        }
    }
}

/// Serialized bytes that JS copies out in bounded chunks. The buffer is freed once read.
#[wasm_bindgen]
pub struct OuterHtmlBytes {
    bytes: Vec<u8>,
    read: usize,
    len: usize,
}

impl OuterHtmlBytes {
    pub(crate) fn from_vec(bytes: Vec<u8>) -> Self {
        let len = bytes.len();
        OuterHtmlBytes {
            bytes,
            read: 0,
            len,
        }
    }
}

#[wasm_bindgen]
impl OuterHtmlBytes {
    #[wasm_bindgen(getter, js_name = "byteLength")]
    pub fn byte_length(&self) -> usize {
        self.len
    }

    /// Up to `max` (at least 1) further bytes; empty once everything has been read.
    #[wasm_bindgen(js_name = "nextChunk")]
    pub fn next_chunk(&mut self, max: usize) -> Vec<u8> {
        let end = self.bytes.len().min(self.read.saturating_add(max.max(1)));
        let chunk = self.bytes[self.read..end].to_vec();
        self.read = end;
        if self.read == self.bytes.len() {
            self.bytes = Vec::new();
            self.read = 0;
        }
        chunk
    }
}

// Enough of the output's start to find the marker and settle the leading-doctype check.
const STREAM_PREFIX_BYTES: usize = 64 * 1024;

#[allow(deprecated)] // std's SipHasher is the only keyed hasher without a new dependency.
pub(crate) type OutputHasher = std::hash::SipHasher;

#[allow(deprecated)]
pub(crate) fn output_hasher(key: (u64, u64)) -> OutputHasher {
    std::hash::SipHasher::new_with_keys(key.0, key.1)
}

pub(crate) fn output_hash_key() -> Result<(u64, u64), getrandom::Error> {
    let mut key = [0u8; 16];
    getrandom::getrandom(&mut key)?;
    let [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p] = key;
    Ok((
        u64::from_le_bytes([a, b, c, d, e, f, g, h]),
        u64::from_le_bytes([i, j, k, l, m, n, o, p]),
    ))
}

/// First serialization pass: length, keyed hash, first marker offset and the output's start.
struct Probe<'m> {
    len: usize,
    hasher: OutputHasher,
    marker: &'m [u8],
    // Knuth-Morris-Pratt state: failure table and bytes of the marker matched so far.
    failure: Vec<usize>,
    matched: usize,
    marker_at: Option<usize>,
    prefix: String,
}

impl<'m> Probe<'m> {
    fn new(marker: &'m str, key: (u64, u64)) -> Self {
        let marker = marker.as_bytes();
        Probe {
            len: 0,
            hasher: output_hasher(key),
            marker,
            failure: failure_table(marker),
            matched: 0,
            marker_at: None,
            prefix: String::new(),
        }
    }

    fn find_marker(&mut self, bytes: &[u8]) {
        for (offset, &b) in bytes.iter().enumerate() {
            while self.matched > 0 && b != self.marker[self.matched] {
                self.matched = self.failure[self.matched - 1];
            }
            if b == self.marker[self.matched] {
                self.matched += 1;
            }
            if self.matched == self.marker.len() {
                self.marker_at = Some(self.len + offset + 1 - self.marker.len());
                return;
            }
        }
    }
}

/// Knuth-Morris-Pratt failure table: the longest proper border of each prefix of `marker`.
fn failure_table(marker: &[u8]) -> Vec<usize> {
    let mut failure = vec![0; marker.len()];
    let mut matched = 0;
    for i in 1..marker.len() {
        while matched > 0 && marker[i] != marker[matched] {
            matched = failure[matched - 1];
        }
        if marker[i] == marker[matched] {
            matched += 1;
        }
        failure[i] = matched;
    }
    failure
}

impl HtmlSink for Probe<'_> {
    fn push_str(&mut self, s: &str) {
        std::hash::Hasher::write(&mut self.hasher, s.as_bytes());
        let room = STREAM_PREFIX_BYTES.saturating_sub(self.prefix.len());
        if room > 0 {
            let mut take = room.min(s.len());
            while !s.is_char_boundary(take) {
                take -= 1;
            }
            self.prefix.push_str(&s[..take]);
        }
        if !self.marker.is_empty() && self.marker_at.is_none() {
            self.find_marker(s.as_bytes());
        }
        self.len += s.len();
    }
}

/// Second pass: the output with `cut` bytes at raw offset `at` replaced by `insert`, queued in
/// `pending` for JS to take. The raw bytes are hashed again to compare with the first pass.
struct StreamSink {
    pending: Vec<u8>,
    // Bytes at the start of `pending` already returned; compacted lazily, so a large node is
    // not shifted down on every chunk.
    taken: usize,
    hasher: OutputHasher,
    raw_pos: usize,
    at: usize,
    cut: usize,
    insert: Vec<u8>,
    inserted: bool,
}

impl HtmlSink for StreamSink {
    fn push_str(&mut self, s: &str) {
        std::hash::Hasher::write(&mut self.hasher, s.as_bytes());
        let mut rest = s.as_bytes();
        while !rest.is_empty() {
            if !self.inserted && self.raw_pos >= self.at {
                self.pending.extend_from_slice(&self.insert);
                self.inserted = true;
            }
            let taken = self.copy_before_next_edit(rest);
            rest = &rest[taken..];
            self.raw_pos += taken;
        }
    }
}

impl StreamSink {
    /// Copies what `rest` holds before the next edit point and returns how many bytes that took:
    /// up to the cut, nothing inside it, then everything after it.
    fn copy_before_next_edit(&mut self, rest: &[u8]) -> usize {
        let pos = self.raw_pos;
        if pos < self.at {
            let taken = rest.len().min(self.at - pos);
            self.pending.extend_from_slice(&rest[..taken]);
            return taken;
        }
        if pos < self.at + self.cut {
            return rest.len().min(self.at + self.cut - pos);
        }
        self.pending.extend_from_slice(rest);
        rest.len()
    }

    fn unread(&self) -> usize {
        self.pending.len() - self.taken
    }

    fn take(&mut self, n: usize) -> Vec<u8> {
        let chunk = self.pending[self.taken..self.taken + n].to_vec();
        self.taken += n;
        if self.taken * 2 >= self.pending.len() {
            self.pending.drain(..self.taken);
            self.taken = 0;
        }
        chunk
    }

    fn clear(&mut self) {
        self.pending = Vec::new();
        self.taken = 0;
    }
}

/// `outerHTML` serialized as JS pulls it, so Wasm holds about one chunk or one text node,
/// whichever is larger, rather than the page. Page JS can change the DOM between pulls; the
/// stream then ends short, and the caller must discard the bytes and serialize in one go.
#[wasm_bindgen]
pub struct OuterHtmlStream {
    stack: Vec<StreamStep>,
    sink: StreamSink,
    expected_hash: u64,
    expected_raw_len: usize,
    len: usize,
    emitted: usize,
    torn: bool,
}

impl OuterHtmlStream {
    /// Runs serialization steps until `max` bytes are pending or the tree is done.
    fn fill(&mut self, doc: &BaseDocument, max: usize) {
        while self.sink.unread() < max {
            let Some(step) = self.stack.pop() else {
                return;
            };
            match step {
                StreamStep::Open(id) => match doc.get_node(id) {
                    Some(node) => write_node_open(doc, node, &mut self.sink, &mut self.stack),
                    None => {
                        self.torn = true;
                        return;
                    }
                },
                StreamStep::Close(id) => match doc.get_node(id).and_then(|n| n.element_data()) {
                    Some(data) => {
                        self.sink.push_str("</");
                        self.sink.push_str(&data.name.local);
                        self.sink.push('>');
                    }
                    None => {
                        self.torn = true;
                        return;
                    }
                },
            }
        }
    }
}

#[wasm_bindgen]
impl OuterHtmlStream {
    #[wasm_bindgen(getter, js_name = "byteLength")]
    pub fn byte_length(&self) -> usize {
        self.len
    }

    /// Up to `max` (at least 1) further bytes of `dom`'s output; empty once `byteLength` bytes
    /// were returned. If the tree changed since the first pass, the last chunk is withheld, so
    /// a torn stream always ends short of `byteLength`.
    #[wasm_bindgen(js_name = "nextChunk")]
    pub fn next_chunk(&mut self, dom: &DomHandle, max: usize) -> Vec<u8> {
        let remaining = self.len - self.emitted;
        if remaining == 0 || self.torn {
            return Vec::new();
        }
        let want = max.max(1).min(remaining);
        let Ok(doc) = dom.doc.try_borrow() else {
            return self.tear();
        };
        self.fill(&doc, want);
        let last = want == remaining;
        if last {
            // One byte past the end shows whether the tree now serializes longer.
            self.fill(&doc, want + 1);
        }
        drop(doc);
        let n = want.min(self.sink.unread());
        if self.torn || n == 0 || (last && !self.ends_consistently(n)) {
            return self.tear();
        }
        let chunk = self.sink.take(n);
        self.emitted += n;
        if self.emitted == self.len {
            self.sink.clear();
        }
        chunk
    }
}

impl OuterHtmlStream {
    /// Whether taking the `n` pending bytes ends the output exactly as the first pass saw it.
    fn ends_consistently(&self, n: usize) -> bool {
        n == self.len - self.emitted
            && self.stack.is_empty()
            && self.sink.unread() == n
            && self.sink.raw_pos == self.expected_raw_len
            && std::hash::Hasher::finish(&self.sink.hasher) == self.expected_hash
    }

    fn tear(&mut self) -> Vec<u8> {
        self.torn = true;
        self.stack = Vec::new();
        self.sink.clear();
        Vec::new()
    }
}

#[wasm_bindgen]
impl DomHandle {
    /// Starts [`OuterHtmlStream`] with the marker and doctype rule of `outerHTMLBytes`. Returns
    /// `None` when the stream cannot apply that rule from the output's start; use
    /// `outerHTMLBytes` then.
    #[wasm_bindgen(js_name = "outerHTMLStream")]
    pub fn outer_html_stream(
        &self,
        node_id: u32,
        marker: &str,
        doctype: &str,
    ) -> Option<OuterHtmlStream> {
        let internal_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        let node = doc.get_node(internal_id)?;

        // First pass: the output's length, keyed hash, first marker offset and its start.
        let key = output_hash_key().ok()?;
        let mut probe = Probe::new(marker, key);
        write_node_outer_html(&doc, node, &mut probe);
        drop(doc);

        let (at, cut, insert) = marker_edit(&probe, marker, doctype)?;
        let len = probe.len - cut + insert.len();
        Some(OuterHtmlStream {
            stack: vec![StreamStep::Open(internal_id)],
            sink: StreamSink {
                pending: Vec::new(),
                taken: 0,
                hasher: output_hasher(key),
                raw_pos: 0,
                at,
                cut,
                inserted: insert.is_empty(),
                insert,
            },
            expected_hash: std::hash::Hasher::finish(&probe.hasher),
            expected_raw_len: probe.len,
            len,
            emitted: 0,
            torn: false,
        })
    }
}

/// Where the streamed output removes `marker` and, unless the output already starts with a
/// doctype after spaces and comments, inserts `doctype`: `(at, cut, insert)`. `None` when the
/// marker or the leading-doctype answer lies past the prefix the probe kept.
fn marker_edit(probe: &Probe<'_>, marker: &str, doctype: &str) -> Option<(usize, usize, Vec<u8>)> {
    let Some(at) = probe.marker_at else {
        return Some((usize::MAX, 0, Vec::new()));
    };
    let prefix = &probe.prefix;
    if at + marker.len() > prefix.len() {
        return None;
    }

    let stripped = [&prefix[..at], &prefix[at + marker.len()..]].concat();
    let complete = prefix.len() == probe.len;
    let keep = doctype.is_empty() || leading_doctype(&stripped, complete)?;
    let insert = if keep {
        Vec::new()
    } else {
        doctype.as_bytes().to_vec()
    };
    Some((at, marker.len(), insert))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "title")]
    pub fn title(&self) -> String {
        match self.doc.try_borrow() {
            Ok(d) => find_title(&d).map(|n| n.text_content()).unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    #[wasm_bindgen(js_name = "baseURL")]
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Moves whenever the first connected `<base href>` can change, so callers re-resolve
    /// `baseURI` only then. Any connected move counts; -1 means the document is borrowed.
    #[wasm_bindgen(js_name = "baseEpoch")]
    pub fn base_epoch(&self) -> f64 {
        self.doc
            .try_borrow()
            .map_or(-1.0, |d| f64::from(d.base_epoch))
    }

    /// The document described as CDP `DOM.getDocument` with `depth` (negative for the whole
    /// tree) and `pierce`.
    #[wasm_bindgen(js_name = "getDocument", unchecked_return_type = "KsNodeInfo | null")]
    pub fn get_document(&self, depth: i32, pierce: bool) -> Result<JsValue, JsError> {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let doc_id = doc.root_node().id();
        let subtree = Subtree { depth, pierce };
        let mut node_handles = self.node_handles.borrow_mut();
        let cdp = describe_node(
            &doc,
            doc_id,
            &self.base_url,
            Some(subtree),
            &mut node_handles,
        );
        drop(node_handles);
        drop(doc);
        let node = cdp.ok_or_else(|| JsError::new("document node missing"))?;
        serde_wasm_bindgen::to_value(&node).map_err(|e| JsError::new(&e.to_string()))
    }

    /// `node_id` with its children to `depth` (negative for all), as CDP describes a node.
    #[wasm_bindgen(js_name = "nodeSubtree", unchecked_return_type = "KsNodeInfo | null")]
    pub fn node_subtree(&self, node_id: u32, depth: i32, pierce: bool) -> Result<JsValue, JsError> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Ok(JsValue::NULL);
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        if doc.get_node(internal_id).is_none() {
            drop(doc);
            return Ok(JsValue::NULL);
        }
        let subtree = Subtree { depth, pierce };
        let mut node_handles = self.node_handles.borrow_mut();
        let cdp = describe_node(
            &doc,
            internal_id,
            &self.base_url,
            Some(subtree),
            &mut node_handles,
        );
        drop(node_handles);
        drop(doc);
        match cdp {
            Some(node) => {
                serde_wasm_bindgen::to_value(&node).map_err(|e| JsError::new(&e.to_string()))
            }
            None => Ok(JsValue::NULL),
        }
    }

    #[wasm_bindgen(
        js_name = "documentBudgetError",
        unchecked_return_type = "KsSubtreeBudgetError | null"
    )]
    pub fn document_budget_error(&self, depth: i32, pierce: bool) -> Result<JsValue, JsError> {
        let doc = match self.doc.try_borrow() {
            Ok(doc) => doc,
            Err(_) => return Ok(JsValue::NULL),
        };
        let root = doc.root_node().id();
        drop(doc);
        budget_error_json(subtree_budget_error(self, root, Subtree { depth, pierce }))
    }

    #[wasm_bindgen(
        js_name = "nodeSubtreeBudgetError",
        unchecked_return_type = "KsSubtreeBudgetError | null"
    )]
    pub fn node_subtree_budget_error(
        &self,
        node_id: u32,
        depth: i32,
        pierce: bool,
    ) -> Result<JsValue, JsError> {
        let Some(root) = self.resolve_node_id(node_id) else {
            return Ok(JsValue::NULL);
        };
        budget_error_json(subtree_budget_error(self, root, Subtree { depth, pierce }))
    }

    /// The estimated serialized size past which one CDP reply is no longer safe to send.
    #[wasm_bindgen(js_name = "subtreeBudgetBytes")]
    pub fn subtree_budget_bytes(&self) -> f64 {
        SUBTREE_BUDGET_BYTES as f64
    }

    /// The estimated serialized size of one subtree. A caller that combines several reads into a
    /// single reply sums these, since the cap applies to the reply and not to each read.
    #[wasm_bindgen(js_name = "nodeSubtreeBytes")]
    pub fn node_subtree_bytes(&self, node_id: u32, depth: i32, pierce: bool) -> f64 {
        let Some(root) = self.resolve_node_id(node_id) else {
            return 0.0;
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return 0.0;
        };
        let handles = self.node_handles.borrow();
        let size = subtree_size(
            &doc,
            root,
            &self.base_url,
            Subtree { depth, pierce },
            &handles,
        );
        drop(handles);
        drop(doc);
        size.at_least_bytes as f64
    }

    #[wasm_bindgen(
        js_name = "nodeDescriptionBudgetError",
        unchecked_return_type = "KsSubtreeBudgetError | null"
    )]
    pub fn node_description_budget_error(&self, node_id: u32) -> Result<JsValue, JsError> {
        let Some(root) = self.resolve_node_id(node_id) else {
            return Ok(JsValue::NULL);
        };
        budget_error_json(node_budget_error(self, root))
    }

    #[wasm_bindgen(js_name = "querySelector")]
    pub fn query_selector(&self, selector: &str) -> Result<i32, JsError> {
        self.flush_slot_assignments();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(-1),
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| doc.query_selector(selector)));
        match result {
            Ok(Ok(Some(id))) => Ok(self.external_node_id_i32(id)),
            Ok(Ok(None)) => Ok(-1),
            Ok(Err(e)) => Err(JsError::new(&format!("{e:?}"))),
            Err(_) => Ok(-1),
        }
    }

    #[wasm_bindgen(js_name = "getElementById")]
    pub fn get_element_by_id(&self, id: &str) -> i32 {
        self.flush_slot_assignments();
        let Ok(doc) = self.doc.try_borrow() else {
            return -1;
        };
        match doc.get_element_by_id(id).and_then(|nid| doc.get_node(nid)) {
            Some(node) if node.attr(local_name!("id")) == Some(id) => {
                self.external_node_id_i32(node.id())
            }
            _ => -1,
        }
    }

    #[wasm_bindgen(js_name = "canonicalizeSelector")]
    pub fn canonicalize_selector(&self, selector: &str) -> Option<String> {
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            doc.try_parse_selector_list(selector).ok().map(|list| {
                use cssparser::ToCss as _;
                list.to_css_string()
            })
        }))
        .ok()
        .flatten()
    }

    #[wasm_bindgen(js_name = "canonicalizeSelectorNs")]
    pub fn canonicalize_selector_ns(
        &self,
        selector: &str,
        #[wasm_bindgen(unchecked_param_type = "Record<string, string>")] prefixes: JsValue,
    ) -> Option<String> {
        let map: std::collections::HashMap<String, String> =
            serde_wasm_bindgen::from_value(prefixes).ok()?;
        let default_ns = map.get("").cloned();
        let prefix_list: Vec<(String, String)> =
            map.into_iter().filter(|(k, _)| !k.is_empty()).collect();
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            doc.try_parse_selector_list_with_namespaces(
                selector,
                default_ns.as_deref(),
                &prefix_list,
            )
            .ok()
            .map(|list| {
                use cssparser::ToCss as _;
                list.to_css_string()
            })
        }))
        .ok()
        .flatten()
    }

    #[wasm_bindgen(js_name = "querySelectorAll")]
    pub fn query_selector_all(&self, selector: &str) -> Result<Vec<i32>, JsError> {
        self.flush_slot_assignments();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };
        let result =
            panic::catch_unwind(panic::AssertUnwindSafe(|| doc.query_selector_all(selector)));
        match result {
            Ok(Ok(ids)) => Ok(ids
                .into_iter()
                .map(|id| self.external_node_id_i32(id))
                .collect()),
            Ok(Err(e)) => Err(JsError::new(&format!("{e:?}"))),
            Err(_) => Ok(Vec::new()),
        }
    }

    #[wasm_bindgen(js_name = "querySelectorAllInSubtree")]
    pub fn query_selector_all_in_subtree(
        &self,
        root_id: u32,
        selector: &str,
    ) -> Result<Vec<i32>, JsError> {
        self.flush_slot_assignments();
        use smallvec::SmallVec;

        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };
        let selector_list = doc
            .try_parse_selector_list(selector)
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        let Some(root) = self
            .resolve_node_id(root_id)
            .and_then(|id| doc.get_node(id))
        else {
            return Ok(Vec::new());
        };

        let mut results: SmallVec<[&Node; 128]> = SmallVec::new();
        let matched = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            query_selector::<&Node, QueryAll>(
                root,
                &selector_list,
                &mut results,
                MayUseInvalidation::Yes,
            );
        }));
        if matched.is_err() {
            return Ok(Vec::new());
        }
        Ok(results
            .into_iter()
            .map(|n| self.external_node_id_i32(n.id()))
            .collect())
    }

    #[wasm_bindgen(js_name = "matchesInSubtree")]
    pub fn matches_in_subtree(&self, node_id: u32, selector: &str) -> Result<bool, JsError> {
        self.matches_in_subtree_text(node_id, selector)
    }

    /// Byte-taking twin of `matchesInSubtree`. Selector text can come from a sheet the page
    /// cannot read, and wasm-bindgen marshals `&str` through `charCodeAt`/`encodeInto`, which
    /// page JS can replace. The caller encodes the text itself and passes the bytes instead.
    /// Invalid UTF-8 matches nothing.
    #[wasm_bindgen(js_name = "matchesInSubtreeBytes")]
    pub fn matches_in_subtree_bytes(&self, node_id: u32, selector: &[u8]) -> Result<bool, JsError> {
        match std::str::from_utf8(selector) {
            Ok(text) => self.matches_in_subtree_text(node_id, text),
            Err(_) => Ok(false),
        }
    }

    fn matches_in_subtree_text(&self, node_id: u32, selector: &str) -> Result<bool, JsError> {
        self.flush_slot_assignments();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(false),
        };
        let selector_list = doc
            .try_parse_selector_list(selector)
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        let Some(node) = self
            .resolve_node_id(node_id)
            .and_then(|id| doc.get_node(id))
        else {
            return Ok(false);
        };

        let quirks = QuirksMode::NoQuirks;
        let m = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            element_matches::<&Node>(&node, &selector_list, quirks)
        }));
        Ok(m.unwrap_or(false))
    }

    #[wasm_bindgen(js_name = "closestInTree")]
    pub fn closest_in_tree(&self, node_id: u32, selector: &str) -> Result<i32, JsError> {
        self.flush_slot_assignments();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(-1),
        };
        let selector_list = doc
            .try_parse_selector_list(selector)
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        let Some(node) = self
            .resolve_node_id(node_id)
            .and_then(|id| doc.get_node(id))
        else {
            return Ok(-1);
        };

        let quirks = QuirksMode::NoQuirks;
        let r = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            element_closest::<&Node>(node, &selector_list, quirks)
        }));
        match r {
            Ok(Some(matched)) => Ok(self.external_node_id_i32(matched.id())),
            _ => Ok(-1),
        }
    }

    #[wasm_bindgen(js_name = "outerHTML")]
    pub fn outer_html(&self, node_id: u32) -> String {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return String::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let Some(n) = doc.get_node(internal_id) else {
            return String::new();
        };
        serialize_exact(&doc, n, write_node_outer_html, write_node_outer_html, 0)
    }

    /// `outerHTML` as UTF-8 that JS reads in chunks, so the page never holds a whole copy.
    /// When `marker` is not empty, its first occurrence is removed; `doctype` (if not empty) is
    /// inserted there unless the rest already starts with a doctype after spaces and comments.
    #[wasm_bindgen(js_name = "outerHTMLBytes")]
    pub fn outer_html_bytes(&self, node_id: u32, marker: &str, doctype: &str) -> OuterHtmlBytes {
        OuterHtmlBytes::from_vec(self.outer_html_utf8(node_id, marker, doctype))
    }

    fn outer_html_utf8(&self, node_id: u32, marker: &str, doctype: &str) -> Vec<u8> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let Some(n) = doc.get_node(internal_id) else {
            return Vec::new();
        };
        let mut out = serialize_exact(
            &doc,
            n,
            write_node_outer_html,
            write_node_outer_html,
            doctype.len(),
        );
        drop(doc);
        if !marker.is_empty() {
            if let Some(at) = out.find(marker) {
                out.replace_range(at..at + marker.len(), "");
                if !doctype.is_empty() && !matches_leading_doctype(&out) {
                    out.insert_str(at, doctype);
                }
            }
        }
        out.into_bytes()
    }

    #[wasm_bindgen(js_name = "innerHTML")]
    pub fn inner_html(&self, node_id: u32) -> String {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return String::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let Some(node) = doc.get_node(internal_id) else {
            return String::new();
        };
        serialize_exact(&doc, node, write_inner_html, write_inner_html, 0)
    }

    #[wasm_bindgen(js_name = "textContent")]
    pub fn text_content(&self, node_id: u32) -> String {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return String::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        match doc.get_node(internal_id) {
            Some(n) => n.text_content(),
            None => String::new(),
        }
    }

    #[wasm_bindgen(js_name = "nodeInfo", unchecked_return_type = "KsNodeInfo | null")]
    pub fn node_info(&self, node_id: u32) -> Result<JsValue, JsError> {
        let internal_id = self
            .resolve_node_id(node_id)
            .ok_or_else(|| JsError::new("node not found"))?;
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let info = describe_node(
            &doc,
            internal_id,
            &self.base_url,
            None,
            &mut self.node_handles.borrow_mut(),
        )
        .ok_or_else(|| JsError::new("node not found"))?;
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The first non-empty value of an attribute whose qualified name is `id`, as found in
    /// `nodeInfo`'s attribute list. Named-global stamping reads it for every `[id]` element and
    /// every insertion, where building the full `nodeInfo` record dominated allocation.
    #[wasm_bindgen(js_name = "idAttribute")]
    pub fn id_attribute(&self, node_id: u32) -> Option<String> {
        let internal_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        let value = match &doc.get_node(internal_id)?.data {
            NodeData::Element(data) | NodeData::AnonymousBlock(data) => data
                .attrs
                .iter()
                .find(|a| a.prefix().is_none() && &*a.name.local == "id" && !a.value.is_empty())
                .map(|a| a.value.to_string()),
            _ => None,
        };
        drop(doc);
        value
    }

    // Wrapper creation does not need CDP ids, child counts or attribute snapshots.
    #[wasm_bindgen(
        js_name = "nodeIdentity",
        unchecked_return_type = "KsNodeIdentity | null"
    )]
    pub fn node_identity(&self, node_id: u32) -> Result<JsValue, JsError> {
        let internal_id = self
            .resolve_node_id(node_id)
            .ok_or_else(|| JsError::new("node not found"))?;
        let doc = match self.doc.try_borrow() {
            Ok(doc) => doc,
            Err(_) => return Ok(JsValue::NULL),
        };
        let info = doc.get_node(internal_id).map(describe_node_identity);
        drop(doc);
        let info = info.ok_or_else(|| JsError::new("node not found"))?;
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = "childIds")]
    pub fn child_ids(&self, node_id: u32) -> Vec<u32> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        match doc.get_node(internal_id) {
            Some(n) => n
                .children()
                .iter()
                .map(|id| self.external_node_id(id))
                .collect(),
            None => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = "parentId")]
    pub fn parent_id(&self, node_id: u32) -> i32 {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        match doc.get_node(internal_id).and_then(|n| n.parent_id()) {
            Some(p) => self.external_node_id_i32(p),
            None => -1,
        }
    }

    #[wasm_bindgen(js_name = "isInclusiveAncestor")]
    pub fn is_inclusive_ancestor(&self, ancestor_id: u32, node_id: u32) -> bool {
        let (Some(ancestor), Some(mut cur)) = (
            self.resolve_node_id(ancestor_id),
            self.resolve_node_id(node_id),
        ) else {
            return false;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(ancestor).is_none() {
            return false;
        }
        for _ in 0..4096 {
            if cur == ancestor {
                return true;
            }
            match doc.get_node(cur).and_then(|n| n.parent_id()) {
                Some(p) if p != cur => cur = p,
                _ => return false,
            }
        }
        false
    }

    #[wasm_bindgen(js_name = "descendantsOf")]
    pub fn descendants_of(&self, node_id: u32) -> Vec<u32> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let mut out = Vec::new();
        collect_descendants(
            &doc,
            internal_id,
            &mut out,
            &mut self.node_handles.borrow_mut(),
        );
        out
    }

    #[wasm_bindgen(js_name = "innerTextRendered", unchecked_return_type = "string | null")]
    pub fn inner_text_rendered(&self, node_id: u32) -> JsValue {
        if self.layout_mode.get() == LayoutMode::Off {
            return JsValue::NULL;
        }
        self.ensure_layout();
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return JsValue::NULL;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return JsValue::NULL,
        };
        let res = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            crate::dom::inner_text::inner_text(&doc, internal_id)
        }))
        .unwrap_or(None);
        drop(doc);
        match res {
            Some(s) => JsValue::from_str(&s),
            None => JsValue::NULL,
        }
    }

    #[wasm_bindgen(js_name = "serialize")]
    pub fn serialize(&self) -> Result<Vec<u8>, JsError> {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(doc.root_node().outer_html().into_bytes())
    }

    #[wasm_bindgen(js_name = "fromSerialized")]
    pub fn from_serialized(bytes: &[u8], base_url: &str) -> Result<DomHandle, JsError> {
        let html = std::str::from_utf8(bytes)
            .map_err(|e| JsError::new(&format!("serialized DOM is not UTF-8: {e}")))?;
        Ok(DomHandle::new(html, base_url))
    }
}
