// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Whitelisted Boa DOM reads use branded wrappers and revalidate after V8 may run.
//! Uncertain state falls back to the generic bridge path.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Weak;

use blitz_dom::{ns, NodeData};
use blitz_html::HtmlDocument;
use blitz_traits::NodeId;
use boa_engine::{
    js_string,
    native_function::NativeFunction,
    object::{FunctionObjectBuilder, JsObject, WeakJsObject},
    Context, JsValue as BoaValue,
};

use wasm_bindgen::JsCast;

use crate::js::boa_bridge::{get_v8, with_v8, with_v8_quiet};
use crate::NodeHandleMap;

const OP_GET_ATTRIBUTE: u8 = 0;
const OP_HAS_ATTRIBUTE: u8 = 1;
const OP_TAG_NAME: u8 = 2;
const OP_NODE_NAME: u8 = 3;
const OP_NODE_TYPE: u8 = 4;
const OP_ID: u8 = 5;
const OP_CLASS_NAME: u8 = 6;
const OP_CONTAINS: u8 = 7;
const OP_PARENT_NODE: u8 = 8;
const OP_PARENT_ELEMENT: u8 = 9;
const OP_FIRST_CHILD: u8 = 10;
const OP_LAST_CHILD: u8 = 11;
const OP_NEXT_SIBLING: u8 = 12;
const OP_PREV_SIBLING: u8 = 13;
const OP_NEXT_ELEM_SIBLING: u8 = 14;
const OP_PREV_ELEM_SIBLING: u8 = 15;
// Bit 16 is childNodes: dep-only (no fast op), watched by the shim so
// a patched childNodes getter deopts the sibling/child ops above.
const OP_QUERY_SELECTOR: u8 = 17;
const OP_QUERY_SELECTOR_ALL: u8 = 18;
const OP_MATCHES: u8 = 19;
const OP_CLOSEST: u8 = 20;
const OP_DOC_GET_ELEMENT_BY_ID: u8 = 21;
const OP_DOC_QUERY_SELECTOR: u8 = 22;
const OP_DOC_QUERY_SELECTOR_ALL: u8 = 23;
const OP_DOC_BODY: u8 = 24;
const OP_DOC_HEAD: u8 = 25;
const OP_COUNT: usize = 26;

// The shim's DOCUMENT_ID (DomHandle::document_node_id). The document brands as
// this id and takes only the OP_DOC_* ops; every node op bails on it.
const DOCUMENT_NID: u32 = 0;

fn is_fast_key(key: &str) -> bool {
    op_for_key(key).is_some() || doc_op_for_key(key).is_some()
}

fn doc_op_for_key(key: &str) -> Option<u8> {
    Some(match key {
        "getElementById" => OP_DOC_GET_ELEMENT_BY_ID,
        "querySelector" => OP_DOC_QUERY_SELECTOR,
        "querySelectorAll" => OP_DOC_QUERY_SELECTOR_ALL,
        "body" => OP_DOC_BODY,
        "head" => OP_DOC_HEAD,
        _ => return None,
    })
}

fn method_name(op: u8) -> &'static str {
    match op {
        OP_QUERY_SELECTOR | OP_DOC_QUERY_SELECTOR => "querySelector",
        OP_QUERY_SELECTOR_ALL | OP_DOC_QUERY_SELECTOR_ALL => "querySelectorAll",
        OP_MATCHES => "matches",
        OP_CLOSEST => "closest",
        OP_DOC_GET_ELEMENT_BY_ID => "getElementById",
        _ => "",
    }
}
fn op_for_key(key: &str) -> Option<u8> {
    Some(match key {
        "querySelector" => OP_QUERY_SELECTOR,
        "querySelectorAll" => OP_QUERY_SELECTOR_ALL,
        "matches" => OP_MATCHES,
        "closest" => OP_CLOSEST,
        "getAttribute" => OP_GET_ATTRIBUTE,
        "hasAttribute" => OP_HAS_ATTRIBUTE,
        "tagName" => OP_TAG_NAME,
        "nodeName" => OP_NODE_NAME,
        "nodeType" => OP_NODE_TYPE,
        "id" => OP_ID,
        "className" => OP_CLASS_NAME,
        "contains" => OP_CONTAINS,
        "parentNode" => OP_PARENT_NODE,
        "parentElement" => OP_PARENT_ELEMENT,
        "firstChild" => OP_FIRST_CHILD,
        "lastChild" => OP_LAST_CHILD,
        "nextSibling" => OP_NEXT_SIBLING,
        "previousSibling" => OP_PREV_SIBLING,
        "nextElementSibling" => OP_NEXT_ELEM_SIBLING,
        "previousElementSibling" => OP_PREV_ELEM_SIBLING,
        _ => return None,
    })
}

