// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Evaluates page `Runtime.evaluate` expressions with Boa instead of V8 code generation.

// boa's async is driven on V8's microtask queue via wasm-bindgen-futures
// (JsFuture == promise.then waker); see WasmJobQueue, boa's JobExecutor, below.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::{poll_fn, Future};
use std::panic;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Poll, Waker};

use boa_engine::{
    builtins::promise::PromiseState,
    context::ContextBuilder,
    job::{GenericJob, Job, JobExecutor, NativeAsyncJob, PromiseJob},
    js_string,
    module::{ModuleLoader, ModuleRequest, Referrer, SyntheticModuleInitializer},
    object::{builtins::JsPromise, FunctionObjectBuilder, JsObject},
    property::Attribute,
    Context, JsArgs, JsNativeError, JsResult, JsString, JsValue as BoaValue, Module,
    NativeFunction, Source,
};
use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use js_sys::{Date, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::js::boa_bridge::{context_ptr, with_context};
use crate::js::dom_fastpath::arm_v8_ran;
use crate::js::internals::get;

#[derive(Default)]
struct KsModuleLoader {
    cache: Rc<RefCell<HashMap<String, Module>>>,
}

fn page_base_url() -> Option<String> {
    let global = js_sys::global();
    let loc = Reflect::get(&global, &JsValue::from_str("location")).ok()?;
    Reflect::get(&loc, &JsValue::from_str("href"))
        .ok()?
        .as_string()
}

#[cfg(target_arch = "wasm32")]
fn resolve_with_import_map(specifier: &str, base: &str) -> Result<Option<String>, String> {
    let global = js_sys::global();
    let Ok(hook) = Reflect::get(&global, &JsValue::from_str("__ks_resolve_import_map")) else {
        return Ok(None);
    };
    let Ok(hook) = hook.dyn_into::<js_sys::Function>() else {
        return Ok(None);
    };
    let resolved = hook
        .call2(
            &global,
            &JsValue::from_str(specifier),
            &JsValue::from_str(base),
        )
        .map_err(|e| format!("import map refused {specifier}: {e:?}"))?;
    resolved
        .as_string()
        .map(Some)
        .ok_or_else(|| format!("import map resolved {specifier} to a non-string value"))
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_with_import_map(_specifier: &str, _base: &str) -> Result<Option<String>, String> {
    Ok(None)
}

fn resolve_specifier(specifier: &str, referrer: &Referrer) -> Result<String, String> {
    let base = referrer
        .path()
        .and_then(|p| p.to_str())
        .map(String::from)
        .or_else(page_base_url)
        .unwrap_or_else(|| "https://kitesurf.local/".to_string());
    if let Some(mapped) = resolve_with_import_map(specifier, &base)? {
        return Ok(mapped);
    }
    if specifier.starts_with("http://") || specifier.starts_with("https://") {
        return Ok(specifier.to_string());
    }
    match url::Url::parse(&base).and_then(|b| b.join(specifier)) {
        Ok(u) => Ok(u.to_string()),
        Err(_) => Ok(specifier.to_string()),
    }
}

// The referrer's URL lets the gate give an import its referrer's nonce (HTML's descendant
// script fetch options); an entry import's referrer is the page.
async fn gated_module_source(url: &str, referrer: Option<&str>) -> Option<Result<String, String>> {
    let hook: js_sys::Function = get("fetchModuleSource")?.dyn_into().ok()?;
    let referrer = referrer.map_or(JsValue::UNDEFINED, JsValue::from_str);
    let promise = hook
        .call2(&JsValue::UNDEFINED, &JsValue::from_str(url), &referrer)
        .map_err(|_| format!("fetchModuleSource({url}) threw"));
    let promise = match promise {
        Ok(p) => p,
        Err(e) => return Some(Err(e)),
    };
    match wasm_bindgen_futures::JsFuture::from(Promise::from(promise)).await {
        Ok(v) => Some(
            v.as_string()
                .ok_or_else(|| "module body not a string".to_string()),
        ),
        Err(e) => Some(Err(format!("module refused for {url}: {e:?}"))),
    }
}

async fn fetch_module_source(url: String, referrer: Option<String>) -> Result<String, String> {
    if let Some(gated) = gated_module_source(&url, referrer.as_deref()).await {
        return gated;
    }
    let global = js_sys::global();
    let fetch_fn: js_sys::Function = Reflect::get(&global, &JsValue::from_str("fetch"))
        .map_err(|_| "no global fetch".to_string())?
        .dyn_into()
        .map_err(|_| "fetch is not a function".to_string())?;
    let resp = wasm_bindgen_futures::JsFuture::from(Promise::from(
        fetch_fn
            .call1(&global, &JsValue::from_str(&url))
            .map_err(|_| format!("fetch({url}) threw"))?,
    ))
    .await
    .map_err(|e| format!("fetch({url}) rejected: {e:?}"))?;
    let status = Reflect::get(&resp, &JsValue::from_str("status"))
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as u32;
    if status != 0 && !(200..300).contains(&status) {
        return Err(format!("fetch({url}) HTTP {status}"));
    }
    let text_fn: js_sys::Function = Reflect::get(&resp, &JsValue::from_str("text"))
        .map_err(|_| "response has no text()".to_string())?
        .dyn_into()
        .map_err(|_| "text is not a function".to_string())?;
    let text = wasm_bindgen_futures::JsFuture::from(Promise::from(
        text_fn
            .call0(&resp)
            .map_err(|_| "text() threw".to_string())?,
    ))
    .await
    .map_err(|_| "text() rejected".to_string())?;
    text.as_string()
        .ok_or_else(|| "module body not a string".to_string())
}

async fn native_import_namespace(url: String) -> Option<wasm_bindgen::JsValue> {
    let f: js_sys::Function = get("nativeImport")?.dyn_into().ok()?;
    let promise = f
        .call1(&JsValue::UNDEFINED, &JsValue::from_str(&url))
        .ok()?;
    let ns = wasm_bindgen_futures::JsFuture::from(Promise::from(promise))
        .await
        .ok()?;
    if ns.is_undefined() || ns.is_null() {
        return None;
    }
    Some(ns)
}

fn v8_namespace_to_synthetic(url: &str, ns: &wasm_bindgen::JsValue, ctx: &mut Context) -> Module {
    let mut names: Vec<JsString> = Vec::new();
    let mut pairs: Vec<(JsString, BoaValue)> = Vec::new();
    let obj: &js_sys::Object = ns.unchecked_ref();
    let ns_handle = crate::js::boa_bridge::pin_v8_value(ns.clone());
    let keys = js_sys::Object::get_own_property_names(obj);
    for k in keys.iter() {
        if let Some(name) = k.as_string() {
            let js_name = JsString::from(name.as_str());
            let raw_value_handle =
                crate::js::boa_bridge::pin_v8_value(wasm_bindgen::JsValue::UNDEFINED);
            let boa_val = boa_engine::module::make_live_binding(
                ns_handle as f64,
                js_name.clone(),
                raw_value_handle,
            );
            names.push(js_name.clone());
            pairs.push((js_name, boa_val));
        }
    }
    // SAFETY: captures are (JsString, boa JsValue) pairs, both Trace; the
    // closure captures nothing else, so GC tracing of the captures is sound.
    let init = unsafe {
        SyntheticModuleInitializer::from_closure_with_captures(
            move |m, pairs, _ctx| {
                for (name, val) in pairs.iter() {
                    m.set_export(name, val.clone())?;
                }
                Ok(())
            },
            pairs,
        )
    };
    Module::synthetic(&names, init, Some(std::path::PathBuf::from(url)), None, ctx)
}

enum LoadedModule {
    Native(wasm_bindgen::JsValue),
    Source(String),
    Err(String),
}

impl ModuleLoader for KsModuleLoader {
    async fn load_imported_module(
        self: Rc<Self>,
        referrer: Referrer,
        request: ModuleRequest,
        context: &RefCell<&mut Context>,
    ) -> JsResult<Module> {
        let url = resolve_specifier(&request.specifier().to_std_string_escaped(), &referrer)
            .map_err(|message| JsNativeError::typ().with_message(message))?;
        let referrer_url = referrer.path().and_then(|p| p.to_str()).map(String::from);
        if let Some(m) = self.cache.borrow().get(&url).cloned() {
            return Ok(m);
        }
        // Use the loaded Worker's module instance when one is available.
        let loaded = if let Some(ns) = native_import_namespace(url.clone()).await {
            LoadedModule::Native(ns)
        } else {
            match fetch_module_source(url.clone(), referrer_url).await {
                Ok(src) => LoadedModule::Source(src),
                Err(msg) => LoadedModule::Err(msg),
            }
        };
        // Dedupe concurrent in-flight loads of the same URL: a sibling load may
        // have parsed and registered this module while we fetched.
        if let Some(existing) = self.cache.borrow().get(&url).cloned() {
            return Ok(existing);
        }
        let module = {
            let ctx = &mut *context.borrow_mut();
            match loaded {
                LoadedModule::Native(ns) => v8_namespace_to_synthetic(&url, &ns, ctx),
                // A JSON module arrives wrapped as `export default <literal>` by the
                // gated source hook, which types it from the response MIME.
                LoadedModule::Source(src) => Module::parse(
                    Source::from_bytes(src.as_bytes())
                        .with_path(std::path::Path::new(url.as_str())),
                    None,
                    ctx,
                )?,
                LoadedModule::Err(msg) => {
                    return Err(JsNativeError::typ().with_message(msg).into());
                }
            }
        };
        self.cache.borrow_mut().insert(url, module.clone());
        Ok(module)
    }

    // boa leaves import.meta empty, so `new URL("./x", import.meta.url)` threw in
    // workerd. The path is the module's absolute URL (load_imported_module sets it).
    fn init_import_meta(
        self: Rc<Self>,
        import_meta: &JsObject,
        module: &Module,
        context: &mut Context,
    ) {
        let Some(url) = module.path().and_then(|p| p.to_str()) else {
            return;
        };
        let _ = import_meta.set(js_string!("url"), JsString::from(url), false, context);
        let resolve = NativeFunction::from_copy_closure_with_captures(
            |_this, args, url: &JsString, ctx| {
                let spec = args.get_or_undefined(0).to_string(ctx)?;
                resolve_import_meta(&spec.to_std_string_escaped(), &url.to_std_string_escaped())
                    .map(|resolved| JsString::from(resolved).into())
                    .map_err(|message| JsNativeError::typ().with_message(message).into())
            },
            JsString::from(url),
        );
        let resolve = FunctionObjectBuilder::new(context.realm(), resolve)
            .name(js_string!("resolve"))
            .length(1)
            .build();
        let _ = import_meta.set(js_string!("resolve"), resolve, false, context);
    }
}

fn resolve_import_meta(specifier: &str, referrer: &str) -> Result<String, String> {
    let global = js_sys::global();
    let resolver = Reflect::get(&global, &JsValue::from_str("__ks_resolve_import_map"))
        .ok()
        .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
        .ok_or_else(|| "import.meta.resolve is unavailable".to_string())?;
    match resolver.call2(
        &global,
        &JsValue::from_str(specifier),
        &JsValue::from_str(referrer),
    ) {
        Ok(resolved) => resolved
            .as_string()
            .ok_or_else(|| "import.meta.resolve returned a non-string".to_string()),
        Err(err) => Err(Reflect::get(&err, &JsValue::from_str("message"))
            .ok()
            .and_then(|m| m.as_string())
            .unwrap_or_else(|| format!("Failed to resolve module specifier \"{specifier}\""))),
    }
}

// Promise and generic jobs run synchronously under the drivers' context lock;
// async jobs (V8 promise awaits, module loads) are futures polled on V8's loop.
enum ReadyJob {
    Promise(PromiseJob),
    Generic(GenericJob),
}

impl ReadyJob {
    fn call(self, context: &mut Context) -> JsResult<BoaValue> {
        match self {
            Self::Promise(job) => job.call(context),
            Self::Generic(job) => job.call(context),
        }
    }
}

type AsyncJobFuture = Pin<Box<dyn Future<Output = JsResult<BoaValue>>>>;

#[derive(Default)]
struct WasmJobQueue {
    promise_jobs: RefCell<VecDeque<ReadyJob>>,
    // Not started yet: a NativeAsyncJob borrows a RefCell<&mut Context> for its
    // whole life, which only the driver that owns the context can hand it.
    async_jobs: RefCell<VecDeque<NativeAsyncJob>>,
    futures: RefCell<FuturesUnordered<AsyncJobFuture>>,
    // Set while `poll_futures` polls: an async job's continuation runs page JS,
    // which can re-enter here (ks_eval_page) and must not see an idle queue.
    polling: Cell<bool>,
    // The persistent context's cell (leaked with the context, which the isolate
    // reclaims per navigate). Fresh contexts drive their own jobs instead.
    ctx_cell: Cell<Option<&'static RefCell<&'static mut Context>>>,
}

impl WasmJobQueue {
    // Start queued async jobs against the persistent context, so pollers of
    // `futures` see them. Fresh-context drivers use drive_local instead.
    fn start_async_jobs(&self) {
        let Some(cell) = self.ctx_cell.get() else {
            return;
        };
        loop {
            let job = self.async_jobs.borrow_mut().pop_front();
            let Some(job) = job else {
                break;
            };
            let fut: AsyncJobFuture = Box::pin(job.call(cell));
            self.futures.borrow_mut().push(fut);
        }
    }

    fn is_idle(&self) -> bool {
        !self.polling.get()
            && self.promise_jobs.borrow().is_empty()
            && self.async_jobs.borrow().is_empty()
            && self.futures.borrow().is_empty()
    }

    // Poll with the set moved out of its RefCell: a job polled here can run JS
    // that re-enters the queue, which a borrow held across the poll would panic on.
    fn poll_futures(&self, cx: &mut std::task::Context<'_>) -> Poll<Option<JsResult<BoaValue>>> {
        let mut restore = RestoreFutures {
            queue: self,
            set: std::mem::take(&mut *self.futures.borrow_mut()),
        };
        self.polling.set(true);
        restore.set.poll_next_unpin(cx)
    }
}

// Puts the polled set back and clears `polling` even if a job panics and unwinds:
// the futures still pending survive, and is_idle can turn true again.
struct RestoreFutures<'a> {
    queue: &'a WasmJobQueue,
    set: FuturesUnordered<AsyncJobFuture>,
}

impl Drop for RestoreFutures<'_> {
    fn drop(&mut self) {
        self.queue.polling.set(false);
        let set = std::mem::take(&mut self.set);
        let mut current = self.queue.futures.borrow_mut();
        let pushed_meanwhile = std::mem::replace(&mut *current, set);
        for fut in pushed_meanwhile {
            current.push(fut);
        }
    }
}

