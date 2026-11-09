// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Splits document content into printable vertical bands and records paint scenes for each page.

use std::collections::HashMap;

use crate::layout::geometry::doc_position;
use crate::paint::scene_record::ImageInfo;

const MAX_PAGES: u32 = 200;

pub(crate) fn compute_page_bands(doc: &blitz_dom::BaseDocument, height: u32) -> Vec<(f64, f64)> {
    let node_ranges = collect_node_y_ranges(doc);
    let unbreakable = merge_break_intervals(&node_ranges, height as f32 * 0.5);

    let (forced_breaks, avoid_ranges) = collect_break_intents(doc);

    let author_unbreakable = merge_break_intervals(&avoid_ranges, height as f32);

    let root = doc.root_element();
    let final_layout = root.final_layout();
    let content_h = root.scroll_height() as f64;
    let size_h = final_layout.size.height as f64;
    let page_height_f = height as f64;
    let total_height = content_h.max(size_h).max(page_height_f);

    let mut bands: Vec<(f64, f64)> = Vec::new();
    let mut y_cur: f64 = 0.0;
    while y_cur < total_height && (bands.len() as u32) < MAX_PAGES {
        let y_next = select_band_end(
            y_cur,
            total_height,
            page_height_f,
            &forced_breaks,
            &author_unbreakable,
            &unbreakable,
        );
        bands.push((y_cur, y_next));
        y_cur = y_next;
    }
    bands
}

pub(crate) fn record_doc_pdf_scenes(
    doc: &mut blitz_dom::BaseDocument,
    content_w: u32,
    content_h: u32,
    fonts_ref: &mut HashMap<u64, (peniko::Blob<u8>, u32)>,
    images_ref: &mut HashMap<u64, ImageInfo>,
    seen_images: &mut Vec<u64>,
) -> Vec<u8> {
    use blitz_paint::paint_scene;
    let bands = compute_page_bands(doc, content_h);
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&(bands.len() as u32).to_le_bytes());
    for (y_top, y_bot) in bands {
        let stripe_h = (y_bot - y_top).ceil().max(1.0) as u32;
        doc.set_viewport_scroll(blitz_dom::Point { x: 0.0, y: y_top });
        let mut scene = crate::paint::scene_record::RecordingScene::for_replay();
        scene.set_viewport(content_w, stripe_h, 0, y_top as u32);
        scene.set_render_region(y_top as u32, stripe_h);
        paint_scene(&mut scene, doc, 1.0, content_w, stripe_h, 0, 0);
        seen_images.extend(scene.image_hashes());
        crate::paint::render::cache_recorded_resources(&mut scene, fonts_ref, images_ref);
        let framed = scene.finish_framed();
        out.extend_from_slice(&(framed.len() as u32).to_le_bytes());
        out.extend_from_slice(&framed);
    }
    out
}
fn select_band_end(
    y_cur: f64,
    total_height: f64,
    page_height: f64,
    forced_breaks: &[f32],
    author_unbreakable: &[(f32, f32)],
    heuristic_unbreakable: &[(f32, f32)],
) -> f64 {
    let y_ideal = (y_cur + page_height).min(total_height);
    if let Some(&f) = forced_breaks
        .iter()
        .find(|&&f| (f as f64) > y_cur + 1.0 && (f as f64) < y_ideal - 0.5)
    {
        return f as f64;
    }
    if y_ideal >= total_height {
        return total_height;
    }
    let min_snap_y = (y_cur + page_height * 0.5) as f32;
    let progress_floor = (y_cur + 1.0) as f32;
    let y1 = safe_break_above(author_unbreakable, y_ideal as f32, progress_floor);
    let y2 = safe_break_above(heuristic_unbreakable, y1, min_snap_y);
    let y3 = if y2 < y1 {
        safe_break_above(author_unbreakable, y2, progress_floor)
    } else {
        y2
    };
    (y3 as f64).max(y_cur + 1.0)
}

fn collect_break_intents(doc: &blitz_dom::BaseDocument) -> (Vec<f32>, Vec<(f32, f32)>) {
    use style::values::specified::box_::{BreakBetween, BreakWithin};
    let mut forced: Vec<f32> = Vec::new();
    let mut avoid: Vec<(f32, f32)> = Vec::new();
    for (_, node) in doc.tree().iter() {
        let Some(styles) = node.primary_styles() else {
            continue;
        };
        let box_style = styles.get_box();
        let before = box_style.clone_break_before();
        let after = box_style.clone_break_after();
        let inside = box_style.clone_break_inside();
        if before == BreakBetween::Auto
            && after == BreakBetween::Auto
            && inside == BreakWithin::Auto
        {
            continue;
        }
        let h = node.final_layout().size.height;
        let pos = doc_position(doc, node);
        let (top, bot) = (pos.y, pos.y + h);
        if !top.is_finite() || !bot.is_finite() {
            continue;
        }
        let forces = |v: BreakBetween| {
            matches!(
                v,
                BreakBetween::Page
                    | BreakBetween::Always
                    | BreakBetween::Left
                    | BreakBetween::Right
                    | BreakBetween::Recto
                    | BreakBetween::Verso
            )
        };
        if forces(before) {
            forced.push(top);
        }
        if forces(after) {
            forced.push(bot);
        }
        if h > 0.5 && matches!(inside, BreakWithin::Avoid | BreakWithin::AvoidPage) {
            avoid.push((top, bot));
        }
    }
    forced.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    forced.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    (forced, avoid)
}