struct Binding {
    doc: Weak<RefCell<HtmlDocument>>,
    node_handles: Weak<RefCell<NodeHandleMap>>,
    brand: js_sys::Function,
    revalidate: js_sys::Function,
    wrapper: js_sys::Function,
    // The cached wrapper for an id or null, touching nothing page-writable, so
    // it runs quiet; a miss falls back to `wrapper`, which can run page code.
    peek: Option<js_sys::Function>,
    // ids -> a static NodeList of nodeFor(id), built the way querySelectorAll
    // builds one, so the fast path returns the same class and wrappers.
    node_list: Option<js_sys::Function>,
}

thread_local! {
    static BINDING: RefCell<Option<Binding>> = const { RefCell::new(None) };
    static DEOPT_MASK: Cell<u32> = const { Cell::new(0) };
    // Advanced whenever V8 code may have run (entry gates, with_v8 returns). An
    // op is trusted only in the epoch it was last revalidated in; 0 = never.
    static V8_EPOCH: Cell<u64> = const { Cell::new(1) };
    static OP_EPOCH: RefCell<[u64; OP_COUNT]> = const { RefCell::new([0; OP_COUNT]) };
    // Node ids whose shim-side state diverges from blitz truth
    // (createElementNS entries, NS-mangled attrs, detached-doc hosts).
    static SPECIAL: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    static NID_BY_HANDLE: RefCell<HashMap<u64, i32>> = RefCell::new(HashMap::new());
    // Weak because each method holds its receiver, so a strong entry would pin the node.
    static FASTFN_CACHE: RefCell<HashMap<(u32, u8), WeakJsObject>> = RefCell::new(HashMap::new());
    static STAT_HITS: Cell<u64> = const { Cell::new(0) };
    // Per-op hit attribution (indexed by the OP_* bits) — answers
    // "which surfaces does this page's boa code actually touch".
    static STAT_HITS_BY_OP: RefCell<[u64; OP_COUNT]> = const { RefCell::new([0; OP_COUNT]) };
    static STAT_BRANDS: Cell<u64> = const { Cell::new(0) };
    static STAT_REVALIDATIONS: Cell<u64> = const { Cell::new(0) };
    static STAT_FALLBACKS: Cell<u64> = const { Cell::new(0) };
}

pub(crate) fn bind(
    doc: Weak<RefCell<HtmlDocument>>,
    node_handles: Weak<RefCell<NodeHandleMap>>,
    brand: js_sys::Function,
    revalidate: js_sys::Function,
    wrapper: js_sys::Function,
    peek: Option<js_sys::Function>,
    node_list: Option<js_sys::Function>,
) {
    BINDING.with(|b| {
        *b.borrow_mut() = Some(Binding {
            doc,
            node_handles,
            brand,
            revalidate,
            wrapper,
            peek,
            node_list,
        })
    });
    DEOPT_MASK.with(|m| m.set(0));
    arm_v8_ran();
    OP_EPOCH.with(|e| *e.borrow_mut() = [0; OP_COUNT]);
    SPECIAL.with(|s| s.borrow_mut().clear());
    NID_BY_HANDLE.with(|m| m.borrow_mut().clear());
    FASTFN_CACHE.with(|m| m.borrow_mut().clear());
}

pub(crate) fn mark_special(id: u32) {
    SPECIAL.with(|s| {
        s.borrow_mut().insert(id);
    });
    FASTFN_CACHE.with(|m| m.borrow_mut().retain(|(nid, _), _| *nid != id));
}

pub(crate) fn arm_v8_ran() {
    V8_EPOCH.with(|e| e.set(e.get() + 1));
}

// Revalidate `op` (its own watched props and their dependencies) once per epoch.
// Re-walking every watched prop was a quarter of a `document.body` loop.
fn ensure_valid(op: u8, ctx: &mut Context) {
    let epoch = V8_EPOCH.with(Cell::get);
    if OP_EPOCH.with(|e| e.borrow()[op as usize]) == epoch {
        return;
    }
    revalidate(op, ctx);
    OP_EPOCH.with(|e| e.borrow_mut()[op as usize] = epoch);
}

pub(crate) fn evict_handle(handle: u64) {
    let nid = NID_BY_HANDLE.with(|m| m.borrow_mut().remove(&handle));
    if let Some(nid) = nid.filter(|n| *n >= 0) {
        let nid = nid as u32;
        FASTFN_CACHE.with(|m| {
            let mut m = m.borrow_mut();
            for op in [
                OP_GET_ATTRIBUTE,
                OP_HAS_ATTRIBUTE,
                OP_CONTAINS,
                OP_QUERY_SELECTOR,
                OP_QUERY_SELECTOR_ALL,
                OP_MATCHES,
                OP_CLOSEST,
                OP_DOC_GET_ELEMENT_BY_ID,
                OP_DOC_QUERY_SELECTOR,
                OP_DOC_QUERY_SELECTOR_ALL,
            ] {
                if m.get(&(nid, op)).is_some_and(|f| f.upgrade().is_none()) {
                    m.remove(&(nid, op));
                }
            }
        });
    }
}

