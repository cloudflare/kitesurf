// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! CDP node descriptions and the not-rendered node scan.

use blitz_dom::{ns, BaseDocument, Node, NodeData};
use blitz_dom::node::{Attribute, ShadowRootMode};
use blitz_traits::NodeId;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode, NodeHandleMap};

/// DFS walk collecting descendant ids (excluding `start`). Allocates
/// the output Vec once at the call site.
/// Wire shape for `notRenderedNodeIds`. Two lists, not one: see the
/// method doc for why display:none and visibility must stay apart.
#[derive(Default, serde::Serialize)]
struct NotRenderedIds {
    #[serde(rename = "displayNone")]
    display_none: Vec<u32>,
    invisible: Vec<u32>,
}

// The TypeScript shape of a serialized CdpNode, for the methods that return
// one (nodeInfo, getDocument, nodeSubtree). serde_wasm_bindgen writes a
// skipped or None field as absent or undefined, hence the optional members.
// Keep it in step with CdpNode and CdpAttributeNamespace.
#[wasm_bindgen(typescript_custom_section)]
const TS_CDP_NODE: &str = r#"
export interface KsAttributeNamespace {
    qualifiedName: string;
    namespaceURI: string;
    prefix?: string;
    localName: string;
}
export interface KsNodeInfo {
    nodeId: number;
    backendNodeId: number;
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    childNodeCount: number;
    attributes?: string[];
    attributeNamespaces?: KsAttributeNamespace[];
    documentURL?: string;
    baseURL?: string;
    xmlVersion?: string;
    children?: KsNodeInfo[];
    shadowRoots?: KsNodeInfo[];
    shadowRootType?: "open" | "closed";
    namespaceURI?: string;
}
"#;

#[derive(Serialize)]
pub(crate) struct CdpNode {
    #[serde(rename = "nodeId")]
    node_id: u32,
    #[serde(rename = "backendNodeId")]
    backend_node_id: u32,
    #[serde(rename = "nodeType")]
    node_type: u32,
    #[serde(rename = "nodeName")]
    node_name: String,
    #[serde(rename = "localName")]
    local_name: String,
    #[serde(rename = "nodeValue")]
    node_value: String,
    #[serde(rename = "childNodeCount")]
    child_node_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    attributes: Option<Vec<String>>,
    #[serde(
        rename = "attributeNamespaces",
        skip_serializing_if = "Option::is_none"
    )]
    attribute_namespaces: Option<Vec<CdpAttributeNamespace>>,
    #[serde(rename = "documentURL", skip_serializing_if = "Option::is_none")]
    document_url: Option<String>,
    #[serde(rename = "baseURL", skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(rename = "xmlVersion", skip_serializing_if = "Option::is_none")]
    xml_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<CdpNode>>,
    #[serde(rename = "shadowRoots", skip_serializing_if = "Option::is_none")]
    shadow_roots: Option<Vec<CdpNode>>,
    #[serde(rename = "shadowRootType", skip_serializing_if = "Option::is_none")]
    shadow_root_type: Option<String>,
    #[serde(rename = "namespaceURI", skip_serializing_if = "Option::is_none")]
    namespace_uri: Option<String>,
}

#[derive(Serialize)]
struct CdpAttributeNamespace {
    #[serde(rename = "qualifiedName")]
    qualified_name: String,
    #[serde(rename = "namespaceURI")]
    namespace_uri: String,
    prefix: Option<String>,
    #[serde(rename = "localName")]
    local_name: String,
}

pub(crate) fn describe_node(
    doc: &BaseDocument,
    id: NodeId,
    base_url: &str,
    include_children: bool,
    node_handles: &mut NodeHandleMap,
) -> Option<CdpNode> {
    describe_node_ext(doc, id, base_url, include_children, true, node_handles)
}

