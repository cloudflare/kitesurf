// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Verifies CSS `filter` functions (`grayscale`, `brightness`, `blur`, and
// `drop-shadow` with `currentColor`) render through both direct screenshots
// and the KSC0 recorded-scene replay path.
// https://drafts.fxtf.org/filter-effects/#FilterProperty

fn decode_png(png: &[u8]) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    pixels.truncate(info.line_size * info.height as usize);
    (info.width, info.height, pixels)
}

fn pixel_at(pixels: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let offset = ((y * width + x) * 4) as usize;
    [
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        pixels[offset + 3],
    ]
}

#[test]
fn css_filter_grayscale_and_brightness_modify_pixels() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #gray {
        position: absolute; left: 0; top: 0; width: 40px; height: 40px;
        background: rgb(255, 0, 0);
        filter: grayscale(1);
      }
      #dim {
        position: absolute; left: 50px; top: 0; width: 40px; height: 40px;
        background: rgb(200, 200, 200);
        filter: brightness(0.5);
      }
    </style></head><body><div id="gray"></div><div id="dim"></div></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 100, 50);
    let (w, _, pixels) = decode_png(&png);

    let g = pixel_at(&pixels, w, 20, 20);
    assert!(
        (g[0] as i32 - g[1] as i32).abs() <= 4 && (g[1] as i32 - g[2] as i32).abs() <= 4,
        "grayscale(1) on red must produce neutral gray; got {g:?}"
    );
    assert!(
        g[0] < 180 && g[0] > 30,
        "grayscale(1) on red should have luma near ~54; got {g:?}"
    );

    let d = pixel_at(&pixels, w, 70, 20);
    assert!(
        d[0] < 130 && d[0] > 70,
        "brightness(0.5) on rgb(200,200,200) should darken near ~100; got {d:?}"
    );
}

#[test]
fn css_filter_drop_shadow_uses_current_color_and_replays_over_ksc0() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #card {
        position: absolute; left: 10px; top: 10px; width: 30px; height: 30px;
        background: rgb(0, 0, 200);
        color: rgb(0, 200, 0);
        filter: drop-shadow(20px 0px 0px);
      }
    </style></head><body><div id="card"></div></body></html>"##;
    let dom = crate::DomHandle::new(html, "https://test.example/");
    dom.set_viewport(100, 60);
    dom.resolve_layout();

    let scene = dom.render_scene_raw(0, 0, 0, 0, false, false);
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let png = rasterizer.rasterize(&scene, "png", 90, false);
    let (w, _, pixels) = decode_png(&png);

    // Shadow shifted +20px right sits at x=40..60, y=10..40 and must inherit currentColor (green).
    let shadow = pixel_at(&pixels, w, 50, 25);
    assert!(
        shadow[1] > 160 && shadow[0] < 30 && shadow[2] < 30,
        "drop-shadow with omitted color must use currentColor (green) across KSC0 replay; got {shadow:?}"
    );
}
