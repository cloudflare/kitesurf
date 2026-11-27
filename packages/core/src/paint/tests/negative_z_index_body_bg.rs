// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// When `<body>`'s background is propagated to the canvas, `<body>` must not
// paint its background a second time on top of `z-index: -1` descendants
// hoisted into the root stacking context.
// https://drafts.csswg.org/css-backgrounds-3/#body-background

#[test]
fn negative_z_index_child_paints_above_propagated_body_background() {
    let html = r##"<!doctype html><html><head><style>
      body { margin: 0; background: #ffffff; }
      #hero {
        position: absolute;
        top: 0;
        left: 0;
        width: 100px;
        height: 100px;
        z-index: -1;
        background: rgb(0, 200, 0);
      }
    </style></head><body><div id="hero"></div></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 100, 100);
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    let frame_len = info.line_size * info.height as usize;
    let green_pixels = pixels[..frame_len]
        .chunks_exact(4)
        .filter(|p| p[1] > 180 && p[0] < 16 && p[2] < 16)
        .count();

    assert!(
        green_pixels > 9000,
        "z-index: -1 child must stay visible above propagated body background; got {green_pixels} green pixels"
    );
}

fn decode_rgba(png: &[u8]) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    pixels.truncate(info.line_size * info.height as usize);
    (info.width, info.height, pixels)
}

#[test]
fn propagated_body_and_html_backgrounds_scroll_with_viewport() {
    for target in ["body", "html"] {
        let html = format!(
            r##"<!doctype html><html><head><style>
              html, body {{ margin: 0; }}
              {target} {{
                height: 2000px;
                background: linear-gradient(to bottom, rgb(255, 0, 0) 0px, rgb(255, 0, 0) 200px, rgb(0, 0, 255) 200px, rgb(0, 0, 255) 2000px);
              }}
            </style></head><body></body></html>"##
        );
        let dom = crate::DomHandle::new(&html, "https://test.example/");
        dom.set_viewport(200, 200);
        dom.resolve_layout();
        let scene = dom.render_scene_raw(0, 1000, 0, 0, false, false);
        let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
        let png = rasterizer.rasterize(&scene, "png", 90, false);
        let (w, _, pixels) = decode_rgba(&png);
        let top = &pixels[((10 * w + 10) * 4) as usize..((10 * w + 10) * 4 + 4) as usize];
        assert!(
            top[2] > 200 && top[0] < 32,
            "{target} gradient scrolled to y=1000 must show blue at top, got {top:?}"
        );
    }
}

