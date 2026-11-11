// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds CDP frame metadata and computes frame origins and document domains.

import type { Protocol } from "devtools-protocol";
import { SANDBOX_ALLOW_ALL } from "@kitesurf/script-gate";
import { isIpHost, isPublicSuffix, siteKey } from "../public-suffix.ts";
import {
  makeTargetId,
  type FrameState,
  type SandboxRestrictions,
  type TargetState,
} from "./types.ts";

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
    if (!host || isIpHost(host) || !host.includes(".") || isPublicSuffix(host)) {
      return "";
    }
    return siteKey(host);
  } catch {
    return "";
  }
}

interface FrameOrigin {
  serialized: string;
  trustworthy: boolean;
  localhost: boolean;
  // Chrome's process-model site: the scheme plus the registrable domain, or the bare host when
  // there is none. Null for an opaque origin.
  site: string | null;
}

const OPAQUE_FRAME_ORIGIN: FrameOrigin = {
  serialized: "://",
  trustworthy: false,
  localhost: false,
  site: null,
};

// Page.Frame reports origins as Chrome serializes them, unlike originOf(): an opaque origin is
// "://" and a blob: URL has its creator's origin. Only https, wss and localhost are trustworthy.
function frameOriginOf(frame: FrameState): FrameOrigin {
  // A sandbox without allow-same-origin forces an opaque origin even for a same-origin URL.
  if (!frame.sandbox.sameOrigin) return OPAQUE_FRAME_ORIGIN;
  const url = frame.url || "about:blank";
  let serialized: string;
  let host: string;
  let protocol: string;
  try {
    serialized = new URL(url).origin;
    if (serialized === "null") return OPAQUE_FRAME_ORIGIN;
    const origin = new URL(serialized);
    host = origin.hostname.replace(/\.$/, "");
    protocol = origin.protocol;
  } catch {
    return OPAQUE_FRAME_ORIGIN;
  }
  const localhost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  const trustworthy = localhost || protocol === "https:" || protocol === "wss:";
  const site = `${protocol}//${domainAndRegistryOf(serialized) || host}`;
  return { serialized, trustworthy, localhost, site };
}

function inheritsCreatorOrigin(url: string): boolean {
  if (url === "") return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "about:" && (parsed.pathname === "blank" || parsed.pathname === "srcdoc")
    );
  } catch {
    return false;
  }
}

interface FrameContext {
  secureContextType: Protocol.Page.SecureContextType;
  crossOriginIsolatedContextType: Protocol.Page.CrossOriginIsolatedContextType;
  // Whether Chrome would keep the frame in its parent's process, so that its iframe element is
  // local to it.
  sameSiteAsParent: boolean;
}

// Every value depends on the chain: about:blank and srcdoc inherit their parent's origin, and an
// insecure ancestor or a cross-origin step (by default policy) carries to every frame below it.
function frameContextOf(frame: FrameState, frames: ReadonlyMap<string, FrameState>): FrameContext {
  const chain: FrameState[] = [];
  for (
    let current: FrameState | undefined = frame;
    current && !chain.includes(current);
    current = current.parentFrameId === null ? undefined : frames.get(current.parentFrameId)
  ) {
    chain.unshift(current);
  }
  let origin = OPAQUE_FRAME_ORIGIN;
  let site: string | null = null;
  let ancestorsSecure = true;
  let isolationAllowed = true;
  const context: FrameContext = {
    secureContextType: "InsecureScheme",
    crossOriginIsolatedContextType: "NotIsolated",
    sameSiteAsParent: false,
  };
  chain.forEach((current, depth) => {
    const parentOrigin = origin;
    const parentSite = site;
    const opaque = !current.sandbox.sameOrigin;
    const inherits = !opaque && depth > 0 && inheritsCreatorOrigin(current.url);
    if (!inherits) origin = frameOriginOf(current);
    // An opaque child (data:) shares its parent's process; a frame with a tuple origin goes to the
    // process of its own site.
    if (origin.site !== null) site = origin.site;
    if (depth > 0) {
      const sameOrigin =
        inherits || (origin.site !== null && origin.serialized === parentOrigin.serialized);
      isolationAllowed &&= sameOrigin && !opaque;
      context.sameSiteAsParent = !opaque && site === parentSite;
    }
    let type: Protocol.Page.SecureContextType;
    if (!origin.trustworthy) type = "InsecureScheme";
    else if (!ancestorsSecure) type = "InsecureAncestor";
    else type = origin.localhost ? "SecureLocalhost" : "Secure";
    context.secureContextType = type;
    ancestorsSecure &&= type === "Secure" || type === "SecureLocalhost";
  });
  context.crossOriginIsolatedContextType = isolationAllowed
    ? "NotIsolated"
    : "NotIsolatedFeatureDisabled";
  return context;
}

