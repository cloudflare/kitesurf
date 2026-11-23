// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `clip-path: circle(50%)` resolves percentages against `sqrt(w^2 + h^2) / sqrt(2)`,
// and `ellipse(closest-side closest-side)` resolves each semi-axis along its own axis.
// https://drafts.csswg.org/css-shapes-1/#funcdef-basic-shape-circle
// https://drafts.csswg.org/css-shapes-1/#funcdef-basic-shape-ellipse

fn render_rgba(html: &str, width: u32, height: u32) -> (Vec<u8>, usize) {
    let png = crate::paint::screenshot::ks_render_html_to_png(
        html,
        "https://test.example/",
        width,
        height,
    );
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    (pixels, info.line_size)
}

fn pixel_is_red(pixels: &[u8], line_size: usize, x: usize, y: usize) -> bool {
    let idx = y * line_size + x * 4;
    pixels[idx] > 240 && pixels[idx + 1] < 16 && pixels[idx + 2] < 16
}

#[test]
fn circle_percentage_radius_uses_normalized_diagonal() {
    // 200x100 box -> normalized diagonal = sqrt(200^2 + 100^2) / sqrt(2) ~= 158.11px.
    // circle(50%) => r ~= 79.06px about (100, 50):
    // - (170, 50) is dx=70 < 79.06 -> inside (red)
    // - (188, 50) is dx=88 > 79.06 -> outside (white; width-based r=100 would wrongly keep it red)
    let html = r##"<!doctype html><html><head><style>
      html, body { margin: 0; background: white; }
      #box { width: 200px; height: 100px; background: rgb(255, 0, 0); clip-path: circle(50%); }
    </style></head><body><div id="box"></div></body></html>"##;
    let (pixels, line_size) = render_rgba(html, 200, 100);
    assert!(
        pixel_is_red(&pixels, line_size, 170, 50),
        "(170, 50) must be inside circle(50%)"
    );
    assert!(
        !pixel_is_red(&pixels, line_size, 188, 50),
        "(188, 50) must be outside circle(50%) (r ~= 79.06, not 100)"
    );
}

#[test]
fn ellipse_closest_side_resolves_each_axis_independently() {
    // 200x100 box -> ellipse(closest-side closest-side) has rx=100, ry=50 about (100, 50):
    // - (180, 50) is dx=80 < 100 -> inside (red; using min(w,h)/2 = 50 would wrongly clip it)
    let html = r##"<!doctype html><html><head><style>
      html, body { margin: 0; background: white; }
      #box { width: 200px; height: 100px; background: rgb(255, 0, 0); clip-path: ellipse(closest-side closest-side); }
    </style></head><body><div id="box"></div></body></html>"##;
    let (pixels, line_size) = render_rgba(html, 200, 100);
    assert!(
        pixel_is_red(&pixels, line_size, 180, 50),
        "(180, 50) must be inside ellipse(closest-side closest-side) with rx=100"
    );
}
