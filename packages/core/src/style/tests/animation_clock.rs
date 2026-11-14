// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use ::style::properties::LonghandId;

use crate::style::transitions::{occurrence_ordinals, AnimationEvent, TransitionEvent};
use crate::DomHandle;

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

fn rgb(value: &str) -> (u32, u32, u32) {
    let inner = value
        .trim_start_matches("rgb(")
        .trim_end_matches(')')
        .to_string();
    let parts: Vec<u32> = inner
        .split(',')
        .map(|p| p.trim().parse().expect("channel is an integer"))
        .collect();
    assert_eq!(parts.len(), 3, "expected rgb() triple, got {value:?}");
    (parts[0], parts[1], parts[2])
}

fn drain_events(dom: &DomHandle) -> Vec<TransitionEvent> {
    let mut events = dom.transition_events.borrow_mut();
    std::mem::take(&mut *events)
}

fn drain_animation_events(dom: &DomHandle) -> Vec<AnimationEvent> {
    let mut events = dom.animation_events.borrow_mut();
    std::mem::take(&mut *events)
}

fn kinds(events: &[TransitionEvent]) -> Vec<&'static str> {
    events.iter().map(|e| e.kind).collect()
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

const DURATION_S: f64 = 1.0;

fn transitioning_dom() -> (DomHandle, u32) {
    let html = r##"<!DOCTYPE html>
<html><head><style>
#t {
  background-color: rgb(255, 0, 0);
  transition: background-color 1s linear;
}
</style></head>
<body><div id="t">x</div></body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok");
    assert!(id >= 0, "#t found");
    (dom, id as u32)
}

#[test]
fn transition_interpolates_between_endpoints() {
    let (dom, id) = transitioning_dom();
    assert_eq!(
        computed(&dom, id, LonghandId::BackgroundColor),
        "rgb(255, 0, 0)",
        "initial cascade sees the author red"
    );

    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::BackgroundColor),
        "rgb(255, 0, 0)",
        "a just-started transition still reads its start value"
    );
    assert!(dom.is_animating(), "the transition registered as animating");

    sleep_ms(300);
    dom.resolve_layout();
    let (r, g, b) = rgb(&computed(&dom, id, LonghandId::BackgroundColor));
    assert_eq!(g, 0, "green stays 0 across a red -> blue ramp");
    assert!(
        r > 0 && r < 255 && b > 0 && b < 255,
        "mid-flight sample must be between the endpoints, got rgb({r}, {g}, {b})"
    );

    sleep_ms(300);
    dom.resolve_layout();
    let (r2, _, b2) = rgb(&computed(&dom, id, LonghandId::BackgroundColor));
    assert!(
        r2 < r && b2 > b,
        "the ramp must advance: rgb({r}, _, {b}) -> rgb({r2}, _, {b2})"
    );
}

#[test]
fn transition_settles_to_end_value_and_stops_animating() {
    let (dom, id) = transitioning_dom();
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();

    sleep_ms(((DURATION_S * 1000.0) as u64) + 400);
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::BackgroundColor),
        "rgb(0, 0, 255)",
        "transition must settle to its end value; the frozen-clock bug \
         kept the start value at the Transitions cascade level forever"
    );
    assert!(
        !dom.is_animating(),
        "a finished transition must stop requesting ticks — otherwise \
         the screencast idle gate never closes again"
    );
}

#[test]
fn transition_emits_run_start_end_in_order() {
    let (dom, id) = transitioning_dom();
    drain_events(&dom);

    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();

    let started = drain_events(&dom);
    assert_eq!(
        kinds(&started),
        vec!["transitionrun", "transitionstart"],
        "a 1s transition must not report finishing on the frame it started"
    );
    assert!(started
        .iter()
        .all(|e| e.property_name == "background-color"));
    assert!(started.iter().all(|e| e.node_id == id));
    assert!(started.iter().all(|e| e.elapsed_time == 0.0));

    sleep_ms(300);
    dom.resolve_layout();
    assert!(
        drain_events(&dom).is_empty(),
        "no events while merely interpolating"
    );

    sleep_ms(((DURATION_S * 1000.0) as u64) + 400);
    dom.resolve_layout();
    let ended = drain_events(&dom);
    assert_eq!(kinds(&ended), vec!["transitionend"]);
    assert_eq!(ended[0].node_id, id);
    assert_eq!(ended[0].property_name, "background-color");
    assert_eq!(
        ended[0].elapsed_time, DURATION_S,
        "elapsedTime is the interpolating time, excluding any delay"
    );
}

