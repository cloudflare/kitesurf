// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! DOM writes: batched ops, node creation, and attribute and text edits.

use blitz_dom::{local_name, ns, BaseDocument, LocalName, Namespace, NodeData, QualName};
use blitz_traits::NodeId;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, NodeHandleMap};

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum Op {
    #[serde(rename = "setAttribute")]
    SetAttribute {
        node: u32,
        name: String,
        value: String,
    },

    #[serde(rename = "removeAttribute")]
    RemoveAttribute { node: u32, name: String },

    #[serde(rename = "setTextContent")]
    SetTextContent { node: u32, text: String },

    #[serde(rename = "setNodeText")]
    SetNodeText { node: u32, text: String },

    #[serde(rename = "setInnerHtml")]
    SetInnerHtml { node: u32, html: String },

    #[serde(rename = "appendChildHtml")]
    AppendChildHtml { parent: u32, html: String },
}

fn apply_one(
    mutr: &mut blitz_dom::DocumentMutator<'_>,
    node_handles: &NodeHandleMap,
    op: Op,
) -> Result<(), String> {
    match op {
        Op::SetAttribute { node, name, value } => {
            let node_id = resolve_op_target(node_handles, node, "setAttribute")?;
            let qname = attr_name_for_key(&*mutr.doc, node_id, &name);
            mutr.set_attribute(node_id, qname, &value);
            Ok(())
        }
        Op::RemoveAttribute { node, name } => {
            let node_id = resolve_op_target(node_handles, node, "removeAttribute")?;
            let qname = attr_name_for_key(&*mutr.doc, node_id, &name);
            mutr.clear_attribute(node_id, qname);
            Ok(())
        }
        Op::SetTextContent { node, text } => {
            let nid = node_handles.resolve(node).unwrap();
            let child_ids = mutr.child_ids(nid);
            for cid in child_ids {
                mutr.remove_node(cid);
            }
            if !text.is_empty() {
                let tid = mutr.create_text_node(&text);
                mutr.append_children(nid, &[tid]);
            }
            Ok(())
        }
        Op::SetNodeText { node, text } => {
            mutr.set_node_text(node_handles.resolve(node).unwrap(), &text);
            Ok(())
        }
        Op::SetInnerHtml { node, html } => {
            mutr.set_inner_html(node_handles.resolve(node).unwrap(), &html);
            Ok(())
        }
        Op::AppendChildHtml { parent, html } => {
            let tmp_qname = QualName::new(None, ns!(html), local_name!("div"));
            let tmp = mutr.create_element(tmp_qname, Vec::new());
            mutr.set_inner_html(tmp, &html);
            let child_ids = mutr.child_ids(tmp);
            mutr.append_children(node_handles.resolve(parent).unwrap(), &child_ids);
            mutr.remove_and_drop_node(tmp);
            Ok(())
        }
    }
}

fn resolve_op_target(
    node_handles: &NodeHandleMap,
    node: u32,
    op_name: &str,
) -> Result<NodeId, String> {
    node_handles
        .resolve(node)
        .ok_or_else(|| format!("{op_name}: node id {node} does not exist (stale or never created)"))
}

fn check_op_targets(
    doc: &BaseDocument,
    node_handles: &NodeHandleMap,
    op: &Op,
) -> Result<(), String> {
    let (target, op_name): (u32, &'static str) = match op {
        Op::SetAttribute { node, .. } => (*node, "setAttribute"),
        Op::RemoveAttribute { node, .. } => (*node, "removeAttribute"),
        Op::SetTextContent { node, .. } => (*node, "setTextContent"),
        Op::SetNodeText { node, .. } => (*node, "setNodeText"),
        Op::SetInnerHtml { node, .. } => (*node, "setInnerHtml"),
        Op::AppendChildHtml { parent, .. } => (*parent, "appendChildHtml"),
    };
    if node_handles
        .resolve(target)
        .and_then(|id| doc.get_node(id))
        .is_some()
    {
        Ok(())
    } else {
        Err(format!(
            "{op_name}: node id {target} does not exist (stale or never created)"
        ))
    }
}

