// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The engine hooks dom-shim and page-script call each other through, on the internals record
// from internal-state.js rather than globalThis. A hook dom-shim reads or writes belongs here;
// page-script's PageScriptInternals extends this. All optional: page-script installs its side
// after dom-shim loads, and a bare WPT harness never does.

import type { Element } from "./element/element.js";
import { getInternals } from "./internal-state.js";

export interface DomShimInternals {
  // Installed by page-script. True while a CDP client has the DOM domain enabled; record.ts and
  // element.ts then queue DOM.* mutation events.
  cdpDomActive?: boolean;
  // Terminal cell size in CSS px, set for TTY targets so wheel scrolls move by whole cells.
  ttyCellWidth?: number;
  ttyCellHeight?: number;
  // Trace parent of the current RPC (the `tp` envelope field).
  traceParent?: string;
  jsSpanEnter?: (op: string, bytes: number, detail: string) => number;
  jsSpanExit?: (slot: number) => void;
  // In lazy font mode, upgrades to the full fonts so text shaped outside layout (canvas, SVG)
  // gets outlines. Null when nothing is pending.
  demandFontOutlines?: () => Promise<void> | null;
  // document.fonts.ready and .status read these.
  fontsReady?: () => Promise<void>;
  fontsInflightCount?: () => number;
  // Registers deferred fonts for canvas measureText. False while bytes are still in flight.
  demandDeferredFonts?: () => boolean;
  // Custom-element registry hooks; page-script owns the registry.
  notifyConnected?: (root: Element) => void;
  upgradeCustomElement?: (element: Element, tagName: string) => void;
  customElementObservesAttribute?: (element: Element, name: string) => boolean;
  notifyCustomElementAttributeChanged?: (
    element: Element,
    name: string,
    oldValue: string | null,
    newValue: string | null,
    namespace: string | null,
  ) => void;

  // Installed by dom-shim for page-script to call. createElementNoUpgrade mints a wrapper with no
  // custom-element upgrade, for page-script's HTMLElement constructor.
  createElementNoUpgrade?: (tag: string) => unknown;
  scrollByWheel?: (hitNodeId: number, dx: number, dy: number) => boolean;
  toggleSelectDropdown?: (select: unknown) => boolean;
}

export const ksInternals = getInternals() as DomShimInternals;