#[test]
fn retargeting_mid_flight_cancels_and_restarts() {
    let (dom, id) = transitioning_dom();
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();
    drain_events(&dom);

    sleep_ms(300);
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 255, 0)"));
    dom.resolve_layout();

    let events = drain_events(&dom);
    assert_eq!(
        kinds(&events),
        vec!["transitioncancel", "transitionrun", "transitionstart"],
        "retarget must cancel the in-flight run before starting the new one"
    );
    let cancelled = &events[0];
    assert!(
        cancelled.elapsed_time > 0.0 && cancelled.elapsed_time < DURATION_S,
        "transitioncancel carries the active time so far, got {}",
        cancelled.elapsed_time
    );
}

#[test]
fn retargeting_after_the_end_reports_a_finish_not_a_cancel() {
    let (dom, id) = transitioning_dom();
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();
    drain_events(&dom);

    sleep_ms(((DURATION_S * 1000.0) as u64) + 200);
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 255, 0)"));
    dom.resolve_layout();

    let events = drain_events(&dom);
    assert_eq!(
        kinds(&events),
        vec!["transitionend", "transitionrun", "transitionstart"],
        "the displaced run had passed its end, so it owes transitionend"
    );
    assert_eq!(
        events[0].elapsed_time, DURATION_S,
        "transitionend carries the full interpolating time"
    );
}

#[test]
fn removing_the_element_cancels_its_transition() {
    let (dom, id) = transitioning_dom();
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();
    drain_events(&dom);
    assert!(dom.is_animating());

    sleep_ms(200);
    assert!(dom.remove_node(id), "node removed");
    dom.resolve_layout();

    assert_eq!(kinds(&drain_events(&dom)), vec!["transitioncancel"]);
    assert!(
        !dom.is_animating(),
        "a removed element's transition must stop requesting ticks"
    );
}

#[test]
fn transition_events_mint_handle_for_internal_inner_html_descendant() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
#host > span {
  background-color: rgb(255, 0, 0);
  transition: background-color 1s linear;
}
#host.active > span { background-color: rgb(0, 0, 255); }
</style></head><body><div id="host"><i></i><b></b><u></u></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let host = dom.query_selector("#host").expect("query ok") as u32;
    let stale_children: Vec<_> = {
        let doc = dom.doc.borrow();
        let handles = dom.node_handles.borrow();
        let host_internal = dom.resolve_node_id(host).expect("mapped host");
        doc.get_node(host_internal)
            .expect("live host")
            .children
            .iter()
            .map(|id| {
                (
                    *id,
                    handles.existing_external(*id).expect("seeded child mapped"),
                )
            })
            .collect()
    };
    for &(_, child) in &stale_children {
        assert!(dom.drop_node(child), "old child dropped explicitly");
    }

    let ops = format!(r#"[{{"kind":"setInnerHtml","node":{host},"html":"<span>new</span>"}}]"#);
    assert_eq!(dom.apply_ops(&ops).expect("innerHTML applied"), 1);
    dom.resolve_layout();
    drain_events(&dom);

    let new_internal = {
        let doc = dom.doc.borrow();
        let host_internal = dom.resolve_node_id(host).expect("mapped host");
        doc.get_node(host_internal).expect("live host").children[0]
    };
    let (stale_internal, stale_child) = stale_children
        .into_iter()
        .find(|(id, _)| id.as_u64() as u32 == new_internal.as_u64() as u32)
        .expect("setInnerHtml should reuse an explicitly dropped child slot");
    assert_ne!(stale_internal, new_internal);
    assert!(
        dom.node_handles
            .borrow()
            .existing_external(new_internal)
            .is_none(),
        "the internally parsed child must not already have an external handle"
    );

    assert!(dom.set_attribute(host, "class", "active"));
    dom.resolve_layout();
    let events = drain_events(&dom);
    assert_eq!(kinds(&events), vec!["transitionrun", "transitionstart"]);
    let target = events[0].node_id;
    assert!(events.iter().all(|event| event.node_id == target));
    assert_ne!(target, stale_child, "the reused slot needs a new handle");
    assert_eq!(dom.resolve_node_id(target), Some(new_internal));
    assert_eq!(dom.parent_id(target), host as i32);
    assert_eq!(dom.parent_id(stale_child), -1);
}

