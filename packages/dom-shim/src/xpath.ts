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
const OPERATOR_PREFIX_PUNCTUATION = new Set(["@", "::", "(", "[", ","]);
const NODE_TYPES = new Set(["comment", "text", "processing-instruction", "node"]);
const OPERATOR_NAMES = new Set(["and", "or", "mod", "div"]);
const STEP_START_TYPES = new Set<Tok["t"]>(["name", "type", "axis"]);
const STEP_START_PUNCTUATION = new Set(["@", ".", ".."]);

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

const NAME_START_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
];

function inCodePointRange(codePoint: number, [start, end]: readonly [number, number]): boolean {
  return codePoint >= start && codePoint <= end;
}

function isNameStart(codePoint: number): boolean {
  return (
    codePoint === 0x5f || NAME_START_RANGES.some((range) => inCodePointRange(codePoint, range))
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

function isNumberStart(source: string, index: number, current: string): boolean {
  return /[0-9]/.test(current) || (current === "." && /[0-9]/.test(source[index + 1] ?? ""));
}

function isDoubleOperator(value: string): boolean {
  return value === "//" || value === "!=" || value === "<=" || value === ">=";
}

function isOperatorPrefix(token: Tok): boolean {
  return token.t === "punct" && OPERATOR_PREFIX_PUNCTUATION.has(token.v);
}

function isXPathQuote(value: string): boolean {
  return value === '"' || value === "'";
}

function singleTokenType(value: string): "punct" | "op" | null {
  if ("().[]@,".includes(value)) return "punct";
  if ("/|+-=<>".includes(value)) return "op";
  return null;
}

class XPathLexer {
  private index = 0;
  private readonly tokens: Tok[] = [];

  constructor(private readonly source: string) {}

  tokenize(): Tok[] {
    while (this.index < this.source.length) this.readToken();
    this.tokens.push(EOF_TOKEN);
    return this.tokens;
  }

  private readToken(): void {
    const current = this.source.charAt(this.index);
    if (" \t\r\n".includes(current)) {
      this.index++;
      return;
    }
    if (isXPathQuote(current)) {
      this.readString(current);
      return;
    }
    if (isNumberStart(this.source, this.index, current)) {
      this.readNumber();
      return;
    }
    if (this.readPunctuationOrOperator(current)) return;
    this.readNameOrVariable(current);
  }

  private readNameOrVariable(current: string): void {
    if (current === "$") this.readVariable();
    else this.readNameOrOperator();
  }

  private readString(quote: string): void {
    const end = this.source.indexOf(quote, this.index + 1);
    if (end < 0) throw syntaxError(this.source);
    this.tokens.push({ t: "str", v: this.source.slice(this.index + 1, end) });
    this.index = end + 1;
  }

  private readNumber(): void {
    const match = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/.exec(this.source.slice(this.index));
    if (!match) throw syntaxError(this.source);
    this.tokens.push({ t: "num", v: match[0] });
    this.index += match[0].length;
  }

  private operatorMayFollow(): boolean {
    const previous = this.tokens[this.tokens.length - 1];
    if (!previous || previous.t === "op") return false;
    return !isOperatorPrefix(previous);
  }

  private readDoublePunctuation(value: string): boolean {
    if (value !== ".." && value !== "::") return false;
    this.tokens.push({ t: "punct", v: value });
    this.index += 2;
    return true;
  }

  private readAsterisk(): void {
    const token = this.operatorMayFollow()
      ? { t: "op" as const, v: "*" }
      : { t: "name" as const, v: "*" };
    this.tokens.push(token);
    this.index++;
  }

  private readPunctuationOrOperator(current: string): boolean {
    const two = this.source.slice(this.index, this.index + 2);
    if (this.readDoublePunctuation(two)) return true;
    if (isDoubleOperator(two)) {
      this.tokens.push({ t: "op", v: two });
      this.index += 2;
      return true;
    }
    const tokenType = singleTokenType(current);
    if (tokenType !== null) {
      this.tokens.push({ t: tokenType, v: current });
      this.index++;
      return true;
    }
    if (current === "*") {
      this.readAsterisk();
      return true;
    }
    return false;
  }

  private readCodePoint(): number {
    return this.source.codePointAt(this.index) ?? -1;
  }

  private advanceCodePoint(codePoint: number): void {
    this.index += codePoint > 0xffff ? 2 : 1;
  }

  private readNcName(): string {
    const start = this.index;
    const first = this.readCodePoint();
    if (!isNameStart(first)) throw syntaxError(this.source);
    this.advanceCodePoint(first);
    while (this.index < this.source.length) {
      const next = this.readCodePoint();
      if (!isNameChar(next)) break;
      this.advanceCodePoint(next);
    }
    return this.source.slice(start, this.index);
  }

  private readVariable(): void {
    this.index++;
    let name = this.readNcName();
    if (this.source[this.index] === ":" && this.source[this.index + 1] !== ":") {
      this.index++;
      name += ":" + this.readNcName();
    }
    this.tokens.push({ t: "var", v: name });
  }

  private readQualifiedName(name: string): string | null {
    if (this.source[this.index] !== ":" || this.source[this.index + 1] === ":") return name;
    this.index++;
    if (this.source[this.index] !== "*") return name + ":" + this.readNcName();
    this.index++;
    this.tokens.push({ t: "name", v: `${name}:*` });
    return null;
  }

  private readNameOrOperator(): void {
    let name = this.readNcName();
    if (this.operatorMayFollow()) {
      if (!OPERATOR_NAMES.has(name)) throw syntaxError(this.source);
      this.tokens.push({ t: "op", v: name });
      return;
    }
    name = this.readQualifiedName(name) ?? "";
    if (name) this.pushClassifiedName(name);
  }

  private pushClassifiedName(name: string): void {
    const next = this.peekNonSpace(this.index);
    if (this.source[next] === "(") {
      this.tokens.push({ t: NODE_TYPES.has(name) ? "type" : "fn", v: name });
      return;
    }
    if (this.source.slice(next, next + 2) === "::") {
      if (!AXES.has(name)) throw syntaxError(this.source);
      this.tokens.push({ t: "axis", v: name });
      return;
    }
    this.tokens.push({ t: "name", v: name });
  }

  private peekNonSpace(from: number): number {
    let index = from;
    while (index < this.source.length && " \t\r\n".includes(this.source.charAt(index))) index++;
    return index;
  }
}

function lex(src: string): Tok[] {
  return new XPathLexer(src).tokenize();
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

function startsStepToken(token: Tok): boolean {
  return (
    STEP_START_TYPES.has(token.t) || (token.t === "punct" && STEP_START_PUNCTUATION.has(token.v))
  );
}

function isLiteralPrimary(token: Tok): token is Tok & { t: "num" | "str" } {
  return token.t === "num" || token.t === "str";
}

function literalPrimary(token: Tok & { t: "num" | "str" }): Expr {
  if (token.t === "num") return { t: "num", v: Number(token.v) };
  return { t: "str", v: token.v };
}

function nodeTypeTestResult(name: string, target: string | null): NodeTest {
  if (name === "node") return { k: "node" };
  if (name === "text") return { k: "text" };
  if (name === "comment") return { k: "comment" };
  return { k: "pi", target };
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
    if (isLiteralPrimary(p)) return literalPrimary(p);
    if (p.t === "var") throw new DOMException(`Variable '$${p.v}' is not defined.`, "SyntaxError");
    if (p.t === "punct") return this.parenthesizedPrimary(p);
    if (p.t === "fn") return this.functionPrimary(p);
    throw syntaxError(this.src);
  }

  private parenthesizedPrimary(token: Tok): Expr {
    if (token.v !== "(") throw syntaxError(this.src);
    const expression = this.orExpr();
    this.expect("punct", ")");
    return expression;
  }

  private functionArguments(): Expr[] {
    if (this.is("punct", ")")) return [];
    const args = [this.orExpr()];
    while (this.is("punct", ",")) {
      this.next();
      args.push(this.orExpr());
    }
    return args;
  }

  private functionPrimary(token: Tok): Expr {
    const fn = FUNCTIONS.get(token.v);
    if (!fn) throw syntaxError(this.src);
    this.expect("punct", "(");
    const args = this.functionArguments();
    this.expect("punct", ")");
    const [min, max] = fn.arity;
    if (args.length < min || args.length > max) throw syntaxError(this.src);
    return { t: "fn", name: token.v, args };
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
    return startsStepToken(this.peek());
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
    if (p.t === "type") return this.typeNodeTest(p);
    if (p.t !== "name") throw syntaxError(this.src);
    return this.nameNodeTest(p.v);
  }

  private typeNodeTest(token: Tok): NodeTest {
    this.expect("punct", "(");
    const target = this.processingInstructionTarget(token);
    this.expect("punct", ")");
    return nodeTypeTestResult(token.v, target);
  }

  private processingInstructionTarget(token: Tok): string | null {
    if (token.v !== "processing-instruction" || !this.is("str")) return null;
    return this.next().v;
  }

  private nameNodeTest(name: string): NodeTest {
    if (name === "*") return { k: "any", ns: null };
    const colon = name.indexOf(":");
    if (colon < 0) return { k: "name", ns: null, local: name };
    const ns = resolvePrefix(this.resolver, name.slice(0, colon));
    const local = name.slice(colon + 1);
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

function childAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  for (let child = firstChild(node); child; child = nextSibling(child)) out.push(child);
  return out;
}

function descendantAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  descendants(node, out);
  return out;
}

function descendantOrSelfAxis(node: XNode): XNode[] {
  const out = [node];
  descendants(node, out);
  return out;
}

function parentAxis(node: XNode): XNode[] {
  const parent = parentOf(node);
  return parent ? [parent] : [];
}

function ancestorAxis(node: XNode, includeSelf: boolean): XNode[] {
  const out: XNode[] = [];
  if (includeSelf) out.push(node);
  for (let parent = parentOf(node); parent; parent = parentOf(parent)) out.push(parent);
  return out;
}

function followingSiblingAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  for (let sibling = nextSibling(node); sibling; sibling = nextSibling(sibling)) out.push(sibling);
  return out;
}

function precedingSiblingAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  for (let sibling = previousSibling(node); sibling; sibling = previousSibling(sibling))
    out.push(sibling);
  return out;
}

