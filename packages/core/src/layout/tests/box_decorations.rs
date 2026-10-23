// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use parley::style::{BorderRadius, BoxDecorations, FontFamily, GenericFamily};

use crate::resources::fonts::make_font_context;

type Brush = u32;

#[test]
fn no_decorations_emits_no_fragments() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_text("Hello world");
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert!(
        layout.span_fragments().is_empty(),
        "no decorations should produce no span fragments, got {:?}",
        layout.span_fragments()
    );
}

#[test]
fn background_only_span_emits_single_line_fragment() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let span_style = parley::style::TextStyle {
        brush: 42,
        box_decorations: BoxDecorations {
            background_brush: Some(42),
            ..Default::default()
        },
        ..root_style.clone()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(span_style);
    tb.push_text("text");
    tb.pop_style_span();
    let (mut layout, _) = tb.build();
    layout.break_all_lines(Some(800.0));

    let (leads, trails) = layout.debug_cluster_sidecars();
    assert!(
        leads.is_empty() && trails.is_empty(),
        "background-only spans need fragment boundaries, not per-cluster advances"
    );

    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        1,
        "background-only span must emit a fragment"
    );
    assert_eq!(fragments[0].line_index, 0);
    assert!(fragments[0].x_end > fragments[0].x_start);
}

fn build_bidi_layout_with_spans(
    fcx: &mut parley::FontContext,
    lcx: &mut parley::LayoutContext<Brush>,
    direction: parley::BaseDirection,
    max_width: f32,
    segments: &[(&str, Option<Brush>)],
) -> (parley::Layout<Brush>, String) {
    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let mut tb = lcx.tree_builder(fcx, 1.0, true, &root_style);
    tb.set_base_direction(direction);
    for &(text, background_brush) in segments {
        if let Some(background_brush) = background_brush {
            let span_style = parley::style::TextStyle {
                brush: background_brush,
                box_decorations: BoxDecorations {
                    background_brush: Some(background_brush),
                    ..Default::default()
                },
                ..root_style.clone()
            };
            tb.push_style_span(span_style);
            tb.push_text(text);
            tb.pop_style_span();
        } else {
            tb.push_text(text);
        }
    }
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(max_width));
    (layout, text)
}

fn assert_spans_have_fragments(layout: &parley::Layout<Brush>, expected_brushes: &[Brush]) {
    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        expected_brushes.len(),
        "unexpected span fragments: {fragments:?}"
    );

    let mut expected_styles: Vec<_> = expected_brushes
        .iter()
        .map(|brush| style_index_for_brush(layout, *brush))
        .collect();
    let mut fragment_styles: Vec<_> = fragments
        .iter()
        .map(|fragment| {
            assert!(
                fragment.x_end > fragment.x_start,
                "empty span fragment: {fragment:?}"
            );
            fragment.style_index
        })
        .collect();
    expected_styles.sort_unstable();
    fragment_styles.sort_unstable();
    assert_eq!(
        fragment_styles, expected_styles,
        "each decorated span must get a fragment"
    );
}

fn style_index_for_brush(layout: &parley::Layout<Brush>, brush: Brush) -> u16 {
    let index = layout
        .styles()
        .iter()
        .position(|style| style.brush == brush)
        .unwrap_or_else(|| panic!("no style with brush {brush}"));
    u16::try_from(index).expect("style index fits u16")
}

fn fragment_for_brush(
    layout: &parley::Layout<Brush>,
    brush: Brush,
) -> &parley::layout::SpanFragment {
    let style_index = style_index_for_brush(layout, brush);
    layout
        .span_fragments()
        .iter()
        .find(|fragment| fragment.style_index == style_index)
        .unwrap_or_else(|| panic!("no span fragment for brush {brush}"))
}

fn assert_fragment_covers_line(
    layout: &parley::Layout<Brush>,
    fragment: &parley::layout::SpanFragment,
) {
    assert_eq!(fragment.line_index, 0);
    assert!(
        fragment.x_start.abs() < 0.5,
        "fragment should start at the line origin: {fragment:?}"
    );
    assert!(
        (fragment.x_end - layout.full_width()).abs() < 0.5,
        "fragment should cover the full line width ({}): {fragment:?}",
        layout.full_width()
    );
}

