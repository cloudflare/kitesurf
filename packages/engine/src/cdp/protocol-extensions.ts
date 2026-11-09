// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import type {
  BoaCollectStats as PageScriptBoaCollectStats,
  FontFaces as PageScriptFontFaces,
  PageScriptGauges,
} from "@kitesurf/jsrpc-types/query-dom";
import "devtools-protocol/types/protocol-mapping";

declare module "devtools-protocol" {
  namespace Protocol {
    namespace DOM {
      interface GetOuterHTMLRequest {
        includeDoctype?: boolean;
      }
      interface QuerySelectorResponse {
        error?: string;
      }
    }
    namespace Page {
      interface CaptureScreenshotRequest {
        omitBackground?: boolean;
      }
      interface PrintToPDFRequest {
        omitBackground?: boolean;
      }
      interface PrintToPDFResponse {
        error?: string;
      }
      interface SetDocumentContentResponse {
        error?: string;
      }
      interface NavigateRequest {
        _kitesurfInternal?: boolean;
        _kitesurfPostData?: string;
        _kitesurfPostContentType?: string;
        _kitesurfLoaderId?: string;
        /** Host of the document that initiated a page-started navigation. */
        _kitesurfInitiatorHost?: string;
      }
      interface StartScreencastRequest {
        minFrameIntervalMs?: integer;
        maxInFlight?: integer;
        maxFramesInFlight?: integer;
      }
    }

    namespace Kitesurf {
      type LayoutMode = "full" | "off";

      interface TargetScopedRequest {
        targetId?: Target.TargetID;
      }

      /** Reply of the per-target methods that fan out without a `targetId`. */
      interface ByTargetResponse<T> {
        byTarget: Record<Target.TargetID, T | null>;
      }

      interface SceneRect {
        x: number;
        y: number;
        w: number;
        h: number;
      }

      interface StartSceneStreamRequest extends TargetScopedRequest {
        width: integer;
        height: integer;
        fps?: integer;
        text?: boolean;
        terminal?: boolean;
        cellW?: number;
        cellH?: number;
        allowPartial?: boolean;
      }

      interface SceneFrameAckRequest extends TargetScopedRequest {
        seq: integer;
        painted?: boolean;
      }

      interface GetSceneResourcesRequest extends TargetScopedRequest {
        missingB64: string;
      }

      interface GetSceneResourcesResponse {
        batchB64: string;
      }

      interface SceneHostManifest {
        abi: integer;
        wireVersion: integer;
        wasm: "scene_host.wasm";
        sha256: string;
        bytes: integer;
        retainedFrames?: boolean;
      }

      interface ReadSceneHostRequest {
        sha256: string;
        offset: integer;
        /** Raw bytes, between 1 and 4194304. The last chunk may be shorter. */
        length: integer;
      }

      interface ReadSceneHostResponse {
        sha256: string;
        offset: integer;
        totalBytes: integer;
        dataB64: string;
      }

      interface SceneFrameEvent {
        data: string;
      }

      interface GetSessionInfoResponse {
        sessionId: string;
        entrypoint: string;
        connectionMode: "page" | "browser";
        environment: string;
        buildVersion: string;
        colo: string;
      }

      interface SetLayoutModeRequest extends TargetScopedRequest {
        mode?: string;
      }

      type SetLayoutModeResponse =
        | { mode: LayoutMode; scope: "browser"; targets: Target.TargetID[] }
        | {
            mode: LayoutMode;
            scope: "target";
            targetId: Target.TargetID;
            error?: string;
          };

      interface GetLayoutModeResponse {
        mode: string;
        error?: string;
      }

      interface GetRendererInfoResponse {
        enabled: boolean;
        active: boolean;
        framesRendered: number;
        partialFramesRendered: number;
        relaunchCount: number;
        rendererWasmBytes: number | null;
        rendererWasmDeltaBytes: number | null;
        initialRes: string | null;
        partialRaster: boolean;
      }

      interface SetPartialRasterRequest {
        enabled?: boolean;
      }

      interface SetPartialRasterResponse {
        enabled: boolean;
      }

      interface DisposeRendererResponse {
        disposed: boolean;
      }

      type NavigatePhases = Record<string, number>;

      type GetNavigatePhasesResponse =
        | ByTargetResponse<NavigatePhases>
        | { phases: NavigatePhases | null; error?: string };

      interface PendingCriticalResources {
        pending: boolean;
        error?: string;
      }

      type HasPendingCriticalResourcesResponse =
        | ByTargetResponse<PendingCriticalResources>
        | PendingCriticalResources
        | Record<string, never>;

