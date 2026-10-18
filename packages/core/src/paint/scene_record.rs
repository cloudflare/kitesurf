// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Encodes the KSC0 paint stream consumed by `scene_decode`.
//! `finish_framed` writes its header and image/font resources. The encoder and
//! decoder share wire constants, with round-trip tests checking their agreement.
//! KSC0 is co-versioned with its decoder, not a stable public format. Integers are LE.

use std::collections::HashMap;

use anyrender::{Glyph as AnyGlyph, NormalizedCoord, PaintRef, RenderContext};
use kurbo::{Affine, PathEl, Rect, Shape, Stroke};
use peniko::{BlendMode, Color, Fill as PenikoFill, StyleRef};

const OP_PUSH_LAYER: usize = 0;
const OP_PUSH_CLIP_LAYER: usize = 1;
const OP_POP_LAYER: usize = 2;
const OP_FILL: usize = 3;
const OP_STROKE: usize = 4;
const OP_GLYPH_RUN: usize = 5;
const OP_BOX_SHADOW: usize = 6;

const OP_KIND_COUNT: usize = 7;

const MAX_RAW_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MIN_WEBP_IMAGE_BYTES: usize = 4096;

pub const HEADER_MAGIC: [u8; 4] = *b"KSC0";
/// Bump on any wire change; the decoder and the CLI's rasterizer manifest require an exact match.
pub const WIRE_VERSION: u32 = 16;
/// u32 fields after magic: version, viewport w/h, scroll x/y, op count (informational, excludes
/// `Part`), resource offset (0 = none, else ends the op stream), render-band top y and height.
pub const HEADER_SIZE: usize = 40;

// Op tags. Each op lists its fields in the order `write_*` emits them; `Part` brackets
// semantic boxes (node ID u64, part code u8) for hit testing and is omitted in replay mode.
pub(crate) const TAG_PUSH_LAYER: u8 = 0x01;
pub(crate) const TAG_PUSH_CLIP_LAYER: u8 = 0x02;
pub(crate) const TAG_POP_LAYER: u8 = 0x03;
pub(crate) const TAG_FILL: u8 = 0x04;
pub(crate) const TAG_STROKE: u8 = 0x05;
pub(crate) const TAG_GLYPH_RUN: u8 = 0x06;
pub(crate) const TAG_BOX_SHADOW: u8 = 0x07;
pub(crate) const TAG_TEXT_RUN: u8 = 0x08;
pub(crate) const TAG_PART: u8 = 0x09;

// Paint tags: solid is RGBA8, image is a content hash u64, gradient has kind, extend, color
// space, hue and alpha bytes, geometry, then u16 stops of 21 bytes. Unknown enums decode to
// defaults.
pub(crate) const PAINT_SOLID: u8 = 0x00;
pub(crate) const PAINT_GRADIENT: u8 = 0x01;
pub(crate) const PAINT_IMAGE: u8 = 0x02;

pub(crate) const PATH_MOVE: u8 = 0x00;
pub(crate) const PATH_LINE: u8 = 0x01;
pub(crate) const PATH_QUAD: u8 = 0x02;
pub(crate) const PATH_CURVE: u8 = 0x03;
pub(crate) const PATH_CLOSE: u8 = 0x04;
const PATH_END: u8 = 0xff;

// Paths are [precision][elements][PATH_END]. Q3 writes i16 eighths of a pixel and is used only
// when every point fits in ±Q3_MAX_ABS; otherwise coordinates are f32.
pub(crate) const PATH_PREC_Q3: u8 = 0x00;
pub(crate) const PATH_PREC_F32: u8 = 0x01;

// Op transform modes. SAME_AS_PREV reuses the last op transform and is invalid before the first;
// the decoder resets that state per scene. Fill and stroke carry a separate brush transform.
pub(crate) const TXFORM_IDENTITY: u8 = 0x00;
pub(crate) const TXFORM_SAME_AS_PREV: u8 = 0x01;
pub(crate) const TXFORM_FULL: u8 = 0x02;
pub(crate) const Q3_UNITS_PER_PIXEL: f32 = 8.0;
pub(crate) const Q3_PIXELS_PER_UNIT: f32 = 0.125;
const Q3_MAX_ABS: f32 = 4095.875;
pub const PATH_END_TAG: u8 = PATH_END;

#[derive(Clone, Copy, PartialEq, Eq)]
struct FontKey {
    blob_ptr: usize,
    face_index: u32,
    coord_sig: u64,
    coord_len: u32,
}

impl FontKey {
    fn new(blob_ptr: usize, face_index: u32, coords: &[NormalizedCoord]) -> Self {
        let mut coord_sig = 0u64;
        for c in coords {
            coord_sig = (coord_sig.rotate_left(5) ^ *c as u16 as u64).wrapping_mul(0x100000001b3);
        }
        Self {
            blob_ptr,
            face_index,
            coord_sig,
            coord_len: coords.len() as u32,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ImageInfo {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) wire_bytes: peniko::Blob<u8>,
    pub(crate) format: u8,
    pub(crate) needed_w: u32,
    pub(crate) needed_h: u32,
}

#[derive(Clone, Copy, Debug)]
struct FontMeta {
    upem: u16,
    stable_hash: u64,
    blob_hash: u64,
    face_index: u32,
}

// Kinds in the on-demand RBI resource batch, which are distinct from the KSC0 table kinds below.
// The engine parses the batch layout in `packages/engine/src/rbi-protocol.ts`.
pub const RBI_RESOURCE_KIND_GLYPH: u8 = 0;
pub const RBI_RESOURCE_KIND_FONT_METRICS: u8 = 1;
pub const RBI_RESOURCE_KIND_IMAGE: u8 = 2;
pub const RBI_RESOURCE_KIND_FONT_DATA: u8 = 3;
pub const FONT_DATA_REF_BLOB: u8 = 0;
pub const FONT_DATA_REF_ASSET: u8 = 1;

pub const IMAGE_FORMAT_ENGINE_REF: u8 = 3;

// Reserve bit 63 for engine keys; peniko Blob IDs count upward from zero.
pub(crate) const ENGINE_KEY_MARKER: u64 = 1u64 << 63;

// KSC0 resource-table kinds. Glyph outlines travel only through the RBI batch; the decoder skips
// unknown kinds by payload length.
pub(crate) const RES_KIND_IMAGE: u8 = 0;
pub(crate) const RES_KIND_GLYPH_OUTLINE: u8 = 1;
pub(crate) const RES_KIND_FONT_METADATA: u8 = 2;

// [hash u64][width u32][height u32][kind u8][format u8][reserved 2][payload length u32].
const RESOURCE_ENTRY_HEADER_BYTES: usize = 24;
const RESOURCE_ENTRY_RESERVED_BYTES: usize = 2;
pub(crate) const SCENE_RESOURCE_COUNT_BYTES: usize = 4;
pub(crate) const IMAGE_REF_HINT_BYTES: usize = 8;
pub(crate) const FONT_METADATA_HASH_BYTES: usize = 8;
// [stable font hash u64][blob hash u64][face index u32]. Only the stable hash covers variation
// coordinates; the entry's hash field is the font ID and its height is units per em.
pub(crate) const FONT_METADATA_BYTES: usize = 20;
const FONT_METRICS_HEADER_BYTES: usize = 8;
const FONT_CMAP_ENTRY_BYTES: usize = 6;
const FONT_GLYPH_ADVANCE_BYTES: usize = 2;

pub struct RecordingScene {
    buf: Vec<u8>,
    op_count: u32,
    op_counts: [u32; OP_KIND_COUNT],
    glyph_run_count: u32,
    glyph_count: u64,
    fonts: Vec<(FontKey, FontMeta)>,
    images: HashMap<u64, ImageInfo>,
    image_rgba_bytes_total: usize,
    glyph_outlines: HashMap<(u32, u32), Vec<u8>>,
    glyph_seen: GlyphSeen,
    font_bytes: HashMap<u64, (peniko::Blob<u8>, u32)>,
    font_tables: FontTableCache,
    glyph_scratch: Vec<AnyGlyph>,
    text_scratch: String,
    depth: u32,
    max_depth: u32,
    dropped_paths: u32,
    viewport_w: u32,
    viewport_h: u32,
    scroll_x: u32,
    scroll_y: u32,
    render_top_y: u32,
    render_h: u32,
    last_transform: Option<[f32; 6]>,
    emit_text_runs: bool,
    extract_glyph_outlines: bool,
    emit_parts: bool,
    pub(crate) raw_images: bool,
    raw_image_bytes: usize,
}

impl Default for RecordingScene {
    fn default() -> Self {
        Self::new()
    }
}

impl RecordingScene {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
            op_count: 0,
            op_counts: [0; OP_KIND_COUNT],
            glyph_run_count: 0,
            glyph_count: 0,
            fonts: Vec::new(),
            images: HashMap::new(),
            image_rgba_bytes_total: 0,
            glyph_outlines: HashMap::new(),
            glyph_seen: GlyphSeen::default(),
            font_bytes: HashMap::new(),
            font_tables: FontTableCache::default(),
            glyph_scratch: Vec::new(),
            text_scratch: String::new(),
            depth: 0,
            max_depth: 0,
            dropped_paths: 0,
            viewport_w: 0,
            viewport_h: 0,
            scroll_x: 0,
            scroll_y: 0,
            render_top_y: 0,
            render_h: 0,
            last_transform: None,
            emit_text_runs: true,
            extract_glyph_outlines: true,
            emit_parts: true,
            raw_images: false,
            raw_image_bytes: 0,
        }
    }

