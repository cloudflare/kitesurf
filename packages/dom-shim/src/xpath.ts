// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Evaluates XPath expressions over shim DOM wrappers and exposes the result interfaces.

import type * as Idl from "./idl/types.generated.js";
import { getInternalState } from "./internal-state.js";
import { asciiLowercase } from "./util/strings.js";
import { reportException } from "./events/dispatch.js";
import {
  ATTRIBUTE_NODE,
  CDATA_SECTION_NODE,
  COMMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_NODE,
  DOCTYPE_NODE,
  ELEMENT_NODE,
  ENTITY_NODE,
  ENTITY_REFERENCE_NODE,
  HTML_NS,
  NOTATION_NODE,
  PROCESSING_INSTRUCTION_NODE,
  TEXT_NODE,
} from "./constants.js";
import { XML_NS, XMLNS_NS } from "./util/validation.js";

const RESULT_TYPES = {
  ANY_TYPE: 0,
  NUMBER_TYPE: 1,
  STRING_TYPE: 2,
  BOOLEAN_TYPE: 3,
  UNORDERED_NODE_ITERATOR_TYPE: 4,
  ORDERED_NODE_ITERATOR_TYPE: 5,
  UNORDERED_NODE_SNAPSHOT_TYPE: 6,
  ORDERED_NODE_SNAPSHOT_TYPE: 7,
  ANY_UNORDERED_NODE_TYPE: 8,
  FIRST_ORDERED_NODE_TYPE: 9,
} as const;

interface XNode {
  readonly nodeType: number;
  readonly parentNode?: XNode | null;
  readonly ownerElement?: XNode | null;
  readonly ownerDocument?: { readonly contentType?: string } | null;
  readonly firstChild?: XNode | null;
  readonly lastChild?: XNode | null;
  readonly nextSibling?: XNode | null;
  readonly previousSibling?: XNode | null;
  readonly attributes?: ArrayLike<XNode | null> | null;
  readonly name?: string;
  readonly localName?: string | null;
  readonly namespaceURI?: string | null;
  readonly prefix?: string | null;
  readonly target?: string;
  readonly textContent?: string | null;
  readonly value?: string;
  readonly nodeValue?: string | null;
  readonly data?: string;
  getAttribute?(name: string): string | null;
  getAttributeNS?(namespace: string | null, localName: string): string | null;
}

type NodeSet = XNode[];
type Value = number | string | boolean | NodeSet;

type Axis =
  | "ancestor"
  | "ancestor-or-self"
  | "attribute"
  | "child"
  | "descendant"
  | "descendant-or-self"
  | "following"
  | "following-sibling"
  | "namespace"
  | "parent"
  | "preceding"
  | "preceding-sibling"
  | "self";
const AXES = new Set<string>([
  "ancestor",
  "ancestor-or-self",
  "attribute",
  "child",
  "descendant",
  "descendant-or-self",
  "following",
  "following-sibling",
  "namespace",
  "parent",
  "preceding",
  "preceding-sibling",
  "self",
]);
const REVERSE_AXES = new Set<Axis>([
  "ancestor",
  "ancestor-or-self",
  "preceding",
  "preceding-sibling",
]);
const NODE_TYPES = new Set(["comment", "text", "processing-instruction", "node"]);
const OPERATOR_NAMES = new Set(["and", "or", "mod", "div"]);

type NodeTest =
  | { k: "name"; ns: string | null; local: string }
  | { k: "any"; ns: string | null }
  | { k: "node" }
  | { k: "text" }
  | { k: "comment" }
  | { k: "pi"; target: string | null };

interface Step {
  axis: Axis;
  test: NodeTest;
  preds: Expr[];
}

type Expr =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "fn"; name: string; args: Expr[] }
  | { t: "or" | "and"; l: Expr; r: Expr }
  | { t: "cmp"; op: string; l: Expr; r: Expr }
  | { t: "arith"; op: string; l: Expr; r: Expr }
  | { t: "neg"; e: Expr }
  | { t: "union"; l: Expr; r: Expr }
  | { t: "filter"; e: Expr; preds: Expr[] }
  | { t: "path"; start: "root" | "context" | Expr; steps: Step[] };

interface Tok {
  t: "num" | "str" | "punct" | "op" | "name" | "fn" | "type" | "axis" | "var" | "eof";
  v: string;
}

const EOF_TOKEN: Tok = { t: "eof", v: "" };

function syntaxError(src: string): DOMException {
  return new DOMException(`The string '${src}' is not a valid XPath expression.`, "SyntaxError");
}

function isNameStart(codePoint: number): boolean {
  return (
    codePoint === 0x5f ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0xc0 && codePoint <= 0xd6) ||
    (codePoint >= 0xd8 && codePoint <= 0xf6) ||
    (codePoint >= 0xf8 && codePoint <= 0x2ff) ||
    (codePoint >= 0x370 && codePoint <= 0x37d) ||
    (codePoint >= 0x37f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  );
}

