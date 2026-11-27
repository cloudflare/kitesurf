// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

// The isolated wrapper keeps `#ab` in `#host`: with no layer root between `#host` and `#cb`,
// the box would paint from `#cb` instead, among the positioned boxes lifted there.
const PAGE: &str = r#"<!DOCTYPE html>
<html><body style="margin:0">
<div id="cb" style="position:relative; width:400px; height:300px">
  <div style="isolation:isolate">
  <div id="host">
    <div id="ab" style="position:absolute; top:10px; left:10px; right:10px; bottom:10px"></div>
  </div>
  </div>
</div>
<div id="filler">text</div>
</body></html>"#;

fn setup(page: &str) -> DomHandle {
    let dom = DomHandle::new(page, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    dom
}

fn reach(dom: &DomHandle, sel: &str) -> Option<(f32, f32, f32, f32)> {
    let id = dom.query_selector(sel).unwrap() as u32;
    dom.test_rehomed_reach(id)
}

#[test]
fn rehomed_host_gets_reach() {
    let dom = setup(PAGE);
    let r = reach(&dom, "#host").expect("host must have rehomed reach");
    assert!(
        r.2 - r.0 > 300.0 && r.3 - r.1 > 200.0,
        "reach must cover the inset abspos box, got {r:?}"
    );
}

#[test]
fn reach_survives_resolves_that_skip_the_host() {
    let dom = setup(PAGE);
    let before = reach(&dom, "#host").expect("baseline reach");
    let filler = dom.query_selector("#filler").unwrap() as u32;
    for i in 0..3 {
        dom.set_attribute(filler, "style", &format!("color:#{i}0{i}0{i}0"));
        dom.resolve_layout();
        assert_eq!(
            reach(&dom, "#host"),
            Some(before),
            "reach lost on resolve {i} that did not touch the host"
        );
    }
}

#[test]
fn reach_clears_when_the_box_stops_being_rehomed() {
    let dom = setup(PAGE);
    assert!(reach(&dom, "#host").is_some(), "baseline reach");

    let ab = dom.query_selector("#ab").unwrap() as u32;
    dom.set_attribute(ab, "style", "position:static");
    dom.resolve_layout();

    assert_eq!(
        reach(&dom, "#host"),
        None,
        "stale reach left behind after the box stopped being re-homed"
    );
}

// Without a layer root between `#host` and `#cb`, `#ab` is lifted to `#cb` instead of re-homed
// in `#host`. Toggling the wrapper's isolation must move the box between the two across
// incremental resolves, and leave no re-homed bookkeeping behind once it is lifted.
#[test]
fn lifting_and_rehoming_follow_the_layer_root_across_resolves() {
    let dom = setup(PAGE);
    let host = dom.query_selector("#host").unwrap() as u32;
    let ab = dom.query_selector("#ab").unwrap() as u32;
    let wrapper = dom.query_selector("#cb > div").unwrap() as u32;
    assert_eq!(dom.test_rehomed_paint_children(host), vec![ab], "baseline");

    for round in 0..2 {
        dom.set_attribute(wrapper, "style", "");
        dom.resolve_layout();
        assert!(
            dom.test_rehomed_paint_children(host).is_empty(),
            "round {round}: lifted box still re-homed in the host"
        );
        assert_eq!(reach(&dom, "#host"), None, "round {round}: stale reach");

        dom.set_attribute(wrapper, "style", "isolation:isolate");
        dom.resolve_layout();
        assert_eq!(
            dom.test_rehomed_paint_children(host),
            vec![ab],
            "round {round}: box not re-homed once the wrapper isolates again"
        );
        assert!(
            reach(&dom, "#host").is_some(),
            "round {round}: reach missing"
        );
    }
}
