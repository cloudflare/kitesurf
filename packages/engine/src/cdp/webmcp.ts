// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Bridges WebMCP CDP commands to page tools and tracks pending tool invocations.

import type { Protocol } from "devtools-protocol";

import type { DispatchCtx } from "./dispatch.ts";
import type { CdpRequest, TargetState } from "./types.ts";
import { resolveTarget as resolveTargetCanonical, stubQueryDom } from "./page-session.ts";

interface PageTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    autosubmit?: boolean;
  };
  backendNodeId?: number;
}

interface ToolSnapshot {
  tools: PageTool[];
  pageScript: TargetState["pageScript"];
  navigateGeneration: number;
}

interface PendingInvocation {
  target: TargetState;
  toolName: string;
  frameId: string;
  sessionKey: string;
  pageInvocationId: string;
  pageScript?: NonNullable<TargetState["pageScript"]>;
  sessions: Array<string | undefined>;
  canceled: boolean;
  started: boolean;
}

const invocationsByConnection = new Map<
  string,
  { pending: Map<string, PendingInvocation>; seq: number }
>();

function connectionInvocations(ctx: DispatchCtx): {
  pending: Map<string, PendingInvocation>;
  seq: number;
} {
  let entry = invocationsByConnection.get(ctx.connectionId);
  if (!entry) {
    entry = { pending: new Map(), seq: 0 };
    invocationsByConnection.set(ctx.connectionId, entry);
  }
  return entry;
}

export function disposeWebMcpConnection(connectionId: string): void {
  const entry = invocationsByConnection.get(connectionId);
  invocationsByConnection.delete(connectionId);
  if (!entry) return;
  for (const pending of entry.pending.values()) {
    if (!pending.started || !pending.pageScript) continue;
    void stubQueryDom(pending.pageScript, "webmcpCancelTool", {
      invocationId: pending.pageInvocationId,
    }).catch(() => {});
  }
}

function sessionKey(sessionId: string | undefined): string {
  return typeof sessionId === "string" ? sessionId : "";
}

function wireSession(key: string): string | undefined {
  return key.length === 0 ? undefined : key;
}

function resolveTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState {
  return resolveTargetCanonical(ctx, sessionId, "WebMCP: no page target attached to session");
}

function targetForFrame(ctx: DispatchCtx, frameId: string): TargetState {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page" && t.frameId === frameId) return t;
  }
  throw new Error(`WebMCP: no frame ${frameId}`);
}

function coerceTools(raw: unknown): PageTool[] {
  if (!Array.isArray(raw)) return [];
  const out: PageTool[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name.length === 0) continue;
    const tool: PageTool = {
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
    };
    if (t.inputSchema !== undefined) tool.inputSchema = t.inputSchema;
    if (typeof t.backendNodeId === "number" && t.backendNodeId > 0) {
      tool.backendNodeId = t.backendNodeId;
    }
    const ann = t.annotations as Record<string, unknown> | undefined;
    if (ann && typeof ann === "object") {
      const annotations: NonNullable<PageTool["annotations"]> = {};
      if (typeof ann.readOnly === "boolean") {
        annotations.readOnly = ann.readOnly;
      }
      if (typeof ann.untrustedContent === "boolean") {
        annotations.untrustedContent = ann.untrustedContent;
      }
      if (typeof ann.autosubmit === "boolean") {
        annotations.autosubmit = ann.autosubmit;
      }
      if (Object.keys(annotations).length > 0) tool.annotations = annotations;
    }
    out.push(tool);
  }
  return out;
}

function toProtocolTool(tool: PageTool, frameId: string): Protocol.WebMCP.Tool {
  const out: Protocol.WebMCP.Tool = {
    name: tool.name,
    description: tool.description,
    frameId,
  };
  if (tool.inputSchema !== undefined && tool.inputSchema !== null) {
    out.inputSchema = tool.inputSchema as Record<string, unknown>;
  }
  if (tool.backendNodeId !== undefined) out.backendNodeId = tool.backendNodeId;
  if (tool.annotations) out.annotations = tool.annotations;
  return out;
}

function ledgerFor(target: TargetState, key: string): Map<string, string> {
  let ledger = target.webmcpAnnouncedTools.get(key);
  if (!ledger) {
    ledger = new Map();
    target.webmcpAnnouncedTools.set(key, ledger);
  }
  return ledger;
}

