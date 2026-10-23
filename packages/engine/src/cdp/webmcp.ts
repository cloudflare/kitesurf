// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Bridges WebMCP CDP commands to page tools and tracks pending tool invocations.

import type { Protocol } from "devtools-protocol";

import type { DispatchCtx } from "./dispatch.ts";
import type { CdpRequest, TargetState } from "./types.ts";
import {
  resolveTarget as resolveTargetCanonical,
  stubQueryDom,
  type QueryDomResult,
} from "./page-session.ts";

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

interface InvocationResult {
  status: Protocol.WebMCP.InvocationStatus;
  output?: unknown;
  errorText?: string;
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
    const tool = coerceTool(item);
    if (tool) out.push(tool);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceTool(raw: unknown): PageTool | null {
  if (!isRecord(raw)) return null;
  const name = toolName(raw.name);
  if (!name) return null;
  const tool: PageTool = {
    name,
    description: typeof raw.description === "string" ? raw.description : "",
  };
  applyOptionalToolFields(tool, raw);
  return tool;
}

function toolName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyOptionalToolFields(tool: PageTool, raw: Record<string, unknown>): void {
  if (raw.inputSchema !== undefined) tool.inputSchema = raw.inputSchema;
  if (typeof raw.backendNodeId === "number" && raw.backendNodeId > 0) {
    tool.backendNodeId = raw.backendNodeId;
  }
  const annotations = coerceAnnotations(raw.annotations);
  if (annotations) tool.annotations = annotations;
}

function coerceAnnotations(value: unknown): PageTool["annotations"] {
  if (!isRecord(value)) return undefined;
  const annotations: NonNullable<PageTool["annotations"]> = {};
  copyBooleanAnnotation(value, annotations, "readOnly");
  copyBooleanAnnotation(value, annotations, "untrustedContent");
  copyBooleanAnnotation(value, annotations, "autosubmit");
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function copyBooleanAnnotation(
  source: Record<string, unknown>,
  target: NonNullable<PageTool["annotations"]>,
  key: keyof NonNullable<PageTool["annotations"]>,
): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
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
  const keys = onlySession === undefined ? target.webmcpSessions : new Set([onlySession]);
  for (const key of keys) emitToolsAddedForSession(ctx, target, tools, key);
}

function emitToolsAddedForSession(
  ctx: DispatchCtx,
  target: TargetState,
  tools: PageTool[],
  key: string,
): void {
  if (!target.webmcpSessions.has(key)) return;
  const ledger = ledgerFor(target, key);
  const fresh = tools.filter((tool) => !ledger.has(tool.name));
  if (fresh.length === 0) return;
  for (const tool of fresh) ledger.set(tool.name, target.frameId);
  ctx.emit({
    method: "WebMCP.toolsAdded",
    params: { tools: fresh.map((tool) => toProtocolTool(tool, target.frameId)) },
    sessionId: wireSession(key),
  });
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
  const stale = staleAnnouncedTools(target, snapshot.tools);
  if (stale.size > 0) emitToolsRemoved(ctx, target, Array.from(stale));
  emitToolsAdded(ctx, target, snapshot.tools);
}

function staleAnnouncedTools(target: TargetState, tools: PageTool[]): Set<string> {
  const liveNames = new Set(tools.map((tool) => tool.name));
  const stale = new Set<string>();
  for (const ledger of target.webmcpAnnouncedTools.values()) {
    for (const name of ledger.keys()) {
      if (!liveNames.has(name)) stale.add(name);
    }
  }
  return stale;
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

type WebMcpEnableRequest = Extract<CdpRequest, { method: "WebMCP.enable" }>;
type WebMcpDisableRequest = Extract<CdpRequest, { method: "WebMCP.disable" }>;
type WebMcpInvokeRequest = Extract<CdpRequest, { method: "WebMCP.invokeTool" }>;
type WebMcpCancelRequest = Extract<CdpRequest, { method: "WebMCP.cancelInvocation" }>;

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
  pending.started = true;
  emitToolInvoked(ctx, pending, invocationId, input);
  const result = await invokePageTool(ctx, pending, input);
  if (pending.canceled) return;
  table.delete(invocationId);
  emitToolResponses(ctx, pending, invocationId, result);
}

function emitToolInvoked(
  ctx: DispatchCtx,
  pending: PendingInvocation,
  invocationId: string,
  input: Record<string, unknown>,
): void {
  for (const sessionId of pending.sessions) {
    ctx.emit({
      method: "WebMCP.toolInvoked",
      params: {
        toolName: pending.toolName,
        frameId: pending.frameId,
        invocationId,
        input: JSON.stringify(input),
      },
      sessionId,
    });
  }
}

async function invokePageTool(
  ctx: DispatchCtx,
  pending: PendingInvocation,
  input: Record<string, unknown>,
): Promise<InvocationResult> {
  const { target, toolName, pageInvocationId } = pending;
  const pageScript = target.pageScript;
  if (!pageScript) {
    return { status: "Error", errorText: "no document loaded — call Page.navigate first" };
  }
  pending.pageScript = pageScript;
  try {
    const reply = await stubQueryDom(pageScript, "webmcpCallTool", {
      name: toolName,
      args: input,
      invocationId: pageInvocationId,
    });
    return invocationResultFromReply(reply, toolName);
  } catch (err) {
    cancelPageInvocation(pageScript, pageInvocationId);
    return { status: "Error", errorText: invocationErrorMessage(err) };
  }
}

function invocationResultFromReply(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
  toolName: string,
): InvocationResult {
  if (isToolNotFound(reply)) return notFoundResult(reply, toolName);
  if (isToolThrown(reply)) return thrownToolResult(reply);
  return completedToolResult(reply);
}

function invocationOutput(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): unknown {
  if (hasRawToolOutput(reply)) return reply.output;
  const output: { content: unknown[]; isError?: true } = {
    content: invocationContent(reply),
  };
  if (toolOutputIsError(reply)) output.isError = true;
  return output;
}

function isToolNotFound(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): boolean {
  return reply !== null && reply !== undefined && reply.notFound === true;
}

function isToolThrown(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): boolean {
  return reply !== null && reply !== undefined && reply.threw === true;
}

function notFoundResult(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
  toolName: string,
): InvocationResult {
  return { status: "Error", errorText: replyErrorText(reply) ?? `no such tool: ${toolName}` };
}

function thrownToolResult(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
): InvocationResult {
  return { status: "Error", errorText: replyErrorText(reply) ?? "tool threw" };
}

function completedToolResult(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
): InvocationResult {
  const result: InvocationResult = { status: "Completed", output: invocationOutput(reply) };
  const errorText = replyErrorText(reply);
  if (errorText !== undefined) result.errorText = errorText;
  return result;
}

function hasRawToolOutput(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
): reply is QueryDomResult<"webmcpCallTool"> {
  return reply !== null && reply !== undefined && reply.rawOutput === true;
}

function invocationContent(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): unknown[] {
  const content = replyContent(reply);
  return Array.isArray(content) ? content : [];
}

function replyContent(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): unknown {
  if (reply === null || reply === undefined) return undefined;
  return reply.content;
}

function toolOutputIsError(reply: QueryDomResult<"webmcpCallTool"> | null | undefined): boolean {
  if (reply === null || reply === undefined) return false;
  return reply.isError === true;
}

function replyErrorText(
  reply: QueryDomResult<"webmcpCallTool"> | null | undefined,
): string | undefined {
  if (reply === null || reply === undefined) return undefined;
  return reply.error;
}

function cancelPageInvocation(
  pageScript: NonNullable<TargetState["pageScript"]>,
  pageInvocationId: string,
): void {
  void stubQueryDom(pageScript, "webmcpCancelTool", { invocationId: pageInvocationId }).catch(
    () => {},
  );
}

function invocationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitToolResponses(
  ctx: DispatchCtx,
  pending: PendingInvocation,
  invocationId: string,
  result: InvocationResult,
): void {
  for (const sessionId of pending.sessions) {
    const params = toolRespondedParams(invocationId, result);
    ctx.emit({ method: "WebMCP.toolResponded", params, sessionId });
  }
}

function toolRespondedParams(
  invocationId: string,
  result: InvocationResult,
): Protocol.WebMCP.ToolRespondedEvent {
  const params: Protocol.WebMCP.ToolRespondedEvent = {
    invocationId,
    status: result.status,
  };
  if (result.status === "Completed" && result.output !== undefined) {
    params.output = result.output;
  }
  if (result.errorText !== undefined) params.errorText = result.errorText;
  return params;
}

export async function handleWebMcp(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "WebMCP.enable":
      return enableWebMcp(ctx, req);
    case "WebMCP.disable":
      return disableWebMcp(ctx, req);
    case "WebMCP.invokeTool":
      return invokeWebMcpTool(ctx, req);
    case "WebMCP.cancelInvocation":
      return cancelWebMcpInvocation(ctx, req);

    default:
      throw new Error(`${req.method} is not a recognized WebMCP method`);
  }
}