      /** Page position and the DOM mutation counter, read without a full DOM walk. */
      interface GetPageStateResponse {
        /** Increments on every DOM mutation; compare two reads to detect a change. */
        seq?: integer;
        scrollX?: number;
        scrollY?: number;
        href?: string;
        title?: string;
        error?: string;
      }

      interface SetControlValueRequest extends TargetScopedRequest {
        /** A `DOM.NodeId` from the current document. */
        nodeId: DOM.NodeId;
        /** A string, a boolean for a checkbox or radio, or strings for `<select multiple>`. */
        value: unknown;
      }

      interface SetControlValueResponse {
        changed: boolean;
        /** The control's `value` after the write. */
        value?: string;
        error?: string;
      }

      interface MarkPaintDamageResponse {
        error?: string;
      }

      interface GetPaintDamageSinceRequest extends TargetScopedRequest {
        /**
         * Leave out this node, its subtree and its ancestors, such as the control a client just
         * used, whose hover and focus restyle would otherwise always show.
         */
        excludeNodeId?: DOM.NodeId;
      }

      interface GetPaintDamageSinceResponse {
        /** Nodes whose painted output changed since `Kitesurf.markPaintDamage`. */
        nodeIds: DOM.NodeId[];
        /** More nodes changed than the report holds. */
        overflow: boolean;
        error?: string;
      }

      interface MemoryStats extends PageScriptGauges {
        wasmBytes?: number;
        wasmInitialBytes?: number;
        wasmDeltaBytes?: number;
        frameWasmBytes?: number;
        frameWasmDeltaBytes?: number;
      }

      interface GetMemoryStatsResponse extends MemoryStats {
        byTarget?: Record<Target.TargetID, MemoryStats | null>;
        engine?: {
          wasmBytes: number;
          wasmInitialBytes: number;
          wasmDeltaBytes: number;
          retainedBodyBytes: number;
          retainedBodyBytesIsolate: number;
          retainedRequestCount: number;
          retainedImageBytes: number;
          retainedImageCount: number;
          fontAssetCacheBytes: number;
          accountedBytes: number;
        };
        renderer?: {
          wasmBytes: number;
          wasmInitialBytes: number;
          wasmDeltaBytes: number;
        };
        isolatesKilled?: number;
        total?: {
          bytes: number;
          deltaBytes: number;
          engineBytes: number;
          pageScriptBytes: number;
          rendererBytes: number;
        };
      }

      interface SetOutboundFiltersRequest {
        allowRequestPattern?: string[];
        rejectRequestPattern?: string[];
        allowResourceTypes?: string[];
        rejectResourceTypes?: string[];
      }

      type SetOutboundFiltersResponse = { ok: true } | { ok: false; error: string };

      interface RecordSceneRequest extends TargetScopedRequest {
        producer?: "client" | "replay";
        sinceSeq?: integer;
        omitBackground?: boolean;
        inlineResources?: boolean;
        clip?: {
          x: number;
          y: number;
          width: number;
          height: number;
          scale?: number;
        };
        allowPartial?: boolean;
        allowScrollShift?: boolean;
        baseSeq?: integer;
        pumpRaf?: boolean;
        frameIntervalMs?: number;
      }

      interface RecordedScene {
        sceneB64: string;
        resourceBatchB64: string;
        seq: integer;
        unchanged: boolean;
        partial: boolean;
        clip: SceneRect | null;
        baseSeq: integer;
        scrollX: number;
        scrollY: number;
        damageCount: integer;
        layoutDirty: boolean;
        skipReason: string;
        error?: string;
      }

      type RecordSceneResponse = RecordedScene | { error: string };

      interface GetRbiResourcesRequest extends TargetScopedRequest {
        missingB64?: string;
      }

      type GetRbiResourcesResponse = { batchB64: string; error?: string } | { error: string };

      interface GetScreencastStatusResponse {
        active?: boolean;
        framesDropped?: integer;
        lastError?: string;
        inFlight?: integer;
        targetId?: Target.TargetID;
        targetUrl?: string;
        hasPageScript?: boolean;
        generation?: integer;
        pageTargets?: integer;
        error?: string;
      }

      interface GetConnectionInfoResponse {
        connectionId: string;
      }

      type PageDiagnosticResponse<T extends { error?: string }> = ByTargetResponse<T> | T;

      type FontFaces = PageScriptFontFaces;
      type BoaCollectStats = PageScriptBoaCollectStats;

      type OpaqueDiagnostic = Record<string, unknown> & { error?: string };
    }
  }
}

