// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Never-run function bodies move to the code store at idle with everything nested in them
//! (vendored boa ks_body), and must come back indistinguishable from code that never left.

#![cfg(test)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use boa_engine::{CodeStore, Context, Script, Source};

#[derive(Default)]
struct MemStore {
    next: Cell<u32>,
    values: RefCell<HashMap<u32, Vec<u8>>>,
    corrupt: Cell<bool>,
}

impl CodeStore for MemStore {
    fn min_bytes(&self) -> usize {
        usize::MAX
    }

    fn put(&self, bytes: &[u8]) -> Option<u32> {
        let key = self.next.get();
        self.next.set(key + bytes.len().max(1) as u32);
        self.values.borrow_mut().insert(key, bytes.to_vec());
        Some(key)
    }

    fn read(&self, key: u32, offset: usize, len: usize, out: &mut Vec<u8>) -> bool {
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
            "a release names a live key and its length"
        );
    }

    fn flush(&self) {}
}

fn stat(key: &str) -> i64 {
    boa_engine::ks_code_stats()
        .into_iter()
        .find(|(name, _)| *name == key)
        .map_or(0, |(_, v)| v)
}

fn eval(ctx: &mut Context, src: &str) -> String {
    let v = ctx.eval(Source::from_bytes(src.as_bytes())).expect("eval");
    v.to_string(ctx).expect("string").to_std_string_escaped()
}

// Defined by one script and only run by a later one, so every function here is still
// unrun at the idle round between them, apart from `make` and the IIFE that set up `blk`.
const DEFS: &str = r#"
var R = {};
function closures(n) { let a = n; const f = () => { let b = a * 2; return () => a + b; }; return f()(); }
function classes() {
  class A { #p = 3; static s = 4; static { this.t = 5; } get g() { return this.#p; } set g(v) { this.#p = v; }
    m() { return #p in this; } static k() { return A.s + A.t; } }
  class B extends A { constructor() { super(); this.q = 1; } m() { return super.m() && this.q === 1; } }
  const b = new B(); b.g = 9; return [b.g, b.m(), A.k()].join();
}
function* gen(n) { for (let i = 0; i < n; i++) { try { yield i; } finally { R.fin = (R.fin | 0) + 1; } } }
async function asyncFn(x) { const v = await Promise.resolve(x); return v + 1; }
async function* agen() { yield 1; yield await Promise.resolve(2); }
function destructure({ a, b: [c, d = 4] = [], ...rest }, ...args) { return [a, c, d, Object.keys(rest).join(), args.length].join(); }
function templates(x) { const tag = (s, ...v) => s.raw.join("|") + v.join(); return tag`a${x}b\n${x + 1}c` + `plain${x}`; }
function regexAndBig() { const r = /(\d+)-(\w+)/g; const m = r.exec("x 12-ab"); return m[1] + m[2] + (2n ** 70n).toString() + 12345678901234567890n; }
function labels() { let s = 0; outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j === 3) continue outer; if (i === 4) break outer; s += j; } } return s; }
function tryCatch() { try { null.x; } catch ({ message }) { return message.length > 0; } finally { R.tc = 1; } }
function sloppyArgs(a, b) { arguments[0] = 10; return a + b; }
function strictArgs(a) { "use strict"; arguments[0] = 10; return a; }
function withStmt() { const o = { w: 2 }; with (o) { return w * 3; } }
function evalInside(x) { var y = 1; eval("var z = x + y"); return eval("z * 2"); }
function deep() { function l1() { function l2() { function l3() { return "deep"; } return l3(); } return l2(); } return l1(); }
function getterSetter() { const o = { _v: 1, get v() { return this._v; }, set v(x) { this._v = x * 2; }, ["comp" + 1]: 7, m() { return super.toString !== undefined; } }; o.v = 5; return [o.v, o.comp1, o.m()].join(); }
function defaults(a, b = a + 1, c = (() => a * b)()) { return [a, b, c].join(); }
function switchFn(x) { switch (x) { case 1: return "one"; case "a": return "A"; default: return "d"; } }
function spread() { const a = [1, 2]; const o = { ...{ p: 1 }, q: 2 }; return Math.max(...a, 0) + Object.keys(o).length; }
function optional(o) { return o?.a?.b ?? "none"; }
function forOfIn() { let s = ""; for (const k in { x: 1, y: 2 }) s += k; for (const v of new Set([3, 4])) s += v; return s; }
function closureCounter() { let c = 0; return { inc: () => ++c, get: () => c }; }
function utf16() { const s = "héllo ☃ 𝒳"; return s.length + s.normalize("NFD").length + "€".charCodeAt(0); }
function throwsAt() {
  throw new Error("boom");
}
var made = (function make() {
  let k = 5;
  return { a: function (x) { return x + k; }, b: (y) => { const z = () => y * k; return z(); } };
})();
var blk = (function () { const out = []; for (let i = 0; i < 3; i++) { out.push(() => i * 10); } return out; })();
"#;

