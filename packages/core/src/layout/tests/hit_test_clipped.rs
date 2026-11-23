// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

// Content clipped away by an ancestor's `overflow: hidden` is not hit-testable
// at its laid-out position: the point belongs to whatever is visible there.
// https://drafts.csswg.org/css-overflow-3/#overflow-clipping

use crate::DomHandle;

const PAGE: &str = r#"<html><head><style>
  body { margin: 0 }
  #panel { position: absolute; left: 0; top: 0; width: 100px; height: 100px; overflow: hidden }
  #clipped { position: absolute; left: 200px; top: 10px; width: 50px; height: 50px }
  #other { position: absolute; left: 200px; top: 10px; width: 50px; height: 50px }
</style></head><body>
  <div id="panel"><div id="clipped"></div></div>
  <div id="other"></div>
</body></html>"#;

#[test]
fn clipped_content_is_not_hit_where_it_would_have_been() {
    let dom = DomHandle::new(PAGE, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let other = dom.query_selector("#other").expect("#other") as u32;
    let clipped = dom.query_selector("#clipped").expect("#clipped") as u32;
    let hit = dom.element_from_point(210.0, 20.0).max(0) as u32;
    assert_ne!(
        hit, clipped,
        "the clipped box must not take the hit at its laid-out position"
    );
    assert_eq!(hit, other, "the visible box under the point takes the hit");
}

#[test]
fn a_clip_path_keeps_points_outside_it_unhittable() {
    let page = r#"<html><head><style>
      body { margin: 0 }
      #clipped { position: absolute; left: 0; top: 0; width: 100px; height: 100px;
                 clip-path: circle(10px at 10px 10px) }
      #under { position: absolute; left: 0; top: 0; width: 100px; height: 100px }
    </style></head><body>
      <div id="under"></div><div id="clipped"></div>
    </body></html>"#;
    let dom = DomHandle::new(page, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let under = dom.query_selector("#under").expect("#under") as u32;
    let clipped = dom.query_selector("#clipped").expect("#clipped") as u32;
    let hit = dom.element_from_point(80.0, 80.0).max(0) as u32;
    assert_ne!(
        hit, clipped,
        "a point outside the circle is not on the clip-path box"
    );
    assert_eq!(hit, under, "the box under the point takes the hit");
}
