// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies DOM operation-log entries and records direct mutations for CDP.

import type { RawCdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { DomHandle } from "../../core/pkg/kitesurf_core";
import { dom, ops, cdpMutations, type DomOperation } from "./state.js";
import { stampNamedGlobal } from "./window.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { isAttachedToDocument, safeChildNodeCount } from "./mutations/attached.js";
import { ksInternals } from "./internals.js";

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
    const value = op.value ?? "";
    if (!domSetAttr(op.node, op.name, value)) return;
    bumpMutationSeq({ attribute: op.name, node: op.node });
    if (op.name === "id") stampNamedGlobal(op.node, String(value));
    if (ksInternals.cdpDomActive) {
      cdpMutations.push({
        kind: "attributeModified",
        nodeId: op.node,
        name: op.name,
        value,
      });
    }
    return;
  }
  if (op.kind === "removeAttribute" && domRemoveAttr) {
    if (!domRemoveAttr(op.node, op.name)) return;
    bumpMutationSeq({ attribute: op.name, node: op.node });
    if (op.name === "id") stampNamedGlobal(op.node, "");
    if (ksInternals.cdpDomActive) {
      cdpMutations.push({
        kind: "attributeRemoved",
        nodeId: op.node,
        name: op.name,
      });
    }
    return;
  }
  let applied = 0;
  try {
    applied = dom.applyOps(JSON.stringify([op]));
  } catch (err) {
    const message =
      typeof err === "object" && err !== null && "message" in err ? err.message : undefined;
    const msg = message ? String(message) : String(err);
    throw new TypeError("kitesurf: mutation rejected: " + msg);
  }
  if (applied > 0) {
    ops.push(op);
    bumpMutationSeq();
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
        recordCdpMutationImpl({
          kind: "attributeRemoved",
          nodeId: op.node,
          name: op.name,
        });
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
        const parentId = op.kind === "appendChildHtml" ? op.parent : op.node;
        recordCdpMutationImpl({
          kind: "childNodeCountUpdated",
          nodeId: parentId,
          childNodeCount: safeChildNodeCount(parentId),
        });
        break;
    }
  }
}
/** Appends CDP mutations when enabled; structural events require an attached node. */
function recordCdpMutationImpl(event: RawCdpMutation): void {
  if (!ksInternals.cdpDomActive) return;
  const kind = event.kind;
  if (
    kind === "attributeModified" ||
    kind === "attributeRemoved" ||
    kind === "characterDataModified"
  ) {
    cdpMutations.push(event);
    return;
  }
  let probeId: number | null = null;
  if (kind === "childNodeInserted") {
    probeId = event.nodeId;
  } else if (kind === "childNodeRemoved" || kind === "childNodeCountUpdated") {
    probeId = (event as { parentNodeId?: number }).parentNodeId ?? event.nodeId;
  } else if (kind === "shadowRootPushed" || (kind as string) === "shadowRootPopped") {
    probeId = event.hostId;
  } else {
    probeId = (event as { nodeId: number }).nodeId;
  }
  if (typeof probeId !== "number" || !isAttachedToDocument(probeId)) {
    return;
  }
  cdpMutations.push(event);
}

export { recordOpImpl as recordOp, recordCdpMutationImpl as recordCdpMutation };