pub(crate) fn stats_json() -> String {
    let by_op = STAT_HITS_BY_OP.with(|a| {
        a.borrow()
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    });
    format!(
        "{{\"fastHits\":{},\"brandChecks\":{},\"revalidations\":{},\"fallbacks\":{},\"deoptMask\":{},\"hitsByOp\":[{}]}}",
        STAT_HITS.with(Cell::get),
        STAT_BRANDS.with(Cell::get),
        STAT_REVALIDATIONS.with(Cell::get),
        STAT_FALLBACKS.with(Cell::get),
        DEOPT_MASK.with(Cell::get),
        by_op,
    )
}

fn count_hit(op: u8) {
    STAT_HITS.with(|c| c.set(c.get() + 1));
    STAT_HITS_BY_OP.with(|a| {
        let mut a = a.borrow_mut();
        if let Some(slot) = a.get_mut(op as usize) {
            *slot += 1;
        }
    });
}

fn brand_check(handle: u64, ctx: &mut Context) -> i32 {
    let verdict = BINDING.with(|b| {
        let b = b.borrow();
        let Some(binding) = b.as_ref() else { return -1 };
        let v8obj = get_v8(handle);
        STAT_BRANDS.with(|c| c.set(c.get() + 1));
        let brand = binding.brand.clone();
        drop(b);
        with_v8(ctx, || {
            brand
                .call1(&wasm_bindgen::JsValue::NULL, &v8obj)
                .ok()
                .and_then(|v| v.as_f64())
                .map(|f| f as i32)
                .unwrap_or(-1)
        })
    });
    NID_BY_HANDLE.with(|m| {
        m.borrow_mut().insert(handle, verdict);
    });
    verdict
}

fn revalidate(op: u8, ctx: &mut Context) {
    STAT_REVALIDATIONS.with(|c| c.set(c.get() + 1));
    let mask = BINDING.with(|b| {
        let b = b.borrow();
        let Some(binding) = b.as_ref() else {
            return u32::MAX;
        };
        let reval = binding.revalidate.clone();
        drop(b);
        with_v8_quiet(ctx, || {
            reval
                .call1(
                    &wasm_bindgen::JsValue::NULL,
                    &wasm_bindgen::JsValue::from(op),
                )
                .ok()
                .and_then(|v| v.as_f64())
                .map(|f| f as u32)
                .unwrap_or(u32::MAX)
        })
    });
    DEOPT_MASK.with(|m| m.set(m.get() | mask));
}

fn deopted(op: u8) -> bool {
    DEOPT_MASK.with(|m| m.get()) & (1u32 << op) != 0
}

fn is_special(nid: u32) -> bool {
    SPECIAL.with(|s| s.borrow().contains(&nid))
}

// Parsed nodes can reach this path before the shim reads their attribute
// namespace sidecar. Match the qualified name that Element.getAttribute exposes
// (prefix:local when prefixed), preserving the parser's attribute order. Like
// Element.getAttribute, only an HTML element lowercases the name.
fn attr_lookup(doc: &HtmlDocument, nid: NodeId, name: &str) -> Option<Option<String>> {
    let node = doc.get_node(nid)?;
    let NodeData::Element(data) = &node.data else {
        return None;
    };
    let lookup = if data.name.ns == ns!(html) {
        name.to_ascii_lowercase()
    } else {
        name.to_owned()
    };
    for a in data.attrs.iter() {
        let matches = match &a.name.prefix {
            Some(prefix) => lookup
                .strip_prefix(&**prefix)
                .and_then(|remaining| remaining.strip_prefix(':'))
                .is_some_and(|local| local == &*a.name.local),
            None => *a.name.local == lookup,
        };
        if matches {
            return Some(Some(a.value.clone()));
        }
    }
    Some(None)
}

fn node_name(doc: &HtmlDocument, nid: NodeId) -> Option<String> {
    let node = doc.get_node(nid)?;
    let NodeData::Element(data) = &node.data else {
        return None;
    };
    let local = data.name.local.to_string();
    let qname = match &data.name.prefix {
        Some(p) => format!("{}:{}", p, local),
        None => local,
    };
    Some(if data.name.ns == ns!(html) {
        qname.to_ascii_uppercase()
    } else {
        qname
    })
}

fn parent_of(doc: &HtmlDocument, nid: NodeId) -> Option<Option<NodeId>> {
    Some(doc.get_node(nid)?.parent)
}

fn is_element(doc: &HtmlDocument, nid: NodeId) -> bool {
    matches!(
        doc.get_node(nid).map(|n| &n.data),
        Some(NodeData::Element(_))
    )
}

fn node_type(doc: &HtmlDocument, nid: NodeId) -> Option<u8> {
    Some(match &doc.get_node(nid)?.data {
        NodeData::Document(_) => 9,
        NodeData::ShadowRoot(_) => 11,
        NodeData::Comment { .. } => 8,
        NodeData::Text(_) => 3,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) => 1,
    })
}