#[test]
fn opaque_node_of_a_reused_slot_resolves_to_its_current_id() {
    let dom = DomHandle::new(
        "<!DOCTYPE html><body><div id=host><i></i><b></b></div></body>",
        "https://test.example/",
    );
    dom.resolve_layout();
    let host = dom.query_selector("#host").expect("query ok") as u32;
    for old in dom.child_ids(host) {
        assert!(dom.drop_node(old), "old child dropped explicitly");
    }
    let ops = format!(r#"[{{"kind":"setInnerHtml","node":{host},"html":"<span>new</span>"}}]"#);
    assert_eq!(dom.apply_ops(&ops).expect("innerHTML applied"), 1);

    let doc = dom.doc.borrow();
    let host_internal = dom.resolve_node_id(host).expect("mapped host");
    let span = doc.get_node(host_internal).expect("live host").children[0];
    assert_ne!(span.as_u64() >> 32, 1, "the span must sit in a reused slot");
    let wasm32_opaque = span.as_u64() as u32 as usize;
    assert_eq!(doc.tree().id_from_opaque(wasm32_opaque), Some(span));
    assert_eq!(
        doc.tree().id_from_opaque(span.as_u64() as usize),
        Some(span)
    );
}

#[test]
fn a_static_page_never_reports_animating() {
    let html = r##"<!DOCTYPE html>
<html><body><div id="t" style="background-color: rgb(255, 0, 0)">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;

    assert!(!dom.is_animating());
    assert!(dom.set_attribute(id, "style", "background-color: rgb(0, 0, 255)"));
    dom.resolve_layout();

    assert_eq!(
        computed(&dom, id, LonghandId::BackgroundColor),
        "rgb(0, 0, 255)",
        "without a transition-property the write applies at once"
    );
    sleep_ms(50);
    assert!(!dom.is_animating());
    assert!(drain_events(&dom).is_empty());
}

#[test]
fn animation_emits_start_and_end_events() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
#t { opacity: 0; animation: 100ms linear 0s 1 normal both fade }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;
    let started = drain_animation_events(&dom);
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].node_id, id);
    assert_eq!(started[0].kind, "animationstart");
    assert_eq!(started[0].animation_name, "fade");

    sleep_ms(250);
    dom.resolve_layout();
    let ended = drain_animation_events(&dom);
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].node_id, id);
    assert_eq!(ended[0].kind, "animationend");
    assert!((ended[0].elapsed_time - 0.1).abs() < 1e-6);
}

#[test]
fn paused_animation_cancels_after_its_nominal_end() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
</style></head><body><div id="t" style="animation: 100ms linear 2 normal both fade">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;
    drain_animation_events(&dom);

    sleep_ms(20);
    assert!(dom.set_attribute(
        id,
        "style",
        "animation: 100ms linear 2 normal both paused fade",
    ));
    dom.resolve_layout();
    drain_animation_events(&dom);

    sleep_ms(250);
    assert!(dom.set_attribute(id, "style", "animation: none"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "animationcancel");
    assert!(events[0].elapsed_time > 0.0 && events[0].elapsed_time < 0.1);
}

#[test]
fn removing_an_earlier_animation_does_not_restart_the_next_one() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes pulse { from { width: 10px } to { width: 20px } }
#t { animation: 20ms linear fade, 1s linear infinite pulse }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    drain_animation_events(&dom);

    sleep_ms(50);
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events
            .iter()
            .map(|event| (event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![("animationend", "fade")],
    );
}