const CALLS: &str = r#"
const out = [];
out.push(closures(3), classes(), [...gen(3)].join(), R.fin, destructure({ a: 1, b: [2], x: 1, y: 2 }, 9, 8));
out.push(templates(1), regexAndBig(), labels(), tryCatch(), R.tc, sloppyArgs(1, 2), strictArgs(1), withStmt());
out.push(evalInside(2), deep(), getterSetter(), defaults(2), switchFn(1), switchFn("a"), switchFn(0), spread());
out.push(optional({ a: { b: 3 } }), optional(null), forOfIn(), utf16(), made.a(1), made.b(2), blk.map((f) => f()).join());
const cc = closureCounter(); cc.inc(); cc.inc(); out.push(cc.get());
out.push(deep.toString(), made.b.toString(), classes.name, destructure.length, defaults.length);
try { throwsAt(); } catch (e) { out.push(e.stack); }
asyncFn(1).then((v) => { R.async = v; });
(async () => { const got = []; for await (const v of agen()) got.push(v); R.agen = got.join(); })();
JSON.stringify(out)
"#;

// The suite's output, with never-run bodies swapped out between their definition and
// their first call, or never swapped at all.
fn run_suite(swap: bool) -> (String, String) {
    let store = Rc::new(MemStore::default());
    boa_engine::ks_set_code_store(swap.then(|| store.clone() as Rc<dyn CodeStore>));
    let mut ctx = Context::default();
    eval(&mut ctx, DEFS);
    if swap {
        let before = stat("bodiesSwapped");
        boa_engine::ks_swap_at_idle();
        assert!(
            stat("bodiesSwapped") - before > 20,
            "the unrun functions' bodies left memory"
        );
    }
    let faults = stat("bodyFaults");
    let out = eval(&mut ctx, CALLS);
    ctx.run_jobs().expect("jobs");
    let late = eval(&mut ctx, "JSON.stringify([R.async, R.agen])");
    if swap {
        assert!(
            stat("bodyFaults") > faults,
            "running them read the bodies back"
        );
    }
    boa_engine::ks_set_code_store(None);
    (out, late)
}

