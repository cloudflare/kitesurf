// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use std::ops::Range;

use crate::paint::scene_decode::{
    decode, DecodedCap, DecodedFillRule, DecodedJoin, DecodedPaint, DecodedPathEl,
    DecodedTransform, SceneVisitor,
};
use crate::DomHandle;

/// The glyph text of each glyph run, as the per-glyph text slices in draw order.
#[derive(Default)]
struct GlyphTexts {
    pending: Option<Vec<String>>,
    runs: Vec<(usize, Option<Vec<String>>)>,
    ranges: Vec<Vec<Range<usize>>>,
}

impl SceneVisitor for GlyphTexts {
    fn on_push_layer(&mut self, _: u8, _: u8, _: f32, _: DecodedTransform, _: &[DecodedPathEl]) {}
    fn on_push_clip_layer(&mut self, _: DecodedTransform, _: &[DecodedPathEl]) {}
    fn on_pop_layer(&mut self) {}
    fn on_fill(
        &mut self,
        _: DecodedFillRule,
        _: DecodedTransform,
        _: Option<DecodedTransform>,
        _: DecodedPaint,
        _: &[DecodedPathEl],
    ) {
    }
    fn on_stroke(
        &mut self,
        _: f32,
        _: f32,
        _: DecodedCap,
        _: DecodedJoin,
        _: f32,
        _: &[f32],
        _: DecodedTransform,
        _: Option<DecodedTransform>,
        _: DecodedPaint,
        _: &[DecodedPathEl],
    ) {
    }
    fn on_glyph_run(
        &mut self,
        _: u32,
        _: f32,
        _: &[i16],
        _: DecodedTransform,
        _: DecodedPaint,
        glyphs: &[(u32, f32, f32)],
    ) {
        self.runs.push((glyphs.len(), self.pending.take()));
    }
    fn on_box_shadow(
        &mut self,
        _: DecodedTransform,
        _: f32,
        _: f32,
        _: f32,
        _: f32,
        _: (u8, u8, u8, u8),
        _: f32,
        _: f32,
    ) {
    }
    fn on_glyph_text(&mut self, text: &str, glyph_ranges: &[Range<usize>]) {
        // Drop the bidi controls layout inserts for `dir`; the PDF text layer drops them too.
        let visible = |r: &Range<usize>| {
            text[r.clone()]
                .chars()
                .filter(|c| !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
                .collect()
        };
        self.pending = Some(glyph_ranges.iter().map(visible).collect());
        self.ranges.push(glyph_ranges.to_vec());
    }
}

fn print_glyph_texts(html: &str) -> GlyphTexts {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(600, 400);
    dom.resolve_layout();
    let envelope = dom.record_pdf_scenes(600, 400, 0, 0, 0, 0);
    let read_u32 = |at: usize| u32::from_le_bytes(envelope[at..at + 4].try_into().unwrap());
    let mut texts = GlyphTexts::default();
    let mut at = 4;
    for _ in 0..read_u32(0) {
        let len = read_u32(at) as usize;
        decode(&envelope[at + 4..at + 4 + len], &mut texts).unwrap();
        at += 4 + len;
    }
    texts
}

/// The text a run shows in logical order: its clusters' slices, each once, by text position.
fn logical_text(glyphs: &[String], ranges: &[Range<usize>]) -> String {
    let mut clusters: Vec<(usize, &str)> = ranges
        .iter()
        .zip(glyphs)
        .map(|(r, g)| (r.start, g.as_str()))
        .collect();
    clusters.sort_by_key(|&(start, _)| start);
    clusters.dedup_by_key(|&mut (start, _)| start);
    clusters.into_iter().map(|(_, g)| g).collect()
}

#[test]
fn pdf_glyph_runs_carry_the_text_they_were_shaped_from() {
    let texts = print_glyph_texts(
        "<!DOCTYPE html><style>body{margin:0;font:20px 'Noto Sans'}</style>\
         <p>office fine</p><p><bdo dir=rtl>abc</bdo></p>",
    );
    assert!(!texts.runs.is_empty(), "the page must paint glyphs");
    for (glyphs, text) in &texts.runs {
        let text = text.as_ref().expect("every glyph run carries its text");
        assert_eq!(text.len(), *glyphs);
    }
    let shown: Vec<String> = texts
        .runs
        .iter()
        .zip(&texts.ranges)
        .map(|((_, text), ranges)| logical_text(text.as_ref().unwrap(), ranges))
        .collect();
    let ligatures = texts.runs.iter().flat_map(|(_, t)| t.iter().flatten());
    assert!(
        ligatures.filter(|g| *g == "ffi" || *g == "fi").count() == 2,
        "each ligature glyph shows all its letters"
    );
    assert!(shown.iter().any(|t| t == "office fine"), "got {shown:?}");
    assert!(shown.iter().any(|t| t == "abc"), "got {shown:?}");
    let (_, rtl) = texts
        .runs
        .iter()
        .find(|(_, t)| t.as_ref().unwrap().concat() == "cba")
        .expect("the overridden run is drawn right to left");
    let rtl: Vec<&str> = rtl
        .iter()
        .flatten()
        .map(String::as_str)
        .filter(|g| !g.is_empty())
        .collect();
    assert_eq!(rtl, ["c", "b", "a"]);
}

#[test]
fn screenshots_record_no_glyph_text() {
    let dom = DomHandle::new("<p>office fine</p>", "https://test.example/");
    dom.set_viewport(300, 100);
    dom.resolve_layout();
    let scene = dom.render_scene_clip(0, 0, 300, 100, false, true, false);
    let mut texts = GlyphTexts::default();
    decode(&scene, &mut texts).unwrap();
    assert!(texts.ranges.is_empty());
}
