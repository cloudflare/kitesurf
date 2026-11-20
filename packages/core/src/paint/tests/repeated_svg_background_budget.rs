// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A repeated SVG background re-renders its whole vector tree for every tile,
//! so one screenshot must not spend unbounded time on it.

use std::time::{Duration, Instant};

use crate::paint::screenshot::ks_render_html_to_png;

fn data_url(svg: &str) -> String {
    format!("data:image/svg+xml;utf8,{}", percent_encode(svg))
}

/// Percent-encodes the characters that would end the URL early or start a
/// fragment, so an SVG or a whole document can ride in a `data:` URL.
fn percent_encode(text: &str) -> String {
    text.replace('%', "%25")
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('"', "%22")
        .replace('#', "%23")
        .replace(' ', "%20")
}

/// A 1x1 SVG of `paths` small triangles, so one tile walks `paths` usvg nodes.
fn triangles_svg(paths: usize, color: &str) -> String {
    let paths: String = (0..paths)
        .map(|i| {
            let (x, y) = ((i % 8) as f64 / 8.0, ((i / 8) % 8) as f64 / 8.0);
            let (x1, y1) = (x + 0.05, y + 0.05);
            format!("<path fill='{color}' d='M{x:.3} {y:.3}L{x:.3} {y1:.3}L{x1:.3} {y:.3}Z'/>")
        })
        .collect();
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1' viewBox='0 0 1 1'>{paths}</svg>"
    )
}

/// A 1x1 SVG of `glyphs` characters, whose one tile walks two tree nodes but
/// `glyphs` outlines.
fn text_svg(glyphs: usize, color: &str) -> String {
    let text: String = "M".repeat(glyphs);
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1' viewBox='0 0 1 1'>\
         <text x='0' y='0.8' font-size='0.8' fill='{color}'>{text}</text></svg>"
    )
}

/// A 1x1 SVG of `rects` whole-tile rects: the same node count as the triangle
/// fixture, but a painted tile is a solid block of `color`, so a pixel count
/// can tell "skipped" from "painted" rather than from "too small to see".
fn rects_svg(rects: usize, color: &str) -> String {
    let rects: String = (0..rects)
        .map(|_| format!("<rect width='1' height='1' fill='{color}'/>"))
        .collect();
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1' viewBox='0 0 1 1'>{rects}</svg>"
    )
}

fn dot_svg(color: &str) -> String {
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' \
viewBox='0 0 8 8'><circle cx='4' cy='4' r='2' fill='{color}'/></svg>"
    )
}

fn page(svg: &str, tile: u32, box_size: u32, elements: usize) -> String {
    let url = data_url(svg);
    let body = "<div></div>".repeat(elements);
    format!(
        "<!doctype html><style>html,body{{margin:0}}div{{width:{box_size}px;height:{box_size}px;\
         background-image:url(\"{url}\");background-size:{tile}px {tile}px;\
         background-repeat:repeat}}</style>{body}"
    )
}

fn render_png(html: &str, width: u32, height: u32) -> Vec<u8> {
    let png = ks_render_html_to_png(html, "https://test.example/", width, height);
    assert!(!png.is_empty(), "the screenshot came back empty");
    png
}

fn count_color(png: &[u8], rgb: [u8; 3]) -> usize {
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().expect("png info");
    let mut pixels = vec![0u8; reader.output_buffer_size().expect("pixel buffer size")];
    let info = reader.next_frame(&mut pixels).expect("png frame");
    let frame_len = info.line_size * info.height as usize;
    pixels[..frame_len]
        .chunks_exact(4)
        .filter(|pixel| pixel[0] == rgb[0] && pixel[1] == rgb[1] && pixel[2] == rgb[2])
        .count()
}

/// The reported input: 1px tiles of a 200-path SVG. Every layer costs more
/// than the scene budget, so the page paints without it and never errors.
#[test]
fn repeated_svg_background_work_is_bounded() {
    let svg = triangles_svg(200, "black");
    let started = Instant::now();
    let png = render_png(&page(&svg, 1, 64, 8), 800, 600);
    let elapsed = started.elapsed();
    assert!(
        count_color(&png, [0, 0, 0]) == 0,
        "the pathological repeated SVG layer painted"
    );
    assert!(elapsed < Duration::from_secs(10), "paint took {elapsed:?}");
}

/// The same fixture under the budget, so the meter admits it: 16 tiles of the
/// 201-node tree is 3216 units. Only the absence of black pixels would also
/// hold for a layer that never painted at all.
#[test]
fn affordable_triangles_layer_still_paints() {
    let png = render_png(&page(&triangles_svg(200, "black"), 64, 256, 1), 800, 600);
    let black = count_color(&png, [0, 0, 0]);
    assert!(
        black > 100,
        "an affordable layer of the over-budget fixture painted {black} black pixels"
    );
}

#[test]
fn repeated_svg_dot_pattern_still_renders() {
    // 62x62 = 3844 tiles, under the per-layer 4096-tile cap, so this layer is
    // charged against the budget and painted rather than discarded first.
    let dot = dot_svg("black");
    let png = render_png(&page(&dot, 8, 496, 1), 800, 600);
    assert!(
        count_color(&png, [0, 0, 0]) > 1000,
        "an ordinary 8px SVG dot pattern stopped painting"
    );
}