#[test]
fn updating_an_animation_does_not_restart_the_same_name() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
</style></head><body><div id="t" style="animation: 1s linear infinite pulse">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;
    drain_animation_events(&dom);

    assert!(dom.set_attribute(id, "style", "animation: 1s linear infinite paused pulse"));
    dom.resolve_layout();
    drain_animation_events(&dom);
    sleep_ms(30);
    assert!(dom.set_attribute(id, "style", "animation: 1s linear infinite running pulse"));
    dom.resolve_layout();
    assert!(drain_animation_events(&dom).is_empty());

    assert!(dom.set_attribute(id, "style", "animation: 2s linear infinite pulse"));
    dom.resolve_layout();
    assert!(drain_animation_events(&dom).is_empty());

    assert!(dom.set_attribute(
        id,
        "style",
        "animation: 2s linear infinite pulse, 2s linear infinite pulse"
    ));
    dom.resolve_layout();
    assert!(drain_animation_events(&dom).is_empty());
}

#[test]
fn animation_iterations_keep_the_same_run() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
#t { opacity: 0; animation: 200ms linear 0s 2 normal both fade }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    assert_eq!(
        drain_animation_events(&dom)
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        vec!["animationstart"],
    );

    sleep_ms(300);
    dom.resolve_layout();
    assert_eq!(
        drain_animation_events(&dom)
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        vec!["animationiteration"],
    );

    sleep_ms(300);
    dom.resolve_layout();
    assert_eq!(
        drain_animation_events(&dom)
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        vec!["animationend"],
    );
}

#[test]
fn infinite_animation_fires_one_iteration_event_per_sample() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
#t { animation: 1ms linear 0s infinite normal both fade }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    drain_animation_events(&dom);

    for expected_iteration in 1..=3u64 {
        sleep_ms(10);
        dom.resolve_layout();
        let events = drain_animation_events(&dom);
        assert_eq!(
            events.len(),
            1,
            "one event per sample (iteration {expected_iteration}), not a burst"
        );
        assert_eq!(events[0].kind, "animationiteration");
        assert!(
            (events[0].elapsed_time - expected_iteration as f64 * 0.001).abs() < 1e-6,
            "elapsedTime = current.iteration * duration, got {}",
            events[0].elapsed_time
        );
    }
}

#[test]
fn unrequested_animation_events_are_not_collected() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
#t { animation: 1ms linear 0s infinite normal both fade }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    drain_animation_events(&dom);

    sleep_ms(200);
    dom.resolve_layout();
    assert!(
        drain_animation_events(&dom).is_empty(),
        "no listener => no collected events"
    );

    dom.set_animation_events_requested(true);
    sleep_ms(200);
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert!(
        events
            .iter()
            .all(|event| event.kind == "animationiteration"),
        "listener registered mid-run must not receive historical lifecycle events, got {}",
        events
            .iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>()
            .join(",")
    );

    dom.set_animation_events_requested(false);
    sleep_ms(200);
    dom.resolve_layout();
    assert!(
        drain_animation_events(&dom).is_empty(),
        "turning the request off stops collection again"
    );

    dom.set_animation_events_requested(true);
    sleep_ms(200);
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert!(
        events
            .iter()
            .all(|event| event.kind == "animationiteration"),
        "re-enabling after a disable must not replay historical lifecycle events, got {}",
        events
            .iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>()
            .join(",")
    );
}

#[test]
fn removing_the_first_of_two_animations_keeps_the_survivor_running() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
#t { animation: 1s linear 0s 1 normal both fade, 1s linear 0s 1 normal both spin }
#t.only-spin { animation: 1s linear 0s 1 normal both spin }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;

    drain_animation_events(&dom);

    assert!(dom.set_attribute(id, "class", "only-spin"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        vec!["animationcancel"],
        "only the removed animation reports; the survivor keeps its identity"
    );
    assert_eq!(events[0].animation_name, "fade");
}