function addFollowingSiblings(node: XNode, out: XNode[]): void {
  for (let sibling = nextSibling(node); sibling; sibling = nextSibling(sibling)) {
    out.push(sibling);
    descendants(sibling, out);
  }
}

function followingAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  let ancestor: XNode | null | undefined = node;
  if (isAttr(node)) {
    ancestor = node.ownerElement;
    if (!ancestor) return out;
    descendants(ancestor, out);
  }
  for (; ancestor; ancestor = parentOf(ancestor)) addFollowingSiblings(ancestor, out);
  return out;
}

function addPrecedingSiblings(node: XNode, out: XNode[]): void {
  for (let sibling = previousSibling(node); sibling; sibling = previousSibling(sibling)) {
    descendantsReversed(sibling, out);
    out.push(sibling);
  }
}

function precedingAxis(node: XNode): XNode[] {
  const out: XNode[] = [];
  const start = isAttr(node) ? node.ownerElement : node;
  for (let ancestor = start; ancestor; ancestor = parentOf(ancestor)) {
    addPrecedingSiblings(ancestor, out);
  }
  return out;
}

const AXIS_HANDLERS: Record<Axis, (node: XNode) => XNode[]> = {
  self: (node) => [node],
  child: childAxis,
  descendant: descendantAxis,
  "descendant-or-self": descendantOrSelfAxis,
  parent: parentAxis,
  ancestor: (node) => ancestorAxis(node, false),
  "ancestor-or-self": (node) => ancestorAxis(node, true),
  "following-sibling": followingSiblingAxis,
  "preceding-sibling": precedingSiblingAxis,
  following: followingAxis,
  preceding: precedingAxis,
  attribute: attributesOf,
  namespace: () => [],
};

