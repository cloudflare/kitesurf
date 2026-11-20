// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Bytecode moves to the embedder's code store at idle and comes back on first run, and a
//! forced round drops what ran, except where a frame stands; every path must stay correct.

#![cfg(test)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use boa_engine::{js_string, CodeStore, Context, JsValue, NativeFunction, Source};

#[derive(Default)]
struct MemStore {
    refuse: Cell<bool>,
    corrupt: Cell<bool>,
    next: Cell<u32>,
    values: RefCell<HashMap<u32, Vec<u8>>>,
    reads: Cell<usize>,
}

impl CodeStore for MemStore {
    fn min_bytes(&self) -> usize {
        usize::MAX
    }

    fn put(&self, bytes: &[u8]) -> Option<u32> {
        if self.refuse.get() {
            return None;
        }
        let key = self.next.get();
        self.next.set(key + bytes.len() as u32);
        self.values.borrow_mut().insert(key, bytes.to_vec());
        Some(key)
    }

    fn read(&self, key: u32, offset: usize, len: usize, out: &mut Vec<u8>) -> bool {
        self.reads.set(self.reads.get() + 1);
        let values = self.values.borrow();
        let Some(bytes) = values.get(&key).and_then(|v| v.get(offset..offset + len)) else {
            return false;
        };
        out.clear();
        out.extend_from_slice(bytes);
        if self.corrupt.get() {
            out[0] ^= 0x55;
        }
        true
    }

    fn release(&self, key: u32, len: usize) {
        let gone = self.values.borrow_mut().remove(&key);
        assert_eq!(
            gone.map(|v| v.len()),
            Some(len),
            "a release names its own length"
        );
    }

    fn flush(&self) {}
}

fn install() -> Rc<MemStore> {
    let store = Rc::new(MemStore::default());
    boa_engine::ks_set_code_store(Some(store.clone() as Rc<dyn CodeStore>));
    store
}

fn stat(key: &str) -> i64 {
    boa_engine::ks_code_stats()
        .into_iter()
        .find(|(name, _)| *name == key)
        .map_or(0, |(_, v)| v)
}

fn eval(ctx: &mut Context, src: &str) -> JsValue {
    ctx.eval(Source::from_bytes(src.as_bytes())).expect("eval")
}

fn number(ctx: &mut Context, src: &str) -> f64 {
    eval(ctx, src).as_number().expect("a number")
}

// Functions big enough to swap (packed forms over the 24-byte floor), defined by one script
// and kept alive by the global object after it is gone.
const FUNCTIONS: &str = "
    function add(a, b) { let s = 0; for (let i = 0; i < a; i++) { s += i * b + (i % 3); } return s; }
    function mul(a, b) { let s = 0; for (let i = 0; i < b; i++) { s += a + (i & 7) - (i >> 2); } return s; }
    function* gen(n) { let k = 0; while (k < n) { yield k * 2 + (k % 5); k++; } return -1; }
";

#[test]
fn never_run_bytecode_swaps_at_idle_and_comes_back_on_first_run() {
    let store = install();
    let mut ctx = Context::default();
    eval(&mut ctx, FUNCTIONS);
    let packed = stat("packedBytes");
    boa_engine::ks_swap_at_idle();
    assert!(
        stat("swappedBlocks") >= 3,
        "add, mul and gen went to the store"
    );
    assert!(
        packed - stat("packedBytes") > 0,
        "their packed forms left memory"
    );

    let reads = store.reads.get();
    assert_eq!(number(&mut ctx, "add(10, 3)"), 144.0);
    assert!(store.reads.get() > reads, "the first run read add back");
    assert_eq!(
        number(&mut ctx, "add(4, 2)"),
        15.0,
        "and later runs need nothing"
    );

    drop(ctx);
    boa_engine::gc::force_collect();
    assert!(
        store.values.borrow().is_empty(),
        "every stored value was released"
    );
    assert_eq!(stat("swappedBlocks"), 0);
    assert_eq!(stat("flushableBlocks"), 0);
}

