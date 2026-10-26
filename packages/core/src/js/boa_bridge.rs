// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Bridges Boa values, callbacks, and promise jobs to the V8-backed page isolate.

use std::cell::RefCell;
use std::rc::Rc;

use boa_engine::{
    builtins::{object::OrdinaryObject, promise::ResolvingFunctions},
    job::{Job, NativeAsyncJob, PromiseJob},
    js_string,
    native_function::{NativeFunction, NativeFunctionPointer},
    object::{
        builtins::{JsArray, JsFunction, JsPromise},
        FunctionObjectBuilder, JsObject,
    },
    property::{PropertyDescriptor, PropertyKey},
    value::JsVariant,
    Context, JsError, JsNativeError, JsResult, JsString, JsSymbol, JsValue as BoaValue,
};

// A runtime-limit (engine) error has no JS value, so page code cannot catch boa's
// recursion guard; hand V8 a plain Error so the callback fails, not the trampoline.
fn error_to_v8(e: &JsError, ctx: &mut Context) -> wasm_bindgen::JsValue {
    match e.clone().into_opaque(ctx) {
        Ok(v) => boa_to_v8(&v, ctx),
        Err(_) => js_sys::Error::new(&format!("kitesurf boa: {e}")).into(),
    }
}
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

thread_local! {
    static CTX: std::cell::Cell<*mut Context> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

pub(crate) struct CtxPtrGuard(*mut Context, u64);

impl Drop for CtxPtrGuard {
    fn drop(&mut self) {
        CTX.with(|c| c.set(self.0));
        PUB_DEPTH.with(|d| d.set(self.1));
    }
}

pub(crate) fn set_context_ptr(ptr: *mut Context) -> CtxPtrGuard {
    let prev = CTX.with(|c| c.replace(ptr));
    let prev_pub = PUB_DEPTH.with(|d| d.replace(d.get() + 1));
    CtxPtrGuard(prev, prev_pub)
}

pub(crate) fn set_baseline_context_ptr(ptr: *mut Context) {
    CTX.with(|c| c.set(ptr));
}

pub(crate) fn context_ptr() -> *mut Context {
    CTX.with(|c| c.get())
}

pub(crate) fn with_context<R>(f: impl FnOnce(&mut Context) -> R) -> Option<R> {
    let ptr = CTX.with(|c| c.get());
    if ptr.is_null() {
        return None;
    }
    crate::js::dom_fastpath::arm_v8_ran();
    let _depth = DepthGuard::enter();
    // A nested entry without a new publication means a V8 call skipped
    // `with_v8`, which would alias a live `&mut Context`.
    if REENTRY_DEPTH.with(std::cell::Cell::get) > 1
        && PUB_DEPTH.with(std::cell::Cell::get) == FRAME_PUB.with(std::cell::Cell::get)
    {
        UNCHAPERONED.with(|u| u.set(u.get() + 1));
    }
    let ctx: &mut Context =
        // SAFETY: single-threaded wasm, and CTX always holds a pointer
        // whose provenance covers the whole Context allocation (the
        // persistent context is `Box::into_raw`'d, never re-boxed).
        //
        // Exclusivity — the property the old comment omitted, and the
        // one this bridge cannot get by simply refusing to nest, since
        // re-entry is a capability it DEPENDS on: `trap_get` holds boa's
        // `&mut Context` while it calls `Reflect::get` on a V8 value
        // that may be a boa-backed V8 Proxy, whose `shim_get` lands
        // back here. So the nested borrow must be a REBORROW of the
        // live one rather than a second sibling derived off the same
        // stale pointer, which is what made this UB.
        //
        // The discipline that buys that: every boa->V8 call that can
        // run page-reachable JS goes through `with_v8`, which publishes
        // a pointer DERIVED FROM the `&mut Context` it is handed and
        // restores the previous one on the way out (panic-safe; panics unwind
        // here). Its signature also mutably
        // borrows that reference for the span of the excursion, so the
        // borrow checker — not a comment — is what stops the outer
        // frame touching the Context while a nested borrow is alive.
        //
        // Result: reads of CTX only ever see a pointer derived from the
        // innermost live reference, so every `&mut Context` on the
        // stack is an ancestor of the ones below it. Properly nested
        // reborrows, and `noalias` on each of them holds.
        unsafe { &mut *ptr };
    let _pubd = set_context_ptr(ctx as *mut Context);
    let _frame = FramePubGuard::own();
    Some(f(ctx))
}

pub(crate) fn with_v8<R>(ctx: &mut Context, f: impl FnOnce() -> R) -> R {
    let _g = set_context_ptr(ctx as *mut Context);
    let r = f();
    crate::js::dom_fastpath::arm_v8_ran();
    r
}

pub(crate) fn with_v8_quiet<R>(ctx: &mut Context, f: impl FnOnce() -> R) -> R {
    let _g = set_context_ptr(ctx as *mut Context);
    f()
}

// Tracks live Context borrows; Drop restores the depth during unwind.
// `heal_at_entry` only reclaims residual values on the outermost entry.
thread_local! {
    static REENTRY_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static REENTRY_MAX: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static PUB_DEPTH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static FRAME_PUB: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static UNCHAPERONED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

struct FramePubGuard(u64);

impl FramePubGuard {
    fn own() -> Self {
        FramePubGuard(FRAME_PUB.with(|f| f.replace(PUB_DEPTH.with(std::cell::Cell::get))))
    }
}

impl Drop for FramePubGuard {
    fn drop(&mut self) {
        FRAME_PUB.with(|f| f.set(self.0));
    }
}

pub(crate) struct DepthGuard;

impl DepthGuard {
    pub(crate) fn enter() -> Self {
        let d = REENTRY_DEPTH.with(|d| {
            d.set(d.get() + 1);
            d.get()
        });
        REENTRY_MAX.with(|m| {
            if d > m.get() {
                m.set(d);
            }
        });
        DepthGuard
    }
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        REENTRY_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
    }
}

pub(crate) fn reentry_depth() -> (u32, u32, u64) {
    (
        REENTRY_DEPTH.with(std::cell::Cell::get),
        REENTRY_MAX.with(std::cell::Cell::get),
        UNCHAPERONED.with(std::cell::Cell::get),
    )
}

thread_local! {
    static BOA_STRICT: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

pub(crate) fn set_boa_strict(v: bool) {
    BOA_STRICT.with(|c| c.set(v));
}

fn boa_strict() -> bool {
    BOA_STRICT.with(|c| c.get())
}

struct PinSlab<T> {
    entries: Vec<(u32, Option<T>)>,
    free: Vec<u32>,
    released: u64,
}

const PIN_GEN_MASK: u32 = 0xf_ffff;

impl<T: Clone> PinSlab<T> {
    const fn new() -> Self {
        PinSlab {
            entries: Vec::new(),
            free: Vec::new(),
            released: 0,
        }
    }
    fn insert(&mut self, v: T) -> u64 {
        if let Some(i) = self.free.pop() {
            let e = &mut self.entries[i as usize];
            e.1 = Some(v);
            return (((e.0 & PIN_GEN_MASK) as u64) << 32) | i as u64;
        }
        let i = self.entries.len() as u32;
        self.entries.push((0, Some(v)));
        i as u64
    }
    fn get(&self, h: u64) -> Option<T> {
        let e = self.entries.get((h & 0xffff_ffff) as usize)?;
        if e.0 & PIN_GEN_MASK != (h >> 32) as u32 {
            return None;
        }
        e.1.clone()
    }
    fn release(&mut self, h: u64) -> Option<T> {
        let i = (h & 0xffff_ffff) as usize;
        let e = self.entries.get_mut(i)?;
        if e.0 & PIN_GEN_MASK != (h >> 32) as u32 || e.1.is_none() {
            return None;
        }
        let v = e.1.take();
        e.0 = e.0.wrapping_add(1);
        self.free.push(i as u32);
        self.released += 1;
        v
    }
    fn replace(&mut self, h: u64, v: T) -> Option<T> {
        let i = (h & 0xffff_ffff) as usize;
        let e = self.entries.get_mut(i)?;
        if e.0 & PIN_GEN_MASK != (h >> 32) as u32 {
            return None;
        }
        let current = e.1.as_mut()?;
        Some(std::mem::replace(current, v))
    }
    fn live(&self) -> usize {
        self.entries.len() - self.free.len()
    }
}

thread_local! {
    static V8: RefCell<PinSlab<wasm_bindgen::JsValue>> = const { RefCell::new(PinSlab::new()) };
}

pub(crate) fn ever_minted() -> bool {
    BOA.with(|t| {
        let t = t.borrow();
        t.live() > 0 || t.released > 0
    })
}

pub(crate) fn bridge_pin_stats() -> (usize, usize, usize, u64, u64) {
    (
        V8.with(|t| t.borrow().live()),
        BOA.with(|t| t.borrow().live()),
        BOA_V8.with(|t| t.borrow().live()),
        V8.with(|t| t.borrow().released),
        BOA.with(|t| t.borrow().released),
    )
}

// WeakRef and FinalizationRegistry are optional. Without them, pins remain
// alive until the isolate is destroyed.
struct WeakRt {
    weakref_ctor: js_sys::Function,
    weakref_deref: js_sys::Function,
    registry: wasm_bindgen::JsValue,
    register: js_sys::Function,
}

thread_local! {
    static WEAK_RT: RefCell<Option<Option<WeakRt>>> = const { RefCell::new(None) };
}

fn weak_rt_init() -> Option<WeakRt> {
    let g: wasm_bindgen::JsValue = js_sys::global().into();
    let wr = js_sys::Reflect::get(&g, &wasm_bindgen::JsValue::from_str("WeakRef"))
        .ok()?
        .dyn_into::<js_sys::Function>()
        .ok()?;
    let proto = js_sys::Reflect::get(&wr, &wasm_bindgen::JsValue::from_str("prototype")).ok()?;
    let deref = js_sys::Reflect::get(&proto, &wasm_bindgen::JsValue::from_str("deref"))
        .ok()?
        .dyn_into::<js_sys::Function>()
        .ok()?;
    let frc = js_sys::Reflect::get(&g, &wasm_bindgen::JsValue::from_str("FinalizationRegistry"))
        .ok()?
        .dyn_into::<js_sys::Function>()
        .ok()?;
    // One registry per isolate; its Rust callback is a deliberate,
    // bounded leak (a single Closure for the isolate's lifetime).
    let cb = Closure::<dyn FnMut(wasm_bindgen::JsValue)>::new(finalize_held);
    let registry = js_sys::Reflect::construct(&frc, &js_sys::Array::of1(cb.as_ref())).ok()?;
    cb.forget();
    let register = js_sys::Reflect::get(&registry, &wasm_bindgen::JsValue::from_str("register"))
        .ok()?
        .dyn_into::<js_sys::Function>()
        .ok()?;
    Some(WeakRt {
        weakref_ctor: wr,
        weakref_deref: deref,
        registry,
        register,
    })
}

fn log_missing_weak_runtime() {
    let g: wasm_bindgen::JsValue = js_sys::global().into();
    let Ok(console) = js_sys::Reflect::get(&g, &wasm_bindgen::JsValue::from_str("console")) else {
        return;
    };
    let Ok(err) = js_sys::Reflect::get(&console, &wasm_bindgen::JsValue::from_str("error")) else {
        return;
    };
    let Some(f) = err.dyn_ref::<js_sys::Function>() else {
        return;
    };
    let _ = f.call1(
        &console,
        &wasm_bindgen::JsValue::from_str(
            "[kitesurf] FinalizationRegistry/WeakRef missing — bridge \
             pin eviction DISABLED; long-dwelling boa pages will leak \
             to the isolate memory cap",
        ),
    );
}

fn with_weak_rt<R>(f: impl FnOnce(&WeakRt) -> R) -> Option<R> {
    WEAK_RT.with(|c| {
        let mut b = c.borrow_mut();
        if b.is_none() {
            let rt = weak_rt_init();
            // Loud, once: without the weak machinery every crossing is
            // immortal again and boa-heavy pages OOM the isolate cap.
            if rt.is_none() {
                log_missing_weak_runtime();
            }
            *b = Some(rt);
        }
        b.as_ref().unwrap().as_ref().map(f)
    })
}

fn weak_available() -> bool {
    with_weak_rt(|_| ()).is_some()
}

fn make_weak(v: &wasm_bindgen::JsValue) -> Option<wasm_bindgen::JsValue> {
    with_weak_rt(|rt| js_sys::Reflect::construct(&rt.weakref_ctor, &js_sys::Array::of1(v)).ok())
        .flatten()
}

fn weak_deref(w: &wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    with_weak_rt(|rt| {
        rt.weakref_deref
            .call0(w)
            .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
    })
    .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

// Watch a minted wrapper: when V8 collects it, release the boa pin
// (+ its wrapper-cache slot) so boa GC can reclaim the object graph.
fn fr_register(wrapper: &wasm_bindgen::JsValue, boa_pin: u64, wrapper_slot: Option<u64>) {
    let watched = match wrapper_slot {
        // boa_v8_store already holds this wrapper in a WeakRef.
        Some(slot) if weak_available() => Some(PinWrapper::Slot(slot)),
        _ => make_weak(wrapper).map(PinWrapper::Weak),
    };
    if let Some(w) = watched {
        PIN_WRAPPER.with(|m| m.borrow_mut().insert(boa_pin, w));
        CC.with(|s| s.borrow_mut().wrapper_gen += 1);
    }
    let _ = with_weak_rt(|rt| {
        let held = js_sys::Array::of2(
            &wasm_bindgen::JsValue::from_f64(boa_pin as f64),
            &wasm_bindgen::JsValue::from_f64(wrapper_slot.map(|h| h as f64).unwrap_or(-1.0)),
        );
        let _ = rt.register.call2(&rt.registry, wrapper, &held);
    });
}

// Runs as its own V8 job, never inside a synchronous bridge call, so
// the slab borrows here can't collide with an in-flight crossing.
fn finalize_held(held: wasm_bindgen::JsValue) {
    drain_v8_releases();
    let arr: &js_sys::Array = held.unchecked_ref();
    let boa_pin = arr.get(0).as_f64().unwrap_or(-1.0);
    let slot = arr.get(1).as_f64().unwrap_or(-1.0);
    if boa_pin >= 0.0 {
        let pin = boa_pin as u64;
        BOA.with(|t| {
            t.borrow_mut().release(pin);
        });
        SLOTTED.with(|s| s.borrow_mut().remove(&pin));
        let watched = PIN_WRAPPER.with(|m| m.borrow_mut().remove(&pin)).is_some();
        CC.with(|s| {
            let mut s = s.borrow_mut();
            s.pin_comp.remove(&pin);
            if watched {
                s.wrapper_gen += 1;
            }
        });
    }
    if slot >= 0.0 {
        BOA_V8.with(|t| {
            t.borrow_mut().release(slot as u64);
        });
    }
}

// A V8 pin releases when Boa collects its proxy. Drop only queues the handle
// because JS cannot run during a GC sweep; the next bridge entry drains it.
thread_local! {
    static V8_RELEASE_QUEUE: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

struct KsV8Release {
    handle: u64,
}
impl boa_engine::gc::Finalize for KsV8Release {}
// SAFETY: no GC-managed fields to trace. The trace hook only records the
// handle while the cycle collector's census runs, and never touches the heap.
unsafe impl boa_engine::gc::Trace for KsV8Release {
    unsafe fn trace(&self, _tracer: &mut boa_engine::gc::Tracer) {
        CENSUS_SINK.with(|s| {
            if let Some(v) = s.borrow_mut().as_mut() {
                v.push(self.handle);
            }
        });
    }
    unsafe fn trace_non_roots(&self) {}
    fn run_finalizer(&self) {
        boa_engine::gc::Finalize::finalize(self);
    }
}

thread_local! {
    static CENSUS_SINK: RefCell<Option<Vec<u64>>> = const { RefCell::new(None) };
}

// Each heap pins what it hands the other, so a cycle through the seam is invisible to both GCs.
// The collector hands V8 the boa-unreachable ("gray") graph as keeper ephemerons on the gray pins'
// wrappers and weakens those V8 pins, turning the cycle V8-only. Any re-entry (get_boa, get_v8,
// an identity-cache hit) makes its component strong again first.
#[derive(Default)]
struct CycleState {
    comps: Vec<Vec<u64>>,
    pin_comp: rustc_hash::FxHashMap<u64, usize>,
    // V8 handles whose slab entry holds a WeakRef. None: the object is gone.
    weak: rustc_hash::FxHashMap<u64, Option<usize>>,
    keepers: Option<js_sys::WeakMap>,
    runs: u64,
    weakened: u64,
    revoked: u64,
    dead_reads: u64,
    last_gray_pins: usize,
    last_ms: f64,
    idle_sig: Option<[u64; 9]>,
    skipped: u64,
    gray_sig: Option<u64>,
    idle_streak: u32,
    backoff_ticks: u32,
    // Bumped whenever a pin's watched wrapper is added or dropped.
    wrapper_gen: u64,
    epoch_wrapper_gen: u64,
    epoch_revoked: u64,
    carried: u64,
}

// Each epoch that rebuilds the previous gray graph doubles the wait before the next, up to 2^4
// ticks; a different graph resets it. Skipping only keeps pins strong longer, so a cycle formed
// meanwhile is collected late, not leaked.
const CC_MAX_IDLE_SHIFT: u32 = 4;

fn gray_graph_sig(g: &GrayGraph) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = rustc_hash::FxHasher::default();
    g.pins.hash(&mut h);
    g.handles.hash(&mut h);
    g.children.hash(&mut h);
    h.finish()
}

thread_local! {
    static CC: RefCell<CycleState> = RefCell::new(CycleState::default());
    static CC_ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    // Boa pin -> the V8 wrapper whose death releases it, held weakly.
    static PIN_WRAPPER: RefCell<rustc_hash::FxHashMap<u64, PinWrapper>> =
        RefCell::new(rustc_hash::FxHashMap::default());
}

enum PinWrapper {
    // The wrapper's BOA_V8 identity-cache slot, released together with the pin.
    Slot(u64),
    Weak(wasm_bindgen::JsValue),
}

fn pin_wrapper(pin: u64) -> Option<wasm_bindgen::JsValue> {
    let weak = PIN_WRAPPER.with(|m| match m.borrow().get(&pin)? {
        PinWrapper::Slot(slot) => BOA_V8.with(|t| t.borrow().get(*slot)),
        PinWrapper::Weak(w) => Some(w.clone()),
    })?;
    Some(weak_deref(&weak))
}

fn cc_weak_state(h: u64) -> Option<Option<usize>> {
    if !CC_ACTIVE.with(std::cell::Cell::get) {
        return None;
    }
    CC.with(|s| s.borrow().weak.get(&h).copied())
}

fn cc_sync_active() {
    CC.with(|s| CC_ACTIVE.with(|a| a.set(!s.borrow().weak.is_empty())));
}

// Make a component strong again. A pin whose object V8 already collected
// stays weak (and dead) until its sentinel releases the slot.
fn cc_revoke(c: usize) {
    let hs = CC.with(|s| {
        s.borrow_mut()
            .comps
            .get_mut(c)
            .map(std::mem::take)
            .unwrap_or_default()
    });
    if hs.is_empty() {
        return;
    }
    for h in hs {
        if !CC.with(|s| s.borrow().weak.contains_key(&h)) {
            continue;
        }
        let target = V8
            .with(|t| t.borrow().get(h))
            .map(|w| weak_deref(&w))
            .filter(|v| !v.is_undefined());
        CC.with(|s| {
            let mut s = s.borrow_mut();
            match target {
                Some(v) => {
                    V8.with(|t| t.borrow_mut().replace(h, v));
                    s.weak.remove(&h);
                }
                None => {
                    s.weak.insert(h, None);
                }
            }
        });
    }
    CC.with(|s| s.borrow_mut().revoked += 1);
    cc_sync_active();
}

fn cc_touch_v8(h: u64) {
    if let Some(Some(c)) = cc_weak_state(h) {
        cc_revoke(c);
    }
}

fn cc_touch_pin(pin: u64) {
    if !CC_ACTIVE.with(std::cell::Cell::get) {
        return;
    }
    if let Some(c) = CC.with(|s| s.borrow().pin_comp.get(&pin).copied()) {
        cc_revoke(c);
    }
}

use crate::js::boa_cc_graph::{condense, GrayGraph};

fn gray_graph() -> GrayGraph {
    use std::collections::{HashMap, HashSet};
    let registered: HashSet<u64> = PIN_WRAPPER.with(|m| m.borrow().keys().copied().collect());
    BOA.with(|t| {
        let t = t.borrow();
        // Only pins a wrapper's death can release are discounted; any other
        // pin is permanent, so it stays a root.
        let mut pins = Vec::new();
        let mut keys = Vec::new();
        for (i, (gen, o)) in t.entries.iter().enumerate() {
            let Some(o) = o else { continue };
            let h = ((u64::from(*gen & PIN_GEN_MASK)) << 32) | i as u64;
            if registered.contains(&h) {
                pins.push(h);
                keys.push(o.census_key());
            }
        }
        CENSUS_SINK.with(|s| *s.borrow_mut() = Some(Vec::new()));
        // SAFETY: every key is the census key of a live pin box in `t.entries`.
        // `t` stays borrowed for the whole census, so nothing is swept or freed.
        let graph = unsafe {
            boa_engine::gc::census(&keys, |c| {
                let rooted: HashSet<u64> = CENSUS_SINK
                    .with(|s| s.borrow_mut().take())
                    .unwrap_or_default()
                    .into_iter()
                    .collect();
                let mut index: HashMap<boa_engine::gc::CensusKey, usize> = HashMap::new();
                let mut nodes: Vec<boa_engine::gc::CensusKey> = Vec::new();
                let mut edges: Vec<Vec<usize>> = Vec::new();
                let mut owned: Vec<Vec<u64>> = Vec::new();
                let mut gray_pins: Vec<(u64, usize)> = Vec::new();
                let mut stack = Vec::new();
                for (pin, key) in pins.iter().zip(&keys) {
                    // `keys` keeps each pin handle live for the census.
                    if c.is_marked(*key) {
                        continue;
                    }
                    let start = match index.get(key) {
                        Some(&n) => n,
                        None => {
                            index.insert(*key, nodes.len());
                            nodes.push(*key);
                            edges.push(Vec::new());
                            owned.push(Vec::new());
                            stack.push(nodes.len() - 1);
                            nodes.len() - 1
                        }
                    };
                    gray_pins.push((*pin, start));
                    while let Some(x) = stack.pop() {
                        CENSUS_SINK.with(|s| *s.borrow_mut() = Some(Vec::new()));
                        // `nodes` only holds keys of live boxes reached from `keys`.
                        let kids = c.children(nodes[x]);
                        let hs = CENSUS_SINK
                            .with(|s| s.borrow_mut().take())
                            .unwrap_or_default();
                        owned[x] = hs.into_iter().filter(|h| !rooted.contains(h)).collect();
                        for kid in kids {
                            // A child of a live box is live.
                            if c.is_marked(kid) {
                                continue;
                            }
                            let y = match index.get(&kid) {
                                Some(&y) => y,
                                None => {
                                    index.insert(kid, nodes.len());
                                    nodes.push(kid);
                                    edges.push(Vec::new());
                                    owned.push(Vec::new());
                                    stack.push(nodes.len() - 1);
                                    nodes.len() - 1
                                }
                            };
                            edges[x].push(y);
                        }
                    }
                }
                condense(gray_pins, &edges, owned)
            })
        };
        CENSUS_SINK.with(|s| *s.borrow_mut() = None);
        graph
    })
}

// Everything an epoch's result depends on. New gray garbage needs a boa
// allocation (heap bytes), a pin or wrapper change, a release, or a
// revocation, so an unchanged signature means the last epoch's weakening
// still stands and a rerun would only redo it.
fn cc_idle_sig() -> [u64; 9] {
    let (v8, boa, wrappers, rel_v8, rel_boa) = bridge_pin_stats();
    let heap = boa_engine::gc::heap_stats().0 as u64;
    [
        v8 as u64,
        boa as u64,
        wrappers as u64,
        rel_v8,
        rel_boa,
        heap,
        CC.with(|s| s.borrow().revoked),
        V8_RELEASE_QUEUE.with(|q| q.borrow().len() as u64),
        PIN_WRAPPER.with(|m| m.borrow().len() as u64),
    ]
}

/// One collector epoch: retire the previous epoch's weak pins, then weaken the gray graph's V8
/// pins behind their keepers. With `idle_skip`, an epoch whose inputs are unchanged is skipped.
/// Returns the epoch's wall time in ms (0 when nothing ran).
pub(crate) fn cycle_collect(idle_skip: bool) -> f64 {
    use std::collections::HashMap;
    if !weak_available()
        || (PIN_WRAPPER.with(|m| m.borrow().is_empty()) && !CC_ACTIVE.with(std::cell::Cell::get))
    {
        return 0.0;
    }
    if idle_skip {
        let backing_off = CC.with(|s| {
            let mut s = s.borrow_mut();
            let wait = s.backoff_ticks > 0;
            if wait {
                s.backoff_ticks -= 1;
                s.skipped += 1;
            }
            wait
        });
        if backing_off {
            return 0.0;
        }
    }
    if idle_skip && CC.with(|s| s.borrow().idle_sig) == Some(cc_idle_sig()) {
        CC.with(|s| s.borrow_mut().skipped += 1);
        return 0.0;
    }
    let started = js_sys::Date::now();
    drain_v8_releases();
    // The census reads only the boa heap and which pins have wrappers, never
    // the V8 slab, so it can run before the last epoch's state is retired.
    let g = gray_graph();
    let gray_sig = gray_graph_sig(&g);
    // The last epoch's keepers still stand if the graph is unchanged, nothing revoked them and no
    // watched wrapper came or went.
    let carried = CC.with(|s| {
        let mut st = s.borrow_mut();
        let carry = st.keepers.is_some()
            && st.gray_sig == Some(gray_sig)
            && st.revoked == st.epoch_revoked
            && st.wrapper_gen == st.epoch_wrapper_gen;
        if carry {
            st.carried += 1;
        }
        carry
    });
    if carried {
        return cc_finish_epoch(started, gray_sig, g.pins.len());
    }
    let epochs = CC.with(|s| s.borrow().comps.len());
    for c in 0..epochs {
        cc_revoke(c);
    }
    CC.with(|s| {
        let mut s = s.borrow_mut();
        s.comps.clear();
        s.pin_comp.clear();
        s.keepers = None;
    });
    // A keeper per SCC holds its own V8 values plus its children's keepers, so a wrapper keeps
    // alive exactly what its boa object reaches.
    let mut keeper: Vec<Option<wasm_bindgen::JsValue>> = Vec::with_capacity(g.handles.len());
    let mut values: Vec<Vec<(u64, wasm_bindgen::JsValue)>> = Vec::with_capacity(g.handles.len());
    for s in 0..g.handles.len() {
        let own: Vec<(u64, wasm_bindgen::JsValue)> = g.handles[s]
            .iter()
            .filter(|h| cc_weak_state(**h).is_none())
            .filter_map(|&h| V8.with(|t| t.borrow().get(h)).map(|v| (h, v)))
            .filter(|(_, v)| v.is_object() || v.is_function())
            .collect();
        let kids: Vec<&wasm_bindgen::JsValue> = g.children[s]
            .iter()
            .filter_map(|&c| keeper[c].as_ref())
            .collect();
        keeper.push(match (own.len(), kids.len()) {
            (0, 0) => None,
            (0, 1) => Some(kids[0].clone()),
            _ => {
                let arr = js_sys::Array::new();
                for (_, v) in &own {
                    arr.push(v);
                }
                for k in kids {
                    arr.push(k);
                }
                Some(arr.into())
            }
        });
        values.push(own);
    }
    // The ephemerons must be in place before any slab entry turns weak: a
    // V8 GC can run at any allocation below.
    let keepers = js_sys::WeakMap::new();
    for &(pin, s) in &g.pins {
        let Some(k) = &keeper[s] else { continue };
        let w = pin_wrapper(pin);
        if let Some(w) = w.filter(|w| w.is_object() || w.is_function()) {
            keepers.set(w.unchecked_ref(), k);
        }
    }
    let mut comp_of: HashMap<usize, usize> = HashMap::new();
    let mut comps: Vec<Vec<u64>> = Vec::new();
    // A handle shared by several SCCs is weakened once; condense put its owners in one group.
    let mut done = std::collections::HashSet::new();
    for (s, own) in values.into_iter().enumerate() {
        for (h, v) in own {
            if !done.insert(h) {
                continue;
            }
            let Some(w) = make_weak(&v) else { continue };
            V8.with(|t| t.borrow_mut().replace(h, w));
            let c = *comp_of.entry(g.group[s]).or_insert_with(|| {
                comps.push(Vec::new());
                comps.len() - 1
            });
            comps[c].push(h);
        }
    }
    CC.with(|st| {
        let mut st = st.borrow_mut();
        for (c, hs) in comps.iter().enumerate() {
            st.weakened += hs.len() as u64;
            for &h in hs {
                st.weak.insert(h, Some(c));
            }
        }
        for &(pin, s) in &g.pins {
            if let Some(&c) = comp_of.get(&g.group[s]) {
                st.pin_comp.insert(pin, c);
            }
        }
        st.comps = comps;
        st.keepers = Some(keepers);
    });
    cc_sync_active();
    cc_finish_epoch(started, gray_sig, g.pins.len())
}

fn cc_finish_epoch(started: f64, gray_sig: u64, gray_pins: usize) -> f64 {
    CC.with(|st| {
        let mut st = st.borrow_mut();
        st.runs += 1;
        st.last_gray_pins = gray_pins;
        if st.gray_sig == Some(gray_sig) {
            st.idle_streak = (st.idle_streak + 1).min(CC_MAX_IDLE_SHIFT);
            st.backoff_ticks = (1 << st.idle_streak) - 1;
        } else {
            st.gray_sig = Some(gray_sig);
            st.idle_streak = 0;
            st.backoff_ticks = 0;
        }
        st.epoch_revoked = st.revoked;
        st.epoch_wrapper_gen = st.wrapper_gen;
        st.last_ms = js_sys::Date::now() - started;
    });
    let sig = cc_idle_sig();
    CC.with(|s| {
        let mut s = s.borrow_mut();
        s.idle_sig = Some(sig);
        s.last_ms
    })
}

pub(crate) fn cycle_stats() -> String {
    CC.with(|s| {
        let s = s.borrow();
        let live = s.weak.values().filter(|c| c.is_some()).count();
        format!(
            "{{\"ccRuns\":{},\"ccGrayPins\":{},\"ccWeakV8\":{},\"ccDeadV8\":{},\"ccWeakened\":{},\"ccRevoked\":{},\"ccDeadReads\":{},\"ccLastMs\":{},\"ccSkipped\":{},\"ccCarried\":{}}}",
            s.runs,
            s.last_gray_pins,
            live,
            s.weak.len() - live,
            s.weakened,
            s.revoked,
            s.dead_reads,
            s.last_ms,
            s.skipped,
            s.carried
        )
    })
}
impl boa_engine::JsData for KsV8Release {}
impl Drop for KsV8Release {
    fn drop(&mut self) {
        V8_RELEASE_QUEUE.with(|q| q.borrow_mut().push(self.handle));
    }
}

pub(crate) fn drain_v8_release_queue() {
    drain_v8_releases();
}

pub(crate) fn is_our_wrapper(v: &wasm_bindgen::JsValue) -> bool {
    our_v8_lookup(v).is_some()
}

// V8 natives take only real buffer sources, never our proxies: hand them a
// copy of the bytes a boa ArrayBuffer, TypedArray or DataView views.
pub(crate) fn boa_buffer_bytes(v: &wasm_bindgen::JsValue) -> Option<js_sys::Uint8Array> {
    let obj = get_boa(our_v8_lookup(v)?)?;
    with_context(|ctx| {
        use boa_engine::object::builtins::{JsArrayBuffer, JsDataView, JsTypedArray};
        let (buffer, offset, len) = if let Ok(ta) = JsTypedArray::from_object(obj.clone()) {
            (
                ta.buffer(ctx).ok()?,
                ta.byte_offset(ctx).ok()?,
                ta.byte_length(ctx).ok()?,
            )
        } else if let Ok(dv) = JsDataView::from_object(obj.clone()) {
            let offset = usize::try_from(dv.byte_offset(ctx).ok()?).ok()?;
            let len = usize::try_from(dv.byte_length(ctx).ok()?).ok()?;
            (dv.buffer(ctx).ok()?, offset, len)
        } else {
            let data = JsArrayBuffer::from_object(obj).ok()?;
            let bytes = data.data()?;
            return Some(js_sys::Uint8Array::from(&bytes[..]));
        };
        let data = JsArrayBuffer::from_object(buffer.as_object()?.clone()).ok()?;
        let bytes = data.data()?;
        bytes
            .get(offset..offset.checked_add(len)?)
            .map(js_sys::Uint8Array::from)
    })?
}

fn drain_v8_releases() {
    let pending = V8_RELEASE_QUEUE.with(|q| std::mem::take(&mut *q.borrow_mut()));
    if pending.is_empty() {
        return;
    }
    V8.with(|t| {
        let mut t = t.borrow_mut();
        for h in pending {
            // A function pin is shared by every (fn, receiver) proxy, and a receiver's pin
            // by its method proxies: either goes only when the last holder is collected.
            let shared = FN_PIN_REFS.with(|r| {
                let mut r = r.borrow_mut();
                let Some(n) = r.get_mut(&h) else {
                    return false;
                };
                *n -= 1;
                if *n > 0 {
                    return true;
                }
                r.remove(&h);
                false
            });
            if shared {
                continue;
            }
            // Brand verdicts are keyed by pin handle; a released pin's
            // slot will be reused, so the stale verdict must go too.
            crate::js::dom_fastpath::evict_handle(h);
            t.release(h);
            if let Some(w) = PIN_WEAK_BOA.with(|m| m.borrow_mut().remove(&h)) {
                WEAK_BOA.with(|t| t.borrow_mut().release(w));
            }
            CC.with(|s| s.borrow_mut().weak.remove(&h));
        }
    });
}

// Live boa holders per shared V8 pin: functions, and the receivers method proxies keep
// (see drain_v8_releases); a pin with no entry is held by one proxy alone.
thread_local! {
    static FN_PIN_REFS: RefCell<std::collections::HashMap<u64, u32>> =
        RefCell::new(std::collections::HashMap::new());
}

// Weak boa-object handles for the identity caches: an entry must find
// its proxy while boa code still can, yet never keep it alive itself.
thread_local! {
    static WEAK_BOA: RefCell<PinSlab<boa_engine::object::WeakJsObject>> =
        const { RefCell::new(PinSlab::new()) };
}

// The WEAK_BOA slot of each cached V8 object proxy, keyed by its V8 pin.
// The proxy's death releases the slot with the pin; a slot that only
// weak_boa_get recycled stayed forever once V8 dropped the cache key,
// together with its boa_gc ephemeron, one per proxy ever minted.
thread_local! {
    static PIN_WEAK_BOA: RefCell<std::collections::HashMap<u64, u64>> =
        RefCell::new(std::collections::HashMap::new());
}

pub(crate) fn weak_boa_live() -> usize {
    WEAK_BOA.with(|t| t.borrow().live())
}

fn weak_boa_insert(o: &JsObject) -> u64 {
    WEAK_BOA.with(|t| t.borrow_mut().insert(o.downgrade()))
}

fn weak_boa_get(h: u64) -> Option<JsObject> {
    let w = WEAK_BOA.with(|t| t.borrow().get(h))?;
    let up = w.upgrade();
    if up.is_none() {
        WEAK_BOA.with(|t| {
            t.borrow_mut().release(h);
        });
    }
    up
}

/// The V8 pin behind `o` only if `o` ITSELF is our proxy: it reads proxy slots, never
/// [[Get]], so a boa class inheriting a bridged one cannot cross as its parent.
pub(crate) fn bridged_v8_handle(o: &JsObject, ctx: &mut Context) -> Option<u64> {
    let (target, handler) = o
        .downcast_ref::<boa_engine::builtins::proxy::Proxy>()?
        .target_and_handler()?;
    if !handler.is::<BridgeHandlerMark>() {
        return None;
    }
    read_handle(&target, "__ks_h", ctx)
}

fn pin(v: wasm_bindgen::JsValue) -> u64 {
    V8.with(|t| t.borrow_mut().insert(v))
}

pub(crate) fn pin_v8_value(v: wasm_bindgen::JsValue) -> u64 {
    pin(v)
}

pub(crate) fn get_v8(handle: u64) -> wasm_bindgen::JsValue {
    if cc_weak_state(handle).is_some() {
        cc_touch_v8(handle);
        if cc_weak_state(handle).is_some() {
            CC.with(|s| s.borrow_mut().dead_reads += 1);
            return wasm_bindgen::JsValue::UNDEFINED;
        }
    }
    V8.with(|t| t.borrow().get(handle))
        .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

pub(crate) fn replace_v8_value(handle: u64, value: wasm_bindgen::JsValue) -> bool {
    V8.with(|t| t.borrow_mut().replace(handle, value)).is_some()
}

thread_local! {
    static BOA: RefCell<PinSlab<JsObject>> = const { RefCell::new(PinSlab::new()) };
}

fn pin_boa(o: JsObject) -> u64 {
    BOA.with(|t| t.borrow_mut().insert(o))
}

fn get_boa(handle: u64) -> Option<JsObject> {
    cc_touch_pin(handle);
    BOA.with(|t| t.borrow().get(handle))
}

// Phase A/B identity interning. A boa->V8 proxy/trampoline answers this
// magic key with its boa pin handle (bridged_v8_handle is the other way).
const BOA_UNWRAP_KEY: &str = "__ks_boa_handle_unwrap_7f2a__";

thread_local! {
    static OUR_V8: RefCell<Option<js_sys::WeakMap>> = const { RefCell::new(None) };
}

fn our_v8_register(v: &wasm_bindgen::JsValue, handle: u64) {
    if !v.is_object() && !v.is_function() {
        return;
    }
    OUR_V8.with(|c| {
        let mut b = c.borrow_mut();
        let m = b.get_or_insert_with(js_sys::WeakMap::new);
        m.set(
            v.unchecked_ref::<js_sys::Object>(),
            &wasm_bindgen::JsValue::from_f64(handle as f64),
        );
    });
}

fn our_v8_lookup(v: &wasm_bindgen::JsValue) -> Option<u64> {
    if !v.is_object() && !v.is_function() {
        return None;
    }
    OUR_V8.with(|c| {
        let b = c.borrow();
        let m = b.as_ref()?;
        // The map holds numbers only, so a miss reads undefined and one get()
        // answers both questions: one crossing instead of has() then get().
        m.get(v.unchecked_ref::<js_sys::Object>())
            .as_f64()
            .map(|n| n as u64)
    })
}

fn v8_builtin_prototype(name: &str) -> Option<wasm_bindgen::JsValue> {
    let global = js_sys::global();
    let ctor = js_sys::Reflect::get(&global, &wasm_bindgen::JsValue::from_str(name)).ok()?;
    let proto = js_sys::Reflect::get(&ctor, &wasm_bindgen::JsValue::from_str("prototype")).ok()?;
    if proto.is_object() {
        Some(proto)
    } else {
        None
    }
}

fn boa_builtin_ctor_name(o: &JsObject, ctx: &Context) -> Option<&'static str> {
    let proto = o.prototype()?;
    let c = ctx.intrinsics().constructors();
    if JsObject::equals(&proto, &c.map().prototype()) {
        Some("Map")
    } else if JsObject::equals(&proto, &c.set().prototype()) {
        Some("Set")
    } else if JsObject::equals(&proto, &c.date().prototype()) {
        Some("Date")
    } else if JsObject::equals(&proto, &c.regexp().prototype()) {
        Some("RegExp")
    } else if JsObject::equals(&proto, &c.weak_map().prototype()) {
        Some("WeakMap")
    } else if JsObject::equals(&proto, &c.weak_set().prototype()) {
        Some("WeakSet")
    } else {
        None
    }
}

const INTRINSIC_CTOR_NAMES: [&str; 24] = [
    "Object",
    "Array",
    "Function",
    "String",
    "Number",
    "Boolean",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "Promise",
    "Symbol",
    "BigInt",
    "ArrayBuffer",
    "DataView",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
];

fn boa_intrinsic_ctor_name(o: &JsObject, ctx: &Context) -> Option<&'static str> {
    let c = ctx.intrinsics().constructors();
    let ctors = [
        c.object(),
        c.array(),
        c.function(),
        c.string(),
        c.number(),
        c.boolean(),
        c.date(),
        c.regexp(),
        c.map(),
        c.set(),
        c.weak_map(),
        c.weak_set(),
        c.weak_ref(),
        c.promise(),
        c.symbol(),
        c.bigint(),
        c.array_buffer(),
        c.data_view(),
        c.error(),
        c.type_error(),
        c.range_error(),
        c.syntax_error(),
        c.reference_error(),
        c.uri_error(),
    ];
    for (name, sc) in INTRINSIC_CTOR_NAMES.iter().zip(ctors.iter()) {
        if JsObject::equals(o, &sc.constructor()) {
            return Some(name);
        }
    }
    None
}

// Snapshot constructors mapped to Boa; read other globals, including DOMException, live.
fn v8_intrinsic(name: &str) -> Option<wasm_bindgen::JsValue> {
    if let Some(i) = INTRINSIC_CTOR_NAMES.iter().position(|n| *n == name) {
        return v8_intrinsics().0[i].clone();
    }
    let v = js_sys::Reflect::get(&js_sys::global(), &wasm_bindgen::JsValue::from_str(name)).ok()?;
    v.is_function().then_some(v)
}

fn v8_intrinsic_ctor_name(v: &wasm_bindgen::JsValue) -> Option<&'static str> {
    // Every name is a constructor, so only a function can match.
    if !v.is_function() {
        return None;
    }
    let i = v8_intrinsics().1.get(v).as_f64()?;
    INTRINSIC_CTOR_NAMES.get(i as usize).copied()
}

thread_local! {
    // V8 strings for property keys that cross the bridge. Re-encoding the key on
    // every access was ~23% of a bridged method call (TextDecoder on the JS side).
    static V8_KEYS: RefCell<std::collections::HashMap<String, wasm_bindgen::JsValue>> =
        RefCell::new(std::collections::HashMap::new());
}

// Short boa strings crossing as values (element types, class names, keys in
// ownKeys) repeat per render; each crossing was a TextDecoder call in the glue.
thread_local! {
    static V8_STRS: RefCell<std::collections::HashMap<JsString, wasm_bindgen::JsValue>> =
        RefCell::new(std::collections::HashMap::new());
}

pub(crate) fn boa_str_to_v8(s: &JsString) -> wasm_bindgen::JsValue {
    if s.len() > 64 {
        return wasm_bindgen::JsValue::from_str(&s.to_std_string_escaped());
    }
    if let Some(v) = V8_STRS.with(|m| m.borrow().get(s).cloned()) {
        return v;
    }
    let v = wasm_bindgen::JsValue::from_str(&s.to_std_string_escaped());
    V8_STRS.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= 4096 {
            m.clear();
        }
        m.insert(s.clone(), v.clone());
    });
    v
}