#[test]
fn bidi_reordered_spans_each_emit_a_fragment() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let (ltr_layout, ltr_text) = build_bidi_layout_with_spans(
        &mut fcx,
        &mut lcx,
        parley::BaseDirection::Ltr,
        800.0,
        &[("before ", None), ("שלום", Some(1)), (" after", None)],
    );
    assert_eq!(ltr_text, "before שלום after");
    assert_spans_have_fragments(&ltr_layout, &[1]);

    let (rtl_layout, rtl_text) = build_bidi_layout_with_spans(
        &mut fcx,
        &mut lcx,
        parley::BaseDirection::Rtl,
        800.0,
        &[("שלום", Some(1)), (" ", None), ("abc", Some(2))],
    );
    assert_eq!(rtl_text, "שלום abc");
    assert_spans_have_fragments(&rtl_layout, &[1, 2]);
    assert!(
        fragment_for_brush(&rtl_layout, 2).x_start < fragment_for_brush(&rtl_layout, 1).x_start,
        "the Latin span must appear left of the Hebrew span in the RTL visual order: {:?}",
        rtl_layout.span_fragments()
    );
}

#[test]
fn rtl_reordered_spans_and_later_ltr_line_keep_fragments() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let (layout, text) = build_bidi_layout_with_spans(
        &mut fcx,
        &mut lcx,
        parley::BaseDirection::Rtl,
        80.0,
        &[
            ("שלום", Some(1)),
            (" ", None),
            ("abc", Some(2)),
            (" ", None),
            ("later", Some(3)),
        ],
    );

    assert_eq!(text, "שלום abc later");
    assert_spans_have_fragments(&layout, &[1, 2, 3]);
    let hebrew_fragment = fragment_for_brush(&layout, 1);
    let latin_fragment = fragment_for_brush(&layout, 2);
    assert_eq!(hebrew_fragment.line_index, 0);
    assert_eq!(latin_fragment.line_index, 0);
    assert!(
        latin_fragment.x_start < hebrew_fragment.x_start,
        "the Latin span must appear left of the Hebrew span on the first RTL line: {:?}",
        layout.span_fragments()
    );
    assert_eq!(
        fragment_for_brush(&layout, 3).line_index,
        1,
        "the later pure-LTR span should survive on its wrapped line: {:?}",
        layout.span_fragments()
    );
}

#[test]
fn decorated_parent_starts_at_leading_child_text() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let mark_style = parley::style::TextStyle {
        brush: 1,
        box_decorations: BoxDecorations {
            background_brush: Some(1),
            ..Default::default()
        },
        ..root_style.clone()
    };
    let child_style = parley::style::TextStyle {
        brush: 2,
        ..root_style.clone()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(mark_style);
    tb.push_style_span(child_style);
    tb.push_text("x");
    tb.pop_style_span();
    tb.push_text(" y");
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "x y");
    assert_fragment_covers_line(&layout, fragment_for_brush(&layout, 1));
}

#[test]
fn decorated_parent_closes_after_trailing_child_text() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let span_style = parley::style::TextStyle {
        brush: 1,
        box_decorations: BoxDecorations {
            background_brush: Some(1),
            ..Default::default()
        },
        ..root_style.clone()
    };
    let child_style = parley::style::TextStyle {
        brush: 2,
        ..root_style.clone()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(span_style);
    tb.push_text("a ");
    tb.push_style_span(child_style);
    tb.push_text("b");
    tb.pop_style_span();
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "a b");
    assert_fragment_covers_line(&layout, fragment_for_brush(&layout, 1));
}

