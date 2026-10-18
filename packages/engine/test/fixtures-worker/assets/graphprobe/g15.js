// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { jsx } from './g-dep-fnprops.js';
export const value = jsx.Fragment === 'FRAG' ? jsx('p') : 'no-frag';
