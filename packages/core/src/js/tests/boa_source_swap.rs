// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A script's retained source text moves to the embedder's code store at an idle point and
//! `toString` reads back only its span; every way the store can refuse or fail stays correct.

#![cfg(test)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use boa_engine::{CodeStore, Context, Script, Source};

#[derive(Default)]
struct MemStore {
    min: usize,
    refuse: Cell<bool>,
    fail_reads: Cell<bool>,
    next: Cell<u32>,
    values: RefCell<HashMap<u32, Vec<u8>>>,
    puts: Cell<usize>,
    reads: Cell<usize>,
    releases: Cell<usize>,
    flushes: Cell<usize>,
}

impl CodeStore for MemStore {
    fn min_bytes(&self) -> usize {
        self.min
    }

    fn put(&self, bytes: &[u8]) -> Option<u32> {
        if self.refuse.get() {
            return None;
        }
        self.puts.set(self.puts.get() + 1);
        let key = self.next.get() + 1;
        self.next.set(key);
        self.values.borrow_mut().insert(key, bytes.to_vec());
        Some(key)
    }

    fn read(&self, key: u32, offset: usize, len: usize, out: &mut Vec<u8>) -> bool {
        self.reads.set(self.reads.get() + 1);
        if self.fail_reads.get() {
            return false;
        }
        let values = self.values.borrow();
        let Some(bytes) = values.get(&key).and_then(|v| v.get(offset..offset + len)) else {
            return false;
        };
        out.clear();
        out.extend_from_slice(bytes);
        true
    }

    fn release(&self, key: u32, len: usize) {
        self.releases.set(self.releases.get() + 1);
        let gone = self.values.borrow_mut().remove(&key);
        assert_eq!(
            gone.map(|v| v.len()),
            Some(len),
            "a release names its own length"
        );
    }

    fn flush(&self) {
        self.flushes.set(self.flushes.get() + 1);
    }
}

fn install(min: usize) -> Rc<MemStore> {
    let store = Rc::new(MemStore {
        min,
        ..MemStore::default()
    });
    boa_engine::ks_set_code_store(Some(store.clone() as Rc<dyn CodeStore>));
    store
}

fn stat(key: &str) -> i64 {
    boa_engine::ks_code_stats()
        .into_iter()
        .find(|(name, _)| *name == key)
        .map_or(0, |(_, v)| v)
}

// A script big enough to swap: its function survives the eval, and padding makes it
// larger than the test store's min_bytes.
fn script_source(f: &str) -> String {
    let pad: String = (0..400).map(|i| format!("var pad{i} = {i};\n")).collect();
    format!("{pad}{f}\n")
}

fn eval_string(ctx: &mut Context, src: &str) -> String {
    let v = ctx.eval(Source::from_bytes(src.as_bytes())).expect("eval");
    v.as_string().expect("a string").to_std_string_escaped()
}

fn compile_and_run(ctx: &mut Context, src: &str) -> Script {
    let script = Script::parse(Source::from_bytes(src.as_bytes()), None, ctx).expect("parse");
    script.evaluate(ctx).expect("run");
    script
}

#[test]
fn source_text_swaps_at_idle_and_reads_back_its_span() {
    let store = install(1024);
    let mut ctx = Context::default();
    const F: &str = "function f(a, b) { return a + b; /* survives */ }";
    let src = script_source(F);
    let script = compile_and_run(&mut ctx, &src);
    let resident = stat("sourceBytes");

    boa_engine::ks_swap_at_idle();
    assert_eq!(stat("sourceSwappedTexts"), 1);
    assert_eq!(
        store.flushes.get(),
        1,
        "a round that stored something flushes"
    );
    assert!(store
        .values
        .borrow()
        .values()
        .any(|v| v.as_slice() == src.as_bytes()));
    assert_eq!(
        resident - stat("sourceBytes"),
        src.len() as i64,
        "the Latin-1 text left memory"
    );
    assert_eq!(stat("sourceSwappedBytes"), src.len() as i64);

    assert_eq!(eval_string(&mut ctx, "f.toString()"), F);
    assert_eq!(store.reads.get(), 1, "one read, of f's span only");
    boa_engine::ks_swap_at_idle();
    assert_eq!(stat("sourceSwappedTexts"), 1, "nothing is swapped twice");

    drop(script);
    drop(ctx);
    boa_engine::gc::force_collect();
    assert!(
        store.values.borrow().is_empty(),
        "every stored value was released"
    );
    assert_eq!(stat("sourceSwappedBytes"), 0);
    assert_eq!(stat("sourceSwappedTexts"), 0);
}

#[test]
fn a_utf16_source_round_trips() {
    let store = install(1024);
    let mut ctx = Context::default();
    const F: &str = "function g() { return \"€ and 😀\"; }";
    let script = compile_and_run(&mut ctx, &script_source(F));
    boa_engine::ks_swap_at_idle();
    assert_eq!(stat("sourceSwappedTexts"), 1);
    assert_eq!(eval_string(&mut ctx, "g.toString()"), F);
    assert_eq!(store.reads.get(), 1);
    drop(script);
}

#[test]
fn a_refused_put_stays_resident() {
    let store = install(1024);
    store.refuse.set(true);
    let mut ctx = Context::default();
    const F: &str = "function h() { return 1; }";
    let script = compile_and_run(&mut ctx, &script_source(F));
    assert_eq!(boa_engine::ks_swap_at_idle(), 0);
    assert_eq!(stat("sourceSwappedTexts"), 0);
    assert_eq!(eval_string(&mut ctx, "h.toString()"), F);
    assert_eq!(store.reads.get(), 0);
    drop(script);
}

#[test]
fn a_failed_read_falls_back_to_native_code() {
    let store = install(1024);
    let mut ctx = Context::default();
    let script = compile_and_run(&mut ctx, &script_source("function k() { return 2; }"));
    boa_engine::ks_swap_at_idle();
    assert_eq!(stat("sourceSwappedTexts"), 1);
    store.fail_reads.set(true);
    let failures = stat("storeFailures");
    assert_eq!(
        eval_string(&mut ctx, "k.toString()"),
        "function k() { [native code] }"
    );
    assert_eq!(stat("storeFailures") - failures, 1);
    drop(script);
}

#[test]
fn small_scripts_json_and_scripts_that_die_never_reach_the_store() {
    let store = install(4096);
    let mut ctx = Context::default();
    // Each kind that must not reach the store: a script under min_bytes, JSON.parse's own
    // transient text, and a big script whose functions don't outlive it.
    let small = compile_and_run(&mut ctx, "function s() { return 3; }");
    let big_json = format!(
        "[{}]",
        (0..2000)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let parsed = ctx
        .eval(Source::from_bytes(
            format!("JSON.parse('{big_json}').length").as_bytes(),
        ))
        .expect("parse json");
    assert_eq!(parsed.as_number(), Some(2000.0));
    let gone = compile_and_run(&mut ctx, &script_source("(function () { return 4; })();"));
    drop(gone);
    boa_engine::gc::force_collect();
    boa_engine::ks_swap_at_idle();
    // The eval wrapping JSON.parse is itself a big script, and it dies before the idle
    // point, so its text never swaps either (bytecode has rounds of its own).
    assert_eq!(stat("sourceSwappedTexts"), 0);
    let _ = &store;
    drop(small);
}
