// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// XMLSerializer. The core writes an element subtree in one call; the node kinds it does not
// model (doctype, CDATA, processing instruction) and the leaf nodes are written here.

import {
  ATTRIBUTE_NODE,
  CDATA_SECTION_NODE,
  COMMENT_NODE,
  DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_NODE,
  ELEMENT_NODE,
  PROCESSING_INSTRUCTION_NODE,
  TEXT_NODE,
} from "./constants.js";
import type * as Idl from "./idl/types.generated.js";
import { attrNs, parsedHandle } from "./registries.js";
import { dom } from "./state.js";
import { XMLNS_NS } from "./util/validation.js";

interface SerializableNode {
  nodeType: number;
  _id?: number;
  childNodes?: ArrayLike<SerializableNode>;
  data?: string;
  value?: string;
  target?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
}

const NOT_A_NODE =
  "Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.";

function isNode(value: unknown): value is SerializableNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    typeof value.nodeType === "number"
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function doctype(node: SerializableNode): string {
  let out = `<!DOCTYPE ${node.name ?? ""}`;
  if (node.publicId) out += ` PUBLIC "${node.publicId}"`;
  else if (node.systemId) out += " SYSTEM";
  if (node.systemId) out += ` "${node.systemId}"`;
  return `${out}>`;
}

// The core keeps an attribute set with setAttributeNS under its qualified name alone, so the
// namespace of each one goes with the call: element id, attribute name, namespace per line.
function scriptedNamespaces(): string {
  let out = "";
  for (const [elementId, attributes] of attrNs) {
    for (const [name, info] of attributes) {
      if (info.parsed || !info.prefix || !info.ns || info.ns === XMLNS_NS) continue;
      if (/[\t\n]/.test(name) || /[\t\n]/.test(info.ns)) continue;
      out += `${elementId}\t${name}\t${info.ns}\n`;
    }
  }
  return out;
}

function serialize(node: SerializableNode, scripted: string): string {
  switch (node.nodeType) {
    case ELEMENT_NODE: {
      if (typeof node._id !== "number") throw new TypeError(NOT_A_NODE);
      // A DOMParser document has its own tree and handle, and the scripted namespaces
      // refer to the page's tree, so it is serialized without them.
      const parsed = parsedHandle(node);
      return parsed ? parsed.serializeXml(node._id, "") : dom.serializeXml(node._id, scripted);
    }
    case ATTRIBUTE_NODE:
      return node.value ?? "";
    case TEXT_NODE:
      return escapeText(node.data ?? "");
    case CDATA_SECTION_NODE:
      return `<![CDATA[${node.data ?? ""}]]>`;
    case PROCESSING_INSTRUCTION_NODE:
      return `<?${node.target ?? ""} ${node.data ?? ""}?>`;
    case COMMENT_NODE:
      return `<!--${node.data ?? ""}-->`;
    case DOCTYPE_NODE:
      return doctype(node);
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE: {
      let out = "";
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) out += serialize(children[i]!, scripted);
      }
      return out;
    }
    default:
      return "";
  }
}

class XMLSerializer implements Idl.XMLSerializer {
  serializeToString(root: Idl.Node): string {
    if (!isNode(root)) throw new TypeError(NOT_A_NODE);
    return serialize(root, scriptedNamespaces());
  }
}

export { XMLSerializer };