#[test]
fn padded_parent_closes_around_background_span_with_trailing_child() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    let outer_style = parley::style::TextStyle {
        brush: 1,
        box_decorations: BoxDecorations {
            padding_inline_start: 3.0,
            padding_inline_end: 4.0,
            border_inline_start_width: 1.0,
            border_inline_end_width: 2.0,
            ..Default::default()
        },
        ..root_style.clone()
    };
    let background_style = parley::style::TextStyle {
        brush: 2,
        box_decorations: BoxDecorations {
            background_brush: Some(2),
            ..Default::default()
        },
        ..root_style.clone()
    };
    let child_style = parley::style::TextStyle {
        brush: 3,
        ..root_style.clone()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(outer_style);
    tb.push_text("before ");
    tb.push_style_span(background_style);
    tb.push_text("a ");
    tb.push_style_span(child_style);
    tb.push_text("b");
    tb.pop_style_span();
    tb.pop_style_span();
    tb.push_text(" after");
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "before a b after");
    assert_spans_have_fragments(&layout, &[1, 2]);
    assert_fragment_covers_line(&layout, fragment_for_brush(&layout, 1));
    let background_fragment = fragment_for_brush(&layout, 2);
    assert!(
        background_fragment.x_end > background_fragment.x_start,
        "the nested background span should close after its child: {background_fragment:?}"
    );
}

#[test]
fn styled_span_emits_single_line_fragment() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };

    let mut span_style = root_style.clone();
    span_style.brush = 42;
    span_style.box_decorations = BoxDecorations {
        padding_inline_start: 7.0,
        padding_inline_end: 7.0,
        padding_block_start: 3.0,
        padding_block_end: 3.0,
        border_inline_start_width: 1.0,
        border_inline_end_width: 1.0,
        border_block_start_width: 1.0,
        border_block_end_width: 1.0,
        border_inline_start_brush: None,
        border_inline_end_brush: None,
        border_block_start_brush: None,
        border_block_end_brush: None,
        background_brush: None,
        border_radius: BorderRadius::all(3.0),
    };
    assert!(
        !span_style.box_decorations.is_empty(),
        "test setup: span_style.box_decorations should be non-empty"
    );

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(span_style);
    tb.push_text("All");
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "All", "tree built the expected text");

    let width_with_decos = layout.full_width();

    let mut lcx2: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let mut tb2 = lcx2.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb2.push_style_span(root_style.clone());
    tb2.push_text("All");
    tb2.pop_style_span();
    let (mut bare, _) = tb2.build();
    bare.break_all_lines(Some(800.0));
    let width_without_decos = bare.full_width();

    let delta = width_with_decos - width_without_decos;
    assert!(
        (delta - 16.0).abs() < 0.5,
        "expected layout to grow by ~16px (lead 8 + trail 8) for the styled span; \
         got with={}, without={}, delta={}",
        width_with_decos,
        width_without_decos,
        delta
    );

    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        1,
        "expected exactly one SpanFragment for a single-line styled span, got {:?}",
        fragments
    );
    let frag = fragments[0];
    assert_eq!(frag.line_index, 0, "fragment should be on line 0");
    assert!(
        frag.is_first_fragment && frag.is_last_fragment,
        "single-line fragment should have both first/last flags set: {:?}",
        frag
    );
    assert!(
        frag.x_end > frag.x_start,
        "fragment should have positive width: {:?}",
        frag
    );
    let frag_width = frag.x_end - frag.x_start;
    assert!(
        (frag_width - width_with_decos).abs() < 1.0,
        "fragment width ({}) should match layout's full_width ({}) for a span \
         that fills the layout",
        frag_width,
        width_with_decos
    );
}

#[test]
fn nested_styled_spans_emit_separate_fragments() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };

    let mut outer = root_style.clone();
    outer.brush = 1;
    outer.box_decorations = BoxDecorations {
        padding_inline_start: 5.0,
        padding_inline_end: 5.0,
        ..Default::default()
    };

    let mut inner = root_style.clone();
    inner.brush = 2;
    inner.box_decorations = BoxDecorations {
        padding_inline_start: 2.0,
        padding_inline_end: 2.0,
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(outer);
    tb.push_text("foo");
    tb.push_style_span(inner);
    tb.push_text("bar");
    tb.pop_style_span();
    tb.push_text("baz");
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "foobarbaz");

    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        2,
        "expected two fragments (one per styled span), got {:?}",
        fragments
    );

    let widths: Vec<_> = fragments
        .iter()
        .map(|f| (f.x_end - f.x_start) as i32)
        .collect();
    assert!(
        widths[0] != widths[1] || fragments[0].x_start != fragments[1].x_start,
        "fragments should be distinguishable by geometry: {:?}",
        fragments
    );
}

