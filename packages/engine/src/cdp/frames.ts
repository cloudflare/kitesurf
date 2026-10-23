// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds CDP frame metadata and computes frame origins and document domains.

import type { Protocol } from "devtools-protocol";
import { isIpHost, isPublicSuffix, siteKey } from "../public-suffix.ts";
import { makeTargetId, type FrameState, type TargetState } from "./types.ts";

export function mintFrameId(): string {
  return makeTargetId();
}

export function mintLoaderId(): string {
  return makeTargetId();
}

export function matchesAboutBlank(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "about:" && u.pathname === "blank";
  } catch {
    return false;
  }
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "://";
  }
}

export function domainAndRegistryOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (isInvalidDomainHost(host)) return "";
    return siteKey(host);
  } catch {
    return "";
  }
}

function isInvalidDomainHost(host: string): boolean {
  return !host || isIpHost(host) || !host.includes(".") || isPublicSuffix(host);
}

export function makeFrameInfo(frame: FrameState): Protocol.Page.Frame {
  const info: Protocol.Page.Frame = {
    id: frame.frameId,
    loaderId: frame.loaderId,
    url: frame.url || "about:blank",
    domainAndRegistry: domainAndRegistryOf(frame.url),
    securityOrigin: originOf(frame.url),
    mimeType: frame.mimeType || "text/html",
    secureContextType: "Secure",
    crossOriginIsolatedContextType: "NotIsolated",
    gatedAPIFeatures: [],
  };
  if (frame.parentFrameId) {
    info.parentId = frame.parentFrameId;
  }
  return info;
}

export function buildFrameTree(target: TargetState): Protocol.Page.FrameTree {
  const childrenByParent = new Map<string, FrameState[]>();
  let mainFrame: FrameState | undefined;
  for (const frame of target.frames.values()) {
    if (frame.parentFrameId === null) {
      mainFrame = frame;
    } else {
      let arr = childrenByParent.get(frame.parentFrameId);
      if (!arr) {
        arr = [];
        childrenByParent.set(frame.parentFrameId, arr);
      }
      arr.push(frame);
    }
  }
  if (!mainFrame) {
    mainFrame = makeMainFrameState({
      frameId: target.frameId,
      loaderId: target.loaderId,
      url: target.url,
    });
  }

  function buildSubtree(frame: FrameState): Protocol.Page.FrameTree {
    const kids = childrenByParent.get(frame.frameId) ?? [];
    const node: Protocol.Page.FrameTree = { frame: makeFrameInfo(frame) };
    if (kids.length > 0) {
      node.childFrames = kids.map(buildSubtree);
    }
    return node;
  }

  return buildSubtree(mainFrame);
}

export function buildFrameResourceTree(target: TargetState): Protocol.Page.FrameResourceTree {
  const tree = buildFrameTree(target);
  function decorate(node: Protocol.Page.FrameTree): Protocol.Page.FrameResourceTree {
    const out: Protocol.Page.FrameResourceTree = {
      frame: node.frame,
      resources: [],
    };
    if (node.childFrames) {
      out.childFrames = node.childFrames.map(decorate);
    }
    return out;
  }
  return decorate(tree);
}

export function makeMainFrameState(args: {
  frameId: string;
  loaderId: string;
  url: string;
}): FrameState {
  return {
    frameId: args.frameId,
    parentFrameId: null,
    loaderId: args.loaderId,
    url: args.url,
    securityOrigin: originOf(args.url),
    mimeType: "text/html",
    ownerBackendNodeId: -1,
    lifecycle: "init",
    detached: false,
    sessions: new Set(),
    dom: null,
    isCrossOrigin: false,
    hasScript: false,
    pendingLoad: null,
    delaysLoadEvent: true,
    readyState: "loading",
    pageScript: null,
    lastRenderSeq: -1,
    execContextId: 0,
  };
}

export function makeChildFrameState(args: {
  frameId: string;
  parentFrameId: string;
  loaderId: string;
  url: string;
  ownerBackendNodeId: number;
  isCrossOrigin: boolean;
  delaysLoadEvent: boolean;
}): FrameState {
  return {
    frameId: args.frameId,
    parentFrameId: args.parentFrameId,
    loaderId: args.loaderId,
    url: args.url,
    securityOrigin: originOf(args.url),
    mimeType: "text/html",
    ownerBackendNodeId: args.ownerBackendNodeId,
    lifecycle: "init",
    detached: false,
    sessions: new Set(),
    dom: null,
    isCrossOrigin: args.isCrossOrigin,
    hasScript: args.isCrossOrigin,
    pendingLoad: null,
    delaysLoadEvent: args.delaysLoadEvent,
    readyState: "loading",
    pageScript: null,
    lastRenderSeq: -1,
    execContextId: 0,
  };
}
