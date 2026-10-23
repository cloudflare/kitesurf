// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Wasm exports for the Boa bridge, synchronous eval, and the DOM fast path.

use wasm_bindgen::prelude::*;

use crate::DomHandle;

#[wasm_bindgen]
pub async fn ks_spike_await(promise: js_sys::Promise) -> Result<JsValue, JsValue> {
    let v = wasm_bindgen_futures::JsFuture::from(promise).await?;
    let n = v.as_f64().unwrap_or(f64::NAN);
    Ok(JsValue::from_f64(n + 1.0))
}

#[wasm_bindgen]
pub fn ks_bridge_pins() -> String {
    let (v8, boa, wrappers, rel_v8, rel_boa) = super::boa_bridge::bridge_pin_stats();
    let (heap, threshold) = boa_engine::gc::heap_stats();
    let (interner_len, interner_reclaims, pending_mods, queue_idle) =
        super::boa_eval::interner_stats();
    let (reentry, reentry_max, unchaperoned) = super::boa_bridge::reentry_depth();
    let weak_boa = super::boa_bridge::weak_boa_live();
    // Pump gauges: a fetch whose `.then` never runs shows up here as
    // futures>0 with bgProgress flat (see boa_eval::pump_stats).
    let p = super::boa_eval::pump_stats();
    format!(
        "{{\"v8Pins\":{v8},\"boaPins\":{boa},\"wrappers\":{wrappers},\"weakBoa\":{weak_boa},\"releasedV8\":{rel_v8},\"releasedBoa\":{rel_boa},\"boaHeapBytes\":{heap},\"boaGcThreshold\":{threshold},\"internerLen\":{interner_len},\"internerReclaims\":{interner_reclaims},\"internerPendingMods\":{pending_mods},\"internerQueueIdle\":{queue_idle},\"ctxReentryDepth\":{reentry},\"ctxReentryMax\":{reentry_max},\"ctxUnchaperoned\":{unchaperoned},\"pumpPromiseJobs\":{},\"pumpFutures\":{},\"pumpDrainBusy\":{},\"pumpTicketWaiters\":{},\"bgTicks\":{},\"bgProgress\":{},\"bgLastTickMs\":{},\"healedAtEntry\":{}}}",
        p.promise_jobs,
        p.futures,
        p.drain_busy,
        p.ticket_waiters,
        p.bg_ticks,
        p.bg_progress,
        p.bg_last_tick_ms,
        super::boa_bridge::healed_at_entry(),
    )
}

/// Runs one epoch of the cross-heap cycle collector and returns its wall time in ms. With
/// `idle_skip`, an epoch whose inputs are unchanged is skipped and returns 0.
#[wasm_bindgen]
pub fn ks_cycle_collect(idle_skip: bool) -> f64 {
    super::boa_bridge::cycle_collect(idle_skip)
}

#[wasm_bindgen]
pub fn ks_cycle_stats() -> String {
    super::boa_bridge::cycle_stats()
}

#[wasm_bindgen]
pub fn ks_is_bridged(v: JsValue) -> bool {
    super::boa_bridge::is_our_wrapper(&v)
}

// Installed once at startup by page-script; the bridge falls back to building
// descriptors field by field when they are absent (the parent engine's instance).
#[wasm_bindgen]
pub fn ks_bridge_install_desc_helpers(data: js_sys::Function, accessor: js_sys::Function) {
    super::boa_bridge::install_desc_helpers(data, accessor);
}

// A boa-backed buffer source's bytes as a V8 Uint8Array, or undefined when the
// value is not one: jsg natives reject our proxies (TextDecoder.decode).
#[wasm_bindgen]
pub fn ks_bridge_buffer_bytes(v: JsValue) -> JsValue {
    super::boa_bridge::boa_buffer_bytes(&v).map_or(JsValue::UNDEFINED, Into::into)
}

// O(1) clone-shim gate: a page that never minted a wrapper skips the
// O(graph) pre-scan on every structuredClone outright.
#[wasm_bindgen]
pub fn ks_bridge_ever_minted() -> bool {
    super::boa_bridge::ever_minted()
}

#[wasm_bindgen]
pub fn ks_boa_force_collect() -> String {
    let before = boa_engine::gc::heap_stats();
    boa_engine::gc::force_collect();
    super::boa_bridge::drain_v8_release_queue();
    let after = boa_engine::gc::heap_stats();
    format!(
        "{{\"beforeBytes\":{},\"afterBytes\":{},\"threshold\":{}}}",
        before.0, after.0, after.1
    )
}

#[wasm_bindgen]
pub fn ks_eval_sync(src: &str) -> String {
    use boa_engine::{Context, Source};
    let mut ctx = Context::default();
    match ctx.eval(Source::from_bytes(src.as_bytes())) {
        Ok(v) => v.display().to_string(),
        Err(e) => format!("boa error: {}", e),
    }
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "fastpathBind")]
    pub fn fastpath_bind(
        &self,
        brand: js_sys::Function,
        revalidate: js_sys::Function,
        wrapper: js_sys::Function,
        peek: Option<js_sys::Function>,
        node_list: Option<js_sys::Function>,
    ) {
        super::dom_fastpath::bind(
            std::rc::Rc::downgrade(&self.doc),
            std::rc::Rc::downgrade(&self.node_handles),
            brand,
            revalidate,
            wrapper,
            peek,
            node_list,
        );
    }

    #[wasm_bindgen(js_name = "fastpathMarkSpecial")]
    pub fn fastpath_mark_special(&self, node_id: u32) {
        super::dom_fastpath::mark_special(node_id);
    }

    #[wasm_bindgen(js_name = "fastpathStats")]
    pub fn fastpath_stats(&self) -> String {
        super::dom_fastpath::stats_json()
    }
}