function isNameChar(codePoint: number): boolean {
  return (
    isNameStart(codePoint) ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0x2d ||
    codePoint === 0x2e ||
    codePoint === 0xb7 ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  );
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  const operatorMayFollow = (): boolean => {
    const p = toks[toks.length - 1];
    if (!p) return false;
    if (p.t === "op") return false;
    return !(
      p.t === "punct" &&
      (p.v === "@" || p.v === "::" || p.v === "(" || p.v === "[" || p.v === ",")
    );
  };
  const readNcName = (): string => {
    const start = i;
    const first = src.codePointAt(i) ?? -1;
    if (!isNameStart(first)) throw syntaxError(src);
    i += first > 0xffff ? 2 : 1;
    while (i < n) {
      const next = src.codePointAt(i) ?? -1;
      if (!isNameChar(next)) break;
      i += next > 0xffff ? 2 : 1;
    }
    return src.slice(start, i);
  };
  const peekNonSpace = (from: number): number => {
    let j = from;
    while (j < n && " \t\r\n".includes(src.charAt(j))) j++;
    return j;
  };
  while (i < n) {
    const c = src.charAt(i);
    if (" \t\r\n".includes(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw syntaxError(src);
      toks.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/.exec(src.slice(i));
      if (!m) throw syntaxError(src);
      toks.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === ".." || two === "::") {
      toks.push({ t: "punct", v: two });
      i += 2;
      continue;
    }
    if ("().[]@,".includes(c)) {
      toks.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if (two === "//" || two === "!=" || two === "<=" || two === ">=") {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("/|+-=<>".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "*") {
      toks.push(operatorMayFollow() ? { t: "op", v: "*" } : { t: "name", v: "*" });
      i++;
      continue;
    }
    if (c === "$") {
      i++;
      let name = readNcName();
      if (src[i] === ":" && src[i + 1] !== ":") {
        i++;
        name += ":" + readNcName();
      }
      toks.push({ t: "var", v: name });
      continue;
    }
    if (!isNameStart(src.codePointAt(i) ?? -1)) throw syntaxError(src);
    let name = readNcName();
    if (operatorMayFollow()) {
      if (!OPERATOR_NAMES.has(name)) throw syntaxError(src);
      toks.push({ t: "op", v: name });
      continue;
    }
    if (src[i] === ":" && src[i + 1] !== ":") {
      i++;
      if (src[i] === "*") {
        i++;
        toks.push({ t: "name", v: `${name}:*` });
        continue;
      }
      name += ":" + readNcName();
    }
    const next = peekNonSpace(i);
    if (src[next] === "(") {
      toks.push({ t: NODE_TYPES.has(name) ? "type" : "fn", v: name });
    } else if (src.slice(next, next + 2) === "::") {
      if (!AXES.has(name)) throw syntaxError(src);
      toks.push({ t: "axis", v: name });
    } else {
      toks.push({ t: "name", v: name });
    }
  }
  toks.push(EOF_TOKEN);
  return toks;
}

type Resolver = ((prefix: string) => unknown) | { lookupNamespaceURI: unknown } | null;

function resolvePrefix(resolver: Resolver, prefix: string): string {
  let ns: unknown = null;
  try {
    if (typeof resolver === "function") {
      ns = resolver(prefix);
    } else if (resolver !== null) {
      const lookupNamespaceURI = resolver.lookupNamespaceURI;
      if (typeof lookupNamespaceURI !== "function") {
        throw new TypeError("XPathNSResolver.lookupNamespaceURI is not callable");
      }
      ns = lookupNamespaceURI.call(resolver, prefix);
    }
  } catch (error) {
    reportException(error);
    throw new DOMException(
      `The string '${prefix}' is not a valid namespace prefix.`,
      "NamespaceError",
    );
  }
  if (ns === null || ns === undefined) {
    throw new DOMException(
      `The string '${prefix}' is not a valid namespace prefix.`,
      "NamespaceError",
    );
  }
  if (typeof ns === "symbol") {
    reportException(new TypeError("XPathNSResolver.lookupNamespaceURI returned a Symbol"));
    throw new DOMException(
      `The string '${prefix}' is not a valid namespace prefix.`,
      "NamespaceError",
    );
  }
  try {
    return String(ns);
  } catch (error) {
    reportException(error);
    throw new DOMException(
      `The string '${prefix}' is not a valid namespace prefix.`,
      "NamespaceError",
    );
  }
}

class Parser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
    private readonly resolver: Resolver,
  ) {}

  parse(): Expr {
    const e = this.orExpr();
    if (this.peek().t !== "eof") throw syntaxError(this.src);
    return e;
  }

  private peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)] ?? EOF_TOKEN;
  }

  private next(): Tok {
    return this.toks[this.i++] ?? EOF_TOKEN;
  }

  private is(t: Tok["t"], v?: string): boolean {
    const p = this.peek();
    return p.t === t && (v === undefined || p.v === v);
  }

  private expect(t: Tok["t"], v?: string): Tok {
    if (!this.is(t, v)) throw syntaxError(this.src);
    return this.next();
  }

  private binary(
    sub: () => Expr,
    ops: string[],
    make: (op: string, l: Expr, r: Expr) => Expr,
  ): Expr {
    let l = sub();
    while (this.peek().t === "op" && ops.includes(this.peek().v)) {
      const op = this.next().v;
      l = make(op, l, sub());
    }
    return l;
  }

  private orExpr(): Expr {
    return this.binary(
      () => this.andExpr(),
      ["or"],
      (_op, l, r) => ({ t: "or", l, r }),
    );
  }

  private andExpr(): Expr {
    return this.binary(
      () => this.equalityExpr(),
      ["and"],
      (_op, l, r) => ({ t: "and", l, r }),
    );
  }

  private equalityExpr(): Expr {
    return this.binary(
      () => this.relationalExpr(),
      ["=", "!="],
      (op, l, r) => ({ t: "cmp", op, l, r }),
    );
  }

  private relationalExpr(): Expr {
    return this.binary(
      () => this.additiveExpr(),
      ["<", ">", "<=", ">="],
      (op, l, r) => ({ t: "cmp", op, l, r }),
    );
  }

  private additiveExpr(): Expr {
    return this.binary(
      () => this.multiplicativeExpr(),
      ["+", "-"],
      (op, l, r) => ({ t: "arith", op, l, r }),
    );
  }

  private multiplicativeExpr(): Expr {
    return this.binary(
      () => this.unaryExpr(),
      ["*", "div", "mod"],
      (op, l, r) => ({ t: "arith", op, l, r }),
    );
  }

  private unaryExpr(): Expr {
    if (this.is("op", "-")) {
      this.next();
      return { t: "neg", e: this.unaryExpr() };
    }
    return this.unionExpr();
  }

  private unionExpr(): Expr {
    return this.binary(
      () => this.pathExpr(),
      ["|"],
      (_op, l, r) => ({ t: "union", l, r }),
    );
  }

  private pathExpr(): Expr {
    const p = this.peek();
    const startsFilter =
      p.t === "var" ||
      p.t === "str" ||
      p.t === "num" ||
      p.t === "fn" ||
      (p.t === "punct" && p.v === "(");
    if (!startsFilter) return this.locationPath();
    const primary = this.primaryExpr();
    const preds = this.predicates();
    let e: Expr = preds.length ? { t: "filter", e: primary, preds } : primary;
    if (this.is("op", "/") || this.is("op", "//")) {
      const steps: Step[] = [];
      this.relativePath(steps, true);
      e = { t: "path", start: e, steps };
    }
    return e;
  }

  private primaryExpr(): Expr {
    const p = this.next();
    if (p.t === "num") return { t: "num", v: Number(p.v) };
    if (p.t === "str") return { t: "str", v: p.v };
    if (p.t === "var") throw new DOMException(`Variable '$${p.v}' is not defined.`, "SyntaxError");
    if (p.t === "punct" && p.v === "(") {
      const e = this.orExpr();
      this.expect("punct", ")");
      return e;
    }
    if (p.t === "fn") {
      const fn = FUNCTIONS.get(p.v);
      if (!fn) throw syntaxError(this.src);
      this.expect("punct", "(");
      const args: Expr[] = [];
      if (!this.is("punct", ")")) {
        args.push(this.orExpr());
        while (this.is("punct", ",")) {
          this.next();
          args.push(this.orExpr());
        }
      }
      this.expect("punct", ")");
      const [min, max] = fn.arity;
      if (args.length < min || args.length > max) throw syntaxError(this.src);
      return { t: "fn", name: p.v, args };
    }
    throw syntaxError(this.src);
  }

  private predicates(): Expr[] {
    const preds: Expr[] = [];
    while (this.is("punct", "[")) {
      this.next();
      preds.push(this.orExpr());
      this.expect("punct", "]");
    }
    return preds;
  }

  private locationPath(): Expr {
    const steps: Step[] = [];
    if (this.is("op", "/")) {
      this.next();
      if (this.startsStep()) this.relativePath(steps, false);
      return { t: "path", start: "root", steps };
    }
    if (this.is("op", "//")) {
      this.relativePath(steps, true);
      return { t: "path", start: "root", steps };
    }
    this.relativePath(steps, false);
    return { t: "path", start: "context", steps };
  }

  private startsStep(): boolean {
    const p = this.peek();
    return (
      p.t === "name" ||
      p.t === "type" ||
      p.t === "axis" ||
      (p.t === "punct" && (p.v === "@" || p.v === "." || p.v === ".."))
    );
  }

  private relativePath(steps: Step[], leadingSeparator: boolean): void {
    if (leadingSeparator) this.separator(steps);
    steps.push(this.step());
    while (this.is("op", "/") || this.is("op", "//")) {
      this.separator(steps);
      steps.push(this.step());
    }
  }

  private separator(steps: Step[]): void {
    const sep = this.next().v;
    if (sep === "//") steps.push({ axis: "descendant-or-self", test: { k: "node" }, preds: [] });
  }

  private step(): Step {
    if (this.is("punct", ".")) {
      this.next();
      return { axis: "self", test: { k: "node" }, preds: [] };
    }
    if (this.is("punct", "..")) {
      this.next();
      return { axis: "parent", test: { k: "node" }, preds: [] };
    }
    let axis: Axis = "child";
    if (this.is("axis")) {
      axis = this.next().v as Axis;
      this.expect("punct", "::");
    } else if (this.is("punct", "@")) {
      this.next();
      axis = "attribute";
    }
    const test = this.nodeTest();
    return { axis, test, preds: this.predicates() };
  }

  private nodeTest(): NodeTest {
    const p = this.next();
    if (p.t === "type") {
      this.expect("punct", "(");
      let target: string | null = null;
      if (p.v === "processing-instruction" && this.is("str")) target = this.next().v;
      this.expect("punct", ")");
      if (p.v === "node") return { k: "node" };
      if (p.v === "text") return { k: "text" };
      if (p.v === "comment") return { k: "comment" };
      return { k: "pi", target };
    }
    if (p.t !== "name") throw syntaxError(this.src);
    if (p.v === "*") return { k: "any", ns: null };
    const colon = p.v.indexOf(":");
    if (colon < 0) return { k: "name", ns: null, local: p.v };
    const ns = resolvePrefix(this.resolver, p.v.slice(0, colon));
    const local = p.v.slice(colon + 1);
    return local === "*" ? { k: "any", ns } : { k: "name", ns, local };
  }
}

