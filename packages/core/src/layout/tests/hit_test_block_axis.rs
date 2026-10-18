// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; font: 16px/20px monospace; }
.gap { height: 5000px; }
#far { position: relative; }
#far .hoist { position: absolute; top: -5100px; width: 4px; height: 4px; }
</style></head>
<body>
<p id="top">top text here top text here</p>
<div class="gap"></div>
<div id="far"><span class="hoist"></span><a id="fartext" href="#">far text far text far text</a></div>
</body></html>"##;

#[test]
fn text_far_below_the_point_is_not_hit() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();

    let top_id = dom.query_selector("#top").expect("query parses");
    assert!(top_id > 0, "#top must exist");
    let far_id = dom.query_selector("#fartext").expect("query parses");
    assert!(far_id > 0, "#fartext must exist");

    let walk_to = |hit: i32, target: i32| -> bool {
        if hit < 0 {
            return false;
        }
        let mut cur = hit as u32;
        for _ in 0..16 {
            if cur as i32 == target {
                return true;
            }
            match dom.parent_id(cur) {
                p if p < 0 => return false,
                p => cur = p as u32,
            }
        }
        false
    };

    for x in [5.0_f32, 50.0, 150.0] {
        let hit = dom.element_from_point(x, 10.0);
        eprintln!("hit-test ({x},10) → node #{hit} (top=#{top_id}, fartext=#{far_id})");
        assert!(
            walk_to(hit, top_id),
            "({x},10) must resolve into #top, got #{hit}",
        );
        assert!(
            !walk_to(hit, far_id),
            "({x},10) resolved into #fartext, 5000px below the point",
        );
    }

    let far_y = 20.0 + 5000.0 + 10.0;
    let hit = dom.element_from_point(50.0, far_y);
    assert!(
        walk_to(hit, far_id),
        "(50,{far_y}) must resolve into #fartext, got #{hit}",
    );
}
