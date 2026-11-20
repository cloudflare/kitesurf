// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// boa's code store (vendored boa ks_code_store) backed by JS functions page-script registers:
// a stateful page's facet SQLite, so cold source text leaves wasm memory, which never shrinks.

use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

struct JsCodeStore {
    min_bytes: usize,
    put: js_sys::Function,
    read: js_sys::Function,
    release: js_sys::Function,
    flush: js_sys::Function,
}

impl boa_engine::CodeStore for JsCodeStore {
    fn min_bytes(&self) -> usize {
        self.min_bytes
    }

    fn put(&self, bytes: &[u8]) -> Option<u32> {
        // SAFETY: the view is dropped before this returns, and the call below runs no wasm,
        // so linear memory cannot grow (detaching the view) while JS copies out of it.
        let view = unsafe { js_sys::Uint8Array::view(bytes) };
        let key = self.put.call1(&JsValue::UNDEFINED, &view).ok()?.as_f64()?;
        (key >= 0.0 && key.fract() == 0.0 && key <= f64::from(u32::MAX)).then_some(key as u32)
    }

    fn read(&self, key: u32, offset: usize, len: usize, out: &mut Vec<u8>) -> bool {
        let reply = self.read.call3(
            &JsValue::UNDEFINED,
            &JsValue::from_f64(f64::from(key)),
            &JsValue::from_f64(offset as f64),
            &JsValue::from_f64(len as f64),
        );
        let Ok(bytes) = reply.and_then(|v| v.dyn_into::<js_sys::Uint8Array>()) else {
            return false;
        };
        if bytes.length() as usize != len {
            return false;
        }
        out.clear();
        out.resize(len, 0);
        bytes.copy_to(out);
        true
    }

    fn release(&self, key: u32, len: usize) {
        let _ = self.release.call2(
            &JsValue::UNDEFINED,
            &JsValue::from_f64(f64::from(key)),
            &JsValue::from_f64(len as f64),
        );
    }

    fn flush(&self) {
        let _ = self.flush.call0(&JsValue::UNDEFINED);
    }
}

// Installed by page-script on a stateful page's facet, before page JS can run; anywhere
// else nothing is installed and every source text stays resident, as before.
#[wasm_bindgen]
pub fn ks_set_code_store(
    min_bytes: u32,
    put: Option<js_sys::Function>,
    read: Option<js_sys::Function>,
    release: Option<js_sys::Function>,
    flush: Option<js_sys::Function>,
) {
    let store = match (put, read, release, flush) {
        (Some(put), Some(read), Some(release), Some(flush)) => Some(Rc::new(JsCodeStore {
            min_bytes: min_bytes as usize,
            put,
            read,
            release,
            flush,
        })
            as Rc<dyn boa_engine::CodeStore>),
        _ => None,
    };
    // Always hooked, store or not: with no store the hook swaps nothing and returns 0, which
    // keeps one path for both cases.
    crate::swap_alloc::set_hook(Some(pressure_hook as fn() -> usize));
    boa_engine::ks_set_code_store(store);
}

// What an allocation under pressure runs: swap what it can. Without a store the swap is a
// no-op returning 0, which is every isolate that installed none.
fn pressure_hook() -> usize {
    boa_engine::ks_swap_under_pressure()
}

// Live wasm bytes past which an allocation first runs a forced swap round; page-script sets
// it with the store, and anything not a positive finite number turns it off.
#[wasm_bindgen]
pub fn ks_set_swap_budget(bytes: f64) {
    let budget = if bytes.is_finite() && bytes > 0.0 {
        bytes as usize
    } else {
        usize::MAX
    };
    crate::swap_alloc::set_budget(budget);
}
