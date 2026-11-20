// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type Protocol from "devtools-protocol";

export type HeaderEntry = Protocol.Fetch.HeaderEntry;

export type InterceptAction =
  | {
      kind: "continue";
      url?: string;
      method?: string;
      headers?: HeaderEntry[];
      postData?: string;
    }
  | {
      kind: "fulfill";
      responseCode: number;
      responseHeaders?: HeaderEntry[];
      body?: string;
    }
  | { kind: "fail"; errorReason: string };

interface CompiledPattern {
  pattern: string;
  resourceType?: string;
}

export interface ParkedRequest {
  interceptionId: string;
  verdict?: InterceptAction;
}

export interface FetchInterceptionState {
  patterns: CompiledPattern[];
  emit: (params: Protocol.Fetch.RequestPausedEvent) => void;
  parked: Map<string, ParkedRequest>;
  nextId: number;
  pendingEmits: Protocol.Fetch.RequestPausedEvent[];
}

const registry = new Map<string, FetchInterceptionState>();

const MAX_PARKED = 500;

const MAX_PENDING_EMITS = 200;

const PARK_TIMEOUT_MS = 5_000;
const VERDICT_POLL_INTERVAL_MS = 20;

export function ensureInterception(connectionId: string): FetchInterceptionState {
  let st = registry.get(connectionId);
  if (!st) {
    st = {
      patterns: [],
      emit: () => {},
      parked: new Map(),
      nextId: 1,
      pendingEmits: [],
    };
    registry.set(connectionId, st);
  }
  return st;
}

export function getInterception(connectionId: string): FetchInterceptionState | undefined {
  const st = registry.get(connectionId);
  return st && st.patterns.length > 0 ? st : undefined;
}

export function releaseAllParked(st: FetchInterceptionState): void {
  for (const p of st.parked.values()) {
    p.verdict ??= { kind: "continue" };
  }
}

export function releaseParkedForConnection(connectionId: string): void {
  const st = registry.get(connectionId);
  if (st) releaseAllParked(st);
}

export function unregisterInterception(connectionId: string): void {
  const st = registry.get(connectionId);
  if (st) releaseAllParked(st);
  registry.delete(connectionId);
}

/** Longest urlPattern accepted by Fetch.enable. */
export const MAX_GLOB_PATTERN_CHARS = 1024;

/**
 * Most request-stage patterns Fetch.enable retains for one connection. Chrome has no cap and
 * clients register one pattern per route, so this stays well above real use.
 */
export const MAX_GLOB_PATTERNS = 1024;

// The four code units a JavaScript `.` refuses to match without the `s` flag.
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

// Matches a Fetch urlPattern without a RegExp, so no pattern can backtrack. `*` matches any
// run of code units and `?` one, both excluding line terminators like `.`; everything else is
// literal. Code units, not code points: the previous regex had no `u` flag.
export function globMatches(pattern: string, url: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < url.length) {
    if (j < pattern.length) {
      const pc = pattern.charCodeAt(j);
      const uc = url.charCodeAt(i);
      if (pc === 0x2a) {
        star = j++;
        mark = i;
        continue;
      }
      if (pc === 0x3f ? !isLineTerminator(uc) : pc === uc) {
        i++;
        j++;
        continue;
      }
    }
    if (star >= 0 && mark < url.length && !isLineTerminator(url.charCodeAt(mark))) {
      // The last `*` takes one more code unit and matching resumes after it.
      mark++;
      i = mark;
      j = star + 1;
      continue;
    }
    return false;
  }
  while (j < pattern.length && pattern.charCodeAt(j) === 0x2a) j++;
  return j === pattern.length;
}

export function interceptionMatches(
  st: FetchInterceptionState,
  url: string,
  resourceType: string,
): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;
  return st.patterns.some((p) => {
    // The resourceType comparison is cheap; skip the glob for a pattern it excludes.
    if (p.resourceType && p.resourceType !== resourceType) return false;
    return globMatches(p.pattern, url);
  });
}

