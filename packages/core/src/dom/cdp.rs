// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! CDP node descriptions and the not-rendered node scan.

use blitz_dom::{ns, BaseDocument, Node, NodeData};
use blitz_dom::node::ShadowRootMode;
use blitz_traits::NodeId;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode, NodeHandleMap};

/// DFS walk collecting descendant ids (excluding `start`). Allocates
/// the output Vec once at the call site.
/// Wire shape for `notRenderedNodeIds`. Two lists, not one: see the
/// method doc for why display:none and visibility must stay apart.
#[derive(Default, serde::Serialize)]
pub(crate) struct NotRenderedIds {
    #[serde(rename = "displayNone")]
    pub(crate) display_none: Vec<u32>,
    pub(crate) invisible: Vec<u32>,
}

struct VisibilityCursor {
    id: NodeId,
    next_child_index: usize,
    shadow_pending: bool,
}

impl VisibilityCursor {
    fn new(node: &Node) -> Self {
        Self {
            id: node.id(),
            next_child_index: node.children().len(),
            shadow_pending: true,
        }
    }
}

fn next_visibility_node(doc: &BaseDocument, stack: &mut Vec<VisibilityCursor>) -> Option<NodeId> {
    loop {
        let cursor = stack.last_mut()?;
        let Some(node) = doc.get_node(cursor.id) else {
            stack.pop();
            continue;
        };
        if let Some(index) = cursor.next_child_index.checked_sub(1) {
            cursor.next_child_index = index;
            return node.children().get(index);
        }
        if cursor.shadow_pending {
            cursor.shadow_pending = false;
            if let Some(shadow) = node.attached_shadow_root_id() {
                return Some(shadow);
            }
        }
        stack.pop();
    }
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
export interface KsNodeIdentity {
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    namespaceURI?: string;
}
export interface KsNodeInfo extends KsNodeIdentity {
    nodeId: number;
    backendNodeId: number;
    childNodeCount: number;
    attributes?: string[];
    attributeNamespaces?: KsAttributeNamespace[];
    documentURL?: string;
    baseURL?: string;
    xmlVersion?: string;
    children?: KsNodeInfo[];
    shadowRoots?: KsNodeInfo[];
    shadowRootType?: "open" | "closed";
}
export interface KsSubtreeBudgetError {
    nodes: number;
    /** Lower bound that already exceeds budget. */
    atLeastBytes: number;
    nodesAtLeast: boolean;
    budget: number;
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeIdentity {
    node_type: u32,
    node_name: String,
    local_name: String,
    node_value: String,
    #[serde(rename = "namespaceURI", skip_serializing_if = "Option::is_none")]
    namespace_uri: Option<String>,
}

pub(crate) fn describe_node_identity(node: &Node) -> NodeIdentity {
    let (node_type, node_name, local_name, node_value) = match &node.data {
        NodeData::Document(_) => (9, "#document".into(), String::new(), String::new()),
        NodeData::ShadowRoot(_) => (
            11,
            "#document-fragment".into(),
            String::new(),
            String::new(),
        ),
        NodeData::Comment { contents } => {
            (8, "#comment".into(), String::new(), String::clone(contents))
        }
        NodeData::Text(data) => (3, "#text".into(), String::new(), data.content.to_string()),
        NodeData::Element(data) | NodeData::AnonymousBlock(data) => {
            let local = data.name.local.to_string();
            let qualified = match data.prefix() {
                Some(prefix) => format!("{prefix}:{local}"),
                None => local.clone(),
            };
            let node_name = if *data.namespace() == ns!(html) {
                qualified.to_ascii_uppercase()
            } else {
                qualified
            };
            (1, node_name, local, String::new())
        }
    };
    let namespace_uri = match &node.data {
        NodeData::Element(data)
            if *data.namespace() != ns!(html) && !data.namespace().is_empty() =>
        {
            Some(data.namespace().to_string())
        }
        _ => None,
    };
    NodeIdentity {
        node_type,
        node_name,
        local_name,
        node_value,
        namespace_uri,
    }
}

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

/// How much of a node's subtree a description includes, as CDP's `depth` and `pierce`.
#[derive(Clone, Copy)]
pub(crate) struct Subtree {
    /// Levels of children to include; negative includes the whole subtree.
    pub(crate) depth: i32,
    /// Whether shadow roots are described to `depth`, rather than without their children.
    pub(crate) pierce: bool,
}

impl Subtree {
    fn below(self) -> Subtree {
        Subtree {
            depth: if self.depth > 0 {
                self.depth - 1
            } else {
                self.depth
            },
            ..self
        }
    }
}

// JSRPC accepts 33,554,432 serialized bytes and rejects 33,554,433. A 360,005-node
// fixture measured 43,544,204 bytes in V8 and 43,544,217 over RPC. Reserve 4 KiB
// for the envelope and differences in serialization.
pub(crate) const SUBTREE_BUDGET_BYTES: usize = 32 * 1024 * 1024 - 4 * 1024;

pub(crate) struct SubtreeSize {
    pub(crate) nodes: usize,
    pub(crate) at_least_bytes: usize,
    pub(crate) nodes_at_least: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtreeBudgetError {
    pub(crate) nodes: usize,
    /// Lower bound that already exceeds budget.
    pub(crate) at_least_bytes: usize,
    pub(crate) nodes_at_least: bool,
    pub(crate) budget: usize,
}

// V8's ValueSerializer writes tags, varint lengths and UTF-16 padding:
// https://github.com/v8/v8/blob/main/src/objects/value-serializer.cc
fn varint_size(mut value: usize) -> usize {
    let mut bytes = 1;
    while value >= 128 {
        value >>= 7;
        bytes += 1;
    }
    bytes
}

fn string_size(parts: &[&str]) -> usize {
    let mut units = 0usize;
    let mut latin1 = true;
    for ch in parts.iter().flat_map(|part| part.chars()) {
        units = units.saturating_add(ch.len_utf16());
        latin1 &= ch <= '\u{ff}';
    }
    let bytes = units.saturating_mul(if latin1 { 1 } else { 2 });
    1usize
        .saturating_add(varint_size(bytes))
        .saturating_add(bytes)
        .saturating_add(usize::from(!latin1))
}

fn integer_size(value: u32) -> usize {
    if value >= (1 << 30) {
        9 // A V8 heap number, on builds with 31-bit Smis.
    } else {
        1 + varint_size((value as usize) * 2)
    }
}

fn array_size(length: usize) -> usize {
    3 + 2 * varint_size(length)
}

fn property_size(name: &str) -> usize {
    2 + name.len()
}

// The stack holds one frame per depth, not per node. Child indices stay valid across
// nested visits, independent of the shared sibling-index hint.
fn walk_subtree(
    doc: &BaseDocument,
    root: NodeId,
    subtree: Subtree,
    mut visit: impl FnMut(&Node, Option<usize>, bool) -> bool,
) {
    struct Frame {
        id: NodeId,
        light_depth: usize,
        opaque_shadows: usize,
        next_child: usize,
        include_children: bool,
        shadow_pending: bool,
    }
    let mut stack: Vec<Frame> = Vec::new();
    let mut next = Some((root, 0usize, 0usize));
    while next.is_some() || !stack.is_empty() {
        if let Some((id, light_depth, opaque_shadows)) = next.take() {
            let Some(node) = doc.get_node(id) else {
                continue;
            };
            let at_limit =
                opaque_shadows > 0 || (subtree.depth >= 0 && light_depth >= subtree.depth as usize);
            let forced = node.attached_shadow_root_id().is_some();
            let include_children = !at_limit
                || forced
                || (node.children().len() == 1
                    && node
                        .children()
                        .first()
                        .and_then(|only| doc.get_node(only))
                        .is_some_and(|c| matches!(c.data, NodeData::Text(_))));
            let child_count = if !at_limit || forced {
                Some(
                    node.children()
                        .iter()
                        .filter(|&id| doc.get_node(id).is_some())
                        .count(),
                )
            } else if include_children {
                Some(1)
            } else {
                None
            };
            let has_shadow = node
                .attached_shadow_root_id()
                .is_some_and(|id| doc.get_node(id).is_some());
            if !visit(node, child_count, has_shadow) {
                return;
            }
            stack.push(Frame {
                id,
                light_depth,
                opaque_shadows,
                next_child: 0,
                include_children,
                shadow_pending: true,
            });
            continue;
        }
        let Some(frame) = stack.last_mut() else { break };
        let Some(node) = doc.get_node(frame.id) else {
            stack.pop();
            continue;
        };
        if frame.include_children {
            while let Some(child) = node.children().get(frame.next_child) {
                frame.next_child += 1;
                if doc.get_node(child).is_some() {
                    next = Some((child, frame.light_depth + 1, frame.opaque_shadows));
                    break;
                }
            }
            if next.is_some() {
                continue;
            }
        }
        if frame.shadow_pending {
            frame.shadow_pending = false;
            if let Some(shadow) = node
                .attached_shadow_root_id()
                .filter(|&id| doc.get_node(id).is_some())
            {
                next = Some((
                    shadow,
                    frame.light_depth,
                    frame.opaque_shadows + usize::from(!subtree.pierce),
                ));
                continue;
            }
        }
        stack.pop();
    }
}

pub(crate) fn subtree_size(
    doc: &BaseDocument,
    root: NodeId,
    base_url: &str,
    subtree: Subtree,
    handles: &NodeHandleMap,
) -> SubtreeSize {
    subtree_size_impl(doc, root, base_url, subtree, handles, false)
}

fn subtree_size_impl(
    doc: &BaseDocument,
    root: NodeId,
    base_url: &str,
    subtree: Subtree,
    handles: &NodeHandleMap,
    single_node: bool,
) -> SubtreeSize {
    let mut size = SubtreeSize {
        nodes: 0,
        at_least_bytes: 2,
        nodes_at_least: false,
    };
    // Every serialized node has seven property names and values, exceeding 70 bytes.
    walk_subtree(doc, root, subtree, |_, _, _| {
        size.nodes = size.nodes.saturating_add(1);
        !single_node && size.nodes.saturating_mul(70) <= SUBTREE_BUDGET_BYTES
    });
    if size.nodes.saturating_mul(70) > SUBTREE_BUDGET_BYTES {
        size.at_least_bytes = size.nodes.saturating_mul(70);
        size.nodes_at_least = true;
        return size;
    }
    // Unassigned handles are issued while describing; bound each by the last possible ID.
    let max_new_id = handles
        .next_external
        .saturating_add(u32::try_from(size.nodes).unwrap_or(u32::MAX));
    walk_subtree(doc, root, subtree, |node, mut children, mut shadow| {
        if single_node {
            children = None;
            shadow = false;
        }
        let id = handles.existing_external(node.id()).unwrap_or(max_new_id);
        let mut bytes = 3
            + property_size("nodeId")
            + integer_size(id)
            + property_size("backendNodeId")
            + integer_size(id)
            + property_size("nodeType")
            + 2
            + property_size("nodeName")
            + property_size("localName")
            + property_size("nodeValue")
            + property_size("childNodeCount")
            + integer_size(node.children().len() as u32);
        match &node.data {
            NodeData::Document(_) => {
                bytes = bytes
                    .saturating_add(string_size(&["#document"]))
                    .saturating_add(string_size(&[""]) * 2)
                    .saturating_add(property_size("documentURL"))
                    .saturating_add(string_size(&[base_url]))
                    .saturating_add(property_size("baseURL"))
                    .saturating_add(string_size(&[base_url]))
                    .saturating_add(property_size("xmlVersion"))
                    .saturating_add(string_size(&[""]));
            }
            NodeData::ShadowRoot(data) => {
                bytes = bytes
                    .saturating_add(string_size(&["#document-fragment"]))
                    .saturating_add(string_size(&[""]) * 2)
                    .saturating_add(property_size("shadowRootType"))
                    .saturating_add(string_size(&[match data.mode {
                        ShadowRootMode::Open => "open",
                        ShadowRootMode::Closed => "closed",
                    }]));
            }
            NodeData::Text(data) => {
                bytes = bytes
                    .saturating_add(string_size(&["#text"]))
                    .saturating_add(string_size(&[""]))
                    .saturating_add(string_size(&[&data.content]));
            }
            NodeData::Comment { contents } => {
                bytes = bytes
                    .saturating_add(string_size(&["#comment"]))
                    .saturating_add(string_size(&[""]))
                    .saturating_add(string_size(&[contents]));
            }
            NodeData::Element(data) | NodeData::AnonymousBlock(data) => {
                let local = data.name.local.as_ref();
                let prefix = data.prefix().map_or("", |p| p.as_ref());
                let separator = if prefix.is_empty() { "" } else { ":" };
                bytes = bytes
                    .saturating_add(string_size(&[prefix, separator, local]))
                    .saturating_add(string_size(&[local]))
                    .saturating_add(string_size(&[""]));
                if matches!(node.data, NodeData::Element(_))
                    && *data.namespace() != ns!(html)
                    && !data.namespace().is_empty()
                {
                    bytes = bytes
                        .saturating_add(property_size("namespaceURI"))
                        .saturating_add(string_size(&[data.namespace().as_ref()]));
                }
                if !data.attrs.is_empty() {
                    bytes = bytes
                        .saturating_add(property_size("attributes"))
                        .saturating_add(array_size(data.attrs.len().saturating_mul(2)));
                    for attr in data.attrs.iter() {
                        let prefix = attr.prefix().map_or("", |p| p.as_ref());
                        let separator = if prefix.is_empty() { "" } else { ":" };
                        bytes = bytes
                            .saturating_add(string_size(&[
                                prefix,
                                separator,
                                attr.name.local.as_ref(),
                            ]))
                            .saturating_add(string_size(&[&attr.value]));
                    }
                }
                let namespaced = data
                    .attrs
                    .iter()
                    .filter(|attr| !attr.namespace().is_empty())
                    .count();
                if namespaced > 0 {
                    bytes = bytes
                        .saturating_add(property_size("attributeNamespaces"))
                        .saturating_add(array_size(namespaced))
                        .saturating_add(
                            (property_size("qualifiedName")
                                + property_size("namespaceURI")
                                + property_size("prefix")
                                + property_size("localName"))
                            .saturating_mul(namespaced),
                        );
                    for attr in data
                        .attrs
                        .iter()
                        .filter(|attr| !attr.namespace().is_empty())
                    {
                        let prefix = attr.prefix().map_or("", |p| p.as_ref());
                        let local = attr.name.local.as_ref();
                        let separator = if prefix.is_empty() { "" } else { ":" };
                        bytes = bytes
                            .saturating_add(string_size(&[prefix, separator, local]))
                            .saturating_add(string_size(&[attr.namespace().as_ref()]))
                            .saturating_add(string_size(&[prefix]))
                            .saturating_add(string_size(&[local]));
                    }
                }
            }
        }
        if let Some(length) = children {
            bytes = bytes.saturating_add(property_size("children") + array_size(length));
        }
        if shadow {
            bytes = bytes.saturating_add(property_size("shadowRoots") + array_size(1));
        }
        size.at_least_bytes = size.at_least_bytes.saturating_add(bytes);
        !single_node && size.at_least_bytes <= SUBTREE_BUDGET_BYTES
    });
    size
}

pub(crate) fn check_subtree_budget(
    doc: &BaseDocument,
    root: NodeId,
    base_url: &str,
    subtree: Subtree,
    handles: &NodeHandleMap,
) -> Option<SubtreeBudgetError> {
    budget_error(subtree_size(doc, root, base_url, subtree, handles))
}

pub(crate) fn check_node_budget(
    doc: &BaseDocument,
    root: NodeId,
    base_url: &str,
    handles: &NodeHandleMap,
) -> Option<SubtreeBudgetError> {
    budget_error(subtree_size_impl(
        doc,
        root,
        base_url,
        Subtree {
            depth: 0,
            pierce: false,
        },
        handles,
        true,
    ))
}

fn budget_error(size: SubtreeSize) -> Option<SubtreeBudgetError> {
    if size.at_least_bytes > SUBTREE_BUDGET_BYTES {
        return Some(SubtreeBudgetError {
            nodes: size.nodes,
            at_least_bytes: size.at_least_bytes,
            nodes_at_least: size.nodes_at_least,
            budget: SUBTREE_BUDGET_BYTES,
        });
    }
    None
}

/// Describes node `id`; `subtree` None leaves out children and shadow roots.
pub(crate) fn describe_node(
    doc: &BaseDocument,
    id: NodeId,
    base_url: &str,
    subtree: Option<Subtree>,
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
    let NodeIdentity {
        node_type,
        node_name,
        local_name,
        node_value,
        namespace_uri,
    } = describe_node_identity(n);
    let is_doc = matches!(n.data, NodeData::Document(_));
    let (attributes, attribute_namespaces) = match &n.data {
        NodeData::Element(data) | NodeData::AnonymousBlock(data) => {
            let mut flat: Vec<String> = Vec::with_capacity(data.attrs.len() * 2);
            let mut attribute_namespaces = Vec::new();
            for attr in data.attrs.iter() {
                let local_name = attr.name.local.to_string();
                let prefix = attr.prefix().map(ToString::to_string);
                let qualified_name = prefix
                    .as_ref()
                    .map(|prefix| format!("{prefix}:{local_name}"))
                    .unwrap_or_else(|| local_name.clone());
                flat.push(qualified_name.clone());
                flat.push(attr.value.to_string());
                if !attr.namespace().is_empty() {
                    attribute_namespaces.push(CdpAttributeNamespace {
                        qualified_name,
                        namespace_uri: attr.namespace().to_string(),
                        prefix,
                        local_name,
                    });
                }
            }
            (
                if flat.is_empty() { None } else { Some(flat) },
                if attribute_namespaces.is_empty() {
                    None
                } else {
                    Some(attribute_namespaces)
                },
            )
        }
        _ => (None, None),
    };

    let child_node_count = n.children().len() as u32;

    // A shadow host's light children are what its shadow root slots in, so a client showing the
    // host needs them with the root even at the depth limit.
    let force_children = n.attached_shadow_root_id().is_some();
    let children = subtree.and_then(|mut subtree| {
        if subtree.depth == 0 && force_children {
            subtree.depth = 1;
        }
        if subtree.depth == 0 {
            // A lone text child is cheap and shows the element's content without a round trip.
            let children = n.children();
            let (1, Some(only)) = (children.len(), children.first()) else {
                return None;
            };
            let text = doc
                .get_node(only)
                .is_some_and(|c| matches!(c.data, NodeData::Text(_)));
            return text
                .then(|| describe_node(doc, only, base_url, Some(subtree), node_handles))
                .flatten()
                .map(|c| vec![c]);
        }
        let mut out = Vec::with_capacity(n.children().len());
        for cid in n.children() {
            if let Some(c) = describe_node(doc, cid, base_url, Some(subtree.below()), node_handles)
            {
                out.push(c);
            }
        }
        Some(out)
    });

    let shadow_roots = subtree.and_then(|subtree| {
        let shadow = Subtree {
            depth: if subtree.pierce { subtree.depth } else { 0 },
            ..subtree
        };
        n.attached_shadow_root_id().and_then(|sid| {
            describe_node(doc, sid, base_url, Some(shadow), node_handles).map(|c| vec![c])
        })
    });

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
        serde_wasm_bindgen::to_value(&self.not_rendered_ids())
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

impl DomHandle {
    pub(crate) fn not_rendered_ids(&self) -> NotRenderedIds {
        if self.layout_mode.get() == LayoutMode::Off {
            return NotRenderedIds::default();
        }
        self.ensure_layout();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return NotRenderedIds::default(),
        };
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            use ::style::properties::generated::longhands::visibility::computed_value::T as StyloVisibility;
            use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
            let mut out = NotRenderedIds::default();
            let mut stack = vec![VisibilityCursor::new(doc.root_node())];
            while let Some(id) = next_visibility_node(doc.as_ref(), &mut stack) {
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
                stack.push(VisibilityCursor::new(node));
            }
            out
        }))
        .unwrap_or_default();
        drop(doc);
        out
    }
}
