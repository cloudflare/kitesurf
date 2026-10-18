// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const PAGE: &str = r#"<!doctype html>
<style>
  body { margin: 0; font: 16px serif; }
  .b { font-family: monospace; font-weight: 700; }
</style>
<p>the quick brown fox jumps</p>
<p class="b">over the lazy dog</p>
"#;

fn painted_once() -> DomHandle {
    let dom = DomHandle::new(PAGE, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom
}

fn cached_glyphs(dom: &DomHandle) -> usize {
    dom.rbi_glyph_cache.borrow().len()
}

fn frame(dom: &DomHandle) -> Vec<u8> {
    dom.render_scene(0, 0, 0, 0, false, true)
}

fn clean_cache_size() -> usize {
    let dom = painted_once();
    assert!(!frame(&dom).is_empty(), "baseline frame came back empty");
    let n = cached_glyphs(&dom);
    assert!(n > 0, "fixture extracted no glyph outlines at all");
    n
}

fn assert_recovers_from_panic_at(at: &'static str) {
    let clean = clean_cache_size();
    let dom = painted_once();

    crate::paint::scene_record::arm_test_paint_panic(at);
    assert!(
        frame(&dom).is_empty(),
        "injected panic at {at} never fired — render_scene returned a \
         frame, so this test is asserting nothing"
    );

    assert!(
        !frame(&dom).is_empty(),
        "the frame after the panic came back empty"
    );
    assert_eq!(
        cached_glyphs(&dom),
        clean,
        "a panic at {at} cost the session glyph outlines it can never \
         re-extract: {} cached vs {clean} on a clean run",
        cached_glyphs(&dom)
    );
}

#[test]
fn panic_before_extraction_leaves_no_glyph_marked() {
    assert_recovers_from_panic_at("before_record");
}

#[test]
fn panic_after_marking_still_banks_the_outlines() {
    assert_recovers_from_panic_at("after_mark");
}
