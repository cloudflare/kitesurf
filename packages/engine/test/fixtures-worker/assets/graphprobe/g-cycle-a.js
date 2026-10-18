// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { fromB } from './g-cycle-b.js';
export function fromA() { return 'A'; }
export function viaB() { return fromB() + '+A'; }
