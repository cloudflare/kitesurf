// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// XMLSerializer: the DOM Parsing spec's XML serialization over the public Node API, so it
// serializes live and DOMParser nodes alike. Limitation: the require-well-formed checks are
// not implemented, and prefixes are only declared, never generated.

import type * as Idl from "./idl/types.generated.js";
import { HTML_NS } from "./constants.js";

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

// HTML void elements serialize as `<br />`, other childless HTML elements with an end tag.
const HTML_VOID = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

// The namespace each prefix maps to in scope; "" is the default namespace.
type Scope = ReadonlyMap<string, string | null>;

function serializeElement(el: Idl.Element, scope: Scope, out: string[]): void {
  const ns = el.namespaceURI;
  const prefix = el.prefix;
  const local = el.localName;
  const qname = prefix ? `${prefix}:${local}` : local;
  const attrs: Idl.Attr[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i);
    if (a) attrs.push(a);
  }
  const own = new Map(scope);
  const declared = new Set<string>();
  for (const a of attrs) {
    if (a.namespaceURI !== XMLNS_NS && a.name !== "xmlns" && !a.name.startsWith("xmlns:")) continue;
    const key = a.name === "xmlns" ? "" : a.localName;
    own.set(key, a.value || null);
    declared.add(key);
  }
  let open = `<${qname}`;
  const declare = (key: string, value: string | null) => {
    if (declared.has(key) || own.get(key) === value) return;
    own.set(key, value);
    declared.add(key);
    open += key ? ` xmlns:${key}="${escapeAttr(value ?? "")}"` : ` xmlns="${escapeAttr(value ?? "")}"`;
  };
  declare(prefix ?? "", ns);
  for (const a of attrs) {
    const ans = a.namespaceURI;
    if (ans && ans !== XMLNS_NS && ans !== XML_NS && a.prefix) declare(a.prefix, ans);
  }
  for (const a of attrs) open += ` ${a.name}="${escapeAttr(a.value)}"`;
  out.push(open);
  // A template's children live in its content fragment.
  const holder =
    ns === HTML_NS && local === "template"
      ? ((el as Idl.HTMLTemplateElement).content as Idl.Node | null) ?? el
      : el;
  const children = holder.childNodes;
  if (!children.length) {
    if (ns !== HTML_NS) out.push("/>");
    else out.push(HTML_VOID.has(local) ? " />" : `></${qname}>`);
    return;
  }
  out.push(">");
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child) serializeNode(child, own, out);
  }
  out.push(`</${qname}>`);
}

function serializeNode(node: Idl.Node, scope: Scope, out: string[]): void {
  switch (node.nodeType) {
    case 1:
      serializeElement(node as Idl.Element, scope, out);
      return;
    case 3:
      out.push(escapeText((node as Idl.CharacterData).data));
      return;
    case 4:
      out.push(`<![CDATA[${(node as Idl.CharacterData).data}]]>`);
      return;
    case 7: {
      // The generated IDL types leave target out; read it where the node has one.
      const pi = node as Idl.ProcessingInstruction & { readonly target?: string };
      const target = pi.target ?? (node as Idl.Node).nodeName;
      out.push(`<?${target}${pi.data ? " " + pi.data : ""}?>`);
      return;
    }
    case 8:
      out.push(`<!--${(node as Idl.CharacterData).data}-->`);
      return;
    case 9:
    case 11: {
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) serializeNode(child, scope, out);
      }
      return;
    }
    case 10: {
      // The generated IDL types leave publicId and systemId out; they read as empty if absent.
      const dt = node as Idl.DocumentType & { readonly publicId?: string; readonly systemId?: string };
      let s = `<!DOCTYPE ${dt.name}`;
      if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
      else if (dt.systemId) s += " SYSTEM";
      if (dt.systemId) s += ` "${dt.systemId}"`;
      out.push(s + ">");
      return;
    }
    default:
      // Attr nodes serialize to the empty string.
      return;
  }
}

class XMLSerializer implements Idl.XMLSerializer {
  serializeToString(root: Idl.Node): string {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'serializeToString' on 'XMLSerializer': 1 argument required, but only 0 present.",
      );
    }
    if (!root || typeof (root as { nodeType?: unknown }).nodeType !== "number") {
      throw new TypeError(
        "Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.",
      );
    }
    const out: string[] = [];
    serializeNode(root, new Map([["", null]]), out);
    return out.join("");
  }
}

export { XMLSerializer };