fn collect_node_y_ranges(doc: &blitz_dom::BaseDocument) -> Vec<(f32, f32)> {
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(1024);
    for (_, node) in doc.tree().iter() {
        // Text, comments, and shadow roots have no independent layout.
        if node.try_stylo_element_data().is_none() {
            continue;
        }
        let h = node.final_layout().size.height;
        if h <= 0.5 {
            continue;
        }
        let pos = doc_position(doc, node);
        let top = pos.y;
        let bot = top + h;
        if !top.is_finite() || !bot.is_finite() {
            continue;
        }
        out.push((top, bot));

        let Some(el) = node.element_data() else {
            continue;
        };
        let Some(text_layout) = el.inline_layout_data.as_ref() else {
            continue;
        };
        for line in text_layout.layout.lines() {
            let m = line.metrics();
            let l_top = top + m.block_min_coord;
            let l_bot = top + m.block_max_coord;
            if l_top.is_finite() && l_bot.is_finite() && l_bot > l_top {
                out.push((l_top, l_bot));
            }
        }
    }
    out
}

fn merge_break_intervals(ranges: &[(f32, f32)], max_h: f32) -> Vec<(f32, f32)> {
    const EPSILON: f32 = 0.25;
    let mut filtered: Vec<(f32, f32)> = ranges
        .iter()
        .copied()
        .filter(|&(t, b)| b > t && (b - t) <= max_h)
        .collect();
    filtered.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal));
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(filtered.len());
    for (t, b) in filtered {
        if let Some(last) = out.last_mut() {
            if t < last.1 - EPSILON {
                if b > last.1 {
                    last.1 = b;
                }
                continue;
            }
        }
        out.push((t, b));
    }
    out
}

fn safe_break_above(unbreakable: &[(f32, f32)], ideal: f32, lower_bound: f32) -> f32 {
    for &(t, b) in unbreakable {
        if t < ideal && ideal < b {
            if t > lower_bound && t.is_finite() {
                return t;
            }
            return ideal;
        }
    }
    ideal
}

#[cfg(test)]
mod band_tests {
    use super::select_band_end;

    const PAGE: f64 = 1000.0;
    const TOTAL: f64 = 5000.0;

    #[test]
    fn no_intent_no_overlap_breaks_at_ideal() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[], &[], &[]);
        assert_eq!(y, 1000.0);
    }

    #[test]
    fn forced_break_wins_inside_the_band() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[400.0], &[], &[]);
        assert_eq!(y, 400.0);
    }

    #[test]
    fn forced_break_behind_cursor_is_ignored() {
        let y = select_band_end(1000.0, TOTAL, PAGE, &[400.0], &[], &[]);
        assert_eq!(y, 2000.0);
    }

    #[test]
    fn author_avoid_snaps_past_the_half_page_floor() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[], &[(300.0, 1900.0)], &[]);
        assert_eq!(y, 300.0);
    }

    #[test]
    fn heuristic_avoid_respects_the_half_page_floor() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[], &[], &[(300.0, 1900.0)]);
        assert_eq!(y, 1000.0);
    }

    #[test]
    fn avoid_block_starting_at_band_top_gets_cut() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[], &[(0.0, 2500.0)], &[]);
        assert_eq!(y, 1000.0);
    }

    #[test]
    fn heuristic_resnap_cannot_reenter_author_extent() {
        let y = select_band_end(
            0.0,
            TOTAL,
            PAGE,
            &[],
            &[(700.0, 1200.0)],
            &[(600.0, 1100.0)],
        );
        assert_eq!(y, 600.0);
    }

    #[test]
    fn last_band_reaches_total_height() {
        let y = select_band_end(4500.0, TOTAL, PAGE, &[], &[], &[]);
        assert_eq!(y, TOTAL);
    }

    #[test]
    fn progress_is_guaranteed() {
        let y = select_band_end(0.0, TOTAL, PAGE, &[], &[(0.5, 4999.0)], &[(0.5, 4999.0)]);
        assert!(y > 0.0);
    }
}