export function compile(src: string, resolver: Resolver): Expr {
  return new Parser(src, lex(src), resolver).parse();
}

function isAttr(n: XNode | null | undefined): boolean {
  return n?.nodeType === ATTRIBUTE_NODE;
}

function parentOf(n: XNode): XNode | null {
  return isAttr(n) ? (n.ownerElement ?? null) : (n.parentNode ?? null);
}

function inModel(n: XNode): boolean {
  const t = n.nodeType;
  return (
    t !== DOCTYPE_NODE && t !== NOTATION_NODE && t !== ENTITY_REFERENCE_NODE && t !== ENTITY_NODE
  );
}

function firstChild(n: XNode): XNode | null | undefined {
  let c = isAttr(n) ? null : n.firstChild;
  while (c && !inModel(c)) c = c.nextSibling;
  return c ?? null;
}

function lastChild(n: XNode): XNode | null | undefined {
  let c = isAttr(n) ? null : n.lastChild;
  while (c && !inModel(c)) c = c.previousSibling;
  return c ?? null;
}

function nextSibling(n: XNode): XNode | null | undefined {
  let c = isAttr(n) ? null : n.nextSibling;
  while (c && !inModel(c)) c = c.nextSibling;
  return c ?? null;
}

function previousSibling(n: XNode): XNode | null | undefined {
  let c = isAttr(n) ? null : n.previousSibling;
  while (c && !inModel(c)) c = c.previousSibling;
  return c ?? null;
}

