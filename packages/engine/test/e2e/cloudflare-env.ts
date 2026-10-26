// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

type FetchBinding = { fetch: typeof fetch };

declare global {
  namespace Cloudflare {
    interface Env {
      ENGINE: FetchBinding;
      ENGINE_NO_INSPECTOR: FetchBinding;
      ENGINE_SAME_ORIGIN_INSPECTOR: FetchBinding;
      OTLP_CAPTURE: FetchBinding;
      CORE_WASM: FetchBinding;
      SCENE_HOST_WASM: FetchBinding;
    }
  }
}

export {};
