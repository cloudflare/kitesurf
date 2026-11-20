// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! CDP node descriptions and the not-rendered node scan.

use blitz_dom::{ns, BaseDocument, Node, NodeData};
use blitz_dom::node::{Attribute, ElementData, ShadowRootMode};
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

// The TypeScript shape of a serialized CdpNode (nodeInfo, getDocument, nodeSubtree) and
// AttributeList (attributeList). serde_wasm_bindgen writes a skipped or None field as absent
// or undefined, hence the optional members. Keep it in step with CdpNode, AttributeList and
// CdpAttributeNamespace.
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
export interface KsAttributeList {
    attributes?: string[];
    attributeNamespaces?: KsAttributeNamespace[];
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

// DOM `Node.nodeType` values, which CDP reports verbatim.
const ELEMENT_NODE: u32 = 1;
const TEXT_NODE: u32 = 3;
const COMMENT_NODE: u32 = 8;
const DOCUMENT_NODE: u32 = 9;
const DOCUMENT_FRAGMENT_NODE: u32 = 11;

impl NodeIdentity {
    fn new(node_type: u32, node_name: &str, node_value: impl Into<String>) -> Self {
        Self {
            node_type,
            node_name: node_name.to_string(),
            local_name: String::new(),
            node_value: node_value.into(),
            namespace_uri: None,
        }
    }