#[test]
fn pill_topology_emits_fragment() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };
    assert!(
        root_style.box_decorations.is_empty(),
        "root (<li>) should have empty decorations"
    );

    let mut a_style = root_style.clone();
    a_style.brush = 99;
    a_style.box_decorations = BoxDecorations {
        padding_inline_start: 7.0,
        padding_inline_end: 7.0,
        padding_block_start: 3.0,
        padding_block_end: 3.0,
        border_inline_start_width: 1.0,
        border_inline_end_width: 1.0,
        border_block_start_width: 1.0,
        border_block_end_width: 1.0,
        border_radius: BorderRadius::all(3.0),
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(a_style);
    tb.push_text("All");
    tb.pop_style_span();
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "All");

    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        1,
        "<li><a>All</a></li> should emit exactly one fragment for the <a>; got {:?}",
        fragments
    );
    let frag = fragments[0];
    assert!(
        frag.is_first_fragment && frag.is_last_fragment,
        "single-line single-span fragment should have both flags: {:?}",
        frag
    );

    let with_decos = layout.full_width();

    let mut lcx2: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let bare_style = root_style.clone();
    let mut tb2 = lcx2.tree_builder(&mut fcx, 1.0, true, &bare_style);
    tb2.push_style_span(bare_style.clone());
    tb2.push_text("All");
    tb2.pop_style_span();
    let (mut bare, _) = tb2.build();
    bare.break_all_lines(Some(800.0));
    let without = bare.full_width();

    assert!(
        (with_decos - without - 16.0).abs() < 0.5,
        "pill should be 16px wider than bare text; with={}, without={}",
        with_decos,
        without
    );
}

#[test]
fn pill_in_paragraph_aligns_with_following_text() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };

    let mut pill_style = root_style.clone();
    pill_style.brush = 99;
    pill_style.box_decorations = BoxDecorations {
        padding_inline_start: 12.0,
        padding_inline_end: 12.0,
        padding_block_start: 6.0,
        padding_block_end: 6.0,
        border_inline_start_width: 2.0,
        border_inline_end_width: 2.0,
        border_block_start_width: 2.0,
        border_block_end_width: 2.0,
        border_radius: BorderRadius::all(6.0),
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_text("Before ");
    tb.push_style_span(pill_style);
    tb.push_text("PILL");
    tb.pop_style_span();
    tb.push_text(" after.");
    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "Before PILL after.");

    let fragments = layout.span_fragments();
    assert_eq!(
        fragments.len(),
        1,
        "expected one pill fragment; got {:?}",
        fragments
    );
    let frag = fragments[0];

    let frag_width = frag.x_end - frag.x_start;
    assert!(
        frag_width > 50.0 && frag_width < 70.0,
        "fragment width should be 28+~30 = ~58px; got {}",
        frag_width
    );

    let line = layout.lines().next().expect("at least one line");
    let mut glyph_runs_seen = 0;
    let mut seen_pill = false;
    let mut last_pill_glyph_right = 0.0_f32;
    let mut first_after_glyph_left = f32::INFINITY;
    for item in line.items() {
        if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
            glyph_runs_seen += 1;
            let style = gr.style();
            let text_x_start = gr.offset();
            let text_x_end = text_x_start + gr.advance();
            if style.brush == 99 {
                seen_pill = true;
                last_pill_glyph_right = last_pill_glyph_right.max(text_x_end);
                let positions: std::vec::Vec<(f32, f32)> =
                    gr.positioned_glyphs().map(|g| (g.x, g.advance)).collect();
                eprintln!(
                    "pill glyph run: offset={}, advance={}, glyphs={:?}",
                    text_x_start,
                    gr.advance(),
                    positions
                );
            } else if seen_pill && first_after_glyph_left == f32::INFINITY {
                first_after_glyph_left = text_x_start;
            }
        }
    }
    assert!(glyph_runs_seen > 0, "expected at least one glyph run");

    eprintln!(
        "frag.x_start={}, frag.x_end={}, last_pill_glyph_right={}, first_after_glyph_left={}",
        frag.x_start, frag.x_end, last_pill_glyph_right, first_after_glyph_left
    );
    assert!(
        first_after_glyph_left.is_finite(),
        "should have found at least one root-style glyph after the pill"
    );
    assert!(
        first_after_glyph_left >= frag.x_end - 0.5,
        "post-pill text should start at or after the pill's right edge ({}); \
         got post-pill text starting at {}. This is the visible \
         'after. overlaps the pill' bug.",
        frag.x_end,
        first_after_glyph_left
    );
}

