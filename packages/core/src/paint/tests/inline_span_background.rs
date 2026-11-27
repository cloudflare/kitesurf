// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/// Decode a rendered PNG into `(rgba, width, height)`.
fn decode_png(png: &[u8]) -> (Vec<u8>, usize, usize) {
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    let height = info.height as usize;
    let stride = info.line_size;
    let width = info.width as usize;
    let mut packed = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let start = row * stride;
        packed.extend_from_slice(&pixels[start..start + width * 4]);
    }
    (packed, width, height)
}

fn is_green(pixel: &[u8]) -> bool {
    pixel[1] > 180 && pixel[0] < 200 && pixel[2] < 200
}

fn is_dark(pixel: &[u8]) -> bool {
    pixel[0] < 80 && pixel[1] < 80 && pixel[2] < 80
}

/// The widest horizontal gap between green pixels on any row.
fn widest_green_gap(pixels: &[u8], width: usize, height: usize) -> usize {
    let mut widest = 0;
    for y in 0..height {
        let row = &pixels[y * width * 4..(y + 1) * width * 4];
        let mut last_green: Option<usize> = None;
        for x in 0..width {
            if is_green(&row[x * 4..x * 4 + 4]) {
                if let Some(prev) = last_green {
                    widest = widest.max(x - prev - 1);
                }
                last_green = Some(x);
            }
        }
    }
    widest
}

fn rightmost(
    pixels: &[u8],
    width: usize,
    height: usize,
    pred: impl Fn(&[u8]) -> bool,
) -> Option<usize> {
    let mut rightmost = None;
    for y in 0..height {
        let row = &pixels[y * width * 4..(y + 1) * width * 4];
        for x in 0..width {
            if pred(&row[x * 4..x * 4 + 4]) {
                rightmost = Some(rightmost.map_or(x, |r: usize| r.max(x)));
            }
        }
    }
    rightmost
}

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

/// A span that holds only child elements still paints its background over its
/// text: the preceding sibling's `margin-right` is a spacer outside both spans,
/// so the 36px gap stays white.
#[test]
fn element_only_span_background_follows_its_shifted_text() {
    let html = r##"<!doctype html>
<html><head><style>
  html, body { margin: 0; background: white; }
  body { font: 20px/40px monospace; }
  a { text-decoration: none; color: black; }
  .tag { background-color: rgb(0, 255, 0); }
</style></head>
<body><a class="tag" style="margin-right: 36px">x</a><a id="t2" class="tag"><span>css</span></a></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 240, 48);
    let (pixels, width, height) = decode_png(&png);

    let gap = widest_green_gap(&pixels, width, height);
    assert!(
        gap >= 30,
        "the 36px margin gap must stay unpainted; widest green gap was {gap}px"
    );
}

/// A child's margins widen the outer span's background, so the trailing text
/// after a margined child stays covered.
#[test]
fn outer_span_background_covers_text_after_margined_child() {
    let html = r##"<!doctype html>
<html><head><style>
  html, body { margin: 0; background: white; }
  body { font: 20px/40px monospace; }
  a { text-decoration: none; color: black; }
</style></head>
<body><a style="background-color: rgb(136, 255, 136)">Read <b style="margin: 0 24px">more</b> <span>now</span></a></body></html>"##;
    let png =
        crate::paint::screenshot::ks_render_html_to_png(html, "https://test.example/", 320, 48);
    let (pixels, width, height) = decode_png(&png);

    let rightmost_green =
        rightmost(&pixels, width, height, is_green).expect("the outer span background must paint");
    let rightmost_text = rightmost(&pixels, width, height, is_dark).expect("the text must paint");
    assert!(
        rightmost_green + 2 >= rightmost_text,
        "outer span background must cover the trailing text: green ends at {rightmost_green}, text at {rightmost_text}"
    );
}
