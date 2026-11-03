// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles Kitesurf CDP methods for scene transfer, engine settings, and diagnostics.

import type { Protocol } from "devtools-protocol";
import type { DispatchCtx } from "./dispatch.ts";
import type { CdpMethod, CdpRequest, CdpResultOf, TargetState } from "./types.ts";
import { CDP_COMMAND_UNHANDLED } from "./types.ts";
import {
  sessionOf,
  stubQueryDom,
  type QueryDomCarrier,
  type QueryDomMethod,
} from "./page-session.ts";
import { engineMemoryBreakdown } from "./target.ts";
import { sceneStreamCommand } from "./scene-stream.ts";
import { sceneHostCommand } from "./scene-host.ts";
import {
  MAX_MISSING_RESOURCE_LIST_B64_CHARS,
  MISSING_RESOURCE_LIST_ENTRY_BYTES,
  MISSING_RESOURCE_LIST_HEADER_BYTES,
  MISSING_RESOURCE_LIST_KIND_BYTES,
} from "../rbi-protocol.ts";

function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}
function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.fromBase64(s);
}

function firstPageTarget(ctx: DispatchCtx): TargetState | null {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return null;
}

function splitMissingHashes(missing: Uint8Array): {
  imageHashes: Uint8Array;
  fontDataHashes: Uint8Array;
} {
  if (missing.byteLength < MISSING_RESOURCE_LIST_HEADER_BYTES) {
    return { imageHashes: new Uint8Array(0), fontDataHashes: new Uint8Array(0) };
  }
  const view = new DataView(missing.buffer, missing.byteOffset, missing.byteLength);
  const count = view.getUint32(0, true);
  const images: number[] = [];
  const fonts: number[] = [];
  let off = MISSING_RESOURCE_LIST_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (off + MISSING_RESOURCE_LIST_ENTRY_BYTES > missing.byteLength) break;
    const kind = view.getUint8(off);
    const hashBytes = missing.subarray(
      off + MISSING_RESOURCE_LIST_KIND_BYTES,
      off + MISSING_RESOURCE_LIST_ENTRY_BYTES,
    );
    if (kind === 2) images.push(...hashBytes);
    else if (kind === 3) fonts.push(...hashBytes);
    off += MISSING_RESOURCE_LIST_ENTRY_BYTES;
  }
  return {
    imageHashes: new Uint8Array(images),
    fontDataHashes: new Uint8Array(fonts),
  };
}

function coerceMode(raw: unknown): Protocol.Kitesurf.LayoutMode {
  if (typeof raw !== "string") return "full";
  const lower = raw.toLowerCase();
  if (lower === "off" || lower === "0" || lower === "false") return "off";
  return "full";
}

function targetIdOf(params: { targetId?: unknown } | undefined): string | null {
  return typeof params?.targetId === "string" ? params.targetId : null;
}

// Target-scoped page methods default to the first page, as the other Kitesurf methods do.
function pageTargetFor(
  ctx: DispatchCtx,
  params: { targetId?: unknown } | undefined,
): TargetState | null {
  const targetId = targetIdOf(params);
  const target =
    targetId === null ? firstPageTarget(ctx) : (ctx.browser.targets.get(targetId) ?? null);
  return target?.type === "page" ? target : null;
}

function noPageScript(target: TargetState | null): string {
  return target ? "no PageScript" : "target not found";
}

// paintDamageSince always takes a node to leave out; this external id is never minted.
const NO_EXCLUDED_NODE = 0xffff_ffff;

function positiveNodeId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const OUTBOUND_FILTER_FIELDS = [
  "allowRequestPattern",
  "rejectRequestPattern",
  "allowResourceTypes",
  "rejectResourceTypes",
] as const;

function cdpResult<M extends CdpMethod>(
  _req: { method: M },
  result: CdpResultOf<M>,
): CdpResultOf<M> {
  return result;
}

const PAGE_DIAGNOSTIC_OPS = {
  "Kitesurf.getFontFaces": "getFontFaces",
  "Kitesurf.getMemprofDump": "getMemprofDump",
  "Kitesurf.resetMemprof": "resetMemprof",
  "Kitesurf.boaForceCollect": "boaForceCollect",
  "Kitesurf.getSceneStats": "getSceneStats",
} as const satisfies Partial<Record<CdpRequest["method"], QueryDomMethod>>;

