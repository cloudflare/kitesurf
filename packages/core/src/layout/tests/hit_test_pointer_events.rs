// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const OVERLAY_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; height: 600px; position: relative; }
button.target {
  position: absolute; top: 100px; left: 100px;
  width: 120px; height: 40px;
}
.scrim {
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 9999;
}
</style></head>
<body>
<button class="target">Click me</button>
<div class="scrim"></div>
</body></html>"##;

#[test]
fn pointer_events_none_overlay_is_transparent_to_hit_test() {
    let dom = DomHandle::new(OVERLAY_HTML, "https://test.example/");
    dom.resolve_layout();

    let btn_id = dom.query_selector("button.target").expect("query parses");
    assert!(btn_id > 0, "button.target must exist");
    let btn_id = btn_id as u32;

    let scrim_id = dom.query_selector("div.scrim").expect("query parses");
    assert!(scrim_id > 0, "div.scrim must exist");
    let scrim_id = scrim_id as u32;

    let hit = dom.element_from_point(160.0, 120.0);
    eprintln!(
        "hit-test (160,120) → node #{} (button=#{}, scrim=#{})",
        hit, btn_id, scrim_id
    );

    let walk_to = |target: u32| -> bool {
        if hit < 0 {
            return false;
        }
        let mut cur = hit as u32;
        for _ in 0..16 {
            if cur == target {
                return true;
            }
            match dom.parent_id(cur) {
                p if p < 0 => return false,
                p => cur = p as u32,
            }
        }
        false
    };

    assert!(
        walk_to(btn_id) && !walk_to(scrim_id),
        "expected click under a pointer-events:none scrim to reach button #{}; \
         resolved to node #{} (hits_button={}, hits_scrim={})",
        btn_id,
        hit,
        walk_to(btn_id),
        walk_to(scrim_id),
    );
}

const REENABLE_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; height: 600px; }
.wrap {
  position: fixed; inset: 0;
  pointer-events: none;
}
.hotspot {
  position: absolute; top: 50px; left: 50px;
  width: 100px; height: 100px;
  pointer-events: auto;
}
</style></head>
<body>
<div class="wrap"><div class="hotspot"></div></div>
</body></html>"##;

#[test]
fn pointer_events_auto_descendant_still_hits() {
    let dom = DomHandle::new(REENABLE_HTML, "https://test.example/");
    dom.resolve_layout();

    let hotspot_id = dom.query_selector("div.hotspot").expect("query parses");
    assert!(hotspot_id > 0, "div.hotspot must exist");
    let hotspot_id = hotspot_id as u32;

    let hit = dom.element_from_point(100.0, 100.0);
    eprintln!(
        "hit-test (100,100) → node #{} (hotspot=#{})",
        hit, hotspot_id
    );
    assert_eq!(
        hit, hotspot_id as i32,
        "pointer-events:auto descendant must win inside a pointer-events:none ancestor"
    );
}

#[test]
fn pointer_events_all_restores_hits_under_an_inherited_none() {
    for value in ["all", "visiblePainted", "auto"] {
        let html = format!(
            r#"<!DOCTYPE html><body style="margin:0">
              <div style="position:relative;width:400px;height:300px">
                <div id="under" style="position:absolute;inset:0"></div>
                <div style="position:relative;height:100%;z-index:300;pointer-events:none">
                  <button id="btn" style="position:absolute;left:10px;top:10px;width:40px;height:40px;pointer-events:{value}"></button>
                </div>
              </div>"#
        );
        let dom = DomHandle::new(&html, "https://test.example/");
        dom.set_viewport(800, 600);
        dom.resolve_layout();
        let btn = dom.query_selector("#btn").unwrap();
        let mut cur = dom.element_from_point(30.0, 30.0);
        while cur > 0 && cur != btn {
            cur = dom.parent_id(cur as u32);
        }
        assert_eq!(cur, btn, "pointer-events:{value} did not take the hit back");
    }
}
