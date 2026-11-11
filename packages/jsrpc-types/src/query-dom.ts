// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines typed arguments and results for PageScript DOM queries and renderer pulls.

import type { Protocol } from "devtools-protocol";

// Each nested gauge group comes from one producer and is null when unavailable.

export interface PageScriptGauges {
  bridge?: {
    v8Pins: number;
    boaPins: number;
    wrappers: number;
    /** Live weak boa-object slots behind the identity caches. */
    weakBoa: number;
    releasedV8: number;
    releasedBoa: number;
    boaHeapBytes: number;
    boaGcThreshold: number;
    internerLen: number;
    internerReclaims: number;
    internerPendingMods: number;
    internerQueueIdle: number;
    ctxReentryDepth: number;
    ctxReentryMax: number;
    ctxUnchaperoned: number;
    pumpPromiseJobs: number;
    pumpFutures: number;
    pumpDrainBusy: boolean;
    pumpTicketWaiters: number;
    bgTicks: number;
    bgProgress: number;
    bgLastTickMs: number;
    /** VM-stack values leaked by a crossing, cleared at the outermost V8->boa
     * entry; a steady climb names a bridge path that strands values. */
    healedAtEntry: number;
    ccRuns: number;
    ccGrayPins: number;
    ccWeakV8: number;
    ccDeadV8: number;
    ccWeakened: number;
    ccRevoked: number;
    ccDeadReads: number;
    ccLastMs: number;
    ccSkipped: number;
    /** What compiled code retains, in bytes by form (vendored boa ks_code_stats). Shared
     * strings and scopes are not counted; blocksRun is blocks whose bytecode expanded. */
    boaCode: {
      blocks: number;
      blocksRun: number;
      sourceTexts: number;
      sourceBytes: number;
      /** Source texts boa's code store holds instead of wasm memory, toString reads of
       * them, and store reads that failed (toString then says "[native code]"). */
      sourceSwappedTexts: number;
      sourceSwappedBytes: number;
      sourceReads: number;
      storeFailures: number;
      /** Blocks whose packed bytecode is in the code store, its bytes, first runs that read
       * it back, executable bytes a forced round dropped, and blocks it still could. */
      swappedBlocks: number;
      swappedBytes: number;
      bytecodeReads: number;
      flushes: number;
      flushableBlocks: number;
      forcedRounds: number;
      packedBytes: number;
      expandedBytes: number;
      icBytes: number;
      sourceMapBytes: number;
      otherBytes: number;
      /** Blocks whose body is in the code store, bodies read back, records written (one per
       * block, nested ones too) and their bytes, and subtrees left resident (vendored ks_body). */
      bodiesSwapped: number;
      bodyFaults: number;
      bodyRecords: number;
      bodyRecordBytes: number;
      bodySkips: number;
    };
    /** The wasm allocator's swap trigger (core swap_alloc.rs): live bytes, the budget past
     * which an allocation forces a swap round (-1 when off), and what those rounds did. */
    swapAlloc: {
      liveBytes: number;
      budgetBytes: number;
      rounds: number;
      rescued: number;
      freedBytes: number;
      failedAllocs: number;
      /** The worst moment this isolate had: wasm pages are one-way, so the high-water is what
       * it is charged for from then on, however much it frees later. */
      peakLiveBytes: number;
      /** Wasm linear memory right now, which is what the platform charges. */
      wasmBytes: number;
    };
  } | null;
  domFastpath?: {
    fastHits: number;
    brandChecks: number;
    revalidations: number;
    fallbacks: number;
    deoptMask: number;
    hitsByOp: number[];
  } | null;
  domNodes?: number | null;
  wrappers?: Record<string, number> | null;
  paint?: { prepares: number } | null;
  // Layout resolves since the document was built. An animation-only resolve
  // re-cascades every running animation, so a fast climb on an idle page
  // means some poller keeps asking.
  layout?: { mutationResolves: number; animationResolves: number } | null;
  intersectionObserver?: {
    free: number;
    forced: number;
    skipped: number;
  } | null;
  /**
   * Page timer wheel (page-tasks.ts timerWheelStats); armed-but-overdue means every page timer
   * is frozen. `shim` is the defer-shim's real-timer accounting underneath it.
   */
  timerWheel?: {
    entries: number;
    armed: boolean;
    wakeOverdueMs: number;
    nextDueInMs: number | null;
    wakesFired: number;
    wakesArmed: number;
    shim: {
      outstanding: number;
      pending: number;
      parked: number;
      liveTimers: number;
      liveIntervals: number;
    };
  } | null;
  error?: string;
}