// Keys are a page's property names, so the set is small; the cap only bounds a
// page that generates keys (`obj["k" + i]`), and long keys skip the cache.
fn v8_key(key: &str) -> wasm_bindgen::JsValue {
    if key.len() > 64 {
        return wasm_bindgen::JsValue::from_str(key);
    }
    if let Some(v) = V8_KEYS.with(|m| m.borrow().get(key).cloned()) {
        return v;
    }
    let v = wasm_bindgen::JsValue::from_str(key);
    V8_KEYS.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= 4096 {
            m.clear();
        }
        m.insert(key.to_owned(), v.clone());
    });
    v
}

type V8Intrinsics = (Vec<Option<wasm_bindgen::JsValue>>, js_sys::Map);

thread_local! {
    // Read once per isolate: every function crossing used to do 24 global reads
    // through the window proxy, ~45% of a bridged `document.getElementById`.
    static V8_INTRINSICS: RefCell<Option<Rc<V8Intrinsics>>> = const { RefCell::new(None) };
}

// The first bridge use fixes the realm's intrinsics, so a global a page swaps
// in later (a Promise polyfill) crosses as its own function, as in a browser.
fn v8_intrinsics() -> Rc<V8Intrinsics> {
    if let Some(snapshot) = V8_INTRINSICS.with(|c| c.borrow().clone()) {
        return snapshot;
    }
    let global = js_sys::global();
    let by_fn = js_sys::Map::new();
    let fns = INTRINSIC_CTOR_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let v = js_sys::Reflect::get(&global, &wasm_bindgen::JsValue::from_str(name)).ok()?;
            if !v.is_function() {
                return None;
            }
            if !by_fn.has(&v) {
                by_fn.set(&v, &wasm_bindgen::JsValue::from(i as u32));
            }
            Some(v)
        })
        .collect();
    let snapshot = Rc::new((fns, by_fn));
    V8_INTRINSICS.with(|c| c.borrow_mut().get_or_insert(snapshot).clone())
}