impl JobExecutor for WasmJobQueue {
    fn enqueue_job(self: Rc<Self>, job: Job, _context: &mut Context) {
        match job {
            Job::PromiseJob(job) => self
                .promise_jobs
                .borrow_mut()
                .push_back(ReadyJob::Promise(job)),
            Job::GenericJob(job) => self
                .promise_jobs
                .borrow_mut()
                .push_back(ReadyJob::Generic(job)),
            Job::AsyncJob(job) | Job::FinalizationRegistryCleanupJob(job) => {
                self.async_jobs.borrow_mut().push_back(job);
            }
            // Timers belong to boa_runtime, which kitesurf does not install: page
            // timers are V8's. Anything else new to boa has no driver here either.
            _ => {}
        }
    }

    fn run_jobs(self: Rc<Self>, context: &mut Context) -> JsResult<()> {
        loop {
            let job = self.promise_jobs.borrow_mut().pop_front();
            match job {
                Some(job) => {
                    let _ = job.call(context);
                }
                None => break,
            }
        }
        Ok(())
    }
}

// Settle every job of a context that is not the persistent one (its own queue,
// its own cell), until nothing is queued or pending.
async fn drive_local(queue: &WasmJobQueue, context: &mut Context) {
    let cell = RefCell::new(context);
    let mut local: FuturesUnordered<Pin<Box<dyn Future<Output = JsResult<BoaValue>> + '_>>> =
        FuturesUnordered::new();
    loop {
        loop {
            let job = queue.promise_jobs.borrow_mut().pop_front();
            match job {
                Some(job) => {
                    let _ = job.call(&mut cell.borrow_mut());
                }
                None => break,
            }
        }
        loop {
            let job = queue.async_jobs.borrow_mut().pop_front();
            let Some(job) = job else {
                break;
            };
            local.push(Box::pin(job.call(&cell)));
        }
        if local.is_empty() {
            if queue.promise_jobs.borrow().is_empty() {
                break;
            }
            continue;
        }
        let _ = local.next().await;
    }
}

