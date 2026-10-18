// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export const metaUrl = import.meta.url;
export const assetUrl = new URL('./importmeta-asset.png', import.meta.url).href;
export const resolvedUrl = import.meta.resolve('./importmeta-asset.png');
export const bareError = (() => { try { import.meta.resolve('bare-pkg'); return null; } catch (e) { return e.name; } })();
