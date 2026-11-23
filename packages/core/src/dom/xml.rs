// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The XML form of a subtree, as `XMLSerializer.serializeToString` writes it: the namespace
//! declarations, empty-element tags and escaping follow Chrome's output.

use std::borrow::Cow;
use std::collections::HashMap;

use blitz_dom::node::{Attribute, ChildIds};
use blitz_dom::{BaseDocument, Node, NodeData};
use blitz_traits::NodeId;
use wasm_bindgen::prelude::*;

use crate::dom::tree::{serialized_children, TemplateContents};
use crate::DomHandle;

const XHTML_NS: &str = "http://www.w3.org/1999/xhtml";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

// Chrome closes an empty HTML element of these names with " />" and writes every other empty
// HTML element with an end tag; the list is wider than the HTML serializer's void elements.
const SELF_CLOSING: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr",
];

/// An attribute's prefix, local name and namespace, with "" for a missing prefix or namespace,
/// whether the tree stored them or the shim passed them.
#[derive(Clone, Copy)]
struct AttrName<'a> {
    prefix: &'a str,
    local: &'a str,
    ns: &'a str,
}

// The full name of each attribute a script set with setAttributeNS, by element and stored name.
// The tree keeps such an attribute under that one name, so the caller passes the parts.
type ScriptedNames<'a> = HashMap<(NodeId, &'a str), AttrName<'a>>;

enum Step<'a> {
    Open(&'a Node),
    Close {
        prefix: &'static str,
        local: &'a str,
        bindings: usize,
    },
}

struct XmlWriter<'a> {
    doc: &'a BaseDocument,
    templates: &'a TemplateContents,
    scripted: &'a ScriptedNames<'a>,
    // Each prefix in scope with its namespace, innermost last; "" is the default namespace.
    // An element's declarations are truncated away when its end tag is written.
    bindings: Vec<(Cow<'a, str>, &'a str)>,
    // Generated prefixes count up from ns1 across the whole call rather than per element, as
    // Chrome's do, so siblings get ns1 and ns2.
    next_prefix: u32,
    entered: Vec<NodeId>,
    out: String,
}

impl<'a> XmlWriter<'a> {
    // An explicit stack, not recursion, as in the HTML writer: a deeply nested DOM overflows
    // the wasm call stack.
    fn write(mut self, node: &'a Node) -> String {
        let mut stack = vec![Step::Open(node)];
        while let Some(step) = stack.pop() {
            match step {
                Step::Open(node) => self.open(node, &mut stack),
                Step::Close {
                    prefix,
                    local,
                    bindings,
                } => {
                    self.out.push_str("</");
                    self.name(prefix, local);
                    self.out.push('>');
                    self.bindings.truncate(bindings);
                }
            }
        }
        self.out
    }

    fn attr_name(&self, node: NodeId, attr: &'a Attribute) -> AttrName<'a> {
        let local: &str = &attr.name.local;
        let ns: &str = attr.namespace();
        let prefix = attr.prefix().map_or("", |prefix| &**prefix);
        if prefix.is_empty() && ns.is_empty() {
            if let Some(&scripted) = self.scripted.get(&(node, local)) {
                return scripted;
            }
        }
        AttrName { prefix, local, ns }
    }

    fn namespace_of(&self, prefix: &str) -> Option<&'a str> {
        self.bindings
            .iter()
            .rev()
            .find(|(bound, _)| bound == prefix)
            .map(|(_, ns)| *ns)
    }

