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

function isVisibleChild(child: unknown, marker: string): boolean {
  return !(isCdpNode(child) && child.nodeType === 8 && child.nodeValue === marker);
}

function sanitizeChildren(value: Record<string, unknown>, marker: string | undefined): void {
  const childNodes = value.children;
  if (!Array.isArray(childNodes)) return;
  const children: unknown[] = childNodes;
  const visibleChildren = marker
    ? children.filter((child) => isVisibleChild(child, marker))
    : children;
  updateChildren(value, children, visibleChildren);
}

function updateChildren(
  value: Record<string, unknown>,
  children: unknown[],
  visibleChildren: unknown[],
): void {
  for (const child of visibleChildren) sanitizeNode(child);
  if (visibleChildren.length === children.length) return;
  value.children = visibleChildren;
  if (typeof value.childNodeCount === "number") value.childNodeCount = visibleChildren.length;
}

function sanitizeShadowRoots(value: Record<string, unknown>): void {
  const shadowRoots = value.shadowRoots;
  if (!Array.isArray(shadowRoots)) return;
  const roots: unknown[] = shadowRoots;
  for (const root of roots) sanitizeNode(root);
}

function sanitizeNode(value: unknown): void {
  if (!isCdpNode(value)) return;
  delete value.attributeNamespaces;
  sanitizeChildren(value, state.sourceDoctype?.marker);
  sanitizeShadowRoots(value);
}
