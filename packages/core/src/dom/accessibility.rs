// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Serialization and DOM traversal for accessibility snapshots.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;

use blitz_dom::{BaseDocument, Node, NodeData};
use blitz_traits::NodeId;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::dom::tree::{OuterHtmlBytes, OutputHasher, output_hash_key, output_hasher};
use crate::{DomHandle, NodeHandleMap};

// The protocol's integer role id for RootWebArea.
const ROOT_WEB_AREA_ROLE_ID: u32 = 144;
// The engine holds decoded JSON in the outgoing frame plus transient chunks, about 2x the reply.
// Keep that beside the 40–60 MB baseline in a 128 MB isolate.
const AX_REPLY_BUDGET_BYTES: usize = 24 * 1024 * 1024;

pub(crate) trait JsonSink {
    fn push_str(&mut self, value: &str);

    fn node(&mut self) {}
}

impl JsonSink for String {
    fn push_str(&mut self, value: &str) {
        String::push_str(self, value);
    }
}

impl JsonSink for Vec<u8> {
    fn push_str(&mut self, value: &str) {
        self.extend_from_slice(value.as_bytes());
    }
}

#[derive(Default)]
#[cfg(test)]
struct ByteCount(usize);

#[cfg(test)]
impl JsonSink for ByteCount {
    fn push_str(&mut self, value: &str) {
        self.0 += value.len();
    }
}

struct MeasureSink {
    bytes: usize,
    nodes: usize,
    budget: usize,
    hasher: Option<OutputHasher>,
}

impl MeasureSink {
    fn new(key: Option<(u64, u64)>, budget: usize) -> Self {
        Self {
            bytes: 0,
            nodes: 0,
            budget,
            hasher: key.map(output_hasher),
        }
    }

    fn finish_hash(&self) -> Option<u64> {
        self.hasher.as_ref().map(Hasher::finish)
    }
}

impl JsonSink for MeasureSink {
    fn push_str(&mut self, value: &str) {
        self.bytes += value.len();
        if self.bytes > self.budget {
            self.hasher = None;
        } else if let Some(hasher) = &mut self.hasher {
            hasher.write(value.as_bytes());
        }
    }

    fn node(&mut self) {
        self.nodes += 1;
    }
}

pub(crate) fn js_ws(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(js_ws)
}

pub(crate) fn collapse(value: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in value.chars() {
        if js_ws(ch) {
            space = !out.is_empty();
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(ch);
        }
    }
    out
}

pub(crate) fn split_js_ws(value: &str) -> impl Iterator<Item = &str> {
    let trimmed = js_trim(value);
    trimmed
        .split(js_ws)
        .filter(move |part| !part.is_empty() || trimmed.is_empty())
}

/// The leading 53 bits of a radix-prefixed integer, plus what rounding needs from the rest.
#[derive(Default)]
struct FloatBits {
    significant: bool,
    bit_length: usize,
    leading_bits: u64,
    leading_bit_count: u32,
    round_bit: bool,
    sticky: bool,
}

impl FloatBits {
    fn fold(&mut self, bit: bool) {
        if !self.significant && !bit {
            return;
        }
        self.significant = true;
        self.bit_length += 1;
        if self.leading_bit_count < 53 {
            self.leading_bits = (self.leading_bits << 1) | u64::from(bit);
            self.leading_bit_count += 1;
        } else if self.leading_bit_count == 53 {
            self.round_bit = bit;
            self.leading_bit_count += 1;
        } else {
            self.sticky |= bit;
        }
    }
}

pub(crate) fn js_number(value: &str) -> f64 {
    let value = js_trim(value);
    if value.is_empty() {
        return 0.0;
    }
    if let Some((prefix, digits)) = value.get(..2).zip(value.get(2..)) {
        let radix = match prefix {
            "0x" | "0X" => 16,
            "0o" | "0O" => 8,
            "0b" | "0B" => 2,
            _ => 0,
        };
        if radix != 0 {
            if digits.is_empty() {
                return f64::NAN;
            }
            let bits_per_digit = match radix {
                2 => 1,
                8 => 3,
                16 => 4,
                _ => return f64::NAN,
            };
            let mut exact = Some(0_u128);
            let mut bits = FloatBits::default();
            for ch in digits.chars() {
                let Some(digit) = ch.to_digit(radix) else {
                    return f64::NAN;
                };
                exact = exact.and_then(|value| {
                    value
                        .checked_mul(u128::from(radix))
                        .and_then(|value| value.checked_add(u128::from(digit)))
                });
                for shift in (0..bits_per_digit).rev() {
                    bits.fold(digit & (1 << shift) != 0);
                }
            }
            if let Some(exact) = exact {
                return exact as f64;
            }
            if bits.bit_length > 1024 {
                return f64::INFINITY;
            }
            if bits.round_bit && (bits.sticky || bits.leading_bits & 1 == 1) {
                bits.leading_bits += 1;
            }
            return (bits.leading_bits as f64) * 2.0_f64.powi((bits.bit_length - 53) as i32);
        }
    }
    match value {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let bytes = value.as_bytes();
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let mut digits = i - start;
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        digits += i - start;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if start == i {
            return f64::NAN;
        }
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    value.parse().unwrap_or(f64::NAN)
}

pub(crate) fn js_parse_int(value: &str) -> f64 {
    let value = value.trim_start_matches(js_ws);
    let bytes = value.as_bytes();
    let sign = if bytes.first() == Some(&b'-') {
        -1.0
    } else {
        1.0
    };
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let start = i;
    let mut result = 0.0;
    while let Some(digit) = bytes.get(i).filter(|b| b.is_ascii_digit()) {
        result = result * 10.0 + f64::from(*digit - b'0');
        i += 1;
    }
    if i == start {
        f64::NAN
    } else {
        result * sign
    }
}

pub(crate) fn write_number<S: JsonSink>(out: &mut S, value: f64) {
    if !value.is_finite() {
        out.push_str("null");
    } else if value == 0.0 {
        out.push_str("0");
    } else {
        out.push_str(ryu_js::Buffer::new().format(value));
    }
}

pub(crate) fn write_string<S: JsonSink>(out: &mut S, value: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\"");
    // Rust strings cannot contain lone surrogates.
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0}'..='\u{1f}' => {
                let n = ch as usize;
                let encoded = [b'\\', b'u', b'0', b'0', HEX[n >> 4], HEX[n & 15]];
                if let Ok(text) = std::str::from_utf8(&encoded) {
                    out.push_str(text);
                }
            }
            _ => out.push_str(ch.encode_utf8(&mut [0; 4])),
        }
    }
    out.push_str("\"");
}

fn write_utf16_string<S: JsonSink>(out: &mut S, value: &[u16]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\"");
    let mut index = 0;
    while let Some(&unit) = value.get(index) {
        index += 1;
        match unit {
            0x0022 => out.push_str("\\\""),
            0x005c => out.push_str("\\\\"),
            0x0008 => out.push_str("\\b"),
            0x000c => out.push_str("\\f"),
            0x000a => out.push_str("\\n"),
            0x000d => out.push_str("\\r"),
            0x0009 => out.push_str("\\t"),
            0x0000..=0x001f => {
                let encoded = [
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    HEX[usize::from(unit) >> 4],
                    HEX[usize::from(unit) & 15],
                ];
                if let Ok(text) = std::str::from_utf8(&encoded) {
                    out.push_str(text);
                }
            }
            0xd800..=0xdbff => {
                if let Some(&low @ 0xdc00..=0xdfff) = value.get(index) {
                    index += 1;
                    let scalar =
                        0x1_0000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                    if let Some(character) = char::from_u32(scalar) {
                        out.push_str(character.encode_utf8(&mut [0; 4]));
                    }
                } else {
                    write_utf16_escape(out, unit, HEX);
                }
            }
            0xdc00..=0xdfff => write_utf16_escape(out, unit, HEX),
            _ => {
                if let Some(character) = char::from_u32(u32::from(unit)) {
                    out.push_str(character.encode_utf8(&mut [0; 4]));
                }
            }
        }
    }
    out.push_str("\"");
}

fn write_utf16_escape<S: JsonSink>(out: &mut S, unit: u16, hex: &[u8; 16]) {
    let encoded = [
        b'\\',
        b'u',
        hex[usize::from(unit >> 12)],
        hex[usize::from((unit >> 8) & 15)],
        hex[usize::from((unit >> 4) & 15)],
        hex[usize::from(unit & 15)],
    ];
    if let Ok(text) = std::str::from_utf8(&encoded) {
        out.push_str(text);
    }
}