function axisNodes(axis: Axis, node: XNode): XNode[] {
  return AXIS_HANDLERS[axis](node);
}

function isHtmlDocumentNode(el: XNode | null | undefined): boolean {
  const doc = el?.ownerDocument;
  return !!doc && doc.contentType === "text/html";
}

type NamedNodeTest = Extract<NodeTest, { k: "name" | "any" }>;
type SpecialNodeTest = Exclude<NodeTest, NamedNodeTest>;

function isNamedNodeTest(test: NodeTest): test is NamedNodeTest {
  return test.k === "name" || test.k === "any";
}

function matchesProcessingInstruction(test: Extract<NodeTest, { k: "pi" }>, node: XNode): boolean {
  return (
    node.nodeType === PROCESSING_INSTRUCTION_NODE &&
    (test.target === null || node.target === test.target)
  );
}

function matchesSpecialNodeTest(test: SpecialNodeTest, node: XNode): boolean {
  if (test.k === "node") return true;
  if (test.k === "text") return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
  if (test.k === "comment") return node.nodeType === COMMENT_NODE;
  return matchesProcessingInstruction(test, node);
}

function matchesNamespace(test: NamedNodeTest, namespace: string | null): boolean {
  return test.ns === null || namespace === test.ns;
}

function matchesExactName(
  test: Extract<NodeTest, { k: "name" }>,
  node: XNode,
  ns: string | null,
): boolean {
  return node.localName === test.local && ns === test.ns;
}