#[test]
fn inserting_an_animation_before_a_running_one_keeps_the_survivor_running() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
#t { animation: 1s linear 0s 1 normal both spin }
#t.also-fade { animation: 1s linear 0s 1 normal both fade, 1s linear 0s 1 normal both spin }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;
    drain_animation_events(&dom);

    assert!(dom.set_attribute(id, "class", "also-fade"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        vec!["animationstart"],
        "only the newcomer starts; the survivor keeps its identity"
    );
    assert_eq!(events[0].animation_name, "fade");
}

#[test]
fn occurrence_ordinals_count_from_the_right() {
    use stylo_atoms::Atom;
    let a = Atom::from("a");
    let b = Atom::from("b");

    assert_eq!(occurrence_ordinals([&a]), vec![0]);
    assert_eq!(occurrence_ordinals([&a, &a]), vec![1, 0]);
    assert_eq!(occurrence_ordinals([&a, &a, &a]), vec![2, 1, 0]);
    assert_eq!(occurrence_ordinals([&a, &b]), vec![0, 0]);
}

#[test]
fn simultaneous_animation_events_follow_composite_order() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes grow { from { transform: scale(0) } to { transform: scale(1) } }
#one { animation: 1s linear 0s 1 normal both fade, 1s linear 0s 1 normal both spin }
#two { animation: 1s linear 0s 1 normal both fade }
#two.grow { animation: 1s linear 0s 1 normal both grow, 1s linear 0s 1 normal both fade }
#one.only-fade { animation: 1s linear 0s 1 normal both fade }
#one.grow-fade { animation: 1s linear 0s 1 normal both grow, 1s linear 0s 1 normal both fade }
</style></head><body>
<div id="one">x</div><div id="two">y</div>
</body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let one = dom.query_selector("#one").expect("query ok") as u32;
    let two = dom.query_selector("#two").expect("query ok") as u32;

    let starts = drain_animation_events(&dom);
    assert_eq!(
        starts
            .iter()
            .map(|event| (event.node_id, event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (one, "animationstart", "fade"),
            (one, "animationstart", "spin"),
            (two, "animationstart", "fade"),
        ],
        "starts follow tree order, then animation-name position"
    );

    assert!(dom.set_attribute(one, "class", "only-fade"));
    assert!(dom.set_attribute(two, "class", "grow"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events
            .iter()
            .map(|event| (event.node_id, event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (one, "animationcancel", "spin"),
            (two, "animationstart", "grow"),
        ],
        "canceled and started events interleave in tree order"
    );
}

#[test]
fn canceled_animation_sorts_before_live_start_on_the_same_owner() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes grow { from { transform: scale(0) } to { transform: scale(1) } }
#t { animation: 1s linear 0s 1 normal both fade, 1s linear 0s 1 normal both spin }
#t.grow-fade { animation: 1s linear 0s 1 normal both grow, 1s linear 0s 1 normal both fade }
</style></head><body><div id="t">x</div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let id = dom.query_selector("#t").expect("query ok") as u32;
    drain_animation_events(&dom);

    assert!(dom.set_attribute(id, "class", "grow-fade"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events
            .iter()
            .map(|event| (event.node_id, event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (id, "animationcancel", "spin"),
            (id, "animationstart", "grow"),
        ],
        "canceled animation sorts before the live start on the same owner"
    );
}

#[test]
fn a_moved_owner_cancels_by_its_current_tree_order() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes grow { from { transform: scale(0) } to { transform: scale(1) } }
#one { animation: 1s linear 0s 1 normal both fade, 1s linear 0s 1 normal both spin }
#two { animation: 1s linear 0s 1 normal both grow }
#one.only-fade { animation: 1s linear 0s 1 normal both fade }
#two.stop { animation: none }
</style></head><body>
<div id="one">x</div><div id="two">y</div>
</body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let one = dom.query_selector("#one").expect("query ok") as u32;
    let two = dom.query_selector("#two").expect("query ok") as u32;
    let body = dom.query_selector("body").expect("query ok") as u32;
    drain_animation_events(&dom);

    assert!(dom.insert_before_node(body, two, one));
    assert!(dom.set_attribute(one, "class", "only-fade"));
    assert!(dom.set_attribute(two, "class", "stop"));
    dom.resolve_layout();
    let events = drain_animation_events(&dom);
    assert_eq!(
        events
            .iter()
            .map(|event| (event.node_id, event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (two, "animationcancel", "grow"),
            (one, "animationcancel", "spin"),
        ],
        "a moved owner's cancel sorts by its current tree order"
    );
}

#[test]
fn shadow_animation_events_follow_flat_tree_order() {
    let html = r##"<!DOCTYPE html>
<html><body><div id="host"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    dom.resolve_layout();
    let host = dom.query_selector("#host").expect("query ok") as u32;
    let root = dom.attach_shadow(host, "open") as u32;

    let style = dom.create_element("style");
    let css = dom.create_text_node(
        "@keyframes fade { from { opacity: 0 } to { opacity: 1 } }\
         @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }",
    );
    assert!(dom.append_child_node(style, css));
    assert!(dom.append_child_node(root, style));

    let first = dom.create_element("div");
    let second = dom.create_element("div");
    assert!(dom.set_attribute(first, "style", "animation: 1s linear 0s 1 normal both fade"));
    assert!(dom.set_attribute(
        second,
        "style",
        "animation: 1s linear 0s 1 normal both spin"
    ));
    assert!(dom.append_child_node(root, first));
    assert!(dom.append_child_node(root, second));
    dom.resolve_layout();

    let starts = drain_animation_events(&dom);
    assert_eq!(
        starts
            .iter()
            .map(|event| (event.node_id, event.kind, event.animation_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (first, "animationstart", "fade"),
            (second, "animationstart", "spin"),
        ],
        "shadow siblings' events follow flat-tree order"
    );
}

#[test]
fn reused_node_slot_does_not_keep_animation_identity() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
</style></head><body><div id="old"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_animation_events_requested(true);
    let old = dom.query_selector("#old").expect("query ok") as u32;
    assert!(dom.set_attribute(old, "style", "animation: 1s linear infinite fade"));
    dom.resolve_layout();
    drain_animation_events(&dom);

    assert!(dom.remove_node(old));
    let replacement = dom.create_element("div");
    let body = dom.query_selector("body").expect("query ok") as u32;
    assert!(dom.set_attribute(replacement, "style", "animation: 1s linear infinite fade"));
    assert!(dom.append_child_node(body, replacement));
    dom.resolve_layout();

    let events = drain_animation_events(&dom);
    assert!(events
        .iter()
        .any(|event| { event.node_id == old && event.kind == "animationcancel" }));
    assert!(events
        .iter()
        .any(|event| { event.node_id == replacement && event.kind == "animationstart" }));
}

#[test]
fn listener_registration_refreshes_cancellation_tree_order() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
</style></head><body></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let body = dom.query_selector("body").expect("query ok") as u32;

    let a = dom.create_element("div");
    let b = dom.create_element("div");
    assert!(dom.set_attribute(
        a,
        "style",
        "animation: 1s linear 0s infinite normal both fade"
    ));
    assert!(dom.set_attribute(
        b,
        "style",
        "animation: 1s linear 0s infinite normal both fade"
    ));
    assert!(dom.append_child_node(body, a));
    assert!(dom.insert_before_node(body, b, a));

    dom.resolve_layout();
    drain_animation_events(&dom);

    dom.set_animation_events_requested(true);

    assert!(dom.remove_node(a));
    assert!(dom.remove_node(b));
    dom.resolve_layout();

    let events = drain_animation_events(&dom);
    assert_eq!(events.len(), 2, "one cancel per removed owner");
    assert!(
        events.iter().all(|event| event.kind == "animationcancel"),
        "removed owners cancel, got {:?}",
        events.iter().map(|e| e.kind).collect::<Vec<_>>()
    );
    assert_eq!(
        events.iter().map(|e| e.node_id).collect::<Vec<_>>(),
        vec![b, a],
        "cancels follow CSS tree order (B before A), not creation order"
    );
}
