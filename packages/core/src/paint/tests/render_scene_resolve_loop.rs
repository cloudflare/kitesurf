// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const PAGE: &str = r##"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; }
  .d { width: 60px; height: 60px; }
  .on .d {
    background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=);
    background-size: cover;
  }
</style></head><body><div class="d"></div></body></html>"##;

#[test]
fn newly_cascaded_background_lands_in_one_render_scene() {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(200, 200);
    dom.resolve_layout();

    let before = dom.debug_dump_background_images();
    assert!(
        !before.contains("Some"),
        "fixture is broken: the image is already loaded before the class \
         swap, so this test cannot detect the regression: {before}"
    );

    let body = dom.query_selector("body").unwrap_or(-1);
    assert!(body > 0, "body must exist");
    dom.set_attribute(body as u32, "class", "on");

    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    assert!(!scene.is_empty(), "scene should not be empty");

    let after = dom.debug_dump_background_images();
    assert!(
        after.contains("Some"),
        "background image not applied by the first render_scene after the \
         cascade started using it: {after}"
    );
}

#[test]
fn stalled_pending_image_does_not_force_a_cascade_every_frame() {
    const RADAR: &str = include_str!("../../../tests_data/radar-page.html");
    let dom = DomHandle::new(RADAR, "https://radar.cloudflare.com/");
    dom.set_viewport(1436, 900);
    dom.resolve_layout();
    let _ = dom.render_scene(0, 0, 0, 0, false, true);

    let pending = dom.doc.borrow().as_ref().pending_images_count();
    assert!(
        pending > 0,
        "fixture no longer leaves an image pending, so this test cannot \
         detect the regression"
    );

    for i in 0..4 {
        let _ = dom.render_scene(0, 0, 0, 0, false, true);
        assert!(
            !dom.layout_dirty.get(),
            "frame {i} left layout dirty, so the next one re-cascades"
        );
    }
}