const ENVELOPE_BUILDER: &str = r#"(function(){
  var v = globalThis.__ks_r, t = typeof v;
  if (t === "function") return JSON.stringify({k:"fn",d:(""+v).slice(0,300)});
  if (t === "symbol") return JSON.stringify({k:"sym",d:(""+v)});
  if (t === "bigint") return JSON.stringify({k:"big",v:(""+v)});
  if (t === "undefined") return '{"k":"undef"}';
  var vj; try { vj = JSON.stringify(v); } catch(e){ return JSON.stringify({k:"obj",d:(""+v).slice(0,300)}); }
  if (vj === undefined) return '{"k":"undef"}';
  return JSON.stringify({k:"val",j:vj});
})()"#;

fn throw_env(message: &str, name: &str) -> String {
    serde_json::json!({ "k": "throw", "message": message, "name": name }).to_string()
}

async fn eval_to_envelope(src: &str, await_promise: bool) -> String {
    let queue = Rc::new(WasmJobQueue::default());
    let mut context = match ContextBuilder::new()
        .job_executor(queue.clone())
        .module_loader(Rc::new(KsModuleLoader::default()))
        .build()
    {
        Ok(c) => c,
        Err(e) => return throw_env(&format!("context build: {e}"), "Error"),
    };

    crate::js::boa_bridge::install_global_bridge(&mut context);
    // Publish the Context so V8-to-Boa trampolines can re-enter
    // during this eval. The guard clears the pointer on every return path
    // (drops before `context` since it is declared later).
    let _ctx_guard = crate::js::boa_bridge::set_context_ptr(&mut context as *mut _);

    let result = match context.eval(Source::from_bytes(src.as_bytes())) {
        Ok(v) => v,
        Err(e) => return throw_env(&format!("{e}"), "Error"),
    };

    // Settle boa's own microtasks (self-contained promises resolve here).
    drive_local(&queue, &mut context).await;

    let final_val = if await_promise {
        if let Some(promise) = result.as_promise() {
            match promise.state() {
                PromiseState::Fulfilled(v) => v,
                PromiseState::Rejected(v) => {
                    let msg = v
                        .to_string(&mut context)
                        .map(|s| s.to_std_string_escaped())
                        .unwrap_or_else(|_| "rejected".to_string());
                    return throw_env(&msg, "Error");
                }
                PromiseState::Pending => {
                    return throw_env(
                        "kitesurf boa: awaiting external promises needs the V8 bridge (Phase 4)",
                        "Error",
                    );
                }
            }
        } else {
            result
        }
    } else {
        result
    };

    if context
        .register_global_property(js_string!("__ks_r"), final_val, Attribute::all())
        .is_err()
    {
        return throw_env("register __ks_r failed", "Error");
    }
    match context.eval(Source::from_bytes(ENVELOPE_BUILDER.as_bytes())) {
        Ok(v) => v
            .as_string()
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_else(|| throw_env("envelope not a string", "Error")),
        Err(e) => throw_env(&format!("envelope build: {e}"), "Error"),
    }
}

