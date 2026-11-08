// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The nodes each DOM session was sent, so mutation events name only nodes the client knows
// and a node is described once its parent's children are.

import type { Protocol } from "devtools-protocol";
import type { SubtreeBudgetError } from "@kitesurf/jsrpc-types/query-dom";

import type { TargetState } from "./types.ts";

export function subtreeBudgetError(method: string, error: SubtreeBudgetError): Error {
  const nodes = error.nodesAtLeast ? `at least ${error.nodes} nodes` : `${error.nodes} nodes`;
  return new Error(
    `${method}: CDP subtree budget exceeded: ${nodes}, at least ${error.atLeastBytes} bytes, budget ${error.budget} bytes; use a smaller depth and DOM.requestChildNodes`,
  );
}

export class DomFrontendNodes {
  // Nodes the client was sent, and the subset whose children it was sent too.
  readonly #bound = new Set<number>();
  readonly #childrenSent = new Set<number>();

  hasDocument(): boolean {
    return this.#bound.size > 0;
  }

  isBound(nodeId: number): boolean {
    return this.#bound.has(nodeId);
  }

  childrenSent(nodeId: number): boolean {
    return this.#childrenSent.has(nodeId);
  }

  reset(): void {
    this.#bound.clear();
    this.#childrenSent.clear();
  }

  bindTree(root: Protocol.DOM.Node): void {
    const stack = [root];
    for (let node = stack.pop(); node; node = stack.pop()) {
      this.#bound.add(node.nodeId);
      if (node.children) {
        this.#childrenSent.add(node.nodeId);
        // A wide parent can exceed the argument limit of a spread call, and a
        // whole-tree read is allowed to reach that width.
        for (const child of node.children) stack.push(child);
      }
      if (node.shadowRoots) {
        for (const root of node.shadowRoots) stack.push(root);
      }
    }
  }

  bindChildren(parentId: number, children: Protocol.DOM.Node[]): void {
    this.#childrenSent.add(parentId);
    for (const child of children) this.bindTree(child);
  }

  // Descendants stay listed: ids are never reused, and a reinserted node is sent again.
  unbind(nodeId: number): void {
    this.#bound.delete(nodeId);
    this.#childrenSent.delete(nodeId);
  }
}

// Node ids belong to one PageScript document, so a new PageScript starts every session afresh.
const bySession = new WeakMap<
  TargetState,
  { pageScript: TargetState["pageScript"]; sessions: Map<string, DomFrontendNodes> }
>();

/** `sessionKey` is the session id, or "" for the browser-level connection. */
export function frontendNodes(target: TargetState, sessionKey: string): DomFrontendNodes {
  let entry = bySession.get(target);
  if (!entry || entry.pageScript !== target.pageScript) {
    entry = { pageScript: target.pageScript, sessions: new Map() };
    bySession.set(target, entry);
  }
  const sessions = entry.sessions;
  let nodes = sessions.get(sessionKey);
  if (!nodes) {
    nodes = new DomFrontendNodes();
    sessions.set(sessionKey, nodes);
  }
  return nodes;
}

export type SubtreeParams = { depth: number; pierce: boolean };

type SubtreeRequest = { depth?: number; pierce?: boolean } | undefined;

// Depth counts levels below the described node; a negative depth means all. getDocument
// stops at `<head>` and `<body>` so a large page stays small; getFlattenedDocument asks for all.
export const GET_DOCUMENT_DEPTH = 2;
export const GET_FLATTENED_DOCUMENT_DEPTH = -1;

function requestedDepth(params: SubtreeRequest, fallback: number): number {
  const depth = params?.depth ?? fallback;
  if (!Number.isInteger(depth)) throw new Error("Invalid parameters: depth must be an integer");
  return depth;
}

/** A document read's subtree; any depth is valid, 0 being the document alone. */
export function documentSubtree(params: SubtreeRequest, fallback: number): SubtreeParams {
  return { depth: requestedDepth(params, fallback), pierce: params?.pierce === true };
}

/** `DOM.requestChildNodes`'s subtree: depth 1 unless given; 0 would send no children. */
export function childNodesSubtree(params: SubtreeRequest): SubtreeParams {
  const depth = requestedDepth(params, 1);
  if (depth === 0 || depth < -1) {
    throw new Error("Please provide a positive integer as a depth or -1 for entire subtree");
  }
  return { depth, pierce: params?.pierce === true };
}

export function sessionKeyOf(sessionId: string | undefined): string {
  return typeof sessionId === "string" ? sessionId : "";
}
