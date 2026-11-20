// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Exports the DOM-shim factory and the types and helpers used by PageScript.

export type {
  AuthOffsetMetricsSnapshot,
  AuthRectSnapshot,
  AuthScrollInfoSnapshot,
  BuildDocumentOpts,
} from "./state.js";
export type { DomShimGlobals } from "./global-scope.js";
export type { ScrollIntoViewOptions } from "./idl/types.generated.js";
export {
  buildDocument,
  listModelContextTools,
  stopModelContextToolWatch,
  callModelContextTool,
  cancelModelContextTool,
  setModelContextTaskScheduler,
  setControlValueAsUser,
  decodeHtmlBytes,
  parseUrlForNode,
  setWrapperSweepScheduler,
  setAnimationTaskScheduler,
  setInlineHandlerGate,
  detachedWrapperStats,
  armKsOtel,
  ksSpan,
} from "./index.js";

export type BuildDocumentResult = ReturnType<typeof import("./index.js").buildDocument>;