export function makeFrameInfo(
  frame: FrameState,
  frames: ReadonlyMap<string, FrameState>,
): Protocol.Page.Frame {
  const href = frame.url || "about:blank";
  const hash = href.indexOf("#");
  const url = hash < 0 ? href : href.slice(0, hash);
  const origin = frameOriginOf(frame);
  const context = frameContextOf(frame, frames);
  const info: Protocol.Page.Frame = {
    id: frame.frameId,
    loaderId: frame.loaderId,
    url,
    domainAndRegistry: domainAndRegistryOf(url),
    securityOrigin: origin.serialized,
    securityOriginDetails: { isLocalhost: origin.localhost },
    mimeType: frame.mimeType || "text/html",
    secureContextType: context.secureContextType,
    crossOriginIsolatedContextType: context.crossOriginIsolatedContextType,
    gatedAPIFeatures: [],
    // Chrome tracks ad evidence only for child frames, so only they carry an explanations list;
    // the main frame reports a bare adFrameType.
    adFrameStatus: frame.parentFrameId
      ? { adFrameType: "none", explanations: [] }
      : { adFrameType: "none" },
  };
  if (hash >= 0) {
    info.urlFragment = href.slice(hash);
  }
  if (frame.parentFrameId) {
    info.parentId = frame.parentFrameId;
    // Chrome falls back to the iframe's id only when that element lives in the frame's process,
    // which for an out-of-process frame it does not.
    const ownerId = context.sameSiteAsParent ? frame.ownerElementId : undefined;
    info.name = frame.name || ownerId || "";
  }
  return info;
}

// The tree below `root` (the main frame by default); a child frame's own session reports the tree
// rooted at it, as Chrome does for an out-of-process frame.
export function buildFrameTree(target: TargetState, root?: FrameState): Protocol.Page.FrameTree {
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
  let frames: ReadonlyMap<string, FrameState> = target.frames;
  if (!mainFrame) {
    const synthesized = makeMainFrameState({
      frameId: target.frameId,
      loaderId: target.loaderId,
      url: target.url,
    });
    mainFrame = synthesized;
    frames = new Map([...target.frames, [synthesized.frameId, synthesized]]);
  }

  function buildSubtree(frame: FrameState): Protocol.Page.FrameTree {
    const kids = childrenByParent.get(frame.frameId) ?? [];
    const node: Protocol.Page.FrameTree = { frame: makeFrameInfo(frame, frames) };
    if (kids.length > 0) {
      node.childFrames = kids.map(buildSubtree);
    }
    return node;
  }

  return buildSubtree(root ?? mainFrame);
}

export function buildFrameResourceTree(
  target: TargetState,
  root?: FrameState,
): Protocol.Page.FrameResourceTree {
  const tree = buildFrameTree(target, root);
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
    sandbox: SANDBOX_ALLOW_ALL,
    srcdoc: null,
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
    pageScriptUrl: null,
    lastRenderSeq: -1,
    execContextId: 0,
  };
}

export function makeChildFrameState(args: {
  frameId: string;
  parentFrameId: string;
  loaderId: string;
  url: string;
  sandbox?: SandboxRestrictions;
  srcdoc?: string | null;
  baseUrl?: string;
  name: string;
  ownerElementId: string;
  ownerBackendNodeId: number;
  isCrossOrigin: boolean;
  delaysLoadEvent: boolean;
}): FrameState {
  return {
    frameId: args.frameId,
    parentFrameId: args.parentFrameId,
    loaderId: args.loaderId,
    url: args.url,
    sandbox: args.sandbox ?? SANDBOX_ALLOW_ALL,
    srcdoc: args.srcdoc ?? null,
    baseUrl: args.baseUrl,
    name: args.name,
    ownerElementId: args.ownerElementId,
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
    pageScriptUrl: null,
    lastRenderSeq: -1,
    execContextId: 0,
  };
}