function descendants(n: XNode, out: XNode[]): void {
  for (let c = firstChild(n); c; c = nextSibling(c)) {
    out.push(c);
    descendants(c, out);
  }
}

function descendantsReversed(n: XNode, out: XNode[]): void {
  for (let c = lastChild(n); c; c = previousSibling(c)) {
    descendantsReversed(c, out);
    out.push(c);
  }
}

function attributesOf(n: XNode): XNode[] {
  if (n?.nodeType !== ELEMENT_NODE) return [];
  const list = n.attributes;
  const out: XNode[] = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (
      !a ||
      a.namespaceURI === XMLNS_NS ||
      a.name === "xmlns" ||
      String(a.name).startsWith("xmlns:")
    )
      continue;
    out.push(a);
  }
  return out;
}

function axisNodes(axis: Axis, n: XNode): XNode[] {
  const out: XNode[] = [];
  switch (axis) {
    case "self":
      out.push(n);
      break;
    case "child":
      for (let c = firstChild(n); c; c = nextSibling(c)) out.push(c);
      break;
    case "descendant":
      descendants(n, out);
      break;
    case "descendant-or-self":
      out.push(n);
      descendants(n, out);
      break;
    case "parent": {
      const p = parentOf(n);
      if (p) out.push(p);
      break;
    }
    case "ancestor":
    case "ancestor-or-self":
      if (axis === "ancestor-or-self") out.push(n);
      for (let p = parentOf(n); p; p = parentOf(p)) out.push(p);
      break;
    case "following-sibling":
      for (let s = nextSibling(n); s; s = nextSibling(s)) out.push(s);
      break;
    case "preceding-sibling":
      for (let s = previousSibling(n); s; s = previousSibling(s)) out.push(s);
      break;
    case "following": {
      let a: XNode | null | undefined = n;
      if (isAttr(n)) {
        a = n.ownerElement;
        if (!a) break;
        descendants(a, out);
      }
      for (; a; a = parentOf(a)) {
        for (let s = nextSibling(a); s; s = nextSibling(s)) {
          out.push(s);
          descendants(s, out);
        }
      }
      break;
    }
    case "preceding": {
      for (let a = isAttr(n) ? n.ownerElement : n; a; a = parentOf(a)) {
        for (let s = previousSibling(a); s; s = previousSibling(s)) {
          descendantsReversed(s, out);
          out.push(s);
        }
      }
      break;
    }
    case "attribute":
      out.push(...attributesOf(n));
      break;
    case "namespace":
      break;
  }
  return out;
}

function isHtmlDocumentNode(el: XNode | null | undefined): boolean {
  const doc = el?.ownerDocument;
  return !!doc && doc.contentType === "text/html";
}

function matches(test: NodeTest, axis: Axis, n: XNode): boolean {
  const t = n.nodeType;
  switch (test.k) {
    case "node":
      return true;
    case "text":
      return t === TEXT_NODE || t === CDATA_SECTION_NODE;
    case "comment":
      return t === COMMENT_NODE;
    case "pi":
      return (
        t === PROCESSING_INSTRUCTION_NODE && (test.target === null || n.target === test.target)
      );
  }
  if (axis === "attribute") {
    if (t !== ATTRIBUTE_NODE) return false;
    const ns = n.namespaceURI ?? null;
    if (test.k === "any") return test.ns === null || ns === test.ns;
    const owner = n.ownerElement;
    if (
      test.ns === null &&
      ns === null &&
      owner &&
      owner.namespaceURI === HTML_NS &&
      isHtmlDocumentNode(owner)
    ) {
      return asciiLowercase(String(n.localName)) === asciiLowercase(test.local);
    }
    return n.localName === test.local && ns === test.ns;
  }
  if (t !== ELEMENT_NODE) return false;
  const ns = n.namespaceURI ?? null;
  if (test.k === "any") return test.ns === null || ns === test.ns;
  if (isHtmlDocumentNode(n)) {
    if (ns === HTML_NS)
      return (
        asciiLowercase(String(n.localName)) === asciiLowercase(test.local) &&
        (test.ns === null || test.ns === ns)
      );
    return n.localName === test.local && test.ns !== null && ns === test.ns;
  }
  return n.localName === test.local && ns === test.ns;
}

