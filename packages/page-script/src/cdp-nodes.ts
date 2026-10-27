// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Sanitizes PageScript DOM snapshots before they cross the CDP boundary.

import { state } from "./state.ts";

function isCdpNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeCdpNodeTree<T>(node: T): T {
  sanitizeNode(node);
  return node;
}

function sanitizeNode(value: unknown): void {
  const marker = state.sourceDoctype?.marker;
  if (!isCdpNode(value)) return;

  delete value.attributeNamespaces;

  const childNodes = value.children;
  if (Array.isArray(childNodes)) {
    const children: unknown[] = childNodes;
    const visibleChildren = marker
      ? children.filter(
          (child) => !(isCdpNode(child) && child.nodeType === 8 && child.nodeValue === marker),
        )
      : children;
    for (const child of visibleChildren) sanitizeNode(child);
    if (visibleChildren.length !== children.length) {
      value.children = visibleChildren;
      if (typeof value.childNodeCount === "number") {
        value.childNodeCount = visibleChildren.length;
      }
    }
  }
  const shadowRoots = value.shadowRoots;
  if (Array.isArray(shadowRoots)) {
    const roots: unknown[] = shadowRoots;
    for (const root of roots) sanitizeNode(root);
  }
}
