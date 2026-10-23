// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#[test]
fn background_only_inline_span_paints_behind_text() {
    let html = r##"<!doctype html>
<html><head><style>
  html, body { margin: 0; background: white; }
  body { font: 20px/24px monospace; }
  span { background-color: rgb(255, 0, 0); }
</style></head>
<body><span>MMMM</span></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 160, 40);
    let decoder = png::Decoder::new(std::io::Cursor::new(&png[..]));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    let frame_len = info.line_size * info.height as usize;
    let red_pixels = pixels[..frame_len]
        .chunks_exact(4)
        .filter(|pixel| pixel[0] > 240 && pixel[1] < 16 && pixel[2] < 16)
        .count();

    assert!(
        red_pixels > 100,
        "background-only inline span should paint a red fragment behind its text; found {red_pixels} red pixels"
    );
}