class Evaluation {
  private order: Map<XNode, number> | null = null;

  constructor(readonly root: XNode) {}

  private index(): Map<XNode, number> {
    if (this.order) return this.order;
    const order = new Map<XNode, number>();
    let k = 0;
    const visit = (n: XNode): void => {
      order.set(n, k++);
      if (n.nodeType === ELEMENT_NODE) for (const a of attributesOf(n)) order.set(a, k++);
      for (let c = firstChild(n); c; c = nextSibling(c)) visit(c);
    };
    visit(this.root);
    this.order = order;
    return order;
  }

  sort(nodes: XNode[]): XNode[] {
    const unique = [...new Set(nodes)];
    if (unique.length < 2) return unique;
    const order = this.index();
    const key = (n: XNode): number => {
      const parent = parentOf(n);
      return order.get(n) ?? (parent ? order.get(parent) : undefined) ?? Number.MAX_SAFE_INTEGER;
    };
    return unique.sort((a, b) => key(a) - key(b));
  }
}

function rootOf(node: XNode): XNode {
  let root = node;
  for (let parent = parentOf(root); parent; parent = parentOf(parent)) {
    root = parent;
  }
  return root;
}

export function stringValue(n: XNode): string {
  switch (n.nodeType) {
    case ELEMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE:
      return String(n.textContent ?? "");
    case DOCUMENT_NODE: {
      let s = "";
      for (let c = firstChild(n); c; c = nextSibling(c)) {
        if (
          c.nodeType === ELEMENT_NODE ||
          c.nodeType === TEXT_NODE ||
          c.nodeType === CDATA_SECTION_NODE
        )
          s += c.textContent ?? "";
      }
      return s;
    }
    case ATTRIBUTE_NODE:
      return String(n.value ?? "");
    default:
      return String(n.nodeValue ?? n.data ?? "");
  }
}

function isNodeSet(v: Value): v is NodeSet {
  return Array.isArray(v);
}

function toBoolean(v: Value): boolean {
  if (isNodeSet(v)) return v.length > 0;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  return v;
}

function stringToNumber(s: string): number {
  return /^[\t\n\r ]*-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[\t\n\r ]*$/.test(s)
    ? Number(s.trim())
    : NaN;
}

