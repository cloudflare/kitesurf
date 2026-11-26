// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `background-clip: text` paints background gradients/colors clipped to the
// glyph silhouettes on both block inline roots and inline `<span>` elements.
// https://drafts.csswg.org/css-backgrounds-4/#valdef-background-clip-text

fn render_rgba(html: &str, width: u32, height: u32) -> Vec<u8> {
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
    pixels.truncate(info.line_size * info.height as usize);
    pixels
}

#[test]
fn background_clip_text_paints_gradient_clipped_to_glyphs_on_block_and_span() {
    let html = r##"<!doctype html><html><head><style>
      html, body { margin: 0; background: #ffffff; }
      #block {
        font: 40px/50px monospace;
        color: transparent;
        background: linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255));
        background-clip: text;
        -webkit-background-clip: text;
      }
      #inline-wrap { font: 40px/50px monospace; }
      #span {
        color: transparent;
        background: linear-gradient(to right, rgb(0, 200, 0), rgb(0, 200, 0));
        background-clip: text;
        -webkit-background-clip: text;
      }
    </style></head><body>
      <div id="block">MMMM</div>
      <div id="inline-wrap"><span id="span">MMMM</span></div>
    </body></html>"##;
    let pixels = render_rgba(html, 200, 110);
    let row_len = 200 * 4;

    // Top band (y 0..50): #block should have colored (red/blue) glyph pixels AND
    // white background pixels (proving the gradient is clipped to the glyphs,
    // not painted as a solid box).
    let top = &pixels[..50 * row_len];
    let top_colored = top
        .chunks_exact(4)
        .filter(|p| (p[0] > 180 && p[1] < 80) || (p[2] > 180 && p[1] < 80))
        .count();
    let top_white = top
        .chunks_exact(4)
        .filter(|p| p[0] > 245 && p[1] > 245 && p[2] > 245)
        .count();
    assert!(
        top_colored > 100,
        "block background-clip:text must paint colored glyph pixels; got {top_colored}"
    );
    assert!(
        top_white > 1000,
        "block background-clip:text must keep non-glyph pixels white; got {top_white}"
    );

    // Bottom band (y 50..105): #span should have green glyph pixels AND white background.
    let bottom = &pixels[50 * row_len..105 * row_len];
    let bottom_green = bottom
        .chunks_exact(4)
        .filter(|p| p[1] > 150 && p[0] < 80 && p[2] < 80)
        .count();
    let bottom_white = bottom
        .chunks_exact(4)
        .filter(|p| p[0] > 245 && p[1] > 245 && p[2] > 245)
        .count();
    assert!(
        bottom_green > 100,
        "inline span background-clip:text must paint green glyph pixels; got {bottom_green}"
    );
    assert!(
        bottom_white > 1000,
        "inline span background-clip:text must keep non-glyph pixels white; got {bottom_white}"
    );
}