export interface BoaCollectStats {
  beforeBytes?: number;
  afterBytes?: number;
  threshold?: number;
  error?: string;
}

export interface FontFaces {
  json?: string;
  error?: string;
}

export interface ParsedStyleSheet {
  rules: Array<{
    selector_text: string;
    selector_specificities: number[];
    declarations: Array<{ name: string; value: string; important?: boolean }>;
    source_line: number;
    source_column: number;
  }>;
  ranges: Array<{
    ruleRange: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    bodyRange: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    selectorRanges: Array<{
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    }>;
    declarationRanges: Array<{
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    }>;
  }>;
}

export interface EnumeratedStyleSheet {
  ownerNodeId: number;
  text: string;
  sourceURL?: string;
  isInline?: boolean;
  origin?: "regular" | "user-agent" | "injected" | "inspector";
  cors?: "clean" | "opaque" | "pending";
}

/** Mutation sequence bounds for checking whether a snapshot changed during its read. */
export interface ReadStamp {
  before: number;
  after: number;
  complete: boolean;
}

export interface FormStateSnapshot {
  values?: Array<[number, string]>;
  checked?: Array<[number, boolean]>;
  selected?: Array<[number, boolean]>;
}

/** Typed wire operations multiplexed over the retained PageScript session.
 * Node IDs and object handles expire with that generation; read stamps expose snapshot mutations.
 */
