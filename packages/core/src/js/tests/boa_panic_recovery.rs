// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use boa_engine::{js_string, Context, JsValue, NativeFunction, Source};

const PANIC_DEEP: &str =
    "function a(){ return b(); } function b(){ return c(); } function c(){ return boom(); } a();";

fn panicking_context() -> Context {
    let mut ctx = Context::default();
    ctx.register_global_callable(
        js_string!("boom"),
        0,
        NativeFunction::from_fn_ptr(|_, _, _| panic!("simulated interpreter panic")),
    )
    .expect("register boom");
    ctx
}

fn eval_panicking(ctx: &mut Context) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ctx.eval(Source::from_bytes(PANIC_DEEP.as_bytes()));
    }));
    std::panic::set_hook(prev);
    assert!(r.is_err(), "boom() must panic, not throw");
}

#[test]
fn panic_unwind_strands_vm_state_that_the_reclaim_recovers() {
    let mut ctx = panicking_context();
    eval_panicking(&mut ctx);

    let (frames, stack) = ctx.ks_vm_stats();
    assert!(
        frames > 0 && stack > 0,
        "the unwind must strand frames+registers ({frames}, {stack}) — else this test is moot"
    );

    let cleared = ctx.ks_clear_residual_stack();
    assert_eq!(
        cleared, stack,
        "every stranded value-stack slot is reclaimed"
    );
    assert_eq!(
        ctx.ks_vm_stats(),
        (0, 0),
        "and every stranded frame with it"
    );

    let v = ctx
        .eval(Source::from_bytes(b"1 + 2"))
        .expect("context still usable");
    assert_eq!(v.as_number(), Some(3.0));
}

#[test]
fn repeated_panics_do_not_poison_the_context() {
    let mut ctx = panicking_context();
    for i in 0..1200 {
        eval_panicking(&mut ctx);
        ctx.ks_clear_residual_stack();
        let v = ctx
            .eval(Source::from_bytes(b"1 + 2"))
            .unwrap_or_else(|e| panic!("execution {i} after reclaim failed: {e}"));
        assert_eq!(v.as_number(), Some(3.0));
    }
    assert_eq!(ctx.ks_vm_stats(), (0, 0));
}

#[test]
fn reclaim_is_inert_while_an_execution_is_live() {
    let mut ctx = Context::default();
    ctx.register_global_callable(
        js_string!("healNow"),
        0,
        NativeFunction::from_fn_ptr(|_, _, ctx: &mut Context| {
            let cleared = ctx.ks_clear_residual_stack();
            assert_eq!(cleared, 0, "a live execution's stack is not residue");
            assert!(ctx.ks_vm_stats().0 > 0, "its frames must survive");
            Ok(JsValue::from(0))
        }),
    )
    .expect("register healNow");

    let v = ctx
        .eval(Source::from_bytes(
            b"function a(){ return b() + 1; } function b(){ return healNow() + 10; } a();",
        ))
        .expect("caller completes");
    assert_eq!(v.as_number(), Some(11.0));
    assert_eq!(ctx.ks_vm_stats(), (0, 0));
}