async function enableWebMcp(
  ctx: DispatchCtx,
  req: WebMcpEnableRequest,
): Promise<Record<string, never>> {
  const target = resolveTarget(ctx, req.sessionId);
  const key = sessionKey(req.sessionId);
  target.webmcpSessions.add(key);
  const watchRevision = ++target.webmcpWatchRevision;
  target.webmcpEnableRevisions.set(key, watchRevision);
  const snapshot = await fetchTools(target, watchRevision);
  afterReply(ctx, async () => {
    if (!isCurrentEnableSnapshot(target, snapshot, key, watchRevision)) return;
    snapshot.tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    emitToolsAdded(ctx, target, snapshot.tools, key);
  });
  return {};
}

function isCurrentEnableSnapshot(
  target: TargetState,
  snapshot: ToolSnapshot | null,
  key: string,
  watchRevision: number,
): snapshot is ToolSnapshot {
  return (
    snapshot !== null &&
    target.webmcpEnableRevisions.get(key) === watchRevision &&
    target.navigateGeneration === snapshot.navigateGeneration &&
    target.pageScript === snapshot.pageScript
  );
}

function disableWebMcp(ctx: DispatchCtx, req: WebMcpDisableRequest): Record<string, never> {
  const target = resolveTarget(ctx, req.sessionId);
  const key = sessionKey(req.sessionId);
  target.webmcpSessions.delete(key);
  target.webmcpEnableRevisions.delete(key);
  target.webmcpAnnouncedTools.delete(key);
  if (target.webmcpSessions.size === 0) stopWatchingTools(target);
  return {};
}