export interface QueryDomMethods {
  getDocument: {
    args: ReadStampArgs;
    result: Partial<Protocol.DOM.GetDocumentResponse> & { readStamp?: ReadStamp };
  };
  nodeSubtree: {
    args: { nodeId: number };
    result: { node?: Protocol.DOM.Node | null };
  };
  querySelector: {
    args: { selector: string };
    result: Partial<Protocol.DOM.QuerySelectorResponse> & { error?: string };
  };
  querySelectorAll: {
    args: { selector: string };
    result: Partial<Protocol.DOM.QuerySelectorAllResponse> & { error?: string };
  };
  getOuterHTML: {
    args: { nodeId?: number; includeDoctype?: boolean };
    result: Partial<Protocol.DOM.GetOuterHTMLResponse>;
  };
  describeNode: {
    args: { nodeId?: number; objectId?: string };
    result: Partial<Protocol.DOM.DescribeNodeResponse>;
  };
  getAttributes: {
    args: { nodeId?: number };
    result: Partial<Protocol.DOM.GetAttributesResponse>;
  };
  resolveNode: {
    args: { nodeId: number };
    result: { object?: Protocol.Runtime.RemoteObject };
  };
  getAncestorElementIds: {
    args: { nodeId: number };
    result: { ancestorIds?: number[] };
  };
  notRenderedNodeIds: {
    args: ReadStampArgs;
    result: { displayNone?: number[]; invisible?: number[]; readStamp?: ReadStamp };
  };
  formStateSnapshot: {
    args: ReadStampArgs;
    result: FormStateSnapshot & { readStamp?: ReadStamp };
  };
  focus: { args: { nodeId: number }; result: EmptyArgs };
  // DOM.scrollIntoViewIfNeeded: `found` is false when the id names no node of this document.
  scrollIntoViewIfNeeded: {
    args: {
      nodeId?: number;
      objectId?: string;
      rect?: { x: number; y: number; width: number; height: number };
    };
    result: { found: boolean; scrolled?: boolean };
  };
  getPageState: {
    args: EmptyArgs;
    result: { seq?: number; scrollX?: number; scrollY?: number; href?: string; title?: string };
  };
  setControlValueAsUser: {
    args: { nodeId: number; value: unknown };
    result: { changed?: boolean; value?: string; error?: string };
  };
  // Paint damage can reveal a visual reaction that accessibility snapshots miss.
  markPaintDamage: { args: EmptyArgs; result: Record<string, unknown> };
  paintDamageSince: {
    args: { nodeId: number };
    result: { ids?: number[]; overflow?: boolean };
  };
  getRect: {
    // `objectId` is a PageScript handle (`ps:<isolateStamp>:<seq>`) from Runtime, as
    // Playwright passes it.
    args: { nodeId: number } | { objectId: string };
    result: { rect?: Protocol.DOM.Rect | null };
  };
  elementFromPoint: {
    args: { x: number; y: number };
    result: { nodeId?: number };
  };
  getComputedStyle: {
    args: { nodeId: number };
    result: { computedStyle?: Protocol.CSS.CSSComputedStyleProperty[] };
  };
  matchSelectorList: {
    args: { nodeId: number; selectorListText: string };
    result: { matches?: number[] };
  };
  parseStyleSheet: {
    args: { text: string };
    result: { sheet?: { rules?: ParsedStyleSheet["rules"] }; error?: string };
  };
  enumerateStyleSheets: {
    args: EmptyArgs;
    result: { sheets?: EnumeratedStyleSheet[]; error?: string };
  };
  setViewport: {
    args: { width: number | null; height: number | null };
    result: {
      ok?: boolean;
      width?: number;
      height?: number;
      scrollX?: number;
      scrollY?: number;
      error?: string;
    };
  };
  setMediaType: {
    args: { media: string; quiet?: boolean };
    result: { ok?: boolean; media?: "screen" | "print"; changed?: boolean; error?: string };
  };
  setLayoutMode: {
    args: { mode: string };
    result: { ok?: boolean; mode?: string; error?: string };
  };
  getLayoutMode: { args: EmptyArgs; result: { mode?: string } };
  // Page.getLayoutMetrics: CSS px. The content size is never smaller than
  // the viewport.
  layoutMetrics: {
    args: EmptyArgs;
    result: {
      viewportWidth: number;
      viewportHeight: number;
      scrollX: number;
      scrollY: number;
      contentWidth: number;
      contentHeight: number;
    };
  };
  setCdpDomActive: { args: { active: boolean }; result: { ok?: boolean } };
  setFrameContext: {
    args: { parentOrigin: string };
    result: { ok?: boolean };
  };
  setSuppressBackgrounds: {
    args: { enabled: boolean };
    result: { ok?: boolean; changed?: boolean; error?: string };
  };
  pageBoxJson: {
    args: EmptyArgs;
    result: { ok?: boolean; json?: string; error?: string };
  };
  awaitPendingResources: {
    args: {
      timeoutMs: number;
      upgradeFonts?: boolean;
      scope?: { mode: "rect"; x: number; y: number; w: number; h: number } | { mode: "viewport" };
    };
    result: {
      ok?: boolean;
      waited?: boolean;
      timedOut?: boolean;
      fontsMs?: number;
      fontsTimedOut?: boolean;
      fonts?: { emoji: boolean; cjk: boolean; upgrade: boolean };
      images?: PendingImageDrain;
    };
  };
  hasPendingCriticalResources: {
    args: EmptyArgs;
    result: { pending?: boolean; error?: string };
  };
  pumpTasks: {
    // An idle pump may arm a paintDirty notification after this sequence.
    args: { armWakeAfterSeq?: number; frameIntervalMs?: number };
    result: {
      seq?: number;
      animating?: boolean;
      pumped?: number;
      idle?: boolean;
      nextRafDelayMs?: number;
    };
  };
  recordScene: {
    // CDP params pass through unknown; narrow each field in PageScript before use.
    args: {
      producer?: unknown;
      sinceSeq?: unknown;
      omitBackground?: unknown;
      clip?: unknown;
      allowPartial?: unknown;
      allowScrollShift?: unknown;
      baseSeq?: unknown;
      inlineResources?: unknown;
      pumpRaf?: unknown;
      frameIntervalMs?: unknown;
      // Arm a scene-stream wake independently from the screencast wake.
      armWake?: unknown;
      // Packed little-endian u64 resource hashes already held by the RBI connection.
      haveImages?: Uint8Array;
      haveFonts?: Uint8Array;
      // CDP keeps images encoded; the private render port selects this mode.
      images?: "raw" | "encoded";
    };
    result: {
      scene?: Uint8Array | null;
      resourceBatch?: Uint8Array | null;
      unchanged?: boolean;
      // True when the scene consumer can sleep until a paintDirty event.
      idle?: boolean;
      seq?: number;
      partial?: boolean;
      clip?: { x: number; y: number; w: number; h: number } | null;
      shift?: { x: number; y: number };
      patches?: { clip: { x: number; y: number; w: number; h: number }; scene: Uint8Array }[];
      baseSeq?: number;
      scrollX?: number;
      scrollY?: number;
      error?: string;
      fallbackHtml?: string;
      damageCount?: number;
      layoutDirty?: boolean;
      skipReason?: string;
      pumped?: number;
      pumpMs?: number;
      nextRafDelayMs?: number;
    };
  };
  getPaintResources: {
    args: { imageHashes: Uint8Array; fontDataHashes: Uint8Array };
    result: { batch?: Uint8Array; error?: string };
  };
  // Resolve font bytes by URL or by the renderer's engine-keyed fallback.
  getFontUrlData: {
    args: { url?: string; key?: string };
    result: { bytes?: Uint8Array | null; error?: string };
  };
  recordPdfScenes: {
    args: {
      width: number;
      height: number;
      marginTop: number;
      marginRight: number;
      marginBottom: number;
      marginLeft: number;
    };
    result: { envelope?: Uint8Array; error?: string };
  };
  getOuterHTMLAndSeq: {
    args: EmptyArgs;
    result: { outerHTML: string; seq: number; scrollX: number; scrollY: number };
  };
  getMemoryStats: {
    args: EmptyArgs;
    result: {
      bytes?: number;
      initialBytes?: number;
      deltaBytes?: number;
    } & PageScriptGauges;
  };
  boaForceCollect: { args: EmptyArgs; result: BoaCollectStats };
  // Sets the live wasm bytes past which an allocation forces a boa swap round (core
  // swap_alloc.rs); zero turns it off. Replies with the allocator's gauges after.
  getFontFaces: { args: EmptyArgs; result: FontFaces };
  getMemprofDump: { args: EmptyArgs; result: { json?: string; error?: string } };
  resetMemprof: { args: EmptyArgs; result: { ok?: boolean; error?: string } };
  getSceneStats: {
    args: EmptyArgs;
    result: {
      seq?: number;
      scrollX?: number;
      scrollY?: number;
      prepMs?: number;
      recordMs?: number;
      statsJson?: string;
      error?: string;
    };
  };
  webmcpGetTools: {
    args: { watchRevision: number };
    result: { tools?: unknown; error?: string };
  };
  webmcpStopWatchingTools: {
    args: { watchRevision: number };
    result: EmptyArgs;
  };
  webmcpCallTool: {
    args: { name: string; args: unknown; invocationId: string };
    result: {
      content?: unknown;
      isError?: unknown;
      error?: string;
      threw?: unknown;
      notFound?: unknown;
      rawOutput?: unknown;
      output?: unknown;
    };
  };
  webmcpCancelTool: {
    args: { invocationId: string };
    result: { aborted?: boolean };
  };
}

type EmptyArgs = Record<string, never>;

// Read stamps bracket snapshots with mutationSeq to expose concurrent DOM changes.
type ReadStampArgs = { includeReadStamp?: boolean };

export interface PendingImageDrain {
  waited: boolean;
  timedOut: boolean;
  ms?: number;
  pending?: number;
  inflight?: number;
  resolves?: number;
  iterations?: number;
  iterTimes?: number[];
  fetchStats?: Record<string, number>;
}

export type QueryDomMethod = keyof QueryDomMethods;
export type QueryDomArgs<M extends QueryDomMethod> = QueryDomMethods[M]["args"];
export type QueryDomResult<M extends QueryDomMethod> = QueryDomMethods[M]["result"];