export function registerParked(
  st: FetchInterceptionState,
  info: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    resourceType: string;
    frameId: string;
    networkId: string;
  },
): ParkedRequest {
  const interceptionId = `interception-job-${st.nextId++}`;
  if (st.parked.size >= MAX_PARKED) {
    const oldest = st.parked.values().next().value as ParkedRequest | undefined;
    if (oldest) {
      // Awaiters keep this object, so resolve it before evicting the map entry.
      oldest.verdict ??= { kind: "continue" };
      st.parked.delete(oldest.interceptionId);
      const evictedId = oldest.interceptionId;
      st.pendingEmits = st.pendingEmits.filter((e) => e.requestId !== evictedId);
    }
  }
  const entry: ParkedRequest = { interceptionId };
  st.parked.set(interceptionId, entry);
  st.pendingEmits.push({
    requestId: interceptionId,
    request: {
      url: info.url,
      method: info.method,
      headers: info.headers,
      postData: info.postData,
      initialPriority: info.resourceType === "Document" ? "VeryHigh" : "Medium",
      referrerPolicy: "strict-origin-when-cross-origin",
    },
    frameId: info.frameId,
    resourceType: info.resourceType as Protocol.Network.ResourceType,
    networkId: info.networkId,
  });
  if (st.pendingEmits.length > MAX_PENDING_EMITS) {
    st.pendingEmits.splice(0, st.pendingEmits.length - MAX_PENDING_EMITS);
  }
  return entry;
}

export function drainInterception(connectionId: string): void {
  const st = registry.get(connectionId);
  if (!st || st.pendingEmits.length === 0) return;
  const batch = st.pendingEmits;
  st.pendingEmits = [];
  for (const ev of batch) {
    try {
      st.emit(ev);
    } catch {
      return;
    }
  }
}

export async function awaitVerdict(
  st: FetchInterceptionState,
  entry: ParkedRequest,
): Promise<InterceptAction> {
  const deadline = Date.now() + PARK_TIMEOUT_MS;
  for (;;) {
    const v = entry.verdict;
    if (v) {
      st.parked.delete(entry.interceptionId);
      return v;
    }
    if (Date.now() > deadline) {
      // A missing verdict continues so interception cannot hold egress indefinitely.
      st.parked.delete(entry.interceptionId);
      return { kind: "continue" };
    }
    await new Promise((r) => setTimeout(r, VERDICT_POLL_INTERVAL_MS));
  }
}

export function resolveParked(
  st: FetchInterceptionState,
  interceptionId: string,
  action: InterceptAction,
): boolean {
  const p = st.parked.get(interceptionId);
  if (!p || p.verdict) return false;
  p.verdict = action;
  return true;
}

export function errorReasonToNet(reason: string): string {
  switch (reason) {
    case "Aborted":
      return "net::ERR_ABORTED";
    case "AccessDenied":
      return "net::ERR_ACCESS_DENIED";
    case "AddressUnreachable":
      return "net::ERR_ADDRESS_UNREACHABLE";
    case "BlockedByClient":
      return "net::ERR_BLOCKED_BY_CLIENT";
    case "BlockedByResponse":
      return "net::ERR_BLOCKED_BY_RESPONSE";
    case "ConnectionAborted":
      return "net::ERR_CONNECTION_ABORTED";
    case "ConnectionClosed":
      return "net::ERR_CONNECTION_CLOSED";
    case "ConnectionFailed":
      return "net::ERR_CONNECTION_FAILED";
    case "ConnectionRefused":
      return "net::ERR_CONNECTION_REFUSED";
    case "ConnectionReset":
      return "net::ERR_CONNECTION_RESET";
    case "InternetDisconnected":
      return "net::ERR_INTERNET_DISCONNECTED";
    case "NameNotResolved":
      return "net::ERR_NAME_NOT_RESOLVED";
    case "TimedOut":
      return "net::ERR_TIMED_OUT";
    default:
      return "net::ERR_FAILED";
  }
}