#[test]
fn a_forced_round_drops_what_ran_and_the_next_run_reads_it_back() {
    let store = install();
    let mut ctx = Context::default();
    eval(&mut ctx, FUNCTIONS);
    let expected = number(&mut ctx, "add(10, 3) + mul(3, 10)");
    boa_engine::ks_swap_at_idle();
    assert!(
        stat("flushableBlocks") >= 2,
        "what ran got a copy in the store"
    );

    let expanded = stat("expandedBytes");
    assert!(boa_engine::ks_swap_under_pressure() > 0);
    assert!(
        stat("expandedBytes") < expanded,
        "a forced round dropped executable bytes"
    );
    assert!(stat("flushes") >= 2);

    let reads = store.reads.get();
    assert_eq!(number(&mut ctx, "add(10, 3) + mul(3, 10)"), expected);
    assert!(
        store.reads.get() > reads,
        "the flushed functions came back from the store"
    );
    drop(ctx);
}

thread_local! {
    static LEFT_PINNED: Cell<i64> = const { Cell::new(i64::MAX) };
}

#[test]
fn a_forced_round_inside_a_call_leaves_the_running_frames_alone() {
    let _store = install();
    let mut ctx = Context::default();
    ctx.register_global_callable(
        js_string!("pressure"),
        0,
        NativeFunction::from_fn_ptr(|_, _, _| {
            boa_engine::ks_swap_under_pressure();
            // What a round leaves registered is exactly what it would not drop: the blocks
            // pinned by frames on the stack.
            LEFT_PINNED.with(|m| m.set(m.get().min(stat("flushableBlocks"))));
            Ok(JsValue::undefined())
        }),
    )
    .expect("register pressure");
    eval(&mut ctx, FUNCTIONS);
    eval(
        &mut ctx,
        "function outer(n) { let before = add(n, 2); pressure(); return before + add(n, 2) + inner(n); }
         function inner(n) { let t = 0; for (let i = 0; i < n; i++) { pressure(); t += mul(i, 3); } return t; }",
    );
    // Run everything once, so each block is expanded, and the idle round gives it a store
    // copy that a forced round can drop its bytes for.
    let first = number(&mut ctx, "outer(6)");
    boa_engine::ks_swap_at_idle();
    // outer (and inner, from inside it) are on the stack each time pressure() runs, and add
    // and mul are not, so only the callees may be dropped.
    LEFT_PINNED.with(|m| m.set(i64::MAX));
    assert_eq!(number(&mut ctx, "outer(6)"), first);
    assert!(
        LEFT_PINNED.with(Cell::get) >= 1,
        "a round kept the blocks whose frames stood"
    );
    assert!(stat("forcedRounds") >= 7);
    assert!(
        stat("flushes") > 0,
        "the callees were flushed between their calls"
    );
    drop(ctx);
}

#[test]
fn a_suspended_generator_resumes_after_its_bytecode_was_dropped() {
    let _store = install();
    let mut ctx = Context::default();
    eval(&mut ctx, FUNCTIONS);
    eval(
        &mut ctx,
        "var it = gen(10); var a = it.next().value + it.next().value;",
    );
    boa_engine::ks_swap_at_idle();
    let flushes = stat("flushes");
    boa_engine::ks_swap_under_pressure();
    assert!(
        stat("flushes") > flushes,
        "the suspended generator holds no pin"
    );
    assert_eq!(
        number(&mut ctx, "a + it.next().value + it.next().value"),
        0.0 + 3.0 + 6.0 + 9.0
    );
    drop(ctx);
}

#[test]
fn a_refused_put_stays_resident_and_runs() {
    let store = install();
    store.refuse.set(true);
    let mut ctx = Context::default();
    eval(&mut ctx, FUNCTIONS);
    boa_engine::ks_swap_at_idle();
    boa_engine::ks_swap_under_pressure();
    assert_eq!(stat("swappedBlocks"), 0);
    assert_eq!(stat("flushes"), 0);
    assert_eq!(number(&mut ctx, "add(10, 3)"), 144.0);
    drop(ctx);
}

#[test]
fn bytes_that_come_back_different_never_run() {
    let store = install();
    let mut ctx = Context::default();
    eval(&mut ctx, FUNCTIONS);
    boa_engine::ks_swap_at_idle();
    store.corrupt.set(true);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ctx.eval(Source::from_bytes("add(10, 3)".as_bytes()));
    }));
    std::panic::set_hook(prev);
    let message = run.expect_err("a corrupt read must not run");
    let text = message.downcast_ref::<&str>().copied().unwrap_or_default();
    assert!(text.contains("could not be read back intact"), "{text}");
    assert_eq!(stat("storeFailures"), 1);
}
