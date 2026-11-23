// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! HostPromiseRejectionTracker for the persistent boa context. workerd tracks only V8's
//! promises, so a rejection in code that runs on boa reaches the page through this.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use boa_engine::builtins::promise::{OperationType, Promise, PromiseState};
use boa_engine::context::HostHooks;
use boa_engine::object::builtins::JsPromise;
use boa_engine::object::JsObject;
use boa_engine::{Context, JsValue as BoaValue};
use wasm_bindgen::prelude::*;

use crate::js::boa_bridge::boa_to_v8;

// A reported promise is kept until a handler arrives so `rejectionhandled` can name it; a page
// that never handles its rejections must not grow this without bound.
const REPORTED_CAP: usize = 256;

thread_local! {
    static HOOK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static TRACKER: RefCell<Option<Rc<RejectionTracker>>> = const { RefCell::new(None) };
}

/// Makes `tracker` the persistent context's: the one `consume` and `notify_persistent` reach,
/// since only that context outlives a single evaluation.
pub(crate) fn install(tracker: Rc<RejectionTracker>) {
    TRACKER.with(|t| *t.borrow_mut() = Some(tracker));
}

/// Reports the persistent context's changes at a microtask checkpoint, as
/// `RejectionTracker::notify` does for its own context.
pub(crate) fn notify_persistent(ctx: &mut Context) {
    if let Some(tracker) = TRACKER.with(|t| t.borrow().clone()) {
        tracker.notify(ctx);
    }
}

/// Takes `promise` out of the report: engine code settles it for a caller (an `import()`, an
/// awaited evaluation), which then handles its rejection itself.
pub(crate) fn consume(promise: &JsPromise) {
    let Some(tracker) = TRACKER.with(|t| t.borrow().clone()) else {
        return;
    };
    let Ok(promise) = JsObject::from(promise.clone()).downcast::<Promise>() else {
        return;
    };
    let mut pending = tracker.pending.borrow_mut();
    if let Some(i) = pending.iter().position(|p| JsObject::equals(p, &promise)) {
        pending.swap_remove(i);
        return;
    }
    drop(pending);
    if matches!(
        JsPromise::from(promise.clone()).state(),
        PromiseState::Pending
    ) {
        let mut consumed = tracker.consumed.borrow_mut();
        if consumed.len() >= REPORTED_CAP {
            consumed.pop_front();
        }
        consumed.push_back(promise);
    }
}

/// Sets the page script's receiver of `(kind, promise, reason)`, where kind is `"unhandled"`,
/// `"handled"` or `"bridged"` (a V8 promise boa is about to attach its handler to).
#[wasm_bindgen]
pub fn ks_set_promise_rejection_hook(hook: js_sys::Function) {
    HOOK.with(|h| *h.borrow_mut() = Some(hook));
}

fn call_hook(kind: &str, promise: &JsValue, reason: &JsValue) {
    HOOK.with(|h| {
        if let Some(hook) = h.borrow().as_ref() {
            let _ = hook.call3(
                &JsValue::UNDEFINED,
                &JsValue::from_str(kind),
                promise,
                reason,
            );
        }
    });
}

/// Tells the page script the bridge is attaching its own handler to `native`, so the
/// `rejectionhandled` V8 fires for that attach is not taken for page code handling it.
pub(crate) fn note_bridged(native: &JsValue) {
    call_hook("bridged", native, &JsValue::UNDEFINED);
}

#[derive(Default)]
pub(crate) struct RejectionTracker {
    pending: RefCell<Vec<JsObject<Promise>>>,
    reported: RefCell<VecDeque<JsObject<Promise>>>,
    consumed: RefCell<VecDeque<JsObject<Promise>>>,
}

impl HostHooks for RejectionTracker {
    fn promise_rejection_tracker(
        &self,
        promise: &JsObject<Promise>,
        operation: OperationType,
        context: &mut Context,
    ) {
        match operation {
            OperationType::Reject => {
                let mut consumed = self.consumed.borrow_mut();
                if let Some(i) = consumed.iter().position(|p| JsObject::equals(p, promise)) {
                    consumed.remove(i);
                    return;
                }
                drop(consumed);
                self.pending.borrow_mut().push(promise.clone());
            }
            OperationType::Handle => {
                let mut pending = self.pending.borrow_mut();
                if let Some(i) = pending.iter().position(|p| JsObject::equals(p, promise)) {
                    pending.swap_remove(i);
                    return;
                }
                drop(pending);
                let mut reported = self.reported.borrow_mut();
                let Some(i) = reported.iter().position(|p| JsObject::equals(p, promise)) else {
                    return;
                };
                reported.remove(i);
                drop(reported);
                // At once, not at the next checkpoint: the page script must still be able to
                // drop a report it has queued but not yet fired, as HTML checks the promise then.
                let value: BoaValue = JsObject::from(JsPromise::from(promise.clone())).into();
                let promise_v8 = boa_to_v8(&value, context);
                call_hook("handled", &promise_v8, &JsValue::UNDEFINED);
            }
        }
    }
}

impl RejectionTracker {
    /// Reports the promises still rejected without a handler, as HTML does after a microtask
    /// checkpoint. A reported promise that gains a handler is reported as it does.
    pub(crate) fn notify(&self, ctx: &mut Context) {
        if self.pending.borrow().is_empty() {
            return;
        }
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        for promise in pending {
            let PromiseState::Rejected(reason) = JsPromise::from(promise.clone()).state() else {
                continue;
            };
            let value: BoaValue = JsObject::from(JsPromise::from(promise.clone())).into();
            let promise_v8 = boa_to_v8(&value, ctx);
            let reason_v8 = boa_to_v8(&reason, ctx);
            call_hook("unhandled", &promise_v8, &reason_v8);
            let mut reported = self.reported.borrow_mut();
            if reported.len() >= REPORTED_CAP {
                reported.pop_front();
            }
            reported.push_back(promise);
        }
    }
}
