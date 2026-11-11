// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The iframe sandbox capabilities this engine models. Type-only, and free of the worker globals
// page-script.ts declares, so the engine, the in-isolate page script and the shared script gate
// all carry one copy. A token the model does not name grants nothing, and a missing attribute
// grants every field.

export interface SandboxRestrictions {
  /** allow-scripts: page-authored script may run. */
  scripts: boolean;
  /** allow-same-origin: the frame keeps its URL's origin instead of an opaque one. */
  sameOrigin: boolean;
  /** allow-forms: form submission may navigate. */
  forms: boolean;
  /** allow-top-navigation: the frame may navigate the top-level document. */
  topNavigation: boolean;
}