#[test]
fn over_budget_svg_layer_is_skipped_and_the_rest_of_the_page_paints() {
    // 63x63 = 3969 tiles x ~400 usvg nodes is far past the budget; the layer
    // is skipped, and the elements after it still paint.
    let over = data_url(&rects_svg(400, "lime"));
    let under = data_url(&dot_svg("blue"));
    let html = format!(
        "<!doctype html><style>html,body{{margin:0;background:#fff}}div{{position:absolute}}\
         .over{{left:0;top:0;width:1000px;height:1000px;background-image:url(\"{over}\");\
         background-size:16px 16px;background-repeat:repeat}}\
         .under{{left:0;top:0;width:496px;height:496px;background-image:url(\"{under}\");\
         background-size:8px 8px;background-repeat:repeat}}\
         .solid{{left:600px;top:0;width:120px;height:120px;background:#ff0000}}</style>\
         <div class=over></div><div class=under></div><div class=solid></div>"
    );
    let png = render_png(&html, 800, 600);
    assert_eq!(
        count_color(&png, [0, 255, 0]),
        0,
        "the over-budget SVG layer painted"
    );
    assert!(
        count_color(&png, [255, 0, 0]) > 1000,
        "a plain element after the over-budget layer stopped painting"
    );
    assert!(
        count_color(&png, [0, 0, 255]) > 100,
        "an affordable SVG layer after the over-budget one stopped painting"
    );
}

/// A text node is two usvg nodes but one outline per glyph, and only the
/// outlines cost anything per tile. 200 glyphs over 3969 tiles is 810k units,
/// so the layer is skipped; charging the two nodes alone would paint it.
#[test]
fn text_heavy_repeated_svg_is_charged_by_its_glyphs() {
    let html = page(&text_svg(200, "black"), 16, 1000, 1);
    let png = render_png(&html, 800, 600);
    assert_eq!(
        count_color(&png, [0, 0, 0]),
        0,
        "the text-heavy SVG layer painted"
    );
}

/// 800 elements sharing one over-budget SVG: measuring a tree is charged like
/// drawing it, so the count stops at the nodes the budget could still afford
/// and the repeated refusals drain it. The trailing dot layer shows that: it
/// paints while the budget lasts and is skipped once the shared tree spent it.
#[test]
fn many_elements_sharing_one_over_budget_svg_drain_the_budget() {
    // 6001 nodes over 10x10 tiles is past the budget, so each layer is refused
    // after visiting 5243 nodes, and 800 of them leave 120 units.
    let over = data_url(&triangles_svg(6000, "lime"));
    let under = data_url(&dot_svg("blue"));
    let html = format!(
        "<!doctype html><style>html,body{{margin:0;background:#fff}}div{{position:absolute;left:0;top:0}}\
         .over{{width:1000px;height:1000px;background-image:url(\"{over}\");\
         background-size:100px 100px;background-repeat:repeat}}\
         .under{{width:496px;height:496px;background-image:url(\"{under}\");\
         background-size:8px 8px;background-repeat:repeat}}\
         .solid{{left:600px;width:120px;height:120px;background:#ff0000}}</style>\
         {}<div class=under></div><div class=solid></div>",
        "<div class=over></div>".repeat(800)
    );
    let png = render_png(&html, 800, 600);
    assert_eq!(
        count_color(&png, [0, 255, 0]),
        0,
        "an over-budget layer painted"
    );
    assert_eq!(
        count_color(&png, [0, 0, 255]),
        0,
        "the shared over-budget tree did not drain the budget"
    );
    assert!(
        count_color(&png, [255, 0, 0]) > 1000,
        "the page stopped painting"
    );
}

/// A subdocument is painted by a second `BlitzDomPainter`, so the screenshot's
/// budget has to span it: otherwise every iframe would paint the same
/// unaffordable layer again, and a page could multiply the work by nesting.
#[test]
fn over_budget_svg_layer_inside_an_iframe_is_skipped() {
    let over = data_url(&rects_svg(400, "lime"));
    let inner = format!(
        "<!doctype html><style>html,body{{margin:0}}div{{width:1000px;height:1000px;\
         background-image:url(\"{over}\");background-size:16px 16px;background-repeat:repeat}}\
         </style><div></div>"
    );
    let html = format!(
        "<!doctype html><style>html,body{{margin:0}}iframe{{border:0;width:400px;height:300px}}\
         .solid{{position:absolute;left:500px;top:0;width:120px;height:120px;background:#ff0000}}\
         </style><iframe src=\"data:text/html,{}\"></iframe><div class=solid></div>",
        percent_encode(&inner)
    );
    let png = render_png(&html, 800, 600);
    assert_eq!(
        count_color(&png, [0, 255, 0]),
        0,
        "the iframe's over-budget SVG layer painted"
    );
    assert!(
        count_color(&png, [255, 0, 0]) > 1000,
        "the page around the iframe stopped painting"
    );
}
