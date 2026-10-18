// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { RenderFrameOpts, RenderPdfOpts } from "@kitesurf/jsrpc-types/page-renderer";

const frameOptions: RenderFrameOpts = {
  format: "png",
  quality: 80,
  omitBackground: false,
};

const malformedFrameOptions: RenderFrameOpts = {
  ...frameOptions,
  // @ts-expect-error Frame options reject unsupported fields.
  unsupported: true,
};
void malformedFrameOptions;

const pdfOptions: RenderPdfOpts = {
  paperWidth: 816,
  paperHeight: 1056,
  omitBackground: false,
  marginTop: 0,
  marginRight: 0,
  marginBottom: 0,
  marginLeft: 0,
};

const malformedPdfOptions: RenderPdfOpts = {
  ...pdfOptions,
  // @ts-expect-error PDF options reject unsupported fields.
  unsupported: true,
};
void malformedPdfOptions;