declare module "devtools-protocol/types/protocol-mapping" {
  namespace ProtocolMapping {
    interface Events {
      "Kitesurf.sceneFrame": [Protocol.Kitesurf.SceneFrameEvent];
    }

    interface Commands {
      "Kitesurf.startSceneStream": {
        paramsType: [Protocol.Kitesurf.StartSceneStreamRequest];
        returnType: void;
      };
      "Kitesurf.stopSceneStream": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: void;
      };
      "Kitesurf.sceneFrameAck": {
        paramsType: [Protocol.Kitesurf.SceneFrameAckRequest];
        returnType: void;
      };
      "Kitesurf.getSceneResources": {
        paramsType: [Protocol.Kitesurf.GetSceneResourcesRequest];
        returnType: Protocol.Kitesurf.GetSceneResourcesResponse;
      };
      "Kitesurf.getSceneHostManifest": {
        paramsType: [];
        returnType: Protocol.Kitesurf.SceneHostManifest;
      };
      "Kitesurf.readSceneHost": {
        paramsType: [Protocol.Kitesurf.ReadSceneHostRequest];
        returnType: Protocol.Kitesurf.ReadSceneHostResponse;
      };
      "Kitesurf.getSessionInfo": {
        paramsType: [];
        returnType: Protocol.Kitesurf.GetSessionInfoResponse;
      };
      "Kitesurf.setLayoutMode": {
        paramsType: [Protocol.Kitesurf.SetLayoutModeRequest?];
        returnType: Protocol.Kitesurf.SetLayoutModeResponse;
      };
      "Kitesurf.getLayoutMode": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.GetLayoutModeResponse;
      };
      "Kitesurf.getRendererInfo": {
        paramsType: [];
        returnType: Protocol.Kitesurf.GetRendererInfoResponse;
      };
      "Kitesurf.setPartialRaster": {
        paramsType: [Protocol.Kitesurf.SetPartialRasterRequest?];
        returnType: Protocol.Kitesurf.SetPartialRasterResponse;
      };
      "Kitesurf.disposeRenderer": {
        paramsType: [];
        returnType: Protocol.Kitesurf.DisposeRendererResponse;
      };
      "Kitesurf.getNavigatePhases": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.GetNavigatePhasesResponse;
      };
      "Kitesurf.hasPendingCriticalResources": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.HasPendingCriticalResourcesResponse;
      };
      "Kitesurf.getPageState": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.GetPageStateResponse;
      };
      "Kitesurf.setControlValue": {
        paramsType: [Protocol.Kitesurf.SetControlValueRequest];
        returnType: Protocol.Kitesurf.SetControlValueResponse;
      };
      "Kitesurf.markPaintDamage": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.MarkPaintDamageResponse;
      };
      "Kitesurf.getPaintDamageSince": {
        paramsType: [Protocol.Kitesurf.GetPaintDamageSinceRequest?];
        returnType: Protocol.Kitesurf.GetPaintDamageSinceResponse;
      };
      "Kitesurf.getMemoryStats": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.GetMemoryStatsResponse;
      };
      "Kitesurf.setOutboundFilters": {
        paramsType: [Protocol.Kitesurf.SetOutboundFiltersRequest?];
        returnType: Protocol.Kitesurf.SetOutboundFiltersResponse;
      };
      "Kitesurf.recordScene": {
        paramsType: [Protocol.Kitesurf.RecordSceneRequest?];
        returnType: Protocol.Kitesurf.RecordSceneResponse;
      };
      "Kitesurf.getScreencastStatus": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.GetScreencastStatusResponse;
      };
      "Kitesurf.getConnectionInfo": {
        paramsType: [];
        returnType: Protocol.Kitesurf.GetConnectionInfoResponse;
      };
      "Kitesurf.getRbiResources": {
        paramsType: [Protocol.Kitesurf.GetRbiResourcesRequest?];
        returnType: Protocol.Kitesurf.GetRbiResourcesResponse;
      };
      "Kitesurf.getFontFaces": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.FontFaces>;
      };
      "Kitesurf.boaForceCollect": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.BoaCollectStats>;
      };
      "Kitesurf.getMemprofDump": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.OpaqueDiagnostic>;
      };
      "Kitesurf.resetMemprof": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.OpaqueDiagnostic>;
      };
      "Kitesurf.getSceneStats": {
        paramsType: [Protocol.Kitesurf.TargetScopedRequest?];
        returnType: Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.OpaqueDiagnostic>;
      };
    }
  }
}
