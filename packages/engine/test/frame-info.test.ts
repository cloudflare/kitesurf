// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import { describe, expect, it } from "vitest";

import { buildFrameTree, makeChildFrameState, makeMainFrameState } from "../src/cdp/frames.ts";
import type { FrameState, TargetState } from "../src/cdp/types.ts";

// Expected values are Chrome 152's Page.getFrameTree for the same documents, with frame and loader
// ids removed. Cross-site iframes are absent there (they are separate targets), so none appear.

const MAIN_AD_STATUS = { adFrameType: "none" };
const CHILD_AD_STATUS = { adFrameType: "none", explanations: [] };
const NOT_ISOLATED = { crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] };

interface ChildSpec {
  url: string;
  name?: string;
  id?: string;
  // Index of the parent among the earlier children; children without one hang off the main
  // frame.
  parent?: number;
}

function target(url: string, children: ChildSpec[] = []): TargetState {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url });
  const frames = new Map<string, FrameState>([[main.frameId, main]]);
  children.forEach((child, index) => {
    const frame = makeChildFrameState({
      frameId: `child-${index}`,
      parentFrameId: child.parent === undefined ? main.frameId : `child-${child.parent}`,
      loaderId: `child-loader-${index}`,
      url: child.url,
      name: child.name ?? "",
      ownerElementId: child.id ?? "",
      ownerBackendNodeId: -1,
      isCrossOrigin: false,
      delaysLoadEvent: true,
    });
    frames.set(frame.frameId, frame);
  });
  return { frameId: main.frameId, loaderId: main.loaderId, url, frames } as TargetState;
}

function withoutIds(tree: Protocol.Page.FrameTree): unknown {
  const { id: _id, loaderId: _loaderId, parentId: _parentId, ...frame } = tree.frame;
  return {
    frame,
    ...(tree.childFrames ? { childFrames: tree.childFrames.map(withoutIds) } : {}),
  };
}