function invokeWebMcpTool(ctx: DispatchCtx, req: WebMcpInvokeRequest): { invocationId: string } {
  const params = req.params;
  if (!params || typeof params.frameId !== "string" || typeof params.toolName !== "string") {
    throw new Error("WebMCP.invokeTool: frameId and toolName are required");
  }
  const { frameId, toolName } = params;
  const target = targetForFrame(ctx, frameId);
  const input = (params.input ?? {}) as Record<string, unknown>;
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

function cancelWebMcpInvocation(ctx: DispatchCtx, req: WebMcpCancelRequest): Record<string, never> {
  const invocationId = req.params?.invocationId;
  if (typeof invocationId !== "string") {
    throw new Error("WebMCP.cancelInvocation: invocationId is required");
  }
  const table = connectionInvocations(ctx).pending;
  const pending = table.get(invocationId);
  if (!pending || pending.sessionKey !== sessionKey(req.sessionId)) return {};
  pending.canceled = true;
  table.delete(invocationId);
  afterReply(ctx, () => completeCanceledInvocation(ctx, pending, invocationId));
  return {};
}

async function completeCanceledInvocation(
  ctx: DispatchCtx,
  pending: PendingInvocation,
  invocationId: string,
): Promise<void> {
  emitCanceledInvocation(ctx, pending, invocationId);
  await cancelStartedPageInvocation(pending);
}

function emitCanceledInvocation(
  ctx: DispatchCtx,
  pending: PendingInvocation,
  invocationId: string,
): void {
  for (const sessionId of pending.sessions) {
    ctx.emit({
      method: "WebMCP.toolResponded",
      params: { invocationId, status: "Canceled" },
      sessionId,
    });
  }
}

async function cancelStartedPageInvocation(pending: PendingInvocation): Promise<void> {
  if (!pending.started || !pending.pageScript) return;
  try {
    await stubQueryDom(pending.pageScript, "webmcpCancelTool", {
      invocationId: pending.pageInvocationId,
    });
  } catch {}
}