fn boa_intrinsic_ctor(name: &str, ctx: &Context) -> Option<JsObject> {
    let c = ctx.intrinsics().constructors();
    Some(match name {
        "Object" => c.object().constructor(),
        "Array" => c.array().constructor(),
        "Function" => c.function().constructor(),
        "String" => c.string().constructor(),
        "Number" => c.number().constructor(),
        "Boolean" => c.boolean().constructor(),
        "Date" => c.date().constructor(),
        "RegExp" => c.regexp().constructor(),
        "Map" => c.map().constructor(),
        "Set" => c.set().constructor(),
        "WeakMap" => c.weak_map().constructor(),
        "WeakSet" => c.weak_set().constructor(),
        "WeakRef" => c.weak_ref().constructor(),
        "Promise" => c.promise().constructor(),
        "Symbol" => c.symbol().constructor(),
        "BigInt" => c.bigint().constructor(),
        "ArrayBuffer" => c.array_buffer().constructor(),
        "DataView" => c.data_view().constructor(),
        "Error" => c.error().constructor(),
        "TypeError" => c.type_error().constructor(),
        "RangeError" => c.range_error().constructor(),
        "SyntaxError" => c.syntax_error().constructor(),
        "ReferenceError" => c.reference_error().constructor(),
        "URIError" => c.uri_error().constructor(),
        _ => return None,
    })
}

thread_local! {
    static V8_BOA_CACHE: RefCell<Option<js_sys::WeakMap>> = const { RefCell::new(None) };
}

thread_local! {
    static V8_FN_HANDLES: RefCell<Option<js_sys::WeakMap>> = const { RefCell::new(None) };
    static METHOD_PROXY_CACHE: RefCell<std::collections::HashMap<(u64, Option<u64>), boa_engine::object::WeakJsObject>> =
        RefCell::new(std::collections::HashMap::new());
    static MPC_SWEEP_AT: std::cell::Cell<usize> = const { std::cell::Cell::new(4096) };
}

fn pin_v8_fn(v: &wasm_bindgen::JsValue) -> u64 {
    let cached = V8_FN_HANDLES.with(|c| {
        let b = c.borrow();
        let m = b.as_ref()?;
        // The map holds numbers only, so a miss reads undefined and one get()
        // answers both questions: one crossing instead of has() then get().
        m.get(v.unchecked_ref::<js_sys::Object>())
            .as_f64()
            .map(|n| n as u64)
    });
    // Revalidate a hit: the pin is released once its last proxy dies.
    if let Some(h) = cached {
        cc_touch_v8(h);
        if cc_weak_state(h).is_none() && V8.with(|t| t.borrow().get(h)).is_some() {
            return h;
        }
    }
    let h = pin(v.clone());
    V8_FN_HANDLES.with(|c| {
        let mut b = c.borrow_mut();
        let m = b.get_or_insert_with(js_sys::WeakMap::new);
        m.set(
            v.unchecked_ref::<js_sys::Object>(),
            &wasm_bindgen::JsValue::from_f64(h as f64),
        );
    });
    h
}

// Cache one proxy per live (function, receiver) pair. Weak values let Boa
// collect unused proxies; thresholded sweeps remove dead map entries.
fn v8_fn_to_boa_proxy(
    v: &wasm_bindgen::JsValue,
    this: Option<(u64, &JsObject)>,
    ctx: &mut Context,
) -> JsObject {
    let fn_handle = pin_v8_fn(v);
    let this_handle = this.map(|(h, _)| h);
    let key = (fn_handle, this_handle);
    if let Some(p) = METHOD_PROXY_CACHE.with(|c| c.borrow().get(&key).and_then(|w| w.upgrade())) {
        return p;
    }
    let proxy = make_v8_proxy(fn_handle, this, true, ctx);
    METHOD_PROXY_CACHE.with(|c| {
        let mut m = c.borrow_mut();
        if m.len() >= MPC_SWEEP_AT.with(|s| s.get()) {
            m.retain(|_, w| w.upgrade().is_some());
            MPC_SWEEP_AT.with(|s| s.set((m.len() * 2).max(4096)));
        }
        m.insert(key, proxy.downgrade());
    });
    proxy
}

thread_local! {
    static BOA_V8: RefCell<PinSlab<wasm_bindgen::JsValue>> = const { RefCell::new(PinSlab::new()) };
}

thread_local! {
    static STAMP_SYM: RefCell<Option<JsSymbol>> = const { RefCell::new(None) };
}

fn stamp_pk() -> PropertyKey {
    STAMP_SYM.with(|c| {
        let mut b = c.borrow_mut();
        let sym = b.get_or_insert_with(|| {
            JsSymbol::new(Some(js_string!("ks_v8_intern"))).expect("stamp symbol")
        });
        PropertyKey::Symbol(sym.clone())
    })
}

fn boa_v8_push(v: wasm_bindgen::JsValue) -> u64 {
    BOA_V8.with(|t| t.borrow_mut().insert(v))
}

fn boa_v8_get(handle: u64) -> Option<wasm_bindgen::JsValue> {
    let s = BOA_V8.with(|t| t.borrow().get(handle))?;
    if !weak_available() {
        return Some(s);
    }
    let v = weak_deref(&s);
    if v.is_undefined() {
        None
    } else {
        Some(v)
    }
}

fn boa_v8_lookup(o: &JsObject, ctx: &mut Context) -> Option<wasm_bindgen::JsValue> {
    if !o.has_own_property(stamp_pk(), ctx).unwrap_or(false) {
        return None;
    }
    let idx = o.get(stamp_pk(), ctx).ok()?.as_number()? as u64;
    boa_v8_get(idx)
}

fn boa_v8_store(o: &JsObject, v: &wasm_bindgen::JsValue, _ctx: &mut Context) -> u64 {
    let stored = make_weak(v).unwrap_or_else(|| v.clone());
    let idx = boa_v8_push(stored);
    let desc = PropertyDescriptor::builder()
        .value(idx as f64)
        .writable(false)
        .enumerable(false)
        .configurable(true)
        .build();
    o.insert_property(stamp_pk(), desc);
    idx
}

fn v8_boa_cache_get(v: &wasm_bindgen::JsValue) -> Option<u64> {
    if !v.is_object() {
        return None;
    }
    V8_BOA_CACHE.with(|c| {
        let b = c.borrow();
        let m = b.as_ref()?;
        // The map holds numbers only, so a miss reads undefined and one get()
        // answers both questions: one crossing instead of has() then get().
        m.get(v.unchecked_ref::<js_sys::Object>())
            .as_f64()
            .map(|n| n as u64)
    })
}

fn v8_boa_cache_set(v: &wasm_bindgen::JsValue, handle: u64) {
    if !v.is_object() {
        return;
    }
    V8_BOA_CACHE.with(|c| {
        let mut b = c.borrow_mut();
        let m = b.get_or_insert_with(js_sys::WeakMap::new);
        m.set(
            v.unchecked_ref::<js_sys::Object>(),
            &wasm_bindgen::JsValue::from_f64(handle as f64),
        );
    });
}

fn boa_unwrap_handle(v: &wasm_bindgen::JsValue) -> Option<u64> {
    our_v8_lookup(v)
}

thread_local! {
    static BOA_SYMBOL_FOR: RefCell<Option<JsFunction>> = const { RefCell::new(None) };
    static BOA_SYMBOL_KEYFOR: RefCell<Option<JsFunction>> = const { RefCell::new(None) };

    static WK_PAIRS: RefCell<Vec<(JsSymbol, js_sys::Symbol)>> = const { RefCell::new(Vec::new()) };

    static UNIQUE_SYMS: RefCell<Vec<(u64, JsSymbol, js_sys::Symbol)>> = const { RefCell::new(Vec::new()) };
}