function matchesHtmlAttributeOwner(
  test: Extract<NodeTest, { k: "name" }>,
  namespace: string | null,
  owner: XNode | null | undefined,
): boolean {
  return isUnprefixedAttributeName(test, namespace) && isHtmlAttributeOwner(owner);
}

function isUnprefixedAttributeName(
  test: Extract<NodeTest, { k: "name" }>,
  namespace: string | null,
): boolean {
  return test.ns === null && namespace === null;
}

function isHtmlAttributeOwner(owner: XNode | null | undefined): boolean {
  return Boolean(owner) && owner?.namespaceURI === HTML_NS && isHtmlDocumentNode(owner);
}

function matchesAttributeName(test: NamedNodeTest, node: XNode, namespace: string | null): boolean {
  if (test.k === "any") return matchesNamespace(test, namespace);
  if (matchesHtmlAttributeOwner(test, namespace, node.ownerElement)) {
    return asciiLowercase(String(node.localName)) === asciiLowercase(test.local);
  }
  return matchesExactName(test, node, namespace);
}

function matchesAttributeTest(test: NamedNodeTest, node: XNode): boolean {
  if (node.nodeType !== ATTRIBUTE_NODE) return false;
  return matchesAttributeName(test, node, node.namespaceURI ?? null);
}

function matchesHtmlElementName(
  test: Extract<NodeTest, { k: "name" }>,
  node: XNode,
  namespace: string | null,
): boolean {
  if (namespace !== HTML_NS) {
    return node.localName === test.local && test.ns !== null && namespace === test.ns;
  }
  return (
    asciiLowercase(String(node.localName)) === asciiLowercase(test.local) &&
    matchesNamespace(test, namespace)
  );
}

function matchesElementName(test: NamedNodeTest, node: XNode, namespace: string | null): boolean {
  if (test.k === "any") return matchesNamespace(test, namespace);
  if (!isHtmlDocumentNode(node)) return matchesExactName(test, node, namespace);
  return matchesHtmlElementName(test, node, namespace);
}

function matchesElementTest(test: NamedNodeTest, node: XNode): boolean {
  if (node.nodeType !== ELEMENT_NODE) return false;
  return matchesElementName(test, node, node.namespaceURI ?? null);
}

