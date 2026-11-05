// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Scene rendering, paint damage tracking, ink rects, and the RBI image cache.

use std::collections::HashMap;
use std::panic;
use std::sync::Arc;

use blitz_html::HtmlDocument;
use blitz_traits::NodeId;
use kurbo::Affine;
use peniko::Fill;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode};
use crate::layout::geometry::{bounding_rect_for_node, composed_transform_for_node, doc_position};
use crate::layout::scroll::overflow_clips;
use crate::paint::scene_record::{RecordingScene, IMAGE_FORMAT_ENGINE_REF};

// Mirrors blitz-dom's private DAMAGE_SUMMARY_CAP: past it a list reads as overflow,
// which the screencast's partial-frame gate already turns into a full frame.
const SCREENCAST_DAMAGE_CAP: usize = 64;
// Enough to tell a page that reacted to an input from one that did not; past it the
// read reports overflow, which callers treat as "changed".
const MARKED_DAMAGE_CAP: usize = 256;

#[derive(Clone, Copy)]
struct SceneClip {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

// blitz keeps one damage summary and taking it drains it, so a second reader would
// starve the screencast; a marked read hands what it took on to the next screencast take.
#[derive(Default)]
pub(crate) struct DamageFanout {
    owed: Option<blitz_dom::DamageSummary>,
    marked: Option<(Vec<NodeId>, bool)>,
}

fn merge_damage_ids(into: &mut Vec<NodeId>, overflow: &mut bool, from: &[NodeId], cap: usize) {
    for &id in from {
        if into.contains(&id) {
            continue;
        }
        if into.len() >= cap {
            *overflow = true;
        } else {
            into.push(id);
        }
    }
}

fn merge_damage(into: &mut blitz_dom::DamageSummary, from: &blitz_dom::DamageSummary) {
    merge_damage_ids(
        &mut into.layout_nodes,
        &mut into.layout_overflow,
        &from.layout_nodes,
        SCREENCAST_DAMAGE_CAP,
    );
    merge_damage_ids(
        &mut into.paint_nodes,
        &mut into.paint_overflow,
        &from.paint_nodes,
        SCREENCAST_DAMAGE_CAP,
    );
    merge_damage_ids(
        &mut into.ink_nodes,
        &mut into.ink_overflow,
        &from.ink_nodes,
        SCREENCAST_DAMAGE_CAP,
    );
    into.layout_overflow |= from.layout_overflow;
    into.paint_overflow |= from.paint_overflow;
    into.ink_overflow |= from.ink_overflow;
}

impl DamageFanout {
    fn owe(&mut self, s: &blitz_dom::DamageSummary) {
        merge_damage(self.owed.get_or_insert_with(Default::default), s);
    }

    fn feed_marked(&mut self, s: &blitz_dom::DamageSummary) {
        if let Some((ids, overflow)) = self.marked.as_mut() {
            for list in [&s.layout_nodes, &s.paint_nodes, &s.ink_nodes] {
                merge_damage_ids(ids, overflow, list, MARKED_DAMAGE_CAP);
            }
            *overflow |= s.layout_overflow || s.paint_overflow || s.ink_overflow;
        }
    }
}

pub(crate) fn cache_recorded_resources(
    scene: &mut RecordingScene,
    fonts: &mut HashMap<u64, (peniko::Blob<u8>, u32)>,
    images: &mut HashMap<u64, crate::paint::scene_record::ImageInfo>,
) {
    for (key, blob, index) in scene.drain_font_bytes() {
        fonts.entry(key).or_insert((blob, index));
    }
    let needed = scene.drain_image_needed();
    for (hash, info) in scene.drain_rbi_images() {
        images.entry(hash).or_insert(info);
    }
    for (hash, width, height) in needed {
        if let Some(info) = images.get_mut(&hash) {
            info.needed_w = info.needed_w.max(width);
            info.needed_h = info.needed_h.max(height);
        }
    }
}

pub(crate) const RBI_ENCODED_IMAGE_BUDGET_BYTES: usize = 16 * 1024 * 1024;

pub(crate) const RBI_IMAGE_KEEP_RECORDS: u64 = 8;

#[derive(Default)]
pub(crate) struct RbiImageRecency {
    record: u64,
    last_seen: HashMap<u64, u64>,
}

impl RbiImageRecency {
    pub(crate) fn note(&mut self, hashes: impl IntoIterator<Item = u64>) {
        self.record += 1;
        for h in hashes {
            self.last_seen.insert(h, self.record);
        }
    }

    fn evict_stale(
        &mut self,
        cache: &mut HashMap<u64, crate::paint::scene_record::ImageInfo>,
        scene: &RecordingScene,
    ) {
        self.note(scene.image_hashes());
        self.last_seen.retain(|h, _| cache.contains_key(h));
        let encoded: usize = cache
            .values()
            .filter(|i| i.format == 1)
            .map(|i| i.wire_bytes.data().len())
            .sum();
        if encoded <= RBI_ENCODED_IMAGE_BUDGET_BYTES {
            return;
        }
        let oldest_kept = self.record.saturating_sub(RBI_IMAGE_KEEP_RECORDS - 1);
        let last_seen = &self.last_seen;
        cache.retain(|h, i| i.format != 1 || last_seen.get(h).is_some_and(|&r| r >= oldest_kept));
        self.last_seen.retain(|h, _| cache.contains_key(h));
    }
}

fn unpack_u64_set(bytes: &[u8]) -> std::collections::HashSet<u64> {
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|chunk| u64::from_le_bytes(*chunk))
        .collect()
}

