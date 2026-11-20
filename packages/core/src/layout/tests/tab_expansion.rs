// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use parley::layout::PositionedLayoutItem;
use parley::style::{FontFamily, GenericFamily, TextStyle};
use parley::LayoutContext;

use crate::resources::fonts::make_font_context;

type Brush = u32;

#[test]
fn tab_advances_to_tab_stops() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();

    let root_style = TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_text("\tA\n\t\tB");
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(800.0));

    let lines: Vec<_> = layout.lines().collect();
    assert_eq!(lines.len(), 2, "two lines expected");

    let first_stop = lines[0]
        .runs()
        .next()
        .unwrap()
        .clusters()
        .next()
        .unwrap()
        .advance();
    assert!(first_stop > 0.0, "tab must carry a positive advance");

    for (line_idx, line) in lines.iter().enumerate() {
        let mut runs = line.runs();
        let run = runs.next().unwrap();
        let clusters: Vec<_> = run.clusters().collect();
        let tab_advance = clusters[0].advance();
        assert!(
            (tab_advance - first_stop).abs() < 0.01,
            "line {} first tab advance {} != one stop {}",
            line_idx,
            tab_advance,
            first_stop
        );

        let glyphs: Vec<_> = line
            .items()
            .filter_map(|item| match item {
                PositionedLayoutItem::GlyphRun(run) => {
                    Some(run.positioned_glyphs().collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect();
        let expected = first_stop * (1 + line_idx) as f32;
        assert_eq!(glyphs.len(), 2 + line_idx, "tabs + one letter");
        assert!(
            (glyphs[0].advance - first_stop).abs() < 0.01,
            "line {} tab glyph advance {} != {}",
            line_idx,
            glyphs[0].advance,
            first_stop
        );
        assert!(
            (glyphs.last().unwrap().x - expected).abs() < 0.01,
            "line {} letter x {} != stop {}",
            line_idx,
            glyphs.last().unwrap().x,
            expected
        );
    }
}

#[test]
fn tab_advances_honor_explicit_tab_size() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();

    let mut root_style = TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };

    let stop8 = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);

    root_style.tab_size = parley::style::TabSize::Px(24.0);
    let stop_px = tab_advance_of(&mut fcx, &mut lcx, &root_style, 2.0);
    assert!(
        (stop_px - 48.0).abs() < 0.01,
        "Px(24.0) at scale 2 must advance 48.0, got {stop_px}"
    );

    root_style.tab_size = parley::style::TabSize::Chars(4.0);
    let stop4 = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);
    assert!(
        (stop4 - stop8 / 2.0).abs() < 0.01,
        "Chars(4) tab must advance half of Chars(8): {stop4} vs {stop8}"
    );
}

#[test]
fn intrinsic_max_width_includes_the_tab_stop() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();
    let root_style = root_style();
    let stop = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);

    let letter = max_content_width(&mut fcx, &mut lcx, "X");
    let tabbed = max_content_width(&mut fcx, &mut lcx, "\tX");
    assert!(
        (tabbed - (letter + stop)).abs() < 0.01,
        "max content width of \"\\tX\" ({tabbed}) != \"X\" ({letter}) + one stop ({stop})"
    );

    let spaced = max_content_width(&mut fcx, &mut lcx, " X");
    assert!(
        spaced < tabbed - 1.0,
        "one space ({spaced}) must measure well under one tab stop ({tabbed})"
    );
}

#[test]
fn trailing_tab_hangs_conditionally() {
    // Parley's default `Preserve` is `white-space: pre-wrap`, where trailing
    // whitespace hangs conditionally (CSS Text 4 § 4.3.2): min-content drops
    // it, max-content keeps it. The tab advances from the pen to the next
    // stop, so "X\t" is exactly one stop wide at max-content.
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();

    let letter = content_widths(&mut fcx, &mut lcx, "X");
    let stop = content_widths(&mut fcx, &mut lcx, "\tX").max - letter.max;
    let trailing = content_widths(&mut fcx, &mut lcx, "X\t");
    assert!(
        (trailing.min - letter.min).abs() < 0.01,
        "trailing tab must not widen min-content: {} vs {}",
        trailing.min,
        letter.min
    );
    assert!(
        (trailing.max - stop).abs() < 0.01,
        "trailing tab must end max-content on the next stop: {} vs {stop}",
        trailing.max
    );
}

#[test]
fn tab_near_a_stop_advances_to_the_following_stop() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();
    let root_style = root_style();
    let stop = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);
    let prefix = max_content_width(&mut fcx, &mut lcx, "iiiiiiii");
    let remaining = stop - prefix;

    assert!(
        remaining > 0.0 && remaining < stop / 16.0,
        "test prefix must end within half a space of the stop: prefix={prefix}, stop={stop}"
    );

    let near = layout_of(&mut fcx, &mut lcx, "iiiiiiii\tX", Some(800.0));
    let near_x = line_geometry(&near)[0].1.last().copied().unwrap();
    assert!(
        (near_x - 2.0 * stop).abs() < 0.01,
        "near-stop tab must move X to the following stop: x={near_x}, stop={stop}"
    );
    let letter = max_content_width(&mut fcx, &mut lcx, "X");
    let near_width = max_content_width(&mut fcx, &mut lcx, "iiiiiiii\tX");
    assert!(
        (near_width - (2.0 * stop + letter)).abs() < 0.01,
        "intrinsic width ({near_width}) must use the following stop ({})",
        2.0 * stop + letter
    );

    let far = layout_of(&mut fcx, &mut lcx, "ii\tX", Some(800.0));
    let far_x = line_geometry(&far)[0].1.last().copied().unwrap();
    assert!(
        (far_x - stop).abs() < 0.01,
        "ordinary tab must move X to the first stop: x={far_x}, stop={stop}"
    );
}