thread_local! {
    // LIFETIME: Keep the Context allocation at a stable raw-pointer address for the
    // isolate; re-boxing would invalidate the nested reborrows that V8 re-entry relies on.
    static PERSIST: Cell<*mut Context> = const { Cell::new(std::ptr::null_mut()) };
    static PERSIST_QUEUE: RefCell<Option<Rc<WasmJobQueue>>> = const { RefCell::new(None) };
    static PERSIST_CP: RefCell<Option<boa_engine::interner::InternerCheckpoint>> =
        const { RefCell::new(None) };
    static PERSIST_MODULES: RefCell<Option<PersistentModuleCache>> = const { RefCell::new(None) };
    static INTERNER_RECLAIMS: Cell<u64> = const { Cell::new(0) };
    static PERSIST_CP_LEN: Cell<usize> = const { Cell::new(0) };
}

type PersistentModuleCache = Rc<RefCell<HashMap<String, Module>>>;

fn maybe_truncate_interner(ctx: &mut Context) {
    if ctx.interner().dynamic_len() <= PERSIST_CP_LEN.with(Cell::get) {
        return;
    }
    let Some(cp) = PERSIST_CP.with(|c| c.borrow().clone()) else {
        return;
    };
    let queue_idle = PERSIST_QUEUE.with(|q| q.borrow().as_ref().is_some_and(|q| q.is_idle()));
    if !queue_idle {
        return;
    }
    PERSIST_MODULES.with(|m| {
        if let Some(cache) = m.borrow().as_ref() {
            cache
                .borrow_mut()
                .retain(|_, module| !module.has_pending_source());
        }
    });
    let before = ctx.interner().dynamic_len();
    ctx.interner_mut().truncate(&cp);
    if ctx.interner().dynamic_len() < before {
        INTERNER_RECLAIMS.with(|r| r.set(r.get() + 1));
    }
}

pub(crate) struct PumpStats {
    pub promise_jobs: usize,
    pub futures: usize,
    pub drain_busy: bool,
    pub ticket_waiters: u64,
    pub bg_ticks: u64,
    pub bg_progress: u64,
    pub bg_last_tick_ms: f64,
}

thread_local! {
    static BG_TICKS: Cell<u64> = const { Cell::new(0) };
    static BG_PROGRESS: Cell<u64> = const { Cell::new(0) };
    static BG_LAST_TICK_MS: Cell<f64> = const { Cell::new(0.0) };
}

pub(crate) fn pump_stats() -> PumpStats {
    let (promise_jobs, futures) = PERSIST_QUEUE.with(|q| {
        q.borrow().as_ref().map_or((0, 0), |q| {
            (
                q.promise_jobs.borrow().len(),
                q.async_jobs.borrow().len() + q.futures.borrow().len(),
            )
        })
    });
    PumpStats {
        promise_jobs,
        futures,
        drain_busy: DRAIN_BUSY.with(|b| b.get()),
        ticket_waiters: BOA_TICKET_NEXT.with(|t| t.get()) - BOA_TICKET_SERVING.with(|s| s.get()),
        bg_ticks: BG_TICKS.with(|t| t.get()),
        bg_progress: BG_PROGRESS.with(|t| t.get()),
        bg_last_tick_ms: BG_LAST_TICK_MS.with(|t| t.get()),
    }
}

pub(crate) fn interner_stats() -> (usize, u64, usize, u8) {
    let len = with_context(|ctx| ctx.interner().dynamic_len()).unwrap_or(0);
    let pending = PERSIST_MODULES.with(|m| {
        m.borrow().as_ref().map_or(0, |cache| {
            cache
                .borrow()
                .values()
                .filter(|m| m.has_pending_source())
                .count()
        })
    });
    let idle = PERSIST_QUEUE.with(|q| q.borrow().as_ref().is_some_and(|q| q.is_idle()));
    (
        len,
        INTERNER_RECLAIMS.with(Cell::get),
        pending,
        u8::from(idle),
    )
}

fn ensure_persistent() -> bool {
    PERSIST.with(|p| {
        if !p.get().is_null() {
            return true;
        }
        let queue = Rc::new(WasmJobQueue::default());
        PERSIST_QUEUE.with(|q| *q.borrow_mut() = Some(queue.clone()));
        let loader = Rc::new(KsModuleLoader::default());
        PERSIST_MODULES.with(|m| *m.borrow_mut() = Some(Rc::clone(&loader.cache)));
        let Ok(ctx) = ContextBuilder::new()
            .job_executor(queue.clone())
            .module_loader(loader)
            .build()
        else {
            return false;
        };
        let mut boxed = Box::new(ctx);
        boxed.runtime_limits_mut().set_recursion_limit(256);
        boxed
            .runtime_limits_mut()
            .set_loop_iteration_limit(50_000_000);
        crate::js::boa_bridge::install_global_bridge(&mut boxed);
        PERSIST_CP.with(|c| *c.borrow_mut() = Some(boxed.interner().checkpoint()));
        PERSIST_CP_LEN.with(|l| l.set(boxed.interner().dynamic_len()));
        // LIFETIME: The raw pointer owns this stable allocation for bridge callbacks;
        // do not re-box it, or nested reborrows taken through `CTX` would dangle.
        let ptr: *mut Context = Box::into_raw(boxed);
        crate::js::boa_bridge::set_baseline_context_ptr(ptr);
        // SAFETY: `ptr` lives for the isolate's life (PERSIST). Async jobs borrow this leaked cell only
        // while polled, after pump/bg_drain drop their `&mut *ptr`; re-entries reborrow what with_v8 publishes.
        let cell: &'static RefCell<&'static mut Context> =
            Box::leak(Box::new(RefCell::new(unsafe { &mut *ptr })));
        queue.ctx_cell.set(Some(cell));
        p.set(ptr);
        wasm_bindgen_futures::spawn_local(background_pump());
        true
    })
}