fn capture_symbol_builtins(ctx: &mut Context) {
    let Ok(sym) = ctx.global_object().get(js_string!("Symbol"), ctx) else {
        return;
    };
    let Some(symobj) = sym.as_object() else {
        return;
    };
    if let Ok(f) = symobj.get(js_string!("for"), ctx) {
        if let Some(o) = f.as_object() {
            if let Some(jf) = JsFunction::from_object(o.clone()) {
                BOA_SYMBOL_FOR.with(|c| *c.borrow_mut() = Some(jf));
            }
        }
    }
    if let Ok(f) = symobj.get(js_string!("keyFor"), ctx) {
        if let Some(o) = f.as_object() {
            if let Some(jf) = JsFunction::from_object(o.clone()) {
                BOA_SYMBOL_KEYFOR.with(|c| *c.borrow_mut() = Some(jf));
            }
        }
    }
}

fn ensure_wk() {
    WK_PAIRS.with(|c| {
        let mut v = c.borrow_mut();
        if !v.is_empty() {
            return;
        }
        v.push((JsSymbol::async_iterator(), js_sys::Symbol::async_iterator()));
        v.push((JsSymbol::has_instance(), js_sys::Symbol::has_instance()));
        v.push((
            JsSymbol::is_concat_spreadable(),
            js_sys::Symbol::is_concat_spreadable(),
        ));
        v.push((JsSymbol::iterator(), js_sys::Symbol::iterator()));
        v.push((JsSymbol::r#match(), js_sys::Symbol::match_()));
        v.push((JsSymbol::replace(), js_sys::Symbol::replace()));
        v.push((JsSymbol::search(), js_sys::Symbol::search()));
        v.push((JsSymbol::species(), js_sys::Symbol::species()));
        v.push((JsSymbol::split(), js_sys::Symbol::split()));
        v.push((JsSymbol::to_primitive(), js_sys::Symbol::to_primitive()));
        v.push((JsSymbol::to_string_tag(), js_sys::Symbol::to_string_tag()));
        v.push((JsSymbol::unscopables(), js_sys::Symbol::unscopables()));
    });
}

fn boa_key_for(s: &JsSymbol, ctx: &mut Context) -> Option<String> {
    let f = BOA_SYMBOL_KEYFOR.with(|c| c.borrow().clone())?;
    let res = f
        .call(&BoaValue::undefined(), &[BoaValue::from(s.clone())], ctx)
        .ok()?;
    res.as_string().map(|js| js.to_std_string_escaped())
}

fn boa_symbol_for(key: &str, ctx: &mut Context) -> Option<JsSymbol> {
    let f = BOA_SYMBOL_FOR.with(|c| c.borrow().clone())?;
    let res = f
        .call(
            &BoaValue::undefined(),
            &[BoaValue::from(JsString::from(key))],
            ctx,
        )
        .ok()?;
    res.as_symbol()
}

fn mint_v8_unique(desc: Option<String>) -> js_sys::Symbol {
    let global: wasm_bindgen::JsValue = js_sys::global().into();
    let arg = match desc {
        Some(d) => wasm_bindgen::JsValue::from_str(&d),
        None => wasm_bindgen::JsValue::UNDEFINED,
    };
    if let Ok(ctor) = js_sys::Reflect::get(&global, &wasm_bindgen::JsValue::from_str("Symbol")) {
        if let Ok(f) = ctor.dyn_into::<js_sys::Function>() {
            if let Ok(res) = f.call1(&wasm_bindgen::JsValue::UNDEFINED, &arg) {
                return res.unchecked_into::<js_sys::Symbol>();
            }
        }
    }
    js_sys::Symbol::for_("__ks_unique_fallback")
}

fn boa_symbol_to_v8(s: &JsSymbol, ctx: &mut Context) -> js_sys::Symbol {
    ensure_wk();
    let h = s.hash();
    if let Some(v8) = WK_PAIRS.with(|c| {
        c.borrow()
            .iter()
            .find(|(b, _)| b.hash() == h)
            .map(|(_, v)| v.clone())
    }) {
        return v8;
    }
    if let Some(key) = boa_key_for(s, ctx) {
        return js_sys::Symbol::for_(&key);
    }
    if let Some(v8) = UNIQUE_SYMS.with(|c| {
        c.borrow()
            .iter()
            .find(|(bh, _, _)| *bh == h)
            .map(|(_, _, v)| v.clone())
    }) {
        return v8;
    }
    let desc = s.description().map(|d| d.to_std_string_escaped());
    let v8 = mint_v8_unique(desc);
    UNIQUE_SYMS.with(|c| c.borrow_mut().push((h, s.clone(), v8.clone())));
    v8
}

fn v8_symbol_to_boa(sym: js_sys::Symbol, ctx: &mut Context) -> JsSymbol {
    ensure_wk();
    if let Some(b) = WK_PAIRS.with(|c| {
        c.borrow()
            .iter()
            .find(|(_, v)| js_sys::Object::is(sym.as_ref(), v.as_ref()))
            .map(|(b, _)| b.clone())
    }) {
        return b;
    }
    let kf = js_sys::Symbol::key_for(&sym);
    if let Some(key) = kf.as_string() {
        if let Some(b) = boa_symbol_for(&key, ctx) {
            return b;
        }
    }
    if let Some(b) = UNIQUE_SYMS.with(|c| {
        c.borrow()
            .iter()
            .find(|(_, _, v)| js_sys::Object::is(sym.as_ref(), v.as_ref()))
            .map(|(_, b, _)| b.clone())
    }) {
        return b;
    }
    let boa = JsSymbol::new(None).expect("boa symbol alloc");
    UNIQUE_SYMS.with(|c| c.borrow_mut().push((boa.hash(), boa.clone(), sym.clone())));
    boa
}

fn read_handle(target: &JsObject, key: &str, ctx: &mut Context) -> Option<u64> {
    // Every trap starts here. A plain-object target holds the handle as native
    // data, and an array or function target holds it in its release sentinel.
    let key = match key {
        "__ks_h" => {
            if let Some(release) = target.downcast_ref::<KsV8Release>() {
                return Some(release.handle);
            }
            let sentinel =
                own_data(target, &js_string!("__ks_rel").into()).and_then(|v| v.as_object());
            if let Some(release) = sentinel
                .as_ref()
                .and_then(|s| s.downcast_ref::<KsV8Release>())
            {
                return Some(release.handle);
            }
            js_string!("__ks_h")
        }
        "__ks_t" => js_string!("__ks_t"),
        other => JsString::from(other),
    };
    target.get(key, ctx).ok()?.as_number().map(|n| n as u64)
}

// Bridge bookkeeping on a proxy target: a direct non-enumerable insert, not a
// [[Set]] that walked the target's prototype chain for setters on every mint.
fn hide_on_target(target: &JsObject, key: JsString, value: BoaValue) {
    let desc = PropertyDescriptor::builder()
        .value(value)
        .writable(false)
        .enumerable(false)
        .configurable(true)
        .build();
    target.insert_property(key, desc);
}

fn own_data(o: &JsObject, key: &PropertyKey) -> Option<BoaValue> {
    let obj = o.try_borrow().ok()?;
    obj.properties().get(key)?.value().cloned()
}

// Property names are almost always valid UTF-16; the escaping formatter is only
// needed for lone surrogates, and it was a visible slice of every trap.
fn key_string(s: &JsString) -> String {
    s.to_std_string()
        .unwrap_or_else(|_| s.to_std_string_escaped())
}

fn noop(_: &BoaValue, _: &[BoaValue], _: &mut Context) -> JsResult<BoaValue> {
    Ok(BoaValue::undefined())
}

pub(crate) fn v8_to_boa(v: wasm_bindgen::JsValue, ctx: &mut Context) -> BoaValue {
    drain_v8_releases();
    if v.is_null() {
        return BoaValue::null();
    }
    if v.is_undefined() {
        return BoaValue::undefined();
    }
    if let Some(n) = v.as_f64() {
        return BoaValue::from(n);
    }
    if let Some(b) = v.as_bool() {
        return BoaValue::from(b);
    }
    if let Some(s) = v.as_string() {
        return BoaValue::from(JsString::from(s.as_str()));
    }
    if v.is_symbol() {
        return BoaValue::from(v8_symbol_to_boa(v.unchecked_into::<js_sys::Symbol>(), ctx));
    }
    // Bridge V8 promises through async jobs. Promise detection can itself trigger
    // proxy traps, so keep the `instanceof` probe inside `with_v8`.
    if with_v8(ctx, || v.dyn_ref::<js_sys::Promise>().is_some()) {
        return bridge_v8_promise(v.unchecked_into::<js_sys::Promise>(), ctx);
    }
    v8_object_to_boa(v, ctx)
}

// For a DOM wrapper the fast path minted through the shim: never a Promise, so
// skip the instanceof excursion, whose re-arm made every minted node revalidate.
pub(crate) fn v8_node_to_boa(v: wasm_bindgen::JsValue, ctx: &mut Context) -> BoaValue {
    drain_v8_releases();
    v8_object_to_boa(v, ctx)
}

fn v8_object_to_boa(v: wasm_bindgen::JsValue, ctx: &mut Context) -> BoaValue {
    // I3: a value we previously handed to V8 (boa->V8 proxy/trampoline)
    // round-trips back to its ORIGINAL boa object, preserving identity.
    if let Some(h) = boa_unwrap_handle(&v) {
        if let Some(o) = get_boa(h) {
            return o.into();
        }
    }
    if let Some(name) = v8_intrinsic_ctor_name(&v) {
        if let Some(o) = boa_intrinsic_ctor(name, ctx) {
            return o.into();
        }
    }
    if v.is_function() {
        return v8_fn_to_boa_proxy(&v, None, ctx).into();
    }
    if let Some(o) = v8_boa_cache_get(&v).and_then(weak_boa_get) {
        // Boa may keep this proxy, so its pin cannot stay weak.
        if CC_ACTIVE.with(std::cell::Cell::get) {
            if let Some(n) = bridged_v8_handle(&o, ctx) {
                cc_touch_v8(n);
            }
        }
        return o.into();
    }
    let handle = pin(v.clone());
    let proxy = make_v8_proxy(handle, None, false, ctx);
    // The cache holds the proxy WEAKLY: boa references keep it alive,
    // and its death releases the V8 pin via the target's sentinel.
    let weak = weak_boa_insert(&proxy);
    PIN_WEAK_BOA.with(|m| m.borrow_mut().insert(handle, weak));
    v8_boa_cache_set(&v, weak);
    proxy.into()
}

// Wrap a V8 Promise as a boa promise. Enqueues a NativeAsyncJob that awaits
// the V8 promise via JsFuture (polled by WasmJobQueue on V8's loop);
// on settle it resolves/rejects the boa promise with the marshalled value.
fn bridge_v8_promise(p: js_sys::Promise, ctx: &mut Context) -> BoaValue {
    let (promise, ResolvingFunctions { resolve, reject }) = JsPromise::new_pending(ctx);
    // The await is the async job; settling is a promise job, so the boa reaction
    // runs in a drain batch under the context lock like every other reaction.
    let job = NativeAsyncJob::new(async move |ctx: &std::cell::RefCell<&mut Context>| {
        let settled = wasm_bindgen_futures::JsFuture::from(p).await;
        let settle = PromiseJob::new(move |ctx: &mut Context| match settled {
            Ok(v) => {
                let bv = v8_to_boa(v, ctx);
                resolve.call(&BoaValue::undefined(), &[bv], ctx)
            }
            Err(e) => {
                let bv = v8_to_boa(e, ctx);
                reject.call(&BoaValue::undefined(), &[bv], ctx)
            }
        });
        ctx.borrow_mut().enqueue_job(Job::PromiseJob(settle));
        Ok(BoaValue::undefined())
    });
    ctx.enqueue_job(Job::AsyncJob(job));
    promise.into()
}

pub(crate) fn boa_to_v8(v: &BoaValue, ctx: &mut Context) -> wasm_bindgen::JsValue {
    drain_v8_releases();
    match v.variant() {
        JsVariant::Null => wasm_bindgen::JsValue::NULL,
        JsVariant::Undefined => wasm_bindgen::JsValue::UNDEFINED,
        JsVariant::Boolean(b) => wasm_bindgen::JsValue::from_bool(b),
        JsVariant::Integer32(i) => wasm_bindgen::JsValue::from_f64(f64::from(i)),
        JsVariant::Float64(r) => wasm_bindgen::JsValue::from_f64(r),
        JsVariant::String(s) => boa_str_to_v8(&s),
        JsVariant::Object(o) => {
            let o = &o;
            // A bridged V8 object -> unwrap to the real V8 value.
            if let Some(n) = bridged_v8_handle(o, ctx) {
                return get_v8(n);
            }
            if o.is_callable() {
                if let Some(v8) = boa_intrinsic_ctor_name(o, ctx).and_then(v8_intrinsic) {
                    return v8;
                }
            }
            if let Some(cached) = boa_v8_lookup(o, ctx) {
                return cached;
            }
            if o.is_callable() {
                let (f, boa_pin) = make_boa_fn_trampoline(o.clone(), ctx);
                let p = boa_fn_to_v8_proxy(f, boa_pin, ctx);
                our_v8_register(&p, boa_pin);
                let slot = boa_v8_store(o, &p, ctx);
                fr_register(&p, boa_pin, Some(slot));
                return p;
            }
            let (p, boa_pin) = boa_object_to_v8_proxy(o.clone());
            let slot = boa_v8_store(o, &p, ctx);
            fr_register(&p, boa_pin, Some(slot));
            p
        }
        // Convert Boa symbols so `Symbol.for('react.element')` remains shared.
        JsVariant::Symbol(s) => boa_symbol_to_v8(&s, ctx).into(),
        _ => wasm_bindgen::JsValue::UNDEFINED,
    }
}

fn getter_threw(e: wasm_bindgen::JsValue, ctx: &mut Context) -> JsResult<BoaValue> {
    if boa_strict() {
        Err(boa_engine::JsError::from_opaque(v8_to_boa(e, ctx)))
    } else {
        Ok(BoaValue::undefined())
    }
}

fn v8_property_to_boa(
    value: wasm_bindgen::JsValue,
    key: Option<&str>,
    receiver: (u64, &JsObject),
    ctx: &mut Context,
) -> BoaValue {
    if let Some(handle) = boa_unwrap_handle(&value) {
        if let Some(object) = get_boa(handle) {
            return object.into();
        }
    }
    if value.is_function() {
        if let Some(name) = v8_intrinsic_ctor_name(&value) {
            if let Some(object) = boa_intrinsic_ctor(name, ctx) {
                return object.into();
            }
        }
        let is_dom_exception_constructor = key
            .is_some_and(|key| matches!(key, "constructor" | "DOMException"))
            && v8_intrinsic("DOMException").is_some_and(|ctor| js_sys::Object::is(&value, &ctor));
        let receiver = (!is_dom_exception_constructor).then_some(receiver);
        return v8_fn_to_boa_proxy(&value, receiver, ctx).into();
    }
    v8_to_boa(value, ctx)
}

fn trap_get(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::undefined());
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::undefined());
    };
    if let Some(sym) = args.get(1).and_then(|k| k.as_symbol()) {
        let v8sym = boa_symbol_to_v8(&sym, ctx);
        let v8 = get_v8(handle);
        return match with_v8(ctx, || js_sys::Reflect::get(&v8, v8sym.as_ref())) {
            Ok(res) => Ok(v8_property_to_boa(res, None, (handle, &target), ctx)),
            Err(e) => getter_threw(e, ctx),
        };
    }
    let key = args
        .get(1)
        .and_then(|k| k.to_string(ctx).ok())
        .map(|s| key_string(&s))
        .unwrap_or_default();
    // boa→blitz DOM short-circuit: whitelisted reads on branded node
    // proxies answer inside the wasm (dom_fastpath.rs); None falls
    // through to the crossing below, unchanged.
    if let Some(fast) = crate::js::dom_fastpath::try_fast_get(handle, &key, &target, ctx) {
        return Ok(fast);
    }
    let v8 = get_v8(handle);
    match with_v8(ctx, || js_sys::Reflect::get(&v8, &v8_key(&key))) {
        Ok(res) => Ok(v8_property_to_boa(
            res,
            Some(key.as_str()),
            (handle, &target),
            ctx,
        )),
        Err(e) => getter_threw(e, ctx),
    }
}

fn trap_has(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::from(false));
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::from(false));
    };
    if let Some(sym) = args.get(1).and_then(|k| k.as_symbol()) {
        let v8sym = boa_symbol_to_v8(&sym, ctx);
        let v8 = get_v8(handle);
        let has = with_v8(ctx, || js_sys::Reflect::has(&v8, v8sym.as_ref())).unwrap_or(false);
        return Ok(BoaValue::from(has));
    }
    let key = args
        .get(1)
        .and_then(|k| k.to_string(ctx).ok())
        .map(|s| key_string(&s))
        .unwrap_or_default();
    let v8 = get_v8(handle);
    let has = with_v8(ctx, || js_sys::Reflect::has(&v8, &v8_key(&key))).unwrap_or(false);
    Ok(BoaValue::from(has))
}

fn trap_apply(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::undefined());
    };
    let Some(fn_handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::undefined());
    };
    let this_v8 = match read_handle(&target, "__ks_t", ctx) {
        Some(h) => get_v8(h),
        None => match args.get(1) {
            Some(t)
                if t.as_object()
                    .is_some_and(|o| JsObject::equals(&o, &ctx.global_object())) =>
            {
                js_sys::global().into()
            }
            Some(t) => boa_to_v8(t, ctx),
            None => wasm_bindgen::JsValue::UNDEFINED,
        },
    };
    let func: js_sys::Function = get_v8(fn_handle).unchecked_into();
    let out = js_sys::Array::new();
    if let Some(list) = args.get(2).and_then(|v| v.as_object()) {
        let len = list
            .get(js_string!("length"), ctx)
            .ok()
            .and_then(|v| v.as_number())
            .unwrap_or(0.0) as u32;
        for i in 0..len {
            let el = list.get(i, ctx).unwrap_or(BoaValue::undefined());
            out.push(&boa_to_v8(&el, ctx));
        }
    }
    match with_v8(ctx, || js_sys::Reflect::apply(&func, &this_v8, &out)) {
        Ok(res) => Ok(v8_to_boa(res, ctx)),
        Err(e) => Err(boa_engine::JsError::from_opaque(v8_to_boa(e, ctx))),
    }
}