fn ink_rect_for_node(doc: &HtmlDocument, node_id: NodeId) -> Option<kurbo::Rect> {
    use ::style::properties::generated::longhands::visibility::computed_value::T as Visibility;
    let node = doc.get_node(node_id)?;
    let visible = node.primary_styles()?.get_inherited_box().visibility == Visibility::Visible;
    if !visible {
        return None;
    }
    ink_bounds(doc, node_id)
}

const SHADOW_BLUR_REACH: f64 = 2.5;

fn paint_outset(doc: &HtmlDocument, node_id: NodeId) -> Option<f64> {
    let mut reach: f64 = 0.0;
    let mut stack = vec![node_id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        stack.extend(
            node.children()
                .iter()
                .chain(node.before())
                .chain(node.after()),
        );
        let Some(styles) = node.primary_styles() else {
            continue;
        };
        let effects = styles.get_effects();
        if !effects.filter.0.is_empty() {
            return None;
        }
        let shadow = |dx: f32, dy: f32, blur: f32, spread: f32| {
            (dx.hypot(dy) + spread.max(0.0)) as f64 + SHADOW_BLUR_REACH * blur as f64
        };
        let mut own: f64 = 0.0;
        for s in effects.box_shadow.0.iter().filter(|s| !s.inset) {
            let b = &s.base;
            own = own.max(shadow(
                b.horizontal.px(),
                b.vertical.px(),
                b.blur.px(),
                s.spread.px(),
            ));
        }
        for b in styles.get_inherited_text().text_shadow.0.iter() {
            own = own.max(shadow(b.horizontal.px(), b.vertical.px(), b.blur.px(), 0.0));
        }
        let outline = styles.get_outline();
        if !outline.outline_style.none_or_hidden() {
            let width = outline.outline_width.0.to_f64_px();
            own = own.max(width + outline.outline_offset.to_f64_px());
        }
        drop(styles);
        if own > 0.0 {
            let scale =
                composed_transform_for_node(doc, id).map_or(1.0, |(t, _)| max_linear_scale(t));
            reach = reach.max(own * scale);
        }
    }
    Some(reach)
}

fn max_linear_scale(t: Affine) -> f64 {
    let [a, b, c, d, _, _] = t.as_coeffs();
    let sum = a * a + b * b + c * c + d * d;
    let det = a * d - b * c;
    ((sum + (sum * sum - 4.0 * det * det).max(0.0).sqrt()) / 2.0).sqrt()
}