#[test]
fn swapped_bodies_run_exactly_like_resident_ones() {
    let plain = run_suite(false);
    let swapped = run_suite(true);
    assert_eq!(swapped.0, plain.0);
    assert_eq!(swapped.1, plain.1);
    assert_eq!(plain.1, r#"[2,"1,2"]"#);
}

// The disassembly of every block of a compile, swapped out first or not, with anonymous
// ids (a global counter) normalized.
fn dump(ctx: &mut Context, src: &str, swap: bool) -> String {
    let script = Script::parse(Source::from_bytes(src.as_bytes()), None, ctx).expect("parse");
    let code = script.codeblock(ctx).expect("compile");
    if swap {
        boa_engine::ks_swap_at_idle();
    }
    let text = boa_engine::ks_debug_dump(&code);
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(i) = rest.find("anon#") {
        out.push_str(&rest[..i + 5]);
        rest = rest[i + 5..].trim_start_matches(|c: char| c.is_ascii_digit());
        out.push('N');
    }
    out.push_str(rest);
    // The header centers the name in dashes, so an id's width moves the padding; compare
    // the lines without it.
    out.lines()
        .map(|l| l.trim_matches('-'))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_round_trips(src: &str) -> (i64, i64) {
    // Blocks release into the store that is current when they drop, so none may outlive
    // the store it came from.
    boa_engine::gc::force_collect();
    boa_engine::ks_set_code_store(None);
    let plain = dump(&mut Context::default(), src, false);
    boa_engine::gc::force_collect();
    let store = Rc::new(MemStore::default());
    boa_engine::ks_set_code_store(Some(store.clone() as Rc<dyn CodeStore>));
    let (records, skips) = (stat("bodyRecords"), stat("bodySkips"));
    let swapped = dump(&mut Context::default(), src, true);
    let moved = (stat("bodyRecords") - records, stat("bodySkips") - skips);
    boa_engine::gc::force_collect();
    boa_engine::ks_set_code_store(None);
    if swapped != plain {
        let line = plain
            .lines()
            .zip(swapped.lines())
            .position(|(a, b)| a != b)
            .unwrap_or(0);
        panic!(
            "dump differs at line {line}:\n  resident: {:?}\n  swapped:  {:?}",
            plain.lines().nth(line),
            swapped.lines().nth(line)
        );
    }
    moved
}

#[test]
fn a_swapped_tree_disassembles_like_the_resident_one() {
    for src in [DEFS, CALLS] {
        let (records, skips) = assert_round_trips(src);
        assert!(records > 0, "the compile's nested blocks went to the store");
        assert_eq!(skips, 0, "no subtree was left resident");
    }
}

// The same check over real bundles, when KS_BODY_CORPUS names a directory of scripts
// (a large bundle's chunks: about 50k blocks).
#[test]
fn corpus_round_trips() {
    let Ok(dir) = std::env::var("KS_BODY_CORPUS") else {
        return;
    };
    // Debug builds of boa's recursive parser need far more than a test thread's stack on
    // a minified bundle.
    let run = std::thread::Builder::new()
        .stack_size(512 << 20)
        .spawn(move || corpus(&dir));
    run.expect("spawn").join().expect("corpus");
}

fn corpus(dir: &str) {
    let mut n = 0;
    for entry in std::fs::read_dir(dir).expect("corpus dir") {
        let path = entry.expect("entry").path();
        if path.extension().is_some_and(|e| e == "js") {
            let src = std::fs::read_to_string(&path).expect("read");
            if Script::parse(
                Source::from_bytes(src.as_bytes()),
                None,
                &mut Context::default(),
            )
            .is_ok()
            {
                let (records, skips) = assert_round_trips(&src);
                eprintln!("{}: {records} records, {skips} skipped", path.display());
                n += 1;
            }
        }
    }
    eprintln!("corpus: {n} scripts round-tripped");
}

#[test]
fn a_body_that_comes_back_different_never_runs() {
    let store = Rc::new(MemStore::default());
    boa_engine::ks_set_code_store(Some(store.clone() as Rc<dyn CodeStore>));
    let mut ctx = Context::default();
    eval(
        &mut ctx,
        "function later(a) { const b = [a, a * 2]; return b.join('-'); }",
    );
    boa_engine::ks_swap_at_idle();
    store.corrupt.set(true);
    let failures = stat("storeFailures");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ctx.eval(Source::from_bytes("later(2)"));
    }));
    assert!(
        result.is_err(),
        "a corrupt record panics instead of running"
    );
    assert!(stat("storeFailures") > failures);
    store.corrupt.set(false);
    boa_engine::ks_set_code_store(None);
}
