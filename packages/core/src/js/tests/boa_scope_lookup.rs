// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The compiler frees each compiled scope's name lookup map (boa_ast ks_drop_lookup), so a
//! direct eval that runs later has to rebuild it and resolve names exactly as before.

#![cfg(test)]

use boa_engine::{Context, Source};

fn number(ctx: &mut Context, src: &str) -> f64 {
    ctx.eval(Source::from_bytes(src.as_bytes()))
        .expect("eval")
        .as_number()
        .expect("a number")
}

#[test]
fn direct_eval_resolves_names_after_the_compiler_dropped_the_maps() {
    let mut ctx = Context::default();
    let decls: String = (0..2000).map(|i| format!("let v{i} = {i};")).collect();
    let src = format!(
        "function big() {{ {decls} return (n) => eval('v' + n); }}\n\
         globalThis.get = big();\n\
         get(1999) + get(7)"
    );
    assert_eq!(
        number(&mut ctx, &src),
        2006.0,
        "a flat 2000-name scope, read through eval"
    );
    assert_eq!(
        number(
            &mut ctx,
            "function g() { var x = 1; eval('var y = 41'); return eval('x + y'); } g()"
        ),
        42.0,
        "a sloppy eval declares into a compiled function scope, and a second eval sees it",
    );
    assert_eq!(
        number(
            &mut ctx,
            "function h() { let a = 2; { const b = 3; return eval('a * b'); } } h()"
        ),
        6.0,
    );
    assert_eq!(
        number(
            &mut ctx,
            "function k() { let c = 1; eval('c = 9'); return c; } k()"
        ),
        9.0,
        "an assignment through eval lands on the binding compiled code reads",
    );
}
