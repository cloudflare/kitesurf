// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Deliberately unlinkable: the dep 404s, so this module parses and
// registers but never links — the stranded-module eviction case.
import { nothing } from "./interner-missing-dep.js";
export const value = nothing;
