// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The seed's own static subtree has to be crawled too, not just the seed.
import { part } from "./classic-seed-dep.js";

export const label = "chunk+" + part;