#[test]
fn one_pill_with_text_around_aligns_correctly() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 14.0,
        ..Default::default()
    };

    let mut pill_style = root_style.clone();
    pill_style.brush = 101;
    pill_style.box_decorations = BoxDecorations {
        padding_inline_start: 7.0,
        padding_inline_end: 7.0,
        border_inline_start_width: 1.0,
        border_inline_end_width: 1.0,
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_text("1 item left! ");
    tb.push_style_span(pill_style);
    tb.push_text("All");
    tb.pop_style_span();
    tb.push_text(" rest");
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(800.0));

    let fragments = layout.span_fragments();
    eprintln!("=== one_pill fragments ===");
    for f in fragments {
        eprintln!(
            "  frag: x_start={}, x_end={}, width={}",
            f.x_start,
            f.x_end,
            f.x_end - f.x_start
        );
    }
    eprintln!("=== one_pill cluster sidecars + advances ===");
    let (leads, trails) = layout.debug_cluster_sidecars();
    let clusters = layout.debug_clusters();
    for (i, (adv, text_off, style_idx, glen)) in clusters.iter().copied().enumerate() {
        let lead = leads.get(i).copied().unwrap_or(0.0);
        let trail = trails.get(i).copied().unwrap_or(0.0);
        if lead > 0.0 || trail > 0.0 || style_idx != 0 {
            eprintln!(
                "  cluster #{}: advance={}, text_offset={}, style_index={}, glyph_len={}, lead={}, trail={}",
                i, adv, text_off, style_idx, glen, lead, trail
            );
        }
    }
    let line = layout.lines().next().unwrap();
    eprintln!("=== one_pill glyph runs ===");
    for item in line.items() {
        if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
            eprintln!(
                "  brush={}, offset={}, advance={}",
                gr.style().brush,
                gr.offset(),
                gr.advance()
            );
        }
    }

    assert_eq!(fragments.len(), 1, "expected one pill fragment");
    let frag = fragments[0];
    let frag_width = frag.x_end - frag.x_start;
    assert!(
        frag_width > 28.0 && frag_width < 40.0,
        "fragment width should include lead+trail (~32-34); got {}",
        frag_width
    );

    let line = layout.lines().next().unwrap();
    let mut runs: std::vec::Vec<(u32, f32, f32)> = std::vec::Vec::new();
    for item in line.items() {
        if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
            runs.push((gr.style().brush, gr.offset(), gr.offset() + gr.advance()));
        }
    }
    let post_pill_x = runs
        .iter()
        .skip_while(|(b, _, _)| *b != 101)
        .skip(1)
        .find(|(b, _, _)| *b == 0)
        .map(|(_, x, _)| *x);
    assert!(
        post_pill_x.is_some(),
        "should have found a post-pill glyph run"
    );
    assert!(
        (post_pill_x.unwrap() - frag.x_end).abs() < 1.0,
        "post-pill text should start at fragment.x_end ({}); got {}",
        frag.x_end,
        post_pill_x.unwrap()
    );
}

