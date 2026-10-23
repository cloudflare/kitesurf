// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Buffers page console calls and DOM mutations for parent-side CDP delivery.

import type {
  CdpMutation,
  ConsoleEntry,
  ConsoleLevel,
  PackedResult,
} from "@kitesurf/jsrpc-types/shared";
import { getInternalState } from "./internal-state.js";
import { packResult } from "./pack.ts";
import { ksGlobal, state } from "./state.ts";
import { sanitizeCdpNodeTree } from "./cdp-nodes.ts";

const CONSOLE_BUFFER_CAP = 1000;

const CONSOLE_ARG_NODE_BUDGET = 10_000;

const __consoleBuffer: ConsoleEntry[] = [];
let __consoleDropped = false;

function __captureArg(value: unknown): PackedResult {
  try {
    return packResult(value, true, CONSOLE_ARG_NODE_BUDGET);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return packResult(message, true);
  }
}

export function pushConsole(level: ConsoleLevel, args: ArrayLike<unknown>): void {
  if (__consoleBuffer.length >= CONSOLE_BUFFER_CAP) {
    if (!__consoleDropped) {
      __consoleDropped = true;
      __consoleBuffer.push({
        level: "warn",
        args: [__captureArg("[kitesurf] console buffer full; dropping oldest entries")],
        timestamp: Date.now(),
      });
    }
    __consoleBuffer.shift();
  }
  const captured: PackedResult[] = [];
  for (let i = 0; i < args.length; i++) {
    captured.push(__captureArg(args[i]));
  }
  __consoleBuffer.push({
    level,
    args: captured,
    timestamp: Date.now(),
  });
}

let __consoleInstalled = false;
export function installConsoleWrapper(): void {
  if (__consoleInstalled) return;
  __consoleInstalled = true;
  type Logger = (...args: unknown[]) => void;
  const originalConsole = (ksGlobal.console || {}) as Record<string, unknown>;
  const bind = (methodName: string, fallback: Logger): Logger => {
    const loggerMethod = originalConsole[methodName];
    if (typeof loggerMethod === "function") {
      return (loggerMethod as Logger).bind(originalConsole);
    }
    return fallback;
  };
  const realLog = bind("log", () => {});
  const realInfo = bind("info", realLog);
  const realWarn = bind("warn", realLog);
  const realError = bind("error", realLog);
  const realDebug = bind("debug", realLog);
  const realTrace = bind("trace", realLog);

  ksGlobal.console = {
    ...(originalConsole as Record<string, unknown>),
    log: (...args: unknown[]) => {
      pushConsole("log", args);
      try {
        realLog(...args);
      } catch {}
    },
    info: (...args: unknown[]) => {
      pushConsole("info", args);
      try {
        realInfo(...args);
      } catch {}
    },
    warn: (...args: unknown[]) => {
      pushConsole("warning", args);
      try {
        realWarn(...args);
      } catch {}
    },
    error: (...args: unknown[]) => {
      pushConsole("error", args);
      try {
        realError(...args);
      } catch {}
    },
    debug: (...args: unknown[]) => {
      pushConsole("debug", args);
      try {
        realDebug(...args);
      } catch {}
    },
    trace: (...args: unknown[]) => {
      pushConsole("trace", args);
      try {
        realTrace(...args);
      } catch {}
    },
    dir: (...args: unknown[]) => {
      pushConsole("dir", args);
      try {
        realLog(...args);
      } catch {}
    },
    table: (...args: unknown[]) => {
      pushConsole("table", args);
      try {
        realLog(...args);
      } catch {}
    },
  } as Console;
}

export function drainConsole(): ConsoleEntry[] {
  if (__consoleBuffer.length === 0) return [];
  const entries = __consoleBuffer.slice();
  __consoleBuffer.length = 0;
  __consoleDropped = false;
  return entries;
}

type InsertedNode = Extract<CdpMutation, { kind: "childNodeInserted" }>["node"];
type RawInsertedNodeMutation = Extract<
  ReturnType<typeof state.drainCdpMutationsRaw>[number],
  { kind: "childNodeInserted" }
>;

function hasNumberField(value: Record<string, unknown>, field: string): boolean {
  return field in value && typeof value[field] === "number";
}

function hasStringField(value: Record<string, unknown>, field: string): boolean {
  return field in value && typeof value[field] === "string";
}

function hasOptionalArray(value: Record<string, unknown>, field: string): boolean {
  return !(field in value) || Array.isArray(value[field]);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNodeIdentity(value: Record<string, unknown>): boolean {
  return hasNumberField(value, "nodeId") && hasNumberField(value, "backendNodeId");
}

function hasNodeType(value: Record<string, unknown>): boolean {
  return hasNumberField(value, "nodeType") && hasStringField(value, "nodeName");
}

function hasNodeContents(value: Record<string, unknown>): boolean {
  return (
    hasStringField(value, "localName") &&
    hasStringField(value, "nodeValue") &&
    hasNumberField(value, "childNodeCount")
  );
}

function hasNodeArrays(value: Record<string, unknown>): boolean {
  return hasOptionalArray(value, "children") && hasOptionalArray(value, "shadowRoots");
}

function isInsertedNode(value: unknown): value is InsertedNode {
  if (!isObjectRecord(value)) return false;
  return (
    hasNodeIdentity(value) && hasNodeType(value) && hasNodeContents(value) && hasNodeArrays(value)
  );
}

function normalizeInsertedNodeMutation(
  mutation: RawInsertedNodeMutation,
): Extract<CdpMutation, { kind: "childNodeInserted" }> | null {
  try {
    const dom = state.dom as { nodeSubtree?: (id: number) => unknown } | null;
    const subtree = dom?.nodeSubtree?.(mutation.nodeId);
    if (!isInsertedNode(subtree)) return null;
    return {
      kind: "childNodeInserted",
      parentNodeId: mutation.parentNodeId,
      previousNodeId: mutation.previousNodeId,
      node: sanitizeCdpNodeTree(subtree),
    };
  } catch {
    return null;
  }
}

function appendRawMutation(
  mutations: CdpMutation[],
  mutation: ReturnType<typeof state.drainCdpMutationsRaw>[number],
): void {
  if (mutation.kind !== "childNodeInserted") {
    mutations.push(mutation);
    return;
  }
  const normalized = normalizeInsertedNodeMutation(mutation);
  if (normalized) mutations.push(normalized);
}

function appendRawMutations(
  mutations: CdpMutation[],
  rawMutations: ReturnType<typeof state.drainCdpMutationsRaw>,
): void {
  for (const mutation of rawMutations) {
    if (!mutation || typeof mutation !== "object") continue;
    appendRawMutation(mutations, mutation);
  }
}

export function drainCdpMutations(): CdpMutation[] {
  const rawMutations = state.drainCdpMutationsRaw();
  const styleSheetHints: CdpMutation[] = [];
  const internalState = getInternalState();
  if (internalState.styleSheetsDirty) {
    styleSheetHints.push({ kind: "stylesheetResourceLoaded" });
    internalState.styleSheetsDirty = false;
  }
  if (rawMutations.length === 0 && styleSheetHints.length === 0) return [];
  const mutations: CdpMutation[] = styleSheetHints;
  appendRawMutations(mutations, rawMutations);
  return mutations;
}

export function resetConsoleBuffer(): void {
  __consoleBuffer.length = 0;
  __consoleDropped = false;
}