#[test]
fn constrained_break_accounts_for_the_expanded_tab() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();
    let root_style = root_style();
    let stop = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);
    let word = max_content_width(&mut fcx, &mut lcx, "AAAA");
    let max_advance = stop + word + 1.0;

    let layout = layout_of(&mut fcx, &mut lcx, "\tAAAA BBBB", Some(max_advance));
    let lines: Vec<_> = layout.lines().collect();
    assert_eq!(
        lines.len(),
        2,
        "the expanded tab must push the second word onto its own line"
    );
    let first = lines[0].metrics();
    assert!(
        first.advance - first.hanging_advance <= max_advance + 0.01,
        "first line ({}) must fit the constraint ({max_advance})",
        first.advance - first.hanging_advance
    );
}

#[test]
fn rebreaking_matches_a_freshly_built_layout() {
    let mut fcx = make_font_context();
    let mut lcx: LayoutContext<Brush> = LayoutContext::new();
    let root_style = root_style();
    let stop = tab_advance_of(&mut fcx, &mut lcx, &root_style, 1.0);
    let word = max_content_width(&mut fcx, &mut lcx, "AAAA");
    let max_advance = stop + word + 1.0;
    let text = "\tAAAA BBBB";

    let mut reused = layout_of(&mut fcx, &mut lcx, text, Some(max_advance * 4.0));
    reused.break_all_lines(Some(max_advance));
    let fresh = layout_of(&mut fcx, &mut lcx, text, Some(max_advance));

    let reused_geometry = line_geometry(&reused);
    let fresh_geometry = line_geometry(&fresh);
    assert_eq!(
        reused_geometry.len(),
        fresh_geometry.len(),
        "line count changed on rebreak"
    );
    for (idx, (reused_line, fresh_line)) in reused_geometry
        .iter()
        .zip(fresh_geometry.iter())
        .enumerate()
    {
        assert!(
            (reused_line.0 - fresh_line.0).abs() < 0.01,
            "line {idx} advance {} != fresh {}",
            reused_line.0,
            fresh_line.0
        );
        assert_eq!(
            reused_line.1.len(),
            fresh_line.1.len(),
            "line {idx} glyph count changed on rebreak"
        );
        for (glyph_idx, (reused_x, fresh_x)) in
            reused_line.1.iter().zip(fresh_line.1.iter()).enumerate()
        {
            assert!(
                (reused_x - fresh_x).abs() < 0.01,
                "line {idx} glyph {glyph_idx} x {reused_x} != fresh {fresh_x}"
            );
        }
    }
}

fn root_style() -> TextStyle<'static, 'static, Brush> {
    TextStyle {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    }
}

fn layout_of(
    fcx: &mut parley::FontContext,
    lcx: &mut LayoutContext<Brush>,
    text: &str,
    max_advance: Option<f32>,
) -> parley::Layout<Brush> {
    let root_style = root_style();
    let mut tb = lcx.tree_builder(fcx, 1.0, true, &root_style);
    tb.push_text(text);
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(max_advance);
    layout
}

fn max_content_width(
    fcx: &mut parley::FontContext,
    lcx: &mut LayoutContext<Brush>,
    text: &str,
) -> f32 {
    content_widths(fcx, lcx, text).max
}

fn content_widths(
    fcx: &mut parley::FontContext,
    lcx: &mut LayoutContext<Brush>,
    text: &str,
) -> parley::ContentWidths {
    let root_style = root_style();
    let mut tb = lcx.tree_builder(fcx, 1.0, true, &root_style);
    tb.push_text(text);
    let (layout, _text) = tb.build();
    layout.calculate_content_widths()
}

fn line_geometry(layout: &parley::Layout<Brush>) -> Vec<(f32, Vec<f32>)> {
    layout
        .lines()
        .map(|line| {
            let glyphs: Vec<f32> = line
                .items()
                .filter_map(|item| match item {
                    PositionedLayoutItem::GlyphRun(run) => {
                        Some(run.positioned_glyphs().map(|g| g.x).collect::<Vec<_>>())
                    }
                    _ => None,
                })
                .flatten()
                .collect();
            (line.metrics().advance, glyphs)
        })
        .collect()
}

fn tab_advance_of(
    fcx: &mut parley::FontContext,
    lcx: &mut LayoutContext<Brush>,
    root_style: &TextStyle<'_, '_, Brush>,
    scale: f32,
) -> f32 {
    let mut tb = lcx.tree_builder(fcx, scale, true, root_style);
    tb.push_text("\tA");
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(800.0));
    let line = layout.lines().next().unwrap();
    let mut runs = line.runs();
    let run = runs.next().unwrap();
    let clusters: Vec<_> = run.clusters().collect();
    clusters[0].advance()
}