#[test]
fn todomvc_footer_topology_emits_three_correctly_positioned_fragments() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 14.0,
        ..Default::default()
    };

    let mut pill_style = root_style.clone();
    pill_style.brush = 100;
    pill_style.box_decorations = BoxDecorations {
        padding_inline_start: 7.0,
        padding_inline_end: 7.0,
        padding_block_start: 3.0,
        padding_block_end: 3.0,
        border_inline_start_width: 1.0,
        border_inline_end_width: 1.0,
        border_block_start_width: 1.0,
        border_block_end_width: 1.0,
        border_radius: BorderRadius::all(3.0),
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_text("1 item left! ");

    let mut a1 = pill_style.clone();
    a1.brush = 101;
    tb.push_style_span(a1);
    tb.push_text("All");
    tb.pop_style_span();
    tb.push_text(" ");

    let mut a2 = pill_style.clone();
    a2.brush = 102;
    tb.push_style_span(a2);
    tb.push_text("Active");
    tb.pop_style_span();
    tb.push_text(" ");

    let mut a3 = pill_style.clone();
    a3.brush = 103;
    tb.push_style_span(a3);
    tb.push_text("Completed");
    tb.pop_style_span();
    tb.push_text(" Clear completed");

    let (mut layout, text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert_eq!(text, "1 item left! All Active Completed Clear completed");

    let fragments = layout.span_fragments();

    eprintln!(
        "=== todomvc_footer fragments ({} total) ===",
        fragments.len()
    );
    for (i, f) in fragments.iter().enumerate() {
        eprintln!(
            "  frag #{}: style_index={}, line={}, x_start={}, x_end={}, first={}, last={}",
            i,
            f.style_index,
            f.line_index,
            f.x_start,
            f.x_end,
            f.is_first_fragment,
            f.is_last_fragment
        );
    }

    let line = layout.lines().next().expect("one line");
    eprintln!(
        "=== line metrics: inline_min={}, inline_max={}, block_min={}, block_max={} ===",
        line.metrics().inline_min_coord,
        line.metrics().inline_max_coord,
        line.metrics().block_min_coord,
        line.metrics().block_max_coord
    );
    let mut pill_glyph_runs: std::vec::Vec<(u32, f32, f32)> = std::vec::Vec::new();
    for item in line.items() {
        if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
            let s = gr.style();
            eprintln!(
                "  glyph run: brush={}, offset={}, advance={}",
                s.brush,
                gr.offset(),
                gr.advance()
            );
            if s.brush >= 100 {
                pill_glyph_runs.push((s.brush, gr.offset(), gr.offset() + gr.advance()));
            }
        }
    }

    assert_eq!(
        fragments.len(),
        3,
        "expected 3 pill fragments (All/Active/Completed); got {}: {:?}",
        fragments.len(),
        fragments
    );

    assert_eq!(
        pill_glyph_runs.len(),
        3,
        "expected 3 pill glyph runs; got {:?}",
        pill_glyph_runs
    );

    for (i, frag) in fragments.iter().enumerate() {
        let (brush, glyph_x_start, glyph_x_end) = pill_glyph_runs[i];

        let style = layout
            .styles()
            .get(frag.style_index as usize)
            .expect("fragment's style_index in range");
        assert_eq!(
            style.brush, brush,
            "fragment #{} brush should match its glyph run's brush",
            i
        );

        assert!(
            (frag.x_start - glyph_x_start).abs() < 1.0,
            "fragment #{} x_start ({}) should match glyph run offset ({})",
            i,
            frag.x_start,
            glyph_x_start
        );
        assert!(
            (frag.x_end - glyph_x_end).abs() < 1.0,
            "fragment #{} x_end ({}) should match glyph run end ({})",
            i,
            frag.x_end,
            glyph_x_end
        );
    }

    for (i, f) in fragments.iter().enumerate() {
        assert_eq!(f.line_index, 0, "fragment #{} should be on line 0", i);
    }

    assert!(
        fragments[0].x_end <= fragments[1].x_start && fragments[1].x_end <= fragments[2].x_start,
        "fragments should be left-to-right with no overlap: {:?}",
        fragments
    );

    assert!(
        fragments[0].x_start > 50.0,
        "fragment #0 should follow the leading text; got x={}",
        fragments[0].x_start
    );
}

#[test]
fn block_only_padding_emits_no_fragment_today() {
    let mut fcx = make_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();

    let root_style = parley::style::TextStyle::<'_, '_, Brush> {
        font_family: FontFamily::Single(GenericFamily::SansSerif.into()),
        font_size: 16.0,
        ..Default::default()
    };

    let mut span_style = root_style.clone();
    span_style.box_decorations = BoxDecorations {
        padding_block_start: 10.0,
        padding_block_end: 10.0,
        ..Default::default()
    };

    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &root_style);
    tb.push_style_span(span_style);
    tb.push_text("Hello");
    tb.pop_style_span();
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(Some(800.0));

    assert!(
        layout.span_fragments().is_empty(),
        "block-only padding should not emit a fragment; got {:?}",
        layout.span_fragments()
    );
}
