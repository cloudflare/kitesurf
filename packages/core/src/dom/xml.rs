// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The XML form of a subtree, as `XMLSerializer.serializeToString` writes it: the namespace
//! declarations, empty-element tags and escaping follow Chrome's output.

use std::collections::HashMap;

use blitz_dom::node::Attribute;
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

// The namespace of each attribute a script set with setAttributeNS, by element and name. The
// tree keeps such an attribute under its qualified name alone, so the caller passes these.
type ScriptedNamespaces<'a> = HashMap<(NodeId, &'a str), &'a str>;

enum Step<'a> {
    Open(&'a Node),
    Close {
        prefix: &'a str,
        local: &'a str,
        bindings: usize,
    },
}

struct XmlWriter<'a> {
    doc: &'a BaseDocument,
    templates: &'a TemplateContents,
    scripted: &'a ScriptedNamespaces<'a>,
    // Each prefix in scope with its namespace, innermost last; "" is the default namespace.
    // An element's declarations are truncated away when its end tag is written.
    bindings: Vec<(&'a str, &'a str)>,
    out: String,
}

// The prefix an attribute declares, "" for the default namespace. Markup inserted through
// innerHTML keeps `xmlns` as a plain attribute, which Chrome honours when it names `element_ns`.
fn declared_prefix<'a>(attr: &'a Attribute, element_ns: &str) -> Option<&'a str> {
    let local: &str = &attr.name.local;
    if &*attr.name.ns == XMLNS_NS {
        return Some(if attr.name.prefix.as_deref() == Some("xmlns") {
            local
        } else {
            ""
        });
    }
    if attr.name.prefix.is_some() || !attr.name.ns.is_empty() {
        return None;
    }
    if local == "xmlns" {
        return (attr.value == element_ns).then_some("");
    }
    local.strip_prefix("xmlns:")
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

    fn namespace_of(&self, prefix: &str) -> &'a str {
        self.bindings
            .iter()
            .rev()
            .find(|(bound, _)| *bound == prefix)
            .map_or("", |(_, ns)| *ns)
    }

    fn name(&mut self, prefix: &str, local: &str) {
        if !prefix.is_empty() {
            self.out.push_str(prefix);
            self.out.push(':');
        }
        self.out.push_str(local);
    }

    fn declare(&mut self, prefix: &'a str, ns: &'a str) {
        self.bindings.push((prefix, ns));
        self.out.push_str(" xmlns");
        if !prefix.is_empty() {
            self.out.push(':');
            self.out.push_str(prefix);
        }
        self.out.push_str("=\"");
        escape_attr(ns, &mut self.out);
        self.out.push('"');
    }

    fn push_children(&self, children: &'a [NodeId], stack: &mut Vec<Step<'a>>) {
        for &id in children.iter().rev() {
            if let Some(child) = self.doc.get_node(id) {
                stack.push(Step::Open(child));
            }
        }
    }

    fn open(&mut self, node: &'a Node, stack: &mut Vec<Step<'a>>) {
        let data = match &node.data {
            NodeData::Document(_) | NodeData::ShadowRoot(_) => {
                return self.push_children(&node.children, stack);
            }
            NodeData::Comment { contents } => {
                self.out.push_str("<!--");
                self.out.push_str(contents);
                return self.out.push_str("-->");
            }
            NodeData::Text(text) => return escape_text(&text.content, &mut self.out),
            NodeData::Element(data) | NodeData::AnonymousBlock(data) => data,
        };
        let ns: &str = &data.name.ns;
        let prefix: &str = data.name.prefix.as_deref().unwrap_or("");
        let local: &str = &data.name.local;
        let saved = self.bindings.len();
        let carries = |p: &str| {
            data.attrs
                .iter()
                .any(|attr| declared_prefix(attr, ns) == Some(p))
        };
        let inherited = self.namespace_of(prefix);
        // A declaration the element carries takes effect before any is generated for it,
        // so a namespace it already declares is never written twice.
        for attr in data.attrs.iter() {
            if let Some(bound) = declared_prefix(attr, ns) {
                self.bindings.push((bound, attr.value.as_str()));
            }
        }

        self.out.push('<');
        self.name(prefix, local);
        if prefix != "xml" && inherited != ns && !carries(prefix) {
            self.declare(prefix, ns);
        }
        for Attribute { name, value } in data.attrs.iter() {
            let attr_local: &str = &name.local;
            // A parsed attribute carries its prefix; one set from script is a single name
            // whose prefix is the part before the colon, with the namespace passed in.
            let (attr_prefix, attr_ns): (&str, &str) = match &name.prefix {
                Some(parsed) => (&**parsed, &*name.ns),
                None => match self.scripted.get(&(node.id, attr_local)) {
                    Some(ns) => (attr_local.split_once(':').map_or("", |(p, _)| p), *ns),
                    None => ("", ""),
                },
            };
            if !attr_prefix.is_empty()
                && attr_prefix != "xml"
                && attr_prefix != "xmlns"
                && attr_ns != XMLNS_NS
                && attr_ns != XML_NS
                && self.namespace_of(attr_prefix) != attr_ns
                && !carries(attr_prefix)
            {
                self.declare(attr_prefix, attr_ns);
            }
            self.out.push(' ');
            self.name(name.prefix.as_deref().unwrap_or(""), attr_local);
            self.out.push_str("=\"");
            escape_attr(value, &mut self.out);
            self.out.push('"');
        }

        let children = serialized_children(self.doc, node, self.templates);
        if children.is_empty() {
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
        }
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
    /// The subtree at `node_id` in XML form. `scripted_namespaces` has one line per attribute
    /// set with setAttributeNS: element id, attribute name and namespace, tab-separated.
    #[wasm_bindgen(js_name = "serializeXml")]
    pub fn serialize_xml(&self, node_id: u32, scripted_namespaces: &str) -> String {
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
        let scripted: ScriptedNamespaces = scripted_namespaces
            .lines()
            .filter_map(|line| {
                let mut fields = line.splitn(3, '\t');
                let element = self.resolve_node_id(fields.next()?.parse().ok()?)?;
                Some(((element, fields.next()?), fields.next()?))
            })
            .collect();
        let templates = self.template_contents.borrow();
        let writer = XmlWriter {
            doc: &doc,
            templates: &templates,
            scripted: &scripted,
            bindings: vec![("xml", XML_NS)],
            out: String::new(),
        };
        writer.write(node)
    }
}