#[test]
fn html_filter_invert_inverts_propagated_background_and_text() {
    let html = r##"<!doctype html><html><head><style>
      html { background: #ffffff; filter: invert(1); }
      body { margin: 0; color: #000000; }
      #bar { width: 40px; height: 40px; background: #000000; }
    </style></head><body><div id="bar"></div></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 100, 100);
    let (w, _, pixels) = decode_rgba(&png);
    let bg = &pixels[((80 * w + 80) * 4) as usize..((80 * w + 80) * 4 + 4) as usize];
    let bar = &pixels[((20 * w + 20) * 4) as usize..((20 * w + 20) * 4 + 4) as usize];
    assert!(
        bg[0] < 32 && bg[1] < 32 && bg[2] < 32,
        "html {{ background: #fff; filter: invert(1) }} must invert page background to black; got {bg:?}"
    );
    assert!(
        bar[0] > 220 && bar[1] > 220 && bar[2] > 220,
        "black child inside html {{ filter: invert(1) }} must invert to white; got {bar:?}"
    );
}

#[test]
fn html_filter_invert_inverts_canvas_at_large_desktop_viewports() {
    let html = r##"<!doctype html><html><head><style>
      html { background: #ffffff; filter: invert(1); }
      body { margin: 0; }
      #bar { width: 40px; height: 40px; background: #000000; }
      #child { width: 400px; height: 400px; background: #000000; filter: brightness(0.9); }
    </style></head><body><div id="bar"></div><div id="child"></div></body></html>"##;
    for (vw, vh) in [(1920u32, 1080u32), (1920, 1200), (2560, 1440)] {
        let png =
            crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", vw, vh);
        let (w, _, pixels) = decode_rgba(&png);
        let bg = &pixels[((vh - 20) * w + (vw - 20)) as usize * 4
            ..((vh - 20) * w + (vw - 20)) as usize * 4 + 4];
        let bar = &pixels[((20 * w + 20) * 4) as usize..((20 * w + 20) * 4 + 4) as usize];
        assert!(
            bg[0] < 32 && bg[1] < 32 && bg[2] < 32,
            "at {vw}x{vh}, html {{ background: #fff; filter: invert(1) }} must invert canvas to black; got {bg:?}"
        );
        assert!(
            bar[0] > 220 && bar[1] > 220 && bar[2] > 220,
            "at {vw}x{vh}, black child must invert to white; got {bar:?}"
        );
    }
}

#[test]
fn propagated_percentage_gradient_stays_scroll_stable() {
    for target in ["html", "body"] {
        let html = format!(
            r##"<!doctype html><html><head><style>
              html, body {{ margin: 0; height: 100%; }}
              {target} {{ background: linear-gradient(to bottom, rgb(0, 0, 0), rgb(255, 255, 255)); }}
              #tall {{ height: 2000px; }}
            </style></head><body><div id="tall"></div></body></html>"##
        );
        let dom = crate::DomHandle::new(&html, "https://test.example/");
        dom.set_viewport(200, 200);
        dom.resolve_layout();
        let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
        let sample = |scroll_y: i32, vy: u32| {
            let scene = dom.render_scene_raw(0, scroll_y, 0, 0, false, false);
            let png = rasterizer.rasterize(&scene, "png", 90, false);
            let (w, _, pixels) = decode_rgba(&png);
            pixels[((vy * w + 100) * 4) as usize]
        };
        let at_0 = sample(0, 100);
        let at_100 = sample(100, 0);
        assert!(
            (i32::from(at_0) - 127).abs() <= 4,
            "{target} gradient must size to the 200px root box (mid grey at y=100), not 2000px overflow; got {at_0}"
        );
        assert!(
            (i32::from(at_0) - i32::from(at_100)).abs() <= 4,
            "{target} content y=100 must render the same gradient colour at scroll 0 and scroll 100; got {at_0} vs {at_100}"
        );
    }
}

// A propagated body background sizes its painting area to the document
// overflow so the tiles keep scrolling with the content, but only the tiles
// that reach the viewport are drawn. With 20px tiles over a 1280px-wide,
// 3000px-tall page the layer asks for 64 x 150 tiles, which the per-layer tile
// cap used to reject wholesale: the body background then painted nothing at any
// scroll position.
#[test]
fn propagated_tiled_svg_body_background_paints_while_scrolled() {
    const WIDTH: u32 = 1280;
    const HEIGHT: u32 = 400;
    let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'>\
               <rect width='10' height='10' fill='black'/></svg>"
        .replace(' ', "%20");
    let html = format!(
        r##"<!doctype html><html><head><style>
          html, body {{ margin: 0; height: 100%; }}
          body {{
            background-image: url("data:image/svg+xml;utf8,{svg}");
            background-size: 20px 20px;
            background-repeat: repeat;
          }}
          #tall {{ height: 3000px; }}
        </style></head><body><div id="tall"></div></body></html>"##
    );
    let dom = crate::DomHandle::new(&html, "https://test.example/");
    dom.set_viewport(WIDTH, HEIGHT);
    dom.resolve_layout();
    // A data-URL SVG is parsed after the first resolve, so drain the image
    // messages and lay out again before painting.
    for _ in 0..2 {
        dom.pump_resource_messages();
        dom.resolve_layout();
    }
    let rasterizer = crate::paint::scene_replay::SceneRasterizer::new();
    let sample = |scroll_y: i32| {
        let scene = dom.render_scene_raw(0, scroll_y, 0, 0, false, false);
        let png = rasterizer.rasterize(&scene, "png", 90, false);
        let (w, h, pixels) = decode_rgba(&png);
        assert_eq!(
            (w, h),
            (WIDTH, HEIGHT),
            "the scene rasterized at the wrong size"
        );
        let count =
            |predicate: fn(&[u8]) -> bool| pixels.chunks_exact(4).filter(|p| predicate(p)).count();
        (
            count(|p| p[0] < 32 && p[1] < 32 && p[2] < 32),
            count(|p| p[0] > 220 && p[1] > 220 && p[2] > 220),
        )
    };
    for scroll_y in [0, 1000] {
        let (black, white) = sample(scroll_y);
        assert!(
            black > 2000,
            "the tiled SVG body background must paint at scroll {scroll_y}; got {black} black pixels"
        );
        assert!(
            white > 2000,
            "the tiled SVG must keep its white gaps at scroll {scroll_y}; got {white} white pixels"
        );
    }
}

// `visible_tiles` culled, and the tiling stepped, by the untransformed stride
// in screen space, so a scaled element's tiled background stopped at the first
// `1/scale` of the viewport. With the transform's scale folded into the stride,
// the pattern still covers the whole scaled box.
#[test]
fn scaled_tiled_svg_background_paints_to_bottom_of_scaled_box() {
    const SIZE: u32 = 400;
    let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'>\
               <rect width='20' height='20' fill='black'/></svg>"
        .replace(' ', "%20");
    // The box is twice the viewport so that, scaled down by half, its border box
    // covers the viewport exactly.
    let html = format!(
        r##"<!doctype html><html><head><style>
          html, body {{ margin: 0; background: #ffffff; }}
          #box {{
            width: 800px;
            height: 800px;
            transform: scale(0.5);
            transform-origin: 0 0;
            background-image: url("data:image/svg+xml;utf8,{svg}");
            background-size: 20px 20px;
            background-repeat: repeat;
          }}
        </style></head><body><div id="box"></div></body></html>"##
    );
    let png =
        crate::paint::screenshot::ks_render_html_to_png(&html, "https://test.example/", SIZE, SIZE);
    let (w, _, pixels) = decode_rgba(&png);
    let is_black = |x: u32, y: u32| {
        let p = &pixels[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        p[0] < 32 && p[1] < 32 && p[2] < 32 && p[3] > 200
    };

    assert!(
        is_black(200, 5),
        "the top of the scaled box must be painted"
    );
    assert!(
        is_black(200, 395),
        "the bottom of the 0.5-scaled box must still be painted; the tiled SVG \
         background stopped at the first half of the viewport"
    );
}
