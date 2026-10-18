// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! PageRenderer's trimmed Wasm entry point for scene replay, rasterization, and PDF output.

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(message: &str);
}

pub(crate) fn console_warn_str(message: &str) {
    console_warn(message);
}

mod paint;
#[path = "../../core/src/ks_tracing.rs"]
mod ks_tracing;

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    ks_tracing::init();
}