export function emitToolsAdded(
  ctx: DispatchCtx,
  target: TargetState,
  tools: PageTool[],
  onlySession?: string,
): void {
  if (tools.length === 0) return;
  const frameId = target.frameId;
  const keys = onlySession === undefined ? target.webmcpSessions : new Set([onlySession]);
  for (const key of keys) {
    if (!target.webmcpSessions.has(key)) continue;
    const ledger = ledgerFor(target, key);
    const fresh = tools.filter((t) => !ledger.has(t.name));
    if (fresh.length === 0) continue;
    for (const tool of fresh) ledger.set(tool.name, frameId);
    ctx.emit({
      method: "WebMCP.toolsAdded",
      params: { tools: fresh.map((t) => toProtocolTool(t, frameId)) },
      sessionId: wireSession(key),
    });
  }
}

export function emitToolsRemoved(ctx: DispatchCtx, target: TargetState, names: string[]): void {
  for (const key of target.webmcpSessions) {
    const ledger = ledgerFor(target, key);
    const payload: Protocol.WebMCP.RemovedTool[] = [];
    for (const name of names) {
      const frameId = ledger.get(name);
      if (frameId === undefined) continue;
      ledger.delete(name);
      payload.push({ name, frameId });
    }
    if (payload.length === 0) continue;
    ctx.emit({
      method: "WebMCP.toolsRemoved",
      params: { tools: payload },
      sessionId: wireSession(key),
    });
  }
}

export function clearToolsForNavigate(ctx: DispatchCtx, target: TargetState): void {
  const announced = new Set<string>();
  for (const ledger of target.webmcpAnnouncedTools.values()) {
    for (const name of ledger.keys()) announced.add(name);
  }
  if (announced.size === 0) return;
  emitToolsRemoved(ctx, target, Array.from(announced));
}

export async function reconcileTools(ctx: DispatchCtx, target: TargetState): Promise<void> {
  if (target.webmcpSessions.size === 0) return;
  const snapshot = await fetchTools(target, target.webmcpWatchRevision);
  if (snapshot === null) return;
  const liveNames = new Set(snapshot.tools.map((t) => t.name));
  const stale = new Set<string>();
  for (const ledger of target.webmcpAnnouncedTools.values()) {
    for (const name of ledger.keys()) {
      if (!liveNames.has(name)) stale.add(name);
    }
  }
  if (stale.size > 0) emitToolsRemoved(ctx, target, Array.from(stale));
  emitToolsAdded(ctx, target, snapshot.tools);
}

async function fetchTools(
  target: TargetState,
  watchRevision: number,
): Promise<ToolSnapshot | null> {
  const pageScript = target.pageScript;
  const navigateGeneration = target.navigateGeneration;
  if (!pageScript) return { tools: [], pageScript, navigateGeneration };
  const reply = await stubQueryDom(pageScript, "webmcpGetTools", {
    watchRevision,
  });
  if (target.pageScript !== pageScript || target.navigateGeneration !== navigateGeneration)
    return null;
  return {
    tools: coerceTools(reply?.tools),
    pageScript,
    navigateGeneration,
  };
}