    /// An element's identity. CDP uppercases the name in the HTML namespace.
    fn element(data: &ElementData, namespace_uri: Option<String>) -> Self {
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
        Self {
            node_type: ELEMENT_NODE,
            node_name,
            local_name: local,
            node_value: String::new(),
            namespace_uri,
        }
    }
}

/// The namespace URI CDP reports for an element, and only for one outside the HTML namespace.
fn element_namespace_uri(data: &ElementData) -> Option<String> {
    (*data.namespace() != ns!(html) && !data.namespace().is_empty())
        .then(|| data.namespace().to_string())
}

pub(crate) fn describe_node_identity(node: &Node) -> NodeIdentity {
    match &node.data {
        NodeData::Document(_) => NodeIdentity::new(DOCUMENT_NODE, "#document", ""),
        NodeData::ShadowRoot(_) => {
            NodeIdentity::new(DOCUMENT_FRAGMENT_NODE, "#document-fragment", "")
        }
        NodeData::Comment { contents } => {
            NodeIdentity::new(COMMENT_NODE, "#comment", contents.to_string())
        }
        NodeData::Text(data) => NodeIdentity::new(TEXT_NODE, "#text", data.content.to_string()),
        NodeData::Element(data) => NodeIdentity::element(data, element_namespace_uri(data)),
        NodeData::AnonymousBlock(data) => NodeIdentity::element(data, None),
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
pub(crate) struct CdpAttributeNamespace {
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

// JSRPC accepts 33,554,432 serialized bytes and rejects 33,554,433. Reserve 4 KiB for the
// envelope and differences in serialization.
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

/// One node the walk visits, with its depth in light children and the number of shadow roots
/// above it that hide their children from the walk.
#[derive(Clone, Copy)]
struct WalkStep {
    id: NodeId,
    light_depth: usize,
    opaque_shadows: usize,
}

/// One open node in the walk, with the children it has not visited yet.
struct WalkFrame {
    step: WalkStep,
    next_child: usize,
    include_children: bool,
    shadow_pending: bool,
}

/// What one node's description includes, as `describe_node` decides it.
#[derive(Clone, Copy)]
struct NodeScope {
    include_children: bool,
    child_count: Option<usize>,
    has_shadow: bool,
}

impl NodeScope {
    fn of(doc: &BaseDocument, node: &Node, subtree: Subtree, step: WalkStep) -> Self {
        let at_limit = step.opaque_shadows > 0
            || (subtree.depth >= 0 && step.light_depth >= subtree.depth as usize);
        let has_shadow_root = node.attached_shadow_root_id().is_some();
        let include_children = !at_limit || has_shadow_root || lone_text_child(doc, node).is_some();
        let child_count = if !at_limit || has_shadow_root {
            Some(live_child_count(doc, node))
        } else if include_children {
            Some(1)
        } else {
            None
        };
        Self {
            include_children,
            child_count,
            has_shadow: live_shadow_root(doc, node).is_some(),
        }
    }

    /// Only the node's own record, without the children or shadow root it describes.
    fn without_children(self) -> Self {
        Self {
            include_children: false,
            child_count: None,
            has_shadow: false,
        }
    }
}

// The stack holds one frame per depth, not per node. Child indices stay valid across
// nested visits, independent of the shared sibling-index hint.
fn walk_subtree(
    doc: &BaseDocument,
    root: NodeId,
    subtree: Subtree,
    mut visit: impl FnMut(&Node, NodeScope) -> bool,
) {
    let mut stack: Vec<WalkFrame> = Vec::new();
    let mut pending = Some(WalkStep {
        id: root,
        light_depth: 0,
        opaque_shadows: 0,
    });
    while let Some(step) = pending.take().or_else(|| descend(doc, &mut stack, subtree)) {
        let Some(node) = doc.get_node(step.id) else {
            continue;
        };
        let scope = NodeScope::of(doc, node, subtree, step);
        if !visit(node, scope) {
            return;
        }
        stack.push(WalkFrame {
            step,
            next_child: 0,
            include_children: scope.include_children,
            shadow_pending: true,
        });
    }
}

/// The next node to visit once the stack's open nodes are exhausted, or None at the end.
fn descend(doc: &BaseDocument, stack: &mut Vec<WalkFrame>, subtree: Subtree) -> Option<WalkStep> {
    loop {
        let frame = stack.last_mut()?;
        let Some(node) = doc.get_node(frame.step.id) else {
            stack.pop();
            continue;
        };
        if frame.include_children {
            if let Some(child) = take_next_live_child(doc, node, frame) {
                return Some(WalkStep {
                    id: child,
                    light_depth: frame.step.light_depth + 1,
                    ..frame.step
                });
            }
        }
        if frame.shadow_pending {
            frame.shadow_pending = false;
            if let Some(shadow) = live_shadow_root(doc, node) {
                return Some(WalkStep {
                    id: shadow,
                    light_depth: frame.step.light_depth,
                    opaque_shadows: frame.step.opaque_shadows + usize::from(!subtree.pierce),
                });
            }
        }
        stack.pop();
    }
}

/// Advances `frame` past missing children and returns the next live one.
fn take_next_live_child(doc: &BaseDocument, node: &Node, frame: &mut WalkFrame) -> Option<NodeId> {
    let children = node.children();
    while let Some(child) = children.get(frame.next_child) {
        frame.next_child += 1;
        if doc.get_node(child).is_some() {
            return Some(child);
        }
    }
    None
}

fn live_shadow_root(doc: &BaseDocument, node: &Node) -> Option<NodeId> {
    node.attached_shadow_root_id()
        .filter(|&id| doc.get_node(id).is_some())
}

fn live_child_count(doc: &BaseDocument, node: &Node) -> usize {
    node.children()
        .iter()
        .filter(|&id| doc.get_node(id).is_some())
        .count()
}

/// The node's only child, when it is a text node.
fn lone_text_child(doc: &BaseDocument, node: &Node) -> Option<NodeId> {
    let children = node.children();
    let (1, Some(only)) = (children.len(), children.first()) else {
        return None;
    };
    doc.get_node(only)
        .is_some_and(|child| matches!(child.data, NodeData::Text(_)))
        .then_some(only)
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
    walk_subtree(doc, root, subtree, |_, _| {
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
    walk_subtree(doc, root, subtree, |node, scope| {
        let scope = if single_node {
            scope.without_children()
        } else {
            scope
        };
        let id = handles.existing_external(node.id()).unwrap_or(max_new_id);
        let bytes = node_bytes(node, base_url, id, scope);
        size.at_least_bytes = size.at_least_bytes.saturating_add(bytes);
        !single_node && size.at_least_bytes <= SUBTREE_BUDGET_BYTES
    });
    size
}

/// A lower bound on the bytes V8 serializes for one described node, without its descendants.
fn node_bytes(node: &Node, base_url: &str, id: u32, scope: NodeScope) -> usize {
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
        NodeData::Element(data) => {
            bytes = bytes.saturating_add(element_bytes(data, true));
        }
        NodeData::AnonymousBlock(data) => {
            bytes = bytes.saturating_add(element_bytes(data, false));
        }
    }
    if let Some(length) = scope.child_count {
        bytes = bytes.saturating_add(property_size("children") + array_size(length));
    }
    if scope.has_shadow {
        bytes = bytes.saturating_add(property_size("shadowRoots") + array_size(1));
    }
    bytes
}

/// A lower bound on the bytes of an element record. `report_namespace` is set for a real
/// element: an anonymous block reports no namespace URI.
fn element_bytes(data: &ElementData, report_namespace: bool) -> usize {
    let local = data.name.local.as_ref();
    let mut bytes = string_size(&qualified_name_parts(
        data.prefix().map(|p| p.as_ref()),
        local,
    ))
    .saturating_add(string_size(&[local]))
    .saturating_add(string_size(&[""]));
    if report_namespace && *data.namespace() != ns!(html) && !data.namespace().is_empty() {
        bytes = bytes
            .saturating_add(property_size("namespaceURI"))
            .saturating_add(string_size(&[data.namespace().as_ref()]));
    }
    bytes.saturating_add(attributes_bytes(&data.attrs))
}

/// A lower bound on the bytes of an element's `attributes` and `attributeNamespaces` records.
fn attributes_bytes(attrs: &[Attribute]) -> usize {
    if attrs.is_empty() {
        return 0;
    }
    let mut bytes =
        property_size("attributes").saturating_add(array_size(attrs.len().saturating_mul(2)));
    for attr in attrs {
        bytes = bytes
            .saturating_add(qualified_name_size(attr))
            .saturating_add(string_size(&[&attr.value]));
    }
    let namespaced = attrs
        .iter()
        .filter(|attr| !attr.namespace().is_empty())
        .count();
    if namespaced == 0 {
        return bytes;
    }
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
    for attr in attrs.iter().filter(|attr| !attr.namespace().is_empty()) {
        let prefix = attr.prefix().map_or("", |p| p.as_ref());
        bytes = bytes
            .saturating_add(qualified_name_size(attr))
            .saturating_add(string_size(&[attr.namespace().as_ref()]))
            .saturating_add(string_size(&[prefix]))
            .saturating_add(string_size(&[attr.name.local.as_ref()]));
    }
    bytes
}

/// The bytes of an attribute's qualified name.
fn qualified_name_size(attr: &Attribute) -> usize {
    string_size(&qualified_name_parts(
        attr.prefix().map(|p| p.as_ref()),
        attr.name.local.as_ref(),
    ))
}

/// The parts of a qualified name, `prefix:local`, without joining them into one string.
fn qualified_name_parts<'a>(prefix: Option<&'a str>, local: &'a str) -> [&'a str; 3] {
    let prefix = prefix.unwrap_or("");
    [prefix, if prefix.is_empty() { "" } else { ":" }, local]
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

/// A node's attributes as `nodeInfo` reports them: flat qualified-name/value pairs, plus the
/// namespace of each namespaced attribute. Both are absent when empty or for a non-element.
#[derive(Serialize)]
pub(crate) struct AttributeList {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attributes: Option<Vec<String>>,
    #[serde(
        rename = "attributeNamespaces",
        skip_serializing_if = "Option::is_none"
    )]
    attribute_namespaces: Option<Vec<CdpAttributeNamespace>>,
}

pub(crate) fn describe_attributes(node: &Node) -> AttributeList {
    let (NodeData::Element(data) | NodeData::AnonymousBlock(data)) = &node.data else {
        return AttributeList {
            attributes: None,
            attribute_namespaces: None,
        };
    };
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
    AttributeList {
        attributes: (!flat.is_empty()).then_some(flat),
        attribute_namespaces: (!attribute_namespaces.is_empty()).then_some(attribute_namespaces),
    }
}

/// Describes node `id`; `subtree` None leaves out children and shadow roots.
pub(crate) fn describe_node(
    doc: &BaseDocument,
    id: NodeId,
    base_url: &str,
    subtree: Option<Subtree>,
    node_handles: &mut NodeHandleMap,
) -> Option<CdpNode> {
    let node: &Node = doc.get_node(id)?;

    let shadow_root_type: Option<String> = match &node.data {
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
    } = describe_node_identity(node);
    let is_doc = matches!(node.data, NodeData::Document(_));
    let AttributeList {
        attributes,
        attribute_namespaces,
    } = describe_attributes(node);

    let child_node_count = node.children().len() as u32;
    let children =
        subtree.and_then(|subtree| describe_children(doc, node, base_url, subtree, node_handles));
    let shadow_root = subtree
        .and_then(|subtree| describe_shadow_root(doc, node, base_url, subtree, node_handles));

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
        shadow_roots: shadow_root.map(|root| vec![root]),
        shadow_root_type,
        namespace_uri,
    })
}

/// The children a description includes at `subtree`'s depth. A shadow host's light children are
/// what its shadow root slots in, so they stay with the root even at the depth limit.
fn describe_children(
    doc: &BaseDocument,
    node: &Node,
    base_url: &str,
    mut subtree: Subtree,
    node_handles: &mut NodeHandleMap,
) -> Option<Vec<CdpNode>> {
    if subtree.depth == 0 {
        if node.attached_shadow_root_id().is_none() {
            // A lone text child is cheap and shows the element's content without a round trip.
            let only = lone_text_child(doc, node)?;
            return describe_node(doc, only, base_url, Some(subtree), node_handles)
                .map(|c| vec![c]);
        }
        subtree.depth = 1;
    }
    let below = subtree.below();
    let mut out = Vec::with_capacity(node.children().len());
    for child in node.children() {
        if let Some(described) = describe_node(doc, child, base_url, Some(below), node_handles) {
            out.push(described);
        }
    }
    Some(out)
}

/// The shadow root, described to `subtree`'s depth only when piercing.
fn describe_shadow_root(
    doc: &BaseDocument,
    node: &Node,
    base_url: &str,
    subtree: Subtree,
    node_handles: &mut NodeHandleMap,
) -> Option<CdpNode> {
    let depth = if subtree.pierce { subtree.depth } else { 0 };
    let shadow = Subtree { depth, ..subtree };
    let root = node.attached_shadow_root_id()?;
    describe_node(doc, root, base_url, Some(shadow), node_handles)
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
            let mut out = NotRenderedIds::default();
            let mut stack = vec![VisibilityCursor::new(doc.root_node())];
            while let Some(id) = next_visibility_node(doc.as_ref(), &mut stack) {
                let Some(node) = doc.get_node(id) else {
                    continue;
                };
                if self.record_unrendered(node, &mut out) {
                    stack.push(VisibilityCursor::new(node));
                }
            }
            out
        }))
        .unwrap_or_default();
        drop(doc);
        out
    }

    /// Records a node the page does not render and returns whether its children still matter.
    fn record_unrendered(&self, node: &Node, out: &mut NotRenderedIds) -> bool {
        use ::style::properties::generated::longhands::visibility::computed_value::T as StyloVisibility;
        use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
        if !node.is_element() {
            return true;
        }
        let Some(styles) = node.primary_styles() else {
            return true;
        };
        let display = styles.clone_display();
        if display.outside() == DisplayOutside::None && display.inside() == DisplayInside::None {
            out.display_none.push(self.external_node_id(node.id()));
            return false;
        }
        if styles.get_inherited_box().visibility != StyloVisibility::Visible {
            out.invisible.push(self.external_node_id(node.id()));
        }
        true
    }
}