fn trap_construct(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Err(JsNativeError::typ()
            .with_message("construct: bad target")
            .into());
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Err(JsNativeError::typ()
            .with_message("construct: no handle")
            .into());
    };
    let ctor: js_sys::Function = get_v8(handle).unchecked_into();
    let out = js_sys::Array::new();
    if let Some(list) = args.get(1).and_then(|v| v.as_object()) {
        let len = list
            .get(js_string!("length"), ctx)
            .ok()
            .and_then(|v| v.as_number())
            .unwrap_or(0.0) as u32;
        for i in 0..len {
            let el = list.get(i, ctx).unwrap_or(BoaValue::undefined());
            out.push(&boa_to_v8(&el, ctx));
        }
    }
    let new_target_v8 = args
        .get(2)
        .map(|nt| boa_to_v8(nt, ctx))
        .unwrap_or_else(|| ctor.clone().into());
    let result = with_v8(ctx, || match new_target_v8.dyn_ref::<js_sys::Function>() {
        Some(nt) => js_sys::Reflect::construct_with_new_target(&ctor, &out, nt),
        None => js_sys::Reflect::construct(&ctor, &out),
    });
    match result {
        Ok(inst) => Ok(v8_to_boa(inst, ctx)),
        Err(e) => Err(boa_engine::JsError::from_opaque(v8_to_boa(e, ctx))),
    }
}

fn trap_set(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::from(false));
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::from(false));
    };
    let value = args.get(2).cloned().unwrap_or(BoaValue::undefined());
    // OrdinarySet writes inherited data to the receiver. Preserve V8 super-setters,
    // the global-proxy exception, and foreign Proxy forwarding.
    if let Some(recv) = args.get(3).and_then(|v| v.as_object()) {
        let is_global = JsObject::equals(&recv, &ctx.global_object());
        if !is_global
            && bridged_v8_handle(&recv, ctx) != Some(handle)
            && inherits_from_bridged(&recv, handle, ctx)
        {
            return set_on_receiver(handle, args.get(1), value, recv, ctx);
        }
    }
    let v8val = boa_to_v8(&value, ctx);
    let v8 = get_v8(handle);
    // Marshal the key BEFORE the excursion: a V8 setter can re-enter boa,
    // so `ctx` must be free by the time we call into V8 (see `with_v8`).
    let v8key = trap_key_to_v8(args.get(1), ctx);
    let res = with_v8(ctx, || js_sys::Reflect::set(&v8, &v8key, &v8val));
    match res {
        Ok(ok) => Ok(BoaValue::from(ok)),
        Err(e) => Err(JsError::from_opaque(v8_to_boa(e, ctx))),
    }
}

fn inherits_from_bridged(recv: &JsObject, handle: u64, ctx: &mut Context) -> bool {
    let mut cur = recv.prototype().clone();
    for _ in 0..64 {
        let Some(p) = cur else { return false };
        if bridged_v8_handle(&p, ctx) == Some(handle) {
            return true;
        }
        cur = p.prototype().clone();
    }
    false
}

fn set_on_receiver(
    handle: u64,
    key: Option<&BoaValue>,
    value: BoaValue,
    recv: JsObject,
    ctx: &mut Context,
) -> JsResult<BoaValue> {
    let v8key = trap_key_to_v8(key, ctx);
    let mut cur = get_v8(handle);
    let mut desc: Option<js_sys::Object> = None;
    for _ in 0..32 {
        let Some(obj) = with_v8(ctx, || cur.dyn_ref::<js_sys::Object>().cloned()) else {
            break;
        };
        if let Ok(d) = with_v8(ctx, || {
            js_sys::Reflect::get_own_property_descriptor(&obj, &v8key)
        }) {
            let dv = d;
            if !dv.is_undefined() {
                desc = Some(dv.unchecked_into());
                break;
            }
        }
        cur = match with_v8(ctx, || js_sys::Reflect::get_prototype_of(&obj)) {
            Ok(p) => p.into(),
            Err(_) => wasm_bindgen::JsValue::NULL,
        };
    }
    if let Some(d) = desc {
        let get = |k: &str| js_sys::Reflect::get(&d, &wasm_bindgen::JsValue::from_str(k)).ok();
        let setter = get("set").filter(|s| s.is_function());
        let is_accessor = setter.is_some() || get("get").is_some_and(|g| !g.is_undefined());
        if is_accessor {
            let Some(setter) = setter else {
                return Ok(BoaValue::from(false));
            };
            let recv_v8 = boa_to_v8(&recv.clone().into(), ctx);
            let v8val = boa_to_v8(&value, ctx);
            let f: js_sys::Function = setter.unchecked_into();
            return match with_v8(ctx, || f.call1(&recv_v8, &v8val)) {
                Ok(_) => Ok(BoaValue::from(true)),
                Err(e) => {
                    let msg = js_sys::Reflect::get(&e, &wasm_bindgen::JsValue::from_str("message"))
                        .ok()
                        .and_then(|m| m.as_string())
                        .unwrap_or_else(|| "V8 setter threw".to_string());
                    Err(JsNativeError::typ().with_message(msg).into())
                }
            };
        }
        if get("writable").and_then(|w| w.as_bool()) == Some(false) {
            return Ok(BoaValue::from(false));
        }
    }
    let pk = match key {
        Some(k) => k.to_property_key(ctx)?,
        None => return Ok(BoaValue::from(false)),
    };
    if recv.has_own_property(pk.clone(), ctx)? {
        let ok = recv
            .define_property_or_throw(pk, PropertyDescriptor::builder().value(value).build(), ctx)
            .is_ok();
        return Ok(BoaValue::from(ok));
    }
    Ok(BoaValue::from(recv.create_data_property(pk, value, ctx)?))
}

fn trap_own_keys(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let out = JsArray::new(ctx)?;
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(out.into());
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(out.into());
    };
    let v8 = get_v8(handle);
    if let Ok(keys) = with_v8(ctx, || js_sys::Reflect::own_keys(&v8)) {
        for k in keys.iter() {
            if let Some(s) = k.as_string() {
                let _ = out.push(JsString::from(s.as_str()), ctx);
            } else if k.is_symbol() {
                let sym = v8_symbol_to_boa(k.unchecked_into::<js_sys::Symbol>(), ctx);
                let _ = out.push(BoaValue::from(sym), ctx);
            }
        }
    }
    Ok(out.into())
}

fn trap_key_to_v8(key: Option<&BoaValue>, ctx: &mut Context) -> wasm_bindgen::JsValue {
    if let Some(sym) = key.and_then(|k| k.as_symbol()) {
        return boa_symbol_to_v8(&sym, ctx).into();
    }
    let s = key
        .and_then(|k| k.to_string(ctx).ok())
        .map(|s| key_string(&s))
        .unwrap_or_default();
    wasm_bindgen::JsValue::from_str(&s)
}

fn trap_define_property(
    _this: &BoaValue,
    args: &[BoaValue],
    ctx: &mut Context,
) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::from(false));
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::from(false));
    };
    let Some(desc_val) = args.get(2).cloned() else {
        return Ok(BoaValue::from(false));
    };
    let desc = desc_val.to_property_descriptor(ctx)?;

    let v8 = get_v8(handle);
    let v8key = trap_key_to_v8(args.get(1), ctx);
    let out = js_sys::Object::new();
    let set_flag = |name: &str, val: bool| {
        let _ = js_sys::Reflect::set(
            &out,
            &wasm_bindgen::JsValue::from_str(name),
            &wasm_bindgen::JsValue::from_bool(val),
        );
    };
    if desc.is_accessor_descriptor() {
        if let Some(g) = desc.get() {
            let gv = boa_to_v8(&g.clone(), ctx);
            let _ = js_sys::Reflect::set(&out, &wasm_bindgen::JsValue::from_str("get"), &gv);
        }
        if let Some(s) = desc.set() {
            let sv = boa_to_v8(&s.clone(), ctx);
            let _ = js_sys::Reflect::set(&out, &wasm_bindgen::JsValue::from_str("set"), &sv);
        }
    } else {
        let value = desc.value().cloned().unwrap_or(BoaValue::undefined());
        let vv = boa_to_v8(&value, ctx);
        let _ = js_sys::Reflect::set(&out, &wasm_bindgen::JsValue::from_str("value"), &vv);
        set_flag("writable", desc.writable().unwrap_or(false));
    }
    set_flag("enumerable", desc.enumerable().unwrap_or(false));
    set_flag("configurable", true);

    let v8obj: js_sys::Object = v8.clone().unchecked_into();
    if with_v8(ctx, || {
        js_sys::Reflect::define_property(&v8obj, &v8key, &out)
    })
    .is_err()
    {
        return Ok(BoaValue::from(false));
    }

    let key = args
        .get(1)
        .cloned()
        .unwrap_or(BoaValue::undefined())
        .to_property_key(ctx)?;
    target.define_property_or_throw(key, desc, ctx)?;
    Ok(BoaValue::from(true))
}

fn trap_delete_property(
    _this: &BoaValue,
    args: &[BoaValue],
    ctx: &mut Context,
) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::from(false));
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::from(false));
    };
    if let Some(desc_obj) = mirrored_descriptor(&target, args.get(1), ctx)? {
        let configurable = desc_obj
            .as_object()
            .and_then(|o| o.get(js_string!("configurable"), ctx).ok())
            .map(|v| v.to_boolean())
            .unwrap_or(false);
        if !configurable {
            return Ok(BoaValue::from(false));
        }
    }
    let key = args
        .get(1)
        .cloned()
        .unwrap_or(BoaValue::undefined())
        .to_property_key(ctx)?;
    let _ = target.delete_property_or_throw(key, ctx);
    let v8 = get_v8(handle);
    let v8key = trap_key_to_v8(args.get(1), ctx);
    let v8obj: js_sys::Object = v8.clone().unchecked_into();
    let deleted =
        with_v8(ctx, || js_sys::Reflect::delete_property(&v8obj, &v8key)).unwrap_or(false);
    Ok(BoaValue::from(deleted))
}

fn mirrored_descriptor(
    target: &JsObject,
    key: Option<&BoaValue>,
    ctx: &mut Context,
) -> JsResult<Option<BoaValue>> {
    if let Some(k) = key {
        if k.as_symbol().is_none() {
            let s = k
                .to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_default();
            if matches!(
                s.as_str(),
                "__ks_h" | "__ks_t" | "__ks_tt" | "__ks_rel" | "__ks_trel"
            ) {
                return Ok(None);
            }
        }
    }
    let object_ctor = ctx.intrinsics().constructors().object().constructor();
    let gopd = object_ctor.get(js_string!("getOwnPropertyDescriptor"), ctx)?;
    let Some(gopd) = gopd.as_callable() else {
        return Ok(None);
    };
    let res = gopd.call(
        &BoaValue::undefined(),
        &[
            target.clone().into(),
            key.cloned().unwrap_or(BoaValue::undefined()),
        ],
        ctx,
    )?;
    if res.is_object() {
        return Ok(Some(res));
    }
    Ok(None)
}