fn mint_node(nid: u32, ctx: &mut Context) -> Option<BoaValue> {
    let peek = BINDING.with(|b| b.borrow().as_ref().and_then(|binding| binding.peek.clone()));
    if let Some(peek) = peek {
        // Quiet: a cached wrapper is a pure lookup, so it must not re-arm the
        // boundary revalidation that a minting nodeFor (which can run page code) needs.
        let hit = with_v8_quiet(ctx, || {
            peek.call1(
                &wasm_bindgen::JsValue::NULL,
                &wasm_bindgen::JsValue::from_f64(nid as f64),
            )
            .ok()
        });
        if let Some(v8) = hit.filter(|v| v.is_object()) {
            return Some(crate::js::boa_bridge::v8_node_to_boa(v8, ctx));
        }
    }
    let v8 = BINDING.with(|b| {
        let b = b.borrow();
        let binding = b.as_ref()?;
        let wrapper = binding.wrapper.clone();
        drop(b);
        with_v8(ctx, || {
            wrapper
                .call1(
                    &wasm_bindgen::JsValue::NULL,
                    &wasm_bindgen::JsValue::from_f64(nid as f64),
                )
                .ok()
        })
    })?;
    if v8.is_null() || v8.is_undefined() {
        return None;
    }
    Some(crate::js::boa_bridge::v8_node_to_boa(v8, ctx))
}

fn handle_of_boa_value(v: &BoaValue, ctx: &mut Context) -> Option<u64> {
    let obj = v.as_object()?;
    crate::js::boa_bridge::bridged_v8_handle(&obj, ctx)
}

fn with_doc<R>(f: impl FnOnce(&HtmlDocument) -> Option<R>) -> Option<R> {
    BINDING.with(|b| {
        let b = b.borrow();
        let doc = b.as_ref()?.doc.upgrade()?;
        drop(b);
        let doc = doc.try_borrow().ok()?;
        f(&doc)
    })
}

fn resolve_node_id(external: u32) -> Option<NodeId> {
    BINDING.with(|b| {
        let binding = b.borrow();
        let handles = binding.as_ref()?.node_handles.upgrade()?;
        drop(binding);
        let resolved = handles.try_borrow().ok()?.resolve(external);
        resolved
    })
}

fn external_node_id(internal: NodeId) -> Option<u32> {
    BINDING.with(|b| {
        let binding = b.borrow();
        let handles = binding.as_ref()?.node_handles.upgrade()?;
        drop(binding);
        let external = handles.try_borrow_mut().ok()?.external_for(internal);
        Some(external)
    })
}

fn with_node<R>(external: u32, f: impl FnOnce(&HtmlDocument, NodeId) -> Option<R>) -> Option<R> {
    let internal = resolve_node_id(external)?;
    with_doc(|doc| f(doc, internal))
}

fn slow_method_call(
    this: &BoaValue,
    nid: u32,
    handle: u64,
    method: &str,
    args: &[BoaValue],
    ctx: &mut Context,
) -> boa_engine::JsResult<BoaValue> {
    let holder = live_holder(this, nid, handle, ctx);
    slow_method_call_on(holder.clone(), holder, method, args, ctx)
}

// The cached closure outlives the proxy whose pin it captured: once a GC releases that
// pin, get_v8 reads undefined (or a reused slot), so fallbacks find the node afresh.
fn live_holder(this: &BoaValue, nid: u32, handle: u64, ctx: &mut Context) -> wasm_bindgen::JsValue {
    let names_node =
        |h: u64| NID_BY_HANDLE.with(|m| m.borrow().get(&h).copied()) == Some(nid as i32);
    if let Some(h) = handle_of_boa_value(this, ctx).filter(|&h| names_node(h)) {
        return get_v8(h);
    }
    if names_node(handle) {
        return get_v8(handle);
    }
    let found = BINDING.with(|b| {
        let b = b.borrow();
        let binding = b.as_ref()?;
        Some((binding.peek.clone(), binding.wrapper.clone()))
    });
    let id = wasm_bindgen::JsValue::from_f64(nid as f64);
    if let Some((peek, wrapper)) = found {
        let peeked = peek.and_then(|peek| {
            with_v8_quiet(ctx, || peek.call1(&wasm_bindgen::JsValue::NULL, &id).ok())
        });
        if let Some(v8) = peeked.filter(|v| v.is_object()) {
            return v8;
        }
        let minted = with_v8(ctx, || {
            wrapper.call1(&wasm_bindgen::JsValue::NULL, &id).ok()
        });
        if let Some(v8) = minted.filter(|v| v.is_object()) {
            return v8;
        }
    }
    get_v8(handle)
}

