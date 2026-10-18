// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines structured-clone records shared across PageScript RPC calls.

import type { Protocol } from "devtools-protocol";

// Prefix of the `[ks-kill] <tail token> <reason>` line logged before `killIsolate`
// aborts. workerd reports the cancelled RPC as hung; the tail treats it as the kill.
export type IsolateKillMarker = "[ks-kill]";

export type PackedResultType =
  | "object"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "function";

export interface PackedResult {
  ok: true;
  type: PackedResultType;
  subtype?: "null" | "array" | "error";
  className?: string;
  description?: string;
  valueJson?: string;
  serializationError: string | null;
  objectId?: string;
}

export interface PackedException {
  ok: false;
  exception: {
    text: "Uncaught";
    message: string;
    stack: string | null;
    className: string;
  };
}

export type ConsoleLevel =
  | "log"
  | "info"
  | "warning"
  | "error"
  | "debug"
  | "trace"
  | "dir"
  | "table"
  | "warn";

export interface ConsoleEntry {
  level: ConsoleLevel;
  args: PackedResult[];
  timestamp: number;
}

export interface ExceptionEntry {
  timestamp: number;
  text: string;
  scriptId: string;
  url: string;
  className: string;
  message: string;
  stack: string;
}

export type RawCdpMutation =
  | {
      kind: "childNodeInserted";
      parentNodeId: number;
      previousNodeId: number;
      nodeId: number;
    }
  | { kind: "childNodeRemoved"; parentNodeId: number; nodeId: number }
  | { kind: "childNodeCountUpdated"; nodeId: number; childNodeCount: number }
  | { kind: "attributeModified"; nodeId: number; name: string; value: string }
  | { kind: "attributeRemoved"; nodeId: number; name: string }
  | { kind: "characterDataModified"; nodeId: number; characterData: string }
  | { kind: "shadowRootPushed"; hostId: number; root: Protocol.DOM.Node };

export type CdpMutation =
  | Exclude<RawCdpMutation, { kind: "childNodeInserted" }>
  | {
      kind: "childNodeInserted";
      parentNodeId: number;
      previousNodeId: number;
      node: Protocol.DOM.Node;
    }
  | { kind: "stylesheetResourceLoaded" };

export interface JsWindowDrain {
  console: ConsoleEntry[];
  cookieWrites: string[];
  cdpMutations: CdpMutation[];
}
