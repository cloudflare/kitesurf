// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides bounded wasm-tree checks for document attachment and current child counts.

import { dom } from "../state.js";

const MAX_DOCUMENT_ATTACHMENT_ANCESTOR_HOPS = 64;
let cachedDocId: number = -1;

export function getDocId(): number {
  if (cachedDocId >= 0) return cachedDocId;
  try {
    cachedDocId = dom.documentNodeId();
  } catch {
    cachedDocId = -1;
  }
  return cachedDocId;
}

// Whether nodeId is reachable from the document root through parentId.
// The walk stops at a fixed bound so a corrupt parent chain can't
// loop forever.
export function isAttachedToDocument(nodeId: number): boolean {
  if (!isValidNodeId(nodeId)) return false;
  const docId = getDocId();
  if (docId < 0) return false;
  if (nodeId === docId) return true;
  return hasDocumentAncestor(nodeId, docId);
}

function hasDocumentAncestor(nodeId: number, docId: number): boolean {
  let cur = nodeId;
  for (let hops = 0; hops < MAX_DOCUMENT_ATTACHMENT_ANCESTOR_HOPS; hops++) {
    const parent = parentIdOrNull(cur);
    if (parent === null || parent < 0) return false;
    if (parent === docId) return true;
    cur = parent;
  }
  return false;
}

function isValidNodeId(nodeId: number): boolean {
  return typeof nodeId === "number" && nodeId >= 0;
}

function parentIdOrNull(nodeId: number): number | null {
  try {
    return dom.parentId(nodeId);
  } catch {
    return null;
  }
}

export function safeChildNodeCount(parentId: number): number {
  if (typeof parentId !== "number" || parentId < 0) return 0;
  try {
    const ids = dom.childIds(parentId);
    return ids ? ids.length : 0;
  } catch {
    return 0;
  }
}

// The child's previous sibling id, read from wasm after the mutation.
// 0 is CDP's "no previous sibling" value, also used when the child
// isn't found.
export function previousSiblingNodeId(parentId: number, childId: number): number {
  if (!isValidNodeId(parentId) || !isValidNodeId(childId)) return 0;
  try {
    const ids = dom.childIds(parentId);
    if (!ids) return 0;
    return precedingSibling(ids, childId);
  } catch {
    return 0;
  }
}

function precedingSibling(ids: ArrayLike<number>, childId: number): number {
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === childId) return i === 0 ? 0 : ids[i - 1];
  }
  return 0;
}
