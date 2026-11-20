// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use std::time::Duration;

use ::style::properties::LonghandId;

use crate::DomHandle;

const DURATION_MS: u64 = 100;

fn computed(dom: &DomHandle, node_id: u32, longhand: LonghandId) -> String {
    let doc = dom.doc.borrow();
    let node = doc
        .get_node(crate::blitz_node_id(node_id))
        .expect("node exists");
    let styles = node.primary_styles().expect("node has primary styles");
    let mut out = String::new();
    styles
        .computed_or_resolved_value(longhand, None, &mut out)
        .expect("longhand serializes");
    out
}

fn resolve_again(dom: &DomHandle) {
    dom.layout_dirty.set(true);
    dom.resolve_layout();
}

fn fading_dom(fill_mode: &str) -> (DomHandle, u32, u32) {
    let html = format!(
        r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade {{ from {{ opacity: 0 }} to {{ opacity: 1 }} }}
#t {{ opacity: 0; animation: {DURATION_MS}ms linear 0s 1 normal {fill_mode} fade }}
</style></head>
<body><div id="t">x</div><div id="other">y</div></body></html>"##
    );

    let dom = DomHandle::new(&html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok");
    let other = dom.query_selector("#other").expect("query ok");
    assert!(id >= 0 && other >= 0, "#t and #other found");
    (dom, id as u32, other as u32)
}

fn settle(dom: &DomHandle, id: u32) {
    std::thread::sleep(Duration::from_millis(DURATION_MS + 250));
    resolve_again(dom);
    assert_eq!(
        computed(dom, id, LonghandId::Opacity),
        "1",
        "the resolve that finishes the animation must apply its last keyframe"
    );
}

#[test]
fn forwards_fill_survives_an_unrelated_restyle() {
    let (dom, id, other) = fading_dom("both");
    settle(&dom, id);

    assert!(dom.set_attribute(other, "style", "margin-left: 1px"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::Opacity),
        "1",
        "a settled forwards fill must survive someone else's restyle; \
         stylo used to retain the finished animation out of the set and \
         leave the element on its cascaded opacity: 0 forever"
    );
}

#[test]
fn forwards_fill_survives_a_restyle_of_the_element_itself() {
    let (dom, id, _) = fading_dom("forwards");
    settle(&dom, id);

    assert!(dom.set_attribute(id, "style", "margin-left: 1px"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::Opacity),
        "1",
        "recascading the element must pull the fill back out of its \
         animation set, not fall through to the author rule"
    );
}

#[test]
fn a_finished_animation_without_a_forwards_fill_stops_contributing() {
    let (dom, id, other) = fading_dom("backwards");
    std::thread::sleep(Duration::from_millis(DURATION_MS + 250));
    resolve_again(&dom);

    assert!(dom.set_attribute(other, "style", "margin-left: 1px"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::Opacity),
        "0",
        "fill-mode: backwards must not hold the end value after the run"
    );
}

#[test]
fn re_triggering_a_settled_animation_through_the_retained_entry_restarts_it() {
    let (dom, id, _) = fading_dom("both");
    settle(&dom, id);
    assert!(
        !dom.doc.borrow().is_animating(),
        "a settled fill must not need ticks"
    );

    assert!(dom.set_attribute(id, "style", "animation-duration: 5000ms"));
    dom.resolve_layout();

    assert!(
        dom.doc.borrow().is_animating(),
        "re-triggering through the retained entry must resume ticking"
    );
    let opacity: f32 = computed(&dom, id, LonghandId::Opacity)
        .parse()
        .expect("opacity is a number");
    assert!(
        opacity < 0.5,
        "the restarted run is only ~7% in, so opacity must fall back off the \
         filled 1, got {opacity}"
    );
}

#[test]
fn removing_the_animation_name_drops_the_retained_fill() {
    let (dom, id, _) = fading_dom("both");
    settle(&dom, id);

    assert!(dom.set_attribute(id, "style", "animation-name: none"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::Opacity),
        "0",
        "cancelling the animation must release the property; a fill that \
         cannot be cancelled would pin the element forever"
    );
}