fn attr_qname(name: &str) -> QualName {
    QualName::new(None, Namespace::from(""), LocalName::from(name))
}

/// Match shim keys against stored qualified names (`prefix:local` or `local`).
/// `crate::js::dom_fastpath::attr_lookup` uses the same prefix rule after HTML lowercasing.
fn attr_matches_key(name: &QualName, key: &str) -> bool {
    match &name.prefix {
        None => &*name.local == key,
        Some(prefix) => key
            .strip_prefix(&**prefix)
            .and_then(|rest| rest.strip_prefix(':'))
            .is_some_and(|local| local == &*name.local),
    }
}

fn attr_name_for_key(doc: &BaseDocument, node_id: NodeId, key: &str) -> QualName {
    doc.get_node(node_id)
        .and_then(|node| node.element_data())
        .and_then(|data| {
            data.attrs
                .iter()
                .find(|attr| attr_matches_key(&attr.name, key))
        })
        .map(|attr| attr.name.clone())
        .unwrap_or_else(|| attr_qname(key))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "applyOps")]
    pub fn apply_ops(&self, json: &str) -> Result<u32, JsError> {
        let _ks_span = tracing::info_span!("wasm.apply_ops", json_bytes = json.len()).entered();
        let ops: Vec<Op> = serde_json::from_str(json)
            .map_err(|e| JsError::new(&format!("apply_ops: bad JSON: {e}")))?;
        let mut applied: u32 = 0;
        let mut errors: Vec<String> = Vec::new();

        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return Ok(0),
        };

        for op in ops {
            if let Err(e) = check_op_targets(&doc, &self.node_handles.borrow(), &op) {
                errors.push(e);
                continue;
            }
            let mut mutr = doc.mutate();
            match apply_one(&mut mutr, &self.node_handles.borrow(), op) {
                Ok(()) => {
                    applied += 1;
                    drop(mutr);
                }
                Err(e) => {
                    errors.push(e);
                    drop(mutr);
                }
            }
        }

        if applied > 0 {
            self.layout_dirty.set(true);
        }
        if applied == 0 && !errors.is_empty() {
            return Err(JsError::new(&format!(
                "all ops failed: {}",
                errors.join("; ")
            )));
        }
        Ok(applied)
    }

    #[wasm_bindgen(js_name = "setAttribute")]
    pub fn set_attribute(&self, node_id: u32, name: &str, value: &str) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(node_id).is_none() {
            return false;
        }
        let qname = attr_name_for_key(&doc, node_id, name);
        let mut mutr = doc.mutate();
        mutr.set_attribute(node_id, qname, value);
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "removeAttribute")]
    pub fn remove_attribute(&self, node_id: u32, name: &str) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(node_id).is_none() {
            return false;
        }
        let qname = attr_name_for_key(&doc, node_id, name);
        let mut mutr = doc.mutate();
        mutr.clear_attribute(node_id, qname);
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "setSelectLabel")]
    pub fn set_select_label(&self, node_id: u32, text: Option<String>) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(node_id).is_none() {
            return false;
        }
        let mut mutr = doc.mutate();
        mutr.set_select_label(node_id, text.as_deref());
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "createElementVerbatim")]
    pub fn create_element_verbatim(&self, local_name: &str, namespace_uri: &str) -> u32 {
        let ns_atom: Namespace = if namespace_uri.is_empty() {
            ns!()
        } else if namespace_uri == "http://www.w3.org/1999/xhtml" {
            ns!(html)
        } else if namespace_uri == "http://www.w3.org/2000/svg" {
            ns!(svg)
        } else if namespace_uri == "http://www.w3.org/1998/Math/MathML" {
            ns!(mathml)
        } else if namespace_uri == "http://www.w3.org/XML/1998/namespace" {
            ns!(xml)
        } else if namespace_uri == "http://www.w3.org/2000/xmlns/" {
            ns!(xmlns)
        } else {
            Namespace::from(namespace_uri)
        };
        let qname = QualName::new(None, ns_atom, LocalName::from(local_name));
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let mut mutr = doc.mutate();
        let id = mutr.create_element(qname, Vec::new());
        drop(mutr);
        self.external_node_id(id)
    }
    #[wasm_bindgen(js_name = "createElement")]
    pub fn create_element(&self, tag_name: &str) -> u32 {
        let qname = QualName::new(
            None,
            ns!(html),
            LocalName::from(tag_name.to_lowercase().as_str()),
        );
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let mut mutr = doc.mutate();
        let id = mutr.create_element(qname, Vec::new());
        drop(mutr);
        self.external_node_id(id)
    }

    #[wasm_bindgen(js_name = "createElementNS")]
    pub fn create_element_ns(&self, namespace_uri: &str, qualified_name: &str) -> u32 {
        let ns_atom: Namespace = if namespace_uri.is_empty() {
            ns!()
        } else if namespace_uri == "http://www.w3.org/1999/xhtml" {
            ns!(html)
        } else if namespace_uri == "http://www.w3.org/2000/svg" {
            ns!(svg)
        } else if namespace_uri == "http://www.w3.org/1998/Math/MathML" {
            ns!(mathml)
        } else if namespace_uri == "http://www.w3.org/XML/1998/namespace" {
            ns!(xml)
        } else if namespace_uri == "http://www.w3.org/2000/xmlns/" {
            ns!(xmlns)
        } else {
            Namespace::from(namespace_uri)
        };

        let (prefix, local) = match qualified_name.split_once(':') {
            Some((p, l)) if !p.is_empty() && !l.is_empty() => (Some(blitz_dom::Prefix::from(p)), l),
            _ => (None, qualified_name),
        };
        let qname = QualName::new(prefix, ns_atom, LocalName::from(local));
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let mut mutr = doc.mutate();
        let id = mutr.create_element(qname, Vec::new());
        drop(mutr);
        self.external_node_id(id)
    }

    #[wasm_bindgen(js_name = "createTextNode")]
    pub fn create_text_node(&self, text: &str) -> u32 {
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let mut mutr = doc.mutate();
        let id = mutr.create_text_node(text);
        drop(mutr);
        self.external_node_id(id)
    }

    #[wasm_bindgen(js_name = "createComment")]
    pub fn create_comment(&self, text: &str) -> u32 {
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let mut mutr = doc.mutate();
        let id = mutr.create_comment_node(text);
        drop(mutr);
        self.external_node_id(id)
    }

    #[wasm_bindgen(js_name = "setCommentData")]
    pub fn set_comment_data(&self, node_id: u32, text: &str) -> bool {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let Ok(mut doc) = self.doc.try_borrow_mut() else {
            return false;
        };
        let Some(node) = doc.get_node_mut(internal_id) else {
            return false;
        };
        let NodeData::Comment { contents } = &mut node.data else {
            return false;
        };
        contents.clear();
        contents.push_str(text);
        true
    }

    #[wasm_bindgen(js_name = "getCommentData")]
    pub fn get_comment_data(&self, node_id: u32) -> String {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return String::new();
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return String::new();
        };
        match doc.get_node(internal_id).map(|node| &node.data) {
            Some(NodeData::Comment { contents }) => contents.clone(),
            _ => String::new(),
        }
    }

    #[wasm_bindgen(js_name = "deepCloneNode")]
    pub fn deep_clone_node(&self, node_id: u32) -> u32 {
        let Some(source_id) = self.resolve_node_id(node_id) else {
            return 0;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        if doc.get_node(source_id).is_none() {
            return 0;
        }
        let mut mutr = doc.mutate();
        let id = mutr.deep_clone_node(source_id);
        drop(mutr);
        self.external_node_id(id)
    }

    #[wasm_bindgen(js_name = "appendChildNode")]
    pub fn append_child_node(&self, parent_id: u32, child_id: u32) -> bool {
        let (Some(parent_id), Some(child_id)) = (
            self.resolve_node_id(parent_id),
            self.resolve_node_id(child_id),
        ) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(parent_id).is_none() || doc.get_node(child_id).is_none() {
            return false;
        }
        let mut mutr = doc.mutate();
        mutr.append_children(parent_id, &[child_id]);
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "insertBeforeNode")]
    pub fn insert_before_node(&self, parent_id: u32, new_child_id: u32, ref_child_id: u32) -> bool {
        let (Some(parent_id), Some(new_child_id)) = (
            self.resolve_node_id(parent_id),
            self.resolve_node_id(new_child_id),
        ) else {
            return false;
        };
        let ref_node_id = (ref_child_id != 0)
            .then(|| self.resolve_node_id(ref_child_id))
            .flatten();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(parent_id).is_none()
            || doc.get_node(new_child_id).is_none()
            || (ref_child_id != 0 && ref_node_id.is_none_or(|id| doc.get_node(id).is_none()))
        {
            return false;
        }
        let mut mutr = doc.mutate();
        if ref_child_id == 0 {
            mutr.append_children(parent_id, &[new_child_id]);
        } else {
            mutr.insert_nodes_before(ref_node_id.unwrap(), &[new_child_id]);
        }
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    /// Records that `contents_id` holds the content of the template `template_id`, which the
    /// caller moved there. Serialization then writes that content inside the template.
    #[wasm_bindgen(js_name = "setTemplateContents")]
    pub fn set_template_contents(&self, template_id: u32, contents_id: u32) -> bool {
        let (Some(template), Some(contents)) = (
            self.resolve_node_id(template_id),
            self.resolve_node_id(contents_id),
        ) else {
            return false;
        };
        self.template_contents
            .borrow_mut()
            .insert(template, contents);
        true
    }

    #[wasm_bindgen(js_name = "removeNode")]
    pub fn remove_node(&self, node_id: u32) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(node_id).is_none() {
            return false;
        }
        let mut mutr = doc.mutate();
        mutr.remove_node(node_id);
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "dropNode")]
    pub fn drop_node(&self, node_id: u32) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let Some(root_id) = self.resolve_node_id(0) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if node_id == root_id || doc.get_node(node_id).is_none() {
            return false;
        }
        let mut node_handles = self.node_handles.borrow_mut();
        let mut template_contents = self.template_contents.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.remove_and_drop_node_with(node_id, &mut |dropped| {
            node_handles.retire(dropped);
            template_contents.remove(&dropped);
        });
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "replaceChildNode")]
    pub fn replace_child_node(&self, new_child_id: u32, old_child_id: u32) -> bool {
        let (Some(new_child_id), Some(old_child_id)) = (
            self.resolve_node_id(new_child_id),
            self.resolve_node_id(old_child_id),
        ) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(new_child_id).is_none() || doc.get_node(old_child_id).is_none() {
            return false;
        }
        let mut mutr = doc.mutate();
        mutr.replace_node_with(old_child_id, &[new_child_id]);
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "setNodeText")]
    pub fn set_node_text(&self, node_id: u32, text: &str) -> bool {
        let Some(nid) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };

        let node = match doc.get_node(nid) {
            Some(n) => n,
            None => return false,
        };
        let is_text = matches!(node.data, NodeData::Text(_));

        let mut mutr = doc.mutate();
        if is_text {
            mutr.set_node_text(nid, text);
            drop(mutr);
            self.layout_dirty.set(true);
            return true;
        }

        mutr.remove_and_drop_all_children(nid);
        if !text.is_empty() {
            let tid = mutr.create_text_node(text);
            mutr.append_children(nid, &[tid]);
        }
        drop(mutr);
        self.layout_dirty.set(true);
        true
    }
}
