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

#[test]
fn css_filter_output_is_clipped_by_overflow_hidden_and_clip_path() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #clip {
        position: absolute; left: 20px; top: 20px; width: 40px; height: 40px;
        overflow: hidden;
      }
      #blur {
        width: 40px; height: 40px;
        background: rgb(0, 0, 255);
        filter: blur(12px);
      }
      #masked {
        position: absolute; left: 90px; top: 20px; width: 60px; height: 60px;
        background: rgb(0, 200, 0);
        filter: drop-shadow(15px 15px 10px rgb(255, 0, 0));
        clip-path: inset(0px 30px 30px 0px);
      }
    </style></head><body>
      <div id="clip"><div id="blur"></div></div>
      <div id="masked"></div>
    </body></html>"##;
    let dom = crate::DomHandle::new(html, "https://test.example/");
    dom.set_viewport(180, 100);
    dom.resolve_layout();

    let scene = dom.render_scene_raw(0, 0, 0, 0, false, false);
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let png = rasterizer.rasterize(&scene, "png", 90, false);
    let (w, _, pixels) = decode_png(&png);

    // Just outside #clip's right edge (x=65, y=40): blur must not bleed past overflow:hidden.
    let outside_overflow = pixel_at(&pixels, w, 65, 40);
    assert_eq!(
        outside_overflow,
        [255, 255, 255, 255],
        "blur inside overflow:hidden must not bleed outside clip box; got {outside_overflow:?}"
    );

    // Just outside #masked's clip-path inset right edge (x=125, y=35):
    // red drop-shadow must be clipped.
    let outside_clip_path = pixel_at(&pixels, w, 125, 35);
    assert_eq!(
        outside_clip_path,
        [255, 255, 255, 255],
        "drop-shadow must be clipped by clip-path; got {outside_clip_path:?}"
    );
}

#[test]
fn css_backdrop_filter_filters_backdrop_without_filtering_children() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #bg {
        position: absolute; left: 0; top: 0; width: 100px; height: 100px;
        background: rgb(255, 0, 0);
      }
      #overlay {
        position: absolute; left: 20px; top: 20px; width: 60px; height: 60px;
        backdrop-filter: grayscale(1);
      }
      #child {
        position: absolute; left: 20px; top: 20px; width: 20px; height: 20px;
        background: rgb(0, 200, 0);
      }
    </style></head><body>
      <div id="bg"></div>
      <div id="overlay"><div id="child"></div></div>
    </body></html>"##;
    let dom = crate::DomHandle::new(html, "https://test.example/");
    dom.set_viewport(100, 100);
    dom.resolve_layout();

    let scene = dom.render_scene_raw(0, 0, 0, 0, false, false);
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let png = rasterizer.rasterize(&scene, "png", 90, false);
    let (w, _, pixels) = decode_png(&png);

    // Outside #overlay (x=10, y=10): original red background stays unfiltered.
    let outside = pixel_at(&pixels, w, 10, 10);
    assert_eq!(
        outside,
        [255, 0, 0, 255],
        "backdrop outside #overlay must stay red; got {outside:?}"
    );

    // Inside #overlay, outside #child (x=25, y=25): red backdrop must be grayscaled.
    let filtered = pixel_at(&pixels, w, 25, 25);
    assert!(
        (filtered[0] as i32 - filtered[1] as i32).abs() <= 4
            && (filtered[1] as i32 - filtered[2] as i32).abs() <= 4
            && filtered[0] > 20
            && filtered[0] < 180,
        "backdrop-filter: grayscale(1) must desaturate red backdrop; got {filtered:?}"
    );

    // Inside #child (x=50, y=50): #overlay's own child must stay unfiltered green.
    let child = pixel_at(&pixels, w, 50, 50);
    assert!(
        child[1] > 180 && child[0] < 20 && child[2] < 20,
        "child inside backdrop-filter element must stay unfiltered green; got {child:?}"
    );
}

