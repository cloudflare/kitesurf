// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies DOM operation-log entries and records direct mutations for CDP.

import type { RawCdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { DomHandle } from "../../core/pkg/kitesurf_core";
import { ksGlobal, dom, ops, cdpMutations, type DomOperation } from "./state.js";
import { stampNamedGlobal } from "./window.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { isAttachedToDocument, safeChildNodeCount } from "./mutations/attached.js";

// Bound on first use because `dom` is still null at module load.
let domSetAttr: DomHandle["setAttribute"] | null = null;
let domRemoveAttr: DomHandle["removeAttribute"] | null = null;
let attrFnsBound = false;
function bindAttrFns() {
  if (attrFnsBound) return;
  attrFnsBound = true;
  domSetAttr = typeof dom.setAttribute === "function" ? dom.setAttribute.bind(dom) : null;
  domRemoveAttr = typeof dom.removeAttribute === "function" ? dom.removeAttribute.bind(dom) : null;
}

/** Applies a queued operation; direct node methods record structural CDP events separately. */
function recordOpImpl(op: DomOperation): void {
  bindAttrFns();
  if (op.kind === "setAttribute" && domSetAttr) {
    recordSetAttribute(op, domSetAttr);
    return;
  }
  if (op.kind === "removeAttribute" && domRemoveAttr) {
    recordRemoveAttribute(op, domRemoveAttr);
    return;
  }
  applyGenericOperation(op);
}

function recordSetAttribute(
  op: Extract<DomOperation, { kind: "setAttribute" }>,
  setAttribute: DomHandle["setAttribute"],
): void {
  const value = op.value ?? "";
  if (!setAttribute(op.node, op.name, value)) return;
  bumpMutationSeq({ attribute: op.name, node: op.node });
  if (op.name === "id") stampNamedGlobal(op.node, String(value));
  if (ksGlobal.__ks_cdpDomActive) {
    cdpMutations.push({ kind: "attributeModified", nodeId: op.node, name: op.name, value });
  }
}

function recordRemoveAttribute(
  op: Extract<DomOperation, { kind: "removeAttribute" }>,
  removeAttribute: DomHandle["removeAttribute"],
): void {
  if (!removeAttribute(op.node, op.name)) return;
  bumpMutationSeq({ attribute: op.name, node: op.node });
  if (op.name === "id") stampNamedGlobal(op.node, "");
  if (ksGlobal.__ks_cdpDomActive) {
    cdpMutations.push({ kind: "attributeRemoved", nodeId: op.node, name: op.name });
  }
}

function applyGenericOperation(op: DomOperation): void {
  let applied = 0;
  try {
    applied = dom.applyOps(JSON.stringify([op]));
  } catch (err) {
    throw mutationRejected(err);
  }
  if (applied > 0) {
    ops.push(op);
    bumpMutationSeq();
    recordAppliedOperation(op);
  }
}

function mutationRejected(err: unknown): TypeError {
  const message =
    typeof err === "object" && err !== null && "message" in err ? err.message : undefined;
  const msg = message ? String(message) : String(err);
  return new TypeError("kitesurf: mutation rejected: " + msg);
}

function recordAppliedOperation(op: DomOperation): void {
  switch (op.kind) {
    case "setAttribute":
      recordCdpMutationImpl({
        kind: "attributeModified",
        nodeId: op.node,
        name: op.name,
        value: op.value ?? "",
      });
      break;
    case "removeAttribute":
      recordCdpMutationImpl({ kind: "attributeRemoved", nodeId: op.node, name: op.name });
      break;
    case "setNodeText":
      recordCdpMutationImpl({
        kind: "characterDataModified",
        nodeId: op.node,
        characterData: op.text ?? "",
      });
      break;
    case "appendChildHtml":
    case "setInnerHtml":
      recordChildNodeCount(op);
      break;
  }
}

function recordChildNodeCount(
  op: Extract<DomOperation, { kind: "appendChildHtml" | "setInnerHtml" }>,
): void {
  const parentId = op.kind === "appendChildHtml" ? op.parent : op.node;
  recordCdpMutationImpl({
    kind: "childNodeCountUpdated",
    nodeId: parentId,
    childNodeCount: safeChildNodeCount(parentId),
  });
}
/** Appends CDP mutations when enabled; structural events require an attached node. */
function recordCdpMutationImpl(event: RawCdpMutation): void {
  if (!ksGlobal.__ks_cdpDomActive) return;
  if (isSimpleMutation(event)) {
    cdpMutations.push(event);
    return;
  }
  const probeId = mutationProbeId(event);
  if (typeof probeId !== "number" || !isAttachedToDocument(probeId)) {
    return;
  }
  cdpMutations.push(event);
}

function isSimpleMutation(
  event: RawCdpMutation,
): event is Extract<
  RawCdpMutation,
  { kind: "attributeModified" | "attributeRemoved" | "characterDataModified" }
> {
  return (
    event.kind === "attributeModified" ||
    event.kind === "attributeRemoved" ||
    event.kind === "characterDataModified"
  );
}

function mutationProbeId(event: RawCdpMutation): number | null {
  if (event.kind === "childNodeInserted") return event.nodeId;
  if (isChildNodeRemoval(event)) return childMutationProbeId(event);
  const hostId = shadowRootMutationHostId(event);
  if (hostId !== null) return hostId;
  return (event as { nodeId: number }).nodeId;
}

function isChildNodeRemoval(
  event: RawCdpMutation,
): event is Extract<RawCdpMutation, { kind: "childNodeRemoved" | "childNodeCountUpdated" }> {
  return event.kind === "childNodeRemoved" || event.kind === "childNodeCountUpdated";
}

function childMutationProbeId(
  event: Extract<RawCdpMutation, { kind: "childNodeRemoved" | "childNodeCountUpdated" }>,
): number {
  return (event as { parentNodeId?: number }).parentNodeId ?? event.nodeId;
}

function shadowRootMutationHostId(event: RawCdpMutation): number | null {
  if (event.kind === "shadowRootPushed") return event.hostId;
  if ((event.kind as string) !== "shadowRootPopped") return null;
  const hostId: unknown = Reflect.get(event, "hostId");
  return typeof hostId === "number" ? hostId : null;
}

export { recordOpImpl as recordOp, recordCdpMutationImpl as recordCdpMutation };
