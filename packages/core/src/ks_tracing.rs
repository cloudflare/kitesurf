// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Sends Wasm tracing spans through the host callback with the engine trace parent.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opentelemetry::trace::{
    SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState, TracerProvider as _,
};
use opentelemetry::{Context, ContextGuard, Value};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{SdkTracerProvider, Span, SpanData, SpanProcessor};
use tracing::{Metadata, Subscriber};
use tracing_core::Interest;
use tracing_subscriber::layer::{Context as LayerContext, Layer, SubscriberExt};
use wasm_bindgen::prelude::*;

static ENABLED: AtomicBool = AtomicBool::new(false);

static ENGINE_PARENT: Mutex<String> = Mutex::new(String::new());

thread_local! {
    static AMBIENT: RefCell<Option<ContextGuard>> = const { RefCell::new(None) };

    static EMIT_HOOK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

#[wasm_bindgen]
pub fn ks_set_emit_hook(f: Option<js_sys::Function>) {
    EMIT_HOOK.with(|h| *h.borrow_mut() = f);
}

fn syn_trace_id() -> TraceId {
    static ID: OnceLock<TraceId> = OnceLock::new();
    *ID.get_or_init(|| {
        let mut b = [0u8; 16];
        let _ = getrandom::getrandom(&mut b);
        b[0] |= 1;
        TraceId::from_bytes(b)
    })
}

fn refresh_ambient() {
    let hex = ENGINE_PARENT.lock().unwrap().clone();
    AMBIENT.with(|g| {
        *g.borrow_mut() = None;
        let Ok(span_id) = SpanId::from_hex(&hex) else {
            return;
        };
        if span_id == SpanId::INVALID {
            return;
        }
        let sc = SpanContext::new(
            syn_trace_id(),
            span_id,
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );
        let cx = Context::new().with_remote_span_context(sc);
        *g.borrow_mut() = Some(cx.attach());
    });
}

#[wasm_bindgen]
pub fn set_ks_trace_parent(span_id_hex: &str) {
    {
        let mut g = ENGINE_PARENT.lock().unwrap();
        g.clear();
        g.push_str(span_id_hex);
    }
    refresh_ambient();
}

thread_local! {
    static JS_SPANS: RefCell<Vec<Option<tracing::span::EnteredSpan>>> =
        const { RefCell::new(Vec::new()) };
}

#[wasm_bindgen]
pub fn ks_js_span_enter(op: &str, bytes: f64, detail: &str) -> u32 {
    let span = tracing::info_span!(
        "dom.op",
        op = %op,
        bytes = tracing::field::Empty,
        detail = tracing::field::Empty,
    );
    if bytes >= 0.0 {
        span.record("bytes", bytes as u64);
    }
    if !detail.is_empty() {
        span.record("detail", detail);
    }
    let entered = span.entered();
    JS_SPANS.with(|s| {
        let mut v = s.borrow_mut();
        if let Some(i) = v.iter().position(Option::is_none) {
            v[i] = Some(entered);
            i as u32
        } else {
            v.push(Some(entered));
            (v.len() - 1) as u32
        }
    })
}

#[wasm_bindgen]
pub fn ks_js_span_exit(slot: u32) {
    JS_SPANS.with(|s| {
        let mut v = s.borrow_mut();
        if let Some(e) = v.get_mut(slot as usize) {
            *e = None;
        }
    });
}

#[wasm_bindgen]
pub fn set_ks_tracing(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

struct GateLayer;

impl<S: Subscriber> Layer<S> for GateLayer {
    fn register_callsite(&self, _meta: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }
    fn enabled(&self, _meta: &Metadata<'_>, _ctx: LayerContext<'_, S>) -> bool {
        ENABLED.load(Ordering::Relaxed)
    }
}

fn otlp_value(v: &Value) -> serde_json::Value {
    match v {
        Value::Bool(b) => serde_json::json!({ "boolValue": b }),
        Value::I64(i) => serde_json::json!({ "intValue": i.to_string() }),
        Value::F64(f) => serde_json::json!({ "doubleValue": f }),
        Value::String(s) => serde_json::json!({ "stringValue": s.as_str() }),
        other => serde_json::json!({ "stringValue": other.to_string() }),
    }
}

fn nanos(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
}

#[derive(Debug)]
struct KsProcessor;

impl SpanProcessor for KsProcessor {
    fn on_start(&self, _span: &mut Span, _cx: &Context) {}

    fn on_end(&self, span: SpanData) {
        let op_name = span.attributes.iter().find_map(|kv| {
            (span.name.as_ref() == "dom.op" && kv.key.as_str() == "op")
                .then(|| kv.value.to_string())
        });
        let attributes: Vec<serde_json::Value> = span
            .attributes
            .iter()
            .filter(|kv| !(op_name.is_some() && kv.key.as_str() == "op"))
            .map(|kv| {
                let (key, value) = (&kv.key, &kv.value);
                serde_json::json!({ "key": key.as_str(), "value": otlp_value(value) })
            })
            .collect();
        let parent =
            (span.parent_span_id != SpanId::INVALID).then(|| span.parent_span_id.to_string());
        let json = serde_json::json!({
            "name": op_name.as_deref().unwrap_or(span.name.as_ref()),
            "traceId": span.span_context.trace_id().to_string(),
            "spanId": span.span_context.span_id().to_string(),
            "parentSpanId": parent,
            "startTimeUnixNano": nanos(span.start_time).to_string(),
            "endTimeUnixNano": nanos(span.end_time).to_string(),
            "attributes": attributes,
        });
        let line = json.to_string();
        let hooked = EMIT_HOOK.with(|h| {
            if let Some(f) = h.borrow().as_ref() {
                f.call1(&JsValue::NULL, &JsValue::from_str(&line)).is_ok()
            } else {
                false
            }
        });
        if !hooked {
            console_log(&format!("[ks-otel-span] {line}"));
        }
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }
}

pub fn init() {
    let provider = SdkTracerProvider::builder()
        .with_span_processor(KsProcessor)
        .build();
    let tracer = provider.tracer("kitesurf-wasm");
    let layer = tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_context_activation(false)
        .with_threads(false)
        .with_target(false);
    let subscriber = tracing_subscriber::registry().with(GateLayer).with(layer);
    let _ = tracing::subscriber::set_global_default(subscriber);
    // The provider must outlive the layer's tracer; parking a clone in
    // a static keeps shutdown (and exporter teardown) from ever firing.
    static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();
    let _ = PROVIDER.set(provider);
}
