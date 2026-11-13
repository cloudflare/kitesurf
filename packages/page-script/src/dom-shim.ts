// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the runtime-resolved sibling `./dom-shim.js`.
// Type-only twin for the external runtime module supplied through Worker Loader.
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
  activationListenerNodeIds,
  armKsOtel,
  ksSpan,
} from "@kitesurf/dom-shim/contract";
export type {
  BuildDocumentOpts,
  BuildDocumentResult,
  DomShimGlobals,
  ScrollIntoViewOptions,
} from "@kitesurf/dom-shim/contract";
