// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export const lib = "lib:" + import.meta.url;

export let count = 0;
export function incrementCount() {
  count += 1;
}

export let initializedValue;
export function setInitializedValue(value) {
  initializedValue = value;
}