describe("Page.getFrameTree frame metadata", () => {
  it("matches Chrome for a new tab's about:blank", () => {
    expect(withoutIds(buildFrameTree(target("about:blank")))).toEqual({
      frame: {
        url: "about:blank",
        domainAndRegistry: "",
        securityOrigin: "://",
        securityOriginDetails: { isLocalhost: false },
        mimeType: "text/html",
        adFrameStatus: MAIN_AD_STATUS,
        secureContextType: "InsecureScheme",
        ...NOT_ISOLATED,
      },
    });
  });

  it("matches Chrome for a secure page with same-origin and inheriting children", () => {
    const tree = buildFrameTree(
      target("https://a.example:9443/top?x=1#top", [
        { url: "https://a.example:9443/c#frag", name: "named" },
        { url: "https://a.example:9443/c" },
        { url: "about:blank" },
        { url: "about:srcdoc" },
      ]),
    );
    const secureChild = {
      domainAndRegistry: "a.example",
      securityOrigin: "https://a.example:9443",
      securityOriginDetails: { isLocalhost: false },
      mimeType: "text/html",
      adFrameStatus: CHILD_AD_STATUS,
      secureContextType: "Secure",
      ...NOT_ISOLATED,
    };
    const inheritingChild = {
      ...secureChild,
      domainAndRegistry: "",
      securityOrigin: "://",
    };
    expect(withoutIds(tree)).toEqual({
      frame: {
        url: "https://a.example:9443/top?x=1",
        urlFragment: "#top",
        domainAndRegistry: "a.example",
        securityOrigin: "https://a.example:9443",
        securityOriginDetails: { isLocalhost: false },
        mimeType: "text/html",
        adFrameStatus: MAIN_AD_STATUS,
        secureContextType: "Secure",
        ...NOT_ISOLATED,
      },
      childFrames: [
        {
          frame: {
            name: "named",
            url: "https://a.example:9443/c",
            urlFragment: "#frag",
            ...secureChild,
          },
        },
        { frame: { name: "", url: "https://a.example:9443/c", ...secureChild } },
        { frame: { name: "", url: "about:blank", ...inheritingChild } },
        { frame: { name: "", url: "about:srcdoc", ...inheritingChild } },
      ],
    });
    for (const child of tree.childFrames ?? []) {
      expect(child.frame.parentId).toBe(tree.frame.id);
    }
  });

  it("matches Chrome's secure context types on insecure and localhost pages", () => {
    const insecure = buildFrameTree(target("http://a.example:9080/top", [{ url: "about:blank" }]));
    expect(insecure.frame.secureContextType).toBe("InsecureScheme");
    expect(insecure.childFrames?.[0]?.frame.secureContextType).toBe("InsecureScheme");

    const local = buildFrameTree(
      target("http://localhost:9080/ids", [
        { url: "data:text/html,d" },
        { url: "blob:http://localhost:9080/dde0a249-fc18-416f-95c9-619042dcdeac" },
      ]),
    );
    expect(local.frame).toMatchObject({
      securityOrigin: "http://localhost:9080",
      securityOriginDetails: { isLocalhost: true },
      secureContextType: "SecureLocalhost",
    });
    expect(local.childFrames?.map((child) => child.frame)).toMatchObject([
      {
        securityOrigin: "://",
        securityOriginDetails: { isLocalhost: false },
        secureContextType: "InsecureScheme",
      },
      {
        securityOrigin: "http://localhost:9080",
        securityOriginDetails: { isLocalhost: true },
        secureContextType: "SecureLocalhost",
      },
    ]);
  });

  it("reports a secure frame under an insecure parent as InsecureAncestor", () => {
    const tree = buildFrameTree(target("http://a.example/", [{ url: "https://a.example/c" }]));
    expect(tree.childFrames?.[0]?.frame.secureContextType).toBe("InsecureAncestor");
  });

  it("falls back to the iframe's id only for a frame Chrome keeps in its parent's process", () => {
    const tree = buildFrameTree(
      target("http://a.example:9080/", [
        { url: "http://sub.a.example:9080/c", id: "samesite" },
        { url: "http://b.example:9080/c", id: "crosssite" },
        { url: "http://a.example:9080/c", id: "sameorigin", name: "named" },
        { url: "about:blank", id: "blank" },
      ]),
    );
    expect(tree.childFrames?.map((child) => child.frame.name)).toEqual([
      "samesite",
      "",
      "named",
      "blank",
    ]);
  });

  it("disables cross-origin isolation below the first cross-origin frame", () => {
    const tree = buildFrameTree(
      target("http://a.example:9080/", [
        { url: "http://sub.a.example:9080/mid" },
        { url: "http://sub.a.example:9080/leaf", parent: 0 },
        { url: "http://a.example:9080/leaf", parent: 0 },
        { url: "data:text/html,d" },
        { url: "about:blank" },
        { url: "about:srcdoc" },
      ]),
    );
    const isolation = (node: Protocol.Page.FrameTree): unknown => [
      node.frame.crossOriginIsolatedContextType,
      ...(node.childFrames ?? []).map(isolation),
    ];
    expect(isolation(tree)).toEqual([
      "NotIsolated",
      [
        "NotIsolatedFeatureDisabled",
        ["NotIsolatedFeatureDisabled"],
        ["NotIsolatedFeatureDisabled"],
      ],
      ["NotIsolatedFeatureDisabled"],
      ["NotIsolated"],
      ["NotIsolated"],
    ]);
  });

  it("roots a child frame's own tree at that frame, as Chrome does for an out-of-process frame", () => {
    const state = target("http://localhost:8787/host", [
      { url: "http://127.0.0.1:8787/child#frag", id: "child" },
      { url: "http://127.0.0.1:8787/grandchild", parent: 0 },
    ]);
    const child = state.frames.get("child-0");
    if (!child) throw new Error("child frame missing");
    const own = buildFrameTree(state, child);
    const inParent = buildFrameTree(state).childFrames?.[0];
    expect(own).toEqual(inParent);
    expect(withoutIds(own)).toMatchObject({
      frame: {
        name: "",
        url: "http://127.0.0.1:8787/child",
        urlFragment: "#frag",
        securityOrigin: "http://127.0.0.1:8787",
        securityOriginDetails: { isLocalhost: true },
        adFrameStatus: CHILD_AD_STATUS,
        secureContextType: "SecureLocalhost",
        crossOriginIsolatedContextType: "NotIsolatedFeatureDisabled",
      },
    });
    expect(own.frame.parentId).toBe("main");
    const leaf = state.frames.get("child-1");
    if (!leaf) throw new Error("grandchild frame missing");
    expect("childFrames" in buildFrameTree(state, leaf)).toBe(false);
  });

  it("keeps an empty fragment, as Chrome does", () => {
    expect(buildFrameTree(target("http://a.example:9080/hash#")).frame).toMatchObject({
      url: "http://a.example:9080/hash",
      urlFragment: "#",
    });
  });
});