fn trap_gopd(_this: &BoaValue, args: &[BoaValue], ctx: &mut Context) -> JsResult<BoaValue> {
    let Some(target) = args.first().and_then(|v| v.as_object()) else {
        return Ok(BoaValue::undefined());
    };
    let Some(handle) = read_handle(&target, "__ks_h", ctx) else {
        return Ok(BoaValue::undefined());
    };
    // Mirrored defines are authoritative because V8 checks proxy invariants
    // against the target descriptor.
    if let Some(mirrored) = mirrored_descriptor(&target, args.get(1), ctx)? {
        return Ok(mirrored);
    }
    let v8 = get_v8(handle);
    let v8key = trap_key_to_v8(args.get(1), ctx);
    let v8obj: js_sys::Object = v8.clone().unchecked_into();
    let desc = match with_v8(ctx, || {
        js_sys::Reflect::get_own_property_descriptor(&v8obj, &v8key)
    }) {
        Ok(d) if !d.is_undefined() && !d.is_null() => d,
        _ => return Ok(BoaValue::undefined()),
    };
    // The descriptor object is ours (V8 just built it), so reading its fields
    // cannot re-enter page code.
    let enumerable = js_sys::Reflect::get(&desc, &wasm_bindgen::JsValue::from_str("enumerable"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let out = JsObject::with_object_proto(ctx.intrinsics());
    let has_get =
        js_sys::Reflect::has(&desc, &wasm_bindgen::JsValue::from_str("get")).unwrap_or(false);
    let has_set =
        js_sys::Reflect::has(&desc, &wasm_bindgen::JsValue::from_str("set")).unwrap_or(false);
    if has_get || has_set {
        let get = js_sys::Reflect::get(&desc, &wasm_bindgen::JsValue::from_str("get"))
            .map(|value| v8_to_boa(value, ctx))
            .unwrap_or(BoaValue::undefined());
        let set = js_sys::Reflect::get(&desc, &wasm_bindgen::JsValue::from_str("set"))
            .map(|value| v8_to_boa(value, ctx))
            .unwrap_or(BoaValue::undefined());
        let _ = out.set(js_string!("get"), get, false, ctx);
        let _ = out.set(js_string!("set"), set, false, ctx);
    } else {
        let val = js_sys::Reflect::get(&desc, &wasm_bindgen::JsValue::from_str("value"))
            .map(|value| v8_to_boa(value, ctx))
            .unwrap_or(BoaValue::undefined());
        let _ = out.set(js_string!("value"), val, false, ctx);
        let _ = out.set(js_string!("writable"), true, false, ctx);
    }
    let _ = out.set(js_string!("enumerable"), enumerable, false, ctx);
    let _ = out.set(js_string!("configurable"), true, false, ctx);
    Ok(out.into())
}

fn make_v8_proxy(
    value_handle: u64,
    this: Option<(u64, &JsObject)>,
    callable: bool,
    ctx: &mut Context,
) -> JsObject {
    let target: JsObject = if callable {
        let t = JsObject::from(
            FunctionObjectBuilder::new(ctx.realm(), NativeFunction::from_fn_ptr(noop))
                .constructor(true)
                .build(),
        );
        // One fn pin is shared by every (fn, receiver) proxy, so each
        // proxy holds a reference and the pin goes with the last one.
        // Immortal fn pins leaked every closure a V8 page handed to boa,
        // and each closure kept its scope (DOM nodes, props) alive.
        FN_PIN_REFS.with(|r| *r.borrow_mut().entry(value_handle).or_insert(0) += 1);
        let sentinel = JsObject::from_proto_and_data(
            None,
            KsV8Release {
                handle: value_handle,
            },
        );
        hide_on_target(&t, js_string!("__ks_rel"), sentinel.into());
        t
    } else if js_sys::Array::is_array(&get_v8(value_handle)) {
        // Array target so boa's IsArray (JSON.stringify / Array checks)
        // sees an array; the get trap still forwards indices to V8.
        let t = JsObject::from(JsArray::new(ctx).expect("an empty array always allocates"));
        // The sentinel rides as a hidden property (traps forward to V8,
        // so target properties never leak into enumeration).
        let sentinel = JsObject::from_proto_and_data(
            None,
            KsV8Release {
                handle: value_handle,
            },
        );
        hide_on_target(&t, js_string!("__ks_rel"), sentinel.into());
        t
    } else {
        // The plain-object target itself carries the release data: when
        // boa GC collects the proxy, Drop queues the V8 pin's release.
        JsObject::from_proto_and_data(
            ctx.intrinsics().constructors().object().prototype(),
            KsV8Release {
                handle: value_handle,
            },
        )
    };
    // An object pin a method proxy shares (below) counts every proxy holding it, a
    // re-minted object proxy included; an unshared object pin keeps no count at all.
    if !callable {
        FN_PIN_REFS.with(|r| {
            if let Some(n) = r.borrow_mut().get_mut(&value_handle) {
                *n += 1;
            }
        });
    }
    if let Some((t, receiver)) = this {
        hide_on_target(&target, js_string!("__ks_t"), (t as f64).into());
        // Preserve the receiver pin's shared-holder count, and expose its target
        // to the census so a live method also keeps the receiver's graph alive.
        FN_PIN_REFS.with(|r| *r.borrow_mut().entry(t).or_insert(1) += 1);
        let sentinel = JsObject::from_proto_and_data(None, KsV8Release { handle: t });
        hide_on_target(&target, js_string!("__ks_trel"), sentinel.into());
        hide_on_target(&target, js_string!("__ks_tt"), receiver.clone().into());
    }
    let handler = proxy_handler(callable, ctx);
    // Not the Proxy constructor: calling it ran a VM frame per mint, and its stack
    // check threw (and panicked here) once a deep page neared boa's limit.
    boa_engine::builtins::proxy::Proxy::from_target_and_handler(target, handler, ctx)
}

// Marks the shared trap handlers, so any realm's bridge proxy is recognised by its
// handler alone: no trap runs, and a page Proxy over one of ours is not taken for it.
struct BridgeHandlerMark;
impl boa_engine::gc::Finalize for BridgeHandlerMark {}
// SAFETY: a unit marker with no GC-managed fields, so the collector has
// nothing to trace through it.
unsafe impl boa_engine::gc::Trace for BridgeHandlerMark {
    boa_engine::gc::empty_trace!();
}
impl boa_engine::JsData for BridgeHandlerMark {}

// Proxy traps forward to the target, so each realm can share two handlers.
struct BridgeProxyHandlers {
    plain: JsObject,
    callable: JsObject,
}
impl boa_engine::gc::Finalize for BridgeProxyHandlers {}
// SAFETY: traces both handlers, the only GC-managed fields.
unsafe impl boa_engine::gc::Trace for BridgeProxyHandlers {
    boa_engine::gc::custom_trace!(this, mark, {
        mark(&this.plain);
        mark(&this.callable);
    });
}
impl boa_engine::JsData for BridgeProxyHandlers {}

fn proxy_handler(callable: bool, ctx: &mut Context) -> JsObject {
    let realm = ctx.realm().clone();
    if let Some(h) = realm.host_defined().get::<BridgeProxyHandlers>() {
        return if callable {
            h.callable.clone()
        } else {
            h.plain.clone()
        };
    }
    let build = |callable: bool, ctx: &mut Context| {
        let handler = JsObject::from_proto_and_data(
            Some(ctx.intrinsics().constructors().object().prototype()),
            BridgeHandlerMark,
        );
        let traps: &[(&str, NativeFunctionPointer, usize)] = &[
            ("get", trap_get, 3),
            ("has", trap_has, 2),
            ("set", trap_set, 4),
            ("ownKeys", trap_own_keys, 1),
            ("defineProperty", trap_define_property, 3),
            ("deleteProperty", trap_delete_property, 2),
            ("getOwnPropertyDescriptor", trap_gopd, 2),
            ("apply", trap_apply, 3),
            ("construct", trap_construct, 3),
        ];
        for &(name, f, len) in &traps[..if callable { 9 } else { 7 }] {
            let f = FunctionObjectBuilder::new(ctx.realm(), NativeFunction::from_fn_ptr(f))
                .length(len)
                .build();
            handler
                .create_data_property_or_throw(JsString::from(name), f, ctx)
                .expect("new object should be writable");
        }
        handler
    };
    let handlers = BridgeProxyHandlers {
        plain: build(false, ctx),
        callable: build(true, ctx),
    };
    let h = if callable {
        handlers.callable.clone()
    } else {
        handlers.plain.clone()
    };
    realm.host_defined_mut().insert(handlers);
    h
}

thread_local! {
    static TRAMP_SHIMS: RefCell<Option<(
        wasm_bindgen::JsValue,
        wasm_bindgen::JsValue,
        wasm_bindgen::JsValue,
    )>> = const { RefCell::new(None) };
}

// The outermost entry clears residual values when no Boa frame is live;
// MessageChannel-driven pages may never reach idle recovery.
fn heal_at_entry(ctx: &mut Context) {
    // Do not clear stack values held by an outer native call without a VM frame.
    if REENTRY_DEPTH.with(std::cell::Cell::get) != 1 || !crate::js::boa_eval::boa_lock_idle() {
        return;
    }
    let (frames, stack) = ctx.ks_vm_stats();
    if frames == 0 && stack > 0 {
        let cleared = ctx.ks_clear_residual_stack();
        HEALED_AT_ENTRY.with(|h| h.set(h.get() + cleared as u64));
    }
}

thread_local! {
    static HEALED_AT_ENTRY: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

pub(crate) fn healed_at_entry() -> u64 {
    HEALED_AT_ENTRY.with(std::cell::Cell::get)
}

fn tramp_call_body(
    handle: f64,
    this_v8: wasm_bindgen::JsValue,
    args_v8: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    with_context(|ctx| {
        heal_at_entry(ctx);
        let Some(jsfn) = get_boa(handle as u64).and_then(JsFunction::from_object) else {
            return Ok(wasm_bindgen::JsValue::UNDEFINED);
        };
        let this_boa = v8_to_boa(this_v8.clone(), ctx);
        let args = unpack_args(&args_v8, ctx);
        match jsfn.call(&this_boa, &args, ctx) {
            Ok(res) => Ok(boa_to_v8(&res, ctx)),
            Err(e) => {
                if boa_strict() {
                    Err(error_to_v8(&e, ctx))
                } else {
                    Ok(wasm_bindgen::JsValue::UNDEFINED)
                }
            }
        }
    })
    .unwrap_or(Ok(wasm_bindgen::JsValue::UNDEFINED))
}

fn tramp_construct_body(
    handle: f64,
    args_v8: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    with_context(|ctx| {
        heal_at_entry(ctx);
        let Some(o) = get_boa(handle as u64) else {
            return Ok(wasm_bindgen::JsValue::UNDEFINED);
        };
        let args = unpack_args(&args_v8, ctx);
        match o.construct(&args, None, ctx) {
            Ok(inst) => Ok(boa_to_v8(&BoaValue::from(inst), ctx)),
            Err(e) => {
                if boa_strict() {
                    Err(error_to_v8(&e, ctx))
                } else {
                    Ok(wasm_bindgen::JsValue::UNDEFINED)
                }
            }
        }
    })
    .unwrap_or(Ok(wasm_bindgen::JsValue::UNDEFINED))
}

fn tramp_method_body(
    fn_handle: f64,
    recv_handle: f64,
    args_v8: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    with_context(|ctx| {
        heal_at_entry(ctx);
        let Some(jsfn) = get_boa(fn_handle as u64).and_then(JsFunction::from_object) else {
            return Ok(wasm_bindgen::JsValue::UNDEFINED);
        };
        let this = get_boa(recv_handle as u64)
            .map(|o| o.into())
            .unwrap_or(BoaValue::undefined());
        let args = unpack_args(&args_v8, ctx);
        match jsfn.call(&this, &args, ctx) {
            Ok(res) => Ok(boa_to_v8(&res, ctx)),
            Err(e) => {
                if boa_strict() {
                    Err(error_to_v8(&e, ctx))
                } else {
                    Ok(wasm_bindgen::JsValue::UNDEFINED)
                }
            }
        }
    })
    .unwrap_or(Ok(wasm_bindgen::JsValue::UNDEFINED))
}

// Build the three shims once; deliberately leaked for the isolate's
// life (same bounded-singleton class as the proxy shims + FR callback).
fn tramp_shims() -> (
    wasm_bindgen::JsValue,
    wasm_bindgen::JsValue,
    wasm_bindgen::JsValue,
) {
    if let Some(t) = TRAMP_SHIMS.with(|c| c.borrow().clone()) {
        return t;
    }
    type J = wasm_bindgen::JsValue;
    type R = Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;
    let call = Closure::<dyn Fn(f64, J, J) -> R>::new(tramp_call_body);
    let ctor = Closure::<dyn Fn(f64, J) -> R>::new(tramp_construct_body);
    let method = Closure::<dyn Fn(f64, f64, J) -> R>::new(tramp_method_body);
    let t = (
        call.as_ref().clone(),
        ctor.as_ref().clone(),
        method.as_ref().clone(),
    );
    call.forget();
    ctor.forget();
    method.forget();
    TRAMP_SHIMS.with(|c| *c.borrow_mut() = Some(t.clone()));
    t
}

// PageScript helpers bind trampoline shims, read from the internals record at mint time so a test
// stub (boa-ctx-reentry) remains observable.
fn helper_wrap3(
    name: &'static str,
    a: &wasm_bindgen::JsValue,
    b: &wasm_bindgen::JsValue,
    c: &wasm_bindgen::JsValue,
) -> wasm_bindgen::JsValue {
    if let Some(helper) = crate::js::internals::get(name) {
        // typeof, not `instanceof Function`: this runs with boa's borrow
        // live, and an instanceof on a bridged function would fire its
        // getPrototypeOf trap and re-enter boa (the ctx-reentry hijack).
        if helper.is_function() {
            let func: &js_sys::Function = helper.unchecked_ref();
            if let Ok(wrapped) = func.call3(&wasm_bindgen::JsValue::UNDEFINED, a, b, c) {
                return wrapped;
            }
        }
    }
    a.clone()
}

fn unpack_args(args_v8: &wasm_bindgen::JsValue, ctx: &mut Context) -> Vec<BoaValue> {
    if let Some(arr) = args_v8.dyn_ref::<js_sys::Array>() {
        arr.iter().map(|v| v8_to_boa(v, ctx)).collect()
    } else if args_v8.is_undefined() {
        Vec::new()
    } else {
        vec![v8_to_boa(args_v8.clone(), ctx)]
    }
}

fn stamp_fn_name(f: &wasm_bindgen::JsValue, boa_fn: &JsObject, ctx: &mut Context) {
    let Ok(n) = boa_fn.get(js_string!("name"), ctx) else {
        return;
    };
    let Some(name) = n.as_string().map(|s| s.to_std_string_escaped()) else {
        return;
    };
    if name.is_empty() {
        return;
    }
    let desc = js_sys::Object::new();
    let _ = js_sys::Reflect::set(
        &desc,
        &wasm_bindgen::JsValue::from_str("value"),
        &wasm_bindgen::JsValue::from_str(&name),
    );
    let _ = js_sys::Reflect::set(
        &desc,
        &wasm_bindgen::JsValue::from_str("configurable"),
        &wasm_bindgen::JsValue::TRUE,
    );
    if let Some(obj) = f.dyn_ref::<js_sys::Object>() {
        let _ =
            js_sys::Object::define_property(obj, &wasm_bindgen::JsValue::from_str("name"), &desc);
    }
}

fn make_boa_fn_trampoline(boa_fn: JsObject, ctx: &mut Context) -> (wasm_bindgen::JsValue, u64) {
    let named = boa_fn.clone();
    let unwrap_handle = pin_boa(boa_fn);
    let (call, ctor, _) = tramp_shims();
    let f = helper_wrap3(
        "wrapBoaFunction",
        &call,
        &ctor,
        &wasm_bindgen::JsValue::from_f64(unwrap_handle as f64),
    );
    let _ = js_sys::Reflect::set(
        &f,
        &wasm_bindgen::JsValue::from_str(BOA_UNWRAP_KEY),
        &wasm_bindgen::JsValue::from_f64(unwrap_handle as f64),
    );
    stamp_fn_name(&f, &named, ctx);
    our_v8_register(&f, unwrap_handle);
    (f, unwrap_handle)
}

fn make_boa_method_trampoline(
    boa_fn: JsObject,
    recv_handle: u64,
    ctx: &mut Context,
) -> wasm_bindgen::JsValue {
    let named = boa_fn.clone();
    let unwrap_handle = pin_boa(boa_fn);
    let (_, _, method) = tramp_shims();
    let f = helper_wrap3(
        "wrapBoaMethod",
        &method,
        &wasm_bindgen::JsValue::from_f64(unwrap_handle as f64),
        &wasm_bindgen::JsValue::from_f64(recv_handle as f64),
    );
    let _ = js_sys::Reflect::set(
        &f,
        &wasm_bindgen::JsValue::from_str(BOA_UNWRAP_KEY),
        &wasm_bindgen::JsValue::from_f64(unwrap_handle as f64),
    );
    stamp_fn_name(&f, &named, ctx);
    our_v8_register(&f, unwrap_handle);
    // Method trampolines have no wrapper-cache slot; only the pin
    // releases when V8 drops the wrapper.
    fr_register(&f, unwrap_handle, None);
    f
}

fn boa_own_string_keys(obj: &JsObject, ctx: &mut Context) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(keys) = obj.own_property_keys(ctx) {
        for k in keys {
            match k {
                PropertyKey::String(s) => out.push(s.to_std_string_escaped()),
                PropertyKey::Index(i) => out.push(i.get().to_string()),
                PropertyKey::Symbol(_) => {}
            }
        }
    }
    out
}

thread_local! {
    static TARGET_HANDLES: RefCell<Option<js_sys::WeakMap>> = const { RefCell::new(None) };
    static SHARED_HANDLER: RefCell<Option<js_sys::Object>> = const { RefCell::new(None) };
}

fn target_handle_set(target: &js_sys::Object, handle: u64) {
    TARGET_HANDLES.with(|c| {
        let mut b = c.borrow_mut();
        let m = b.get_or_insert_with(js_sys::WeakMap::new);
        m.set(target, &wasm_bindgen::JsValue::from_f64(handle as f64));
    });
}

fn target_handle_get(target: &wasm_bindgen::JsValue) -> Option<u64> {
    if !target.is_object() && !target.is_function() {
        return None;
    }
    TARGET_HANDLES.with(|c| {
        let b = c.borrow();
        let m = b.as_ref()?;
        m.get(target.unchecked_ref::<js_sys::Object>())
            .as_f64()
            .map(|n| n as u64)
    })
}

fn shim_get(
    target: wasm_bindgen::JsValue,
    key: wasm_bindgen::JsValue,
    recv: wasm_bindgen::JsValue,
) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::UNDEFINED;
    };
    // I3: answer the unwrap probe with our boa pin handle so a
    // round-trip back into boa recovers the original object.
    let key_str = key.as_string();
    if key_str.as_deref() == Some(BOA_UNWRAP_KEY) {
        return wasm_bindgen::JsValue::from_f64(handle as f64);
    }
    let inherited = !recv.is_undefined() && our_v8_lookup(&recv) != Some(handle);
    with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return wasm_bindgen::JsValue::UNDEFINED;
        };
        let pk: PropertyKey = match key_str.as_deref() {
            Some(k) => JsString::from(k).into(),
            None if key.is_symbol() => PropertyKey::Symbol(v8_symbol_to_boa(
                key.clone().unchecked_into::<js_sys::Symbol>(),
                ctx,
            )),
            None => js_string!().into(),
        };
        let owner = if target.is_function() {
            boa_fn_carries(&o, &pk, ctx)
        } else if o.has_own_property(pk.clone(), ctx).unwrap_or(false) {
            FnKeyOwner::Boa
        } else {
            boa_chain_owner(&o, &pk, None, ctx)
        };
        match owner {
            FnKeyOwner::Boa => {}
            FnKeyOwner::V8Super(sup) => {
                return with_v8(ctx, || reflect_get_with_receiver(&sup, &key, &recv))
                    .unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
            }
            FnKeyOwner::FunctionProto if target.is_function() => {
                return js_sys::Reflect::get(&target, &key)
                    .unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
            }
            FnKeyOwner::FunctionProto => {}
        }
        let res = o.get(pk, ctx);
        match res {
            Ok(bv) => match bv.as_object() {
                Some(fobj) if fobj.is_callable() => {
                    // A V8 function boa stored (React's `onData: setState`
                    // in a props object built by boa code) must read back
                    // as itself. A fresh trampoline per read broke
                    // `prev === next` checks and re-ran effects forever.
                    if let Some(h) = bridged_v8_handle(&fobj, ctx) {
                        return get_v8(h);
                    }
                    match boa_intrinsic_ctor_name(&fobj, ctx).and_then(v8_intrinsic) {
                        Some(v8) => v8,
                        None if inherited => boa_to_v8(&bv, ctx),
                        None if fobj.is_constructor() => boa_to_v8(&bv, ctx),
                        None => make_boa_method_trampoline(fobj.clone(), handle, ctx),
                    }
                }
                _ => boa_to_v8(&bv, ctx),
            },
            Err(_) => wasm_bindgen::JsValue::UNDEFINED,
        }
    })
    .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

enum FnKeyOwner {
    Boa,
    V8Super(wasm_bindgen::JsValue),
    FunctionProto,
}

fn boa_chain_owner(
    o: &JsObject,
    key: &PropertyKey,
    stop: Option<&JsObject>,
    ctx: &mut Context,
) -> FnKeyOwner {
    let mut cur = Some(o.clone());
    for _ in 0..64 {
        let Some(c) = cur else {
            return FnKeyOwner::FunctionProto;
        };
        if stop.is_some_and(|s| JsObject::equals(&c, s)) {
            return FnKeyOwner::FunctionProto;
        }
        if let Some(h) = bridged_v8_handle(&c, ctx) {
            return FnKeyOwner::V8Super(get_v8(h));
        }
        if c.has_own_property(key.clone(), ctx).unwrap_or(false) {
            return FnKeyOwner::Boa;
        }
        cur = c.prototype().clone();
    }
    FnKeyOwner::FunctionProto
}

fn boa_fn_carries(o: &JsObject, key: &PropertyKey, ctx: &mut Context) -> FnKeyOwner {
    let fproto = ctx.intrinsics().constructors().function().prototype();
    boa_chain_owner(o, key, Some(&fproto), ctx)
}

// `Reflect.get(target, key, receiver)` — js_sys only binds the two-argument
// form, and the receiver is the point: a V8 getter found up the chain has
// to run with `this` = the object the read started from.
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Reflect, js_name = get, catch)]
    fn reflect_get_with_receiver(
        target: &wasm_bindgen::JsValue,
        key: &wasm_bindgen::JsValue,
        receiver: &wasm_bindgen::JsValue,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;
}

fn shim_has(target: wasm_bindgen::JsValue, key: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::from_bool(false);
    };
    if target.is_function() && key.as_string().as_deref() == Some("prototype") {
        return wasm_bindgen::JsValue::from_bool(true);
    }
    with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return wasm_bindgen::JsValue::from_bool(false);
        };
        let pk = v8_key_to_boa(&key, ctx);
        if matches!(o.get(pk.clone(), ctx), Ok(ref v) if !v.is_undefined()) {
            return wasm_bindgen::JsValue::TRUE;
        }
        let shell = target.unchecked_ref::<js_sys::Object>();
        let slot = shell_slot(shell, &key);
        if !slot.is_object() {
            return wasm_bindgen::JsValue::FALSE;
        }
        if slot_is_fixed(&slot) || o.has_own_property(pk, ctx).unwrap_or(false) {
            return wasm_bindgen::JsValue::TRUE;
        }
        let _ = js_sys::Reflect::delete_property(shell, &key);
        wasm_bindgen::JsValue::FALSE
    })
    .unwrap_or(wasm_bindgen::JsValue::from_bool(false))
}