#[wasm_bindgen]
pub fn ks_eval_page(src: &str) -> Result<JsValue, JsValue> {
    arm_v8_ran();
    if !ensure_persistent() {
        return Err(JsValue::from_str("kitesurf boa: context init failed"));
    }
    with_context(|ctx| match ctx.eval(Source::from_bytes(src.as_bytes())) {
        Ok(v) => {
            let _ = ctx.run_jobs();
            let out = crate::js::boa_bridge::boa_to_v8(&v, ctx);
            maybe_truncate_interner(ctx);
            Ok(out)
        }
        Err(e) => Err(JsValue::from_str(&format!("{e}"))),
    })
    .unwrap_or_else(|| Err(JsValue::from_str("kitesurf boa: context unavailable")))
}

#[wasm_bindgen]
pub fn ks_run_page_jobs() {
    arm_v8_ran();
    if !ensure_persistent() {
        return;
    }
    with_context(|ctx| {
        let _ = ctx.run_jobs();
        maybe_truncate_interner(ctx);
    });
}

// Single-threaded async lock serializing boa-context drivers so they
// don't alias &mut Context across an await in their job drain.

// webpack fires ~18 import() at once; without serialization the aliased
// persistent-context borrow corrupted its job queue (only ~2/18 resolved).
thread_local! {
    static BOA_TICKET_NEXT: Cell<u64> = const { Cell::new(1) };
    static BOA_TICKET_SERVING: Cell<u64> = const { Cell::new(1) };
    static BOA_TICKET_WAKERS: RefCell<HashMap<u64, Waker>> = RefCell::new(HashMap::new());
    static BOA_TICKET_ABANDONED: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    static DRAIN_BUSY: Cell<bool> = const { Cell::new(false) };
    static DRAIN_WAITERS: RefCell<VecDeque<Waker>> = const { RefCell::new(VecDeque::new()) };
}

struct BoaGuard;

impl Drop for BoaGuard {
    fn drop(&mut self) {
        advance_boa_serving();
    }
}

fn advance_boa_serving() {
    loop {
        let next = BOA_TICKET_SERVING.with(|s| {
            let v = s.get() + 1;
            s.set(v);
            v
        });
        let abandoned = BOA_TICKET_ABANDONED.with(|a| a.borrow_mut().remove(&next));
        if !abandoned {
            if let Some(w) = BOA_TICKET_WAKERS.with(|m| m.borrow_mut().remove(&next)) {
                w.wake();
            }
            break;
        }
    }
}

struct BoaTicket {
    ticket: u64,
    acquired: bool,
}

impl Future for BoaTicket {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<()> {
        let me = self.get_mut();
        if BOA_TICKET_SERVING.with(|s| s.get()) == me.ticket {
            me.acquired = true;
            Poll::Ready(())
        } else {
            BOA_TICKET_WAKERS.with(|m| m.borrow_mut().insert(me.ticket, cx.waker().clone()));
            Poll::Pending
        }
    }
}

impl Drop for BoaTicket {
    fn drop(&mut self) {
        if self.acquired {
            return;
        }
        BOA_TICKET_WAKERS.with(|m| m.borrow_mut().remove(&self.ticket));
        if BOA_TICKET_SERVING.with(|s| s.get()) == self.ticket {
            advance_boa_serving();
        } else {
            BOA_TICKET_ABANDONED.with(|a| a.borrow_mut().insert(self.ticket));
        }
    }
}

async fn acquire_boa_lock() -> BoaGuard {
    let ticket = BOA_TICKET_NEXT.with(|t| {
        let v = t.get();
        t.set(v + 1);
        v
    });
    BoaTicket {
        ticket,
        acquired: false,
    }
    .await;
    BoaGuard
}

struct DrainGuard;

impl Drop for DrainGuard {
    fn drop(&mut self) {
        DRAIN_BUSY.with(|b| b.set(false));
        let next = DRAIN_WAITERS.with(|w| w.borrow_mut().pop_front());
        if let Some(w) = next {
            w.wake();
        }
    }
}

async fn acquire_drain_lock() -> DrainGuard {
    poll_fn(|cx| {
        let free = DRAIN_BUSY.with(|b| {
            if b.get() {
                false
            } else {
                b.set(true);
                true
            }
        });
        if free {
            Poll::Ready(())
        } else {
            DRAIN_WAITERS.with(|w| w.borrow_mut().push_back(cx.waker().clone()));
            Poll::Pending
        }
    })
    .await;
    DrainGuard
}

// No driver holds the context and none waits for it: nothing boa runs is live
// beneath a fresh V8->boa entry, native calls included.
pub(crate) fn boa_lock_idle() -> bool {
    BOA_TICKET_NEXT.with(|t| BOA_TICKET_SERVING.with(|s| t.get() == s.get()))
}

// Option A: cooperative drain of the PERSISTENT context's job queue.
// Non-blocking lock tries for the background pump. It must NEVER block on a
// lock (a suspended driver can hold the drain lock), else it stops ticking.
fn try_acquire_boa_lock() -> Option<BoaGuard> {
    let free = BOA_TICKET_NEXT.with(|t| {
        BOA_TICKET_SERVING.with(|s| {
            if t.get() == s.get() {
                t.set(t.get() + 1);
                true
            } else {
                false
            }
        })
    });
    if free {
        Some(BoaGuard)
    } else {
        None
    }
}

fn try_acquire_drain_lock() -> Option<DrainGuard> {
    let free = DRAIN_BUSY.with(|b| {
        if b.get() {
            false
        } else {
            b.set(true);
            true
        }
    });
    if free {
        Some(DrainGuard)
    } else {
        None
    }
}

const JOB_DRAIN_BATCH: usize = 1024;

const JOB_DRAIN_BUDGET_MS: f64 = 100.0;

fn heal_residual_stack(ctx: &mut Context) {
    let before = ctx.ks_vm_stats().0;
    let cleared = ctx.ks_clear_residual_stack();
    let (frames, stack) = ctx.ks_vm_stats();
    if before > frames || cleared > 256 {
        crate::console_warn_str(&format!(
            "[kitesurf-boa] reclaimed {} stranded frame(s) + {cleared} \
             value-stack entries at idle",
            before - frames
        ));
    }
    if stack > 8192 || frames > 64 {
        crate::console_warn_str(&format!(
            "[kitesurf-boa] vm occupancy frames={frames} stack={stack} names={:?}",
            ctx.ks_vm_frame_names()
        ));
    }
}