// A fast method answers only for the node it was read from: any other receiver
// (`Document.prototype.querySelector.call(parsedDoc, ...)`) gets the real method.
fn foreign_receiver(this: &BoaValue, nid: u32, handle: u64, ctx: &mut Context) -> bool {
    let Some(h) = handle_of_boa_value(this, ctx) else {
        return true;
    };
    h != handle && NID_BY_HANDLE.with(|m| m.borrow().get(&h).copied()) != Some(nid as i32)
}

// The method as read from `handle` (the shim's own), applied to the caller's `this`.
fn foreign_method_call(
    this: &BoaValue,
    nid: u32,
    handle: u64,
    method: &str,
    args: &[BoaValue],
    ctx: &mut Context,
) -> boa_engine::JsResult<BoaValue> {
    STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
    let holder = live_holder(&BoaValue::undefined(), nid, handle, ctx);
    let recv = crate::js::boa_bridge::boa_to_v8(this, ctx);
    slow_method_call_on(holder, recv, method, args, ctx)
}

fn slow_method_call_on(
    holder: wasm_bindgen::JsValue,
    recv: wasm_bindgen::JsValue,
    method: &str,
    args: &[BoaValue],
    ctx: &mut Context,
) -> boa_engine::JsResult<BoaValue> {
    let marshalled: Vec<wasm_bindgen::JsValue> = args
        .iter()
        .map(|a| crate::js::boa_bridge::boa_to_v8(a, ctx))
        .collect();
    let out = with_v8(ctx, || {
        let m = js_sys::Reflect::get(&holder, &wasm_bindgen::JsValue::from_str(method)).ok()?;
        let f: &js_sys::Function = m.dyn_ref::<js_sys::Function>()?;
        let arr = js_sys::Array::new();
        for a in &marshalled {
            arr.push(a);
        }
        Some(js_sys::Reflect::apply(f, &recv, &arr))
    });
    // A throw rethrows like trap_apply's does: querySelector("[") must still
    // surface the shim's SyntaxError DOMException, not read as undefined.
    match out {
        Some(Ok(v)) => Ok(crate::js::boa_bridge::v8_to_boa(v, ctx)),
        Some(Err(e)) => Err(boa_engine::JsError::from_opaque(
            crate::js::boa_bridge::v8_to_boa(e, ctx),
        )),
        None => Ok(BoaValue::undefined()),
    }
}

fn make_attr_method(
    nid: u32,
    handle: u64,
    op: u8,
    receiver: &JsObject,
    ctx: &mut Context,
) -> JsObject {
    let nf = NativeFunction::from_copy_closure_with_captures(
        move |this, args, _receiver: &JsObject, ctx: &mut Context| {
            let method = if op == OP_GET_ATTRIBUTE {
                "getAttribute"
            } else {
                "hasAttribute"
            };
            if foreign_receiver(this, nid, handle, ctx) {
                return foreign_method_call(this, nid, handle, method, args, ctx);
            }
            let name_arg = args.first().cloned().unwrap_or_default();
            let fast_name = match name_arg.as_string() {
                Some(s) if !deopted(op) && !is_special(nid) => Some(s.to_std_string_escaped()),
                _ => None,
            };
            let Some(name) = fast_name else {
                STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
                return slow_method_call(this, nid, handle, method, args, ctx);
            };
            match with_node(nid, |doc, internal| attr_lookup(doc, internal, &name)) {
                Some(found) => {
                    count_hit(op);
                    Ok(if op == OP_GET_ATTRIBUTE {
                        match found {
                            Some(v) => BoaValue::from(js_string!(v)),
                            None => BoaValue::null(),
                        }
                    } else {
                        BoaValue::from(found.is_some())
                    })
                }
                None => {
                    STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
                    slow_method_call(this, nid, handle, method, args, ctx)
                }
            }
        },
        receiver.clone(),
    );
    let name = if op == OP_GET_ATTRIBUTE {
        "getAttribute"
    } else {
        "hasAttribute"
    };
    FunctionObjectBuilder::new(ctx.realm(), nf)
        .name(js_string!(name))
        .length(1)
        .build()
        .into()
}

fn make_contains_method(nid: u32, handle: u64, receiver: &JsObject, ctx: &mut Context) -> JsObject {
    let nf = NativeFunction::from_copy_closure_with_captures(
        move |this, args, _receiver: &JsObject, ctx: &mut Context| {
            if foreign_receiver(this, nid, handle, ctx) {
                return foreign_method_call(this, nid, handle, "contains", args, ctx);
            }
            let arg = args.first().cloned().unwrap_or_default();
            if !deopted(OP_CONTAINS) {
                if arg.is_null() || arg.is_undefined() {
                    count_hit(OP_CONTAINS);
                    return Ok(BoaValue::from(false));
                }
                if let Some(other_handle) = handle_of_boa_value(&arg, ctx) {
                    let other_nid =
                        match NID_BY_HANDLE.with(|m| m.borrow().get(&other_handle).copied()) {
                            Some(v) => v,
                            None => brand_check(other_handle, ctx),
                        };
                    if other_nid >= 0 {
                        let Some(target) = resolve_node_id(nid) else {
                            STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
                            return slow_method_call(this, nid, handle, "contains", args, ctx);
                        };
                        let verdict = with_node(other_nid as u32, |doc, mut cur| {
                            for _ in 0..4096 {
                                if cur == target {
                                    return Some(true);
                                }
                                let Some(p) = parent_of(doc, cur)? else {
                                    return Some(false);
                                };
                                if p == cur {
                                    return Some(false);
                                }
                                cur = p;
                            }
                            None
                        });
                        if let Some(v) = verdict {
                            count_hit(OP_CONTAINS);
                            return Ok(BoaValue::from(v));
                        }
                    }
                }
            }
            STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
            slow_method_call(this, nid, handle, "contains", args, ctx)
        },
        receiver.clone(),
    );
    FunctionObjectBuilder::new(ctx.realm(), nf)
        .name(js_string!("contains"))
        .length(1)
        .build()
        .into()
}