pub(crate) fn abs_url(href: &str, base: &str) -> String {
    let result = if base.is_empty() {
        url::Url::parse(href)
    } else {
        url::Url::parse(base).and_then(|url| url.join(href))
    };
    result.map(|url| url.to_string()).unwrap_or_default()
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum FormValue {
    String(String),
    Utf16(Vec<u16>),
}

impl FormValue {
    fn as_lossy_str(&self) -> Cow<'_, str> {
        match self {
            Self::String(value) => Cow::Borrowed(value),
            Self::Utf16(value) => Cow::Owned(String::from_utf16_lossy(value)),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    method: Method,
    #[serde(default)]
    node_id: Option<u32>,
    #[serde(default)]
    ax_id: Option<String>,
    #[serde(default = "default_fetch_relatives")]
    fetch_relatives: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    accessible_name: Option<String>,
    #[serde(default)]
    frame_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    depth: Option<i32>,
    #[serde(default)]
    buffered: bool,
    #[serde(default)]
    visibility: bool,
    #[serde(default)]
    values: Vec<(u32, FormValue)>,
    #[serde(default)]
    checked: Vec<(u32, bool)>,
    #[serde(default)]
    selected: Vec<(u32, bool)>,
}

fn default_fetch_relatives() -> bool {
    true
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Method {
    Full,
    Root,
    Children,
    Ancestors,
    Partial,
    Query,
}

#[derive(Clone, Copy, Default)]
struct Inherited {
    aria_hidden: bool,
    hidden: bool,
    text_hidden: bool,
    layout_table: bool,
    list_depth: usize,
}

#[derive(Clone, Copy)]
struct BuildFrame {
    id: NodeId,
    parent: Option<NodeId>,
    inherited: Inherited,
    depth: u32,
}

struct ElementStatus<'a> {
    name: String,
    explicit: &'a str,
    role: &'a str,
    reason: Option<&'static str>,
    no_box: bool,
    next: Inherited,
}

#[derive(Default)]
struct AxIndex {
    id_to_node: HashMap<String, NodeId>,
    label_for: HashMap<String, NodeId>,
    display_none: HashSet<u32>,
    invisible: HashSet<u32>,
    values: HashMap<u32, FormValue>,
    checked: HashMap<u32, bool>,
    selected: HashMap<u32, bool>,
    base_url: String,
    root_ax: Option<NodeId>,
}

struct Context<'a> {
    doc: &'a BaseDocument,
    req: &'a Request,
    handles: RefCell<&'a mut NodeHandleMap>,
    index: &'a AxIndex,
}

fn tag(node: &Node) -> String {
    match &node.data {
        NodeData::Element(data) | NodeData::AnonymousBlock(data) => data.name.local.to_lowercase(),
        NodeData::Document(_) => "#document".into(),
        NodeData::ShadowRoot(_) => "#document-fragment".into(),
        NodeData::Text(_) => "#text".into(),
        NodeData::Comment { .. } => "#comment".into(),
    }
}

fn attr<'a>(node: &'a Node, wanted: &str) -> Option<&'a str> {
    let data = match &node.data {
        NodeData::Element(data) | NodeData::AnonymousBlock(data) => data,
        _ => return None,
    };
    data.attrs.iter().rev().find_map(|attribute| {
        let name = match attribute.prefix() {
            Some(prefix) => format!("{}:{}", prefix, attribute.name.local),
            None => attribute.name.local.to_string(),
        };
        (name.to_lowercase() == wanted).then_some(attribute.value.as_str())
    })
}

fn skip(tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "noscript" | "template" | "meta" | "link" | "base" | "head" | "title"
    )
}

fn buildable(node: &Node) -> bool {
    match &node.data {
        NodeData::Text(text) => !collapse(&text.content).is_empty(),
        NodeData::Element(_) | NodeData::AnonymousBlock(_) => !skip(&tag(node)),
        _ => false,
    }
}

impl AxIndex {
    fn new(
        doc: &BaseDocument,
        req: &Request,
        display_none: HashSet<u32>,
        invisible: HashSet<u32>,
    ) -> Self {
        let root = doc.root_node().id();
        let mut ctx = Self {
            id_to_node: HashMap::new(),
            label_for: HashMap::new(),
            display_none,
            invisible,
            values: req
                .values
                .iter()
                .map(|(id, value)| (*id, value.clone()))
                .collect(),
            checked: req.checked.iter().copied().collect(),
            selected: req.selected.iter().copied().collect(),
            base_url: req.url.clone(),
            root_ax: None,
        };
        let mut saw_base = false;
        let mut stack = vec![IndexFrame::new(root)];
        while let Some(frame) = stack.last_mut() {
            let Some(node) = doc.get_node(frame.id) else {
                stack.pop();
                continue;
            };
            if !frame.entered {
                frame.entered = true;
                let id = frame.id;
                index_entered_node(&mut ctx, node, id, &mut saw_base);
                continue;
            }
            if let Some(child) = node.children().get(frame.next_child_index) {
                frame.next_child_index += 1;
                stack.push(IndexFrame::new(child));
                continue;
            }
            if frame.shadow_pending {
                frame.shadow_pending = false;
                if let Some(shadow) = node.attached_shadow_root_id() {
                    stack.push(IndexFrame::new(shadow));
                    continue;
                }
            }
            stack.pop();
        }
        ctx.root_ax = doc
            .root_node()
            .children()
            .iter()
            .find(|id| doc.get_node(*id).is_some_and(buildable));
        ctx
    }
}

fn index_entered_node(ctx: &mut AxIndex, node: &Node, id: NodeId, saw_base: &mut bool) {
    let name = tag(node);
    if let Some(id_attr) = attr(node, "id").filter(|v| !v.is_empty()) {
        ctx.id_to_node.insert(id_attr.into(), id);
    }
    if name == "label" {
        if let Some(for_id) = attr(node, "for").filter(|v| !v.is_empty()) {
            ctx.label_for.entry(for_id.into()).or_insert(id);
        }
    }
    if name == "base" && !*saw_base {
        let Some(href) = attr(node, "href").filter(|v| !v.is_empty()) else {
            return;
        };
        *saw_base = true;
        let resolved = abs_url(href, &ctx.base_url);
        if !resolved.is_empty() {
            ctx.base_url = resolved;
        }
    }
}

struct IndexFrame {
    id: NodeId,
    next_child_index: usize,
    shadow_pending: bool,
    entered: bool,
}

impl IndexFrame {
    fn new(id: NodeId) -> Self {
        Self {
            id,
            next_child_index: 0,
            shadow_pending: true,
            entered: false,
        }
    }
}

impl<'a> Context<'a> {
    fn new(
        doc: &'a BaseDocument,
        req: &'a Request,
        handles: &'a mut NodeHandleMap,
        index: &'a AxIndex,
    ) -> Self {
        Self {
            doc,
            req,
            handles: RefCell::new(handles),
            index,
        }
    }

    fn id(&self, node: NodeId) -> u32 {
        self.handles.borrow_mut().external_for(node)
    }

    fn resolve(&self, external: u32) -> Option<NodeId> {
        self.handles.borrow().resolve(external)
    }

    fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.doc.get_node(id)?.parent_id()
    }

    fn children(&self, node: &Node) -> Vec<NodeId> {
        let mut children = Vec::new();
        if let Some(shadow) = node
            .attached_shadow_root_id()
            .and_then(|id| self.doc.get_node(id))
        {
            children.extend(shadow.children());
        }
        children.extend(node.children());
        children.retain(|id| self.doc.get_node(*id).is_some_and(buildable));
        children
    }

    fn child_at(&self, node: &Node, index: usize) -> Option<NodeId> {
        let shadow_children = node
            .attached_shadow_root_id()
            .and_then(|id| self.doc.get_node(id))
            .map(|shadow| shadow.children());
        let shadow_len = shadow_children.map_or(0, |children| children.len());
        shadow_children
            .and_then(|children| children.get(index))
            .or_else(|| node.children().get(index.checked_sub(shadow_len)?))
    }

    fn next_buildable_child(&self, parent: NodeId, index: &mut usize) -> Option<NodeId> {
        let node = self.doc.get_node(parent)?;
        loop {
            let child = self.child_at(node, *index)?;
            *index += 1;
            if self.doc.get_node(child).is_some_and(buildable) {
                return Some(child);
            }
        }
    }

    fn descendant_inherited(&self, frame: BuildFrame) -> Option<Inherited> {
        let node = self.doc.get_node(frame.id)?;
        if matches!(node.data, NodeData::Text(_)) {
            return None;
        }
        let status = self.element_status(node, frame.inherited);
        (!status.no_box).then_some(status.next)
    }

    fn in_select(&self, id: NodeId) -> bool {
        let mut parent = self.parent(id);
        if parent
            .and_then(|id| self.doc.get_node(id))
            .is_some_and(|node| tag(node) == "optgroup")
        {
            parent = parent.and_then(|id| self.parent(id));
        }
        parent
            .and_then(|id| self.doc.get_node(id))
            .is_some_and(|node| tag(node) == "select")
    }
}