export async function handleKitesurf(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Kitesurf.getSceneHostManifest":
    case "Kitesurf.readSceneHost":
      return sceneHostCommand(ctx.env.FONT_ASSETS, req, ctx.browser);
    case "Kitesurf.startSceneStream":
    case "Kitesurf.stopSceneStream":
    case "Kitesurf.sceneFrameAck":
    case "Kitesurf.getSceneResources":
      return sceneStreamCommand(ctx, req);
    case "Kitesurf.getSessionInfo": {
      const meta = ctx.analytics.meta;
      return cdpResult(req, {
        sessionId: meta.sessionId,
        entrypoint: meta.entrypoint,
        connectionMode: meta.connectionMode,
        environment: meta.environment,
        buildVersion: meta.buildVersion,
        colo: meta.colo,
      });
    }

    case "Kitesurf.setLayoutMode": {
      const mode = coerceMode(req.params?.mode);
      const targetId = targetIdOf(req.params);

      if (targetId === null) {
        ctx.browser.layoutMode = mode;
        const updated: string[] = [];
        for (const t of ctx.browser.targets.values()) {
          t.layoutMode = mode;
          if (t.type === "page") {
            await sessionOf(ctx, t).callIfLive.setLayoutMode({ mode });
          }
          updated.push(t.targetId);
        }
        return cdpResult(req, { mode, scope: "browser", targets: updated });
      }

      const target = ctx.browser.targets.get(targetId);
      if (!target) {
        return cdpResult(req, {
          mode,
          scope: "target",
          targetId,
          error: "target not found",
        });
      }
      target.layoutMode = mode;
      if (target.type === "page" && target.pageScript) {
        try {
          await stubQueryDom(target.pageScript, "setLayoutMode", { mode });
        } catch (err) {
          return cdpResult(req, {
            mode,
            scope: "target",
            targetId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return cdpResult(req, { mode, scope: "target", targetId });
    }

    case "Kitesurf.getLayoutMode": {
      const targetId = targetIdOf(req.params);
      if (targetId === null) {
        return cdpResult(req, { mode: ctx.browser.layoutMode });
      }
      const target = ctx.browser.targets.get(targetId);
      if (!target) {
        return cdpResult(req, {
          mode: ctx.browser.layoutMode,
          error: "target not found",
        });
      }
      if (target.type === "page") {
        const reply = await sessionOf(ctx, target).callIfLive.getLayoutMode({});
        if (reply && typeof reply.mode === "string") {
          return cdpResult(req, { mode: reply.mode });
        }
      }
      return cdpResult(req, { mode: target.layoutMode });
    }

    case "Kitesurf.getRendererInfo": {
      const m = ctx.browser.rendererManager;
      const memory = m ? m.memoryStats() : null;
      return cdpResult(req, {
        enabled: true,
        active: !!m,
        framesRendered: m ? m.framesRendered : 0,
        partialFramesRendered: m ? m.partialFramesRendered : 0,
        relaunchCount: m ? m.relaunchCount : 0,
        rendererWasmBytes: memory ? memory.bytes : null,
        rendererWasmDeltaBytes: memory ? memory.deltaBytes : null,
        initialRes: m ? m.initialResString() : null,
        partialRaster: !ctx.browser.skipPartialRaster,
      });
    }

    case "Kitesurf.setPartialRaster": {
      const enabled = req.params?.enabled !== false;
      ctx.browser.skipPartialRaster = !enabled;
      return cdpResult(req, { enabled });
    }

    case "Kitesurf.disposeRenderer": {
      const m = ctx.browser.rendererManager;
      if (m) m.dispose("Kitesurf.disposeRenderer");
      return cdpResult(req, { disposed: !!m });
    }

    case "Kitesurf.getNavigatePhases": {
      const targetId = targetIdOf(req.params);
      if (targetId === null) {
        const byTarget: Record<string, Protocol.Kitesurf.NavigatePhases | null> = {};
        for (const t of ctx.browser.targets.values()) {
          if (t.type !== "page") continue;
          byTarget[t.targetId] = t.lastNavigatePhases;
        }
        return cdpResult(req, { byTarget });
      }
      const target = ctx.browser.targets.get(targetId);
      if (!target) {
        return cdpResult(req, { phases: null, error: "target not found" });
      }
      return cdpResult(req, { phases: target.lastNavigatePhases });
    }

    case "Kitesurf.hasPendingCriticalResources": {
      const targetId = targetIdOf(req.params);
      const ask = async (
        t: TargetState,
      ): Promise<Protocol.Kitesurf.PendingCriticalResources | null> => {
        if (t.type !== "page") return null;
        if (!t.pageScript) return { pending: false, error: "no PageScript" };
        try {
          const reply = await stubQueryDom(t.pageScript, "hasPendingCriticalResources", {});
          return { pending: !!reply?.pending, error: reply?.error };
        } catch (err) {
          return {
            pending: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };
      if (targetId === null) {
        const byTarget: Record<string, Protocol.Kitesurf.PendingCriticalResources | null> = {};
        for (const t of ctx.browser.targets.values()) {
          if (t.type !== "page") continue;
          byTarget[t.targetId] = await ask(t);
        }
        return cdpResult(req, { byTarget });
      }
      const target = ctx.browser.targets.get(targetId);
      if (!target) {
        return cdpResult(req, { pending: false, error: "target not found" });
      }
      return cdpResult(req, (await ask(target)) ?? {});
    }

    case "Kitesurf.getPageState": {
      const target = pageTargetFor(ctx, req.params);
      if (!target?.pageScript) return cdpResult(req, { error: noPageScript(target) });
      try {
        const reply = await stubQueryDom(target.pageScript, "getPageState", {});
        return cdpResult(req, reply ?? {});
      } catch (err) {
        return cdpResult(req, { error: errorText(err) });
      }
    }

    case "Kitesurf.setControlValue": {
      const nodeId = positiveNodeId(req.params?.nodeId);
      if (nodeId === null) return cdpResult(req, { changed: false, error: "bad nodeId" });
      const target = pageTargetFor(ctx, req.params);
      if (!target?.pageScript) {
        return cdpResult(req, { changed: false, error: noPageScript(target) });
      }
      try {
        const reply = await stubQueryDom(target.pageScript, "setControlValueAsUser", {
          nodeId,
          value: req.params?.value,
        });
        return cdpResult(req, {
          changed: reply?.changed === true,
          value: reply?.value,
          error: reply?.error,
        });
      } catch (err) {
        return cdpResult(req, { changed: false, error: errorText(err) });
      }
    }

    case "Kitesurf.markPaintDamage": {
      const target = pageTargetFor(ctx, req.params);
      if (!target?.pageScript) return cdpResult(req, { error: noPageScript(target) });
      try {
        await stubQueryDom(target.pageScript, "markPaintDamage", {});
        return cdpResult(req, {});
      } catch (err) {
        return cdpResult(req, { error: errorText(err) });
      }
    }

    case "Kitesurf.getPaintDamageSince": {
      const raw = req.params?.excludeNodeId;
      const nodeId = raw === undefined ? NO_EXCLUDED_NODE : positiveNodeId(raw);
      if (nodeId === null) {
        return cdpResult(req, { nodeIds: [], overflow: false, error: "bad nodeId" });
      }
      const target = pageTargetFor(ctx, req.params);
      if (!target?.pageScript) {
        return cdpResult(req, { nodeIds: [], overflow: false, error: noPageScript(target) });
      }
      try {
        const reply = await stubQueryDom(target.pageScript, "paintDamageSince", { nodeId });
        return cdpResult(req, {
          nodeIds: Array.isArray(reply?.ids) ? reply.ids : [],
          overflow: reply?.overflow === true,
        });
      } catch (err) {
        return cdpResult(req, { nodeIds: [], overflow: false, error: errorText(err) });
      }
    }

    case "Kitesurf.getMemoryStats": {
      const targetId = targetIdOf(req.params);
      const askStub = async (stub: QueryDomCarrier) => {
        try {
          const reply = await stubQueryDom(stub, "getMemoryStats", {});
          return {
            wasmBytes: typeof reply?.bytes === "number" ? reply.bytes : 0,
            wasmInitialBytes: typeof reply?.initialBytes === "number" ? reply.initialBytes : 0,
            wasmDeltaBytes: typeof reply?.deltaBytes === "number" ? reply.deltaBytes : 0,
            bridge: reply?.bridge ?? null,
            domFastpath: reply?.domFastpath ?? null,
            domNodes: typeof reply?.domNodes === "number" ? reply.domNodes : null,
            wrappers: reply?.wrappers ?? null,
            paint: reply?.paint ?? null,
            layout: reply?.layout ?? null,
            intersectionObserver: reply?.intersectionObserver ?? null,
            timerWheel: reply?.timerWheel ?? null,
            error: reply?.error,
          };
        } catch (err) {
          return {
            wasmBytes: 0,
            wasmInitialBytes: 0,
            wasmDeltaBytes: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };
      const ask = async (t: TargetState) => {
        if (t.type !== "page") return null;
        if (!t.pageScript) {
          return {
            wasmBytes: 0,
            wasmInitialBytes: 0,
            wasmDeltaBytes: 0,
            frameWasmBytes: 0,
            frameWasmDeltaBytes: 0,
            error: "no PageScript",
          };
        }
        const children = [...t.frames.values()]
          .map((f) => f.pageScript)
          .filter((s): s is NonNullable<typeof s> => Boolean(s));
        const [own, ...replies] = await Promise.all([
          askStub(t.pageScript),
          ...children.map((s) => askStub(s)),
        ]);
        let frameWasmBytes = 0;
        let frameWasmDeltaBytes = 0;
        for (const child of replies) {
          frameWasmBytes += child.wasmBytes;
          frameWasmDeltaBytes += child.wasmDeltaBytes;
        }
        return { ...own, frameWasmBytes, frameWasmDeltaBytes };
      };
      if (targetId === null) {
        const byTarget: Record<string, Protocol.Kitesurf.MemoryStats | null> = {};
        let pageScriptBytes = 0;
        let pageScriptDeltaBytes = 0;
        for (const t of ctx.browser.targets.values()) {
          if (t.type !== "page") continue;
          const stats = await ask(t);
          byTarget[t.targetId] = stats;
          if (!stats) continue;
          pageScriptBytes += stats.wasmBytes + stats.frameWasmBytes;
          pageScriptDeltaBytes += stats.wasmDeltaBytes + stats.frameWasmDeltaBytes;
        }
        const engine = engineMemoryBreakdown(ctx.browser);
        const rendererMem = ctx.browser.rendererManager?.memoryStats() ?? null;
        const renderer = {
          wasmBytes: rendererMem?.bytes ?? 0,
          wasmInitialBytes: rendererMem?.initialBytes ?? 0,
          wasmDeltaBytes: rendererMem?.deltaBytes ?? 0,
        };
        return cdpResult(req, {
          byTarget,
          engine,
          renderer,
          isolatesKilled: ctx.browser.workerBudget.isolatesKilled,
          total: {
            bytes: engine.accountedBytes + pageScriptBytes + renderer.wasmBytes,
            deltaBytes: engine.wasmDeltaBytes + pageScriptDeltaBytes + renderer.wasmDeltaBytes,
            engineBytes: engine.accountedBytes,
            pageScriptBytes,
            rendererBytes: renderer.wasmBytes,
          },
        });
      }
      const target = ctx.browser.targets.get(targetId);
      if (!target) {
        return cdpResult(req, { wasmBytes: 0, error: "target not found" });
      }
      return cdpResult(req, (await ask(target)) ?? {});
    }

    case "Kitesurf.setOutboundFilters": {
      const { compileOutboundFilters, registerOutboundFilters } =
        await import("./outbound-filter-registry.ts");
      const params = req.params ?? {};
      const input: Partial<Record<(typeof OUTBOUND_FILTER_FIELDS)[number], string[]>> = {};
      for (const name of OUTBOUND_FILTER_FIELDS) {
        const value: unknown = params[name];
        if (!Array.isArray(value)) continue;
        const strings = value.filter((s): s is string => typeof s === "string");
        if (strings.length !== value.length) {
          return cdpResult(req, { ok: false, error: `${name} must be an array of strings` });
        }
        input[name] = strings;
      }
      const compiled = compileOutboundFilters(input);
      if (!compiled.ok) {
        return cdpResult(req, { ok: false, error: compiled.error });
      }
      registerOutboundFilters(ctx.connectionId, compiled.filters);
      return cdpResult(req, { ok: true });
    }

    case "Kitesurf.recordScene": {
      const params = req.params ?? {};
      const targetId = targetIdOf(params);
      const target = targetId ? ctx.browser.targets.get(targetId) : firstPageTarget(ctx);
      if (!target || target.type !== "page") {
        return cdpResult(req, { error: "no page target" });
      }
      if (!target.pageScript) {
        return cdpResult(req, { error: "no PageScript" });
      }
      const args = {
        producer: params.producer,
        sinceSeq: params.sinceSeq,
        omitBackground: params.omitBackground,
        clip: params.clip,
        allowPartial: params.allowPartial,
        allowScrollShift: params.allowScrollShift,
        baseSeq: params.baseSeq,
        inlineResources: params.inlineResources,
        pumpRaf: params.pumpRaf,
        frameIntervalMs: params.frameIntervalMs,
      };
      try {
        const r = await stubQueryDom(target.pageScript, "recordScene", args);
        return cdpResult(req, {
          sceneB64: r.scene && r.scene.length > 0 ? bytesToBase64(r.scene) : "",
          resourceBatchB64:
            r.resourceBatch && r.resourceBatch.length > 0 ? bytesToBase64(r.resourceBatch) : "",
          unchanged: !!r.unchanged,
          seq: r.seq ?? 0,
          partial: !!r.partial,
          clip: r.clip ?? null,
          baseSeq: r.baseSeq ?? -1,
          scrollX: r.scrollX ?? 0,
          scrollY: r.scrollY ?? 0,
          error: r.error,
          damageCount: r.damageCount ?? 0,
          layoutDirty: !!r.layoutDirty,
          skipReason: r.skipReason ?? "",
        });
      } catch (err) {
        return cdpResult(req, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    case "Kitesurf.getScreencastStatus": {
      const targetId = targetIdOf(req.params);
      const target = targetId ? ctx.browser.targets.get(targetId) : firstPageTarget(ctx);
      if (!target) {
        return cdpResult(req, { error: "no page target" });
      }
      const sc = ctx.browser.screencasts.get(target.targetId);
      const where = {
        targetId: target.targetId,
        targetUrl: target.url,
        hasPageScript: target.pageScript !== null,
        generation: target.navigateGeneration,
        pageTargets: [...ctx.browser.targets.values()].filter((t) => t.type === "page").length,
      };
      if (!sc) {
        return cdpResult(req, { active: false, ...where });
      }
      return cdpResult(req, {
        active: !sc.stopped,
        framesDropped: sc.framesDropped,
        lastError: sc.lastRenderError ?? "",
        inFlight: sc.frameSeq - sc.lastAckedSeq,
        ...where,
      });
    }

    case "Kitesurf.getConnectionInfo": {
      return cdpResult(req, { connectionId: ctx.connectionId });
    }

    case "Kitesurf.getRbiResources": {
      const targetId = targetIdOf(req.params);
      const target = targetId ? ctx.browser.targets.get(targetId) : firstPageTarget(ctx);
      if (!target || target.type !== "page") {
        return cdpResult(req, { error: "no page target" });
      }
      if (!target.pageScript) {
        return cdpResult(req, { error: "no PageScript" });
      }
      const missingB64Param = req.params?.missingB64;
      const missingB64 = typeof missingB64Param === "string" ? missingB64Param : "";
      if (missingB64.length > MAX_MISSING_RESOURCE_LIST_B64_CHARS) {
        return cdpResult(req, { error: "missing list too large" });
      }
      const missing = base64ToBytes(missingB64);
      const { imageHashes, fontDataHashes } = splitMissingHashes(missing);
      try {
        const r = await stubQueryDom(target.pageScript, "getPaintResources", {
          imageHashes,
          fontDataHashes,
        });
        return cdpResult(req, {
          batchB64: r.batch && r.batch.length > 0 ? bytesToBase64(r.batch) : "",
          error: r.error,
        });
      } catch (err) {
        return cdpResult(req, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    case "Kitesurf.getFontFaces":
    case "Kitesurf.getMemprofDump":
    case "Kitesurf.resetMemprof":
    case "Kitesurf.boaForceCollect":
    case "Kitesurf.getSceneStats": {
      const op = PAGE_DIAGNOSTIC_OPS[req.method];
      const targetId = targetIdOf(req.params);
      const ask = async (t: TargetState) => {
        if (t.type !== "page") return null;
        if (!t.pageScript) return { error: "no PageScript" };
        try {
          return await stubQueryDom(t.pageScript, op, {});
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      };
      if (targetId === null) {
        const byTarget: Record<string, Awaited<ReturnType<typeof ask>>> = {};
        for (const t of ctx.browser.targets.values()) {
          if (t.type !== "page") continue;
          byTarget[t.targetId] = await ask(t);
        }
        return { byTarget };
      }
      const target = ctx.browser.targets.get(targetId);
      if (!target) return { error: "target not found" };
      return (await ask(target)) ?? {};
    }

    default:
      return CDP_COMMAND_UNHANDLED;
  }
}
