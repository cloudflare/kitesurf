// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin

export type {
  BundleDiag,
  IframePost,
  KitesurfInternalState,
} from "../../page-script/src/internal-state";
export {
  createInternalState,
  getInternalState,
  sendUpstreamEvent,
  registerUpstreamSender,
  clearUpstreamSender,
  takeDocumentReopened,
} from "../../page-script/src/internal-state";
