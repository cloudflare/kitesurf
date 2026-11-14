#![cfg(test)]
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

#[test]
fn data_uri_background_reaches_image_slot() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
  .d { width: 60px; height: 60px;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=);
       background-size: cover; }
</style></head><body><div class="d"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_background_images();
    eprintln!("=== {}", report);
    assert!(
        report.contains("Some"),
        "data: background never loaded: {report}"
    );
}

#[test]
fn discover_pending_images_drains_data_uri_backgrounds() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
  .d { width: 60px; height: 60px;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=);
       background-size: cover; }
</style></head><body><div class="d"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let pending = dom.discover_pending_images();
    assert_eq!(
        pending, 0,
        "data: bg-image still pending after discovery — the JS drain would stall its full cap"
    );
}

#[test]
fn data_uri_background_paints() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; }
  .d { width: 60px; height: 60px;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=); }
  .e { width: 60px; height: 60px; background-size: cover;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=); }
</style></head><body><div class="d"></div><div class="e"></div></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 200, 200);
    assert!(!png.is_empty(), "render produced no bytes");
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0u8; reader.output_buffer_size().expect("buf size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    let stride = info.line_size;
    let px = &buf[30 * stride + 30 * 4..30 * stride + 30 * 4 + 3];
    let px2 = &buf[90 * stride + 30 * 4..90 * stride + 30 * 4 + 3];
    eprintln!(
        "plain bg pixel at 30,30 = {:?} | cover bg pixel at 30,90 = {:?}",
        px, px2
    );
    assert!(
        !(px[0] > 240 && px[1] > 240 && px[2] > 240),
        "div region is white — data: background did not paint (px={px:?})"
    );
}

#[test]
fn data_uri_bg_step_by_step() {
    use blitz_dom::DocumentConfig;
    use blitz_html::{HtmlDocument, HtmlProvider};
    use blitz_traits::shell::{ColorScheme, Viewport};
    use std::sync::Arc;
    let html = r##"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; }
  .d { width: 60px; height: 60px;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=);
       background-size: cover; }
</style></head><body><div class="d"></div></body></html>"##;
    let net_provider = Arc::new(crate::resources::net::KitesurfNetProvider::new());
    let mut document = HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some("https://test.example/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            net_provider: Some(net_provider),
            viewport: Some(Viewport::new(200, 200, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    let dump = |doc: &blitz_dom::BaseDocument, tag: &str| {
        let mut n_some = 0;
        let mut n_none = 0;
        for (_, node) in doc.tree().iter() {
            let Some(el) = node.element_data() else {
                continue;
            };
            for d in el.background_images().iter().flatten() {
                if matches!(d.image, blitz_dom::node::ImageData::None) {
                    n_none += 1
                } else {
                    n_some += 1
                }
            }
        }
        eprintln!("[{tag}] bg slots: {n_some} LOADED / {n_none} placeholder");
        n_some
    };
    document.as_mut().handle_messages();
    dump(document.as_ref(), "after parse+drain");
    document.as_mut().resolve(0.0);
    dump(document.as_ref(), "after resolve 1");
    document.as_mut().handle_messages();
    dump(document.as_ref(), "after drain 2");
    document.as_mut().resolve(0.0);
    let n = dump(document.as_ref(), "after resolve 2");
    assert!(n > 0, "no background image slot filled");
}

#[test]
fn backgrounds_without_a_url_keep_no_image_storage() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
  .d { width: 60px; height: 60px;
       background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM8ISfHAANMDEgANwcANHYBDK9qubUAAAAASUVORK5CYII=); }
  .g { background-image: linear-gradient(red, blue); }
</style></head><body><p>a</p><p class="g">b</p><div id="d" class="d"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_background_images();
    assert_eq!(
        report.lines().count(),
        1,
        "only the url layer needs storage: {report}"
    );
    assert!(report.contains("Some"), "{report}");

    let holder = dom.query_selector("#d").unwrap();
    dom.set_attribute(holder as u32, "class", "");
    dom.resolve_layout();
    let after_removal = dom.debug_dump_background_images();
    assert!(
        after_removal.is_empty(),
        "a removed image kept its slot: {after_removal}"
    );
}