pub(crate) fn describe_node_ext(
    doc: &BaseDocument,
    id: NodeId,
    base_url: &str,
    include_children: bool,
    include_shadow_roots: bool,
    node_handles: &mut NodeHandleMap,
) -> Option<CdpNode> {
    let n: &Node = doc.get_node(id)?;

    let shadow_root_type: Option<String> = match &n.data {
        NodeData::ShadowRoot(data) => Some(match data.mode {
            ShadowRootMode::Open => "open".to_string(),
            ShadowRootMode::Closed => "closed".to_string(),
        }),
        _ => None,
    };
    let namespace_uri = match &n.data {
        NodeData::Element(data) if data.name.ns != ns!(html) && !data.name.ns.is_empty() => {
            Some(data.name.ns.to_string())
        }
        _ => None,
    };
    let (node_type, node_name, local_name, node_value, attributes, attribute_namespaces, is_doc) =
        match &n.data {
            NodeData::Document(_) => (
                9u32,
                "#document".to_string(),
                String::new(),
                String::new(),
                None,
                None,
                true,
            ),
            NodeData::ShadowRoot(_) => (
                11,
                "#document-fragment".to_string(),
                String::new(),
                String::new(),
                None,
                None,
                false,
            ),
            NodeData::Comment { contents } => (
                8,
                "#comment".to_string(),
                String::new(),
                contents.clone(),
                None,
                None,
                false,
            ),
            NodeData::Text(data) => (
                3,
                "#text".to_string(),
                String::new(),
                data.content.clone(),
                None,
                None,
                false,
            ),
            NodeData::Element(data) | NodeData::AnonymousBlock(data) => {
                let mut flat: Vec<String> = Vec::with_capacity(data.attrs.len() * 2);
                let mut attribute_namespaces = Vec::new();
                for a in data.attrs.iter() {
                    let Attribute { name, value } = a;
                    let local_name = name.local.to_string();
                    let prefix = name.prefix.as_ref().map(ToString::to_string);
                    let qualified_name = prefix
                        .as_ref()
                        .map(|prefix| format!("{prefix}:{local_name}"))
                        .unwrap_or_else(|| local_name.clone());
                    flat.push(qualified_name.clone());
                    flat.push(value.clone());
                    if !name.ns.is_empty() {
                        attribute_namespaces.push(CdpAttributeNamespace {
                            qualified_name,
                            namespace_uri: name.ns.to_string(),
                            prefix,
                            local_name,
                        });
                    }
                }
                let local = data.name.local.to_string();
                let is_html_ns = data.name.ns == ns!(html);
                let qname = match &data.name.prefix {
                    Some(p) => format!("{}:{}", p, local),
                    None => local.clone(),
                };
                let node_name = if is_html_ns {
                    qname.to_ascii_uppercase()
                } else {
                    qname
                };
                (
                    1,
                    node_name,
                    local,
                    String::new(),
                    if flat.is_empty() { None } else { Some(flat) },
                    if attribute_namespaces.is_empty() {
                        None
                    } else {
                        Some(attribute_namespaces)
                    },
                    false,
                )
            }
        };

    let child_node_count = n.children.len() as u32;

    let children = if include_children {
        let mut out = Vec::with_capacity(n.children.len());
        for &cid in &n.children {
            if let Some(c) =
                describe_node_ext(doc, cid, base_url, true, include_shadow_roots, node_handles)
            {
                out.push(c);
            }
        }
        Some(out)
    } else {
        None
    };

    let shadow_roots = if include_children && include_shadow_roots {
        n.attached_shadow_root_id().and_then(|sid| {
            describe_node_ext(doc, sid, base_url, true, include_shadow_roots, node_handles)
                .map(|c| vec![c])
        })
    } else {
        None
    };

    Some(CdpNode {
        node_id: node_handles.external_for(id),
        backend_node_id: node_handles.external_for(id),
        node_type,
        node_name,
        local_name,
        node_value,
        child_node_count,
        attributes,
        attribute_namespaces,
        document_url: if is_doc {
            Some(base_url.to_string())
        } else {
            None
        },
        base_url: if is_doc {
            Some(base_url.to_string())
        } else {
            None
        },
        xml_version: if is_doc { Some(String::new()) } else { None },
        children,
        shadow_roots,
        shadow_root_type,
        namespace_uri,
    })
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "notRenderedNodeIds")]
    pub fn not_rendered_node_ids(&self) -> Result<JsValue, JsError> {
        if self.layout_mode.get() == LayoutMode::Off {
            return serde_wasm_bindgen::to_value(&NotRenderedIds::default())
                .map_err(|e| JsError::new(&e.to_string()));
        }
        self.ensure_layout();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => {
                return serde_wasm_bindgen::to_value(&NotRenderedIds::default())
                    .map_err(|e| JsError::new(&e.to_string()))
            }
        };
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            use ::style::properties::generated::longhands::visibility::computed_value::T as StyloVisibility;
            use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
            let mut out = NotRenderedIds::default();
            let mut stack: Vec<NodeId> = vec![doc.root_node().id];
            while let Some(id) = stack.pop() {
                let Some(node) = doc.get_node(id) else { continue };
                let mut descend = true;
                if node.is_element() {
                    if let Some(styles) = node.primary_styles() {
                        let display = styles.clone_display();
                        if display.outside() == DisplayOutside::None
                            && display.inside() == DisplayInside::None
                        {
                            out.display_none.push(self.external_node_id(id));
                            descend = false;
                        } else if styles.get_inherited_box().visibility
                            != StyloVisibility::Visible
                        {
                            out.invisible.push(self.external_node_id(id));
                        }
                    }
                }
                if !descend {
                    continue;
                }
                if let Some(sid) = node.attached_shadow_root_id() {
                    stack.push(sid);
                }
                for &cid in node.children.iter() {
                    stack.push(cid);
                }
            }
            out
        }))
        .unwrap_or_default();
        drop(doc);
        serde_wasm_bindgen::to_value(&out).map_err(|e| JsError::new(&e.to_string()))
    }
}