// Selectors the shim answers itself: pseudo-elements match nothing there (an
// invalid one throws), and WebMCP's :tool-* pseudo-classes are JS-side state.
fn selector_is_plain(sel: &str) -> bool {
    let lower = sel.to_ascii_lowercase();
    ![
        "::",
        ":before",
        ":after",
        ":first-line",
        ":first-letter",
        ":tool-",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

enum Query {
    First,
    All,
    Matches,
    Closest,
}

enum QueryOut<T> {
    Node(Option<T>),
    Nodes(Vec<T>),
    Bool(bool),
}

// The same stylo entry points DomHandle's querySelector*/matches/closest use.
// None (bad selector, dropped node, matcher panic) leaves the answer to the shim.
fn run_query(root: u32, sel: &str, q: Query) -> Option<QueryOut<u32>> {
    use ::style::context::QuirksMode;
    use ::style::dom_apis::{
        element_closest, element_matches, query_selector, MayUseInvalidation, QueryAll, QueryFirst,
    };
    use blitz_dom::Node;
    BINDING.with(|b| {
        let b = b.borrow();
        let doc = b.as_ref()?.doc.upgrade()?;
        drop(b);
        doc.try_borrow_mut().ok()?.flush_slot_assignments();
        Some(())
    })?;
    let internal = resolve_node_id(root)?;
    let raw = with_doc(|doc| {
        let node = doc.get_node(internal)?;
        let is_root = internal == doc.root_node().id;
        let blitz_parses = is_root && matches!(q, Query::First | Query::All);
        let parsed = (!blitz_parses).then(|| doc.try_parse_selector_list(sel));
        let list = match parsed {
            Some(Ok(list)) => Some(list),
            Some(Err(_)) => return None,
            None => None,
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match q {
            // Document-rooted queries go through blitz's own entry points, as the
            // shim's document methods do (dom.querySelector / querySelectorAll).
            Query::First if is_root => doc.query_selector(sel).ok().map(QueryOut::Node),
            Query::All if is_root => doc
                .query_selector_all(sel)
                .ok()
                .map(|ids| QueryOut::Nodes(ids.into_iter().collect())),
            Query::First => {
                let mut out: Option<&Node> = None;
                query_selector::<&Node, QueryFirst>(
                    node,
                    list.as_ref()?,
                    &mut out,
                    MayUseInvalidation::Yes,
                );
                Some(QueryOut::Node(out.map(|n| n.id)))
            }
            Query::All => {
                let mut out: smallvec::SmallVec<[&Node; 128]> = smallvec::SmallVec::new();
                query_selector::<&Node, QueryAll>(
                    node,
                    list.as_ref()?,
                    &mut out,
                    MayUseInvalidation::Yes,
                );
                Some(QueryOut::Nodes(out.into_iter().map(|n| n.id).collect()))
            }
            Query::Matches => Some(QueryOut::Bool(element_matches::<&Node>(
                &node,
                list.as_ref()?,
                QuirksMode::NoQuirks,
            ))),
            Query::Closest => Some(QueryOut::Node(
                element_closest::<&Node>(node, list.as_ref()?, QuirksMode::NoQuirks).map(|n| n.id),
            )),
        }))
        .ok()
        .flatten()
    })?;
    Some(match raw {
        QueryOut::Bool(b) => QueryOut::Bool(b),
        QueryOut::Node(None) => QueryOut::Node(None),
        QueryOut::Node(Some(id)) => QueryOut::Node(Some(external_node_id(id)?)),
        QueryOut::Nodes(ids) => QueryOut::Nodes(
            ids.into_iter()
                .map(external_node_id)
                .collect::<Option<Vec<_>>>()?,
        ),
    })
}

// A static NodeList through the shim, so it is the same NodeList class and
// wrapper identity querySelectorAll's slow path returns.
fn mint_node_list(ids: &[u32], ctx: &mut Context) -> Option<BoaValue> {
    let hook = BINDING.with(|b| {
        b.borrow()
            .as_ref()
            .and_then(|binding| binding.node_list.clone())
    })?;
    let arr = js_sys::Array::new();
    for &id in ids {
        arr.push(&wasm_bindgen::JsValue::from_f64(id as f64));
    }
    let v8 = with_v8(ctx, || hook.call1(&wasm_bindgen::JsValue::NULL, &arr).ok())?;
    v8.is_object()
        .then(|| crate::js::boa_bridge::v8_node_to_boa(v8, ctx))
}

fn node_or_null(id: Option<u32>, ctx: &mut Context) -> Option<BoaValue> {
    match id {
        None => Some(BoaValue::null()),
        Some(id) => mint_node(id, ctx),
    }
}

// querySelector(All) / matches / closest / getElementById as boa methods closed
// over the receiver, deciding at CALL time like the attribute methods above.
fn make_query_method(
    nid: u32,
    handle: u64,
    op: u8,
    receiver: &JsObject,
    ctx: &mut Context,
) -> JsObject {
    let nf = NativeFunction::from_copy_closure_with_captures(
        move |this, args, _receiver: &JsObject, ctx: &mut Context| {
            let method = method_name(op);
            if foreign_receiver(this, nid, handle, ctx) {
                return foreign_method_call(this, nid, handle, method, args, ctx);
            }
            let live = !deopted(op) && (nid == DOCUMENT_NID || !is_special(nid));
            // Only a string argument: anything else needs ToString, which can run
            // page code, and the shim's coercion and error messages own that path.
            let arg = match args.first().and_then(|a| a.as_string()) {
                Some(s) if live => s.to_std_string().ok(),
                _ => None,
            };
            let out = arg.and_then(|arg| match op {
                OP_DOC_GET_ELEMENT_BY_ID => {
                    if arg.is_empty() {
                        return Some(BoaValue::null());
                    }
                    let hit = with_doc(|doc| {
                        let node = doc.get_node(doc.get_element_by_id(&arg)?)?;
                        Some(
                            (node.attr(blitz_dom::local_name!("id")) == Some(arg.as_str()))
                                .then_some(node.id),
                        )
                    })
                    .flatten();
                    node_or_null(
                        match hit {
                            Some(id) => Some(external_node_id(id)?),
                            None => None,
                        },
                        ctx,
                    )
                }
                _ if !selector_is_plain(&arg) => None,
                OP_QUERY_SELECTOR | OP_DOC_QUERY_SELECTOR => {
                    match run_query(nid, &arg, Query::First)? {
                        QueryOut::Node(id) => node_or_null(id, ctx),
                        _ => None,
                    }
                }
                OP_CLOSEST => match run_query(nid, &arg, Query::Closest)? {
                    QueryOut::Node(id) => node_or_null(id, ctx),
                    _ => None,
                },
                OP_MATCHES => match run_query(nid, &arg, Query::Matches)? {
                    QueryOut::Bool(b) => Some(BoaValue::from(b)),
                    _ => None,
                },
                OP_QUERY_SELECTOR_ALL | OP_DOC_QUERY_SELECTOR_ALL => {
                    match run_query(nid, &arg, Query::All)? {
                        QueryOut::Nodes(ids) => mint_node_list(&ids, ctx),
                        _ => None,
                    }
                }
                _ => None,
            });
            match out {
                Some(v) => {
                    count_hit(op);
                    Ok(v)
                }
                None => {
                    STAT_FALLBACKS.with(|c| c.set(c.get() + 1));
                    slow_method_call(this, nid, handle, method, args, ctx)
                }
            }
        },
        receiver.clone(),
    );
    FunctionObjectBuilder::new(ctx.realm(), nf)
        .name(js_string!(method_name(op)))
        .length(1)
        .build()
        .into()
}

// Answers a trap_get from blitz or the method cache, or returns None for the slow path.
// `receiver` is the node proxy's target. Minted methods capture it, so a method boa keeps
// also keeps the node's V8 pin, and with it the node.
pub(crate) fn try_fast_get(
    handle: u64,
    key: &str,
    receiver: &JsObject,
    ctx: &mut Context,
) -> Option<BoaValue> {
    if !is_fast_key(key) {
        return None;
    }
    let nid = match NID_BY_HANDLE.with(|m| m.borrow().get(&handle).copied()) {
        Some(v) => v,
        None => brand_check(handle, ctx),
    };
    if nid < 0 {
        return None;
    }
    let nid = nid as u32;
    // The document is special for every node op (its child list is shim-made),
    // so it only ever takes the document ops.
    let op = if nid == DOCUMENT_NID {
        doc_op_for_key(key)?
    } else {
        op_for_key(key)?
    };
    ensure_valid(op, ctx);
    if deopted(op) || (nid != DOCUMENT_NID && is_special(nid)) {
        return None;
    }
    let out = match op {
        OP_GET_ATTRIBUTE
        | OP_HAS_ATTRIBUTE
        | OP_CONTAINS
        | OP_QUERY_SELECTOR
        | OP_QUERY_SELECTOR_ALL
        | OP_MATCHES
        | OP_CLOSEST
        | OP_DOC_GET_ELEMENT_BY_ID
        | OP_DOC_QUERY_SELECTOR
        | OP_DOC_QUERY_SELECTOR_ALL => {
            let cached =
                FASTFN_CACHE.with(|m| m.borrow().get(&(nid, op)).and_then(WeakJsObject::upgrade));
            let f = match cached {
                Some(f) => f,
                None => {
                    let f = match op {
                        OP_CONTAINS => make_contains_method(nid, handle, receiver, ctx),
                        OP_GET_ATTRIBUTE | OP_HAS_ATTRIBUTE => {
                            make_attr_method(nid, handle, op, receiver, ctx)
                        }
                        _ => make_query_method(nid, handle, op, receiver, ctx),
                    };
                    FASTFN_CACHE.with(|m| {
                        m.borrow_mut().insert((nid, op), f.downgrade());
                    });
                    f
                }
            };
            Some(BoaValue::from(f))
        }
        OP_PARENT_NODE | OP_PARENT_ELEMENT => {
            let pid = with_node(nid, parent_of)?;
            if pid.is_none() {
                Some(BoaValue::null())
            } else {
                let pid = pid?;
                let external_pid = external_node_id(pid)?;
                if is_special(external_pid) {
                    None
                } else if op == OP_PARENT_ELEMENT
                    && !with_doc(|doc| Some(is_element(doc, pid))).unwrap_or(false)
                {
                    Some(BoaValue::null())
                } else {
                    mint_node(external_pid, ctx)
                }
            }
        }
        OP_FIRST_CHILD | OP_LAST_CHILD => {
            let pick = with_node(nid, |doc, internal| {
                let node = doc.get_node(internal)?;
                Some(if op == OP_FIRST_CHILD {
                    node.children.first().copied()
                } else {
                    node.children.last().copied()
                })
            })?;
            match pick {
                None => Some(BoaValue::null()),
                Some(cid) => mint_node(external_node_id(cid)?, ctx),
            }
        }
        OP_NEXT_SIBLING | OP_PREV_SIBLING | OP_NEXT_ELEM_SIBLING | OP_PREV_ELEM_SIBLING => {
            let internal = resolve_node_id(nid)?;
            match with_doc(|doc| parent_of(doc, internal))? {
                None => Some(BoaValue::null()),
                Some(pid) => {
                    let external_pid = external_node_id(pid)?;
                    if is_special(external_pid) {
                        None
                    } else {
                        let found = with_doc(|doc| {
                            let parent = doc.get_node(pid)?;
                            let kids = &parent.children;
                            let i = kids.iter().position(|&c| c == internal)?;
                            let fwd = op == OP_NEXT_SIBLING || op == OP_NEXT_ELEM_SIBLING;
                            let elems_only =
                                op == OP_NEXT_ELEM_SIBLING || op == OP_PREV_ELEM_SIBLING;
                            let step = |cid: NodeId| -> Option<NodeId> {
                                if !elems_only || is_element(doc, cid) {
                                    Some(cid)
                                } else {
                                    None
                                }
                            };
                            if fwd {
                                for &cid in &kids[i + 1..] {
                                    if let Some(hit) = step(cid) {
                                        return Some(Some(hit));
                                    }
                                }
                            } else {
                                for &cid in kids[..i].iter().rev() {
                                    if let Some(hit) = step(cid) {
                                        return Some(Some(hit));
                                    }
                                }
                            }
                            Some(None)
                        })?;
                        match found {
                            None => Some(BoaValue::null()),
                            Some(cid) => mint_node(external_node_id(cid)?, ctx),
                        }
                    }
                }
            }
        }
        OP_DOC_BODY | OP_DOC_HEAD => {
            // The shim's body/head getters are dom.querySelector("body"/"head"),
            // i.e. the first such element in the document, which this mirrors.
            let tag = if op == OP_DOC_BODY { "body" } else { "head" };
            match run_query(DOCUMENT_NID, tag, Query::First)? {
                QueryOut::Node(id) => node_or_null(id, ctx),
                _ => None,
            }
        }
        OP_NODE_TYPE => with_node(nid, |doc, internal| {
            node_type(doc, internal).map(BoaValue::from)
        }),
        OP_TAG_NAME | OP_NODE_NAME => with_node(nid, |doc, internal| {
            node_name(doc, internal).map(|s| BoaValue::from(js_string!(s)))
        }),
        OP_ID | OP_CLASS_NAME => {
            let attr = if op == OP_ID { "id" } else { "class" };
            with_node(nid, |doc, internal| {
                attr_lookup(doc, internal, attr)
                    .map(|found| BoaValue::from(js_string!(found.unwrap_or_default())))
            })
        }
        _ => None,
    };
    if out.is_some() {
        count_hit(op);
    }
    out
}