    // A prefix in scope for `ns`, other than the default namespace, that no inner declaration has
    // rebound to something else.
    fn prefix_for(&self, ns: &str) -> Option<Cow<'a, str>> {
        self.bindings
            .iter()
            .rev()
            .find(|(bound, bound_ns)| {
                !bound.is_empty() && *bound_ns == ns && self.namespace_of(bound) == Some(ns)
            })
            .map(|(bound, _)| bound.clone())
    }

    fn name(&mut self, prefix: &str, local: &str) {
        if !prefix.is_empty() {
            self.out.push_str(prefix);
            self.out.push(':');
        }
        self.out.push_str(local);
    }

    fn declare(&mut self, prefix: Cow<'a, str>, ns: &'a str) {
        self.out.push_str(" xmlns");
        if !prefix.is_empty() {
            self.out.push(':');
            self.out.push_str(&prefix);
        }
        self.out.push_str("=\"");
        escape_attr(ns, &mut self.out);
        self.out.push('"');
        self.bindings.push((prefix, ns));
    }

    // The prefix for a namespaced attribute: its own when that is free or already means its
    // namespace, else one in scope for the namespace, else ns1, ns2... declared here.
    fn attr_prefix(&mut self, name: AttrName<'a>) -> Cow<'a, str> {
        if !name.prefix.is_empty() && name.prefix != "xml" && name.prefix != "xmlns" {
            match self.namespace_of(name.prefix) {
                Some(ns) if ns == name.ns => return Cow::Borrowed(name.prefix),
                None => {
                    self.declare(Cow::Borrowed(name.prefix), name.ns);
                    return Cow::Borrowed(name.prefix);
                }
                Some(_) => {}
            }
        }
        if let Some(prefix) = self.prefix_for(name.ns) {
            return prefix;
        }
        loop {
            let candidate = format!("ns{}", self.next_prefix);
            self.next_prefix += 1;
            if self.namespace_of(&candidate).is_none() {
                self.declare(Cow::Owned(candidate.clone()), name.ns);
                return Cow::Owned(candidate);
            }
        }
    }

    fn push_children(&self, children: ChildIds<'a>, stack: &mut Vec<Step<'a>>) {
        for id in children.iter().rev() {
            if let Some(child) = self.doc.get_node(id) {
                stack.push(Step::Open(child));
            }
        }
    }

    fn open(&mut self, node: &'a Node, stack: &mut Vec<Step<'a>>) {
        let data = match &node.data {
            NodeData::Document(_) | NodeData::ShadowRoot(_) => {
                return self.push_children(node.children(), stack);
            }
            NodeData::Comment { contents } => {
                self.out.push_str("<!--");
                self.out.push_str(contents);
                return self.out.push_str("-->");
            }
            NodeData::Text(text) => return escape_text(&text.content, &mut self.out),
            NodeData::Element(data) | NodeData::AnonymousBlock(data) => data,
        };
        let ns: &'a str = data.namespace();
        let local: &'a str = &data.name.local;
        let prefix = if ns == XML_NS { "xml" } else { "" };
        let saved = self.bindings.len();
        let id = node.id();

        // A carried prefixed declaration always binds; a default one, or a plain xmlns attribute,
        // binds only when it names the element's own namespace.
        let mut default_carried = false;
        for attr in data.attrs.iter() {
            let name = self.attr_name(id, attr);
            let value = attr.value.as_str();
            if name.ns == XMLNS_NS && name.prefix == "xmlns" {
                self.bindings.push((Cow::Borrowed(name.local), value));
            } else if name.prefix.is_empty()
                && name.local == "xmlns"
                && value == ns
                && (name.ns == XMLNS_NS || name.ns.is_empty())
            {
                default_carried = true;
            }
        }

        self.out.push('<');
        self.name(prefix, local);
        if ns != XML_NS {
            if default_carried {
                self.bindings.push((Cow::Borrowed(""), ns));
            } else if self.namespace_of("").unwrap_or("") != ns {
                self.declare(Cow::Borrowed(""), ns);
            }
        }

        for attr in data.attrs.iter() {
            let name = self.attr_name(id, attr);
            let value = attr.value.as_str();
            let written: Cow<'a, str> = if name.ns == XMLNS_NS {
                if name.prefix.is_empty() && value != ns {
                    continue; // Chrome drops a default declaration that names another namespace.
                }
                Cow::Borrowed(if name.prefix.is_empty() { "" } else { "xmlns" })
            } else if name.ns == XML_NS {
                Cow::Borrowed("xml")
            } else if name.ns.is_empty() {
                Cow::Borrowed("")
            } else {
                self.attr_prefix(name)
            };
            self.out.push(' ');
            self.name(&written, name.local);
            self.out.push_str("=\"");
            escape_attr(value, &mut self.out);
            self.out.push('"');
        }

        let children = serialized_children(self.doc, self.templates, node, &mut self.entered);
        let Some(children) = children.filter(|children| !children.is_empty()) else {
            if ns != XHTML_NS {
                self.out.push_str("/>");
            } else if SELF_CLOSING.contains(&local) {
                self.out.push_str(" />");
            } else {
                self.out.push_str("></");
                self.name(prefix, local);
                self.out.push('>');
            }
            self.bindings.truncate(saved);
            return;
        };
        self.out.push('>');
        stack.push(Step::Close {
            prefix,
            local,
            bindings: saved,
        });
        self.push_children(children, stack);
    }
}

fn escape_text(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

fn escape_attr(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#9;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            _ => out.push(ch),
        }
    }
}

#[wasm_bindgen]
impl DomHandle {
    /// The subtree at `node_id` in XML form. `scripted_names` has one line per attribute set with
    /// setAttributeNS: element id, stored name, prefix, local name and namespace, tab-separated.
    #[wasm_bindgen(js_name = "serializeXml")]
    pub fn serialize_xml(&self, node_id: u32, scripted_names: &str) -> String {
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
        let scripted: ScriptedNames = scripted_names
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\t');
                let element = self.resolve_node_id(fields.next()?.parse().ok()?)?;
                let stored = fields.next()?;
                let name = AttrName {
                    prefix: fields.next()?,
                    local: fields.next()?,
                    ns: fields.next()?,
                };
                Some(((element, stored), name))
            })
            .collect();
        let templates = self.template_contents.borrow();
        let writer = XmlWriter {
            doc: &doc,
            templates: &templates,
            scripted: &scripted,
            bindings: vec![(Cow::Borrowed("xml"), XML_NS)],
            next_prefix: 1,
            entered: Vec::new(),
            out: String::new(),
        };
        writer.write(node)
    }
}
