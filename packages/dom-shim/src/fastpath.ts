// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Rust shares these fast-path bits; only canonical wrappers are branded.
// revalidate runs under with_v8_quiet and must use captured intrinsics only.
import type { NodeBase } from "./node-base.js";
import {
  dom,
  nodeFor,
  nodePeek,
  DOCUMENT_ID,
  fastpathMarkSpecial,
  type FastpathHost,
} from "./state.js";
import { ELEMENT_NODE } from "./constants.js";
import { Element } from "./element/index.js";
import { makeStaticNodeList } from "./collections.js";

const gopd = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const MAX_DEPENDENCY_CLOSURE_PASSES = 4;
const MAX_PROTOTYPE_CHAIN_HOPS = 16;

const WATCHED: Array<[number, string]> = [
  [0, "getAttribute"],
  [1, "hasAttribute"],
  [2, "tagName"],
  [3, "nodeName"],
  [4, "nodeType"],
  [5, "id"],
  [6, "className"],
  [7, "contains"],
  [8, "parentNode"],
  [9, "parentElement"],
  [10, "firstChild"],
  [11, "lastChild"],
  [12, "nextSibling"],
  [13, "previousSibling"],
  [14, "nextElementSibling"],
  [15, "previousElementSibling"],
  [16, "childNodes"],
  [17, "querySelector"],
  [18, "querySelectorAll"],
  [19, "matches"],
  [20, "closest"],
];

// Document ops, walked from the document object itself: a page that assigns
// document.getElementById = ... shadows it on the instance, not a prototype.
const WATCHED_DOC: Array<[number, string]> = [
  [21, "getElementById"],
  [22, "querySelector"],
  [23, "querySelectorAll"],
  [24, "body"],
  [25, "head"],
];

const DEPS: Array<[number, number[]]> = [
  [0, [1, 5, 6]],
  [2, [3]],
  [4, [9, 14, 15]],
  [8, [9, 12, 13, 14, 15]],
  [16, [10, 11, 12, 13, 14, 15]],
];

function closeOverDeps(mask: number): number {
  let out = mask;
  for (let pass = 0; pass < MAX_DEPENDENCY_CLOSURE_PASSES; pass++) {
    let next = out;
    for (const [dep, dependents] of DEPS) {
      if (next & (1 << dep)) {
        for (const d of dependents) next |= 1 << d;
      }
    }
    if (next === out) break;
    out = next;
  }
  return out >>> 0;
}

interface Baseline {
  holder: object;
  kind: "data" | "accessor";
  fn: unknown;
}

function findHolder(
  prop: string,
  root: object = Element.prototype,
): { holder: object; desc: PropertyDescriptor } | null {
  let o: object | null = root;
  let guard = 0;
  while (o && guard++ < MAX_PROTOTYPE_CHAIN_HOPS) {
    const desc = gopd(o, prop);
    if (desc) return { holder: o, desc };
    o = getProto(o);
  }
  return null;
}

export function installFastpath(document: object): void {
  const d = dom as FastpathHost | null;
  if (!d || typeof d.fastpathBind !== "function") return;

  const base = new Map<number, Baseline>();
  let installMask = 0;
  const watched: Array<[number, string, object]> = [
    ...WATCHED.map(([bit, prop]): [number, string, object] => [bit, prop, Element.prototype]),
    ...WATCHED_DOC.map(([bit, prop]): [number, string, object] => [bit, prop, document]),
  ];
  for (const [bit, prop, root] of watched) {
    const found = findHolder(prop, root);
    if (!found) {
      installMask |= 1 << bit;
      continue;
    }
    base.set(bit, {
      holder: found.holder,
      kind: found.desc.get ? "accessor" : "data",
      fn: found.desc.get ?? found.desc.value,
    });
  }

  const brand = (obj: unknown): number => {
    // The document brands as its own id; wasm offers it only the document
    // ops, since every node op bails on it (it is marked special below).
    if (obj === document) return DOCUMENT_ID;
    try {
      const el = obj as { _id?: unknown; nodeType?: unknown; ownerDocument?: unknown } | null;
      const id = el?._id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return -1;
      if (nodeFor(id) !== obj) return -1;
      if (el!.nodeType !== ELEMENT_NODE) return -1;
      if (el!.ownerDocument !== document) return -1;
      return id;
    } catch {
      return -1;
    }
  };

  // Per op, the watched props its answer depends on: its own and every prop whose
  // dependency closure reaches it (firstChild needs childNodes). Built at install.
  const needs: Array<Array<[number, string, object]>> = [];
  for (let op = 0; op < 32; op++) {
    needs.push(watched.filter(([bit]) => (closeOverDeps(1 << bit) & (1 << op)) !== 0));
  }

  // SAFETY: with_v8_quiet cannot re-arm the V8 boundary; use captured intrinsics
  // and never invoke page code from this callback.
  const revalidate = (op?: number): number => {
    let mask = installMask;
    try {
      for (const [bit, prop, root] of op === undefined ? watched : (needs[op] ?? watched)) {
        const b = base.get(bit);
        if (!b) continue; // already in installMask
        const found = findHolder(prop, root);
        if (
          !found ||
          found.holder !== b.holder ||
          (found.desc.get ? "accessor" : "data") !== b.kind ||
          (found.desc.get ?? found.desc.value) !== b.fn
        ) {
          mask |= 1 << bit;
        }
      }
    } catch {
      return 0xffffffff;
    }
    return closeOverDeps(mask);
  };

  const wrapperForNodeId = (nid: number): unknown => {
    try {
      return nodeFor(nid) ?? null;
    } catch {
      return null;
    }
  };

  // Pure (see nodePeek), so wasm calls it without re-arming revalidation; a
  // miss falls back to wrapperForNodeId, which can run page code.
  const peek = (nid: number): unknown => {
    try {
      return nodePeek(nid) ?? null;
    } catch {
      return null;
    }
  };
  // querySelectorAll's own construction, so the NodeList class and the
  // wrappers in it are the ones the slow path returns.
  const nodeList = (ids: number[]): unknown =>
    makeStaticNodeList(ids.map((id) => nodeFor(id)).filter((n): n is NodeBase => n !== null));

  try {
    d.fastpathBind(brand, revalidate, wrapperForNodeId, peek, nodeList);
  } catch {
    return;
  }
  fastpathMarkSpecial(DOCUMENT_ID);
}
