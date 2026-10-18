// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const PAGE: &str = r##"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; }
  .outer { container-type: inline-size; width: 800px; }
  .inner { container-type: inline-size; width: 25%; }
  @container (width > 700px) { .inner { width: 75%; } }
  @container (width > 500px) {
    .leaf { background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=); }
  }
</style></head><body><div class="outer"><div class="inner"><div class="leaf">leaf</div></div></div></body></html>"##;

fn init() -> DomHandle {
    crate::style::cssom::init_style_prefs();
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 300);
    dom
}

#[test]
fn settle_cascade_background_reaches_slot_in_first_resolve() {
    let dom = init();
    dom.resolve_layout();

    let pending_style_images = dom.doc.borrow().as_ref().pending_style_image_count();
    assert_eq!(
        pending_style_images, 0,
        "style-image queue still holds {pending_style_images} node(s) after one \
         resolve — the settle loop did not flush it"
    );

    let report = dom.debug_dump_background_images();
    assert!(
        report.contains("Some"),
        "background slot empty after one resolve: {report}"
    );
}

#[test]
fn settle_cascade_background_paints_on_first_frame() {
    // Container queries are behind a stylo pref; production sets it in `start()`.
    crate::style::cssom::init_style_prefs();
    let png =
        crate::paint::screenshot::ks_render_html_to_png(PAGE, "https://test.example/", 800, 300);
    assert!(!png.is_empty(), "render produced no bytes");
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0u8; reader.output_buffer_size().expect("buf size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    let mut best: [u8; 3] = [0, 0, 0];
    let mut best_score = 0i32;
    for y in 4..15 {
        for x in 100..500 {
            let i = y * info.line_size + x * 4;
            let px = [buf[i], buf[i + 1], buf[i + 2]];
            let score = px[0] as i32 - (px[1] as i32 + px[2] as i32) / 2;
            if score > best_score {
                best_score = score;
                best = px;
            }
        }
    }
    eprintln!("leaf band best = {best:?} (score {best_score})");
    assert!(
        best[0] > 120 && best[1] < 100 && best[2] < 100,
        "leaf region is not red — the settle-cascaded background did not \
         paint on the first frame (best={best:?})"
    );
}
