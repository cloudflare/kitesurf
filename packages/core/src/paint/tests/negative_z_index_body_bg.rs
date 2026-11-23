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
