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
  // Nodes the client was sent, the subset whose children it was sent too, and the child ids each
  // of those was sent with, so a removal or a move can unbind the whole subtree.
  readonly #bound = new Set<number>();
  readonly #childrenSent = new Set<number>();
  readonly #children = new Map<number, number[]>();
  // Every id sent under a node, including shadow roots, and the owner of each.
  readonly #owned = new Map<number, number[]>();
  readonly #parentOf = new Map<number, number>();

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
    this.#children.clear();
    this.#owned.clear();
    this.#parentOf.clear();
  }

  #addOwned(ownerId: number, nodeId: number): void {
    const owned = this.#owned.get(ownerId);
    if (owned) {
      if (!owned.includes(nodeId)) owned.push(nodeId);
    } else {
      this.#owned.set(ownerId, [nodeId]);
    }
  }

  bindTree(root: Protocol.DOM.Node, ownerId?: number): void {
    const stack: Array<{ node: Protocol.DOM.Node; owner: number | undefined }> = [
      { node: root, owner: ownerId },
    ];
    for (let item = stack.pop(); item; item = stack.pop()) {
      const { node, owner } = item;
      this.#bound.add(node.nodeId);
      if (owner !== undefined) {
        this.#parentOf.set(node.nodeId, owner);
        this.#addOwned(owner, node.nodeId);
      }
      if (node.children) {
        this.#childrenSent.add(node.nodeId);
        this.#children.set(
          node.nodeId,
          node.children.map((child) => child.nodeId),
        );
        // A wide parent can exceed the argument limit of a spread call, and a
        // whole-tree read is allowed to reach that width.
        for (const child of node.children) stack.push({ node: child, owner: node.nodeId });
      }
      if (node.shadowRoots) {
        for (const shadow of node.shadowRoots) stack.push({ node: shadow, owner: node.nodeId });
      }
    }
  }

  bindChildren(parentId: number, children: Protocol.DOM.Node[]): void {
    // `DOM.setChildNodes` replaces the parent's previous children on the client.
    this.unbindChildren(parentId);
    this.#childrenSent.add(parentId);
    this.#children.set(
      parentId,
      children.map((child) => child.nodeId),
    );
    for (const child of children) this.bindTree(child, parentId);
  }

  noteInserted(parentId: number, node: Protocol.DOM.Node): void {
    this.unbind(node.nodeId);
    this.bindTree(node, parentId);
    const children = this.#children.get(parentId);
    if (children && !children.includes(node.nodeId)) children.push(node.nodeId);
  }

  noteRemoved(parentId: number, nodeId: number): void {
    const children = this.#children.get(parentId);
    if (children) {
      const at = children.indexOf(nodeId);
      if (at >= 0) children.splice(at, 1);
    }
    this.unbind(nodeId);
  }

  unbindChildren(parentId: number): void {
    const children = this.#children.get(parentId);
    if (children) {
      this.#children.delete(parentId);
      for (const child of [...children]) this.unbind(child);
    }
    const owned = this.#owned.get(parentId);
    if (owned) {
      for (const nodeId of [...owned]) this.unbind(nodeId);
    }
  }

  // A removal, or a move, drops the whole subtree the client was sent under this node.
  unbind(nodeId: number): void {
    const stack = [nodeId];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const owner = this.#parentOf.get(id);
      if (owner !== undefined) {
        this.#parentOf.delete(id);
        const owned = this.#owned.get(owner);
        if (owned) {
          const at = owned.indexOf(id);
          if (at >= 0) owned.splice(at, 1);
        }
      }
      this.#bound.delete(id);
      this.#childrenSent.delete(id);
      const children = this.#children.get(id);
      if (children) {
        this.#children.delete(id);
        for (const child of children) stack.push(child);
      }
      const owned = this.#owned.get(id);
      if (owned) {
        this.#owned.delete(id);
        for (const child of owned) stack.push(child);
      }
    }
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