function matches(test: NodeTest, axis: Axis, node: XNode): boolean {
  if (!isNamedNodeTest(test)) return matchesSpecialNodeTest(test, node);
  if (axis === "attribute") return matchesAttributeTest(test, node);
  return matchesElementTest(test, node);
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

function isDocumentTextNode(node: XNode): boolean {
  return (
    node.nodeType === ELEMENT_NODE ||
    node.nodeType === TEXT_NODE ||
    node.nodeType === CDATA_SECTION_NODE
  );
}

function documentStringValue(node: XNode): string {
  let value = "";
  for (let child = firstChild(node); child; child = nextSibling(child)) {
    if (isDocumentTextNode(child)) value += child.textContent ?? "";
  }
  return value;
}

function isTextContentContainer(node: XNode): boolean {
  return node.nodeType === ELEMENT_NODE || node.nodeType === DOCUMENT_FRAGMENT_NODE;
}

function textContentStringValue(node: XNode): string {
  return String(node.textContent ?? "");
}

function attributeStringValue(node: XNode): string {
  return String(node.value ?? "");
}

function nodeStringValue(node: XNode): string {
  return String(node.nodeValue ?? node.data ?? "");
}

export function stringValue(n: XNode): string {
  if (isTextContentContainer(n)) return textContentStringValue(n);
  if (n.nodeType === DOCUMENT_NODE) return documentStringValue(n);
  if (n.nodeType === ATTRIBUTE_NODE) return attributeStringValue(n);
  return nodeStringValue(n);
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
  if (isNodeSet(v)) return nodeSetStringValue(v);
  if (typeof v === "number") return numberToString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

function nodeSetStringValue(nodes: NodeSet): string {
  return nodes.length ? stringValue(nodes[0]) : "";
}

function equalAtoms(a: Value, b: Value): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return toBoolean(a) === toBoolean(b);
  if (typeof a === "number" || typeof b === "number") return toNumber(a) === toNumber(b);
  return toStringValue(a) === toStringValue(b);
}

function compareEquality(op: string, a: Value, b: Value): boolean {
  const equal = equalAtoms(a, b);
  return op === "=" ? equal : !equal;
}

function compareOrdered(op: string, a: Value, b: Value): boolean {
  const left = toNumber(a);
  const right = toNumber(b);
  if (op === "<") return left < right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  return left >= right;
}

function compareAtoms(op: string, a: Value, b: Value): boolean {
  if (op === "=" || op === "!=") return compareEquality(op, a, b);
  return compareOrdered(op, a, b);
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
  if (isNameBearingNode(n)) return String(n.localName ?? "");
  if (n.nodeType === PROCESSING_INSTRUCTION_NODE) return String(n.target ?? "");
  return "";
}

function qualifiedNameOf(n: XNode): string {
  if (isNameBearingNode(n)) return qualifiedNameOfNameBearingNode(n);
  if (n.nodeType === PROCESSING_INSTRUCTION_NODE) return String(n.target ?? "");
  return "";
}

function isNameBearingNode(node: XNode): boolean {
  return node.nodeType === ELEMENT_NODE || node.nodeType === ATTRIBUTE_NODE;
}

function qualifiedNameOfNameBearingNode(node: XNode): string {
  return node.prefix ? `${node.prefix}:${node.localName}` : String(node.localName ?? "");
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
  const walk = (node: XNode): void => {
    if (node.nodeType === ELEMENT_NODE) {
      const id = node.getAttribute?.("id");
      if (id !== null && id !== undefined && wanted.has(id)) {
        found.push(node);
        wanted.delete(id);
      }
    }
    for (let child = firstChild(node); child && wanted.size; child = nextSibling(child)) {
      walk(child);
    }
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

function readElementLanguage(node: XNode): string | null | undefined {
  return node.getAttributeNS?.(XML_NS, "lang") ?? node.getAttribute?.("xml:lang");
}

function hasElementLanguage(language: string | null | undefined): language is string {
  return language !== null && language !== undefined;
}

function languageAtElement(node: XNode): string | null {
  if (node.nodeType !== ELEMENT_NODE) return null;
  const language = readElementLanguage(node);
  if (!hasElementLanguage(language)) return null;
  return String(language).toLowerCase();
}

function languageAncestorValue(context: XNode): string | null {
  for (let node = isAttr(context) ? context.ownerElement : context; node; node = parentOf(node)) {
    const language = languageAtElement(node);
    if (language !== null) return language;
  }
  return null;
}

function matchesLanguage(language: string, wanted: string): boolean {
  return language === wanted || language.startsWith(wanted + "-");
}

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
        const language = languageAncestorValue(c.node);
        return language !== null && matchesLanguage(language, want);
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

type LogicalExpr = Extract<Expr, { t: "or" | "and" }>;
type ArithmeticExpr = Extract<Expr, { t: "cmp" | "arith" | "neg" }>;
type SetPathExpr = Extract<Expr, { t: "union" | "filter" | "path" }>;
type CompoundExpr = Exclude<Expr, { t: "num" | "str" }>;

function evaluateFunction(expression: Extract<Expr, { t: "fn" }>, context: Ctx): Value {
  const fn = FUNCTIONS.get(expression.name);
  if (!fn) throw syntaxError(expression.name);
  return fn.run(context, expression.args);
}

function isLogicalExpr(expression: CompoundExpr): expression is LogicalExpr {
  return expression.t === "or" || expression.t === "and";
}

function evaluateLogical(expression: LogicalExpr, context: Ctx): boolean {
  if (expression.t === "or") {
    return toBoolean(evaluate(expression.l, context)) || toBoolean(evaluate(expression.r, context));
  }
  return toBoolean(evaluate(expression.l, context)) && toBoolean(evaluate(expression.r, context));
}

function isArithmeticExpr(expression: CompoundExpr): expression is ArithmeticExpr {
  return expression.t === "cmp" || expression.t === "arith" || expression.t === "neg";
}

function evaluateArithmeticOperation(
  expression: Extract<Expr, { t: "arith" }>,
  context: Ctx,
): number {
  const left = toNumber(evaluate(expression.l, context));
  const right = toNumber(evaluate(expression.r, context));
  if (expression.op === "+") return left + right;
  if (expression.op === "-") return left - right;
  if (expression.op === "*") return left * right;
  if (expression.op === "div") return left / right;
  return left % right;
}

function evaluateArithmetic(expression: ArithmeticExpr, context: Ctx): Value {
  if (expression.t === "cmp") {
    return compare(expression.op, evaluate(expression.l, context), evaluate(expression.r, context));
  }
  if (expression.t === "arith") return evaluateArithmeticOperation(expression, context);
  return -toNumber(evaluate(expression.e, context));
}

function evaluatePath(expression: Extract<Expr, { t: "path" }>, context: Ctx): NodeSet {
  let nodes: XNode[];
  if (expression.start === "root") nodes = [context.ev.root];
  else if (expression.start === "context") nodes = [context.node];
  else nodes = context.ev.sort(nodeSetOf(evaluate(expression.start, context)));
  for (const step of expression.steps) nodes = applyStep(step, nodes, context.ev);
  return nodes;
}

function evaluateSetPath(expression: SetPathExpr, context: Ctx): NodeSet {
  if (expression.t === "union") {
    return context.ev.sort([
      ...nodeSetOf(evaluate(expression.l, context)),
      ...nodeSetOf(evaluate(expression.r, context)),
    ]);
  }
  if (expression.t === "filter") {
    return filterByPredicates(
      context.ev.sort(nodeSetOf(evaluate(expression.e, context))),
      expression.preds,
      context.ev,
    );
  }
  return evaluatePath(expression, context);
}

function evaluateCompound(expression: CompoundExpr, context: Ctx): Value {
  if (expression.t === "fn") return evaluateFunction(expression, context);
  if (isLogicalExpr(expression)) return evaluateLogical(expression, context);
  if (isArithmeticExpr(expression)) return evaluateArithmetic(expression, context);
  return evaluateSetPath(expression, context);
}

function evaluate(expression: Expr, context: Ctx): Value {
  if (expression.t === "num") return expression.v;
  if (expression.t === "str") return expression.v;
  return evaluateCompound(expression, context);
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

function inferredResultType(value: Value): number {
  if (isNodeSet(value)) return RESULT_TYPES.UNORDERED_NODE_ITERATOR_TYPE;
  if (typeof value === "number") return RESULT_TYPES.NUMBER_TYPE;
  if (typeof value === "string") return RESULT_TYPES.STRING_TYPE;
  return RESULT_TYPES.BOOLEAN_TYPE;
}

function ensureSupportedNodeResultType(type: number): void {
  if (type < 0 || type > RESULT_TYPES.FIRST_ORDERED_NODE_TYPE) {
    throw new DOMException("The result type is not supported.", "NotSupportedError");
  }
}

function nodeSetResultValue(value: Value): NodeSet {
  if (!isNodeSet(value)) {
    throw new TypeError(
      "The result is not a node set, and therefore cannot be converted to the desired type.",
    );
  }
  return value;
}

function convertedResultValue(value: Value, type: number): Value {
  if (type === RESULT_TYPES.NUMBER_TYPE) return toNumber(value);
  if (type === RESULT_TYPES.STRING_TYPE) return toStringValue(value);
  if (type === RESULT_TYPES.BOOLEAN_TYPE) return toBoolean(value);
  ensureSupportedNodeResultType(type);
  return nodeSetResultValue(value);
}

function makeResult(value: Value, type: number, reuse: XPathResult | null = null): XPathResult {
  let resultType = toXPathResultType(type);
  if (resultType === RESULT_TYPES.ANY_TYPE) resultType = inferredResultType(value);
  const resultValue = convertedResultValue(value, resultType);
  if (reuse) {
    reuse[INTERNAL_REFILL](resultType, resultValue);
    return reuse;
  }
  return new XPathResult(INTERNAL_CONSTRUCT, resultType, resultValue);
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