fn drain_ready_bounded(queue: &WasmJobQueue, ctx: &mut Context) -> usize {
    let t0 = Date::now();
    heal_residual_stack(ctx);
    let mut n = 0usize;
    while n < JOB_DRAIN_BATCH && Date::now() - t0 < JOB_DRAIN_BUDGET_MS {
        let job = queue.promise_jobs.borrow_mut().pop_front();
        match job {
            Some(j) => {
                let _ = j.call(ctx);
                n += 1;
            }
            None => break,
        }
    }
    maybe_truncate_interner(ctx);
    n
}

// The pump releases Context between synchronous job batches and V8 I/O waits so
// quick evals can interleave; the drain token serializes shared-future polling.
// boa's job queue rides V8's microtask queue, so awaiting a proxied V8 thenable works directly.
async fn pump(ptr: *mut Context, is_done: impl Fn() -> bool) {
    let Some(queue) = PERSIST_QUEUE.with(|q| q.borrow().clone()) else {
        return;
    };
    loop {
        {
            let _ctx_guard = acquire_boa_lock().await;
            let ctx = unsafe { &mut *ptr };
            drain_ready_bounded(&queue, ctx);
        }
        if is_done() {
            return;
        }
        if !queue.promise_jobs.borrow().is_empty() {
            yield_to_v8(0).await;
            continue;
        }
        let _drain_guard = acquire_drain_lock().await;
        if is_done() {
            return;
        }
        queue.start_async_jobs();
        if queue.futures.borrow().is_empty() {
            if queue.promise_jobs.borrow().is_empty() {
                return;
            }
            drop(_drain_guard);
            yield_to_v8(0).await;
            continue;
        }
        // Await the next completed future WITHOUT the context lock, so a
        // concurrent quick eval can run its sync batch in this gap. The
        // RefCell borrow is per-poll, never held across the .await.
        let _ = poll_fn(|cx| queue.poll_futures(cx)).await;
    }
}

const BG_FAST_MS: i32 = 4;
const BG_IDLE_MS: i32 = 100;

async fn background_pump() {
    loop {
        let did = bg_drain_once().await;
        BG_TICKS.with(|t| t.set(t.get() + 1));
        if did {
            BG_PROGRESS.with(|t| t.set(t.get() + 1));
        }
        BG_LAST_TICK_MS.with(|t| t.set(Date::now()));
        yield_to_v8(if did { BG_FAST_MS } else { BG_IDLE_MS }).await;
    }
}

async fn bg_drain_once() -> bool {
    let Some(queue) = PERSIST_QUEUE.with(|q| q.borrow().clone()) else {
        return false;
    };
    let ptr = context_ptr();
    if ptr.is_null() {
        return false;
    }
    let mut did = false;
    if let Some(_g) = try_acquire_boa_lock() {
        let ctx = unsafe { &mut *ptr };
        if drain_ready_bounded(&queue, ctx) > 0 {
            did = true;
        }
    }
    if let Some(_dg) = try_acquire_drain_lock() {
        queue.start_async_jobs();
        let completed: usize = poll_fn(|cx| {
            let mut n = 0usize;
            while let Poll::Ready(Some(_)) = queue.poll_futures(cx) {
                n += 1;
            }
            Poll::Ready(n)
        })
        .await;
        if completed > 0 {
            did = true;
        }
    }
    if did {
        if let Some(_g) = try_acquire_boa_lock() {
            let ctx = unsafe { &mut *ptr };
            drain_ready_bounded(&queue, ctx);
        }
    }
    did
}

fn describe_rejection(v: &BoaValue, ctx: &mut Context) -> String {
    let Some(obj) = v.as_object() else {
        return v.display().to_string();
    };
    let get = |key: &str, ctx: &mut Context| -> Option<String> {
        obj.get(JsString::from(key), ctx)
            .ok()
            .filter(|p| !p.is_undefined() && !p.is_null())
            .and_then(|p| p.as_string().map(|s| s.to_std_string_escaped()))
            .filter(|s| !s.is_empty())
    };
    if let Some(stack) = get("stack", ctx) {
        return stack;
    }
    match (get("name", ctx), get("message", ctx)) {
        (Some(name), Some(msg)) => format!("{name}: {msg}"),
        (Some(name), None) => name,
        (None, Some(msg)) => msg,
        (None, None) => v.display().to_string(),
    }
}

#[wasm_bindgen]
pub fn ks_import(specifier: String, referrer_url: String) -> Promise {
    arm_v8_ran();
    wasm_bindgen_futures::future_to_promise(panic::AssertUnwindSafe(async move {
        let promise = {
            let _boa_guard = acquire_boa_lock().await;
            if !ensure_persistent() {
                return Err(JsValue::from_str("kitesurf boa: context init failed"));
            }
            let ptr = context_ptr();
            if ptr.is_null() {
                return Err(JsValue::from_str("kitesurf boa: no context"));
            }
            // SAFETY: single-threaded; the persistent context outlives this.
            let ctx: &mut Context = unsafe { &mut *ptr };
            let src = format!(
                "import({})",
                serde_json::to_string(&specifier).unwrap_or_else(|_| "''".to_string())
            );
            let promise_val = match ctx.eval(
                Source::from_bytes(src.as_bytes()).with_path(std::path::Path::new(&referrer_url)),
            ) {
                Ok(v) => v,
                Err(e) => return Err(JsValue::from_str(&format!("import eval: {e}"))),
            };
            match promise_val.as_promise() {
                Some(p) => p,
                None => return Err(JsValue::from_str("import() did not return a promise")),
            }
        };
        let ptr = context_ptr();
        pump(ptr, || !matches!(promise.state(), PromiseState::Pending)).await;
        let _boa_guard = acquire_boa_lock().await;
        let ctx: &mut Context = unsafe { &mut *ptr };
        match promise.state() {
            PromiseState::Fulfilled(ns) => Ok(crate::js::boa_bridge::boa_to_v8(&ns, ctx)),
            PromiseState::Rejected(e) => {
                let detail = describe_rejection(&e, ctx);
                Err(JsValue::from_str(&format!(
                    "import({specifier}) rejected: {detail}"
                )))
            }
            PromiseState::Pending => Err(JsValue::from_str(&format!(
                "import({specifier}) still pending"
            ))),
        }
    }))
}

