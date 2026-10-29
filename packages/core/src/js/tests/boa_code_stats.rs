// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The vendored code counters (boa_engine ks_code_stats) must follow a script through
//! compile, first run and drop, since swap decisions will be made on what they report.

#![cfg(test)]

use std::collections::HashMap;

use boa_engine::{Context, Script, Source};

const SRC: &str = "function a(x) { return x.p + 1; }\n\
                   function b() { return 2; }\n\
                   function c() { return 3; }\n\
                   a({ p: 1 });";

fn stats() -> HashMap<&'static str, i64> {
    boa_engine::ks_code_stats().into_iter().collect()
}

fn delta(from: &HashMap<&'static str, i64>, to: &HashMap<&'static str, i64>, key: &str) -> i64 {
    to[key] - from[key]
}

#[test]
fn code_is_counted_by_form_and_refunded_on_drop() {
    let base = stats();
    let mut ctx = Context::default();
    let fresh = stats();

    let script = Script::parse(Source::from_bytes(SRC), None, &mut ctx).expect("parse");
    script.codeblock(&mut ctx).expect("compile");
    let compiled = stats();
    // <main> plus a, b and c, and all four are still packed: compiling runs nothing, and
    // the one source text is the script's, one Latin-1 byte per character.
    assert_eq!(delta(&fresh, &compiled, "blocks"), 4);
    assert_eq!(delta(&fresh, &compiled, "blocksRun"), 0);
    assert_eq!(delta(&fresh, &compiled, "sourceTexts"), 1);
    assert_eq!(
        delta(&fresh, &compiled, "sourceBytes"),
        SRC.len() as i64,
        "Latin-1, one byte each"
    );
    assert!(delta(&fresh, &compiled, "packedBytes") > 0);
    assert_eq!(delta(&fresh, &compiled, "expandedBytes"), 0);
    assert_eq!(delta(&fresh, &compiled, "icBytes"), 0);
    assert!(delta(&fresh, &compiled, "sourceMapBytes") > 0);
    assert!(delta(&fresh, &compiled, "otherBytes") > 0);

    script.evaluate(&mut ctx).expect("run");
    let ran = stats();
    // <main> and a ran, so their bytecode expanded and a's `x.p` built its inline cache;
    // b and c never ran and stay packed.
    assert_eq!(delta(&fresh, &ran, "blocksRun"), 2);
    assert!(delta(&fresh, &ran, "expandedBytes") > 0);
    assert!(delta(&compiled, &ran, "packedBytes") < 0);
    assert!(delta(&fresh, &ran, "icBytes") > 0);

    drop(script);
    drop(ctx);
    boa_engine::gc::force_collect();
    let end = stats();
    for (key, value) in &base {
        assert_eq!(
            end[key], *value,
            "{key} must be refunded once everything drops"
        );
    }
}