    pub fn for_replay() -> Self {
        let mut s = Self::new();
        s.emit_text_runs = false;
        s.extract_glyph_outlines = false;
        s.emit_parts = false;
        s
    }

    pub fn set_viewport(&mut self, w: u32, h: u32, scroll_x: u32, scroll_y: u32) {
        self.viewport_w = w;
        self.viewport_h = h;
        self.scroll_x = scroll_x;
        self.scroll_y = scroll_y;
        if self.render_h == 0 {
            self.render_top_y = scroll_y;
            self.render_h = h;
        }
    }

    pub fn set_render_region(&mut self, render_top_y: u32, render_h: u32) {
        self.render_top_y = render_top_y;
        self.render_h = render_h;
    }

    pub fn finish_framed(self) -> Vec<u8> {
        let has_resources = !self.images.is_empty() || !self.fonts.is_empty();

        let mut resource_bytes_estimate = 0usize;
        for info in self.images.values() {
            let payload_len = match info.format {
                0 => info.wire_bytes.data().len(),
                2 => 8,
                _ => 0,
            };
            resource_bytes_estimate += RESOURCE_ENTRY_HEADER_BYTES + payload_len;
        }
        resource_bytes_estimate +=
            (RESOURCE_ENTRY_HEADER_BYTES + FONT_METADATA_BYTES) * self.fonts.len();

        let capacity =
            HEADER_SIZE + self.buf.len() + SCENE_RESOURCE_COUNT_BYTES + resource_bytes_estimate;
        let mut out = Vec::with_capacity(capacity);

        let resource_offset: u32 = if has_resources {
            (HEADER_SIZE + self.buf.len()) as u32
        } else {
            0
        };

        out.extend_from_slice(&HEADER_MAGIC);
        out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
        out.extend_from_slice(&self.viewport_w.to_le_bytes());
        out.extend_from_slice(&self.viewport_h.to_le_bytes());
        out.extend_from_slice(&self.scroll_x.to_le_bytes());
        out.extend_from_slice(&self.scroll_y.to_le_bytes());
        out.extend_from_slice(&self.op_count.to_le_bytes());
        out.extend_from_slice(&resource_offset.to_le_bytes());
        out.extend_from_slice(&self.render_top_y.to_le_bytes());
        out.extend_from_slice(&self.render_h.to_le_bytes());
        debug_assert_eq!(out.len(), HEADER_SIZE);

        out.extend_from_slice(&self.buf);

        if resource_offset != 0 {
            let total_count = self.images.len() + self.fonts.len();
            out.extend_from_slice(&(total_count as u32).to_le_bytes());

            let mut images: Vec<_> = self.images.iter().collect();
            images.sort_unstable_by_key(|(hash, _)| **hash);
            for (hash, info) in images {
                let mut hint = [0u8; IMAGE_REF_HINT_BYTES];
                let payload: &[u8] = match info.format {
                    0 => info.wire_bytes.data(),
                    2 | IMAGE_FORMAT_ENGINE_REF => {
                        hint[0..4].copy_from_slice(&info.needed_w.to_le_bytes());
                        hint[4..8].copy_from_slice(&info.needed_h.to_le_bytes());
                        &hint
                    }
                    _ => &[],
                };
                write_resource_entry(
                    &mut out,
                    *hash,
                    info.width,
                    info.height,
                    RES_KIND_IMAGE,
                    info.format,
                    payload,
                );
            }
            for (font_id, (_, meta)) in self.fonts.iter().enumerate() {
                let mut payload = [0u8; FONT_METADATA_BYTES];
                payload[0..8].copy_from_slice(&meta.stable_hash.to_le_bytes());
                payload[8..16].copy_from_slice(&meta.blob_hash.to_le_bytes());
                payload[16..20].copy_from_slice(&meta.face_index.to_le_bytes());
                write_resource_entry(
                    &mut out,
                    font_id as u64,
                    0,
                    meta.upem as u32,
                    RES_KIND_FONT_METADATA,
                    0,
                    &payload,
                );
            }
        }
        out
    }

    pub fn drain_image_needed(&mut self) -> Vec<(u64, u32, u32)> {
        self.images
            .iter()
            .filter(|(_, info)| info.format == 2)
            .map(|(hash, info)| (*hash, info.needed_w, info.needed_h))
            .collect()
    }