fn boa_chain_setter(
    o: &JsObject,
    key: &PropertyKey,
    ctx: &mut Context,
) -> Option<Option<JsObject>> {
    let object_ctor = ctx.intrinsics().constructors().object().constructor();
    let gopd = object_ctor
        .get(js_string!("getOwnPropertyDescriptor"), ctx)
        .ok()?
        .as_callable()?;
    let key_v: BoaValue = match key {
        PropertyKey::String(s) => s.clone().into(),
        PropertyKey::Symbol(s) => s.clone().into(),
        PropertyKey::Index(i) => BoaValue::from(i.get()),
    };
    let mut cur = Some(o.clone());
    for _ in 0..64 {
        let c = cur?;
        if c.has_own_property(key.clone(), ctx).ok()? {
            let d = gopd
                .call(
                    &BoaValue::undefined(),
                    &[c.clone().into(), key_v.clone()],
                    ctx,
                )
                .ok()?;
            let d = d.as_object()?.clone();
            let getter = d.get(js_string!("get"), ctx).ok()?;
            let setter = d.get(js_string!("set"), ctx).ok()?;
            if getter.is_undefined() && setter.is_undefined() {
                return None;
            }
            return Some(setter.as_callable());
        }
        cur = c.prototype().clone();
    }
    None
}

fn v8_inherits_from_ours(recv: &wasm_bindgen::JsValue, handle: u64) -> bool {
    let mut cur: wasm_bindgen::JsValue = recv.clone();
    for _ in 0..64 {
        let Some(obj) = cur.dyn_ref::<js_sys::Object>().cloned() else {
            return false;
        };
        let Ok(p) = js_sys::Reflect::get_prototype_of(&obj) else {
            return false;
        };
        let pv: wasm_bindgen::JsValue = p.into();
        if pv.is_null() || pv.is_undefined() {
            return false;
        }
        if our_v8_lookup(&pv) == Some(handle) {
            return true;
        }
        cur = pv;
    }
    false
}

fn shim_set(
    target: wasm_bindgen::JsValue,
    key: wasm_bindgen::JsValue,
    val: wasm_bindgen::JsValue,
    recv: wasm_bindgen::JsValue,
) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::from_bool(false);
    };
    if !recv.is_undefined()
        && our_v8_lookup(&recv) != Some(handle)
        && v8_inherits_from_ours(&recv, handle)
    {
        if let Some(recv_obj) = recv.dyn_ref::<js_sys::Object>() {
            enum Inherited {
                V8(wasm_bindgen::JsValue),
                Setter(Option<Option<JsObject>>),
            }
            let inherited = with_context(|ctx| {
                let o = get_boa(handle)?;
                let pk: PropertyKey = if key.is_symbol() {
                    PropertyKey::Symbol(v8_symbol_to_boa(
                        key.clone().unchecked_into::<js_sys::Symbol>(),
                        ctx,
                    ))
                } else {
                    JsString::from(key.as_string().unwrap_or_default().as_str()).into()
                };
                if let FnKeyOwner::V8Super(sup) = boa_chain_owner(&o, &pk, None, ctx) {
                    return Some(Inherited::V8(sup));
                }
                Some(Inherited::Setter(boa_chain_setter(&o, &pk, ctx)))
            })
            .flatten();
            let setter = match inherited {
                Some(Inherited::V8(sup)) => {
                    let ok = with_context(|ctx| {
                        with_v8(ctx, || {
                            js_sys::Reflect::set_with_receiver(&sup, &key, &val, &recv)
                        })
                        .unwrap_or(false)
                    })
                    .unwrap_or(false);
                    return wasm_bindgen::JsValue::from_bool(ok);
                }
                Some(Inherited::Setter(s)) => s,
                None => None,
            };
            match setter {
                Some(Some(setter_fn)) => {
                    let ok = with_context(|ctx| {
                        let this_b = v8_to_boa(recv.clone(), ctx);
                        let v_b = v8_to_boa(val.clone(), ctx);
                        setter_fn.call(&this_b, &[v_b], ctx).is_ok()
                    })
                    .unwrap_or(false);
                    return wasm_bindgen::JsValue::from_bool(ok);
                }
                Some(None) => return wasm_bindgen::JsValue::from_bool(false),
                None => {}
            }
            let has_own = js_sys::Reflect::get_own_property_descriptor(recv_obj, &key)
                .map(|d| !d.is_undefined())
                .unwrap_or(false);
            let d = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&d, &wasm_bindgen::JsValue::from_str("value"), &val);
            if !has_own {
                let _ = js_sys::Reflect::set(
                    &d,
                    &wasm_bindgen::JsValue::from_str("writable"),
                    &wasm_bindgen::JsValue::TRUE,
                );
                let _ = js_sys::Reflect::set(
                    &d,
                    &wasm_bindgen::JsValue::from_str("enumerable"),
                    &wasm_bindgen::JsValue::TRUE,
                );
                let _ = js_sys::Reflect::set(
                    &d,
                    &wasm_bindgen::JsValue::from_str("configurable"),
                    &wasm_bindgen::JsValue::TRUE,
                );
            }
            let ok = js_sys::Reflect::define_property(recv_obj, &key, &d).unwrap_or(false);
            return wasm_bindgen::JsValue::from_bool(ok);
        }
    }
    with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return wasm_bindgen::JsValue::from_bool(false);
        };
        let bv = v8_to_boa(val, ctx);
        let ok = if key.is_symbol() {
            o.set(
                PropertyKey::Symbol(v8_symbol_to_boa(
                    key.clone().unchecked_into::<js_sys::Symbol>(),
                    ctx,
                )),
                bv,
                false,
                ctx,
            )
        } else {
            o.set(
                JsString::from(key.as_string().unwrap_or_default().as_str()),
                bv,
                false,
                ctx,
            )
        };
        wasm_bindgen::JsValue::from_bool(ok.unwrap_or(false))
    })
    .unwrap_or(wasm_bindgen::JsValue::from_bool(false))
}

fn shim_delete(target: wasm_bindgen::JsValue, key: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::from_bool(false);
    };
    with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return wasm_bindgen::JsValue::from_bool(false);
        };
        let pk: PropertyKey = if key.is_symbol() {
            PropertyKey::Symbol(v8_symbol_to_boa(
                key.clone().unchecked_into::<js_sys::Symbol>(),
                ctx,
            ))
        } else {
            PropertyKey::from(JsString::from(key.as_string().unwrap_or_default().as_str()))
        };
        let ok = o.delete_property_or_throw(pk, ctx).unwrap_or(false);
        if let (true, Some(shell)) = (ok, target.dyn_ref::<js_sys::Object>()) {
            let _ = js_sys::Reflect::delete_property(shell, &key);
        }
        wasm_bindgen::JsValue::from_bool(ok)
    })
    .unwrap_or(wasm_bindgen::JsValue::from_bool(false))
}

fn shim_define(
    target: wasm_bindgen::JsValue,
    key: wasm_bindgen::JsValue,
    desc: wasm_bindgen::JsValue,
) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::from_bool(false);
    };
    let Some(shell) = target.dyn_ref::<js_sys::Object>() else {
        return wasm_bindgen::JsValue::from_bool(false);
    };
    let field = |n: &str| -> Option<wasm_bindgen::JsValue> {
        let k = wasm_bindgen::JsValue::from_str(n);
        if js_sys::Reflect::has(&desc, &k).unwrap_or(false) {
            js_sys::Reflect::get(&desc, &k).ok()
        } else {
            None
        }
    };
    let slot: wasm_bindgen::JsValue = js_sys::Reflect::get_own_property_descriptor(shell, &key)
        .unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
    let slot_fixed = slot.is_object() && !desc_field(&slot, "configurable").is_truthy();
    if !slot.is_object() && !js_sys::Reflect::is_extensible(shell).unwrap_or(true) {
        return wasm_bindgen::JsValue::from_bool(false);
    }
    if slot_fixed && !fixed_slot_accepts(&slot, &field) {
        return wasm_bindgen::JsValue::from_bool(false);
    }
    let (value, writable) = (field("value"), field("writable"));
    let (getter, setter) = (field("get"), field("set"));
    let (enumerable, configurable) = (field("enumerable"), field("configurable"));
    let asked_fixed = configurable.as_ref().is_some_and(|c| !c.is_truthy());
    enum Defined {
        Rejected,
        InBoa,
        Mirror(Option<js_sys::Object>),
    }
    let outcome = with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return Defined::Rejected;
        };
        let pk: PropertyKey = if key.is_symbol() {
            PropertyKey::Symbol(v8_symbol_to_boa(
                key.clone().unchecked_into::<js_sys::Symbol>(),
                ctx,
            ))
        } else {
            PropertyKey::from(JsString::from(key.as_string().unwrap_or_default().as_str()))
        };
        let mut b = PropertyDescriptor::builder();
        if let Some(g) = getter {
            b = b.get(v8_to_boa(g, ctx));
        }
        if let Some(st) = setter {
            b = b.set(v8_to_boa(st, ctx));
        }
        if let Some(v) = value {
            b = b.value(v8_to_boa(v, ctx));
        }
        if let Some(w) = &writable {
            b = b.writable(w.is_truthy());
        }
        if let Some(e) = &enumerable {
            b = b.enumerable(e.is_truthy());
        }
        if let Some(c) = &configurable {
            b = b.configurable(c.is_truthy());
        }
        if o.define_property_or_throw(pk.clone(), b.build(), ctx)
            .is_err()
        {
            return Defined::Rejected;
        }
        let own = {
            let obj = o.try_borrow().ok();
            let own = obj.as_ref().and_then(|obj| obj.properties().get(&pk));
            drop(obj);
            own
        };
        let fixed = own
            .as_ref()
            .map_or(asked_fixed, |d| d.configurable() == Some(false));
        if !fixed && !slot_fixed {
            return Defined::InBoa;
        }
        Defined::Mirror(own.map(|d| boa_desc_to_v8(&d, ctx)))
    })
    .unwrap_or(Defined::Rejected);
    let ok = match outcome {
        Defined::Rejected | Defined::Mirror(None) => false,
        Defined::InBoa => true,
        Defined::Mirror(Some(mirror)) => {
            // V8 compares get/set/value with a fixed slot by identity, so they come from that slot
            // or the caller, never a trampoline boa_to_v8 minted afresh (a partial re-define).
            if slot_fixed {
                for name in ["get", "set"] {
                    let k = wasm_bindgen::JsValue::from_str(name);
                    if js_sys::Reflect::has(&slot, &k).unwrap_or(false) {
                        let _ = js_sys::Reflect::set(&mirror, &k, &desc_field(&slot, name));
                    }
                }
            }
            for name in ["get", "set", "value"] {
                if let Some(v) = field(name) {
                    let _ =
                        js_sys::Reflect::set(&mirror, &wasm_bindgen::JsValue::from_str(name), &v);
                }
            }
            mark_slotted(handle);
            js_sys::Reflect::define_property(shell, &key, &mirror).unwrap_or(false)
        }
    };
    wasm_bindgen::JsValue::from_bool(ok)
}

fn desc_field(d: &wasm_bindgen::JsValue, name: &str) -> wasm_bindgen::JsValue {
    js_sys::Reflect::get(d, &wasm_bindgen::JsValue::from_str(name))
        .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

fn v8_key_to_boa(key: &wasm_bindgen::JsValue, ctx: &mut Context) -> PropertyKey {
    if key.is_symbol() {
        PropertyKey::Symbol(v8_symbol_to_boa(
            key.clone().unchecked_into::<js_sys::Symbol>(),
            ctx,
        ))
    } else {
        PropertyKey::from(JsString::from(key.as_string().unwrap_or_default().as_str()))
    }
}

fn boa_key_to_v8(pk: &PropertyKey, ctx: &mut Context) -> wasm_bindgen::JsValue {
    match pk {
        PropertyKey::String(s) => boa_str_to_v8(s),
        PropertyKey::Index(i) => wasm_bindgen::JsValue::from_str(&i.get().to_string()),
        PropertyKey::Symbol(s) => boa_symbol_to_v8(s, ctx).into(),
    }
}

fn boa_own_desc(o: &JsObject, pk: &PropertyKey) -> Option<PropertyDescriptor> {
    let obj = o.try_borrow().ok()?;
    let own = obj.properties().get(pk);
    drop(obj);
    own
}

// Handles whose shell (proxy target) holds own slots: a fixed define, a gopd mirror or a
// closed shell. Any other object shell is empty, so its slot lookup can skip a crossing.
thread_local! {
    static SLOTTED: RefCell<std::collections::HashSet<u64>> = RefCell::new(std::collections::HashSet::new());
}

fn mark_slotted(handle: u64) {
    SLOTTED.with(|s| s.borrow_mut().insert(handle));
}

fn is_slotted(handle: u64) -> bool {
    SLOTTED.with(|s| s.borrow().contains(&handle))
}

fn shell_slot(shell: &js_sys::Object, key: &wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    js_sys::Reflect::get_own_property_descriptor(shell, key)
        .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

fn slot_is_fixed(slot: &wasm_bindgen::JsValue) -> bool {
    slot.is_object() && !desc_field(slot, "configurable").is_truthy()
}

fn close_shell(shell: &js_sys::Object, o: &JsObject, ctx: &mut Context) {
    if !js_sys::Reflect::is_extensible(shell).unwrap_or(false) {
        return;
    }
    if let Some(handle) = target_handle_get(shell) {
        mark_slotted(handle);
    }
    let stand_in = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&stand_in, &"writable".into(), &wasm_bindgen::JsValue::TRUE);
    let _ = js_sys::Reflect::set(
        &stand_in,
        &"configurable".into(),
        &wasm_bindgen::JsValue::TRUE,
    );
    let listed = js_sys::Set::new(&wasm_bindgen::JsValue::UNDEFINED);
    let stamp = stamp_pk();
    for pk in o.own_property_keys(ctx).unwrap_or_default() {
        if pk == stamp {
            continue;
        }
        let key = boa_key_to_v8(&pk, ctx);
        listed.add(&key);
        match boa_own_desc(o, &pk) {
            Some(d) if d.configurable() == Some(false) => {
                let _ = js_sys::Reflect::define_property(shell, &key, &boa_desc_to_v8(&d, ctx));
            }
            _ if !shell_slot(shell, &key).is_object() => {
                let _ = js_sys::Reflect::define_property(shell, &key, &stand_in);
            }
            _ => {}
        }
    }
    for k in js_sys::Reflect::own_keys(shell)
        .map(|a| a.to_vec())
        .unwrap_or_default()
    {
        if !listed.has(&k) {
            let _ = js_sys::Reflect::delete_property(shell, &k);
        }
    }
    let _ = js_sys::Reflect::prevent_extensions(shell);
}

fn prune_shell(shell: &js_sys::Object, o: &JsObject, ctx: &mut Context) {
    for k in js_sys::Reflect::own_keys(shell)
        .map(|a| a.to_vec())
        .unwrap_or_default()
    {
        let slot = shell_slot(shell, &k);
        if slot.is_object()
            && !slot_is_fixed(&slot)
            && boa_own_desc(o, &v8_key_to_boa(&k, ctx)).is_none()
        {
            let _ = js_sys::Reflect::delete_property(shell, &k);
        }
    }
}

fn shim_is_extensible(target: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    let Some(shell) = target.dyn_ref::<js_sys::Object>() else {
        return wasm_bindgen::JsValue::FALSE;
    };
    if js_sys::Reflect::is_extensible(shell).unwrap_or(false) {
        if let Some(handle) = target_handle_get(&target) {
            with_context(|ctx| {
                if let Some(o) = get_boa(handle).filter(|o| o.is_extensible(ctx).is_ok_and(|e| !e))
                {
                    close_shell(shell, &o, ctx);
                }
            });
        }
    }
    wasm_bindgen::JsValue::from_bool(js_sys::Reflect::is_extensible(shell).unwrap_or(false))
}

fn shim_prevent_extensions(target: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    let (Some(handle), Some(shell)) = (
        target_handle_get(&target),
        target.dyn_ref::<js_sys::Object>(),
    ) else {
        return wasm_bindgen::JsValue::FALSE;
    };
    let closed = with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return false;
        };
        let args = [BoaValue::from(o.clone())];
        if OrdinaryObject::prevent_extensions(&BoaValue::undefined(), &args, ctx).is_err() {
            return false;
        }
        close_shell(shell, &o, ctx);
        true
    })
    .unwrap_or(false);
    wasm_bindgen::JsValue::from_bool(
        closed && !js_sys::Reflect::is_extensible(shell).unwrap_or(true),
    )
}

fn fixed_slot_accepts(
    slot: &wasm_bindgen::JsValue,
    field: &dyn Fn(&str) -> Option<wasm_bindgen::JsValue>,
) -> bool {
    if field("configurable").is_some_and(|c| c.is_truthy()) {
        return false;
    }
    if field("enumerable")
        .is_some_and(|e| e.is_truthy() != desc_field(slot, "enumerable").is_truthy())
    {
        return false;
    }
    let accessor = field("get").is_some() || field("set").is_some();
    let data = field("value").is_some() || field("writable").is_some();
    let slot_accessor =
        js_sys::Reflect::has(slot, &wasm_bindgen::JsValue::from_str("get")).unwrap_or(false);
    if (accessor && !slot_accessor) || (data && slot_accessor) {
        return false;
    }
    let same = |n: &str| field(n).is_none_or(|v| js_sys::Object::is(&v, &desc_field(slot, n)));
    if slot_accessor {
        return same("get") && same("set");
    }
    desc_field(slot, "writable").is_truthy()
        || (!field("writable").is_some_and(|w| w.is_truthy()) && same("value"))
}

