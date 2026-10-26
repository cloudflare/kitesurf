// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The internals record page-script publishes at `globalThis[Symbol.for("kitesurf.internals")]`
//! (internal-state.ts): the hooks the wasm calls back into the page isolate through. Absent in
//! the parent engine isolate, where every lookup returns `None` and callers fall back.

use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::JsValue;

thread_local! {
    // The record is a non-configurable global, so the first hit stays valid for the isolate's
    // lifetime. A miss is not cached: the parent never publishes one, and a lookup is cheap.
    static RECORD: RefCell<Option<JsValue>> = const { RefCell::new(None) };
    // Field names as V8 strings, decoded once per isolate.
    static KEYS: RefCell<HashMap<&'static str, JsValue>> = RefCell::new(HashMap::new());
}

fn record() -> Option<JsValue> {
    if let Some(found) = RECORD.with(|cell| cell.borrow().clone()) {
        return Some(found);
    }
    let key = js_sys::Symbol::for_("kitesurf.internals");
    let found = js_sys::Reflect::get(&js_sys::global(), &key)
        .ok()
        .filter(JsValue::is_object)?;
    RECORD.with(|cell| *cell.borrow_mut() = Some(found.clone()));
    Some(found)
}

/// One field of the record, or `None` when it is unset. Read on every call, not cached: the
/// record's fields stay writable, and boa-ctx-reentry stubs `wrapBoaFunction`.
pub(crate) fn get(name: &'static str) -> Option<JsValue> {
    let record = record()?;
    let key = KEYS.with(|keys| {
        keys.borrow_mut()
            .entry(name)
            .or_insert_with(|| JsValue::from_str(name))
            .clone()
    });
    js_sys::Reflect::get(&record, &key)
        .ok()
        .filter(|value| !value.is_undefined())
}
