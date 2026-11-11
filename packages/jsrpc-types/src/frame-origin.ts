// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A committed document origin, as the engine's trusted frame ancestry reports it. An opaque
// origin keeps a distinct identity: two opaque origins never compare equal just because both
// serialize as "null".

export type CommittedOrigin =
  | { readonly kind: "tuple"; readonly origin: string }
  | { readonly kind: "opaque"; readonly id: string };