#[wasm_bindgen]
pub fn ks_set_boa_strict(v: bool) {
    crate::js::boa_bridge::set_boa_strict(v);
}

#[wasm_bindgen]
pub fn ks_eval(src: String, await_promise: bool) -> Promise {
    wasm_bindgen_futures::future_to_promise(panic::AssertUnwindSafe(async move {
        Ok(JsValue::from_str(
            &eval_to_envelope(&src, await_promise).await,
        ))
    }))
}

async fn yield_to_v8(ms: i32) {
    let promise = Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        if let Ok(st) = Reflect::get(&global, &JsValue::from_str("setTimeout")) {
            if let Ok(f) = st.dyn_into::<js_sys::Function>() {
                let _ = f.call2(&global, &resolve, &JsValue::from_f64(f64::from(ms)));
            }
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

async fn yield_to_v8_microtasks() {
    let promise = Promise::resolve(&JsValue::UNDEFINED);
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

fn pump_due_page_timers(deadline: f64) -> bool {
    let Some(Ok(hook)) = get("pumpDueTimers").map(|v| v.dyn_into::<js_sys::Function>()) else {
        return false;
    };
    hook.call1(&JsValue::UNDEFINED, &JsValue::from_f64(deadline))
        .ok()
        .and_then(|value| value.as_f64())
        .is_some_and(|count| count > 0.0)
}

const AWAITED_YIELD_MAX_MS: f64 = 16.0;

fn awaited_yield_ms() -> i32 {
    let delay = get("nextTimerDelay")
        .and_then(|hook| hook.dyn_into::<js_sys::Function>().ok())
        .and_then(|hook| hook.call0(&JsValue::UNDEFINED).ok())
        .and_then(|value| value.as_f64())
        .unwrap_or(1.0);
    delay.clamp(1.0, AWAITED_YIELD_MAX_MS).ceil() as i32
}

const AWAITED_TIMER_PUMP_BUDGET_MS: f64 = 50.0;
const AWAITED_TIMER_PUMP_MAX_TURNS: u32 = 64;

// Settle and marshal without holding Context across V8 yields; host callbacks
// can re-enter Boa.
async fn drive_cdp(
    value: BoaValue,
    await_promise: bool,
    return_by_value: bool,
    ptr: *mut Context,
) -> Result<JsValue, JsValue> {
    // Do not hold &mut Context across yields; callbacks can re-enter with_context.
    if !await_promise {
        let _g = acquire_boa_lock().await;
        return Ok(marshal_cdp(value, return_by_value, unsafe { &mut *ptr }));
    }
    let Some(promise) = value.as_promise() else {
        let _g = acquire_boa_lock().await;
        return Ok(marshal_cdp(value, return_by_value, unsafe { &mut *ptr }));
    };
    {
        let _g = acquire_boa_lock().await;
        let ctx = unsafe { &mut *ptr };
        let _ = ctx.register_global_property(
            js_string!("__ks_await_root"),
            value.clone(),
            Attribute::all(),
        );
    }
    let mut pump_budget_started_at = Date::now();
    let mut pump_turns = 0;
    loop {
        {
            let _g = acquire_boa_lock().await;
            match promise.state() {
                PromiseState::Fulfilled(v) => {
                    return Ok(marshal_cdp(v, return_by_value, unsafe { &mut *ptr }));
                }
                PromiseState::Rejected(v) => {
                    let ctx = unsafe { &mut *ptr };
                    if let Some(original) = bridged_v8_throw(&v, ctx) {
                        return Err(original);
                    }
                    let msg = v
                        .to_string(ctx)
                        .map(|s| s.to_std_string_escaped())
                        .unwrap_or_else(|_| "boa promise rejected".to_string());
                    return Err(js_sys::Error::new(&msg).into());
                }
                PromiseState::Pending => {}
            }
        }
        yield_to_v8_microtasks().await;
        if !matches!(promise.state(), PromiseState::Pending) {
            continue;
        }
        if pump_due_page_timers(pump_budget_started_at + AWAITED_TIMER_PUMP_BUDGET_MS) {
            pump_turns += 1;
            yield_to_v8_microtasks().await;
            pump(ptr, || !matches!(promise.state(), PromiseState::Pending)).await;
            if !matches!(promise.state(), PromiseState::Pending)
                || (pump_turns < AWAITED_TIMER_PUMP_MAX_TURNS
                    && Date::now() - pump_budget_started_at < AWAITED_TIMER_PUMP_BUDGET_MS)
            {
                continue;
            }
        }
        pump_budget_started_at = Date::now();
        pump_turns = 0;
        yield_to_v8(awaited_yield_ms()).await;
        // Drain boa jobs the callback enqueued; the lock is released during
        // any async-job wait so a concurrent driver can interleave.
        pump(ptr, || !matches!(promise.state(), PromiseState::Pending)).await;
    }
}

// A throw from page code V8 ran (a natively baked script) reaches boa as a
// bridged proxy, which formats as "{ }". Hand V8 its own error back, so the
// CDP exception keeps the class, message and stack the page threw.
fn bridged_v8_throw(thrown: &BoaValue, ctx: &mut Context) -> Option<JsValue> {
    let obj = thrown.as_object()?;
    crate::js::boa_bridge::bridged_v8_handle(&obj, ctx).map(crate::js::boa_bridge::get_v8)
}

fn cdp_throw(e: &boa_engine::JsError, ctx: &mut Context) -> JsValue {
    e.as_opaque()
        .and_then(|thrown| bridged_v8_throw(thrown, ctx))
        .unwrap_or_else(|| js_sys::Error::new(&format!("{e}")).into())
}

fn build_envelope(value: BoaValue, ctx: &mut Context) -> String {
    if ctx
        .register_global_property(js_string!("__ks_r"), value, Attribute::all())
        .is_err()
    {
        return throw_env("register __ks_r failed", "Error");
    }
    match ctx.eval(Source::from_bytes(ENVELOPE_BUILDER.as_bytes())) {
        Ok(v) => v
            .as_string()
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_else(|| throw_env("envelope not a string", "Error")),
        Err(e) => throw_env(&format!("envelope build: {e}"), "Error"),
    }
}

fn marshal_cdp(value: BoaValue, return_by_value: bool, ctx: &mut Context) -> JsValue {
    if return_by_value {
        JsValue::from_str(&build_envelope(value, ctx))
    } else {
        crate::js::boa_bridge::boa_to_v8(&value, ctx)
    }
}

#[wasm_bindgen]
pub fn ks_eval_cdp(src: String, await_promise: bool, return_by_value: bool) -> Promise {
    arm_v8_ran();
    let ks_span = tracing::info_span!("wasm.boa_eval", src_bytes = src.len(), engine = "boa");
    wasm_bindgen_futures::future_to_promise(panic::AssertUnwindSafe(
        tracing::Instrument::instrument(
            async move {
                let (ptr, value) = {
                    let _boa_guard = acquire_boa_lock().await;
                    if !ensure_persistent() {
                        return Err(JsValue::from_str("kitesurf boa: context init failed"));
                    }
                    let ptr = context_ptr();
                    if ptr.is_null() {
                        return Err(JsValue::from_str("kitesurf boa: no context"));
                    }
                    // SAFETY: single-threaded; &mut is never held across a yield.
                    // The depth guard makes this borrow visible to the re-entry
                    // counter, so a nested `with_context` under it reads as 2;
                    // it does not gate anything.
                    let _depth = crate::js::boa_bridge::DepthGuard::enter();
                    let ctx = unsafe { &mut *ptr };
                    heal_residual_stack(ctx);
                    let value = match ctx.eval(Source::from_bytes(src.as_bytes())) {
                        Ok(v) => v,
                        Err(e) => return Err(cdp_throw(&e, ctx)),
                    };
                    (ptr, value)
                };
                pump(ptr, || true).await;
                drive_cdp(value, await_promise, return_by_value, ptr).await
            },
            ks_span,
        ),
    ))
}

#[wasm_bindgen]
pub fn ks_call_cdp(
    fn_src: String,
    this_v8: JsValue,
    args_v8: js_sys::Array,
    await_promise: bool,
    return_by_value: bool,
) -> Promise {
    arm_v8_ran();
    let ks_span = tracing::info_span!("wasm.boa_call", src_bytes = fn_src.len(), engine = "boa");
    wasm_bindgen_futures::future_to_promise(panic::AssertUnwindSafe(
        tracing::Instrument::instrument(
            async move {
                let (ptr, value) = {
                    let _boa_guard = acquire_boa_lock().await;
                    if !ensure_persistent() {
                        return Err(JsValue::from_str("kitesurf boa: context init failed"));
                    }
                    let ptr = context_ptr();
                    if ptr.is_null() {
                        return Err(JsValue::from_str("kitesurf boa: no context"));
                    }
                    // SAFETY: see ks_eval_cdp. &mut is never held across a yield.
                    let _depth = crate::js::boa_bridge::DepthGuard::enter();
                    let ctx = unsafe { &mut *ptr };
                    heal_residual_stack(ctx);
                    let fn_expr = format!("({fn_src})");
                    let fn_val = match ctx.eval(Source::from_bytes(fn_expr.as_bytes())) {
                        Ok(v) => v,
                        Err(e) => return Err(js_sys::Error::new(&format!("{e}")).into()),
                    };
                    let Some(callable) = fn_val.as_object().filter(|o| o.is_callable()) else {
                        return Err(JsValue::from_str(
                            "kitesurf boa: callFunctionOn target is not a function",
                        ));
                    };
                    let this_boa = crate::js::boa_bridge::v8_to_boa(this_v8, ctx);
                    let mut boa_args: Vec<BoaValue> = Vec::with_capacity(args_v8.length() as usize);
                    for i in 0..args_v8.length() {
                        boa_args.push(crate::js::boa_bridge::v8_to_boa(args_v8.get(i), ctx));
                    }
                    let value = match callable.call(&this_boa, &boa_args, ctx) {
                        Ok(v) => v,
                        Err(e) => return Err(cdp_throw(&e, ctx)),
                    };
                    (ptr, value)
                };
                pump(ptr, || true).await;
                drive_cdp(value, await_promise, return_by_value, ptr).await
            },
            ks_span,
        ),
    ))
}

#[wasm_bindgen]
pub fn ks_spike_boa_await(js_promise: Promise) -> Promise {
    wasm_bindgen_futures::future_to_promise(panic::AssertUnwindSafe(boa_spike_await_impl(
        js_promise,
    )))
}

async fn boa_spike_await_impl(js_promise: Promise) -> Result<JsValue, JsValue> {
    let queue = Rc::new(WasmJobQueue::default());
    let mut context = ContextBuilder::new()
        .job_executor(queue.clone())
        .build()
        .map_err(|e| JsValue::from_str(&format!("ctx build: {e}")))?;

    let (bridge, resolvers) = JsPromise::new_pending(&mut context);
    let bridge_job = NativeAsyncJob::new(async move |ctx: &RefCell<&mut Context>| {
        let v = wasm_bindgen_futures::JsFuture::from(js_promise)
            .await
            .unwrap_or(JsValue::UNDEFINED);
        let n = v.as_f64().unwrap_or(f64::NAN);
        resolvers.resolve.call(
            &BoaValue::undefined(),
            &[BoaValue::from(n)],
            &mut ctx.borrow_mut(),
        )
    });
    context.enqueue_job(Job::AsyncJob(bridge_job));

    context
        .register_global_property(js_string!("p"), bridge, Attribute::all())
        .map_err(|e| JsValue::from_str(&format!("register: {e}")))?;

    let result_val = context
        .eval(Source::from_bytes(
            b"(async () => { const r = await p; return r + 1; })()",
        ))
        .map_err(|e| JsValue::from_str(&format!("eval: {e}")))?;
    let result_obj = result_val
        .as_object()
        .ok_or_else(|| JsValue::from_str("eval result not a promise"))?
        .clone();
    let result = JsPromise::from_object(result_obj)
        .map_err(|e| JsValue::from_str(&format!("from_object: {e}")))?;

    // Drive boa's queue on V8's loop until the async fn settles.
    drive_local(&queue, &mut context).await;

    match result.state() {
        PromiseState::Fulfilled(v) => Ok(JsValue::from_f64(v.as_number().unwrap_or(f64::NAN))),
        PromiseState::Rejected(v) => Err(JsValue::from_str(&format!("rejected: {}", v.display()))),
        PromiseState::Pending => Err(JsValue::from_str("still pending after run_jobs")),
    }
}