// Descriptor field names, decoded once: building a descriptor re-decoded all four
// per call, and React's for-in over a boa props object asks for two per key.
thread_local! {
    static DESC_KEYS: [wasm_bindgen::JsValue; 6] =
        ["value", "writable", "enumerable", "configurable", "get", "set"].map(wasm_bindgen::JsValue::from_str);
    static DESC_HELPERS: RefCell<Option<(js_sys::Function, js_sys::Function)>> = const { RefCell::new(None) };
}

// page-script's one-call descriptor builders: an object literal in V8 instead of
// an empty object plus four Reflect.set crossings. Absent, the slow path stands.
pub(crate) fn install_desc_helpers(data: js_sys::Function, accessor: js_sys::Function) {
    DESC_HELPERS.with(|h| *h.borrow_mut() = Some((data, accessor)));
}

const DESC_VALUE: usize = 0;
const DESC_WRITABLE: usize = 1;
const DESC_ENUMERABLE: usize = 2;
const DESC_CONFIGURABLE: usize = 3;
const DESC_GET: usize = 4;
const DESC_SET: usize = 5;

fn desc_flags(d: &PropertyDescriptor) -> wasm_bindgen::JsValue {
    let bit = |b: Option<bool>, v: u8| if b.unwrap_or(false) { v } else { 0 };
    wasm_bindgen::JsValue::from_f64(f64::from(
        bit(d.writable(), 1) | bit(d.enumerable(), 2) | bit(d.configurable(), 4),
    ))
}

fn boa_desc_to_v8(d: &PropertyDescriptor, ctx: &mut Context) -> js_sys::Object {
    let helpers = DESC_HELPERS.with(|h| h.borrow().clone());
    if let Some((data, accessor)) = helpers {
        let built = if d.is_accessor_descriptor() {
            let side = |f: Option<&BoaValue>, ctx: &mut Context| match f {
                Some(f) if f.is_callable() => boa_to_v8(f, ctx),
                _ => wasm_bindgen::JsValue::UNDEFINED,
            };
            let (g, st) = (side(d.get(), ctx), side(d.set(), ctx));
            accessor.call3(&wasm_bindgen::JsValue::UNDEFINED, &g, &st, &desc_flags(d))
        } else {
            let v = d
                .value()
                .map_or(wasm_bindgen::JsValue::UNDEFINED, |v| boa_to_v8(v, ctx));
            data.call2(&wasm_bindgen::JsValue::UNDEFINED, &v, &desc_flags(d))
        };
        if let Ok(o) = built {
            return o.unchecked_into();
        }
    }
    let out = js_sys::Object::new();
    let put = |idx: usize, v: &wasm_bindgen::JsValue| {
        DESC_KEYS.with(|keys| {
            let _ = js_sys::Reflect::set(&out, &keys[idx], v);
        });
    };
    if d.is_accessor_descriptor() {
        for (idx, f) in [(DESC_GET, d.get()), (DESC_SET, d.set())] {
            let v = match f {
                Some(f) if f.is_callable() => boa_to_v8(f, ctx),
                _ => wasm_bindgen::JsValue::UNDEFINED,
            };
            put(idx, &v);
        }
    } else {
        let v = d
            .value()
            .map_or(wasm_bindgen::JsValue::UNDEFINED, |v| boa_to_v8(v, ctx));
        put(DESC_VALUE, &v);
        put(
            DESC_WRITABLE,
            &wasm_bindgen::JsValue::from_bool(d.writable().unwrap_or(false)),
        );
    }
    put(
        DESC_ENUMERABLE,
        &wasm_bindgen::JsValue::from_bool(d.enumerable().unwrap_or(false)),
    );
    put(
        DESC_CONFIGURABLE,
        &wasm_bindgen::JsValue::from_bool(d.configurable().unwrap_or(false)),
    );
    out
}

fn shim_get_proto(target: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    // V8 owns function-prototype checks so `Function` tests cannot re-enter Boa.
    if target.is_function() {
        if let Some(obj) = target.dyn_ref::<js_sys::Object>() {
            if let Ok(p) = js_sys::Reflect::get_prototype_of(obj) {
                return p.into();
            }
        }
    }
    let named = target_handle_get(&target).and_then(|handle| {
        with_context(|ctx| {
            let o = get_boa(handle)?;
            if let Some(name) = boa_builtin_ctor_name(&o, ctx) {
                return v8_builtin_prototype(name);
            }
            let proto = o.prototype().clone()?;
            let ctor = proto.get(js_string!("constructor"), ctx).ok()?;
            let ctor = ctor.as_object()?;
            if boa_intrinsic_ctor_name(&ctor, ctx).is_some() {
                return None;
            }
            Some(boa_to_v8(&proto.into(), ctx))
        })
        .flatten()
    });
    if let Some(p) = named {
        return p;
    }
    if let Some(obj) = target.dyn_ref::<js_sys::Object>() {
        if let Ok(p) = js_sys::Reflect::get_prototype_of(obj) {
            return p.into();
        }
    }
    wasm_bindgen::JsValue::NULL
}

fn shim_own_keys(target: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    if let Some(obj) = target.dyn_ref::<js_sys::Object>() {
        if !js_sys::Reflect::is_extensible(obj).unwrap_or(true) {
            if let Some(handle) = target_handle_get(&target) {
                with_context(|ctx| get_boa(handle).map(|o| prune_shell(obj, &o, ctx)));
            }
            let all = js_sys::Array::new();
            for k in js_sys::Object::get_own_property_names(obj).iter() {
                all.push(&k);
            }
            for k in js_sys::Object::get_own_property_symbols(obj).iter() {
                all.push(&k);
            }
            return all.into();
        }
    }
    let arr = js_sys::Array::new();
    let Some(handle) = target_handle_get(&target) else {
        return arr.into();
    };
    let mut saw_length = false;
    let mut saw_prototype = false;
    with_context(|ctx| {
        if let Some(o) = get_boa(handle) {
            for k in boa_own_string_keys(&o, ctx) {
                if k == "length" {
                    saw_length = true;
                }
                if k == "prototype" {
                    saw_prototype = true;
                }
                arr.push(&v8_key(&k));
            }
        }
    });
    if js_sys::Array::is_array(&target) && !saw_length {
        arr.push(&wasm_bindgen::JsValue::from_str("length"));
    }
    if target.is_function() && !saw_prototype {
        arr.push(&wasm_bindgen::JsValue::from_str("prototype"));
    }
    if let Some(shell) = target.dyn_ref::<js_sys::Object>() {
        for k in js_sys::Reflect::own_keys(shell)
            .map(|a| a.to_vec())
            .unwrap_or_default()
        {
            let fixed = js_sys::Reflect::get_own_property_descriptor(shell, &k)
                .is_ok_and(|d| d.is_object() && !desc_field(&d, "configurable").is_truthy());
            if fixed && !arr.includes(&k, 0) {
                arr.push(&k);
            }
        }
    }
    arr.into()
}

// Read Boa's property map without descriptor callbacks under a live Context borrow.
// V8 checks proxy invariants against the target's fixed `prototype` descriptor.
fn boa_prototype_writable(o: &JsObject) -> bool {
    let Ok(obj) = o.try_borrow() else {
        return false;
    };
    obj.properties()
        .get(&PropertyKey::from(js_string!("prototype")))
        .and_then(|d| d.writable())
        .unwrap_or(false)
}

fn shim_gopd(target: wasm_bindgen::JsValue, key: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    let Some(handle) = target_handle_get(&target) else {
        return wasm_bindgen::JsValue::UNDEFINED;
    };
    with_context(|ctx| {
        let Some(o) = get_boa(handle) else {
            return wasm_bindgen::JsValue::UNDEFINED;
        };
        let key_str = key.as_string();
        let k = key_str.as_deref().unwrap_or_default();
        // Match the function target's fixed `prototype` descriptor, or V8's invariant check throws.
        if k == "prototype" && target.is_function() {
            let writable = boa_prototype_writable(&o);
            let proto = o
                .get(js_string!("prototype"), ctx)
                .map(|v| boa_to_v8(&v, ctx))
                .unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
            let d = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&d, &wasm_bindgen::JsValue::from_str("value"), &proto);
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("writable"),
                &wasm_bindgen::JsValue::from_bool(writable),
            );
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("enumerable"),
                &wasm_bindgen::JsValue::FALSE,
            );
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("configurable"),
                &wasm_bindgen::JsValue::FALSE,
            );
            return d.into();
        }
        // Array targets require a non-configurable `length` descriptor.
        if k == "length" && js_sys::Array::is_array(&target) {
            let len = o
                .get(js_string!("length"), ctx)
                .ok()
                .and_then(|v| v.as_number())
                .unwrap_or(0.0);
            let writable = js_sys::Reflect::get_own_property_descriptor(
                target.unchecked_ref::<js_sys::Object>(),
                &key,
            )
            .map_or(true, |d| desc_field(&d, "writable").is_truthy());
            let d = js_sys::Object::new();
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("value"),
                &wasm_bindgen::JsValue::from_f64(len),
            );
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("writable"),
                &wasm_bindgen::JsValue::from_bool(writable),
            );
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("enumerable"),
                &wasm_bindgen::JsValue::FALSE,
            );
            let _ = js_sys::Reflect::set(
                &d,
                &wasm_bindgen::JsValue::from_str("configurable"),
                &wasm_bindgen::JsValue::FALSE,
            );
            return d.into();
        }
        let pk = match key_str.as_deref() {
            Some(k) => PropertyKey::from(JsString::from(k)),
            None if key.is_symbol() => PropertyKey::Symbol(v8_symbol_to_boa(
                key.clone().unchecked_into::<js_sys::Symbol>(),
                ctx,
            )),
            None => PropertyKey::from(js_string!()),
        };
        let shell = target.unchecked_ref::<js_sys::Object>();
        // A function target is a real V8 function with its own name/length
        // slots; any other shell is empty until mark_slotted says otherwise.
        let td = if is_slotted(handle) || target.is_function() {
            shell_slot(shell, &key)
        } else {
            wasm_bindgen::JsValue::UNDEFINED
        };
        let Some(own) = boa_own_desc(&o, &pk) else {
            if !slot_is_fixed(&td) {
                if td.is_object() {
                    let _ = js_sys::Reflect::delete_property(shell, &key);
                }
                return wasm_bindgen::JsValue::UNDEFINED;
            }
            if desc_field(&td, "writable").is_truthy() {
                let live = o.get(pk, ctx).unwrap_or(BoaValue::undefined());
                let _ = js_sys::Reflect::set(&td, &"value".into(), &boa_to_v8(&live, ctx));
            }
            return td;
        };
        // A fixed accessor slot holds the get/set V8 defined it with, which V8 compares by
        // identity; a reminted trampoline would fail that check on every later read.
        if own.is_accessor_descriptor() && slot_is_fixed(&td) {
            return td;
        }
        // Boa's real attributes, accessors included (svelte finds a bindable prop's setter
        // here). V8 takes a non-configurable answer only as the shell holds it, so mirror it.
        let d = boa_desc_to_v8(&own, ctx);
        let mirrored = slot_is_fixed(&td)
            && desc_field(&td, "writable").is_truthy() == own.writable().unwrap_or(false);
        if own.configurable() == Some(false) && !mirrored {
            mark_slotted(handle);
            let _ = js_sys::Reflect::define_property(shell, &key, &d);
        }
        d.into()
    })
    .unwrap_or(wasm_bindgen::JsValue::UNDEFINED)
}

// Ten shared trap closures live for the isolate lifetime.
fn shared_handler() -> js_sys::Object {
    if let Some(h) = SHARED_HANDLER.with(|c| c.borrow().clone()) {
        return h;
    }
    let handler = js_sys::Object::new();
    macro_rules! install {
        ($name:literal, $closure:expr) => {{
            let c = $closure;
            let _ = js_sys::Reflect::set(
                &handler,
                &wasm_bindgen::JsValue::from_str($name),
                c.as_ref(),
            );
            c.forget();
        }};
    }
    type J = wasm_bindgen::JsValue;
    install!("get", Closure::<dyn Fn(J, J, J) -> J>::new(shim_get));
    install!("has", Closure::<dyn Fn(J, J) -> J>::new(shim_has));
    install!("set", Closure::<dyn Fn(J, J, J, J) -> J>::new(shim_set));
    install!(
        "deleteProperty",
        Closure::<dyn Fn(J, J) -> J>::new(shim_delete)
    );
    install!(
        "getPrototypeOf",
        Closure::<dyn Fn(J) -> J>::new(shim_get_proto)
    );
    install!("ownKeys", Closure::<dyn Fn(J) -> J>::new(shim_own_keys));
    install!(
        "getOwnPropertyDescriptor",
        Closure::<dyn Fn(J, J) -> J>::new(shim_gopd)
    );
    install!(
        "defineProperty",
        Closure::<dyn Fn(J, J, J) -> J>::new(shim_define)
    );
    install!(
        "isExtensible",
        Closure::<dyn Fn(J) -> J>::new(shim_is_extensible)
    );
    install!(
        "preventExtensions",
        Closure::<dyn Fn(J) -> J>::new(shim_prevent_extensions)
    );
    SHARED_HANDLER.with(|c| *c.borrow_mut() = Some(handler.clone()));
    handler
}

thread_local! {
    static SHARED_FN_HANDLER: RefCell<Option<js_sys::Object>> = const { RefCell::new(None) };
}

fn shared_fn_handler() -> js_sys::Object {
    if let Some(h) = SHARED_FN_HANDLER.with(|c| c.borrow().clone()) {
        return h;
    }
    type J = wasm_bindgen::JsValue;
    let handler: js_sys::Object = js_sys::Object::assign(&js_sys::Object::new(), &shared_handler());
    let reflect =
        js_sys::Reflect::get(&js_sys::global(), &J::from_str("Reflect")).unwrap_or(J::UNDEFINED);
    for name in ["apply", "construct"] {
        if let Ok(f) = js_sys::Reflect::get(&reflect, &J::from_str(name)) {
            let _ = js_sys::Reflect::set(&handler, &J::from_str(name), &f);
        }
    }
    SHARED_FN_HANDLER.with(|c| *c.borrow_mut() = Some(handler.clone()));
    handler
}

fn boa_fn_to_v8_proxy(
    tramp: wasm_bindgen::JsValue,
    boa_pin: u64,
    ctx: &mut Context,
) -> wasm_bindgen::JsValue {
    let target: js_sys::Object = tramp.unchecked_into();
    if let Some(o) = get_boa(boa_pin).filter(|o| !boa_prototype_writable(o)) {
        let proto = o
            .get(js_string!("prototype"), ctx)
            .map(|v| boa_to_v8(&v, ctx))
            .unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
        let desc = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&desc, &wasm_bindgen::JsValue::from_str("value"), &proto);
        let _ = js_sys::Reflect::set(
            &desc,
            &wasm_bindgen::JsValue::from_str("writable"),
            &wasm_bindgen::JsValue::FALSE,
        );
        let _ = js_sys::Reflect::define_property(
            &target,
            &wasm_bindgen::JsValue::from_str("prototype"),
            &desc,
        );
    }
    if let Some(sup) = get_boa(boa_pin).and_then(|o| boa_fn_v8_super(&o, ctx)) {
        if let Some(sup) = sup.dyn_ref::<js_sys::Object>() {
            let _ = js_sys::Reflect::set_prototype_of(&target, sup);
        }
    }
    target_handle_set(&target, boa_pin);
    js_sys::Proxy::new(&target, &shared_fn_handler()).into()
}

fn boa_fn_v8_super(o: &JsObject, ctx: &mut Context) -> Option<wasm_bindgen::JsValue> {
    let fproto = ctx.intrinsics().constructors().function().prototype();
    let mut cur = o.prototype().clone();
    for _ in 0..64 {
        let c = cur?;
        if JsObject::equals(&c, &fproto) {
            return None;
        }
        if let Some(h) = bridged_v8_handle(&c, ctx) {
            return Some(get_v8(h));
        }
        cur = c.prototype().clone();
    }
    None
}

fn boa_object_to_v8_proxy(obj: JsObject) -> (wasm_bindgen::JsValue, u64) {
    let is_array = obj.is_array();
    let handle = pin_boa(obj);
    let target: js_sys::Object = if is_array {
        js_sys::Array::new().unchecked_into()
    } else {
        js_sys::Object::new()
    };
    target_handle_set(&target, handle);
    let proxy: wasm_bindgen::JsValue = js_sys::Proxy::new(&target, &shared_handler()).into();
    our_v8_register(&proxy, handle);
    (proxy, handle)
}

// Reuses the last Boa conversion only while the raw V8 value is SameValue-identical.
fn live_export_resolve(
    ns_handle: f64,
    raw_value_handle: u64,
    name: &JsString,
    cached_value: Option<BoaValue>,
    ctx: &mut Context,
) -> BoaValue {
    let ns = get_v8(ns_handle as u64);
    let key = boa_str_to_v8(name);
    let has_cached_value = cached_value.is_some();
    let (value, unchanged) = with_v8(ctx, || {
        let value = js_sys::Reflect::get(&ns, &key).unwrap_or(wasm_bindgen::JsValue::UNDEFINED);
        let unchanged = has_cached_value && js_sys::Object::is(&value, &get_v8(raw_value_handle));
        (value, unchanged)
    });
    if unchanged {
        if let Some(cached) = cached_value {
            return cached;
        }
    }

    let converted = v8_to_boa(value.clone(), ctx);
    let updated = replace_v8_value(raw_value_handle, value);
    debug_assert!(updated, "live-export raw-value pin must outlive its marker");
    converted
}

pub(crate) fn install_global_bridge(ctx: &mut Context) {
    capture_symbol_builtins(ctx);
    boa_engine::module::set_live_resolve_hook(live_export_resolve);
    let handle = pin(js_sys::global().into());
    let proxy = make_v8_proxy(handle, None, false, ctx);
    ctx.global_object().set_prototype(Some(proxy));
}
