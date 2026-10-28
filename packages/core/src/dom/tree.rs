// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! DOM reads: selectors, node info, serialization, and tree walks.

use blitz_dom::{local_name, ns, BaseDocument, LocalName, Namespace, Node, NodeData};
use blitz_traits::NodeId;
use ::style::context::QuirksMode;
use ::style::dom_apis::{
    element_closest, element_matches, query_selector, MayUseInvalidation, QueryAll,
};
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode, NodeHandleMap};
use crate::dom::cdp::{describe_node, describe_node_ext};

fn find_html_title(doc: &BaseDocument) -> Option<&Node> {
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        if let Some(el) = node.element_data() {
            if el.name.local == local_name!("title") && el.name.ns == ns!(html) {
                return Some(node);
            }
        }
        stack.extend(node.children.iter().rev().copied());
    }
    None
}

fn find_title<'a>(doc: &'a BaseDocument) -> Option<&'a Node> {
    let is = |n: &Node, local: LocalName, ns: Namespace| {
        n.element_data()
            .is_some_and(|el| el.name.local == local && el.name.ns == ns)
    };
    let elements = |n: &Node| -> Vec<&'a Node> {
        n.children
            .iter()
            .filter_map(|&id| doc.get_node(id))
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

pub(crate) fn collect_descendants(
    doc: &BaseDocument,
    start: NodeId,
    out: &mut Vec<u32>,
    node_handles: &mut NodeHandleMap,
) {
    let Some(node) = doc.get_node(start) else {
        return;
    };
    for &cid in &node.children {
        out.push(node_handles.external_for(cid));
        collect_descendants(doc, cid, out, node_handles);
    }
}

pub(crate) fn collect_descendants_with_pseudos(
    doc: &BaseDocument,
    start: NodeId,
    out: &mut Vec<u32>,
    node_handles: &mut NodeHandleMap,
) {
    let Some(node) = doc.get_node(start) else {
        return;
    };
    if let Some(before) = node.pe_by_index(1) {
        out.push(node_handles.external_for(before));
        collect_descendants_with_pseudos(doc, before, out, node_handles);
    }
    for &cid in &node.children {
        out.push(node_handles.external_for(cid));
        collect_descendants_with_pseudos(doc, cid, out, node_handles);
    }
    if let Some(after) = node.pe_by_index(0) {
        out.push(node_handles.external_for(after));
        collect_descendants_with_pseudos(doc, after, out, node_handles);
    }
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

enum SerializeStep<'a> {
    Open(&'a Node),
    Close(&'a str),
}

// An explicit stack, not recursion: a deeply nested DOM overflowed the wasm call stack.
fn write_outer_html(doc: &BaseDocument, node: &Node, out: &mut String) {
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

fn push_children<'a>(doc: &'a BaseDocument, node: &'a Node, stack: &mut Vec<SerializeStep<'a>>) {
    for &cid in node.children.iter().rev() {
        if let Some(c) = doc.get_node(cid) {
            stack.push(SerializeStep::Open(c));
        }
    }
}

fn write_node_open<'a>(
    doc: &'a BaseDocument,
    node: &'a Node,
    out: &mut String,
    stack: &mut Vec<SerializeStep<'a>>,
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
            if let SpecialElementData::CheckboxInput(true) = data.special_data {
                emit_synth_checked = true;
                suppress_attr_checked = true;
            } else if let SpecialElementData::CheckboxInput(false) = data.special_data {
                suppress_attr_checked = true;
            }
            if emit_synth_checked {
                out.push_str(" checked=\"\"");
            }
            for Attribute { name, value } in data.attrs.iter() {
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

            stack.push(SerializeStep::Close(local));
            if is_raw_text_element(local) {
                for &cid in &node.children {
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

fn escape_attr_value(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
}

fn escape_text_content(s: &str, out: &mut String) {
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

    #[wasm_bindgen(js_name = "getDocument", unchecked_return_type = "KsNodeInfo | null")]
    pub fn get_document(&self) -> Result<JsValue, JsError> {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let doc_id = doc.root_node().id;
        let mut node_handles = self.node_handles.borrow_mut();
        let cdp = describe_node(&doc, doc_id, &self.base_url, true, &mut node_handles)
            .ok_or_else(|| JsError::new("document node missing"))?;
        serde_wasm_bindgen::to_value(&cdp).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = "nodeSubtree", unchecked_return_type = "KsNodeInfo | null")]
    pub fn node_subtree(&self, node_id: u32) -> Result<JsValue, JsError> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Ok(JsValue::NULL);
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        if doc.get_node(internal_id).is_none() {
            return Ok(JsValue::NULL);
        }
        let cdp = describe_node_ext(
            &doc,
            internal_id,
            &self.base_url,
            true,
            false,
            &mut self.node_handles.borrow_mut(),
        );
        match cdp {
            Some(node) => {
                serde_wasm_bindgen::to_value(&node).map_err(|e| JsError::new(&e.to_string()))
            }
            None => Ok(JsValue::NULL),
        }
    }

    #[wasm_bindgen(js_name = "querySelector")]
    pub fn query_selector(&self, selector: &str) -> Result<i32, JsError> {
        self.flush_slot_assignments();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(-1),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.query_selector(selector)
        }));
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
                self.external_node_id_i32(node.id)
            }
            _ => -1,
        }
    }

    #[wasm_bindgen(js_name = "canonicalizeSelector")]
    pub fn canonicalize_selector(&self, selector: &str) -> Option<String> {
        let doc = self.doc.try_borrow().ok()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.query_selector_all(selector)
        }));
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
        let matched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
            .map(|n| self.external_node_id_i32(n.id))
            .collect())
    }

    #[wasm_bindgen(js_name = "matchesInSubtree")]
    pub fn matches_in_subtree(&self, node_id: u32, selector: &str) -> Result<bool, JsError> {
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
        let m = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            element_closest::<&Node>(node, &selector_list, quirks)
        }));
        match r {
            Ok(Some(matched)) => Ok(self.external_node_id_i32(matched.id)),
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
        let mut out = String::new();
        if matches!(n.data, NodeData::Document(_)) {
            for &cid in &n.children {
                if let Some(c) = doc.get_node(cid) {
                    write_outer_html(&doc, c, &mut out);
                }
            }
        } else {
            write_outer_html(&doc, n, &mut out);
        }
        out
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
        let mut out = String::new();
        let raw_text = match &node.data {
            NodeData::Element(data) => is_raw_text_element(&data.name.local),
            _ => false,
        };
        for &cid in &node.children {
            if let Some(c) = doc.get_node(cid) {
                if raw_text {
                    if let NodeData::Text(t) = &c.data {
                        out.push_str(&t.content);
                    }
                } else {
                    write_outer_html(&doc, c, &mut out);
                }
            }
        }
        out
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
            false,
            &mut self.node_handles.borrow_mut(),
        )
        .ok_or_else(|| JsError::new("node not found"))?;
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
                .children
                .iter()
                .copied()
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
        match doc.get_node(internal_id).and_then(|n| n.parent) {
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
            match doc.get_node(cur).and_then(|n| n.parent) {
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
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