function toNumber(v: Value): number {
  if (isNodeSet(v)) return stringToNumber(toStringValue(v));
  if (typeof v === "string") return stringToNumber(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function numberToString(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return "0";
  const s = String(x);
  if (!/e/i.test(s)) return s;
  const [mant, expStr] = s.toLowerCase().split("e") as [string, string];
  const neg = mant.startsWith("-");
  const digits = mant.replace(/^-/, "").replace(".", "");
  const intLen = (mant.replace(/^-/, "").split(".")[0] ?? "").length;
  const exp = Number(expStr) + intLen;
  let out: string;
  if (exp <= 0) out = "0." + "0".repeat(-exp) + digits;
  else if (exp >= digits.length) out = digits + "0".repeat(exp - digits.length);
  else out = digits.slice(0, exp) + "." + digits.slice(exp);
  return (neg ? "-" : "") + out;
}

function toStringValue(v: Value): string {
  if (isNodeSet(v)) return v.length ? stringValue(v[0]) : "";
  if (typeof v === "number") return numberToString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

function compareAtoms(op: string, a: Value, b: Value): boolean {
  if (op === "=" || op === "!=") {
    let eq: boolean;
    if (typeof a === "boolean" || typeof b === "boolean") eq = toBoolean(a) === toBoolean(b);
    else if (typeof a === "number" || typeof b === "number") eq = toNumber(a) === toNumber(b);
    else eq = toStringValue(a) === toStringValue(b);
    return op === "=" ? eq : !eq;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (op === "<") return x < y;
  if (op === "<=") return x <= y;
  if (op === ">") return x > y;
  return x >= y;
}

function compare(op: string, a: Value, b: Value): boolean {
  if (isNodeSet(a) && isNodeSet(b)) {
    const bs = b.map(stringValue);
    return a.some((n) => {
      const s = stringValue(n);
      return bs.some((t) => compareAtoms(op, s, t));
    });
  }
  if (isNodeSet(a) || isNodeSet(b)) {
    const set = (isNodeSet(a) ? a : b) as NodeSet;
    const other = (isNodeSet(a) ? b : a) as number | string | boolean;
    if (typeof other === "boolean")
      return isNodeSet(a)
        ? compareAtoms(op, toBoolean(set), other)
        : compareAtoms(op, other, toBoolean(set));
    return set.some((n) => {
      const s = typeof other === "number" ? stringToNumber(stringValue(n)) : stringValue(n);
      return isNodeSet(a) ? compareAtoms(op, s, other) : compareAtoms(op, other, s);
    });
  }
  return compareAtoms(op, a, b);
}

interface Ctx {
  node: XNode;
  pos: number;
  size: number;
  ev: Evaluation;
}

function nodeSetOf(v: Value): NodeSet {
  if (!isNodeSet(v)) throw new TypeError("The expression does not evaluate to a node-set.");
  return v;
}

function xpathRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x < 0 && x >= -0.5) return -0;
  return Math.floor(x + 0.5);
}

function localNameOf(n: XNode): string {
  const t = n.nodeType;
  if (t === ELEMENT_NODE || t === ATTRIBUTE_NODE) return String(n.localName ?? "");
  if (t === PROCESSING_INSTRUCTION_NODE) return String(n.target ?? "");
  return "";
}

function qualifiedNameOf(n: XNode): string {
  const t = n.nodeType;
  if (t === ELEMENT_NODE || t === ATTRIBUTE_NODE)
    return n.prefix ? `${n.prefix}:${n.localName}` : String(n.localName ?? "");
  if (t === PROCESSING_INSTRUCTION_NODE) return String(n.target ?? "");
  return "";
}

function firstOf(c: Ctx, args: Expr[]): XNode | null {
  if (!args.length) return c.node;
  const set = c.ev.sort(nodeSetOf(evaluate(arg(args, 0), c)));
  return set[0] ?? null;
}

function idLookup(c: Ctx, ids: string[]): NodeSet {
  const root = c.ev.root;
  const found: XNode[] = [];
  const wanted = new Set(ids.filter(Boolean));
  if (!wanted.size) return found;
  const walk = (n: XNode): void => {
    if (n.nodeType === ELEMENT_NODE) {
      const id = n.getAttribute?.("id");
      if (id !== null && id !== undefined && wanted.has(id)) {
        found.push(n);
        wanted.delete(id);
      }
    }
    for (let k = firstChild(n); k && wanted.size; k = nextSibling(k)) walk(k);
  };
  walk(root);
  return c.ev.sort(found);
}

interface Fn {
  arity: [number, number];
  run(c: Ctx, args: Expr[]): Value;
}

function arg(args: Expr[], i: number): Expr {
  const e = args[i];
  if (!e) throw new Error(`xpath: missing argument ${i}`);
  return e;
}

const str = (c: Ctx, args: Expr[], i: number): string => toStringValue(evaluate(arg(args, i), c));
const num = (c: Ctx, args: Expr[], i: number): number => toNumber(evaluate(arg(args, i), c));

const FUNCTIONS = new Map<string, Fn>(
  Object.entries<Fn>({
    last: { arity: [0, 0], run: (c) => c.size },
    position: { arity: [0, 0], run: (c) => c.pos },
    count: { arity: [1, 1], run: (c, a) => nodeSetOf(evaluate(arg(a, 0), c)).length },
    id: {
      arity: [1, 1],
      run: (c, a) => {
        const v = evaluate(arg(a, 0), c);
        const tokens = isNodeSet(v)
          ? v.flatMap((n) => stringValue(n).split(/[\t\n\r ]+/))
          : toStringValue(v).split(/[\t\n\r ]+/);
        return idLookup(c, tokens);
      },
    },
    "local-name": {
      arity: [0, 1],
      run: (c, a) => {
        const n = firstOf(c, a);
        return n ? localNameOf(n) : "";
      },
    },
    "namespace-uri": {
      arity: [0, 1],
      run: (c, a) => {
        const n = firstOf(c, a);
        return n && (n.nodeType === ELEMENT_NODE || n.nodeType === ATTRIBUTE_NODE)
          ? String(n.namespaceURI ?? "")
          : "";
      },
    },
    name: {
      arity: [0, 1],
      run: (c, a) => {
        const n = firstOf(c, a);
        return n ? qualifiedNameOf(n) : "";
      },
    },
    string: { arity: [0, 1], run: (c, a) => (a.length ? str(c, a, 0) : stringValue(c.node)) },
    concat: { arity: [2, Infinity], run: (c, a) => a.map((_, i) => str(c, a, i)).join("") },
    "starts-with": { arity: [2, 2], run: (c, a) => str(c, a, 0).startsWith(str(c, a, 1)) },
    contains: { arity: [2, 2], run: (c, a) => str(c, a, 0).includes(str(c, a, 1)) },
    "substring-before": {
      arity: [2, 2],
      run: (c, a) => {
        const s = str(c, a, 0);
        const i = s.indexOf(str(c, a, 1));
        return i < 0 ? "" : s.slice(0, i);
      },
    },
    "substring-after": {
      arity: [2, 2],
      run: (c, a) => {
        const s = str(c, a, 0);
        const t = str(c, a, 1);
        const i = s.indexOf(t);
        return i < 0 ? "" : s.slice(i + t.length);
      },
    },
    substring: {
      arity: [2, 3],
      run: (c, a) => {
        const chars = Array.from(str(c, a, 0));
        const start = xpathRound(num(c, a, 1));
        const end = a.length > 2 ? start + xpathRound(num(c, a, 2)) : Infinity;
        return chars.filter((_, i) => i + 1 >= start && i + 1 < end).join("");
      },
    },
    "string-length": {
      arity: [0, 1],
      run: (c, a) => Array.from(a.length ? str(c, a, 0) : stringValue(c.node)).length,
    },
    "normalize-space": {
      arity: [0, 1],
      run: (c, a) =>
        (a.length ? str(c, a, 0) : stringValue(c.node))
          .replace(/[\t\n\r ]+/g, " ")
          .replace(/^ | $/g, ""),
    },
    translate: {
      arity: [3, 3],
      run: (c, a) => {
        const from = Array.from(str(c, a, 1));
        const to = Array.from(str(c, a, 2));
        return Array.from(str(c, a, 0))
          .map((ch) => {
            const i = from.indexOf(ch);
            return i < 0 ? ch : (to[i] ?? "");
          })
          .join("");
      },
    },
    boolean: { arity: [1, 1], run: (c, a) => toBoolean(evaluate(arg(a, 0), c)) },
    not: { arity: [1, 1], run: (c, a) => !toBoolean(evaluate(arg(a, 0), c)) },
    true: { arity: [0, 0], run: () => true },
    false: { arity: [0, 0], run: () => false },
    lang: {
      arity: [1, 1],
      run: (c, a) => {
        const want = str(c, a, 0).toLowerCase();
        for (let n = isAttr(c.node) ? c.node.ownerElement : c.node; n; n = parentOf(n)) {
          if (n.nodeType !== ELEMENT_NODE) continue;
          const lang = n.getAttributeNS?.(XML_NS, "lang") ?? n.getAttribute?.("xml:lang");
          if (lang === null || lang === undefined) continue;
          const l = String(lang).toLowerCase();
          return l === want || l.startsWith(want + "-");
        }
        return false;
      },
    },
    number: {
      arity: [0, 1],
      run: (c, a) => (a.length ? num(c, a, 0) : stringToNumber(stringValue(c.node))),
    },
    sum: {
      arity: [1, 1],
      run: (c, a) =>
        nodeSetOf(evaluate(arg(a, 0), c)).reduce((s, n) => s + stringToNumber(stringValue(n)), 0),
    },
    floor: { arity: [1, 1], run: (c, a) => Math.floor(num(c, a, 0)) },
    ceiling: { arity: [1, 1], run: (c, a) => Math.ceil(num(c, a, 0)) },
    round: { arity: [1, 1], run: (c, a) => xpathRound(num(c, a, 0)) },
  }),
);

function filterByPredicates(nodes: XNode[], preds: Expr[], ev: Evaluation): XNode[] {
  let cur = nodes;
  for (const pred of preds) {
    const size = cur.length;
    cur = cur.filter((node, i) => {
      const v = evaluate(pred, { node, pos: i + 1, size, ev });
      return typeof v === "number" ? v === i + 1 : toBoolean(v);
    });
  }
  return cur;
}

function applyStep(step: Step, contexts: XNode[], ev: Evaluation): XNode[] {
  const out: XNode[] = [];
  for (const n of contexts) {
    const picked = axisNodes(step.axis, n).filter((m) => matches(step.test, step.axis, m));
    out.push(...filterByPredicates(picked, step.preds, ev));
  }
  if (contexts.length === 1) return REVERSE_AXES.has(step.axis) ? out.reverse() : out;
  return ev.sort(out);
}

function evaluate(e: Expr, c: Ctx): Value {
  switch (e.t) {
    case "num":
      return e.v;
    case "str":
      return e.v;
    case "fn": {
      const fn = FUNCTIONS.get(e.name);
      if (!fn) throw syntaxError(e.name);
      return fn.run(c, e.args);
    }
    case "or":
      return toBoolean(evaluate(e.l, c)) || toBoolean(evaluate(e.r, c));
    case "and":
      return toBoolean(evaluate(e.l, c)) && toBoolean(evaluate(e.r, c));
    case "cmp":
      return compare(e.op, evaluate(e.l, c), evaluate(e.r, c));
    case "arith": {
      const x = toNumber(evaluate(e.l, c));
      const y = toNumber(evaluate(e.r, c));
      if (e.op === "+") return x + y;
      if (e.op === "-") return x - y;
      if (e.op === "*") return x * y;
      if (e.op === "div") return x / y;
      return x % y;
    }
    case "neg":
      return -toNumber(evaluate(e.e, c));
    case "union":
      return c.ev.sort([...nodeSetOf(evaluate(e.l, c)), ...nodeSetOf(evaluate(e.r, c))]);
    case "filter":
      return filterByPredicates(c.ev.sort(nodeSetOf(evaluate(e.e, c))), e.preds, c.ev);
    case "path": {
      let nodes: XNode[];
      if (e.start === "root") nodes = [c.ev.root];
      else if (e.start === "context") nodes = [c.node];
      else nodes = c.ev.sort(nodeSetOf(evaluate(e.start, c)));
      for (const step of e.steps) nodes = applyStep(step, nodes, c.ev);
      return nodes;
    }
  }
}

function isNode(v: unknown): v is XNode {
  return !!v && typeof v === "object" && typeof (v as { nodeType?: unknown }).nodeType === "number";
}

const INTERNAL_CONSTRUCT = Symbol("kitesurfInternalConstruct");
const INTERNAL_REFILL = Symbol("kitesurfInternalRefill");
const xpathResultInstances = new WeakSet<object>();

function need(ok: boolean, what: string): void {
  if (!ok) throw new TypeError(`The result type is not ${what}.`);
}

export class XPathResult implements Idl.XPathResult {
  #type: number;
  #value: Value;
  #seq: number;
  #cursor = 0;

  constructor(token?: symbol, type = 0, value: Value = false) {
    if (token !== INTERNAL_CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#type = type;
    this.#value = value;
    this.#seq = getInternalState().treeSeq | 0;
    xpathResultInstances.add(this);
  }

  [INTERNAL_REFILL](type: number, value: Value): void {
    this.#type = type;
    this.#value = value;
    this.#cursor = 0;
    this.#seq = getInternalState().treeSeq | 0;
  }

  get resultType(): number {
    return this.#type;
  }

  get numberValue(): number {
    need(this.#type === RESULT_TYPES.NUMBER_TYPE, "a number");
    return this.#value as number;
  }

  get stringValue(): string {
    need(this.#type === RESULT_TYPES.STRING_TYPE, "a string");
    return this.#value as string;
  }

  get booleanValue(): boolean {
    need(this.#type === RESULT_TYPES.BOOLEAN_TYPE, "a boolean");
    return this.#value as boolean;
  }

  get singleNodeValue(): XNode | null {
    need(
      this.#type === RESULT_TYPES.ANY_UNORDERED_NODE_TYPE ||
        this.#type === RESULT_TYPES.FIRST_ORDERED_NODE_TYPE,
      "a single node",
    );
    return (this.#value as NodeSet)[0] ?? null;
  }

  get invalidIteratorState(): boolean {
    return (
      (this.#type === RESULT_TYPES.UNORDERED_NODE_ITERATOR_TYPE ||
        this.#type === RESULT_TYPES.ORDERED_NODE_ITERATOR_TYPE) &&
      (getInternalState().treeSeq | 0) !== this.#seq
    );
  }

  get snapshotLength(): number {
    need(
      this.#type === RESULT_TYPES.UNORDERED_NODE_SNAPSHOT_TYPE ||
        this.#type === RESULT_TYPES.ORDERED_NODE_SNAPSHOT_TYPE,
      "a snapshot",
    );
    return (this.#value as NodeSet).length;
  }

  iterateNext(): XNode | null {
    need(
      this.#type === RESULT_TYPES.UNORDERED_NODE_ITERATOR_TYPE ||
        this.#type === RESULT_TYPES.ORDERED_NODE_ITERATOR_TYPE,
      "an iterator",
    );
    if (this.invalidIteratorState)
      throw new DOMException(
        "The document has mutated since the result was returned.",
        "InvalidStateError",
      );
    return (this.#value as NodeSet)[this.#cursor++] ?? null;
  }

  snapshotItem(index: number): XNode | null {
    need(
      this.#type === RESULT_TYPES.UNORDERED_NODE_SNAPSHOT_TYPE ||
        this.#type === RESULT_TYPES.ORDERED_NODE_SNAPSHOT_TYPE,
      "a snapshot",
    );
    return (this.#value as NodeSet)[Number(index)] ?? null;
  }
}

function toXPathResultType(value: number): number {
  const number = +value;
  if (!Number.isFinite(number) || number === 0) return 0;
  const modulo = Math.trunc(number) % 0x1_0000;
  return (modulo + 0x1_0000) % 0x1_0000;
}

function makeResult(value: Value, type: number, reuse: XPathResult | null = null): XPathResult {
  let t = toXPathResultType(type);
  if (t === RESULT_TYPES.ANY_TYPE) {
    t = isNodeSet(value)
      ? RESULT_TYPES.UNORDERED_NODE_ITERATOR_TYPE
      : typeof value === "number"
        ? RESULT_TYPES.NUMBER_TYPE
        : typeof value === "string"
          ? RESULT_TYPES.STRING_TYPE
          : RESULT_TYPES.BOOLEAN_TYPE;
  }
  let resultValue: Value;
  if (t === RESULT_TYPES.NUMBER_TYPE) resultValue = toNumber(value);
  else if (t === RESULT_TYPES.STRING_TYPE) resultValue = toStringValue(value);
  else if (t === RESULT_TYPES.BOOLEAN_TYPE) resultValue = toBoolean(value);
  else {
    if (t < 0 || t > RESULT_TYPES.FIRST_ORDERED_NODE_TYPE)
      throw new DOMException("The result type is not supported.", "NotSupportedError");
    if (!isNodeSet(value))
      throw new TypeError(
        "The result is not a node set, and therefore cannot be converted to the desired type.",
      );
    resultValue = value;
  }
  if (reuse) {
    reuse[INTERNAL_REFILL](t, resultValue);
    return reuse;
  }
  return new XPathResult(INTERNAL_CONSTRUCT, t, resultValue);
}

function isXPathResult(value: unknown): value is XPathResult {
  return typeof value === "object" && value !== null && xpathResultInstances.has(value);
}

function reusableResult(value: unknown): XPathResult | null {
  if (value === null || value === undefined) return null;
  if (!isXPathResult(value)) throw new TypeError("The result is not an XPathResult.");
  return value;
}

export class XPathExpression implements Idl.XPathExpression {
  readonly #expr: Expr;

  constructor(token?: symbol, expr?: Expr) {
    if (token !== INTERNAL_CONSTRUCT || !expr) throw new TypeError("Illegal constructor");
    this.#expr = expr;
  }

  evaluate(contextNode: unknown, type = 0, result: unknown = null): XPathResult {
    if (!isNode(contextNode))
      throw new TypeError(
        "Failed to execute 'evaluate' on 'XPathExpression': parameter 1 is not of type 'Node'.",
      );
    const reuse = reusableResult(result);
    const ev = new Evaluation(rootOf(contextNode));
    const value = evaluate(this.#expr, { node: contextNode, pos: 1, size: 1, ev });
    return makeResult(isNodeSet(value) ? ev.sort(value) : value, type, reuse);
  }
}

export function createExpression(expression: unknown, resolver: Resolver = null): XPathExpression {
  return new XPathExpression(INTERNAL_CONSTRUCT, compile(String(expression), resolver));
}

export function evaluateXPath(
  expression: unknown,
  contextNode: unknown,
  resolver: Resolver = null,
  type = 0,
  result: unknown = null,
): XPathResult {
  reusableResult(result);
  return createExpression(expression, resolver).evaluate(contextNode, type, result);
}

export class XPathEvaluator implements Idl.XPathEvaluator {
  createExpression(expression: unknown, resolver: Resolver = null): XPathExpression {
    return createExpression(expression, resolver);
  }

  createNSResolver<T>(nodeResolver: T): T {
    return nodeResolver;
  }

  evaluate(
    expression: unknown,
    contextNode: unknown,
    resolver: Resolver = null,
    type = 0,
    result: unknown = null,
  ): XPathResult {
    return evaluateXPath(expression, contextNode, resolver, type, result);
  }
}

export const XPATH_RESULT_TYPES = RESULT_TYPES;