#[test]
fn tall_filtered_element_banded_render_matches_grayscale_drop_shadow_and_nested_filters() {
    // Height 4200 > MAX_SINGLE_PASS_DIMENSION (4096) forces the 128-row banded path.
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #gray {
        position: absolute; left: 0; top: 0; width: 100px; height: 4200px;
        background: rgb(255, 0, 0);
        filter: grayscale(1);
      }
      /* Box ends at y=384 (exact 128-row band seam); shadow extends to y=384..392. */
      #shadow {
        position: absolute; left: 110px; top: 344px; width: 40px; height: 40px;
        background: rgb(0, 0, 200);
        filter: drop-shadow(0px 8px 0px rgb(255, 0, 0));
      }
    </style></head><body>
      <div id="gray"></div>
      <div id="shadow"></div>
    </body></html>"##;
    let dom = crate::DomHandle::new(html, "https://test.example/");
    dom.set_viewport(200, 4200);
    dom.resolve_layout();

    let scene = dom.render_scene_raw(0, 0, 0, 0, false, false);
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let start = std::time::Instant::now();
    let png = rasterizer.rasterize(&scene, "png", 90, false);
    let elapsed = start.elapsed();
    let (w, h, pixels) = decode_png(&png);
    assert_eq!((w, h), (200, 4200));

    for y in [10, 2000, 4190] {
        let p = pixel_at(&pixels, w, 50, y);
        assert!(
            (p[0] as i32 - p[1] as i32).abs() <= 4 && (p[1] as i32 - p[2] as i32).abs() <= 4,
            "row {y} must be neutral gray; got {p:?}"
        );
        assert!(
            p[0] > 30 && p[0] < 180,
            "row {y} grayscale(1) on red must be mid-gray; got {p:?}"
        );
    }
    // Shadow crossing the y=384 band seam must stay solid red at y=386.
    let seam_shadow = pixel_at(&pixels, w, 130, 386);
    assert!(
        seam_shadow[0] > 200 && seam_shadow[1] < 32 && seam_shadow[2] < 32,
        "drop-shadow across 128-row band seam must remain red; got {seam_shadow:?}"
    );
    assert!(
        elapsed.as_secs() < 5,
        "banded tall filter rasterization took too long: {elapsed:?}"
    );
}

#[test]
fn nested_and_over_budget_filters_render_fast_and_never_vanish() {
    // Nested filter (html invert + tall main grayscale) on a 4200px banded scene
    // must band-clip both layers instead of re-rendering the child per band.
    let nested_html = r##"<!doctype html><html><head><style>
      html { filter: invert(1); }
      body { margin: 0; }
      main { width: 200px; height: 4200px; background: rgb(255, 0, 0); filter: grayscale(1); }
    </style></head><body><main></main></body></html>"##;
    let dom = crate::DomHandle::new(nested_html, "https://test.example/");
    dom.set_viewport(200, 4200);
    dom.resolve_layout();
    let scene = dom.render_scene_raw(0, 0, 0, 0, false, false);
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let start = std::time::Instant::now();
    let png = rasterizer.rasterize(&scene, "png", 90, false);
    assert!(
        start.elapsed().as_secs() < 5,
        "nested banded filter took too long: {:?}",
        start.elapsed()
    );
    let (w, h, pixels) = decode_png(&png);
    assert_eq!((w, h), (200, 4200));
    let mid = pixel_at(&pixels, w, 100, 2000);
    // grayscale(red) ~= 54, inverted ~= 201 (neutral light gray).
    assert!(
        mid[0] > 160 && (mid[0] as i32 - mid[2] as i32).abs() <= 4,
        "nested inverted grayscale must paint light gray; got {mid:?}"
    );

    // Over-budget filter (single-pass 2100x2100 > 4M pixels) must fall back to
    // painting unfiltered content instead of silently dropping the element.
    let big_html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #big { width: 2100px; height: 2100px; background: rgb(0, 0, 200); filter: blur(10px); }
    </style></head><body><div id="big"></div></body></html>"##;
    let png = crate::paint::screenshot::ks_render_html_to_png(
        big_html,
        "https://test.example/",
        2100,
        2100,
    );
    let (bw, bh, bpixels) = decode_png(&png);
    assert_eq!((bw, bh), (2100, 2100));
    let center = pixel_at(&bpixels, bw, 1050, 1050);
    assert!(
        center[2] > 180 && center[0] < 32,
        "over-budget filter layer must fall back to painting its content unfiltered; got {center:?}"
    );
}

#[test]
fn large_drop_shadow_offset_is_clamped_and_fast() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #box {
        width: 200px; height: 200px;
        background: rgb(0, 0, 200);
        filter: drop-shadow(5000px 5000px 0px rgb(255, 0, 0));
      }
    </style></head><body><div id="box"></div></body></html>"##;
    let start = std::time::Instant::now();
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 200, 200);
    let elapsed = start.elapsed();
    let (w, h, pixels) = decode_png(&png);
    assert_eq!((w, h), (200, 200));
    let center = pixel_at(&pixels, w, 100, 100);
    assert!(center[2] > 180 && center[0] < 32, "got {center:?}");
    assert!(
        elapsed.as_secs() < 5,
        "clamped drop-shadow render took too long: {elapsed:?}"
    );
}