fn ink_bounds(doc: &HtmlDocument, node_id: NodeId) -> Option<kurbo::Rect> {
    use ::style::properties::generated::longhands::direction::computed_value::T as Direction;
    let node = doc.get_node(node_id)?;
    let rtl = node.primary_styles()?.get_inherited_box().direction == Direction::Rtl;
    if bounding_rect_for_node(doc, node).width < 0.0 {
        return None;
    }
    let scale = doc.viewport().scale_f64();
    let layout = node.final_layout();
    let (w, h) = (
        layout.size.width as f64 * scale,
        layout.size.height as f64 * scale,
    );
    let o = layout.scrollable_overflow_rect;
    let b = layout.border;
    let (x0, x1) = if rtl {
        let right_edge = layout.size.width - b.right;
        (right_edge - o.right, right_edge - o.left)
    } else {
        (b.left + o.left, b.left + o.right)
    };
    let content = kurbo::Rect::new(
        x0 as f64,
        (b.top + o.top) as f64,
        x1 as f64,
        (b.top + o.bottom) as f64,
    )
    .scale_from_origin(scale);
    let mut local = node
        .scrollable_overflow()
        .union(kurbo::Rect::new(0.0, 0.0, w, h))
        .union(content);
    let (clip_x, clip_y) = overflow_clips(node);
    if clip_x {
        (local.x0, local.x1) = (0.0, w);
    }
    if clip_y {
        (local.y0, local.y1) = (0.0, h);
    }
    let composed = match composed_transform_for_node(doc, node_id) {
        Some((composed, _)) => composed,
        None => {
            let p = doc_position(doc, node);
            Affine::translate((
                (p.x as f64 + node.scroll_offset().x) * scale,
                (p.y as f64 + node.scroll_offset().y) * scale,
            ))
        }
    };
    let r = composed.transform_rect_bbox(local);
    (r.width() > 0.0 && r.height() > 0.0).then(|| r.scale_from_origin(1.0 / scale))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "renderSceneClip")]
    pub fn render_scene_clip(
        &self,
        clip_x: i32,
        clip_y: i32,
        clip_w: u32,
        clip_h: u32,
        omit_background: bool,
        client_wire: bool,
    ) -> Vec<u8> {
        self.render_scene_clip_inner(
            SceneClip {
                x: clip_x,
                y: clip_y,
                width: clip_w,
                height: clip_h,
            },
            omit_background,
            client_wire,
            false,
        )
    }

    #[wasm_bindgen(js_name = "renderSceneClipRaw")]
    pub fn render_scene_clip_raw(
        &self,
        clip_x: i32,
        clip_y: i32,
        clip_w: u32,
        clip_h: u32,
        omit_background: bool,
        client_wire: bool,
    ) -> Vec<u8> {
        self.render_scene_clip_inner(
            SceneClip {
                x: clip_x,
                y: clip_y,
                width: clip_w,
                height: clip_h,
            },
            omit_background,
            client_wire,
            true,
        )
    }

    fn render_scene_clip_inner(
        &self,
        clip: SceneClip,
        omit_background: bool,
        client_wire: bool,
        raw_images: bool,
    ) -> Vec<u8> {
        use anyrender::PaintScene as _;
        let SceneClip {
            x: clip_x,
            y: clip_y,
            width: clip_w,
            height: clip_h,
        } = clip;
        if self.layout_mode.get() == LayoutMode::Off {
            return Vec::new();
        }
        if clip_w == 0 || clip_h == 0 {
            return Vec::new();
        }
        self.resolve_until_images_settle();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        // Raster coordinates are u16.
        const MAX_CLIP_DIM: u32 = u16::MAX as u32;
        let overhang_x = (-clip_x).max(0) as u32;
        let overhang_y = (-clip_y).max(0) as u32;
        let sx = clip_x.max(0) as u32;
        let sy = clip_y.max(0) as u32;
        let w = clip_w.saturating_sub(overhang_x).min(MAX_CLIP_DIM);
        let h = clip_h.saturating_sub(overhang_y).min(MAX_CLIP_DIM);
        if w == 0 || h == 0 {
            return Vec::new();
        }
        let mut cache_ref = match self.rbi_glyph_cache.try_borrow_mut() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut fonts_ref = match self.rbi_font_bytes.try_borrow_mut() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let mut images_ref = match self.rbi_image_cache.try_borrow_mut() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };
        let entry_scroll = doc.viewport_scroll();
        doc.set_viewport_scroll_with_fixed_anchor(
            blitz_dom::Point {
                x: sx as f64,
                y: sy as f64,
            },
            entry_scroll,
        );
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let base: &mut blitz_dom::BaseDocument = &mut doc;
            let mut scene = if client_wire {
                RecordingScene::new()
            } else {
                RecordingScene::for_replay()
            };
            scene.set_viewport(w, h, sx, sy);
            scene.raw_images = raw_images;
            scene.set_render_region(sy, h);
            if !omit_background {
                use blitz_dom::util::Color;
                use peniko::kurbo::Rect;
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, w as f64, h as f64),
                );
            }
            blitz_paint::paint_scene(&mut scene, base, 1.0, w, h, 0, 0);
            for (hash, path_bytes) in scene.drain_glyph_outlines() {
                cache_ref.entry(hash).or_insert(path_bytes);
            }
            cache_recorded_resources(&mut scene, &mut fonts_ref, &mut images_ref);
            if let Ok(mut recency) = self.rbi_image_recency.try_borrow_mut() {
                recency.evict_stale(&mut images_ref, &scene);
            }
            scene.finish_framed()
        }));
        doc.set_viewport_scroll(entry_scroll);
        // Scrolling paints through strips, so this path must age layouts too;
        // after the restore, so the band follows the viewport, not the strip.
        let base: &mut blitz_dom::BaseDocument = &mut doc;
        base.evict_offscreen_inline_layouts();
        result.unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "setIframeImage")]
    pub fn set_iframe_image(&self, node_id: u32, width: u32, height: u32, rgba: &[u8]) -> i32 {
        const MAX_IFRAME_DIM: u32 = 4096;
        if width == 0 || height == 0 || width > MAX_IFRAME_DIM || height > MAX_IFRAME_DIM {
            return -1;
        }
        let expected = (width as usize) * (height as usize) * 4;
        if rgba.len() != expected {
            return -1;
        }
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return -2,
        };
        let rc = doc.kitesurf_set_iframe_image(internal_id, width, height, Arc::new(rgba.to_vec()));
        drop(doc);
        if rc == 1 {
            self.layout_dirty.set(true);
        }
        rc
    }

    #[wasm_bindgen(js_name = "clearIframeImage")]
    pub fn clear_iframe_image(&self, node_id: u32) {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return;
        };
        if let Ok(mut d) = self.doc.try_borrow_mut() {
            d.kitesurf_clear_iframe_image(node_id);
            drop(d);
            self.layout_dirty.set(true);
        }
    }

    #[wasm_bindgen(js_name = "takeDamageSummary")]
    pub fn take_damage_summary(&self) -> String {
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let base: &mut blitz_dom::BaseDocument = &mut doc;
        let mut s = base.take_damage_summary();
        let mut fan = self.damage_fanout.borrow_mut();
        fan.feed_marked(&s);
        if let Some(mut owed) = fan.owed.take() {
            merge_damage(&mut owed, &s);
            s = owed;
        }
        drop(fan);
        let mut node_handles = self.node_handles.borrow_mut();
        let mut ids = |v: &[NodeId]| {
            let mut out = String::from("[");
            for (i, id) in v.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&node_handles.external_for(*id).to_string());
            }
            out.push(']');
            out
        };
        format!(
            "{{\"layout\":{},\"paint\":{},\"ink\":{},\"layoutOverflow\":{},\"paintOverflow\":{}}}",
            ids(&s.layout_nodes),
            ids(&s.paint_nodes),
            ids(&s.ink_nodes),
            s.layout_overflow || s.ink_overflow,
            s.paint_overflow,
        )
    }

    /// Start counting the damage a caller attributes to its next input; what was
    /// already pending goes to the screencast, so it is never read as the input's.
    #[wasm_bindgen(js_name = "paintDamageMark")]
    pub fn paint_damage_mark(&self) {
        self.ensure_layout();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        let base: &mut blitz_dom::BaseDocument = &mut doc;
        let s = base.take_damage_summary();
        drop(doc);
        let mut fan = self.damage_fanout.borrow_mut();
        fan.owe(&s);
        fan.marked = Some((Vec::new(), false));
    }

    /// Nodes damaged since the last mark or read, as JSON `{ids, overflow}`, leaving out
    /// `exclude`, its subtree and its ancestors: a control's own hover and focus restyle.
    #[wasm_bindgen(js_name = "paintDamageSince")]
    pub fn paint_damage_since(&self, exclude: u32) -> String {
        self.ensure_layout();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let base: &mut blitz_dom::BaseDocument = &mut doc;
        let s = base.take_damage_summary();
        let mut fan = self.damage_fanout.borrow_mut();
        fan.owe(&s);
        fan.feed_marked(&s);
        let Some((ids, overflow)) = fan.marked.replace((Vec::new(), false)) else {
            return String::new();
        };
        drop(fan);
        let target = self.resolve_node_id(exclude);
        let parent = |id: NodeId| base.get_node(id).and_then(|n| n.parent_id());
        let mut lineage = std::collections::HashSet::new();
        let mut cur = target;
        while let Some(id) = cur {
            lineage.insert(id);
            cur = parent(id);
        }
        let inside = |id: NodeId| {
            let mut cur = Some(id);
            while let Some(c) = cur {
                if Some(c) == target {
                    return true;
                }
                cur = parent(c);
            }
            false
        };
        let kept: Vec<NodeId> = ids
            .into_iter()
            .filter(|&id| base.get_node(id).is_some() && !lineage.contains(&id) && !inside(id))
            .collect();
        drop(doc);
        let external: Vec<u32> = kept.iter().map(|&id| self.external_node_id(id)).collect();
        format!("{{\"ids\":{:?},\"overflow\":{}}}", external, overflow)
    }

    /// Document-space ink bounds for the transformed border box and descendants.
    /// Null means no box. Partial frames use it for transform-only damage.
    #[wasm_bindgen(js_name = "inkRect")]
    pub fn ink_rect(&self, node_id: u32) -> Option<Vec<f64>> {
        if self.layout_mode.get() == LayoutMode::Off {
            return None;
        }
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            ink_rect_for_node(&doc, internal_id)
        }))
        .ok()
        .flatten()
        .map(|r| vec![r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0])
    }

    #[wasm_bindgen(js_name = "pinnedRects")]
    pub fn pinned_rects(&self) -> Option<Vec<f64>> {
                use ::style::properties::generated::longhands::background_attachment::single_value::computed_value::T as Attachment;
        use ::style::properties::generated::longhands::position::computed_value::T as Position;
        if self.layout_mode.get() == LayoutMode::Off {
            return None;
        }
        self.ensure_layout();
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let mut out = Vec::new();
            for (id, node) in doc.tree().iter() {
                let Some(styles) = node.primary_styles() else {
                    continue;
                };
                if styles
                    .get_background()
                    .background_attachment
                    .0
                    .contains(&Attachment::Fixed)
                {
                    return None;
                }
                let pinned = matches!(styles.clone_position(), Position::Fixed | Position::Sticky);
                drop(styles);
                if let Some(r) = pinned.then(|| ink_bounds(&doc, id)).flatten() {
                    // A filter's reach is not modelled: the scroll takes a full frame.
                    let reach = paint_outset(&doc, id)?;
                    let r = r.inflate(reach, reach);
                    out.extend([
                        self.external_node_id(id) as f64,
                        r.x0,
                        r.y0,
                        r.x1 - r.x0,
                        r.y1 - r.y0,
                    ]);
                }
            }
            Some(out)
        }))
        .ok()
        .flatten()
    }

    #[wasm_bindgen(js_name = "renderSceneStats")]
    pub fn render_scene_stats(&self, scroll_x: i32, scroll_y: i32) -> String {
        use anyrender::PaintScene as _;

        if self.layout_mode.get() == LayoutMode::Off {
            return String::new();
        }
        self.resolve_until_images_settle();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let viewport = doc.viewport();
        let (w, h) = viewport.window_size;

        doc.set_viewport_scroll(blitz_dom::Point {
            x: scroll_x.max(0) as f64,
            y: scroll_y.max(0) as f64,
        });

        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let base: &mut blitz_dom::BaseDocument = &mut doc;
            let mut scene = RecordingScene::new();
            {
                use blitz_dom::util::Color;
                use peniko::kurbo::Rect;
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, w as f64, h as f64),
                );
            }
            blitz_paint::paint_scene(&mut scene, base, 1.0, w, h, 0, 0);
            scene.stats_json()
        }));
        result.unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "renderScene")]
    pub fn render_scene(
        &self,
        scroll_x: i32,
        scroll_y: i32,
        overdraw_top: u32,
        overdraw_bottom: u32,
        omit_background: bool,
        client_wire: bool,
    ) -> Vec<u8> {
        self.render_scene_inner(
            (scroll_x, scroll_y),
            overdraw_top,
            overdraw_bottom,
            omit_background,
            client_wire,
            false,
        )
    }

    #[wasm_bindgen(js_name = "renderSceneRaw")]
    pub fn render_scene_raw(
        &self,
        scroll_x: i32,
        scroll_y: i32,
        overdraw_top: u32,
        overdraw_bottom: u32,
        omit_background: bool,
        client_wire: bool,
    ) -> Vec<u8> {
        self.render_scene_inner(
            (scroll_x, scroll_y),
            overdraw_top,
            overdraw_bottom,
            omit_background,
            client_wire,
            true,
        )
    }

    /// Keeps the raw scene in linear memory; `stagedScenePtr` locates its
    /// bytes until the next call. JS can copy them into a pooled ArrayBuffer
    /// instead of allocating one for every canvas frame.
    #[wasm_bindgen(js_name = "renderSceneRawStaged")]
    pub fn render_scene_raw_staged(
        &self,
        scroll_x: i32,
        scroll_y: i32,
        overdraw_top: u32,
        overdraw_bottom: u32,
        omit_background: bool,
        client_wire: bool,
    ) -> u32 {
        let scene = self.render_scene_inner(
            (scroll_x, scroll_y),
            overdraw_top,
            overdraw_bottom,
            omit_background,
            client_wire,
            true,
        );
        let len = scene.len() as u32;
        *self.staged_scene.borrow_mut() = scene;
        len
    }

    /// Address of the last staged scene in linear memory.
    #[wasm_bindgen(js_name = "stagedScenePtr")]
    pub fn staged_scene_ptr(&self) -> u32 {
        self.staged_scene.borrow().as_ptr() as u32
    }

    fn render_scene_inner(
        &self,
        scroll: (i32, i32),
        overdraw_top: u32,
        overdraw_bottom: u32,
        omit_background: bool,
        client_wire: bool,
        raw_images: bool,
    ) -> Vec<u8> {
        use anyrender::PaintScene as _;
        let (scroll_x, scroll_y) = scroll;
        let _ks_span = tracing::info_span!("wasm.record_scene").entered();

        if self.layout_mode.get() == LayoutMode::Off {
            return Vec::new();
        }
        {
            let _sp = tracing::info_span!("wasm.record_scene.layout").entered();
            self.resolve_until_images_settle();
        }
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let viewport = doc.viewport();
        let (w, h) = viewport.window_size;
        let sx = scroll_x.max(0) as u32;
        let sy = scroll_y.max(0) as u32;
        let effective_overdraw_top = overdraw_top.min(sy);
        let render_top_y = sy - effective_overdraw_top;
        let render_h = h
            .saturating_add(effective_overdraw_top)
            .saturating_add(overdraw_bottom);
        doc.set_viewport_scroll(blitz_dom::Point {
            x: sx as f64,
            y: render_top_y as f64,
        });

        let mut cache_ref = match self.rbi_glyph_cache.try_borrow_mut() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut fonts_ref = match self.rbi_font_bytes.try_borrow_mut() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let mut images_ref = match self.rbi_image_cache.try_borrow_mut() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };

        let mut seen_ref = match self.rbi_glyph_seen.try_borrow_mut() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let mut tables_ref = match self.rbi_font_tables.try_borrow_mut() {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };

        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _sp = tracing::info_span!("wasm.record_scene.paint").entered();
            let base: &mut blitz_dom::BaseDocument = &mut doc;
            let mut scene = if client_wire {
                RecordingScene::new()
            } else {
                RecordingScene::for_replay()
            };
            scene.set_viewport(w, h, sx, sy);
            scene.raw_images = raw_images;
            scene.set_render_region(render_top_y, render_h);
            fn harvest_glyphs(
                scene: &mut RecordingScene,
                cache: &mut HashMap<u64, Vec<u8>>,
                seen: &mut crate::paint::scene_record::GlyphSeen,
                tables: &mut crate::paint::scene_record::FontTableCache,
            ) {
                for (hash, path_bytes) in scene.drain_glyph_outlines() {
                    cache.entry(hash).or_insert(path_bytes);
                }
                *seen = scene.take_glyph_seen();
                *tables = scene.take_font_tables();
            }
            if let Err(panic) = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                scene.set_glyph_seen(std::mem::take(&mut *seen_ref));
                scene.set_font_tables(std::mem::take(&mut *tables_ref));
                if !omit_background {
                    use blitz_dom::util::Color;
                    use peniko::kurbo::Rect;
                    scene.fill(
                        Fill::NonZero,
                        Affine::IDENTITY,
                        Color::WHITE,
                        None,
                        &Rect::new(0.0, 0.0, w as f64, render_h as f64),
                    );
                }
                blitz_paint::paint_scene(&mut scene, base, 1.0, w, render_h, 0, 0);
            })) {
                harvest_glyphs(&mut scene, &mut cache_ref, &mut seen_ref, &mut tables_ref);
                panic::resume_unwind(panic);
            }
            harvest_glyphs(&mut scene, &mut cache_ref, &mut seen_ref, &mut tables_ref);
            cache_recorded_resources(&mut scene, &mut fonts_ref, &mut images_ref);
            if let Ok(mut recency) = self.rbi_image_recency.try_borrow_mut() {
                recency.evict_stale(&mut images_ref, &scene);
            }
            // Scrolling resolves nothing, so this is where text that scrolled
            // far out of view drops its shaped layout again.
            base.evict_offscreen_inline_layouts();
            scene.finish_framed()
        }));
        result.unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "renderRbiResources")]
    pub fn render_rbi_resources(
        &self,
        glyph_hashes: &[u8],
        font_metric_hashes: &[u8],
        image_hashes: &[u8],
        font_data_hashes: &[u8],
    ) -> Vec<u8> {
        let glyph_cache = match self.rbi_glyph_cache.try_borrow() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let font_bytes = match self.rbi_font_bytes.try_borrow() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let image_cache = match self.rbi_image_cache.try_borrow() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };

        fn parse_hashes(bytes: &[u8]) -> Vec<u64> {
            let end = bytes.len() - (bytes.len() % 8);
            let mut out = Vec::with_capacity(end / 8);
            let mut i = 0;
            while i + 8 <= end {
                let mut buf = [0u8; 8];
                buf.copy_from_slice(&bytes[i..i + 8]);
                out.push(u64::from_le_bytes(buf));
                i += 8;
            }
            out
        }
        let glyphs = parse_hashes(glyph_hashes);
        let fonts = parse_hashes(font_metric_hashes);
        let images = parse_hashes(image_hashes);
        let font_datas = parse_hashes(font_data_hashes);

        let mut resolved_glyphs: Vec<(u64, &[u8])> = Vec::with_capacity(glyphs.len());
        for h in &glyphs {
            if let Some(bytes) = glyph_cache.get(h) {
                resolved_glyphs.push((*h, bytes.as_slice()));
            }
        }
        let mut resolved_fonts: Vec<(u64, Vec<u8>)> = Vec::with_capacity(fonts.len());
        for h in &fonts {
            if let Some((blob, idx)) = font_bytes.get(h) {
                if let Some(metrics) =
                    crate::paint::scene_record::extract_font_metrics(blob.data(), *idx)
                {
                    resolved_fonts.push((*h, metrics));
                }
            }
        }
        enum FontDataRef<'a> {
            Asset(String),
            Blob(&'a [u8]),
        }
        struct ResolvedImage<'a> {
            hash: u64,
            width: u32,
            height: u32,
            format: u8,
            needed: (u32, u32),
            bytes: &'a [u8],
        }
        let mut resolved_font_datas: Vec<(u64, u32, FontDataRef)> =
            Vec::with_capacity(font_datas.len());
        for h in &font_datas {
            if let Some(name) = crate::resources::fonts::font_asset_name_for_hash(*h) {
                let idx = font_bytes.get(h).map(|(_, i)| *i).unwrap_or(0);
                resolved_font_datas.push((*h, idx, FontDataRef::Asset(name.to_string())));
            } else if let Some(key) = crate::resources::fonts::font_engine_key_for_hash(*h) {
                let idx = font_bytes.get(h).map(|(_, i)| *i).unwrap_or(0);
                resolved_font_datas.push((*h, idx, FontDataRef::Asset(key)));
            } else if let Some(url) = crate::resources::fonts::font_url_for_hash(*h) {
                let idx = font_bytes.get(h).map(|(_, i)| *i).unwrap_or(0);
                resolved_font_datas.push((*h, idx, FontDataRef::Asset(url)));
            } else if let Some((blob, idx)) = font_bytes.get(h) {
                resolved_font_datas.push((*h, *idx, FontDataRef::Blob(blob.data())));
            }
        }
        let mut resolved_images: Vec<ResolvedImage<'_>> = Vec::with_capacity(images.len());
        for h in &images {
            if image_cache.get(h).is_none() {
                crate::console_warn_str(&format!(
                    "[ks-rbi] image hash {h} not in rbi_image_cache ({} entries)",
                    image_cache.len()
                ));
            }
            if let Some(info) = image_cache.get(h) {
                let format = if *h & crate::paint::scene_record::ENGINE_KEY_MARKER != 0
                    && info.wire_bytes.data().is_empty()
                {
                    IMAGE_FORMAT_ENGINE_REF
                } else {
                    info.format
                };
                resolved_images.push(ResolvedImage {
                    hash: *h,
                    width: info.width,
                    height: info.height,
                    format,
                    needed: (info.needed_w, info.needed_h),
                    bytes: info.wire_bytes.data(),
                });
            }
        }

        let payload_total: usize = resolved_glyphs
            .iter()
            .map(|(_, p)| p.len() + 1)
            .sum::<usize>()
            + resolved_fonts.iter().map(|(_, p)| p.len()).sum::<usize>()
            + resolved_images
                .iter()
                .map(|image| {
                    if image.format == IMAGE_FORMAT_ENGINE_REF {
                        17
                    } else if image.format == 2 {
                        image.bytes.len() + 17
                    } else {
                        image.bytes.len() + 9
                    }
                })
                .sum::<usize>()
            + resolved_font_datas
                .iter()
                .map(|(_, _, r)| match r {
                    FontDataRef::Asset(n) => n.len() + 5,
                    FontDataRef::Blob(b) => b.len() + 5,
                })
                .sum::<usize>();
        let total = resolved_glyphs.len()
            + resolved_fonts.len()
            + resolved_images.len()
            + resolved_font_datas.len();
        let entry_headers = 13 * total;
        let mut out = Vec::with_capacity(4 + entry_headers + payload_total);
        out.extend_from_slice(&(total as u32).to_le_bytes());
        for (hash, path_bytes) in &resolved_glyphs {
            out.push(crate::paint::scene_record::RBI_RESOURCE_KIND_GLYPH);
            out.extend_from_slice(&hash.to_le_bytes());
            let len = path_bytes.len() as u32 + 1;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(path_bytes);
            out.push(crate::paint::scene_record::PATH_END_TAG);
        }
        for (hash, metrics) in &resolved_fonts {
            out.push(crate::paint::scene_record::RBI_RESOURCE_KIND_FONT_METRICS);
            out.extend_from_slice(&hash.to_le_bytes());
            out.extend_from_slice(&(metrics.len() as u32).to_le_bytes());
            out.extend_from_slice(metrics);
        }
        for image in &resolved_images {
            out.push(crate::paint::scene_record::RBI_RESOURCE_KIND_IMAGE);
            out.extend_from_slice(&image.hash.to_le_bytes());
            let is_ref = image.format == IMAGE_FORMAT_ENGINE_REF;
            let prefix = if image.format == 2 || is_ref { 17 } else { 9 };
            let body_len = if is_ref { 0 } else { image.bytes.len() };
            out.extend_from_slice(&((body_len + prefix) as u32).to_le_bytes());
            out.extend_from_slice(&image.width.to_le_bytes());
            out.extend_from_slice(&image.height.to_le_bytes());
            out.push(image.format);
            if image.format == 2 || is_ref {
                out.extend_from_slice(&image.needed.0.to_le_bytes());
                out.extend_from_slice(&image.needed.1.to_le_bytes());
            }
            if !is_ref {
                out.extend_from_slice(image.bytes);
            }
        }
        for (hash, idx, r) in &resolved_font_datas {
            out.push(crate::paint::scene_record::RBI_RESOURCE_KIND_FONT_DATA);
            out.extend_from_slice(&hash.to_le_bytes());
            let (ref_type, body): (u8, &[u8]) = match r {
                FontDataRef::Asset(n) => (
                    crate::paint::scene_record::FONT_DATA_REF_ASSET,
                    n.as_bytes(),
                ),
                FontDataRef::Blob(b) => (crate::paint::scene_record::FONT_DATA_REF_BLOB, b),
            };
            out.extend_from_slice(&((body.len() + 5) as u32).to_le_bytes());
            out.push(ref_type);
            out.extend_from_slice(&idx.to_le_bytes());
            out.extend_from_slice(body);
        }
        out
    }

    #[wasm_bindgen(js_name = "renderSceneInlineResources")]
    pub fn render_scene_inline_resources(
        &self,
        scene: &[u8],
        have_images: &[u8],
        have_fonts: &[u8],
    ) -> Vec<u8> {
        let header = match crate::paint::scene_decode::parse_header(scene) {
            Ok(h) => h,
            Err(_) => return Vec::new(),
        };
        let resources = match crate::paint::scene_decode::parse_resources(scene, &header) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let have_img = unpack_u64_set(have_images);
        let have_fnt = unpack_u64_set(have_fonts);
        let mut image_hashes: Vec<u8> = Vec::new();
        for (hash, res) in &resources.by_hash {
            if res.format != 0 && !have_img.contains(hash) {
                image_hashes.extend_from_slice(&hash.to_le_bytes());
            }
        }
        let mut font_data_hashes: Vec<u8> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for meta in resources.font_meta.values() {
            if meta.blob_hash != 0 {
                let key =
                    crate::paint::scene_record::font_data_key(meta.blob_hash, meta.face_index);
                if seen.insert(key) && !have_fnt.contains(&key) {
                    font_data_hashes.extend_from_slice(&key.to_le_bytes());
                }
            }
        }
        if image_hashes.is_empty() && font_data_hashes.is_empty() {
            return Vec::new();
        }
        self.render_rbi_resources(&[], &[], &image_hashes, &font_data_hashes)
    }

    #[wasm_bindgen(js_name = "renderSceneRoundtrip")]
    pub fn render_scene_roundtrip(&self, scroll_x: i32, scroll_y: i32) -> String {
        use anyrender::PaintScene as _;

        if self.layout_mode.get() == LayoutMode::Off {
            return String::new();
        }
        self.resolve_until_images_settle();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return String::new(),
        };
        let viewport = doc.viewport();
        let (w, h) = viewport.window_size;
        let sx = scroll_x.max(0) as u32;
        let sy = scroll_y.max(0) as u32;
        doc.set_viewport_scroll(blitz_dom::Point {
            x: sx as f64,
            y: sy as f64,
        });

        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let base: &mut blitz_dom::BaseDocument = &mut doc;
            let mut scene = RecordingScene::new();
            scene.set_viewport(w, h, sx, sy);
            {
                use blitz_dom::util::Color;
                use peniko::kurbo::Rect;
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, w as f64, h as f64),
                );
            }
            blitz_paint::paint_scene(&mut scene, base, 1.0, w, h, 0, 0);

            let enc_fill = scene.fill_count();
            let enc_stroke = scene.stroke_count();
            let enc_push_layer = scene.push_layer_count();
            let enc_push_clip = scene.push_clip_layer_count();
            let enc_pop = scene.pop_layer_count();
            let enc_glyph_runs = scene.glyph_run_count();
            let enc_glyphs = scene.glyph_count();
            let enc_fonts = scene.font_count();
            let enc_images = scene.image_count();
            let enc_ops = scene.op_count();
            let op_stream_len = scene.op_stream().len();

            let framed = scene.finish_framed();
            let framed_len = framed.len();

            let mut vis = crate::paint::scene_decode::StatsVisitor::default();
            let header_res = crate::paint::scene_decode::parse_header(&framed);
            let (decode_ok, decode_err) =
                match crate::paint::scene_decode::decode(&framed, &mut vis) {
                    Ok(_h) => (true, String::new()),
                    Err(e) => (false, e.to_string()),
                };
            let (dec_res_count, dec_res_bytes, dec_glyph_outlines, dec_font_meta, resources_ok) =
                match header_res.as_ref() {
                    Ok(h) => match crate::paint::scene_decode::parse_resources(&framed, h) {
                        Ok(r) => {
                            let bytes_total: usize = r.by_hash.values().map(|e| e.data.len()).sum();
                            let all_op_hashes_resolved = vis
                                .distinct_image_hashes
                                .iter()
                                .all(|h| r.by_hash.contains_key(h));
                            let all_fonts_resolved = vis
                                .distinct_font_ids
                                .iter()
                                .all(|fid| r.font_meta.contains_key(fid));
                            let ok = r.by_hash.len() == enc_images
                                && all_op_hashes_resolved
                                && all_fonts_resolved;
                            (
                                r.by_hash.len(),
                                bytes_total,
                                r.glyph_outlines.len(),
                                r.font_meta.len(),
                                ok,
                            )
                        }
                        Err(_) => (0, 0, 0, 0, false),
                    },
                    Err(_) => (0, 0, 0, 0, false),
                };

            let round_trip_ok = decode_ok
                && resources_ok
                && vis.fill == enc_fill
                && vis.stroke == enc_stroke
                && vis.push_layer == enc_push_layer
                && vis.push_clip_layer == enc_push_clip
                && vis.pop_layer == enc_pop
                && (vis.glyph_run + vis.text_run) == enc_glyph_runs
                && vis.distinct_font_ids.len() == enc_fonts
                && vis.distinct_image_hashes.len() == enc_images;

            format!(
                concat!(
                    "{{",
                    "\"framedBytes\":{fb},",
                    "\"headerBytes\":{hb},",
                    "\"opStreamBytes\":{ob},",
                    "\"encoder\":{{\"opCount\":{eo},\"fill\":{ef},\"stroke\":{es},\"pushLayer\":{epl},\"pushClipLayer\":{epc},\"popLayer\":{epo},\"glyphRun\":{egr},\"glyphs\":{egs},\"fonts\":{efc},\"images\":{eic}}},",
                    "\"decoder\":{{\"fill\":{df},\"stroke\":{ds},\"pushLayer\":{dpl},\"pushClipLayer\":{dpc},\"popLayer\":{dpo},\"glyphRun\":{dgr},\"glyphs\":{dgs},\"fonts\":{dfc},\"images\":{dic}}},",
                    "\"paints\":{{\"solid\":{dps},\"gradient\":{dpg},\"image\":{dpi},\"gradientStops\":{dgst}}},",
                    "\"resources\":{{\"count\":{drc},\"totalBytes\":{drb},\"ok\":{ro},\"glyphOutlines\":{dgo},\"fontMeta\":{dfm}}},",
                    "\"roundTripOk\":{rt},",
                    "\"decodeOk\":{dk},",
                    "\"decodeError\":\"{de}\"",
                    "}}"
                ),
                fb = framed_len,
                hb = crate::paint::scene_record::HEADER_SIZE,
                ob = op_stream_len,
                eo = enc_ops,
                ef = enc_fill, es = enc_stroke,
                epl = enc_push_layer, epc = enc_push_clip, epo = enc_pop,
                egr = enc_glyph_runs, egs = enc_glyphs,
                efc = enc_fonts, eic = enc_images,
                df = vis.fill, ds = vis.stroke,
                dpl = vis.push_layer, dpc = vis.push_clip_layer, dpo = vis.pop_layer,
                dgr = vis.glyph_run, dgs = vis.glyph_total,
                dfc = vis.distinct_font_ids.len(), dic = vis.distinct_image_hashes.len(),
                dps = vis.solid_paints, dpg = vis.gradient_paints, dpi = vis.image_paints,
                dgst = vis.gradient_stops,
                drc = dec_res_count, drb = dec_res_bytes, ro = resources_ok,
                dgo = dec_glyph_outlines, dfm = dec_font_meta,
                rt = round_trip_ok,
                dk = decode_ok,
                de = decode_err.replace('"', "'"),
            )
        }));
        result.unwrap_or_default()
    }
}

#[cfg(test)]
mod rbi_have_keys {
    use super::unpack_u64_set;

    #[test]
    fn reads_little_endian_keys() {
        let mut b = Vec::new();
        b.extend_from_slice(&1u64.to_le_bytes());
        b.extend_from_slice(&0xDEAD_BEEF_1234_5678u64.to_le_bytes());
        let got = unpack_u64_set(&b);
        assert!(got.contains(&1));
        assert!(got.contains(&0xDEAD_BEEF_1234_5678));
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn empty_means_nothing_delivered() {
        assert!(unpack_u64_set(&[]).is_empty());
    }

    #[test]
    fn a_truncated_tail_is_dropped_not_misread() {
        let mut b = 7u64.to_le_bytes().to_vec();
        b.extend_from_slice(&[9, 9, 9]);
        let got = unpack_u64_set(&b);
        assert_eq!(got.len(), 1);
        assert!(got.contains(&7));
    }
}