    pub(crate) fn image_hashes(&self) -> impl Iterator<Item = u64> + '_ {
        self.images.keys().copied()
    }

    pub fn drain_rbi_images(&mut self) -> Vec<(u64, ImageInfo)> {
        let mut out = Vec::new();
        for (hash, info) in self.images.iter_mut() {
            let shippable = *hash & ENGINE_KEY_MARKER != 0 || !info.wire_bytes.data().is_empty();
            if info.format != 0 && shippable {
                let taken = ImageInfo {
                    width: info.width,
                    height: info.height,
                    wire_bytes: std::mem::replace(
                        &mut info.wire_bytes,
                        peniko::Blob::from(Vec::new()),
                    ),
                    format: info.format,
                    needed_w: info.needed_w,
                    needed_h: info.needed_h,
                };
                out.push((*hash, taken));
            }
        }
        out
    }

    pub fn drain_glyph_outlines(&mut self) -> Vec<(u64, Vec<u8>)> {
        let mut out = Vec::with_capacity(self.glyph_outlines.len());
        let outlines = std::mem::take(&mut self.glyph_outlines);
        for ((font_id, glyph_id), path_bytes) in outlines {
            let stable = self.font_stable_hash(font_id);
            let wire_hash = mix64(stable, glyph_id);
            out.push((wire_hash, path_bytes));
        }
        out
    }

    pub fn set_glyph_seen(&mut self, seen: GlyphSeen) {
        self.glyph_seen = seen;
    }

    pub fn take_glyph_seen(&mut self) -> GlyphSeen {
        std::mem::take(&mut self.glyph_seen)
    }

    pub fn set_font_tables(&mut self, tables: FontTableCache) {
        self.font_tables = tables;
    }

    pub fn take_font_tables(&mut self) -> FontTableCache {
        std::mem::take(&mut self.font_tables)
    }

    pub fn drain_font_bytes(&mut self) -> Vec<(u64, peniko::Blob<u8>, u32)> {
        let taken = std::mem::take(&mut self.font_bytes);
        taken
            .into_iter()
            .map(|(hash, (blob, idx))| (hash, blob, idx))
            .collect()
    }

    pub fn op_stream(&self) -> &[u8] {
        &self.buf
    }

    pub fn op_count(&self) -> u32 {
        self.op_count
    }
    pub fn fill_count(&self) -> u32 {
        self.op_counts[OP_FILL]
    }
    pub fn stroke_count(&self) -> u32 {
        self.op_counts[OP_STROKE]
    }
    pub fn push_layer_count(&self) -> u32 {
        self.op_counts[OP_PUSH_LAYER]
    }
    pub fn push_clip_layer_count(&self) -> u32 {
        self.op_counts[OP_PUSH_CLIP_LAYER]
    }
    pub fn pop_layer_count(&self) -> u32 {
        self.op_counts[OP_POP_LAYER]
    }
    pub fn glyph_run_count(&self) -> u32 {
        self.glyph_run_count
    }
    pub fn glyph_count(&self) -> u64 {
        self.glyph_count
    }
    pub fn font_count(&self) -> usize {
        self.fonts.len()
    }
    pub fn image_count(&self) -> usize {
        self.images.len()
    }

    pub fn stats_json(&self) -> String {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let mut gz = GzEncoder::new(
            Vec::with_capacity(self.buf.len() / 2),
            Compression::default(),
        );
        let _ = gz.write_all(&self.buf);
        let gzipped = gz.finish().unwrap_or_default();

        let mut framed = Vec::with_capacity(HEADER_SIZE + self.buf.len());
        framed.extend_from_slice(&HEADER_MAGIC);
        framed.extend_from_slice(&WIRE_VERSION.to_le_bytes());
        framed.extend_from_slice(&self.viewport_w.to_le_bytes());
        framed.extend_from_slice(&self.viewport_h.to_le_bytes());
        framed.extend_from_slice(&self.scroll_x.to_le_bytes());
        framed.extend_from_slice(&self.scroll_y.to_le_bytes());
        framed.extend_from_slice(&self.op_count.to_le_bytes());
        framed.extend_from_slice(&0u32.to_le_bytes());
        framed.extend_from_slice(&self.render_top_y.to_le_bytes());
        framed.extend_from_slice(&self.render_h.to_le_bytes());
        framed.extend_from_slice(&self.buf);
        let mut vis = crate::paint::scene_decode::StatsVisitor::default();
        let _ = crate::paint::scene_decode::decode(&framed, &mut vis);
        let bb = |tag: u8| -> (u64, u64) {
            let i = (tag as usize) & 0x0f;
            (vis.count_by_tag[i], vis.bytes_by_tag[i])
        };
        let (c_push, b_push) = bb(TAG_PUSH_LAYER);
        let (c_clip, b_clip) = bb(TAG_PUSH_CLIP_LAYER);
        let (c_pop, b_pop) = bb(TAG_POP_LAYER);
        let (c_fill, b_fill) = bb(TAG_FILL);
        let (c_stroke, b_stroke) = bb(TAG_STROKE);
        let (c_glyph, b_glyph) = bb(TAG_GLYPH_RUN);
        let (c_shadow, b_shadow) = bb(TAG_BOX_SHADOW);
        let (c_text, b_text) = bb(TAG_TEXT_RUN);

        format!(
            concat!(
                "{{",
                "\"sceneBytes\":{sb},",
                "\"sceneBytesGzipped\":{gb},",
                "\"opCount\":{oc},",
                "\"opsByKind\":{{",
                "\"pushLayer\":{k0},",
                "\"pushClipLayer\":{k1},",
                "\"popLayer\":{k2},",
                "\"fill\":{k3},",
                "\"stroke\":{k4},",
                "\"glyphRun\":{k5},",
                "\"boxShadow\":{k6}",
                "}},",
                "\"decoded\":{{",
                "\"textRunCount\":{v_tr},",
                "\"textCharTotal\":{v_tc},",
                "\"glyphRunCount\":{v_gr},",
                "\"glyphTotal\":{v_gt}",
                "}},",
                "\"bytesByKind\":{{",
                "\"pushLayer\":{{\"c\":{c_push},\"b\":{b_push}}},",
                "\"pushClipLayer\":{{\"c\":{c_clip},\"b\":{b_clip}}},",
                "\"popLayer\":{{\"c\":{c_pop},\"b\":{b_pop}}},",
                "\"fill\":{{\"c\":{c_fill},\"b\":{b_fill}}},",
                "\"stroke\":{{\"c\":{c_stroke},\"b\":{b_stroke}}},",
                "\"glyphRun\":{{\"c\":{c_glyph},\"b\":{b_glyph}}},",
                "\"boxShadow\":{{\"c\":{c_shadow},\"b\":{b_shadow}}},",
                "\"textRun\":{{\"c\":{c_text},\"b\":{b_text}}}",
                "}},",
                "\"glyphRunCount\":{grc},",
                "\"glyphCount\":{gc},",
                "\"fontCount\":{fc},",
                "\"imageCount\":{ic},",
                "\"imageRgbaBytesTotal\":{ib},",
                "\"maxLayerDepth\":{md},",
                "\"droppedPaths\":{dp}",
                "}}"
            ),
            sb = self.buf.len(),
            gb = gzipped.len(),
            oc = self.op_count,
            k0 = self.op_counts[OP_PUSH_LAYER],
            k1 = self.op_counts[OP_PUSH_CLIP_LAYER],
            k2 = self.op_counts[OP_POP_LAYER],
            k3 = self.op_counts[OP_FILL],
            k4 = self.op_counts[OP_STROKE],
            k5 = self.op_counts[OP_GLYPH_RUN],
            k6 = self.op_counts[OP_BOX_SHADOW],
            grc = self.glyph_run_count,
            gc = self.glyph_count,
            fc = self.fonts.len(),
            ic = self.images.len(),
            ib = self.image_rgba_bytes_total,
            md = self.max_depth,
            dp = self.dropped_paths,
            v_tr = vis.text_run,
            v_tc = vis.text_char_total,
            v_gr = vis.glyph_run,
            v_gt = vis.glyph_total,
            c_push = c_push,
            b_push = b_push,
            c_clip = c_clip,
            b_clip = b_clip,
            c_pop = c_pop,
            b_pop = b_pop,
            c_fill = c_fill,
            b_fill = b_fill,
            c_stroke = c_stroke,
            b_stroke = b_stroke,
            c_glyph = c_glyph,
            b_glyph = b_glyph,
            c_shadow = c_shadow,
            b_shadow = b_shadow,
            c_text = c_text,
            b_text = b_text,
        )
    }

    #[inline]
    // Part markers are wire metadata, not entries in the KSC0 operation count.
    fn tag_untracked(&mut self, tag: u8) {
        self.buf.push(tag);
    }

    #[inline]
    fn tag(&mut self, tag: u8, kind: usize) {
        self.buf.push(tag);
        self.op_count += 1;
        self.op_counts[kind] += 1;
    }

    #[inline]
    fn w_u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    #[inline]
    fn w_u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn w_u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn w_u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn w_i16(&mut self, v: i16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn w_f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    #[inline]
    fn w_rgba8(&mut self, c: peniko::color::Rgba8) {
        self.buf.extend_from_slice(&[c.r, c.g, c.b, c.a]);
    }

    fn w_transform(&mut self, a: Affine) {
        let c = a.as_coeffs();
        let f: [f32; 6] = [
            c[0] as f32,
            c[1] as f32,
            c[2] as f32,
            c[3] as f32,
            c[4] as f32,
            c[5] as f32,
        ];
        const IDENT: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        if f == IDENT {
            self.w_u8(TXFORM_IDENTITY);
            self.last_transform = Some(IDENT);
            return;
        }
        if let Some(prev) = self.last_transform {
            if prev == f {
                self.w_u8(TXFORM_SAME_AS_PREV);
                return;
            }
        }
        self.w_u8(TXFORM_FULL);
        for v in &f {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
        self.last_transform = Some(f);
    }

    fn w_brush_transform(&mut self, bt: Option<Affine>) {
        match bt {
            None => self.w_u8(0),
            Some(a) => {
                self.w_u8(1);
                let c = a.as_coeffs();
                for v in &[
                    c[0] as f32,
                    c[1] as f32,
                    c[2] as f32,
                    c[3] as f32,
                    c[4] as f32,
                    c[5] as f32,
                ] {
                    self.buf.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Used by kitesurf-core's ordered KSC0 TextRun writer."
    )]
    fn try_emit_text_run(
        &mut self,
        font: &peniko::FontData,
        font_id: u32,
        font_size: f32,
        normalized_coords: &[NormalizedCoord],
        transform: Affine,
        rgba: peniko::color::Rgba8,
        glyphs: &[AnyGlyph],
        synthetic_italic: bool,
    ) -> bool {
        if glyphs.is_empty() {
            return false;
        }
        let Some(&(
            _,
            FontMeta {
                upem, stable_hash, ..
            },
        )) = self.fonts.get(font_id as usize)
        else {
            return false;
        };
        cap_fonts(&mut self.font_tables.fonts, stable_hash);
        let tables = self
            .font_tables
            .fonts
            .entry(stable_hash)
            .or_insert_with(|| {
                let rev = build_reverse_cmap(font.data.data(), font.index)?;
                let hmtx = build_hmtx_advances(font.data.data(), font.index)?;
                Some(FontTables { rev, hmtx })
            });
        let Some(FontTables { rev, hmtx }) = tables else {
            return false;
        };
        let upem = upem as f32;
        let scale = font_size / upem;

        let baseline_y = glyphs[0].y;
        self.text_scratch.clear();
        let mut kerns: Vec<(u16, i8)> = Vec::new();
        const KERN_MAX_ABS: f32 = 15.875;
        const KERN_EPSILON: f32 = 0.05;
        for (i, g) in glyphs.iter().enumerate() {
            if (g.y - baseline_y).abs() > 0.01 {
                return false;
            }
            let idx = g.id as usize;
            let cp = match rev.get(idx).and_then(|c| *c) {
                Some(cp) => cp,
                None => return false,
            };
            match char::from_u32(cp) {
                Some(c) if !c.is_control() => self.text_scratch.push(c),
                _ => return false,
            }

            if i + 1 < glyphs.len() {
                let actual = glyphs[i + 1].x - g.x;
                let hmtx_adv = hmtx.get(idx).copied().unwrap_or(0) as f32 * scale;
                let delta = actual - hmtx_adv;
                if delta.abs() > KERN_EPSILON {
                    if delta.abs() > KERN_MAX_ABS {
                        return false;
                    }
                    let dx_q3 = (delta * Q3_UNITS_PER_PIXEL).round() as i32;
                    if !(-127..=127).contains(&dx_q3) {
                        return false;
                    }
                    if i > u16::MAX as usize {
                        return false;
                    }
                    kerns.push((i as u16, dx_q3 as i8));
                }
            }
        }

        if self.text_scratch.len() > u16::MAX as usize {
            return false;
        }

        let start_x_q3 = (glyphs[0].x * Q3_UNITS_PER_PIXEL).round();
        let start_y_q3 = (baseline_y * Q3_UNITS_PER_PIXEL).round();
        if !(-32_768.0..=32_767.0).contains(&start_x_q3)
            || !(-32_768.0..=32_767.0).contains(&start_y_q3)
        {
            return false;
        }
        let start_x_i16 = start_x_q3 as i16;
        let start_y_i16 = start_y_q3 as i16;

        self.tag(TAG_TEXT_RUN, OP_GLYPH_RUN);
        self.w_u32(font_id);
        self.w_f32(font_size);
        let coord_len = normalized_coords.len().min(u16::MAX as usize) as u16;
        self.w_u16(coord_len);
        for c in &normalized_coords[..coord_len as usize] {
            self.w_i16(*c);
        }
        self.w_transform(transform);
        self.w_u8(PAINT_SOLID);
        self.w_rgba8(rgba);
        self.buf.extend_from_slice(&start_x_i16.to_le_bytes());
        self.buf.extend_from_slice(&start_y_i16.to_le_bytes());
        self.w_u16(self.text_scratch.len() as u16);
        let text = std::mem::take(&mut self.text_scratch);
        self.buf.extend_from_slice(text.as_bytes());
        self.text_scratch = text;
        self.w_u16(kerns.len() as u16);
        for (char_idx, dx) in &kerns {
            self.w_u16(*char_idx);
            self.buf.push(*dx as u8);
        }
        self.w_u8(u8::from(synthetic_italic));
        true
    }

    fn w_path(&mut self, shape: &impl Shape) -> bool {
        let mut els: smallvec::SmallVec<[(u8, [f32; 6]); 32]> = smallvec::SmallVec::new();
        let mut min_x = f32::INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let track =
            |x: f32, y: f32, min_x: &mut f32, min_y: &mut f32, max_x: &mut f32, max_y: &mut f32| {
                if x < *min_x {
                    *min_x = x;
                }
                if x > *max_x {
                    *max_x = x;
                }
                if y < *min_y {
                    *min_y = y;
                }
                if y > *max_y {
                    *max_y = y;
                }
            };
        for el in shape.path_elements(0.25) {
            match el {
                PathEl::MoveTo(p) => {
                    let x = p.x as f32;
                    let y = p.y as f32;
                    track(x, y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    els.push((PATH_MOVE, [x, y, 0., 0., 0., 0.]));
                }
                PathEl::LineTo(p) => {
                    let x = p.x as f32;
                    let y = p.y as f32;
                    track(x, y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    els.push((PATH_LINE, [x, y, 0., 0., 0., 0.]));
                }
                PathEl::QuadTo(c, p) => {
                    let cx = c.x as f32;
                    let cy = c.y as f32;
                    let x = p.x as f32;
                    let y = p.y as f32;
                    track(cx, cy, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    track(x, y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    els.push((PATH_QUAD, [cx, cy, x, y, 0., 0.]));
                }
                PathEl::CurveTo(c1, c2, p) => {
                    let c1x = c1.x as f32;
                    let c1y = c1.y as f32;
                    let c2x = c2.x as f32;
                    let c2y = c2.y as f32;
                    let x = p.x as f32;
                    let y = p.y as f32;
                    track(c1x, c1y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    track(c2x, c2y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    track(x, y, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
                    els.push((PATH_CURVE, [c1x, c1y, c2x, c2y, x, y]));
                }
                PathEl::ClosePath => {
                    els.push((PATH_CLOSE, [0.; 6]));
                }
            }
        }
        if els.is_empty() {
            self.w_u8(PATH_PREC_Q3);
            self.w_u8(PATH_END);
            return false;
        }
        let fits_q3 = min_x.is_finite()
            && max_x.is_finite()
            && min_y.is_finite()
            && max_y.is_finite()
            && min_x >= -Q3_MAX_ABS
            && max_x <= Q3_MAX_ABS
            && min_y >= -Q3_MAX_ABS
            && max_y <= Q3_MAX_ABS;
        if fits_q3 {
            self.w_u8(PATH_PREC_Q3);
            for (tag, c) in &els {
                self.w_u8(*tag);
                match *tag {
                    PATH_MOVE | PATH_LINE => {
                        self.w_q3(c[0]);
                        self.w_q3(c[1]);
                    }
                    PATH_QUAD => {
                        self.w_q3(c[0]);
                        self.w_q3(c[1]);
                        self.w_q3(c[2]);
                        self.w_q3(c[3]);
                    }
                    PATH_CURVE => {
                        self.w_q3(c[0]);
                        self.w_q3(c[1]);
                        self.w_q3(c[2]);
                        self.w_q3(c[3]);
                        self.w_q3(c[4]);
                        self.w_q3(c[5]);
                    }
                    PATH_CLOSE => {}
                    _ => unreachable!(),
                }
            }
        } else {
            self.w_u8(PATH_PREC_F32);
            for (tag, c) in &els {
                self.w_u8(*tag);
                match *tag {
                    PATH_MOVE | PATH_LINE => {
                        self.w_f32(c[0]);
                        self.w_f32(c[1]);
                    }
                    PATH_QUAD => {
                        self.w_f32(c[0]);
                        self.w_f32(c[1]);
                        self.w_f32(c[2]);
                        self.w_f32(c[3]);
                    }
                    PATH_CURVE => {
                        self.w_f32(c[0]);
                        self.w_f32(c[1]);
                        self.w_f32(c[2]);
                        self.w_f32(c[3]);
                        self.w_f32(c[4]);
                        self.w_f32(c[5]);
                    }
                    PATH_CLOSE => {}
                    _ => unreachable!(),
                }
            }
        }
        self.w_u8(PATH_END);
        true
    }

    #[inline]
    fn w_q3(&mut self, v: f32) {
        let q = (v * Q3_UNITS_PER_PIXEL)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        self.buf.extend_from_slice(&q.to_le_bytes());
    }

    fn w_paint(&mut self, p: &PaintRef<'_>, scale: (f64, f64)) {
        match p {
            anyrender::Paint::Solid(c) => {
                self.w_u8(PAINT_SOLID);
                self.w_rgba8(c.to_rgba8());
            }
            anyrender::Paint::Gradient(g) => {
                self.w_u8(PAINT_GRADIENT);
                self.w_gradient(g);
            }
            anyrender::Paint::Image(img_ref) => {
                self.w_u8(PAINT_IMAGE);
                let hash = self.record_image(img_ref, scale);
                self.w_u64(hash);
            }
            _ => {
                self.w_u8(PAINT_SOLID);
                self.w_rgba8(peniko::Color::TRANSPARENT.to_rgba8());
            }
        }
    }

    fn w_gradient(&mut self, g: &peniko::Gradient) {
        use peniko::GradientKind;
        let (kind_tag, geom_floats): (u8, [f32; 6]) = match &g.kind {
            GradientKind::Linear(pos) => (
                0,
                [
                    pos.start.x as f32,
                    pos.start.y as f32,
                    pos.end.x as f32,
                    pos.end.y as f32,
                    0.0,
                    0.0,
                ],
            ),
            GradientKind::Radial(pos) => (
                1,
                [
                    pos.start_center.x as f32,
                    pos.start_center.y as f32,
                    pos.start_radius,
                    pos.end_center.x as f32,
                    pos.end_center.y as f32,
                    pos.end_radius,
                ],
            ),
            GradientKind::Sweep(pos) => (
                2,
                [
                    pos.center.x as f32,
                    pos.center.y as f32,
                    pos.start_angle,
                    pos.end_angle,
                    0.0,
                    0.0,
                ],
            ),
        };
        let geom_len: usize = match kind_tag {
            0 => 4,
            1 => 6,
            _ => 4,
        };
        self.w_u8(kind_tag);
        self.w_u8(g.extend as u8);
        self.w_u8(g.interpolation_cs as u8);
        self.w_u8(g.hue_direction as u8);
        self.w_u8(g.interpolation_alpha_space as u8);
        for v in &geom_floats[..geom_len] {
            self.w_f32(*v);
        }
        let stop_count = g.stops.0.len().min(u16::MAX as usize) as u16;
        self.w_u16(stop_count);
        for stop in g.stops.0.iter().take(stop_count as usize) {
            self.w_f32(stop.offset);
            self.w_u8(stop.color.cs as u8);
            for c in &stop.color.components {
                self.w_f32(*c);
            }
        }
    }

    fn record_image(&mut self, brush: &peniko::ImageBrushRef<'_>, scale: (f64, f64)) -> u64 {
        use peniko::ImageFormat;
        let img = brush.image;
        if img.width == 0 || img.height == 0 {
            return 0;
        }
        let needed_w = ((img.width as f64 * scale.0).ceil() as u32).clamp(1, img.width);
        let needed_h = ((img.height as f64 * scale.1).ceil() as u32).clamp(1, img.height);
        match img.format {
            ImageFormat::Rgba8 => {}
            _ => return 0,
        };
        let rgba = img.data.data();
        let rgba_len = (img.width as usize)
            .checked_mul(img.height as usize)
            .and_then(|px| px.checked_mul(4));
        let encoded_payload = rgba_len != Some(rgba.len());
        let engine_key = if encoded_payload && img.data.id() & ENGINE_KEY_MARKER != 0 {
            Some(img.data.id())
        } else {
            None
        };
        let hash = match engine_key {
            Some(key) => key,
            None => {
                let content_hash = if encoded_payload {
                    blob_content_hash(rgba)
                } else {
                    image_hash_u64(rgba)
                };
                mix64(content_hash ^ ((img.width as u64) << 32), img.height)
            }
        };
        if encoded_payload {
            if let Some(info) = self.images.get_mut(&hash) {
                info.needed_w = info.needed_w.max(needed_w);
                info.needed_h = info.needed_h.max(needed_h);
            } else {
                self.image_rgba_bytes_total += rgba.len();
                self.images.insert(
                    hash,
                    ImageInfo {
                        width: img.width,
                        height: img.height,
                        wire_bytes: img.data.clone(),
                        format: 2,
                        needed_w,
                        needed_h,
                    },
                );
            }
            return hash;
        }
        if !self.images.contains_key(&hash) {
            self.image_rgba_bytes_total += rgba.len();
            let raw = self.raw_images
                && rgba.len() <= MAX_RAW_IMAGE_BYTES.saturating_sub(self.raw_image_bytes);
            let (wire_bytes, format_u8) = if !raw && rgba.len() >= MIN_WEBP_IMAGE_BYTES {
                match encode_webp_lossless(rgba, img.width, img.height) {
                    Some(webp) => (peniko::Blob::from(webp), 1u8),
                    None => (img.data.clone(), 0u8),
                }
            } else {
                (img.data.clone(), 0u8)
            };
            if format_u8 == 0 {
                self.raw_image_bytes += rgba.len();
            }
            self.images.insert(
                hash,
                ImageInfo {
                    width: img.width,
                    height: img.height,
                    wire_bytes,
                    format: format_u8,
                    needed_w: img.width,
                    needed_h: img.height,
                },
            );
        }
        hash
    }

    fn font_stable_hash(&self, font_id: u32) -> u64 {
        self.fonts
            .get(font_id as usize)
            .map_or(0, |(_, m)| m.stable_hash)
    }

    fn record_font(&mut self, font: &peniko::FontData, coords: &[NormalizedCoord]) -> u32 {
        let ptr = font.data.data().as_ptr() as usize;
        let key = FontKey::new(ptr, font.index, coords);
        if let Some(id) = self.fonts.iter().position(|(k, _)| *k == key) {
            return id as u32;
        }
        let blob_hash = blob_content_hash(font.data.data());
        let mut coord_bytes = Vec::with_capacity(coords.len() * 2);
        for c in coords {
            coord_bytes.extend_from_slice(&c.to_le_bytes());
        }
        let stable_hash = mix_coord_hash(blob_hash, &coord_bytes);
        let upem = extract_font_upem(font).unwrap_or(1000);
        let id = self.fonts.len() as u32;
        self.fonts.push((
            key,
            FontMeta {
                upem,
                stable_hash,
                blob_hash,
                face_index: font.index,
            },
        ));
        self.font_bytes
            .entry(font_data_key(blob_hash, font.index))
            .or_insert_with(|| (font.data.clone(), font.index));
        id
    }

    fn record_glyph_outline(
        &mut self,
        font: &peniko::FontData,
        coords: &[NormalizedCoord],
        font_id: u32,
        glyph_id: u32,
    ) {
        let key = (font_id, glyph_id);
        if self.glyph_outlines.contains_key(&key) {
            return;
        }
        let path_bytes = extract_glyph_outline(font, coords, glyph_id).unwrap_or_default();
        self.glyph_outlines.insert(key, path_bytes);
    }
}

struct FontTables {
    rev: Vec<Option<u32>>,
    hmtx: Vec<u16>,
}

#[derive(Default)]
pub struct FontTableCache {
    fonts: HashMap<u64, Option<FontTables>>,
}

const MAX_CACHED_FONTS: usize = 32;

fn cap_fonts<V>(map: &mut HashMap<u64, V>, key: u64) {
    if map.len() >= MAX_CACHED_FONTS && !map.contains_key(&key) {
        map.clear();
    }
}

#[derive(Default)]
pub struct GlyphSeen {
    fonts: HashMap<u64, Vec<u64>>,
}

impl GlyphSeen {
    fn bits_for(&mut self, font: u64) -> &mut Vec<u64> {
        cap_fonts(&mut self.fonts, font);
        self.fonts.entry(font).or_default()
    }

    fn mark(bits: &mut Vec<u64>, glyph: u32) {
        let (word, mask) = (glyph as usize / 64, 1u64 << (glyph % 64));
        if word >= bits.len() {
            bits.resize(word + 1, 0);
        }
        bits[word] |= mask;
    }

    fn is_marked(bits: &[u64], glyph: u32) -> bool {
        let (word, mask) = (glyph as usize / 64, 1u64 << (glyph % 64));
        bits.get(word).is_some_and(|w| w & mask != 0)
    }
}

#[cfg(test)]
thread_local! {
    static TEST_PAINT_PANIC: std::cell::Cell<Option<&'static str>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn arm_test_paint_panic(at: &'static str) {
    TEST_PAINT_PANIC.with(|c| c.set(Some(at)));
}

#[cfg(test)]
fn trip_test_paint_panic(at: &'static str) {
    TEST_PAINT_PANIC.with(|c| {
        if c.get() == Some(at) {
            c.set(None);
            panic!("injected paint panic at {at}");
        }
    });
}

pub(crate) fn is_pure_skew(t: Affine) -> bool {
    let c = t.as_coeffs();
    const EPS: f64 = 1e-6;
    (c[0] - 1.0).abs() < EPS
        && c[1].abs() < EPS
        && (c[3] - 1.0).abs() < EPS
        && c[4].abs() < EPS
        && c[5].abs() < EPS
        && c[2].abs() > EPS
}

impl RenderContext for RecordingScene {}

fn part_code(p: anyrender::ScenePart) -> u8 {
    use anyrender::ScenePart as P;
    match p {
        P::Background => 0,
        P::Border => 1,
        P::Outline => 2,
        P::TableBorder => 3,
        P::TableRowBackground => 4,
        P::TextDecoration => 5,
        P::Marker => 6,
        P::Checkbox { checked: false } => 7,
        P::Checkbox { checked: true } => 8,
        P::Radio { checked: false } => 9,
        P::Radio { checked: true } => 10,
    }
}

impl anyrender::PaintScene for RecordingScene {
    fn begin_part(&mut self, node_id: u64, part: anyrender::ScenePart) {
        if !self.emit_parts {
            return;
        }
        self.tag_untracked(TAG_PART);
        self.w_u8(1);
        self.w_u64(node_id);
        self.w_u8(part_code(part));
    }

    fn end_part(&mut self) {
        if !self.emit_parts {
            return;
        }
        self.tag_untracked(TAG_PART);
        self.w_u8(0);
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.op_count = 0;
        self.op_counts = [0; OP_KIND_COUNT];
        self.glyph_run_count = 0;
        self.glyph_count = 0;
        self.depth = 0;
        self.max_depth = 0;
        self.dropped_paths = 0;
    }

    // The wire carries no clip fill rule, so clips replay non-zero.
    // blitz-paint only clips non-zero; an SVG `clip-rule: evenodd`
    // clip-path (anyrender_svg) loses its rule, as it did before
    // anyrender 0.14 added the parameter.
    fn push_layer(
        &mut self,
        _fill: PenikoFill,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        _filter: Option<std::sync::Arc<anyrender::Filter>>,
        _backdrop_filter: Option<std::sync::Arc<anyrender::Filter>>,
    ) {
        self.tag(TAG_PUSH_LAYER, OP_PUSH_LAYER);
        let bm: BlendMode = blend.into();
        let mix_byte = bm.mix as u8 as u16;
        let compose_byte = bm.compose as u8 as u16;
        self.w_u16(mix_byte | (compose_byte << 8));
        self.w_f32(alpha);
        self.w_transform(transform);
        if !self.w_path(clip) {
            self.dropped_paths += 1;
        }
        self.depth += 1;
        if self.depth > self.max_depth {
            self.max_depth = self.depth;
        }
    }

    fn push_clip_layer(&mut self, _fill: PenikoFill, transform: Affine, clip: &impl Shape) {
        self.tag(TAG_PUSH_CLIP_LAYER, OP_PUSH_CLIP_LAYER);
        self.w_transform(transform);
        if !self.w_path(clip) {
            self.dropped_paths += 1;
        }
        self.depth += 1;
        if self.depth > self.max_depth {
            self.max_depth = self.depth;
        }
    }

    fn pop_layer(&mut self) {
        self.tag(TAG_POP_LAYER, OP_POP_LAYER);
        self.depth = self.depth.saturating_sub(1);
    }

    fn stroke<'p>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'p>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        self.tag(TAG_STROKE, OP_STROKE);
        self.w_f32(style.width as f32);
        self.w_f32(style.miter_limit as f32);
        self.w_u8(match style.start_cap {
            kurbo::Cap::Butt => 0,
            kurbo::Cap::Round => 1,
            kurbo::Cap::Square => 2,
        });
        self.w_u8(match style.join {
            kurbo::Join::Miter => 0,
            kurbo::Join::Round => 1,
            kurbo::Join::Bevel => 2,
        });
        let dashes: Vec<f32> = style
            .dash_pattern
            .iter()
            .take(255)
            .map(|d| *d as f32)
            .collect();
        self.w_f32(style.dash_offset as f32);
        self.w_u8(dashes.len() as u8);
        for d in &dashes {
            self.w_f32(*d);
        }
        self.w_transform(transform);
        self.w_brush_transform(brush_transform);
        let paint_ref: PaintRef<'p> = brush.into();
        self.w_paint(&paint_ref, affine_scale(transform));
        if !self.w_path(shape) {
            self.dropped_paths += 1;
        }
    }

    fn fill<'p>(
        &mut self,
        style: PenikoFill,
        transform: Affine,
        brush: impl Into<PaintRef<'p>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        self.tag(TAG_FILL, OP_FILL);
        self.w_u8(match style {
            PenikoFill::NonZero => 0,
            PenikoFill::EvenOdd => 1,
        });
        self.w_transform(transform);
        self.w_brush_transform(brush_transform);
        let paint_ref: PaintRef<'p> = brush.into();
        self.w_paint(&paint_ref, affine_scale(transform));
        if !self.w_path(shape) {
            self.dropped_paths += 1;
        }
    }

    fn draw_glyphs<'p, 's: 'p>(
        &'s mut self,
        font: &'p peniko::FontData,
        font_size: f32,
        _hint: bool,
        normalized_coords: &'p [NormalizedCoord],
        _embolden: kurbo::Vec2,
        _style: impl Into<StyleRef<'p>>,
        brush: impl Into<PaintRef<'p>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = AnyGlyph> + Clone,
    ) {
        let font_id = self.record_font(font, normalized_coords);
        let mut collected = std::mem::take(&mut self.glyph_scratch);
        collected.clear();
        collected.extend(glyphs);
        if collected.is_empty() {
            self.glyph_scratch = collected;
            return;
        }
        if self.extract_glyph_outlines {
            let stable = self.font_stable_hash(font_id);
            let mut fresh: Vec<u32> = Vec::new();
            {
                let bits = self.glyph_seen.bits_for(stable);
                for g in &collected {
                    if !GlyphSeen::is_marked(bits, g.id) {
                        fresh.push(g.id);
                    }
                }
            }
            #[cfg(test)]
            trip_test_paint_panic("before_record");
            for &gid in &fresh {
                self.record_glyph_outline(font, normalized_coords, font_id, gid);
            }
            if !fresh.is_empty() {
                let bits = self.glyph_seen.bits_for(stable);
                for gid in fresh {
                    GlyphSeen::mark(bits, gid);
                }
            }
            #[cfg(test)]
            trip_test_paint_panic("after_mark");
        }

        let paint_ref: PaintRef<'p> = brush.into();
        let synthetic_italic = glyph_transform.is_some_and(is_pure_skew);
        let text_run_emitted =
            if self.emit_text_runs && (glyph_transform.is_none() || synthetic_italic) {
                if let anyrender::Paint::Solid(c) = &paint_ref {
                    let mut rgba = c.to_rgba8();
                    rgba.a = ((rgba.a as f32) * brush_alpha.clamp(0.0, 1.0)).round() as u8;
                    self.try_emit_text_run(
                        font,
                        font_id,
                        font_size,
                        normalized_coords,
                        transform,
                        rgba,
                        &collected,
                        synthetic_italic,
                    )
                } else {
                    false
                }
            } else {
                false
            };

        if text_run_emitted {
            self.glyph_run_count += 1;
            self.glyph_count += collected.len() as u64;
            self.glyph_scratch = collected;
            return;
        }

        self.tag(TAG_GLYPH_RUN, OP_GLYPH_RUN);
        self.w_u32(font_id);
        self.w_f32(font_size);

        let coord_len = normalized_coords.len().min(u16::MAX as usize) as u16;
        self.w_u16(coord_len);
        for c in &normalized_coords[..coord_len as usize] {
            self.w_i16(*c);
        }

        let combined = if let Some(gt) = glyph_transform {
            let c = gt.as_coeffs();
            let uniform_y = collected
                .first()
                .map(|g| g.y)
                .filter(|y| collected.iter().all(|g| (g.y - *y).abs() < 1e-6));
            match (is_pure_skew(gt), uniform_y) {
                (true, Some(y)) => transform * Affine::translate((-(c[2] * y as f64), 0.0)) * gt,
                _ => transform * gt,
            }
        } else {
            transform
        };
        self.w_transform(combined);

        match &paint_ref {
            anyrender::Paint::Solid(c) => {
                let mut rgba = c.to_rgba8();
                rgba.a = ((rgba.a as f32) * brush_alpha.clamp(0.0, 1.0)).round() as u8;
                self.w_u8(PAINT_SOLID);
                self.w_rgba8(rgba);
            }
            _ => self.w_paint(&paint_ref, affine_scale(transform)),
        }

        let n = collected.len() as u32;
        self.w_u32(n);
        for g in &collected {
            self.w_u32(g.id);
            self.w_f32(g.x);
            self.w_f32(g.y);
        }
        self.glyph_run_count += 1;
        self.glyph_count += collected.len() as u64;
        self.glyph_scratch = collected;
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: Rect,
        brush: Color,
        radius: f64,
        std_dev: f64,
    ) {
        self.tag(TAG_BOX_SHADOW, OP_BOX_SHADOW);
        self.w_transform(transform);
        self.w_f32(rect.x0 as f32);
        self.w_f32(rect.y0 as f32);
        self.w_f32(rect.x1 as f32);
        self.w_f32(rect.y1 as f32);
        self.w_rgba8(brush.to_rgba8());
        self.w_f32(radius as f32);
        self.w_f32(std_dev as f32);
    }
}

fn write_resource_entry(
    out: &mut Vec<u8>,
    hash: u64,
    width: u32,
    height: u32,
    kind: u8,
    format: u8,
    payload: &[u8],
) {
    out.extend_from_slice(&hash.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.push(kind);
    out.push(format);
    out.extend_from_slice(&[0u8; RESOURCE_ENTRY_RESERVED_BYTES]);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

fn extract_font_upem(font: &peniko::FontData) -> Option<u16> {
    use skrifa::raw::{FontRef, TableProvider};
    let bytes = font.data.data();
    let font_ref = FontRef::from_index(bytes, font.index).ok()?;
    let head = font_ref.head().ok()?;
    let _maxp = font_ref.maxp().ok()?;
    Some(head.units_per_em())
}

pub fn extract_font_metrics(font_bytes: &[u8], font_index: u32) -> Option<Vec<u8>> {
    use skrifa::instance::LocationRef;
    use skrifa::raw::FontRef;
    use skrifa::{GlyphId, MetadataProvider};
    let font_ref = FontRef::from_index(font_bytes, font_index).ok()?;
    let charmap = font_ref.charmap();
    let num_glyphs = {
        use skrifa::raw::TableProvider;
        font_ref.maxp().ok()?.num_glyphs() as u32
    };

    let mut cmap_pairs: Vec<(u32, u16)> = Vec::with_capacity(4096);
    for (codepoint, gid) in charmap.mappings() {
        let gid_u16 = u32::from(gid) as u16;
        if gid_u16 == 0 {
            continue;
        }
        cmap_pairs.push((codepoint, gid_u16));
    }
    cmap_pairs.sort_by_key(|(cp, _)| *cp);

    let metrics =
        font_ref.glyph_metrics(skrifa::instance::Size::unscaled(), LocationRef::default());

    let cmap_count = cmap_pairs.len() as u32;
    let cap = FONT_METRICS_HEADER_BYTES
        + (FONT_CMAP_ENTRY_BYTES * cmap_pairs.len())
        + (FONT_GLYPH_ADVANCE_BYTES * num_glyphs as usize);
    let mut out = Vec::with_capacity(cap);
    out.extend_from_slice(&num_glyphs.to_le_bytes());
    out.extend_from_slice(&cmap_count.to_le_bytes());
    for (cp, gid) in &cmap_pairs {
        out.extend_from_slice(&cp.to_le_bytes());
        out.extend_from_slice(&gid.to_le_bytes());
    }
    for gid_raw in 0..num_glyphs {
        let adv = metrics.advance_width(GlyphId::new(gid_raw)).unwrap_or(0.0);
        let adv_u16 = adv.round().clamp(0.0, u16::MAX as f32) as u16;
        out.extend_from_slice(&adv_u16.to_le_bytes());
    }
    Some(out)
}

pub fn build_reverse_cmap(font_bytes: &[u8], font_index: u32) -> Option<Vec<Option<u32>>> {
    use skrifa::raw::{FontRef, TableProvider};
    use skrifa::MetadataProvider;
    let font_ref = FontRef::from_index(font_bytes, font_index).ok()?;
    let num_glyphs = font_ref.maxp().ok()?.num_glyphs() as usize;
    let mut rev: Vec<Option<u32>> = vec![None; num_glyphs];
    for (codepoint, gid) in font_ref.charmap().mappings() {
        let idx = u32::from(gid) as usize;
        if idx >= num_glyphs {
            continue;
        }
        match rev[idx] {
            None => rev[idx] = Some(codepoint),
            Some(existing) if codepoint < existing => rev[idx] = Some(codepoint),
            _ => {}
        }
    }
    Some(rev)
}

pub fn build_hmtx_advances(font_bytes: &[u8], font_index: u32) -> Option<Vec<u16>> {
    use skrifa::instance::LocationRef;
    use skrifa::raw::FontRef;
    use skrifa::raw::TableProvider;
    use skrifa::{GlyphId, MetadataProvider};
    let font_ref = FontRef::from_index(font_bytes, font_index).ok()?;
    let num_glyphs = font_ref.maxp().ok()?.num_glyphs() as u32;
    let metrics =
        font_ref.glyph_metrics(skrifa::instance::Size::unscaled(), LocationRef::default());
    let mut out = Vec::with_capacity(num_glyphs as usize);
    for gid_raw in 0..num_glyphs {
        let adv = metrics.advance_width(GlyphId::new(gid_raw)).unwrap_or(0.0);
        out.push(adv.round().clamp(0.0, u16::MAX as f32) as u16);
    }
    Some(out)
}

fn encode_webp_lossless(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use image::codecs::webp::WebPEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if rgba.len() != expected {
        return None;
    }
    let mut out: Vec<u8> = Vec::with_capacity(rgba.len() / 4);
    let enc = WebPEncoder::new_lossless(&mut out);
    enc.write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

fn extract_glyph_outline(
    font: &peniko::FontData,
    coords: &[NormalizedCoord],
    glyph_id: u32,
) -> Option<Vec<u8>> {
    use skrifa::instance::{LocationRef, Size};
    use skrifa::outline::{DrawSettings, OutlinePen};
    use skrifa::raw::FontRef;
    use skrifa::{GlyphId, MetadataProvider};

    let bytes = font.data.data();
    let font_ref = FontRef::from_index(bytes, font.index).ok()?;
    let outlines = font_ref.outline_glyphs();
    let outline = outlines.get(GlyphId::new(glyph_id))?;

    struct BytePen {
        out: Vec<u8>,
        wrote_move: bool,
    }
    impl OutlinePen for BytePen {
        fn move_to(&mut self, x: f32, y: f32) {
            self.out.push(PATH_MOVE);
            self.out.extend_from_slice(&x.to_le_bytes());
            self.out.extend_from_slice(&y.to_le_bytes());
            self.wrote_move = true;
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.out.push(PATH_LINE);
            self.out.extend_from_slice(&x.to_le_bytes());
            self.out.extend_from_slice(&y.to_le_bytes());
        }
        fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
            self.out.push(PATH_QUAD);
            self.out.extend_from_slice(&cx0.to_le_bytes());
            self.out.extend_from_slice(&cy0.to_le_bytes());
            self.out.extend_from_slice(&x.to_le_bytes());
            self.out.extend_from_slice(&y.to_le_bytes());
        }
        fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
            self.out.push(PATH_CURVE);
            self.out.extend_from_slice(&cx0.to_le_bytes());
            self.out.extend_from_slice(&cy0.to_le_bytes());
            self.out.extend_from_slice(&cx1.to_le_bytes());
            self.out.extend_from_slice(&cy1.to_le_bytes());
            self.out.extend_from_slice(&x.to_le_bytes());
            self.out.extend_from_slice(&y.to_le_bytes());
        }
        fn close(&mut self) {
            self.out.push(PATH_CLOSE);
        }
    }

    let mut pen = BytePen {
        out: Vec::with_capacity(64),
        wrote_move: false,
    };
    let sk_coords: Vec<skrifa::instance::NormalizedCoord> = coords
        .iter()
        .map(|c| skrifa::instance::NormalizedCoord::from_bits(*c))
        .collect();
    let location = LocationRef::new(&sk_coords);
    let settings = DrawSettings::unhinted(Size::unscaled(), location);
    outline.draw(settings, &mut pen).ok()?;
    if !pen.wrote_move {
        return Some(Vec::new());
    }
    Some(pen.out)
}

pub(crate) fn blob_content_hash(blob_bytes: &[u8]) -> u64 {
    thread_local! {
        static BLOB_HASH_CACHE: std::cell::RefCell<HashMap<usize, u64>> =
            std::cell::RefCell::new(HashMap::new());
    }
    let ptr = blob_bytes.as_ptr() as usize;
    BLOB_HASH_CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if let Some(h) = cache.get(&ptr) {
            return *h;
        }
        let h = fx_hash_u64(blob_bytes);
        cache.insert(ptr, h);
        h
    })
}

fn mix_coord_hash(blob_h: u64, coord_bytes: &[u8]) -> u64 {
    let coord_h = if coord_bytes.is_empty() {
        0
    } else {
        fx_hash_u64(coord_bytes)
    };
    let mut h = blob_h ^ coord_h.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h.wrapping_mul(0x94D0_49BB_1331_11EB)
}

pub(crate) fn affine_scale(t: Affine) -> (f64, f64) {
    let c = t.as_coeffs();
    (
        (c[0] * c[0] + c[1] * c[1]).sqrt(),
        (c[2] * c[2] + c[3] * c[3]).sqrt(),
    )
}

pub fn mix64(font_hash: u64, glyph_id: u32) -> u64 {
    let mut h = font_hash ^ (glyph_id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h.wrapping_mul(0x94D0_49BB_1331_11EB)
}

pub(crate) fn font_data_key(blob_hash: u64, face_index: u32) -> u64 {
    mix64(blob_hash, face_index)
}

pub(crate) fn fx_hash_u64(bytes: &[u8]) -> u64 {
    const SEED: u64 = 0xcbf29ce484222325;
    const K: u64 = 0x100000001b3;
    let mut h: u64 = SEED;
    let mut i = 0;
    while i + 8 <= bytes.len() {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes[i..i + 8]);
        let w = u64::from_le_bytes(buf);
        h = h.rotate_left(5) ^ w;
        h = h.wrapping_mul(K);
        i += 8;
    }
    for &b in &bytes[i..] {
        h = (h ^ b as u64).wrapping_mul(K);
    }
    h ^ (bytes.len() as u64)
}

// Raw RGBA hashes are recomputed during recording; font keys need stable
// cross-scene identity, so keep their hash path separate.
pub(crate) fn image_hash_u64(bytes: &[u8]) -> u64 {
    const SEED: u64 = 0xcbf29ce484222325;
    const K: u64 = 0x100000001b3;
    let step = |h: u64, w: u64| (h.rotate_left(5) ^ w).wrapping_mul(K);
    let word = |c: &[u8]| u64::from_le_bytes(std::array::from_fn(|i| c[i]));
    let mut lanes = [SEED, SEED ^ 1, SEED ^ 2, SEED ^ 3];
    let (blocks, tail) = bytes.as_chunks::<32>();
    for block in blocks {
        for (lane, w) in lanes.iter_mut().zip(block.as_chunks::<8>().0) {
            *lane = step(*lane, word(w));
        }
    }
    let mut h = lanes[1..].iter().fold(lanes[0], |h, &l| step(h, l));
    let (words, tail) = tail.as_chunks::<8>();
    for w in words {
        h = step(h, word(w));
    }
    for &b in tail {
        h = (h ^ b as u64).wrapping_mul(K);
    }
    h ^ (bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyrender::PaintScene as _;

    #[test]
    fn image_hash_separates_bytes_lengths_and_lanes() {
        let bytes: Vec<u8> = (0..100u32).map(|i| (i * 37 + 11) as u8).collect();
        let base = image_hash_u64(&bytes);
        assert_eq!(base, image_hash_u64(&bytes.clone()));
        let mut seen = std::collections::HashSet::new();
        for len in 0..=bytes.len() {
            assert!(seen.insert(image_hash_u64(&bytes[..len])), "length {len}");
        }
        for i in 0..bytes.len() {
            let mut flipped = bytes.clone();
            flipped[i] ^= 1;
            assert_ne!(image_hash_u64(&flipped), base, "byte {i}");
        }
        let mut swapped = bytes.clone();
        let (a, b) = swapped.split_at_mut(8);
        a.swap_with_slice(&mut b[..8]);
        assert_ne!(image_hash_u64(&swapped), base);
    }

    #[test]
    fn raw_image_transport_falls_back_to_webp_before_the_rpc_limit() {
        for sides in [vec![3072], vec![2048, 2048, 2048]] {
            let mut scene = RecordingScene::for_replay();
            scene.raw_images = true;
            scene.set_viewport(64, 64, 0, 0);
            for (i, side) in sides.iter().enumerate() {
                let pixels = [i as u8, 80, 160, 255].repeat((*side * *side) as usize);
                let image = peniko::ImageData {
                    data: peniko::Blob::from(pixels),
                    format: peniko::ImageFormat::Rgba8,
                    alpha_type: peniko::ImageAlphaType::Alpha,
                    width: *side,
                    height: *side,
                };
                let brush = peniko::ImageBrush::new(image);
                scene.fill(
                    PenikoFill::NonZero,
                    Affine::IDENTITY,
                    brush.as_ref(),
                    None,
                    &Rect::new(0.0, 0.0, 64.0, 64.0),
                );
            }
            let encoded = scene.drain_rbi_images();
            assert_eq!(encoded.len(), if sides.len() == 1 { 1 } else { 2 });
            for (_, info) in encoded {
                assert_eq!(info.format, 1);
                let decoded = image::load_from_memory(info.wire_bytes.data()).unwrap();
                assert_eq!(decoded.width(), info.width);
                assert_eq!(decoded.height(), info.height);
            }
            let bytes = scene.finish_framed();
            assert!(bytes.len() < 32 * 1024 * 1024);
            let header = crate::paint::scene_decode::parse_header(&bytes).unwrap();
            let resources = crate::paint::scene_decode::parse_resources(&bytes, &header).unwrap();
            assert_eq!(
                resources.by_hash.values().filter(|r| r.format == 0).count(),
                if sides.len() == 1 { 0 } else { 1 },
            );
        }
    }

    #[test]
    fn font_caches_stop_growing_at_the_cap() {
        let mut seen = GlyphSeen::default();
        for font in 0..(MAX_CACHED_FONTS as u64 * 4) {
            GlyphSeen::mark(seen.bits_for(font), 42);
            assert!(seen.fonts.len() <= MAX_CACHED_FONTS);
        }
        assert!(!seen.fonts.contains_key(&0));
    }

    #[test]
    fn revisiting_a_cached_font_does_not_evict() {
        let mut seen = GlyphSeen::default();
        for font in 0..MAX_CACHED_FONTS as u64 {
            GlyphSeen::mark(seen.bits_for(font), 42);
        }
        assert_eq!(seen.fonts.len(), MAX_CACHED_FONTS);
        for font in 0..MAX_CACHED_FONTS as u64 {
            GlyphSeen::mark(seen.bits_for(font), 43);
        }
        assert_eq!(seen.fonts.len(), MAX_CACHED_FONTS);
    }

    #[test]
    fn only_a_horizontal_shear_reads_as_synthetic_oblique() {
        assert!(is_pure_skew(Affine::new([1.0, 0.0, 0.2126, 1.0, 0.0, 0.0])));

        assert!(!is_pure_skew(Affine::IDENTITY), "no shear is not oblique");
        assert!(
            !is_pure_skew(Affine::rotate(0.2)),
            "a rotation needs per-glyph placement, not a flag"
        );
        assert!(
            !is_pure_skew(Affine::new([2.0, 0.0, 0.2, 1.0, 0.0, 0.0])),
            "a scale changes advances the reshaper would have to redo"
        );
        assert!(
            !is_pure_skew(Affine::new([1.0, 0.0, 0.2, 1.0, 5.0, 0.0])),
            "a translate moves the baseline the run start already carries"
        );
        assert!(
            !is_pure_skew(Affine::new([1.0, 0.3, 0.2, 1.0, 0.0, 0.0])),
            "a vertical shear is not something a terminal can drop"
        );
    }
}