function stopWatchingTools(target: TargetState): void {
  const watchRevision = ++target.webmcpWatchRevision;
  const pageScript = target.pageScript;
  if (!pageScript) return;
  void stubQueryDom(pageScript, "webmcpStopWatchingTools", { watchRevision }).catch((err) => {
    if (target.pageScript === pageScript) {
      console.warn(
        "kitesurf: failed to stop WebMCP declarative watcher:",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

export function detachWebMcpSession(target: TargetState, sessionId: string): void {
  if (!target.webmcpSessions.delete(sessionId)) return;
  target.webmcpEnableRevisions.delete(sessionId);
  target.webmcpAnnouncedTools.delete(sessionId);
  if (target.webmcpSessions.size === 0) stopWatchingTools(target);
}

function afterReply(ctx: DispatchCtx, work: () => Promise<void>): void {
  ctx.ctx.waitUntil(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        work()
          .catch((err) => {
            console.warn(
              "kitesurf: WebMCP deferred work failed:",
              err instanceof Error ? err.message : String(err),
            );
          })
          .finally(resolve);
      }, 0);
    }),
  );
}

async function runInvocation(
  ctx: DispatchCtx,
  invocationId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const table = connectionInvocations(ctx).pending;
  const pending = table.get(invocationId);
  if (!pending) return;
  const { target, toolName, frameId, sessions } = pending;

  pending.started = true;

  for (const sessionId of sessions) {
    ctx.emit({
      method: "WebMCP.toolInvoked",
      params: { toolName, frameId, invocationId, input: JSON.stringify(input) },
      sessionId,
    });
  }

  let status: Protocol.WebMCP.InvocationStatus = "Completed";
  let output: unknown;
  let errorText: string | undefined;

  const pageScript = target.pageScript;
  if (!pageScript) {
    status = "Error";
    errorText = "no document loaded — call Page.navigate first";
  } else {
    pending.pageScript = pageScript;
    try {
      const reply = await stubQueryDom(pageScript, "webmcpCallTool", {
        name: toolName,
        args: input,
        invocationId: pending.pageInvocationId,
      });
      if (reply?.notFound === true) {
        status = "Error";
        errorText = reply?.error ?? `no such tool: ${toolName}`;
      } else if (reply?.threw === true) {
        status = "Error";
        errorText = reply?.error ?? "tool threw";
      } else {
        output =
          reply?.rawOutput === true
            ? reply.output
            : {
                content: Array.isArray(reply?.content) ? reply.content : [],
                ...(reply?.isError === true ? { isError: true } : {}),
              };
        if (reply?.error !== undefined) errorText = reply.error;
      }
    } catch (err) {
      status = "Error";
      errorText = err instanceof Error ? err.message : String(err);
      void stubQueryDom(pageScript, "webmcpCancelTool", {
        invocationId: pending.pageInvocationId,
      }).catch(() => {});
    }
  }

  if (pending.canceled) return;
  table.delete(invocationId);

  for (const sessionId of sessions) {
    const params: Protocol.WebMCP.ToolRespondedEvent = { invocationId, status };
    if (status === "Completed" && output !== undefined) params.output = output;
    if (errorText !== undefined) params.errorText = errorText;
    ctx.emit({ method: "WebMCP.toolResponded", params, sessionId });
  }
}

export async function handleWebMcp(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "WebMCP.enable": {
      const target = resolveTarget(ctx, req.sessionId);
      const key = sessionKey(req.sessionId);
      target.webmcpSessions.add(key);
      const watchRevision = ++target.webmcpWatchRevision;
      target.webmcpEnableRevisions.set(key, watchRevision);
      const snapshot = await fetchTools(target, watchRevision);
      afterReply(ctx, async () => {
        if (
          snapshot === null ||
          target.webmcpEnableRevisions.get(key) !== watchRevision ||
          target.navigateGeneration !== snapshot.navigateGeneration ||
          target.pageScript !== snapshot.pageScript
        )
          return;
        snapshot.tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        emitToolsAdded(ctx, target, snapshot.tools, key);
      });
      return {};
    }

    case "WebMCP.disable": {
      const target = resolveTarget(ctx, req.sessionId);
      const key = sessionKey(req.sessionId);
      target.webmcpSessions.delete(key);
      target.webmcpEnableRevisions.delete(key);
      target.webmcpAnnouncedTools.delete(key);
      if (target.webmcpSessions.size === 0) stopWatchingTools(target);
      return {};
    }

    case "WebMCP.invokeTool": {
      const p = req.params;
      if (!p || typeof p.frameId !== "string" || typeof p.toolName !== "string") {
        throw new Error("WebMCP.invokeTool: frameId and toolName are required");
      }
      const { frameId, toolName } = p;
      const target = targetForFrame(ctx, frameId);
      const input = (p.input ?? {}) as Record<string, unknown>;
      const table = connectionInvocations(ctx);
      const invocationId = `webmcp-${++table.seq}`;
      table.pending.set(invocationId, {
        target,
        toolName,
        frameId,
        sessionKey: sessionKey(req.sessionId),
        pageInvocationId: `${ctx.connectionId}:${invocationId}`,
        sessions: Array.from(target.webmcpSessions, wireSession),
        canceled: false,
        started: false,
      });
      afterReply(ctx, () => runInvocation(ctx, invocationId, input));
      return { invocationId };
    }

    case "WebMCP.cancelInvocation": {
      const invocationId = req.params?.invocationId;
      if (typeof invocationId !== "string") {
        throw new Error("WebMCP.cancelInvocation: invocationId is required");
      }
      const pending = connectionInvocations(ctx).pending.get(invocationId);
      if (pending?.sessionKey === sessionKey(req.sessionId)) {
        pending.canceled = true;
        connectionInvocations(ctx).pending.delete(invocationId);
        afterReply(ctx, async () => {
          for (const sessionId of pending.sessions) {
            ctx.emit({
              method: "WebMCP.toolResponded",
              params: { invocationId, status: "Canceled" },
              sessionId,
            });
          }
          if (pending.started && pending.pageScript) {
            try {
              await stubQueryDom(pending.pageScript, "webmcpCancelTool", {
                invocationId: pending.pageInvocationId,
              });
            } catch {}
          }
        });
      }
      return {};
    }

    default:
      throw new Error(`${(req as { method: string }).method} is not a recognized WebMCP method`);
  }
}
