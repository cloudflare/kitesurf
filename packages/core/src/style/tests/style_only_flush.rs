// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A single computed-value read restyles without layout; the next geometry read lays out.

#![cfg(test)]

use crate::DomHandle;

const PLAIN_BOX: &str =
    r#"<!DOCTYPE html><body style="margin:0"><div id="t" style="width:100px;height:10px"></div>"#;

/// The node id of `selector`, which every fixture here contains.
fn element(dom: &DomHandle, selector: &str) -> u32 {
    let id = crate::test_support::query_selector_id(dom, selector);
    assert!(id > 0, "{selector} must match an element");
    id
}

fn laid_out(html: &str) -> (DomHandle, u32) {
    // Container queries are behind a stylo pref; production sets it in `start()`.
    crate::style::cssom::init_style_prefs();
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let t = element(&dom, "#t");
    (dom, t)
}

#[test]
fn computed_value_read_restyles_without_layout() {
    let (dom, t) = laid_out(PLAIN_BOX);
    let epoch = dom.layout_epoch();
    let counts = dom.resolve_counts();

    assert!(dom.set_attribute(t, "style", "width:300px;height:10px;color:rgb(1, 2, 3)"));
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(1, 2, 3)")
    );
    assert_eq!(
        dom.layout_epoch(),
        epoch,
        "a computed-value read must not lay out"
    );
    assert_eq!(dom.resolve_counts(), counts);
    assert!(!dom.layout_clean());
}

#[test]
fn a_mutation_after_a_style_only_flush_restyles_again() {
    let (dom, t) = laid_out(PLAIN_BOX);
    assert!(dom.set_attribute(t, "style", "width:300px;height:10px;color:rgb(1, 2, 3)"));
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(1, 2, 3)")
    );

    assert!(dom.set_attribute(t, "style", "width:300px;height:10px;color:rgb(4, 5, 6)"));
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(4, 5, 6)"),
        "a mutation after a style-only flush must restyle again"
    );
}

#[test]
fn layout_consumes_the_damage_a_style_only_flush_left() {
    let (dom, t) = laid_out(PLAIN_BOX);
    assert!(dom.set_attribute(t, "style", "width:300px;height:10px;color:rgb(1, 2, 3)"));
    dom.computed_style_value(t, "color");

    let (_, _, width, _) = dom.test_bounding_rect(t);
    assert_eq!(
        width, 300.0,
        "layout must consume the damage the style-only flush left"
    );
    assert!(dom.layout_clean());
}

#[test]
fn animating_reads_share_one_style_pass_per_clock_sample() {
    let (dom, t) = laid_out(
        r#"<!DOCTYPE html><style>@keyframes s { to { opacity: 0 } }
#t { animation: s 10s infinite }</style><div id="t"></div>"#,
    );
    assert!(dom.is_animating());
    assert!(dom.set_attribute(t, "class", "x"));
    dom.computed_style_value(t, "color");
    // Workerd freezes the animation clock for a synchronous turn; pin the sample like it does.
    dom.last_resolve_now.set(f64::INFINITY);
    let passes = dom.style_passes.get();
    for _ in 0..10 {
        dom.computed_style_value(t, "color");
    }
    assert_eq!(dom.style_passes.get(), passes);
}

#[test]
fn container_query_read_lays_out_first() {
    let (dom, t) = laid_out(
        r#"<!DOCTYPE html><style>
#c { container-type: inline-size; width: 500px }
#t { color: rgb(255, 0, 0) }
@container (min-width: 400px) { #t { color: rgb(0, 128, 0) } }
</style><body style="margin:0"><div id="c"><div id="t">x</div></div>"#,
    );
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(0, 128, 0)")
    );

    let c = element(&dom, "#c");
    assert!(dom.set_attribute(c, "style", "width: 300px"));
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(255, 0, 0)"),
        "@container rules read laid-out sizes, so the read must lay out"
    );
    assert!(dom.layout_clean());
}

#[test]
fn element_that_becomes_a_container_lays_out_on_read() {
    let (dom, t) = laid_out(
        r#"<!DOCTYPE html><style>
.q { container-type: inline-size }
#c { width: 300px }
#t { color: rgb(255, 0, 0) }
@container (max-width: 400px) { #t { color: rgb(0, 128, 0) } }
</style><body style="margin:0"><div id="c"><div id="t">x</div></div>"#,
    );
    assert_eq!(
        dom.computed_style_value(t, "color").as_deref(),
        Some("rgb(255, 0, 0)")
    );

    let c = element(&dom, "#c");
    assert!(dom.set_attribute(c, "style", "width: 350px"));
    dom.computed_style_value(t, "color");
    assert!(
        !dom.layout_clean(),
        "no container yet, so the read skipped layout"
    );

    // Turning #c into a container is a restyle; the next read must take the full path.
    // (A full resolve does not yet re-cascade against a container a restyle created.)
    assert!(dom.set_attribute(c, "class", "q"));
    dom.computed_style_value(t, "color");
    assert!(dom.layout_clean());
}
