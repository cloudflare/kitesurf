// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use parley::style::{FontFamily, GenericFamily};

use crate::resources::fonts::make_font_context;

type Brush = u32;

type Shaped = (
    Vec<(u32, f32, f32, f32)>,
    Vec<(std::ops::Range<usize>, f32)>,
);

fn shape(
    fcx: &mut parley::FontContext,
    lcx: &mut parley::LayoutContext<Brush>,
    family: GenericFamily,
    text: &str,
) -> Shaped {
    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(family.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let mut tb = lcx.tree_builder(fcx, 1.0, true, &root_style);
    tb.push_text(text);
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(100_000.0));
    let mut shaped = Shaped::default();
    for line in layout.lines() {
        for item in line.items() {
            if let parley::layout::PositionedLayoutItem::GlyphRun(run) = item {
                shaped
                    .0
                    .extend(run.positioned_glyphs().map(|g| (g.id, g.x, g.y, g.advance)));
                shaped
                    .1
                    .extend(run.run().clusters().map(|c| (c.text_range(), c.advance())));
            }
        }
    }
    shaped
}

#[test]
fn words_reused_from_earlier_runs_shape_like_the_whole_run() {
    // Kerning pairs, ligatures, digits, punctuation, marks on spaces and letters, then the same
    // words reordered so each is reused next to different neighbours.
    let seen = "AVATAR To Yo office fly 1/2 W.A.V. (Tę) naïve \u{0301}x Ωμέγα Жук  two  spaces";
    let reordered = "Ωμέγα naïve spaces \u{0301}x office (Tę) Yo  W.A.V. AVATAR two fly 1/2 Жук To";
    let mut fcx = make_font_context();
    for family in [
        GenericFamily::SansSerif,
        GenericFamily::Serif,
        GenericFamily::Monospace,
    ] {
        let fresh = shape(
            &mut fcx,
            &mut parley::LayoutContext::new(),
            family,
            reordered,
        );
        let mut warm = parley::LayoutContext::new();
        shape(&mut fcx, &mut warm, family, seen);
        assert_eq!(
            shape(&mut fcx, &mut warm, family, reordered),
            fresh,
            "{family:?}"
        );
    }
}