#[cfg(test)]
pub(crate) fn build_json(dom: &DomHandle, request_json: &str) -> Result<String, String> {
    let request: Request = serde_json::from_str(request_json).map_err(|err| err.to_string())?;
    let visibility = if request.visibility {
        dom.not_rendered_ids()
    } else {
        Default::default()
    };
    let doc = match dom.doc.try_borrow() {
        Ok(doc) => doc,
        Err(_) if request.method == Method::Root => return Err("No document loaded".into()),
        Err(_) => return Ok("{\"nodes\":[]}".into()),
    };
    let mut handles = dom.node_handles.borrow_mut();
    let index = AxIndex::new(
        doc.as_ref(),
        &request,
        visibility.display_none.into_iter().collect(),
        visibility.invisible.into_iter().collect(),
    );
    let context = Context::new(doc.as_ref(), &request, &mut handles, &index);
    let mut count = ByteCount::default();
    context.write_reply(&mut count);
    let mut result = String::with_capacity(count.0);
    context.write_reply(&mut result);
    drop(context);
    drop(handles);
    drop(doc);
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AxBudgetError {
    pub(crate) nodes: usize,
    pub(crate) bytes: usize,
    pub(crate) budget: usize,
}

#[derive(Debug)]
pub(crate) enum AxStartError {
    Request(String),
    NoDocument,
    Random(String),
    InternalState,
    Budget(AxBudgetError),
}

#[wasm_bindgen]
pub struct AxStart {
    budget_error: Option<AxBudgetError>,
    byte_length: usize,
    stream: Option<AxJsonStream>,
    bytes: Option<OuterHtmlBytes>,
}

#[wasm_bindgen]
impl AxStart {
    #[wasm_bindgen(js_name = "budgetError")]
    pub fn budget_error(&self) -> Option<String> {
        self.budget_error.as_ref().map(|error| {
            format!(
                "{{\"nodes\":{},\"bytes\":{},\"budget\":{}}}",
                error.nodes, error.bytes, error.budget
            )
        })
    }

    #[wasm_bindgen(getter, js_name = "byteLength")]
    pub fn byte_length(&self) -> usize {
        self.byte_length
    }

    #[wasm_bindgen(js_name = "takeStream")]
    pub fn take_stream(&mut self) -> Option<AxJsonStream> {
        self.stream.take()
    }

    #[wasm_bindgen(js_name = "takeBytes")]
    pub fn take_bytes(&mut self) -> Option<OuterHtmlBytes> {
        self.bytes.take()
    }
}

#[wasm_bindgen]
pub struct AxJsonStream {
    request: Request,
    index: AxIndex,
    traversal: AxTraversal,
    sink: AxStreamSink,
    expected_hash: u64,
    byte_length: usize,
    emitted: usize,
    torn: bool,
}

#[wasm_bindgen]
impl AxJsonStream {
    #[wasm_bindgen(getter, js_name = "byteLength")]
    pub fn byte_length(&self) -> usize {
        self.byte_length
    }

    #[wasm_bindgen(js_name = "nextChunk")]
    pub fn next_chunk(&mut self, dom: &DomHandle, max: usize) -> Vec<u8> {
        let remaining = self.byte_length.saturating_sub(self.emitted);
        if remaining == 0 || self.torn {
            return Vec::new();
        }
        let want = max.max(1).min(remaining);
        let last = want == remaining;
        {
            let Ok(doc) = dom.doc.try_borrow() else {
                return self.tear();
            };
            let mut handles = dom.node_handles.borrow_mut();
            let context = Context::new(doc.as_ref(), &self.request, &mut handles, &self.index);
            if !self.traversal.fill(&context, &mut self.sink, want, last) {
                return self.tear();
            }
        }
        let unread = self.sink.unread();
        if last
            && (!self.traversal.done
                || unread != remaining
                || self.sink.bytes != self.byte_length
                || self.sink.hasher.finish() != self.expected_hash)
        {
            return self.tear();
        }
        let count = want.min(unread);
        if count == 0 {
            return self.tear();
        }
        let chunk = self.sink.take(count);
        self.emitted += count;
        if self.emitted == self.byte_length {
            self.sink.clear();
        }
        chunk
    }
}

impl AxJsonStream {
    #[cfg(test)]
    pub(crate) fn serialized_nodes(&self) -> usize {
        self.sink.serialized_nodes
    }

    fn tear(&mut self) -> Vec<u8> {
        self.torn = true;
        self.traversal.stack.clear();
        self.sink.clear();
        self.index = AxIndex::default();
        Vec::new()
    }
}

struct AxStreamSink {
    pending: Vec<u8>,
    taken: usize,
    bytes: usize,
    byte_limit: usize,
    overflowed: bool,
    hasher: OutputHasher,
    #[cfg(test)]
    serialized_nodes: usize,
}

impl JsonSink for AxStreamSink {
    fn push_str(&mut self, value: &str) {
        self.push_bytes(value.as_bytes());
    }

    fn node(&mut self) {
        #[cfg(test)]
        {
            self.serialized_nodes += 1;
        }
    }
}

impl AxStreamSink {
    fn push_bytes(&mut self, value: &[u8]) {
        if self.overflowed {
            return;
        }
        let available = self.byte_limit.saturating_sub(self.bytes);
        let count = value.len().min(available);
        self.bytes += count;
        self.hasher.write(&value[..count]);
        self.pending.extend_from_slice(&value[..count]);
        self.overflowed = count != value.len();
    }

    fn unread(&self) -> usize {
        self.pending.len() - self.taken
    }

    fn take(&mut self, count: usize) -> Vec<u8> {
        let chunk = self.pending[self.taken..self.taken + count].to_vec();
        self.taken += count;
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

enum AxCurrent {
    Root,
    Node(BuildFrame),
}

struct AxTraversal {
    stack: Vec<ChildCursor>,
    full: bool,
    root_pending: bool,
    current: Option<AxCurrent>,
    opened: bool,
    first: bool,
    done: bool,
}

#[derive(Clone, Copy)]
struct ChildCursor {
    parent: NodeId,
    next_child_index: usize,
    inherited: Inherited,
}

impl AxTraversal {
    fn new(context: &Context<'_>) -> Self {
        let full = context.req.method == Method::Full;
        let root_pending = full || context.root_matches_query();
        let depth_limit = context
            .req
            .depth
            .filter(|depth| *depth >= 0)
            .and_then(|depth| u32::try_from(depth).ok());
        let stack = if full && depth_limit == Some(0) {
            Vec::new()
        } else {
            vec![ChildCursor {
                parent: context.doc.root_node().id(),
                next_child_index: 0,
                inherited: Inherited::default(),
            }]
        };
        Self {
            stack,
            full,
            root_pending,
            current: None,
            opened: false,
            first: true,
            done: false,
        }
    }

    fn fill(
        &mut self,
        context: &Context<'_>,
        sink: &mut AxStreamSink,
        target: usize,
        finish: bool,
    ) -> bool {
        if !self.opened {
            sink.push_str("{\"nodes\":[");
            self.opened = true;
        }
        let depth_limit = context
            .req
            .depth
            .filter(|depth| *depth >= 0)
            .and_then(|depth| u32::try_from(depth).ok());
        loop {
            if self.done || (sink.unread() >= target && (!finish || self.done)) {
                return true;
            }
            if self.current.is_none() && self.root_pending {
                self.current = Some(AxCurrent::Root);
            }
            if self.current.is_none() {
                let frame = match self.next_frame(context) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => {
                        sink.push_str("]}");
                        self.done = true;
                        continue;
                    }
                    Err(()) => return false,
                };
                if context.doc.get_node(frame.id).is_none() {
                    return false;
                }
                if self.full || context.query_matches(frame) {
                    self.current = Some(AxCurrent::Node(frame));
                } else {
                    self.skip_unmatched(context, frame);
                    continue;
                }
            }
            let Some(current) = self.current.take() else {
                return false;
            };
            match current {
                AxCurrent::Root => {
                    context.write_root(sink);
                    self.root_pending = false;
                }
                AxCurrent::Node(frame) => {
                    if !self.first {
                        sink.push_str(",");
                    }
                    let Some(node) = context.doc.get_node(frame.id) else {
                        return false;
                    };
                    let (has_children, inherited) =
                        context.write_node(sink, node, frame.parent, frame.inherited);
                    if has_children
                        && (!self.full || depth_limit.is_none_or(|limit| frame.depth < limit))
                    {
                        self.stack.push(ChildCursor {
                            parent: node.id(),
                            next_child_index: 0,
                            inherited,
                        });
                    }
                }
            }
            if sink.overflowed {
                return false;
            }
            self.first = false;
        }
    }

    fn skip_unmatched(&mut self, context: &Context<'_>, frame: BuildFrame) {
        if let Some(inherited) = context.descendant_inherited(frame) {
            self.stack.push(ChildCursor {
                parent: frame.id,
                next_child_index: 0,
                inherited,
            });
        }
    }

    fn next_frame(&mut self, context: &Context<'_>) -> Result<Option<BuildFrame>, ()> {
        loop {
            let depth = u32::try_from(self.stack.len()).unwrap_or(u32::MAX);
            let Some(cursor) = self.stack.last_mut() else {
                return Ok(None);
            };
            let parent = cursor.parent;
            let inherited = cursor.inherited;
            if let Some(id) = context.next_buildable_child(parent, &mut cursor.next_child_index) {
                return Ok(Some(BuildFrame {
                    id,
                    parent: (parent != context.doc.root_node().id()).then_some(parent),
                    inherited,
                    depth,
                }));
            }
            if context.doc.get_node(parent).is_none() {
                return Err(());
            }
            self.stack.pop();
        }
    }
}

impl Context<'_> {
    fn root_matches_query(&self) -> bool {
        self.req
            .role
            .as_deref()
            .is_none_or(|role| role.is_empty() || role == "RootWebArea")
            && self
                .req
                .accessible_name
                .as_deref()
                .is_none_or(|name| name == self.req.title)
    }
}

pub(crate) fn start_accessibility_with_budget(
    dom: &DomHandle,
    request_json: &str,
    budget: usize,
) -> Result<AxStart, AxStartError> {
    let request: Request = serde_json::from_str(request_json)
        .map_err(|error| AxStartError::Request(error.to_string()))?;
    let streaming = !request.buffered
        && (request.method == Method::Full
            || (request.method == Method::Query && request.node_id.is_none()));
    let key = if streaming {
        Some(output_hash_key().map_err(|error| AxStartError::Random(error.to_string()))?)
    } else {
        None
    };
    let visibility = if request.visibility {
        dom.not_rendered_ids()
    } else {
        Default::default()
    };
    let doc = match dom.doc.try_borrow() {
        Ok(doc) => doc,
        Err(_) if request.method == Method::Root => return Err(AxStartError::NoDocument),
        Err(_) => {
            let bytes = b"{\"nodes\":[]}";
            if bytes.len() > budget {
                return Err(AxStartError::Budget(AxBudgetError {
                    nodes: 0,
                    bytes: bytes.len(),
                    budget,
                }));
            }
            return Ok(AxStart {
                budget_error: None,
                byte_length: bytes.len(),
                stream: None,
                bytes: Some(OuterHtmlBytes::from_vec(bytes.to_vec())),
            });
        }
    };
    let index = AxIndex::new(
        doc.as_ref(),
        &request,
        visibility.display_none.into_iter().collect(),
        visibility.invisible.into_iter().collect(),
    );
    let mut handles = dom.node_handles.borrow_mut();
    let context = Context::new(doc.as_ref(), &request, &mut handles, &index);
    let mut measure = MeasureSink::new(key, budget);
    context.write_reply(&mut measure);
    if measure.bytes > budget {
        return Err(AxStartError::Budget(AxBudgetError {
            nodes: measure.nodes,
            bytes: measure.bytes,
            budget,
        }));
    }
    if streaming {
        let traversal = AxTraversal::new(&context);
        let (Some(stream_key), Some(expected_hash)) = (key, measure.finish_hash()) else {
            drop(handles);
            drop(doc);
            return Err(AxStartError::InternalState);
        };
        let byte_length = measure.bytes;
        drop(handles);
        drop(doc);
        return Ok(AxStart {
            budget_error: None,
            byte_length,
            stream: Some(AxJsonStream {
                request,
                index,
                traversal,
                sink: AxStreamSink {
                    pending: Vec::new(),
                    taken: 0,
                    bytes: 0,
                    byte_limit: byte_length,
                    overflowed: false,
                    hasher: output_hasher(stream_key),
                    #[cfg(test)]
                    serialized_nodes: 0,
                },
                expected_hash,
                byte_length,
                emitted: 0,
                torn: false,
            }),
            bytes: None,
        });
    }
    let mut output = Vec::with_capacity(measure.bytes);
    context.write_reply(&mut output);
    let byte_length = output.len();
    drop(handles);
    drop(doc);
    Ok(AxStart {
        budget_error: None,
        byte_length,
        stream: None,
        bytes: Some(OuterHtmlBytes::from_vec(output)),
    })
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "accessibilityStream")]
    pub fn accessibility_stream(&self, request_json: &str) -> Result<AxStart, JsError> {
        match start_accessibility_with_budget(self, request_json, AX_REPLY_BUDGET_BYTES) {
            Ok(start) => Ok(start),
            Err(AxStartError::Budget(error)) => Ok(AxStart {
                budget_error: Some(error),
                byte_length: 0,
                stream: None,
                bytes: None,
            }),
            Err(AxStartError::Request(error)) => Err(JsError::new(&error)),
            Err(AxStartError::NoDocument) => Err(JsError::new("No document loaded")),
            Err(AxStartError::Random(error)) => Err(JsError::new(&format!(
                "accessibility stream could not initialize its tear check: {error}"
            ))),
            Err(AxStartError::InternalState) => Err(JsError::new(
                "accessibility stream could not initialize its tear check",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{JsonSink, MeasureSink, output_hash_key};

    #[test]
    fn measure_sink_stops_hashing_after_budget_but_keeps_counting() {
        let key = output_hash_key().expect("hash key generation succeeds");
        let mut sink = MeasureSink::new(Some(key), 3);
        sink.push_str("abc");
        assert!(sink.hasher.is_some());
        sink.push_str("d");
        assert!(sink.hasher.is_none());
        sink.push_str("ef");
        assert_eq!(sink.bytes, 6);
    }
}

#[derive(Clone)]
enum Scalar {
    String(String),
    Utf16(Vec<u16>),
    Number(f64),
    Bool(bool),
}

struct Value {
    kind: &'static str,
    value: Scalar,
}

struct Property {
    name: &'static str,
    value: Value,
}

fn string_value(kind: &'static str, value: impl Into<String>) -> Value {
    Value {
        kind,
        value: Scalar::String(value.into()),
    }
}

fn form_string_value(kind: &'static str, value: &FormValue) -> Value {
    Value {
        kind,
        value: match value {
            FormValue::String(value) => Scalar::String(value.clone()),
            FormValue::Utf16(value) => Scalar::Utf16(value.clone()),
        },
    }
}

fn number_value(kind: &'static str, value: f64) -> Value {
    Value {
        kind,
        value: Scalar::Number(value),
    }
}

fn bool_value(kind: &'static str, value: bool) -> Value {
    Value {
        kind,
        value: Scalar::Bool(value),
    }
}

fn write_value<S: JsonSink>(out: &mut S, value: &Value) {
    out.push_str("{\"type\":");
    write_string(out, value.kind);
    out.push_str(",\"value\":");
    match &value.value {
        Scalar::String(value) => write_string(out, value),
        Scalar::Utf16(value) => write_utf16_string(out, value),
        Scalar::Number(value) => write_number(out, *value),
        Scalar::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
    }
    out.push_str("}");
}

fn write_property<S: JsonSink>(out: &mut S, property: &Property) {
    out.push_str("{\"name\":");
    write_string(out, property.name);
    out.push_str(",\"value\":");
    write_value(out, &property.value);
    out.push_str("}");
}

fn first_token(node: &Node) -> &str {
    attr(node, "role")
        .and_then(|value| split_js_ws(value).next())
        .unwrap_or("")
}

fn input_type(node: &Node) -> String {
    attr(node, "type")
        .filter(|v| !v.is_empty())
        .unwrap_or("text")
        .to_lowercase()
}

fn implicit_role(node: &Node, name: &str) -> &'static str {
    match name {
        "a" | "area" => {
            if attr(node, "href").is_some() {
                "link"
            } else {
                "generic"
            }
        }
        "article" => "article",
        "aside" => "complementary",
        "blockquote" => "blockquote",
        "body" => "generic",
        "button" | "summary" => "button",
        "caption" => "caption",
        "code" => "code",
        "datalist" => "listbox",
        "del" => "deletion",
        "details" | "fieldset" => "group",
        "dfn" | "dt" => "term",
        "dialog" => "dialog",
        "dd" => "definition",
        "em" => "emphasis",
        "figure" => "figure",
        "footer" => "contentinfo",
        "form" => "form",
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => "heading",
        "header" => "banner",
        "hr" => "separator",
        "html" => "document",
        "iframe" => "Iframe",
        "img" => {
            if attr(node, "alt") == Some("") {
                "presentation"
            } else {
                "image"
            }
        }
        "input" => match input_type(node).as_str() {
            "button" | "submit" | "reset" | "image" => "button",
            "checkbox" => "checkbox",
            "radio" => "radio",
            "range" => "slider",
            "number" => "spinbutton",
            "search" => "searchbox",
            _ => "textbox",
        },
        "ins" => "insertion",
        "li" => "listitem",
        "main" => "main",
        "mark" => "mark",
        "math" => "math",
        "menu" | "ol" | "ul" => "list",
        "meter" => "meter",
        "nav" => "navigation",
        "option" => "option",
        "output" => "status",
        "p" => "paragraph",
        "progress" => "progressbar",
        "search" => "search",
        "section" => {
            if attr(node, "aria-label").is_some() || attr(node, "aria-labelledby").is_some() {
                "region"
            } else {
                "generic"
            }
        }
        "select" => {
            if attr(node, "multiple").is_some()
                || js_number(attr(node, "size").unwrap_or("0")) > 1.0
            {
                "listbox"
            } else {
                "combobox"
            }
        }
        "strong" => "strong",
        "sub" => "subscript",
        "sup" => "superscript",
        "svg" => "graphics-document",
        "table" => "table",
        "textarea" => "textbox",
        "tbody" | "thead" | "tfoot" => "rowgroup",
        "td" => "cell",
        "th" => {
            if attr(node, "scope") == Some("row") {
                "rowheader"
            } else {
                "columnheader"
            }
        }
        "time" => "time",
        "tr" => "row",
        _ => "generic",
    }
}

fn focusable(node: &Node, name: &str) -> bool {
    if attr(node, "disabled").is_some() {
        return false;
    }
    if attr(node, "tabindex").is_some() {
        return true;
    }
    if attr(node, "contenteditable").is_some_and(|v| v != "false") {
        return true;
    }
    match name {
        "a" | "area" => attr(node, "href").is_some(),
        "button" | "input" | "select" | "textarea" | "summary" | "iframe" => true,
        "audio" | "video" => attr(node, "controls").is_some(),
        _ => false,
    }
}

impl Context<'_> {
    fn text_from_subtree(&self, node: &Node, exclude: Option<NodeId>) -> String {
        let mut parts = Vec::new();
        let mut stack: Vec<NodeId> = node.children().iter().rev().collect();
        while let Some(id) = stack.pop() {
            if Some(id) == exclude {
                continue;
            }
            let Some(node) = self.doc.get_node(id) else {
                continue;
            };
            match &node.data {
                NodeData::Text(text) => {
                    if !text.content.is_empty() {
                        parts.push(text.content.as_str());
                    }
                }
                NodeData::Element(_) | NodeData::AnonymousBlock(_) => {
                    let name = tag(node);
                    if skip(&name) || attr(node, "aria-hidden") == Some("true") {
                        continue;
                    }
                    if let Some(label) = attr(node, "aria-label")
                        .map(js_trim)
                        .filter(|v| !v.is_empty())
                    {
                        parts.push(label);
                        continue;
                    }
                    if name == "img" {
                        if let Some(alt) = attr(node, "alt").filter(|v| !v.is_empty()) {
                            parts.push(alt);
                        }
                        continue;
                    }
                    stack.extend(node.children().iter().rev());
                }
                _ => {}
            }
        }
        collapse(&parts.join(" "))
    }

    fn referenced_text(&self, value: &str) -> String {
        let parts: Vec<String> = split_js_ws(value)
            .filter_map(|id| self.index.id_to_node.get(id))
            .filter_map(|id| self.doc.get_node(*id))
            .map(|node| self.text_from_subtree(node, None))
            .collect();
        js_trim(&parts.join(" ")).to_string()
    }

    fn wrapping_label(&self, node: &Node) -> String {
        let mut parent = self.parent(node.id());
        for _ in 0..8 {
            let Some(id) = parent else { break };
            let Some(current) = self.doc.get_node(id) else {
                break;
            };
            // A shadow root's parent is its host, but a label outside the shadow
            // tree does not name a control inside it.
            if matches!(current.data, NodeData::ShadowRoot(_)) {
                break;
            }
            if tag(current) == "label" {
                return self.text_from_subtree(current, Some(node.id()));
            }
            parent = self.parent(id);
        }
        String::new()
    }

    fn name(&self, node: &Node, name: &str) -> String {
        if let Some(value) = attr(node, "aria-labelledby").filter(|v| !v.is_empty()) {
            let text = self.referenced_text(value);
            if !text.is_empty() {
                return text;
            }
        }
        if let Some(value) = attr(node, "aria-label")
            .map(js_trim)
            .filter(|v| !v.is_empty())
        {
            return value.into();
        }
        if matches!(name, "img" | "area") {
            if let Some(value) = attr(node, "alt").filter(|v| !v.is_empty()) {
                return value.into();
            }
        }
        if name == "input" {
            let kind = input_type(node);
            if matches!(kind.as_str(), "button" | "submit" | "reset") {
                if let Some(value) = attr(node, "value").filter(|v| !v.is_empty()) {
                    return value.into();
                }
                if kind == "submit" {
                    return "Submit".into();
                }
                if kind == "reset" {
                    return "Reset".into();
                }
            }
            if kind == "image" {
                if let Some(alt) = attr(node, "alt").filter(|v| !v.is_empty()) {
                    return alt.into();
                }
            }
        }
        if matches!(name, "input" | "textarea" | "select") {
            if let Some(label) = attr(node, "id")
                .and_then(|id| self.index.label_for.get(id))
                .and_then(|id| self.doc.get_node(*id))
            {
                let text = self.text_from_subtree(label, None);
                if !text.is_empty() {
                    return text;
                }
            }
            let wrapped = self.wrapping_label(node);
            if !wrapped.is_empty() {
                return wrapped;
            }
            if name != "select" {
                if let Some(value) = attr(node, "placeholder").filter(|v| !v.is_empty()) {
                    return value.into();
                }
            }
        }
        let child_name = match name {
            "fieldset" => "legend",
            "table" => "caption",
            "figure" => "figcaption",
            "svg" => "title",
            _ => "",
        };
        if !child_name.is_empty() {
            if let Some(child) = node
                .children()
                .iter()
                .filter_map(|id| self.doc.get_node(id))
                .find(|child| tag(child) == child_name)
            {
                return self.text_from_subtree(child, None);
            }
        }
        let from_contents = matches!(
            name,
            "a" | "button"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "summary"
                | "th"
                | "td"
                | "option"
                | "figcaption"
                | "label"
                | "legend"
        ) || matches!(
            first_token(node),
            "button"
                | "cell"
                | "checkbox"
                | "columnheader"
                | "gridcell"
                | "heading"
                | "link"
                | "menuitem"
                | "menuitemcheckbox"
                | "menuitemradio"
                | "option"
                | "radio"
                | "row"
                | "rowheader"
                | "switch"
                | "tab"
                | "tooltip"
                | "treeitem"
        );
        if from_contents {
            let text = self.text_from_subtree(node, None);
            if !text.is_empty() {
                return text;
            }
        }
        attr(node, "title").map(js_trim).unwrap_or("").into()
    }

    fn description(&self, node: &Node) -> String {
        if let Some(value) = attr(node, "aria-describedby").filter(|v| !v.is_empty()) {
            let text = self.referenced_text(value);
            if !text.is_empty() {
                return text;
            }
        }
        attr(node, "aria-description")
            .map(js_trim)
            .unwrap_or("")
            .into()
    }

    fn selected_option(&self, select: &Node) -> Option<String> {
        let mut options = Vec::new();
        for child in select
            .children()
            .iter()
            .filter_map(|id| self.doc.get_node(id))
        {
            match tag(child).as_str() {
                "option" => options.push(child),
                "optgroup" => options.extend(
                    child
                        .children()
                        .iter()
                        .filter_map(|id| self.doc.get_node(id))
                        .filter(|node| tag(node) == "option"),
                ),
                _ => {}
            }
        }
        let have_live = options
            .iter()
            .any(|node| self.index.selected.contains_key(&self.id(node.id())));
        let chosen = if have_live {
            options
                .iter()
                .copied()
                .find(|node| self.index.selected.get(&self.id(node.id())) == Some(&true))
        } else if let Some(marked) = options
            .iter()
            .rev()
            .copied()
            .find(|node| attr(node, "selected").is_some())
        {
            Some(marked)
        } else if js_parse_int(attr(select, "size").unwrap_or("")) > 1.0 {
            None
        } else {
            let mut found = None;
            for child in select
                .children()
                .iter()
                .filter_map(|id| self.doc.get_node(id))
            {
                if attr(child, "disabled").is_some() {
                    continue;
                }
                match tag(child).as_str() {
                    "option" => {
                        found = Some(child);
                        break;
                    }
                    "optgroup" => {
                        found = child
                            .children()
                            .iter()
                            .filter_map(|id| self.doc.get_node(id))
                            .find(|node| tag(node) == "option" && attr(node, "disabled").is_none());
                        if found.is_some() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            found
        }?;
        Some(
            attr(chosen, "label")
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| self.text_from_subtree(chosen, None)),
        )
    }

    fn value(&self, node: &Node, name: &str) -> Option<Value> {
        let live = self.index.values.get(&self.id(node.id()));
        if name == "input" {
            if matches!(input_type(node).as_str(), "range" | "number") {
                let value = live
                    .map(FormValue::as_lossy_str)
                    .or_else(|| attr(node, "value").map(Cow::Borrowed));
                if let Some(value) = value.filter(|value| !value.is_empty()) {
                    return Some(number_value("number", js_number(&value)));
                }
            } else if let Some(value) = live {
                return Some(form_string_value("string", value));
            } else if let Some(value) = attr(node, "value") {
                return Some(string_value("string", value));
            }
        }
        if name == "select" && attr(node, "multiple").is_none() {
            if let Some(label) = self.selected_option(node) {
                return Some(string_value("string", label));
            }
        }
        if attr(node, "contenteditable").is_some_and(|v| v.to_lowercase() != "false") {
            return Some(string_value("string", self.text_from_subtree(node, None)));
        }
        if name == "textarea" {
            if let Some(value) = live {
                return Some(form_string_value("string", value));
            }
            let text = self.text_from_subtree(node, None);
            if !text.is_empty() {
                return Some(string_value("string", text));
            }
        }
        if let Some(value) = attr(node, "aria-valuenow")
            .map(js_number)
            .filter(|n| n.is_finite())
        {
            return Some(number_value("number", value));
        }
        attr(node, "aria-valuetext")
            .filter(|v| !v.is_empty())
            .map(|v| string_value("string", v))
    }

    fn properties(&self, node: &Node, name: &str, role: &str, depth: usize) -> Vec<Property> {
        let mut properties = Vec::new();
        let mut push = |name, value| properties.push(Property { name, value });
        if name.len() == 2 && name.starts_with('h') {
            if let Some(n @ b'1'..=b'6') = name.as_bytes().get(1).copied() {
                push("level", number_value("integer", f64::from(n - b'0')));
            }
        }
        let aria_level = attr(node, "aria-level");
        if let Some(n) = aria_level.map(js_number).filter(|n| n.is_finite()) {
            push("level", number_value("integer", n));
        }
        if role == "listitem" && aria_level.is_none() && depth > 0 {
            push("level", number_value("integer", depth as f64));
        }
        let url_attr = if role == "link" {
            Some("href")
        } else if name == "img" {
            Some("src")
        } else {
            None
        };
        if let Some(raw) = url_attr.and_then(|name| attr(node, name)) {
            let resolved = abs_url(raw, &self.index.base_url);
            push(
                "url",
                string_value(
                    "string",
                    if resolved.is_empty() {
                        raw.to_string()
                    } else {
                        resolved
                    },
                ),
            );
        }
        if focusable(node, name) {
            push("focusable", bool_value("booleanOrUndefined", true));
        }
        if let Some(key) = attr(node, "accesskey").filter(|v| !v.is_empty()) {
            if attr(node, "aria-keyshortcuts").is_none_or(str::is_empty) {
                push(
                    "keyshortcuts",
                    string_value("string", format!("Ctrl+Alt+{key}")),
                );
            }
        }
        for (name, aria) in [
            ("expanded", "aria-expanded"),
            ("disabled", "aria-disabled"),
            ("required", "aria-required"),
            ("readonly", "aria-readonly"),
            ("selected", "aria-selected"),
            ("modal", "aria-modal"),
            ("multiline", "aria-multiline"),
            ("multiselectable", "aria-multiselectable"),
            ("atomic", "aria-atomic"),
            ("busy", "aria-busy"),
        ] {
            match attr(node, aria) {
                Some("true") => push(name, bool_value("boolean", true)),
                Some("false") => push(name, bool_value("boolean", false)),
                _ => {}
            }
        }
        for (name, aria) in [("checked", "aria-checked"), ("pressed", "aria-pressed")] {
            if let Some(value @ ("true" | "false" | "mixed")) = attr(node, aria) {
                push(name, string_value("tristate", value));
            }
        }
        if matches!(name, "input" | "textarea" | "select" | "button") {
            for property in ["disabled", "required", "readonly"] {
                if attr(node, property).is_some() {
                    push(property, bool_value("boolean", true));
                }
            }
        }
        if name == "input" && matches!(input_type(node).as_str(), "checkbox" | "radio") {
            let checked = self
                .index
                .checked
                .get(&self.id(node.id()))
                .copied()
                .unwrap_or_else(|| attr(node, "checked").is_some());
            push(
                "checked",
                string_value("tristate", if checked { "true" } else { "false" }),
            );
        }
        if name == "option"
            && self
                .index
                .selected
                .get(&self.id(node.id()))
                .copied()
                .unwrap_or_else(|| attr(node, "selected").is_some())
        {
            push("selected", bool_value("boolean", true));
        }
        if name == "details" && attr(node, "open").is_some() {
            push("expanded", bool_value("boolean", true));
        }
        if let Some(value) = attr(node, "aria-haspopup").filter(|v| !v.is_empty() && *v != "false")
        {
            push(
                "hasPopup",
                string_value("token", if value == "true" { "menu" } else { value }),
            );
        }
        for (name, aria) in [
            ("keyshortcuts", "aria-keyshortcuts"),
            ("roledescription", "aria-roledescription"),
            ("autocomplete", "aria-autocomplete"),
            ("orientation", "aria-orientation"),
            ("live", "aria-live"),
            ("relevant", "aria-relevant"),
            ("placeholder", "aria-placeholder"),
            ("valuetext", "aria-valuetext"),
        ] {
            if let Some(value) = attr(node, aria).filter(|v| !v.is_empty()) {
                push(name, string_value("string", value));
            }
        }
        for (name, aria) in [
            ("valuemin", "aria-valuemin"),
            ("valuemax", "aria-valuemax"),
            ("valuenow", "aria-valuenow"),
            ("setsize", "aria-setsize"),
            ("posinset", "aria-posinset"),
            ("colcount", "aria-colcount"),
            ("rowcount", "aria-rowcount"),
            ("colindex", "aria-colindex"),
            ("rowindex", "aria-rowindex"),
            ("colspan", "aria-colspan"),
            ("rowspan", "aria-rowspan"),
        ] {
            if let Some(value) = attr(node, aria).map(js_number).filter(|v| v.is_finite()) {
                push(name, number_value("integer", value));
            }
        }
        if name == "input" && matches!(input_type(node).as_str(), "range" | "number") {
            for (property, attribute) in [
                ("valuemin", "min"),
                ("valuemax", "max"),
                ("valuenow", "value"),
            ] {
                if let Some(value) = attr(node, attribute)
                    .map(js_number)
                    .filter(|v| v.is_finite())
                {
                    push(property, number_value("number", value));
                }
            }
        }
        properties
    }
}

fn inline_display_none(style: Option<&str>) -> bool {
    let mut display = String::new();
    let mut important = false;
    for declaration in style.unwrap_or("").split(';') {
        let Some((property, value)) = declaration.split_once(':') else {
            continue;
        };
        if js_trim(property).to_lowercase() != "display" {
            continue;
        }
        let value = js_trim(value).to_lowercase();
        let stripped = value
            .strip_suffix("important")
            .map(|v| v.trim_end_matches(js_ws));
        let marked = stripped.is_some_and(|v| v.ends_with('!'));
        if important && !marked {
            continue;
        }
        display = if marked {
            js_trim(stripped.unwrap_or("").strip_suffix('!').unwrap_or("")).to_string()
        } else {
            js_trim(&value).to_string()
        };
        important = marked;
    }
    display == "none"
}

impl Context<'_> {
    fn element_status<'a>(&self, node: &'a Node, inherited: Inherited) -> ElementStatus<'a> {
        let id = self.id(node.id());
        let name = tag(node);
        let self_aria = attr(node, "aria-hidden") == Some("true");
        let aria_hidden = inherited.aria_hidden || self_aria;
        let option = name == "option"
            && self.in_select(node.id())
            && !inline_display_none(attr(node, "style"));
        let hidden_input = name == "input"
            && attr(node, "type").is_some_and(|v| js_trim(v).to_lowercase() == "hidden");
        let no_box = (self.index.display_none.contains(&id) && !option)
            || hidden_input
            || attr(node, "hidden").is_some();
        let subtree_hidden = inherited.hidden || aria_hidden || no_box;
        let hidden = subtree_hidden || self.index.invisible.contains(&id);
        let explicit = first_token(node);
        let role = if explicit.is_empty() {
            implicit_role(node, &name)
        } else {
            explicit
        };
        let layout_table = name == "table" && explicit.is_empty() && self.is_layout_table(node);
        let table_part = matches!(
            name.as_str(),
            "tr" | "td" | "th" | "thead" | "tbody" | "tfoot" | "caption" | "colgroup" | "col"
        );
        let demoted = layout_table || (inherited.layout_table && table_part && explicit.is_empty());
        let reason = if hidden {
            Some(if self_aria {
                "ariaHiddenElement"
            } else if aria_hidden {
                "ariaHiddenSubtree"
            } else {
                "notRendered"
            })
        } else if matches!(role, "presentation" | "none") || demoted {
            Some("presentationalRole")
        } else if name == "html" {
            Some("uninteresting")
        } else {
            None
        };
        let next = Inherited {
            aria_hidden,
            hidden: subtree_hidden,
            text_hidden: hidden,
            layout_table: if name == "table" {
                layout_table
            } else {
                inherited.layout_table
            },
            list_depth: inherited.list_depth + usize::from(name == "ul" || name == "ol"),
        };
        ElementStatus {
            name,
            explicit,
            role,
            reason,
            no_box,
            next,
        }
    }

    fn is_layout_table(&self, node: &Node) -> bool {
        if attr(node, "summary").is_some() {
            return false;
        }
        let mut stack = vec![(node.id(), 0)];
        while let Some((id, depth)) = stack.pop() {
            if depth > 4 {
                continue;
            }
            let Some(current) = self.doc.get_node(id) else {
                continue;
            };
            for child in current
                .children()
                .iter()
                .filter_map(|id| self.doc.get_node(id))
            {
                if !matches!(
                    child.data,
                    NodeData::Element(_) | NodeData::AnonymousBlock(_)
                ) {
                    continue;
                }
                let name = tag(child);
                if matches!(name.as_str(), "caption" | "th")
                    || (name == "td"
                        && ["scope", "headers", "abbr"]
                            .iter()
                            .any(|attr_name| attr(child, attr_name).is_some()))
                {
                    return false;
                }
                if name != "table" {
                    stack.push((child.id(), depth + 1));
                }
            }
        }
        true
    }

    fn write_root<S: JsonSink>(&self, out: &mut S) {
        out.node();
        out.push_str("{\"nodeId\":");
        write_string(out, &format!("root-{}", self.req.frame_id));
        out.push_str(",\"ignored\":false,\"role\":{\"type\":\"internalRole\",\"value\":\"RootWebArea\"},\"chromeRole\":{\"type\":\"internalRole\",\"value\":");
        out.push_str(&ROOT_WEB_AREA_ROLE_ID.to_string());
        out.push_str("},\"name\":");
        write_value(out, &string_value("computedString", &self.req.title));
        out.push_str(",\"value\":");
        write_value(out, &string_value("string", &self.req.url));
        out.push_str(",\"backendDOMNodeId\":");
        out.push_str(&self.id(self.doc.root_node().id()).to_string());
        out.push_str(",\"frameId\":");
        write_string(out, &self.req.frame_id);
        out.push_str(",\"childIds\":[");
        if let Some(root) = self.index.root_ax {
            write_string(out, &self.id(root).to_string());
        }
        out.push_str("],\"properties\":[");
        write_property(
            out,
            &Property {
                name: "url",
                value: string_value("string", &self.req.url),
            },
        );
        out.push_str(",");
        write_property(
            out,
            &Property {
                name: "focusable",
                value: bool_value("booleanOrUndefined", true),
            },
        );
        out.push_str("]}");
    }

    fn write_reply<S: JsonSink>(&self, out: &mut S) {
        if self.req.method == Method::Root {
            out.push_str("{\"node\":");
            self.write_root(out);
            out.push_str("}");
            return;
        }
        if self.req.method != Method::Full {
            self.write_scoped(out);
            return;
        }
        out.push_str("{\"nodes\":[");
        self.write_root(out);
        let depth_limit = self
            .req
            .depth
            .filter(|depth| *depth >= 0)
            .and_then(|depth| u32::try_from(depth).ok());
        let mut stack: Vec<ChildCursor> = if depth_limit == Some(0) {
            Vec::new()
        } else {
            vec![ChildCursor {
                parent: self.doc.root_node().id(),
                next_child_index: 0,
                inherited: Inherited::default(),
            }]
        };
        loop {
            let depth = u32::try_from(stack.len()).unwrap_or(u32::MAX);
            let Some(cursor) = stack.last_mut() else {
                break;
            };
            let parent = cursor.parent;
            let inherited = cursor.inherited;
            let Some(id) = self.next_buildable_child(parent, &mut cursor.next_child_index) else {
                stack.pop();
                continue;
            };
            let frame = BuildFrame {
                id,
                parent: (parent != self.doc.root_node().id()).then_some(parent),
                inherited,
                depth,
            };
            let Some(node) = self.doc.get_node(frame.id) else {
                continue;
            };
            out.push_str(",");
            let (has_children, child_inherited) =
                self.write_node(out, node, frame.parent, frame.inherited);
            if has_children && depth_limit.is_none_or(|limit| frame.depth < limit) {
                stack.push(ChildCursor {
                    parent: node.id(),
                    next_child_index: 0,
                    inherited: child_inherited,
                });
            }
        }
        out.push_str("]}");
    }

    fn build_parent(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.parent(id)?;
        if parent == self.doc.root_node().id() {
            return None;
        }
        let parent_node = self.doc.get_node(parent)?;
        Some(match &parent_node.data {
            NodeData::ShadowRoot(shadow) => shadow.host,
            _ => parent,
        })
    }

    fn frames_for(&self, external: u32) -> Option<Vec<BuildFrame>> {
        let mut id = self.resolve(external)?;
        let mut path = Vec::new();
        loop {
            let node = self.doc.get_node(id)?;
            if !buildable(node) {
                return None;
            }
            path.push(id);
            if let Some(parent) = self.build_parent(id) {
                id = parent;
            } else {
                break;
            }
        }
        if !self.doc.root_node().children().contains(id) {
            return None;
        }
        let mut frames = Vec::with_capacity(path.len());
        let mut inherited = Inherited::default();
        let mut parent = None;
        let mut blocked = false;
        for id in path.into_iter().rev() {
            if blocked {
                return None;
            }
            let node = self.doc.get_node(id)?;
            frames.push(BuildFrame {
                id,
                parent,
                inherited,
                depth: u32::try_from(frames.len())
                    .unwrap_or(u32::MAX)
                    .saturating_add(1),
            });
            if matches!(node.data, NodeData::Text(_)) {
                blocked = true;
            } else {
                let status = self.element_status(node, inherited);
                blocked = status.no_box;
                inherited = status.next;
            }
            parent = Some(id);
        }
        Some(frames)
    }

    fn child_frames(&self, frame: BuildFrame) -> Vec<BuildFrame> {
        let Some(node) = self.doc.get_node(frame.id) else {
            return Vec::new();
        };
        if matches!(node.data, NodeData::Text(_)) {
            return Vec::new();
        }
        let status = self.element_status(node, frame.inherited);
        if status.no_box {
            return Vec::new();
        }
        self.children(node)
            .into_iter()
            .map(|id| BuildFrame {
                id,
                parent: Some(frame.id),
                inherited: status.next,
                depth: frame.depth.saturating_add(1),
            })
            .collect()
    }

    fn query_matches(&self, frame: BuildFrame) -> bool {
        let Some(node) = self.doc.get_node(frame.id) else {
            return false;
        };
        let (role, name) = if let NodeData::Text(text) = &node.data {
            if frame.inherited.hidden || frame.inherited.text_hidden {
                return false;
            }
            ("StaticText", collapse(&text.content))
        } else {
            let status = self.element_status(node, frame.inherited);
            if status.reason.is_some() {
                return false;
            }
            (status.role, self.name(node, &status.name))
        };
        self.req
            .role
            .as_deref()
            .is_none_or(|wanted| wanted.is_empty() || wanted == role)
            && self
                .req
                .accessible_name
                .as_deref()
                .is_none_or(|wanted| wanted == name)
    }

    fn write_scoped<S: JsonSink>(&self, out: &mut S) {
        out.push_str("{\"nodes\":[");
        let mut first = true;
        let frames = self.req.node_id.and_then(|id| self.frames_for(id));
        match self.req.method {
            Method::Children => {
                let ax_id = self.req.ax_id.as_deref().unwrap_or("");
                if ax_id == format!("root-{}", self.req.frame_id) {
                    if let Some(frame) = self
                        .index
                        .root_ax
                        .and_then(|id| self.frames_for(self.id(id)))
                        .and_then(|path| path.last().copied())
                    {
                        self.emit_frame(out, &mut first, frame);
                    }
                } else {
                    if let Some(frame) = ax_id
                        .parse::<u32>()
                        .ok()
                        .filter(|id| id.to_string() == ax_id)
                        .and_then(|id| self.frames_for(id))
                        .and_then(|path| path.last().copied())
                    {
                        for child in self.child_frames(frame) {
                            self.emit_frame(out, &mut first, child);
                        }
                    }
                }
            }
            Method::Ancestors => {
                if let Some(path) = frames {
                    for frame in path.iter().rev() {
                        self.emit_frame(out, &mut first, *frame);
                    }
                    let reaches_root = path
                        .first()
                        .is_some_and(|frame| self.index.root_ax == Some(frame.id));
                    if reaches_root {
                        self.emit_root(out, &mut first);
                    }
                }
            }
            Method::Partial => self.emit_partial(out, &mut first, frames.as_deref()),
            Method::Query => {
                if self.req.node_id.is_some() {
                    let mut stack = frames
                        .and_then(|path| path.last().copied())
                        .into_iter()
                        .collect::<Vec<_>>();
                    while let Some(frame) = stack.pop() {
                        if self.query_matches(frame) {
                            self.emit_frame(out, &mut first, frame);
                        }
                        stack.extend(self.child_frames(frame));
                    }
                } else {
                    let root_matches = self
                        .req
                        .role
                        .as_deref()
                        .is_none_or(|v| v.is_empty() || v == "RootWebArea")
                        && self
                            .req
                            .accessible_name
                            .as_deref()
                            .is_none_or(|v| v == self.req.title);
                    if root_matches {
                        self.emit_root(out, &mut first);
                    }
                    let mut cursors = vec![ChildCursor {
                        parent: self.doc.root_node().id(),
                        next_child_index: 0,
                        inherited: Inherited::default(),
                    }];
                    while let Some(frame) = self.next_cursor_frame(&mut cursors) {
                        if self.query_matches(frame) {
                            self.emit_frame(out, &mut first, frame);
                        }
                        if let Some(inherited) = self.descendant_inherited(frame) {
                            cursors.push(ChildCursor {
                                parent: frame.id,
                                next_child_index: 0,
                                inherited,
                            });
                        }
                    }
                }
            }
            Method::Full | Method::Root => {}
        }
        out.push_str("]}");
    }

    fn emit_frame<S: JsonSink>(&self, out: &mut S, first: &mut bool, frame: BuildFrame) {
        if let Some(node) = self.doc.get_node(frame.id) {
            if !*first {
                out.push_str(",");
            }
            self.write_node(out, node, frame.parent, frame.inherited);
            *first = false;
        }
    }

    fn emit_partial<S: JsonSink>(
        &self,
        out: &mut S,
        first: &mut bool,
        frames: Option<&[BuildFrame]>,
    ) {
        let Some(path) = frames else {
            return;
        };
        let mut seen = HashSet::new();
        if let Some(frame) = path.last().copied() {
            let mut stack = vec![frame];
            while let Some(frame) = stack.pop() {
                if !seen.insert(frame.id) {
                    continue;
                }
                self.emit_frame(out, first, frame);
                stack.extend(self.child_frames(frame));
            }
        }
        if self.req.fetch_relatives {
            for frame in path.iter().rev().skip(1) {
                if seen.insert(frame.id) {
                    self.emit_frame(out, first, *frame);
                }
            }
            let reaches_root = path
                .first()
                .is_some_and(|frame| self.index.root_ax == Some(frame.id));
            if reaches_root {
                self.emit_root(out, first);
            }
        }
    }

    fn emit_root<S: JsonSink>(&self, out: &mut S, first: &mut bool) {
        if !*first {
            out.push_str(",");
        }
        self.write_root(out);
        *first = false;
    }

    fn next_cursor_frame(&self, stack: &mut Vec<ChildCursor>) -> Option<BuildFrame> {
        loop {
            let depth = u32::try_from(stack.len()).unwrap_or(u32::MAX);
            let cursor = stack.last_mut()?;
            let parent = cursor.parent;
            let inherited = cursor.inherited;
            if let Some(id) = self.next_buildable_child(parent, &mut cursor.next_child_index) {
                return Some(BuildFrame {
                    id,
                    parent: (parent != self.doc.root_node().id()).then_some(parent),
                    inherited,
                    depth,
                });
            }
            stack.pop();
        }
    }

    fn write_node<S: JsonSink>(
        &self,
        out: &mut S,
        node: &Node,
        parent: Option<NodeId>,
        inherited: Inherited,
    ) -> (bool, Inherited) {
        out.node();
        let id = self.id(node.id());
        out.push_str("{\"nodeId\":");
        write_string(out, &id.to_string());
        if let NodeData::Text(text) = &node.data {
            let hidden = inherited.hidden || inherited.text_hidden;
            out.push_str(if hidden {
                ",\"ignored\":true"
            } else {
                ",\"ignored\":false"
            });
            out.push_str(",\"backendDOMNodeId\":");
            out.push_str(&id.to_string());
            out.push_str(",\"frameId\":");
            write_string(out, &self.req.frame_id);
            if hidden {
                self.write_ignored(
                    out,
                    if inherited.aria_hidden {
                        "ariaHiddenSubtree"
                    } else {
                        "notRendered"
                    },
                );
            } else {
                out.push_str(",\"role\":");
                write_value(out, &string_value("internalRole", "StaticText"));
                out.push_str(",\"name\":");
                write_value(
                    out,
                    &string_value("computedString", collapse(&text.content)),
                );
            }
            self.write_parent(out, node.id(), parent);
            out.push_str("}");
            return (false, inherited);
        }
        let status = self.element_status(node, inherited);
        out.push_str(if status.reason.is_some() {
            ",\"ignored\":true"
        } else {
            ",\"ignored\":false"
        });
        out.push_str(",\"backendDOMNodeId\":");
        out.push_str(&id.to_string());
        out.push_str(",\"frameId\":");
        write_string(out, &self.req.frame_id);
        if let Some(reason) = status.reason {
            self.write_ignored(out, reason);
        } else {
            out.push_str(",\"role\":");
            write_value(
                out,
                &string_value(
                    if status.explicit.is_empty() {
                        "internalRole"
                    } else {
                        "role"
                    },
                    status.role,
                ),
            );
            let accessible_name = self.name(node, &status.name);
            if !accessible_name.is_empty() {
                out.push_str(",\"name\":");
                write_value(out, &string_value("computedString", accessible_name));
            }
            let description = self.description(node);
            if !description.is_empty() {
                out.push_str(",\"description\":");
                write_value(out, &string_value("computedString", description));
            }
            if let Some(value) = self.value(node, &status.name) {
                out.push_str(",\"value\":");
                write_value(out, &value);
            }
            let properties = self.properties(node, &status.name, status.role, inherited.list_depth);
            if !properties.is_empty() {
                out.push_str(",\"properties\":[");
                for (index, property) in properties.iter().enumerate() {
                    if index != 0 {
                        out.push_str(",");
                    }
                    write_property(out, property);
                }
                out.push_str("]");
            }
        }
        if self.index.root_ax != Some(node.id()) {
            self.write_parent(out, node.id(), parent);
        }
        let mut child_index = 0;
        let first_child = if status.no_box {
            None
        } else {
            self.next_buildable_child(node.id(), &mut child_index)
        };
        if let Some(first_child) = first_child {
            out.push_str(",\"childIds\":[");
            write_string(out, &self.id(first_child).to_string());
            while let Some(child) = self.next_buildable_child(node.id(), &mut child_index) {
                out.push_str(",");
                write_string(out, &self.id(child).to_string());
            }
            out.push_str("]");
        }
        if self.index.root_ax == Some(node.id()) {
            self.write_parent(out, node.id(), parent);
        }
        out.push_str("}");
        (first_child.is_some(), status.next)
    }

    fn write_parent<S: JsonSink>(&self, out: &mut S, id: NodeId, parent: Option<NodeId>) {
        if let Some(parent) = parent {
            out.push_str(",\"parentId\":");
            write_string(out, &self.id(parent).to_string());
        } else if self.index.root_ax == Some(id) {
            out.push_str(",\"parentId\":");
            write_string(out, &format!("root-{}", self.req.frame_id));
        }
    }

    fn write_ignored<S: JsonSink>(&self, out: &mut S, reason: &str) {
        out.push_str(",\"ignoredReasons\":[{\"name\":");
        write_string(out, reason);
        out.push_str(",\"value\":{\"type\":\"boolean\",\"value\":true}}],\"role\":{\"type\":\"internalRole\",\"value\":\"none\"}");
    }
}
