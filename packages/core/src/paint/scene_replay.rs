// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Replays recorded paint scenes after resolving their image and font resources.
//! Each rasterizer instance owns its resource cache and retained-frame state.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Cursor;
use std::panic::{self, RefUnwindSafe};

use anyrender::{Glyph as AnyGlyph, ImageRenderer as _, PaintScene};
#[cfg(feature = "pdf")]
use krilla::geom::Transform;
use kurbo::{Affine, BezPath, Point, Shape, Vec2};
use peniko::{
    BlendMode, Blob, Color, Fill, FontData, ImageAlphaType, ImageBrush, ImageData, ImageSampler,
};
#[cfg(not(feature = "native-host"))]
use wasm_bindgen::prelude::*;

#[cfg(feature = "pdf")]
use crate::paint::pdf_paint::{
    content_box, paint_white_background, push_page_clip, push_px_to_pt_scale, KrillaPaintScene,
};
use crate::paint::scene_decode::{
    self, DecodedCap, DecodedFillRule, DecodedJoin, DecodedPaint, DecodedPathEl, DecodedResources,
    DecodedTransform, ResourceKind, SceneVisitor,
};
use crate::paint::scene_record::{
    font_data_key, fx_hash_u64, FONT_DATA_REF_ASSET, FONT_DATA_REF_BLOB, IMAGE_REF_HINT_BYTES,
    RBI_RESOURCE_KIND_FONT_DATA, RBI_RESOURCE_KIND_IMAGE,
};
use crate::paint::screenshot::{
    encode_jpeg, encode_jpeg_retained, encode_png, encode_webp, ImageFormat, JpegRowCache,
};

pub(crate) const RESOURCE_COUNT_BYTES: usize = 4;
const RESOURCE_BATCH_ENTRY_HEADER_BYTES: usize = 13;
const IMAGE_RESOURCE_HEADER_BYTES: usize = 9;
const FONT_DATA_REF_HEADER_BYTES: usize = 5;
pub(crate) const MISSING_RESOURCE_ENTRY_BYTES: usize = 9;
pub(crate) const PDF_ENVELOPE_U32_BYTES: usize = 4;
const MAX_BROKEN_RESOURCE_KEYS: usize = 1024;

#[derive(Default)]
pub(crate) struct ResourceStore {
    fonts: HashMap<u64, FontData>,
    images: HashMap<u64, ImageData>,
    solid_images: HashMap<u64, Color>,
    font_order: Vec<u64>,
    image_order: Vec<u64>,
    font_bytes_total: usize,
    image_bytes_total: usize,
    pending_assets: HashMap<u64, String>,
    pending_images: HashMap<u64, (u32, u32, (u32, u32))>,
    broken_images: std::collections::HashSet<u64>,
    broken_fonts: std::collections::HashSet<u64>,
}

const FONT_BYTES_BUDGET: usize = 48 * 1024 * 1024;
const IMAGE_BYTES_BUDGET: usize = 48 * 1024 * 1024;

impl ResourceStore {
    fn insert_font(&mut self, key: u64, font: FontData) {
        let len = font.data.data().len();
        if let Some(old) = self.fonts.insert(key, font) {
            self.font_bytes_total = self.font_bytes_total.saturating_sub(old.data.data().len());
            self.font_order.retain(|k| *k != key);
        }
        self.font_bytes_total += len;
        self.font_order.push(key);
        self.evict_fonts_over(FONT_BYTES_BUDGET);
    }

    fn evict_fonts_over(&mut self, budget: usize) {
        while self.font_bytes_total > budget && self.font_order.len() > 1 {
            let evict = self.font_order.remove(0);
            if let Some(old) = self.fonts.remove(&evict) {
                self.font_bytes_total = self.font_bytes_total.saturating_sub(old.data.data().len());
            }
        }
    }

    pub(crate) fn images_iter(&self) -> impl Iterator<Item = (&u64, &ImageData)> {
        self.images.iter()
    }

    pub(crate) fn pending_image_keys(&self) -> Vec<u64> {
        self.pending_images.keys().copied().collect()
    }

    pub(crate) fn abandon_image_key(&mut self, key: u64) -> bool {
        let removed = self.pending_images.remove(&key).is_some();
        if self.broken_images.len() >= MAX_BROKEN_RESOURCE_KEYS {
            self.broken_images.clear();
        }
        self.broken_images.insert(key);
        removed
    }

    fn insert_image(&mut self, key: u64, img: ImageData) {
        let len = img.data.data().len();
        match opaque_solid_color(&img) {
            Some(color) => self.solid_images.insert(key, color),
            None => self.solid_images.remove(&key),
        };
        if let Some(old) = self.images.insert(key, img) {
            self.image_bytes_total = self.image_bytes_total.saturating_sub(old.data.data().len());
            self.image_order.retain(|k| *k != key);
        }
        self.image_bytes_total += len;
        self.image_order.push(key);
        self.evict_images_over(IMAGE_BYTES_BUDGET);
    }

    fn evict_images_over(&mut self, budget: usize) {
        while self.image_bytes_total > budget && self.image_order.len() > 1 {
            let evict = self.image_order.remove(0);
            self.solid_images.remove(&evict);
            if let Some(old) = self.images.remove(&evict) {
                self.image_bytes_total =
                    self.image_bytes_total.saturating_sub(old.data.data().len());
            }
        }
    }

    pub(crate) fn put_batch(&mut self, batch: &[u8]) -> u32 {
        let mut stored = 0u32;
        let mut i = 0usize;
        if batch.len() < RESOURCE_COUNT_BYTES {
            return 0;
        }
        let count = u32_le(&batch[0..RESOURCE_COUNT_BYTES]);
        i += RESOURCE_COUNT_BYTES;
        for _ in 0..count {
            if i + RESOURCE_BATCH_ENTRY_HEADER_BYTES > batch.len() {
                break;
            }
            let kind = batch[i];
            let hash = u64_le(&batch[i + 1..i + 9]);
            let len = u32_le(&batch[i + 9..i + RESOURCE_BATCH_ENTRY_HEADER_BYTES]) as usize;
            i += RESOURCE_BATCH_ENTRY_HEADER_BYTES;
            if i + len > batch.len() {
                break;
            }
            let payload = &batch[i..i + len];
            i += len;
            if kind == RBI_RESOURCE_KIND_IMAGE {
                if payload.len() < IMAGE_RESOURCE_HEADER_BYTES {
                    continue;
                }
                let w = u32_le(&payload[0..4]);
                let h = u32_le(&payload[4..8]);
                let format = payload[8];
                let (hint, body) = if matches!(
                    format,
                    2 | crate::paint::scene_record::IMAGE_FORMAT_ENGINE_REF
                ) && payload.len()
                    >= IMAGE_RESOURCE_HEADER_BYTES + IMAGE_REF_HINT_BYTES
                {
                    (
                        (u32_le(&payload[9..13]), u32_le(&payload[13..17])),
                        &payload[IMAGE_RESOURCE_HEADER_BYTES + IMAGE_REF_HINT_BYTES..],
                    )
                } else {
                    ((0, 0), &payload[IMAGE_RESOURCE_HEADER_BYTES..])
                };
                if format == crate::paint::scene_record::IMAGE_FORMAT_ENGINE_REF {
                    if !self.images.contains_key(&hash) && !self.broken_images.contains(&hash) {
                        self.pending_images.insert(hash, (w, h, hint));
                    }
                    continue;
                }
                if let Some(img) = decode_image_payload(w, h, format, hint, body.into()) {
                    self.insert_image(hash, img);
                    self.broken_images.remove(&hash);
                    self.pending_images.remove(&hash);
                    stored += 1;
                } else {
                    if self.broken_images.len() >= MAX_BROKEN_RESOURCE_KEYS {
                        self.broken_images.clear();
                    }
                    if self.broken_images.insert(hash) {
                        let magic: Vec<u8> = body.iter().take(8).copied().collect();
                        crate::console_warn_str(&format!(
                            "[ks-replay] image decode failed (marked broken): hash={hash} w={w} h={h} format={format} len={} magic={magic:02x?}",
                            body.len()
                        ));
                    }
                }
            } else if kind == RBI_RESOURCE_KIND_FONT_DATA {
                if payload.len() < FONT_DATA_REF_HEADER_BYTES {
                    continue;
                }
                let ref_type = payload[0];
                let idx = u32_le(&payload[1..FONT_DATA_REF_HEADER_BYTES]);
                let body = &payload[FONT_DATA_REF_HEADER_BYTES..];
                stored += self.put_font_entry(hash, ref_type, idx, body);
            }
        }
        stored
    }

    fn put_font_entry(&mut self, hash: u64, ref_type: u8, idx: u32, body: &[u8]) -> u32 {
        match ref_type {
            FONT_DATA_REF_BLOB => {
                let processed = normalize_font_container(body);
                if is_shapeable_face(&processed, idx) {
                    self.insert_font(hash, FontData::new(Blob::from(processed), idx));
                    self.pending_assets.remove(&hash);
                    self.broken_fonts.remove(&hash);
                    1
                } else {
                    if self.broken_fonts.len() >= MAX_BROKEN_RESOURCE_KEYS {
                        self.broken_fonts.clear();
                    }
                    if self.broken_fonts.insert(hash) {
                        let magic: Vec<u8> = processed.iter().take(4).copied().collect();
                        crate::console_warn_str(&format!(
                            "[ks-replay] font blob is not a parseable face (marked broken): hash={hash} len={} magic={magic:02x?}",
                            processed.len()
                        ));
                    }
                    self.pending_assets.remove(&hash);
                    0
                }
            }
            FONT_DATA_REF_ASSET if !self.fonts.contains_key(&hash) => {
                if let Ok(name) = std::str::from_utf8(body) {
                    self.pending_assets.insert(hash, name.to_string());
                }
                0
            }
            _ => 0,
        }
    }

    pub(crate) fn put_image_bytes(&mut self, key: u64, bytes: &[u8]) -> u32 {
        let Some((w, h, hint)) = self.pending_images.remove(&key) else {
            return 0;
        };
        match decode_image_payload(w, h, 2, hint, bytes.into()) {
            Some(img) => {
                self.insert_image(key, img);
                self.broken_images.remove(&key);
                1
            }
            None => {
                if self.broken_images.len() >= MAX_BROKEN_RESOURCE_KEYS {
                    self.broken_images.clear();
                }
                if self.broken_images.insert(key) {
                    crate::console_warn_str(&format!(
                        "[ks-replay] engine image decode failed (marked broken): key={key} w={w} h={h} len={}",
                        bytes.len()
                    ));
                }
                0
            }
        }
    }

    fn put_font_asset(&mut self, path: &str, bytes: &[u8]) -> u32 {
        let processed = normalize_font_container(bytes);
        let keys: Vec<u64> = self
            .pending_assets
            .iter()
            .filter(|(_, p)| p.as_str() == path)
            .map(|(k, _)| *k)
            .collect();
        if !is_shapeable_face(&processed, 0) {
            if self.broken_fonts.len() >= MAX_BROKEN_RESOURCE_KEYS {
                self.broken_fonts.clear();
            }
            for key in &keys {
                self.broken_fonts.insert(*key);
                self.pending_assets.remove(key);
            }
            if processed.is_empty() {
                crate::console_warn_str(&format!(
                    "[ks-replay] font asset delivered no bytes (marked broken): path={path}"
                ));
                return 0;
            }
            let magic: Vec<u8> = processed.iter().take(4).copied().collect();
            crate::console_warn_str(&format!(
                "[ks-replay] font asset is not a parseable face (marked broken): path={path} len={} magic={magic:02x?}",
                processed.len()
            ));
            return 0;
        }
        let content_key = font_data_key(fx_hash_u64(&processed), 0);
        let blob = Blob::from(processed);
        let mut stored = 0u32;
        for key in keys {
            self.insert_font(key, FontData::new(blob.clone(), 0));
            self.pending_assets.remove(&key);
            stored += 1;
        }
        if !self.fonts.contains_key(&content_key) {
            self.insert_font(content_key, FontData::new(blob, 0));
            self.pending_assets.remove(&content_key);
            stored += 1;
        }
        stored.max(1)
    }
}

/// A refused container stays compressed, so `is_shapeable_face` marks it broken.
fn normalize_font_container(bytes: &[u8]) -> Vec<u8> {
    match super::font_container::inflate_font_container(bytes) {
        super::font_container::FontContainer::Inflated(sfnt) => sfnt,
        _ => bytes.to_vec(),
    }
}

fn is_shapeable_face(bytes: &[u8], index: u32) -> bool {
    use skrifa::raw::TableProvider;
    skrifa::FontRef::from_index(bytes, index).is_ok_and(|f| f.head().is_ok())
}

pub(crate) fn missing_resources(store: &ResourceStore, scene_bytes: &[u8]) -> Vec<u8> {
    let mut missing: Vec<(u8, u64)> = Vec::new();
    let Ok(header) = scene_decode::parse_header(scene_bytes) else {
        return encode_missing(&missing);
    };
    let Ok(resources) = scene_decode::parse_resource_refs(scene_bytes, &header) else {
        return encode_missing(&missing);
    };
    let mut seen_fonts = std::collections::HashSet::new();
    for meta in resources.font_meta.values() {
        if meta.blob_hash == 0 {
            continue;
        }
        let key = font_data_key(meta.blob_hash, meta.face_index);
        if store.fonts.contains_key(&key) || store.broken_fonts.contains(&key) {
            continue;
        }
        if seen_fonts.insert(key) {
            missing.push((RBI_RESOURCE_KIND_FONT_DATA, key));
        }
    }
    for (hash, res) in &resources.by_hash {
        if res.format == 0 {
            continue;
        }
        match store.images.get(hash) {
            None if store.broken_images.contains(hash) => {}
            None => missing.push((RBI_RESOURCE_KIND_IMAGE, *hash)),
            Some(img) if res.format == 2 => {
                let (hw, hh) = decode_hint(res);
                let (tw, th) = mip_dims(res.width, res.height, hw, hh, REPLAY_DECODE_CEILING);
                if img.width < tw || img.height < th {
                    crate::console_warn_str(&format!(
                        "[ks-replay] undersized decode: hash={hash} cached={}x{} target={tw}x{th} header={}x{} hint={hw}x{hh}",
                        img.width, img.height, res.width, res.height
                    ));
                    missing.push((RBI_RESOURCE_KIND_IMAGE, *hash));
                }
            }
            Some(_) => {}
        }
    }
    encode_missing(&missing)
}

fn decode_hint(res: &crate::paint::scene_decode::DecodedResource) -> (u32, u32) {
    if res.data.len() >= IMAGE_REF_HINT_BYTES {
        let mut w = [0u8; 4];
        let mut h = [0u8; 4];
        w.copy_from_slice(&res.data[0..4]);
        h.copy_from_slice(&res.data[4..8]);
        (u32::from_le_bytes(w), u32::from_le_bytes(h))
    } else {
        (0, 0)
    }
}

fn encode_missing(missing: &[(u8, u64)]) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(RESOURCE_COUNT_BYTES + missing.len() * MISSING_RESOURCE_ENTRY_BYTES);
    out.extend_from_slice(&(missing.len() as u32).to_le_bytes());
    for (kind, hash) in missing {
        out.push(*kind);
        out.extend_from_slice(&hash.to_le_bytes());
    }
    out
}

const REPLAY_DECODE_CEILING: u32 = 4096;

fn mip_dims(header_w: u32, header_h: u32, hint_w: u32, hint_h: u32, ceiling: u32) -> (u32, u32) {
    let (mut w, mut h) = (header_w.max(1), header_h.max(1));
    if hint_w > 0 && hint_h > 0 {
        while w / 2 >= hint_w && h / 2 >= hint_h && w / 2 >= 1 && h / 2 >= 1 {
            w /= 2;
            h /= 2;
        }
    }
    while w > ceiling || h > ceiling {
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    (w, h)
}

const DECODE_SRC_RGBA_BUDGET: u64 = 128 * 1024 * 1024;

fn decoded_size_ok(w: u32, h: u32) -> bool {
    (w as u128) * (h as u128) * 4 <= DECODE_SRC_RGBA_BUDGET as u128
}

pub(crate) fn decode_image_payload(
    w: u32,
    h: u32,
    format: u8,
    hint: (u32, u32),
    bytes: Cow<'_, [u8]>,
) -> Option<ImageData> {
    let (rgba, out_w, out_h): (Vec<u8>, u32, u32) = match format {
        0 => {
            if bytes.len() != (w as usize) * (h as usize) * 4 {
                return None;
            }
            (bytes.into_owned(), w, h)
        }
        1 => {
            if !decoded_size_ok(w, h) {
                return None;
            }
            let decoded =
                image::load_from_memory_with_format(&bytes, image::ImageFormat::WebP).ok()?;
            let rgba = decoded.to_rgba8();
            if rgba.width() != w || rgba.height() != h {
                return None;
            }
            (rgba.into_raw(), w, h)
        }
        2 => {
            {
                let mut reader = image::ImageReader::new(Cursor::new(bytes.as_ref()));
                match reader.with_guessed_format() {
                    Ok(r) => reader = r,
                    Err(e) => {
                        crate::console_warn_str(&format!(
                            "[ks-replay] format sniff failed ({} bytes): {e}",
                            bytes.len()
                        ));
                        return None;
                    }
                }
                match reader.into_dimensions() {
                    Ok((sw, sh)) => {
                        if !decoded_size_ok(sw, sh) {
                            crate::console_warn_str(&format!(
                                "[ks-replay] decode-bomb reject {sw}x{sh}"
                            ));
                            return None;
                        }
                    }
                    Err(e) => {
                        crate::console_warn_str(&format!(
                            "[ks-replay] dims sniff failed ({} bytes): {e}",
                            bytes.len()
                        ));
                        return None;
                    }
                }
            }
            let decoded = image::load_from_memory(&bytes).ok()?;
            let (tw, th) = mip_dims(
                decoded.width(),
                decoded.height(),
                hint.0,
                hint.1,
                REPLAY_DECODE_CEILING,
            );
            let scaled = if decoded.width() > tw || decoded.height() > th {
                use image::imageops::FilterType;
                decoded.resize_exact(tw, th, FilterType::Triangle)
            } else {
                decoded
            };
            let (dw, dh) = (scaled.width(), scaled.height());
            (scaled.into_rgba8().into_raw(), dw, dh)
        }
        _ => return None,
    };
    Some(ImageData {
        data: Blob::from(rgba),
        format: peniko::ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width: out_w,
        height: out_h,
    })
}

/// Retained RGBA bytes an inline image will need, without decoding its pixels.
fn inline_rgba_len(w: u32, h: u32, format: u8, bytes: &[u8]) -> Option<usize> {
    if !matches!(format, 0 | 1) {
        return None;
    }
    if format == 1 {
        let dims = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::WebP)
            .into_dimensions()
            .ok()?;
        if dims != (w, h) {
            return None;
        }
    }
    let len = usize::try_from(w)
        .ok()?
        .checked_mul(usize::try_from(h).ok()?)?
        .checked_mul(4)?;
    if format == 0 && len != bytes.len() {
        return None;
    }
    Some(len)
}

/// Decodes the scene's inline images within one shared retained-byte budget.
/// Images over the remaining budget are skipped and render as missing.
pub(crate) fn decode_inline_images(resources: &mut DecodedResources) -> HashMap<u64, ImageData> {
    let mut keys: Vec<u64> = resources.by_hash.keys().copied().collect();
    keys.sort_unstable();
    let mut out = HashMap::new();
    let mut remaining = IMAGE_BYTES_BUDGET;
    for key in keys {
        let Some(res) = resources.by_hash.get_mut(&key) else {
            continue;
        };
        if res.kind != ResourceKind::Image || res.data.is_empty() {
            continue;
        }
        let Some(len) = inline_rgba_len(res.width, res.height, res.format, &res.data) else {
            continue;
        };
        if len > remaining {
            continue;
        }
        remaining -= len;
        match decode_image_payload(
            res.width,
            res.height,
            res.format,
            (0, 0),
            std::mem::take(&mut res.data).into(),
        ) {
            Some(img) if img.data.data().len() == len => {
                out.insert(key, img);
            }
            _ => remaining += len,
        }
    }
    out
}

fn opaque_solid_color(img: &ImageData) -> Option<Color> {
    if img.format != peniko::ImageFormat::Rgba8 {
        return None;
    }
    let mut px = img.data.data().as_chunks::<4>().0.iter();
    let first = px.next()?;
    if first[3] != 255 || !px.all(|p| p == first) {
        return None;
    }
    Some(solid(first[0], first[1], first[2], 255))
}

struct ReplayContext<'a> {
    store: &'a ResourceStore,
    inline_images: HashMap<u64, ImageData>,
    inline_solid: HashMap<u64, Color>,
    fonts_by_id: HashMap<u32, Option<FontData>>,
    image_scale: HashMap<u64, Affine>,
}

impl<'a> ReplayContext<'a> {
    fn new(store: &'a ResourceStore, resources: &mut DecodedResources) -> Self {
        let inline_images = decode_inline_images(resources);
        let inline_solid = inline_images
            .iter()
            .filter_map(|(hash, img)| Some((*hash, opaque_solid_color(img)?)))
            .collect();
        let mut fonts_by_id = HashMap::new();
        for (font_id, meta) in &resources.font_meta {
            fonts_by_id.insert(
                *font_id,
                store
                    .fonts
                    .get(&font_data_key(meta.blob_hash, meta.face_index))
                    .cloned(),
            );
        }
        let mut ctx = Self {
            store,
            inline_images,
            inline_solid,
            fonts_by_id,
            image_scale: HashMap::new(),
        };
        for (hash, res) in &resources.by_hash {
            let dims = ctx.image(*hash).map(|img| (img.width, img.height));
            if let Some((w, h)) = dims {
                if (w != res.width || h != res.height) && w > 0 && h > 0 {
                    ctx.image_scale.insert(
                        *hash,
                        Affine::scale_non_uniform(
                            res.width as f64 / w as f64,
                            res.height as f64 / h as f64,
                        ),
                    );
                }
            }
        }
        ctx
    }

    fn image(&self, hash: u64) -> Option<&ImageData> {
        self.inline_images
            .get(&hash)
            .or_else(|| self.store.images.get(&hash))
    }

    fn solid_image(&self, hash: u64) -> Option<Color> {
        if self.inline_images.contains_key(&hash) {
            self.inline_solid.get(&hash).copied()
        } else {
            self.store.solid_images.get(&hash).copied()
        }
    }

    fn image_brush_transform(&self, hash: u64) -> Option<Affine> {
        self.image_scale.get(&hash).copied()
    }
}

struct ReplayVisitor<'a, 'b, S: PaintScene> {
    scene: &'a mut S,
    ctx: &'a ReplayContext<'b>,
    missing_fonts: u32,
    missing_images: u32,
    text_runs: u32,
    clip_paths: bool,
    open_clip_paths: Vec<bool>,
}

const PIXEL_EDGE_EPSILON: f64 = 1e-3;

fn is_whole_pixel_rect(transform: DecodedTransform, clip_path: &[DecodedPathEl]) -> bool {
    let t = affine(transform);
    let c = t.as_coeffs();
    if c[1] != 0.0 || c[2] != 0.0 {
        return false;
    }
    let mut corners = [Point::ZERO; 4];
    let mut n = 0;
    for (i, el) in clip_path.iter().enumerate() {
        match *el {
            DecodedPathEl::Move { .. } if i != 0 => return false,
            DecodedPathEl::Line { .. } if i == 0 => return false,
            DecodedPathEl::Move { x, y } | DecodedPathEl::Line { x, y } => {
                let p = t * Point::new(x as f64, y as f64);
                if n == 4 && p == corners[0] {
                    continue;
                }
                if n == 4 {
                    return false;
                }
                corners[n] = p;
                n += 1;
            }
            DecodedPathEl::Close if i + 1 == clip_path.len() => {}
            _ => return false,
        }
    }
    if n != 4 {
        return false;
    }
    let on_edge = |v: f64| (v - v.round()).abs() <= PIXEL_EDGE_EPSILON;
    (0..4).all(|i| {
        let (a, b) = (corners[i], corners[(i + 1) % 4]);
        let axis_aligned = (a.x == b.x) != (a.y == b.y);
        axis_aligned && on_edge(a.x) && on_edge(a.y)
    })
}

#[derive(Default)]
struct LayerComposeScan {
    non_source_over: bool,
    dimensions: (u32, u32),
    depth: u32,
    unbalanced: bool,
    opaque_background: bool,
}

impl SceneVisitor for LayerComposeScan {
    fn on_push_layer(
        &mut self,
        _: u8,
        compose: u8,
        _: f32,
        _: DecodedTransform,
        _: &[DecodedPathEl],
    ) {
        self.non_source_over |= compose_from_u8(compose) != peniko::Compose::SrcOver;
        self.depth += 1;
    }
    fn on_push_clip_layer(&mut self, _: DecodedTransform, _: &[DecodedPathEl]) {
        self.depth += 1;
    }
    fn on_pop_layer(&mut self) {
        self.unbalanced |= self.depth == 0;
        self.depth = self.depth.saturating_sub(1);
    }
    fn on_fill(
        &mut self,
        _: DecodedFillRule,
        transform: DecodedTransform,
        _: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    ) {
        if !self.opaque_background
            && self.depth == 0
            && matches!(paint, DecodedPaint::Solid { a: 255, .. })
            && transform.is_identity()
            && is_whole_pixel_rect(transform, path)
        {
            let bounds = bez_path(path).bounding_box();
            self.opaque_background = bounds.x0 <= 0.0
                && bounds.y0 <= 0.0
                && bounds.x1 >= self.dimensions.0 as f64
                && bounds.y1 >= self.dimensions.1 as f64;
        }
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "LayerComposeScan implements the ordered KSC0 stroke callback."
    )]
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
        _: &[(u32, f32, f32)],
    ) {
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "LayerComposeScan implements the ordered KSC0 box-shadow callback."
    )]
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
}

fn scan_layer_composition(scene_bytes: &[u8], dimensions: (u32, u32)) -> LayerComposeScan {
    let mut scan = LayerComposeScan {
        dimensions,
        ..Default::default()
    };
    if scene_decode::decode(scene_bytes, &mut scan).is_err() {
        scan.non_source_over = true;
    }
    scan
}

fn affine(t: DecodedTransform) -> Affine {
    let c = t.0;
    Affine::new([
        c[0] as f64,
        c[1] as f64,
        c[2] as f64,
        c[3] as f64,
        c[4] as f64,
        c[5] as f64,
    ])
}

fn bez_path(els: &[DecodedPathEl]) -> BezPath {
    let mut p = BezPath::new();
    for el in els {
        match *el {
            DecodedPathEl::Move { x, y } => p.move_to(Point::new(x as f64, y as f64)),
            DecodedPathEl::Line { x, y } => p.line_to(Point::new(x as f64, y as f64)),
            DecodedPathEl::Quad { cx, cy, x, y } => p.quad_to(
                Point::new(cx as f64, cy as f64),
                Point::new(x as f64, y as f64),
            ),
            DecodedPathEl::Curve {
                c1x,
                c1y,
                c2x,
                c2y,
                x,
                y,
            } => p.curve_to(
                Point::new(c1x as f64, c1y as f64),
                Point::new(c2x as f64, c2y as f64),
                Point::new(x as f64, y as f64),
            ),
            DecodedPathEl::Close => p.close_path(),
        }
    }
    p
}

fn mix_from_u8(v: u8) -> peniko::Mix {
    use peniko::Mix::*;
    match v {
        1 => Multiply,
        2 => Screen,
        3 => Overlay,
        4 => Darken,
        5 => Lighten,
        6 => ColorDodge,
        7 => ColorBurn,
        8 => HardLight,
        9 => SoftLight,
        10 => Difference,
        11 => Exclusion,
        12 => Hue,
        13 => Saturation,
        14 => Color,
        15 => Luminosity,
        _ => Normal,
    }
}

fn compose_from_u8(v: u8) -> peniko::Compose {
    use peniko::Compose::*;
    match v {
        0 => Clear,
        1 => Copy,
        2 => Dest,
        4 => DestOver,
        5 => SrcIn,
        6 => DestIn,
        7 => SrcOut,
        8 => DestOut,
        9 => SrcAtop,
        10 => DestAtop,
        11 => Xor,
        12 => Plus,
        13 => PlusLighter,
        _ => SrcOver,
    }
}

fn solid(r: u8, g: u8, b: u8, a: u8) -> Color {
    Color::from_rgba8(r, g, b, a)
}

fn image_sampler() -> ImageSampler {
    ImageSampler {
        x_extend: peniko::Extend::Repeat,
        y_extend: peniko::Extend::Repeat,
        quality: peniko::ImageQuality::Medium,
        alpha: 1.0,
    }
}

impl<'a, 'b, S: PaintScene> ReplayVisitor<'a, 'b, S> {
    fn fill_with_paint(
        &mut self,
        rule: Fill,
        t: Affine,
        brush_transform: Option<Affine>,
        paint: &DecodedPaint,
        path: &BezPath,
    ) {
        match paint {
            DecodedPaint::Solid { r, g, b, a } => {
                self.scene.fill(rule, t, solid(*r, *g, *b, *a), None, path);
            }
            DecodedPaint::Gradient(g) => {
                let pg = g.to_peniko_gradient();
                self.scene.fill(rule, t, &pg, brush_transform, path);
            }
            DecodedPaint::Image { content_hash } => {
                if let Some(color) = self.ctx.solid_image(*content_hash) {
                    self.scene.fill(rule, t, color, None, path);
                } else if let Some(img) = self.ctx.image(*content_hash) {
                    let bt = self.ctx.image_brush_transform(*content_hash);
                    let brush = ImageBrush {
                        image: img.clone(),
                        sampler: image_sampler(),
                    };
                    self.scene.fill(rule, t, brush.as_ref(), bt, path);
                } else {
                    self.missing_images += 1;
                }
            }
        }
    }
}

impl<'a, 'b, S: PaintScene> SceneVisitor for ReplayVisitor<'a, 'b, S> {
    fn on_push_layer(
        &mut self,
        blend_mix: u8,
        blend_compose: u8,
        alpha: f32,
        transform: DecodedTransform,
        clip_path: &[DecodedPathEl],
    ) {
        let blend = BlendMode::new(mix_from_u8(blend_mix), compose_from_u8(blend_compose));
        // The wire carries no clip fill rule (see RecordingScene::push_layer).
        self.scene.push_layer(
            Fill::NonZero,
            blend,
            alpha,
            affine(transform),
            &bez_path(clip_path),
            None,
            None,
        );
        self.open_clip_paths.push(false);
    }

    fn on_push_clip_layer(&mut self, transform: DecodedTransform, clip_path: &[DecodedPathEl]) {
        let as_path = self.clip_paths && is_whole_pixel_rect(transform, clip_path);
        if as_path {
            self.scene
                .push_clip_path(Fill::NonZero, affine(transform), &bez_path(clip_path));
        } else {
            self.scene
                .push_clip_layer(Fill::NonZero, affine(transform), &bez_path(clip_path));
        }
        self.open_clip_paths.push(as_path);
    }

    fn on_pop_layer(&mut self) {
        if self.open_clip_paths.pop() == Some(true) {
            self.scene.pop_clip_path();
        } else {
            self.scene.pop_layer();
        }
    }

    fn on_fill(
        &mut self,
        fill_rule: DecodedFillRule,
        transform: DecodedTransform,
        brush_transform: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    ) {
        let rule = match fill_rule {
            DecodedFillRule::NonZero => Fill::NonZero,
            DecodedFillRule::EvenOdd => Fill::EvenOdd,
        };
        let p = bez_path(path);
        let bt = brush_transform.map(affine);
        self.fill_with_paint(rule, affine(transform), bt, &paint, &p);
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "ReplayVisitor consumes the ordered KSC0 stroke callback fields."
    )]
    fn on_stroke(
        &mut self,
        width: f32,
        miter_limit: f32,
        cap: DecodedCap,
        join: DecodedJoin,
        dash_offset: f32,
        dashes: &[f32],
        transform: DecodedTransform,
        brush_transform: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    ) {
        let kcap = match cap {
            DecodedCap::Butt => kurbo::Cap::Butt,
            DecodedCap::Round => kurbo::Cap::Round,
            DecodedCap::Square => kurbo::Cap::Square,
        };
        let kjoin = match join {
            DecodedJoin::Miter => kurbo::Join::Miter,
            DecodedJoin::Round => kurbo::Join::Round,
            DecodedJoin::Bevel => kurbo::Join::Bevel,
        };
        let mut style = kurbo::Stroke::new(width as f64)
            .with_caps(kcap)
            .with_join(kjoin)
            .with_miter_limit(miter_limit as f64);
        if !dashes.is_empty() {
            style = style.with_dashes(dash_offset as f64, dashes.iter().map(|d| *d as f64));
        }
        let t = affine(transform);
        let bt_wire = brush_transform.map(affine);
        let p = bez_path(path);
        match &paint {
            DecodedPaint::Solid { r, g, b, a } => {
                self.scene
                    .stroke(&style, t, solid(*r, *g, *b, *a), None, &p);
            }
            DecodedPaint::Gradient(g) => {
                let pg = g.to_peniko_gradient();
                self.scene.stroke(&style, t, &pg, bt_wire, &p);
            }
            DecodedPaint::Image { content_hash } => {
                if let Some(img) = self.ctx.image(*content_hash) {
                    let bt = self.ctx.image_brush_transform(*content_hash);
                    let brush = ImageBrush {
                        image: img.clone(),
                        sampler: image_sampler(),
                    };
                    self.scene.stroke(&style, t, brush.as_ref(), bt, &p);
                } else {
                    self.missing_images += 1;
                }
            }
        }
    }

    fn on_glyph_run(
        &mut self,
        font_id: u32,
        font_size: f32,
        normalized_coords: &[i16],
        transform: DecodedTransform,
        paint: DecodedPaint,
        glyphs: &[(u32, f32, f32)],
    ) {
        let Some(Some(font)) = self.ctx.fonts_by_id.get(&font_id) else {
            self.missing_fonts += 1;
            return;
        };
        let glyph_iter = glyphs.iter().map(|(id, x, y)| AnyGlyph {
            id: *id,
            x: *x,
            y: *y,
        });
        let t = affine(transform);
        match &paint {
            DecodedPaint::Solid { r, g, b, a } => {
                self.scene.draw_glyphs(
                    font,
                    font_size,
                    true,
                    normalized_coords,
                    Vec2::ZERO,
                    Fill::NonZero,
                    solid(*r, *g, *b, *a),
                    1.0,
                    t,
                    None,
                    glyph_iter,
                );
            }
            DecodedPaint::Gradient(g) => {
                let pg = g.to_peniko_gradient();
                self.scene.draw_glyphs(
                    font,
                    font_size,
                    true,
                    normalized_coords,
                    Vec2::ZERO,
                    Fill::NonZero,
                    &pg,
                    1.0,
                    t,
                    None,
                    glyph_iter,
                );
            }
            DecodedPaint::Image { content_hash } => {
                if let Some(img) = self.ctx.image(*content_hash) {
                    let brush = ImageBrush {
                        image: img.clone(),
                        sampler: image_sampler(),
                    };
                    self.scene.draw_glyphs(
                        font,
                        font_size,
                        true,
                        normalized_coords,
                        Vec2::ZERO,
                        Fill::NonZero,
                        brush.as_ref(),
                        1.0,
                        t,
                        None,
                        glyph_iter,
                    );
                } else {
                    self.missing_images += 1;
                }
            }
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "ReplayVisitor consumes the ordered KSC0 box-shadow callback fields."
    )]
    fn on_box_shadow(
        &mut self,
        transform: DecodedTransform,
        rect_x0: f32,
        rect_y0: f32,
        rect_x1: f32,
        rect_y1: f32,
        rgba: (u8, u8, u8, u8),
        radius: f32,
        std_dev: f32,
    ) {
        self.scene.draw_box_shadow(
            affine(transform),
            kurbo::Rect::new(
                rect_x0 as f64,
                rect_y0 as f64,
                rect_x1 as f64,
                rect_y1 as f64,
            ),
            solid(rgba.0, rgba.1, rgba.2, rgba.3),
            radius as f64,
            std_dev as f64,
        );
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "ReplayVisitor consumes the ordered KSC0 text-run callback fields."
    )]
    fn on_text_run(
        &mut self,
        _font_id: u32,
        _font_size: f32,
        _normalized_coords: &[i16],
        _transform: DecodedTransform,
        _rgba: (u8, u8, u8, u8),
        _start_x_q3: i16,
        _start_y_q3: i16,
        _text_utf8: &[u8],
        _kerns: &[(u16, i8)],
        _flags: u8,
    ) {
        self.text_runs += 1;
    }
}

#[derive(Default, Clone, Copy)]
pub(crate) struct ReplayStats {
    pub missing_fonts: u32,
    pub missing_images: u32,
    pub text_runs: u32,
    pub opaque: bool,
}

pub(crate) fn replay_into<S: PaintScene>(
    scene_bytes: &[u8],
    store: &ResourceStore,
    target: &mut S,
) -> Result<ReplayStats, String> {
    let header = scene_decode::parse_header(scene_bytes).map_err(|e| e.to_string())?;
    let mut resources =
        scene_decode::parse_resources(scene_bytes, &header).map_err(|e| e.to_string())?;
    let ctx = ReplayContext::new(store, &mut resources);
    let composition = scan_layer_composition(scene_bytes, raster_dimensions(&header));
    let mut vis = ReplayVisitor {
        scene: target,
        ctx: &ctx,
        missing_fonts: 0,
        missing_images: 0,
        text_runs: 0,
        clip_paths: !composition.non_source_over,
        open_clip_paths: Vec::new(),
    };
    scene_decode::decode(scene_bytes, &mut vis).map_err(|e| e.to_string())?;
    Ok(ReplayStats {
        missing_fonts: vis.missing_fonts,
        missing_images: vis.missing_images,
        text_runs: vis.text_runs,
        opaque: composition.opaque_background
            && !composition.non_source_over
            && !composition.unbalanced
            && composition.depth == 0,
    })
}

#[cfg(test)]
pub(crate) fn replay_to_rgba(
    scene_bytes: &[u8],
    store: &ResourceStore,
) -> Result<(Vec<u8>, u32, u32, ReplayStats), String> {
    replay_to_rgba_with(scene_bytes, store, &mut None, Vec::new())
}

const RENDERER_IMAGE_CACHE_BYTES: usize = 16 * 1024 * 1024;
const RENDERER_IMAGE_CACHE_PRUNE_FRAMES: u64 = 1;

pub(crate) struct CachedRenderer {
    w: u32,
    h: u32,
    renderer: anyrender_vello_cpu::VelloCpuImageRenderer,
}

fn raster_dimensions(header: &scene_decode::SceneHeader) -> (u32, u32) {
    const MAX_DIM: u32 = 4096;
    let h = if header.render_h > 0 {
        header.render_h
    } else {
        header.viewport_h
    };
    (header.viewport_w.clamp(1, MAX_DIM), h.clamp(1, MAX_DIM))
}

pub(crate) fn replay_to_rgba_with(
    scene_bytes: &[u8],
    store: &ResourceStore,
    slot: &mut Option<CachedRenderer>,
    mut buffer: Vec<u8>,
) -> Result<(Vec<u8>, u32, u32, ReplayStats), String> {
    use anyrender_vello_cpu::{ImageCacheConfig, VelloCpuImageRenderer};

    let header = scene_decode::parse_header(scene_bytes).map_err(|e| e.to_string())?;
    let (w, h) = raster_dimensions(&header);

    buffer.clear();
    buffer.resize((w as usize) * (h as usize) * 4, 0);
    match slot {
        Some(c) if c.w == w && c.h == h => c.renderer.reset(),
        _ => {
            let config = ImageCacheConfig {
                max_bytes: RENDERER_IMAGE_CACHE_BYTES,
                prune_interval: RENDERER_IMAGE_CACHE_PRUNE_FRAMES,
                ..Default::default()
            };
            *slot = Some(CachedRenderer {
                w,
                h,
                renderer: VelloCpuImageRenderer::with_image_cache_config(w, h, config),
            });
        }
    }
    let renderer = &mut slot.as_mut().expect("slot filled above").renderer;
    let mut result: Result<ReplayStats, String> = Ok(ReplayStats::default());
    renderer.render(
        |scene| {
            result = replay_into(scene_bytes, store, scene);
        },
        &mut buffer,
    );
    let stats = result?;
    Ok((buffer, w, h, stats))
}

#[cfg(feature = "pdf")]
fn split_pdf_envelope(envelope: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    if envelope.len() < PDF_ENVELOPE_U32_BYTES {
        return out;
    }
    let count = u32_le(&envelope[0..PDF_ENVELOPE_U32_BYTES]) as usize;
    let mut off = PDF_ENVELOPE_U32_BYTES;
    for _ in 0..count {
        if off + PDF_ENVELOPE_U32_BYTES > envelope.len() {
            break;
        }
        let len = u32_le(&envelope[off..off + PDF_ENVELOPE_U32_BYTES]) as usize;
        off += PDF_ENVELOPE_U32_BYTES;
        if off + len > envelope.len() {
            break;
        }
        out.push(&envelope[off..off + len]);
        off += len;
    }
    out
}

#[cfg(feature = "pdf")]
#[derive(Clone, Copy)]
struct PdfRenderOptions {
    paper_width: u32,
    paper_height: u32,
    omit_background: bool,
    margin_top: u32,
    margin_right: u32,
    margin_bottom: u32,
    margin_left: u32,
}

#[cfg(feature = "pdf")]
fn render_pdf_impl(
    store: &ResourceStore,
    envelope: &[u8],
    options: PdfRenderOptions,
) -> Result<Vec<u8>, String> {
    use krilla::page::PageSettings;
    use krilla::Document;

    let PdfRenderOptions {
        paper_width,
        paper_height,
        omit_background,
        margin_top,
        margin_right,
        margin_bottom,
        margin_left,
    } = options;
    let scenes = split_pdf_envelope(envelope);
    if scenes.is_empty() {
        return Err("empty pdf scene envelope".to_string());
    }
    let (ml, mt, content_w, _content_h) = content_box(
        paper_width,
        paper_height,
        margin_top,
        margin_right,
        margin_bottom,
        margin_left,
    );
    const PX_TO_PT: f32 = 72.0 / 96.0;
    let page_w_pt = (paper_width as f32) * PX_TO_PT;
    let page_h_pt = (paper_height as f32) * PX_TO_PT;
    let mut pdf_doc = Document::new();
    for scene_bytes in scenes {
        let header = scene_decode::parse_header(scene_bytes).map_err(|e| e.to_string())?;
        let stripe_h = if header.render_h > 0 {
            header.render_h
        } else {
            header.viewport_h
        };
        let settings = PageSettings::from_wh(page_w_pt, page_h_pt)
            .ok_or_else(|| format!("invalid page size {}x{}pt", page_w_pt, page_h_pt))?;
        let mut page = pdf_doc.start_page_with(settings);
        let mut surface = page.surface();
        push_px_to_pt_scale(&mut surface);
        if !omit_background {
            paint_white_background(&mut surface, paper_width, paper_height)?;
        }
        if ml > 0 || mt > 0 {
            let t = Transform::from_row(1.0, 0.0, 0.0, 1.0, ml as f32, mt as f32);
            surface.push_transform(&t);
        }
        push_page_clip(&mut surface, content_w as f32, stripe_h as f32);
        {
            let mut kps = KrillaPaintScene::new(&mut surface);
            replay_into(scene_bytes, store, &mut kps)?;
        }
        surface.pop();
        if ml > 0 || mt > 0 {
            surface.pop();
        }
        surface.pop();
    }
    pdf_doc
        .finish()
        .map_err(|e| format!("krilla finish: {:?}", e))
}

fn u32_le(b: &[u8]) -> u32 {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&b[0..4]);
    u32::from_le_bytes(buf)
}

fn u64_le(b: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&b[0..8]);
    u64::from_le_bytes(buf)
}

const MAX_RETAINED_PIXELS: usize = 2560 * 1440;

struct RetainedFrame {
    key: String,
    buf: Vec<u8>,
    w: u32,
    h: u32,
    opaque: bool,
    jpeg: Option<JpegRowCache>,
    dirty: (u32, u32),
    history: Vec<JpegRowCache>,
}

const JPEG_ROW_HISTORY: usize = 4;

impl RetainedFrame {
    fn encode(
        &mut self,
        fmt: ImageFormat,
        quality: u8,
        dirty: Option<(u32, u32)>,
        scratch: &mut Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        let cache = self.jpeg.take();
        self.dirty = (0, 0);
        if !matches!(fmt, ImageFormat::Jpeg) {
            return encode_rgba_frame(fmt, &mut self.buf, self.w, self.h, quality, scratch);
        }
        let reusable = match (cache, dirty) {
            (Some(cache), Some(rows)) if cache.matches(self.w, self.h, quality) => {
                Some((cache, rows))
            }
            _ => None,
        };
        let (bytes, cache) = match reusable {
            Some((mut cache, (y0, y1))) => (
                cache.encode_rows(&mut self.buf, y0, y1, self.opaque, scratch)?,
                cache,
            ),
            None => {
                let (w, h) = (self.w, self.h);
                let reused = if self.history.is_empty() {
                    None
                } else {
                    JpegRowCache::encode_reusing(
                        &mut self.buf,
                        w,
                        h,
                        quality,
                        &self.history,
                        self.opaque,
                        scratch,
                    )?
                };
                match reused {
                    Some(done) => done,
                    None => {
                        self.history.clear();
                        JpegRowCache::encode(&mut self.buf, w, h, quality, self.opaque, scratch)?
                    }
                }
            }
        };
        self.jpeg = Some(cache);
        Ok(bytes)
    }

    fn mark_dirty(&mut self, y0: u32, y1: u32) {
        let (d0, d1) = self.dirty;
        self.dirty = if y0 >= y1 {
            (d0, d1)
        } else if d0 >= d1 {
            (y0, y1)
        } else {
            (d0.min(y0), d1.max(y1))
        };
    }

    fn shift(&mut self, dx: i32, dy: i32) -> Result<(), String> {
        let (w, h) = (self.w as usize, self.h as usize);
        if dx == 0 && dy == 0 {
            return Ok(());
        }
        if dx.unsigned_abs() as usize >= w || dy.unsigned_abs() as usize >= h {
            return Err("shift exceeds the frame".to_string());
        }
        if let Some(mut cache) = self.jpeg.take().filter(|_| self.dirty.0 >= self.dirty.1) {
            cache.hash_rows(&self.buf);
            if self.history.len() == JPEG_ROW_HISTORY {
                self.history.remove(0);
            }
            self.history.push(cache);
        }
        let stride = w * 4;
        let rows = h - dy.unsigned_abs() as usize;
        let (from, to) = if dy < 0 {
            (-dy as usize, 0)
        } else {
            (0, dy as usize)
        };
        self.buf
            .copy_within(from * stride..(from + rows) * stride, to * stride);
        if dx != 0 {
            let cols = (w - dx.unsigned_abs() as usize) * 4;
            let (from, to) = if dx < 0 {
                (-dx as usize * 4, 0)
            } else {
                (0, dx as usize * 4)
            };
            for row in self.buf.chunks_exact_mut(stride) {
                row.copy_within(from..from + cols, to);
            }
        }
        self.mark_dirty(0, self.h);
        Ok(())
    }
}

#[inline]
fn same_rgba_row(left: &[u8], right: &[u8]) -> bool {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        let (left, tail_left) = left.as_chunks::<64>();
        let (right, tail_right) = right.as_chunks::<64>();
        for (a, b) in left.iter().zip(right) {
            let mut diff = i32x4_splat(0);
            for offset in [0, 16, 32, 48] {
                // SAFETY: each load lies within its 64-byte chunk; loads may be unaligned.
                let (a, b) = unsafe {
                    (
                        v128_load(a.as_ptr().add(offset).cast()),
                        v128_load(b.as_ptr().add(offset).cast()),
                    )
                };
                diff = v128_or(diff, v128_xor(a, b));
            }
            if v128_any_true(diff) {
                return false;
            }
        }
        tail_left == tail_right
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        left == right
    }
}

fn changed_rows(old: &[u8], new: &[u8], w: u32) -> (u32, u32) {
    let stride = w as usize * 4;
    let rows = || old.chunks_exact(stride).zip(new.chunks_exact(stride));
    let Some(top) = rows().position(|(a, b)| !same_rgba_row(a, b)) else {
        return (0, 0);
    };
    let bottom = rows()
        .rposition(|(a, b)| !same_rgba_row(a, b))
        .unwrap_or(top);
    (top as u32, bottom as u32 + 1)
}

fn blit_rgba(
    dst: &mut [u8],
    dst_size: (u32, u32),
    src: &[u8],
    src_size: (u32, u32),
    at: (i32, i32),
) {
    let (dw, dh) = dst_size;
    let (sw, sh) = src_size;
    let (at_x, at_y) = at;
    let sx0 = (-at_x).max(0) as u32;
    let sy0 = (-at_y).max(0) as u32;
    let dx0 = at_x.max(0) as u32;
    let dy0 = at_y.max(0) as u32;
    if sx0 >= sw || sy0 >= sh || dx0 >= dw || dy0 >= dh {
        return;
    }
    let w = (sw - sx0).min(dw - dx0) as usize;
    let h = (sh - sy0).min(dh - dy0) as usize;
    for row in 0..h {
        let s_off = ((sy0 as usize + row) * sw as usize + sx0 as usize) * 4;
        let d_off = ((dy0 as usize + row) * dw as usize + dx0 as usize) * 4;
        dst[d_off..d_off + w * 4].copy_from_slice(&src[s_off..s_off + w * 4]);
    }
}

fn encode_rgba_frame_owned(
    fmt: ImageFormat,
    mut buffer: Vec<u8>,
    w: u32,
    h: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    match fmt {
        ImageFormat::Jpeg => encode_jpeg(&mut buffer, w, h, quality),
        _ => encode_rgba_frame(fmt, &mut buffer, w, h, quality, &mut Vec::new()),
    }
}

fn encode_rgba_frame(
    fmt: ImageFormat,
    buffer: &mut [u8],
    w: u32,
    h: u32,
    quality: u8,
    scratch: &mut Vec<u8>,
) -> Result<Vec<u8>, String> {
    match fmt {
        ImageFormat::Png => encode_png(buffer, w, h),
        ImageFormat::Jpeg => encode_jpeg_retained(buffer, w, h, quality, false, scratch),
        ImageFormat::Webp => encode_webp(buffer, w, h),
        ImageFormat::Rgba => {
            let mut out = Vec::with_capacity(8 + buffer.len());
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
            out.extend_from_slice(buffer);
            Ok(out)
        }
    }
}

/// Wasm replay interface with one session resource cache per instance.
/// Raster and PDF failures return empty bytes; diagnostics are available via `lastRasterizeInfo`.
#[cfg_attr(not(feature = "native-host"), wasm_bindgen)]
#[derive(Default)]
pub struct SceneRasterizer {
    store: RefCell<ResourceStore>,
    last_error: RefCell<String>,
    last_stats: RefCell<ReplayStats>,
    retained: RefCell<Option<RetainedFrame>>,
    scratch: RefCell<Vec<u8>>,
    renderer: RefCell<Option<CachedRenderer>>,
}

// Manual RefUnwindSafe is valid in single-threaded Wasm: unwinding drops
// RefCell guards. A raster panic discards renderer state but keeps resources.
impl RefUnwindSafe for SceneRasterizer {}

#[cfg_attr(not(feature = "native-host"), wasm_bindgen)]
impl SceneRasterizer {
    /// Create a rasterizer with an empty resource store and no retained frame.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(constructor))]
    pub fn new() -> SceneRasterizer {
        SceneRasterizer::default()
    }

    /// Scan a framed scene for resources the store can't satisfy.
    /// Returns [count u32] + count × { kind u8, hash u64 (LE) }.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "missingResources")
    )]
    pub fn missing_resources(&self, scene: &[u8]) -> Vec<u8> {
        let _ks_span =
            tracing::info_span!("wasm.missing_resources", scene_bytes = scene.len()).entered();
        let store = self.store.borrow();
        missing_resources(&store, scene)
    }

    /// Ingest a PageScript render_rbi_resources reply. Returns the
    /// number of entries stored; asset-refs land in the pending
    /// list instead (see pendingFontAssets).
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "putResources"))]
    pub fn put_resources(&self, batch: &[u8]) -> u32 {
        self.store.borrow_mut().put_batch(batch)
    }

    /// Drop every cached font and image. Batch entries are stored under the hash the page
    /// reports, so the host calls this when the document that supplies them changes.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "resetResources"))]
    pub fn reset_resources(&self) {
        *self.store.borrow_mut() = ResourceStore::default();
    }

    /// Engine-store image keys awaiting putImageBytes, as decimal
    /// strings (a u64 doesn't survive a JS number). Format-3 refs
    /// land here instead of being stored — see IMAGE_FORMAT_ENGINE_REF.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "pendingImages"))]
    pub fn pending_images(&self) -> Vec<String> {
        self.store
            .borrow()
            .pending_images
            .keys()
            .map(|k| k.to_string())
            .collect()
    }

    /// Retire an engine-store image key whose payload is no longer available.
    /// Later missing-resource scans skip it; absent images paint as a no-op.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "abandonImage"))]
    pub fn abandon_image(&self, key: &str) -> u32 {
        let Ok(parsed) = key.parse::<u64>() else {
            return 0;
        };
        let mut store = self.store.borrow_mut();
        let removed = store.pending_images.remove(&parsed).is_some();
        if store.broken_images.len() >= MAX_BROKEN_RESOURCE_KEYS {
            store.broken_images.clear();
        }
        store.broken_images.insert(parsed);
        drop(store);
        u32::from(removed)
    }

    /// Supply the payload for one engine-store image ref. Returns 1 on
    /// a successful decode, 0 for an unknown key or undecodable bytes.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "putImageBytes"))]
    pub fn put_image_bytes(&self, key: &str, bytes: &[u8]) -> u32 {
        let Ok(parsed) = key.parse::<u64>() else {
            return 0;
        };
        self.store.borrow_mut().put_image_bytes(parsed, bytes)
    }

    /// JSON array of { hash: "<u64 as decimal string>", path }
    /// entries for font asset-refs awaiting putFontAsset.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "pendingFontAssets")
    )]
    pub fn pending_font_assets(&self) -> String {
        let store = self.store.borrow();
        let mut out = String::from("[");
        for (i, (hash, path)) in store.pending_assets.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"hash\":\"{}\",\"path\":\"{}\"}}",
                hash,
                path.replace('"', "")
            ));
        }
        out.push(']');
        out
    }

    /// Register a fetched font asset file (post-fetch bytes; woff2
    /// is decompressed here). `path` matches pending asset-refs —
    /// see ResourceStore::put_font_asset for why path, not hash.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "putFontAsset"))]
    pub fn put_font_asset(&self, path: &str, bytes: &[u8]) -> u32 {
        self.store.borrow_mut().put_font_asset(path, bytes)
    }

    /// Rasterize a framed scene to an encoded image. Empty Vec on
    /// failure — read lastError for the reason. Format string and
    /// quality clamp semantics match screenshot.rs encoders.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "rasterize"))]
    pub fn rasterize(
        &self,
        scene: &[u8],
        format: &str,
        quality: u8,
        omit_background: bool,
    ) -> Vec<u8> {
        self.rasterize_inner(scene, format, quality, omit_background, None)
    }

    /// Rasterize a full frame and retain its RGBA under `key` for later partial updates.
    /// Only one base is kept per instance; oversized frames are returned but not retained.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "rasterizeAndRetain")
    )]
    pub fn rasterize_and_retain(
        &self,
        scene: &[u8],
        format: &str,
        quality: u8,
        omit_background: bool,
        key: &str,
    ) -> Vec<u8> {
        self.rasterize_inner(scene, format, quality, omit_background, Some(key))
    }

    fn rasterize_inner(
        &self,
        scene: &[u8],
        format: &str,
        quality: u8,
        omit_background: bool,
        retain_key: Option<&str>,
    ) -> Vec<u8> {
        let _ks_span =
            tracing::info_span!("wasm.rasterize", scene_bytes = scene.len(), format).entered();
        let fmt = crate::paint::screenshot::ImageFormat::from_str(format);
        let store = self.store.borrow();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (buffer, w, h, stats) = {
                let _sp = tracing::info_span!("wasm.rasterize.replay").entered();
                let buffer = std::mem::take(&mut *self.scratch.borrow_mut());
                replay_to_rgba_with(scene, &store, &mut self.renderer.borrow_mut(), buffer)?
            };
            *self.last_stats.borrow_mut() = stats;
            let _ = omit_background;
            match retain_key {
                Some(key) if (w as usize) * (h as usize) <= MAX_RETAINED_PIXELS => {
                    let mut slot = self.retained.borrow_mut();
                    let mut dirty = None;
                    let frame = match slot.as_mut() {
                        Some(f) => {
                            f.key.clear();
                            if matches!(fmt, ImageFormat::Jpeg)
                                && f.jpeg.as_ref().is_some_and(|c| c.matches(w, h, quality))
                            {
                                dirty = Some(changed_rows(&f.buf, &buffer, w));
                            }
                            let prev = std::mem::replace(&mut f.buf, buffer);
                            if matches!(fmt, ImageFormat::Jpeg) {
                                *self.scratch.borrow_mut() = prev;
                            }
                            f.w = w;
                            f.h = h;
                            f.opaque = stats.opaque;
                            f
                        }
                        None => slot.insert(RetainedFrame {
                            key: String::new(),
                            buf: buffer,
                            w,
                            h,
                            opaque: stats.opaque,
                            jpeg: None,
                            dirty: (0, 0),
                            history: Vec::new(),
                        }),
                    };
                    let bytes = {
                        let _sp = tracing::info_span!("wasm.rasterize.encode", format).entered();
                        frame.encode(fmt, quality, dirty, &mut self.scratch.borrow_mut())?
                    };
                    frame.key.push_str(key);
                    Ok(bytes)
                }
                over_cap => {
                    if over_cap.is_some() {
                        if let Some(f) = self.retained.borrow_mut().as_mut() {
                            f.key.clear();
                        }
                    }
                    let _sp = tracing::info_span!("wasm.rasterize.encode", format).entered();
                    encode_rgba_frame_owned(fmt, buffer, w, h, quality)
                }
            }
        }));
        match result {
            Ok(Ok(bytes)) => {
                self.last_error.borrow_mut().clear();
                bytes
            }
            Ok(Err(e)) => {
                *self.last_error.borrow_mut() = e;
                Vec::new()
            }
            Err(_) => {
                *self.last_error.borrow_mut() = "rasterize panicked".to_string();
                *self.renderer.borrow_mut() = None;
                Vec::new()
            }
        }
    }

    /// Composite a damage-rect scene at viewport-space `(dst_x, dst_y)` and encode the full frame.
    /// Requires a retained frame with the same `key`.
    /// Failures return empty bytes and set `lastRasterizeInfo`.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "rasterizePartial")
    )]
    pub fn rasterize_partial(
        &self,
        scene: &[u8],
        dst_x: i32,
        dst_y: i32,
        format: &str,
        quality: u8,
        key: &str,
    ) -> Vec<u8> {
        let _ks_span =
            tracing::info_span!("wasm.rasterize_partial", scene_bytes = scene.len(), format)
                .entered();
        let fmt = ImageFormat::from_str(format);
        self.with_retained(key, "rasterizePartial", |frame| {
            self.blit_patch(frame, scene, dst_x, dst_y)?;
            let dirty = frame.dirty;
            frame.encode(fmt, quality, Some(dirty), &mut self.scratch.borrow_mut())
        })
        .unwrap_or_default()
    }

    /// Move the retained frame's pixels by (dx, dy) for a page scroll,
    /// without encoding. The caller patches the exposed band with
    /// `blitPartial`, then ships the frame with `encodeRetained`.
    /// Returns `false` when `key` does not identify the retained frame.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "shiftRetained"))]
    pub fn shift_retained(&self, key: &str, dx: i32, dy: i32) -> bool {
        self.with_retained(key, "shiftRetained", |frame| frame.shift(dx, dy))
            .is_some()
    }

    /// Apply `scene` at viewport-space `(dst_x, dst_y)` without encoding.
    /// Returns `false` if `key` does not match the base or the scene cannot be replayed.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "blitPartial"))]
    pub fn blit_partial(&self, scene: &[u8], dst_x: i32, dst_y: i32, key: &str) -> bool {
        self.with_retained(key, "blitPartial", |frame| {
            self.blit_patch(frame, scene, dst_x, dst_y)
        })
        .is_some()
    }

    /// Encode the retained frame, re-encoding only rows changed since its
    /// last encode.
    /// Returns empty bytes when `key` is not the retained base or encoding fails.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "encodeRetained"))]
    pub fn encode_retained(&self, format: &str, quality: u8, key: &str) -> Vec<u8> {
        let fmt = ImageFormat::from_str(format);
        self.with_retained(key, "encodeRetained", |frame| {
            let dirty = frame.dirty;
            frame.encode(fmt, quality, Some(dirty), &mut self.scratch.borrow_mut())
        })
        .unwrap_or_default()
    }

    fn with_retained<T>(
        &self,
        key: &str,
        what: &str,
        f: impl FnOnce(&mut RetainedFrame) -> Result<T, String>,
    ) -> Option<T> {
        let mut retained = self.retained.borrow_mut();
        let result = match retained.as_mut() {
            Some(frame) if frame.key == key => {
                panic::catch_unwind(panic::AssertUnwindSafe(|| f(frame)))
            }
            _ => Ok(Err("no retained base frame for key".to_string())),
        };
        // A failed operation on a matching base clears its key so a later partial
        // cannot reuse pixels that may have been partly changed.
        if !matches!(result, Ok(Ok(_))) {
            if let Some(frame) = retained.as_mut().filter(|f| f.key == key) {
                frame.key.clear();
            }
        }
        match result {
            Ok(Ok(value)) => {
                self.last_error.borrow_mut().clear();
                Some(value)
            }
            Ok(Err(e)) => {
                *self.last_error.borrow_mut() = e;
                None
            }
            Err(_) => {
                *self.last_error.borrow_mut() = format!("{what} panicked");
                *self.renderer.borrow_mut() = None;
                None
            }
        }
    }

    fn blit_patch(
        &self,
        frame: &mut RetainedFrame,
        scene: &[u8],
        dst_x: i32,
        dst_y: i32,
    ) -> Result<(), String> {
        let (patch, pw, ph, stats) = replay_to_rgba_with(
            scene,
            &self.store.borrow(),
            &mut self.renderer.borrow_mut(),
            Vec::new(),
        )?;
        *self.last_stats.borrow_mut() = stats;
        blit_rgba(
            &mut frame.buf,
            (frame.w, frame.h),
            &patch,
            (pw, ph),
            (dst_x, dst_y),
        );
        frame.opaque &= stats.opaque;
        let h = frame.h as i32;
        frame.mark_dirty(
            dst_y.clamp(0, h) as u32,
            dst_y.saturating_add(ph as i32).clamp(0, h) as u32,
        );
        Ok(())
    }

    /// Reserve scratch-buffer capacity for a `w`-by-`h` frame before rasterizing.
    /// This does not create or replace a retained frame.
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "reserveFrame"))]
    pub fn reserve_frame(&self, w: u32, h: u32) {
        let px = (w as usize) * (h as usize);
        if px == 0 || px > MAX_RETAINED_PIXELS {
            return;
        }
        let mut scratch = self.scratch.borrow_mut();
        scratch.clear();
        scratch.reserve(px * 4);
    }

    /// Key of the currently retained base frame ("" = none). The JS
    /// side gates its baseSeq handshake on this before opting in.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "retainedFrameKey")
    )]
    pub fn retained_frame_key(&self) -> String {
        self.retained
            .borrow()
            .as_ref()
            .map(|f| f.key.clone())
            .unwrap_or_default()
    }

    /// Union missingResources over every scene in a PDF envelope
    /// ([count u32] then per scene [len u32][framed bytes] — see
    /// DomHandle::recordPdfScenes). Same wire encoding as
    /// missingResources so the manager's split/fetch loop is shared.
    #[cfg(feature = "pdf")]
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "missingResourcesPdf")
    )]
    pub fn missing_resources_pdf(&self, envelope: &[u8]) -> Vec<u8> {
        let store = self.store.borrow();
        let mut union: Vec<(u8, u64)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for scene in split_pdf_envelope(envelope) {
            let missing = missing_resources(&store, scene);
            if missing.len() < RESOURCE_COUNT_BYTES {
                continue;
            }
            let count = u32_le(&missing[0..RESOURCE_COUNT_BYTES]) as usize;
            let mut off = RESOURCE_COUNT_BYTES;
            for _ in 0..count {
                if off + MISSING_RESOURCE_ENTRY_BYTES > missing.len() {
                    break;
                }
                let kind = missing[off];
                let hash = u64_le(&missing[off + 1..off + MISSING_RESOURCE_ENTRY_BYTES]);
                if seen.insert((kind, hash)) {
                    union.push((kind, hash));
                }
                off += MISSING_RESOURCE_ENTRY_BYTES;
            }
        }
        encode_missing(&union)
    }

    /// Replay a `recordPdfScenes` envelope into a Krilla document, one scene per page.
    /// Pages use a point-sized MediaBox, px-to-pt scale, and optional white fill.
    /// Margins and `render_h` set paint bounds. Failures return empty bytes; read
    /// `lastRasterizeInfo` for diagnostics.
    #[cfg(feature = "pdf")]
    #[cfg_attr(not(feature = "native-host"), wasm_bindgen(js_name = "renderPdf"))]
    #[allow(
        clippy::too_many_arguments,
        reason = "This wasm-bindgen export preserves the existing PageRenderer PDF ABI."
    )]
    pub fn render_pdf(
        &self,
        envelope: &[u8],
        paper_width: u32,
        paper_height: u32,
        omit_background: bool,
        margin_top: u32,
        margin_right: u32,
        margin_bottom: u32,
        margin_left: u32,
    ) -> Vec<u8> {
        let store = self.store.borrow();
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            render_pdf_impl(
                &store,
                envelope,
                PdfRenderOptions {
                    paper_width,
                    paper_height,
                    omit_background,
                    margin_top,
                    margin_right,
                    margin_bottom,
                    margin_left,
                },
            )
        }));
        match result {
            Ok(Ok(bytes)) => {
                self.last_error.borrow_mut().clear();
                bytes
            }
            Ok(Err(e)) => {
                *self.last_error.borrow_mut() = e;
                Vec::new()
            }
            Err(_) => {
                *self.last_error.borrow_mut() = "renderPdf panicked".to_string();
                Vec::new()
            }
        }
    }

    /// Diagnostics for the last rasterize call: JSON with the
    /// error string (empty = ok) + degraded-frame counters.
    #[cfg_attr(
        not(feature = "native-host"),
        wasm_bindgen(js_name = "lastRasterizeInfo")
    )]
    pub fn last_rasterize_info(&self) -> String {
        let stats = *self.last_stats.borrow();
        format!(
            "{{\"error\":\"{}\",\"missingFonts\":{},\"missingImages\":{},\"textRuns\":{}}}",
            self.last_error.borrow().replace('"', "'"),
            stats.missing_fonts,
            stats.missing_images,
            stats.text_runs,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::scene_record::RecordingScene;
    use anyrender_vello_cpu::VelloCpuImageRenderer;
    use peniko::kurbo::Rect;

    const W: u32 = 160;
    const H: u32 = 120;

    fn script_ops<S: PaintScene>(scene: &mut S, font: Option<&FontData>, img: Option<&ImageData>) {
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::WHITE,
            None,
            &Rect::new(0.0, 0.0, W as f64, H as f64),
        );
        scene.fill(
            Fill::NonZero,
            Affine::translate((10.0, 10.0)),
            Color::from_rgba8(200, 30, 30, 255),
            None,
            &Rect::new(0.0, 0.0, 60.0, 40.0),
        );
        let grad = peniko::Gradient::new_linear((80.0, 10.0), (140.0, 50.0)).with_stops([
            Color::from_rgba8(0, 0, 255, 255),
            Color::from_rgba8(0, 255, 0, 255),
        ]);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &grad,
            None,
            &Rect::new(80.0, 10.0, 140.0, 50.0),
        );
        scene.stroke(
            &kurbo::Stroke::new(3.0).with_caps(kurbo::Cap::Round),
            Affine::IDENTITY,
            Color::from_rgba8(10, 10, 10, 255),
            None,
            &kurbo::Line::new((10.0, 60.0), (150.0, 70.0)),
        );
        scene.push_clip_layer(
            Fill::NonZero,
            Affine::IDENTITY,
            &Rect::new(20.0, 75.0, 90.0, 110.0),
        );
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(255, 160, 0, 255),
            None,
            &kurbo::Circle::new((55.0, 92.0), 30.0),
        );
        scene.pop_layer();
        scene.draw_box_shadow(
            Affine::IDENTITY,
            Rect::new(100.0, 80.0, 140.0, 105.0),
            Color::from_rgba8(0, 0, 0, 128),
            4.0,
            3.0,
        );
        if let Some(font) = font {
            let glyphs = [
                AnyGlyph {
                    id: 40,
                    x: 12.0,
                    y: 55.0,
                },
                AnyGlyph {
                    id: 41,
                    x: 24.0,
                    y: 55.0,
                },
                AnyGlyph {
                    id: 42,
                    x: 36.0,
                    y: 55.0,
                },
            ];
            scene.draw_glyphs(
                font,
                16.0,
                true,
                &[],
                Vec2::ZERO,
                Fill::NonZero,
                Color::from_rgba8(20, 20, 120, 255),
                1.0,
                Affine::IDENTITY,
                None,
                glyphs.iter().copied(),
            );
        }
        if let Some(img) = img {
            let brush = ImageBrush {
                image: img.clone(),
                sampler: image_sampler(),
            };
            scene.fill(
                Fill::NonZero,
                Affine::translate((110.0, 10.0)),
                brush.as_ref(),
                None,
                &Rect::new(0.0, 0.0, img.width as f64, img.height as f64),
            );
        }
    }

    fn test_font() -> FontData {
        let bytes: &[u8] = include_bytes!("../../../engine/public/fonts/NotoSans.ttf");
        FontData::new(Blob::from(bytes.to_vec()), 0)
    }

    #[test]
    fn magic_valid_but_unparseable_face_is_refused() {
        assert!(
            !is_shapeable_face(&[0x00, 0x01, 0x00, 0x00], 0),
            "bare sfnt version, no offset table"
        );
        let mut truncated = vec![0x00, 0x01, 0x00, 0x00, 0x00, 0x10];
        truncated.extend_from_slice(&[0u8; 6]);
        assert!(
            !is_shapeable_face(&truncated, 0),
            "16 tables declared, directory absent"
        );
        let font = test_font();
        assert!(is_shapeable_face(font.data.data(), 0), "a real face passes");
    }

    fn test_image(side: u32) -> ImageData {
        let mut rgba = Vec::with_capacity((side * side * 4) as usize);
        for y in 0..side {
            for x in 0..side {
                rgba.push((x * 7 % 256) as u8);
                rgba.push((y * 11 % 256) as u8);
                rgba.push(((x + y) * 5 % 256) as u8);
                rgba.push(255);
            }
        }
        ImageData {
            data: Blob::from(rgba),
            format: peniko::ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: side,
            height: side,
        }
    }

    fn direct_render(font: Option<&FontData>, img: Option<&ImageData>) -> Vec<u8> {
        let mut buffer = vec![0u8; (W as usize) * (H as usize) * 4];
        let mut renderer = VelloCpuImageRenderer::new(W, H);
        renderer.render(|scene| script_ops(scene, font, img), &mut buffer);
        buffer
    }

    fn record_scene(
        font: Option<&FontData>,
        img: Option<&ImageData>,
    ) -> (Vec<u8>, RecordingSceneDrains) {
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        script_ops(&mut rec, font, img);
        let images = rec.drain_rbi_images();
        let fonts = rec.drain_font_bytes();
        (rec.finish_framed(), RecordingSceneDrains { images, fonts })
    }

    struct RecordingSceneDrains {
        images: Vec<(u64, crate::paint::scene_record::ImageInfo)>,
        fonts: Vec<(u64, Blob<u8>, u32)>,
    }

    #[test]
    fn render_pdf_replays_envelope_into_valid_pdf() {
        let img = test_image(64);
        let (page1, drains) = record_scene(None, Some(&img));
        let (page2, _) = record_scene(None, None);
        let mut envelope = Vec::new();
        envelope.extend_from_slice(&2u32.to_le_bytes());
        for s in [&page1, &page2] {
            envelope.extend_from_slice(&(s.len() as u32).to_le_bytes());
            envelope.extend_from_slice(s);
        }
        let raster = SceneRasterizer::new();
        let missing = raster.missing_resources_pdf(&envelope);
        assert_eq!(u32_le(&missing[0..4]), 1, "webp image is missing cold");
        let (hash, info) = &drains.images[0];
        let mut store = raster.store.borrow_mut();
        put_image_batch(&mut store, *hash, info);
        drop(store);
        assert_eq!(u32_le(&raster.missing_resources_pdf(&envelope)[0..4]), 0);
        let pdf = raster.render_pdf(&envelope, 816, 1056, false, 10, 10, 10, 10);
        assert!(pdf.len() > 500, "got {} bytes", pdf.len());
        assert_eq!(&pdf[0..5], b"%PDF-");
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"), "expected 2-page PDF");
    }

    fn solid_scene(w: u32, h: u32, color: Color) -> Vec<u8> {
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(w, h, 0, 0);
        rec.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            color,
            None,
            &Rect::new(0.0, 0.0, w as f64, h as f64),
        );
        rec.finish_framed()
    }

    #[test]
    fn kept_renderer_matches_a_fresh_one_across_frames_and_sizes() {
        let raster = SceneRasterizer::new();
        let retained = SceneRasterizer::new();
        let fresh = |scene: &[u8]| SceneRasterizer::new().rasterize(scene, "rgba", 0, false);
        let red = solid_scene(W, H, Color::from_rgba8(255, 0, 0, 128));
        let blue = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 128));
        let small = solid_scene(20, 10, Color::from_rgba8(0, 255, 0, 128));
        let (image, _) = record_scene(None, Some(&test_image(2)));
        for scene in [&red, &blue, &small, &blue, &image, &image] {
            assert_eq!(raster.rasterize(scene, "rgba", 0, false), fresh(scene));
            let jpeg = retained.rasterize_and_retain(scene, "jpeg", 80, false, "warm");
            assert!(!jpeg.is_empty());
            let expected = SceneRasterizer::new().rasterize(scene, "jpeg", 80, false);
            assert_eq!(
                jpeg, expected,
                "retained buffer reuse changed resized/translucent pixels",
            );
        }
    }

    #[test]
    fn rasterize_partial_composites_into_retained_frame() {
        let raster = SceneRasterizer::new();
        let base = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 255));
        let full = raster.rasterize_and_retain(&base, "rgba", 80, false, "k1");
        assert_eq!(raster.retained_frame_key(), "k1");
        assert_eq!(u32_le(&full[0..4]), W);
        let patch = solid_scene(20, 10, Color::from_rgba8(255, 0, 0, 255));
        let out = raster.rasterize_partial(&patch, 30, 40, "rgba", 80, "k1");
        assert_eq!(u32_le(&out[0..4]), W, "partial re-encodes the FULL frame");
        assert_eq!(u32_le(&out[4..8]), H);
        let px = |x: u32, y: u32| {
            let off = 8 + ((y * W + x) * 4) as usize;
            (out[off], out[off + 1], out[off + 2])
        };
        assert_eq!(px(35, 45), (255, 0, 0), "inside the patch");
        assert_eq!(px(5, 5), (0, 0, 255), "far outside untouched");
        assert_eq!(px(29, 40), (0, 0, 255), "left of the patch untouched");
        assert_eq!(px(30, 50), (0, 0, 255), "below the patch untouched");
    }

    #[test]
    fn retained_base_is_format_independent() {
        let base = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 128));
        let offframe = solid_scene(8, 8, Color::from_rgba8(255, 0, 0, 255));

        let pristine = SceneRasterizer::new();
        let expected = pristine.rasterize_and_retain(&base, "rgba", 80, false, "k");
        assert!(
            expected[8..]
                .as_chunks::<4>()
                .0
                .iter()
                .any(|px| px[3] != 255),
            "negative control: the fixture must contain non-opaque pixels",
        );

        let raster = SceneRasterizer::new();
        let jpeg = raster.rasterize_and_retain(&base, "jpeg", 80, false, "k");
        assert!(!jpeg.is_empty(), "jpeg retain produced bytes");
        let after_jpeg = raster.rasterize_partial(&offframe, 10_000, 10_000, "rgba", 80, "k");
        assert_eq!(
            after_jpeg, expected,
            "a jpeg encode must leave the retained base byte-identical",
        );

        for _ in 0..3 {
            let out = raster.rasterize_partial(&offframe, 10_000, 10_000, "jpeg", 80, "k");
            assert!(!out.is_empty(), "jpeg partial produced bytes");
        }
        let after_loop = raster.rasterize_partial(&offframe, 10_000, 10_000, "rgba", 80, "k");
        assert_eq!(
            after_loop, expected,
            "repeated jpeg partials must not drift the retained base",
        );
    }

    #[test]
    fn retain_returns_the_same_bytes_as_rasterize() {
        let scene = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 128));
        for fmt in ["png", "jpeg", "rgba"] {
            let plain = SceneRasterizer::new().rasterize(&scene, fmt, 80, false);
            let retained = SceneRasterizer::new().rasterize_and_retain(&scene, fmt, 80, false, "k");
            assert!(!plain.is_empty(), "{fmt}: rasterize produced bytes");
            assert_eq!(retained, plain, "{fmt}: retaining changed the output");
        }
    }

    fn block_scene(x: f64, y: f64) -> Vec<u8> {
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        let fill = |rec: &mut RecordingScene, color, rect: Rect| {
            rec.fill(Fill::NonZero, Affine::IDENTITY, color, None, &rect)
        };
        fill(
            &mut rec,
            Color::from_rgba8(0, 0, 255, 255),
            Rect::new(0.0, 0.0, W as f64, H as f64),
        );
        fill(
            &mut rec,
            Color::from_rgba8(255, 0, 0, 255),
            Rect::new(x, y, x + 12.0, y + 7.0),
        );
        rec.finish_framed()
    }

    #[test]
    fn retained_jpeg_composites_a_transparent_patch_after_an_opaque_frame() {
        let r = SceneRasterizer::new();
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        rec.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::WHITE,
            None,
            &Rect::new(0.0, 0.0, W as f64, H as f64),
        );
        let base = r.rasterize_and_retain(&rec.finish_framed(), "rgba", 0, false, "opaque");
        assert_eq!(base.len(), 8 + (W * H * 4) as usize);
        assert!(base[8..]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [255, 255, 255, 255]));
        let mut expected = base[8..].to_vec();
        let mut patch = RecordingScene::for_replay();
        patch.set_viewport(16, 16, 0, 0);
        patch.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(0, 200, 0, 128),
            None,
            &Rect::new(0.0, 0.0, 16.0, 16.0),
        );
        for y in 8..24usize {
            for x in 8..24usize {
                let offset = (y * W as usize + x) * 4;
                expected[offset..offset + 4].copy_from_slice(&[0, 100, 0, 128]);
            }
        }
        let jpeg = r.rasterize_partial(&patch.finish_framed(), 8, 8, "jpeg", 60, "opaque");
        let fresh = encode_jpeg(&mut expected.clone(), W, H, 60).unwrap();
        assert_eq!(jpeg, fresh);
        assert_eq!(
            &r.encode_retained("rgba", 0, "opaque")[8..],
            expected.as_slice()
        );
    }

    #[test]
    fn retained_jpeg_respects_group_opacity_and_destination_out() {
        for erase in [false, true] {
            let mut rec = RecordingScene::for_replay();
            rec.set_viewport(W, H, 0, 0);
            let bounds = Rect::new(0.0, 0.0, W as f64, H as f64);
            if erase {
                rec.fill(Fill::NonZero, Affine::IDENTITY, Color::WHITE, None, &bounds);
            }
            rec.push_layer(
                Fill::NonZero,
                BlendMode::new(
                    peniko::Mix::Normal,
                    if erase {
                        peniko::Compose::DestOut
                    } else {
                        peniko::Compose::SrcOver
                    },
                ),
                if erase { 1.0 } else { 0.5 },
                Affine::IDENTITY,
                &bounds,
                None,
                None,
            );
            rec.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(255, 0, 0, 255),
                None,
                &bounds,
            );
            rec.pop_layer();
            let r = SceneRasterizer::new();
            let framed = rec.finish_framed();
            let rgba = r.rasterize_and_retain(&framed, "rgba", 0, false, "group");
            assert_eq!(rgba.len(), 8 + (W * H * 4) as usize);
            assert_eq!(rgba[11], if erase { 0 } else { 128 });
            let fresh = encode_jpeg(&mut rgba[8..].to_vec(), W, H, 60).unwrap();
            assert_eq!(
                r.rasterize_and_retain(&framed, "jpeg", 60, false, "group"),
                fresh
            );
            assert_eq!(r.encode_retained("rgba", 0, "group"), rgba);
        }
    }

    #[test]
    fn retained_jpeg_full_frames_match_a_fresh_encode() {
        let raster = SceneRasterizer::new();
        let frames = [
            (40.0, 50.0),
            (40.0, 50.0),
            (70.0, H as f64 - 7.0),
            (10.0, 0.0),
            (40.0, 50.0),
        ];
        for quality in [80, 95] {
            for (i, &(x, y)) in frames.iter().enumerate() {
                let scene = block_scene(x, y);
                let fresh = SceneRasterizer::new().rasterize(&scene, "jpeg", quality, false);
                let out = raster.rasterize_and_retain(&scene, "jpeg", quality, false, "k");
                assert_eq!(out, fresh, "q{quality} frame {i}: retained encode differs");
            }
        }
    }

    fn page_window(x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
        const CELL: i32 = 9;
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(w, h, 0, 0);
        for row in y / CELL..=(y + h as i32) / CELL {
            for col in x / CELL..=(x + w as i32) / CELL {
                let color =
                    Color::from_rgba8((row * 37 % 256) as u8, (col * 53 % 256) as u8, 128, 255);
                let (cx, cy) = ((col * CELL - x) as f64, (row * CELL - y) as f64);
                let cell = Rect::new(cx, cy, cx + CELL as f64, cy + CELL as f64);
                rec.fill(Fill::NonZero, Affine::IDENTITY, color, None, &cell);
            }
        }
        rec.finish_framed()
    }

    #[test]
    fn scroll_shift_matches_a_fresh_frame() {
        let (w, h) = (W as i32, H as i32);
        let scrolls = [
            (0, 0),
            (0, 23),
            (0, 5),
            (13, 40),
            (4, 40),
            (4, 56),
            (4, 48),
            (4, 64),
            (4, 40 + h - 1),
        ];
        for format in ["rgba", "jpeg"] {
            let raster = SceneRasterizer::new();
            raster.rasterize_and_retain(&page_window(0, 0, W, H), format, 80, false, "k");
            for pair in scrolls.windows(2) {
                let ((ox, oy), (sx, sy)) = (pair[0], pair[1]);
                let (dx, dy) = (sx - ox, sy - oy);
                assert!(raster.shift_retained("k", -dx, -dy));
                if dy != 0 {
                    let top = if dy > 0 { h - dy } else { 0 };
                    let band = page_window(sx, sy + top, W, dy.unsigned_abs());
                    assert!(raster.blit_partial(&band, 0, top, "k"));
                }
                if dx != 0 {
                    let left = if dx > 0 { w - dx } else { 0 };
                    let band = page_window(sx + left, sy, dx.unsigned_abs(), H);
                    assert!(raster.blit_partial(&band, left, 0, "k"));
                }
                let out = raster.encode_retained(format, 80, "k");
                let fresh =
                    SceneRasterizer::new().rasterize(&page_window(sx, sy, W, H), format, 80, false);
                assert!(
                    out == fresh,
                    "{format} scroll ({sx},{sy}): shifted frame differs"
                );
            }
        }
    }

    #[test]
    fn rasterize_partial_requires_matching_retained_key() {
        let raster = SceneRasterizer::new();
        let patch = solid_scene(8, 8, Color::from_rgba8(255, 0, 0, 255));
        assert!(raster
            .rasterize_partial(&patch, 0, 0, "rgba", 80, "k1")
            .is_empty());
        let base = solid_scene(W, H, Color::WHITE);
        let _ = raster.rasterize_and_retain(&base, "rgba", 80, false, "k1");
        assert!(raster
            .rasterize_partial(&patch, 0, 0, "rgba", 80, "other")
            .is_empty());
        let _ = raster.rasterize(&base, "rgba", 80, false);
        assert_eq!(raster.retained_frame_key(), "k1");
    }

    #[test]
    fn reserve_frame_presizes_scratch_and_creates_no_base() {
        let raster = SceneRasterizer::new();
        raster.reserve_frame(W, H);
        assert_eq!(raster.retained_frame_key(), "");
        let patch = solid_scene(8, 8, Color::from_rgba8(255, 0, 0, 255));
        assert!(raster
            .rasterize_partial(&patch, 0, 0, "rgba", 80, "k1")
            .is_empty());
        let base = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 255));
        let _ = raster.rasterize_and_retain(&base, "rgba", 80, false, "k1");
        assert_eq!(raster.retained_frame_key(), "k1");
        let out = raster.rasterize_partial(&patch, 30, 40, "rgba", 80, "k1");
        assert_eq!(u32_le(&out[0..4]), W);
        let px = |x: u32, y: u32| {
            let off = 8 + ((y * W + x) * 4) as usize;
            (out[off], out[off + 1], out[off + 2])
        };
        assert_eq!(px(35, 45), (255, 0, 0), "inside the patch");
        assert_eq!(px(5, 5), (0, 0, 255), "outside untouched");
    }

    #[test]
    fn rasterize_partial_clamps_offframe_patches() {
        let raster = SceneRasterizer::new();
        let base = solid_scene(W, H, Color::from_rgba8(0, 0, 255, 255));
        let _ = raster.rasterize_and_retain(&base, "rgba", 80, false, "k");
        let patch = solid_scene(20, 10, Color::from_rgba8(255, 0, 0, 255));
        let out = raster.rasterize_partial(&patch, -10, -5, "rgba", 80, "k");
        let px = |x: u32, y: u32| {
            let off = 8 + ((y * W + x) * 4) as usize;
            (out[off], out[off + 1], out[off + 2])
        };
        assert_eq!(px(0, 0), (255, 0, 0), "overlapping quadrant lands");
        assert_eq!(px(9, 4), (255, 0, 0));
        assert_eq!(px(10, 0), (0, 0, 255), "clamped at the patch edge");
        assert_eq!(px(0, 5), (0, 0, 255));
        let out2 = raster.rasterize_partial(&patch, W as i32 + 5, 0, "rgba", 80, "k");
        assert!(!out2.is_empty());
        let off00 = 8_usize;
        assert_eq!(out2[off00], 255, "prior composite persists");
        let off = 8 + ((50 * W + 50) * 4) as usize;
        assert_eq!(out2[off + 2], 255, "base pixels unchanged");
    }

    #[test]
    fn replay_matches_direct_render_no_resources() {
        let (framed, _) = record_scene(None, None);
        let store = ResourceStore::default();
        let (buf, w, h, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!((w, h), (W, H));
        assert_eq!(stats.missing_fonts, 0);
        assert_eq!(stats.missing_images, 0);
        let direct = direct_render(None, None);
        assert_buffers_close(&buf, &direct, 0.001);
    }

    fn translucent_overlaps_in_fractional_clip<S: PaintScene>(scene: &mut S) {
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::WHITE,
            None,
            &Rect::new(0.0, 0.0, W as f64, H as f64),
        );
        scene.push_clip_layer(
            Fill::NonZero,
            Affine::IDENTITY,
            &Rect::new(20.5, 20.5, 100.5, 80.5),
        );
        for (rect, rgba) in [
            (Rect::new(10.0, 10.0, 110.0, 90.0), [255, 0, 0, 128]),
            (Rect::new(40.0, 30.0, 130.0, 100.0), [0, 0, 255, 128]),
        ] {
            let [r, g, b, a] = rgba;
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(r, g, b, a),
                None,
                &rect,
            );
        }
        scene.pop_layer();
    }

    fn dest_out_layer_in_whole_pixel_clip<S: PaintScene>(scene: &mut S) {
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::WHITE,
            None,
            &Rect::new(0.0, 0.0, W as f64, H as f64),
        );
        scene.push_clip_layer(
            Fill::NonZero,
            Affine::IDENTITY,
            &Rect::new(20.0, 20.0, 100.0, 80.0),
        );
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(255, 0, 0, 255),
            None,
            &Rect::new(10.0, 10.0, 110.0, 90.0),
        );
        let hole = Rect::new(40.0, 30.0, 80.0, 60.0);
        scene.push_layer(
            Fill::NonZero,
            BlendMode::new(peniko::Mix::Normal, peniko::Compose::DestOut),
            1.0,
            Affine::IDENTITY,
            &hole,
            None,
            None,
        );
        scene.fill(Fill::NonZero, Affine::IDENTITY, Color::BLACK, None, &hole);
        scene.pop_layer();
        scene.pop_layer();
    }

    fn replay_diff_from_clip_layers(
        record: fn(&mut RecordingScene),
        direct: fn(&mut anyrender_vello_cpu::VelloCpuScenePainter),
    ) -> u8 {
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        record(&mut rec);
        let (replayed, _, _, _) =
            replay_to_rgba(&rec.finish_framed(), &ResourceStore::default()).unwrap();
        let mut layered = vec![0u8; (W as usize) * (H as usize) * 4];
        VelloCpuImageRenderer::new(W, H).render(direct, &mut layered);
        replayed
            .iter()
            .zip(&layered)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap()
    }

    const CLIP_ROUNDING: u8 = 1;

    #[test]
    fn a_fractional_clip_replays_as_a_clip_layer() {
        let worst = replay_diff_from_clip_layers(
            translucent_overlaps_in_fractional_clip,
            translucent_overlaps_in_fractional_clip,
        );
        assert!(worst <= CLIP_ROUNDING, "replay is off by {worst}");
    }

    #[test]
    fn a_destination_out_layer_keeps_its_clip_a_layer() {
        let worst = replay_diff_from_clip_layers(
            dest_out_layer_in_whole_pixel_clip,
            dest_out_layer_in_whole_pixel_clip,
        );
        assert!(worst <= CLIP_ROUNDING, "replay is off by {worst}");
    }

    #[test]
    fn replay_matches_direct_render_with_font_and_inline_image() {
        let font = test_font();
        let img = test_image(16);
        let (framed, _) = record_scene(Some(&font), Some(&img));
        let mut store = ResourceStore::default();
        let key = font_data_key(crate::paint::scene_record::fx_hash_u64(font.data.data()), 0);
        store.insert_font(key, font.clone());
        let (buf, _, _, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!(stats.missing_fonts, 0);
        assert_eq!(stats.missing_images, 0);
        assert_eq!(stats.text_runs, 0);
        let direct = direct_render(Some(&font), Some(&img));
        assert_buffers_close(&buf, &direct, 0.001);
    }

    fn uniform_image(side: u32, rgba: [u8; 4]) -> ImageData {
        ImageData {
            data: Blob::from(rgba.repeat((side * side) as usize)),
            format: peniko::ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: side,
            height: side,
        }
    }

    fn scaled_image_fill<S: PaintScene>(scene: &mut S, img: &ImageData) {
        let brush = ImageBrush {
            image: img.clone(),
            sampler: image_sampler(),
        };
        scene.fill(
            Fill::NonZero,
            Affine::translate((10.3, 7.6)) * Affine::scale_non_uniform(0.84, 1.7),
            brush.as_ref(),
            None,
            &Rect::new(0.0, 0.0, img.width as f64, img.height as f64),
        );
    }

    #[test]
    fn solid_color_image_replays_identical_to_the_image_brush() {
        let (inline_side, store_side) = (16, 64);
        for side in [inline_side, store_side] {
            let img = uniform_image(side, [200, 30, 90, 255]);
            assert!(opaque_solid_color(&img).is_some());
            let mut direct = vec![0u8; (W * H * 4) as usize];
            VelloCpuImageRenderer::new(W, H)
                .render(|scene| scaled_image_fill(scene, &img), &mut direct);
            let mut rec = RecordingScene::for_replay();
            rec.set_viewport(W, H, 0, 0);
            scaled_image_fill(&mut rec, &img);
            let images = rec.drain_rbi_images();
            let framed = rec.finish_framed();
            let mut store = ResourceStore::default();
            for (hash, info) in &images {
                put_image_batch(&mut store, *hash, info);
            }
            assert_eq!(store.solid_images.len(), images.len());
            let (buf, _, _, stats) = replay_to_rgba(&framed, &store).unwrap();
            assert_eq!(stats.missing_images, 0);
            assert!(
                buf == direct,
                "{side} px solid image diverged from the image brush"
            );
        }
        assert!(opaque_solid_color(&uniform_image(4, [200, 30, 90, 254])).is_none());
        assert!(opaque_solid_color(&test_image(4)).is_none());
    }

    fn oblique_ops<S: PaintScene>(scene: &mut S, font: &FontData, skew: Option<Affine>) {
        let glyphs = [
            AnyGlyph {
                id: 0x2C,
                x: 10.0,
                y: 60.0,
            },
            AnyGlyph {
                id: 0x2D,
                x: 40.0,
                y: 60.0,
            },
            AnyGlyph {
                id: 0x2E,
                x: 70.0,
                y: 60.0,
            },
        ];
        scene.draw_glyphs(
            font,
            48.0,
            true,
            &[],
            Vec2::ZERO,
            Fill::NonZero,
            Color::from_rgba8(0, 0, 0, 255),
            1.0,
            Affine::IDENTITY,
            skew,
            glyphs.iter().copied(),
        );
    }

    fn oblique_direct(font: &FontData, skew: Option<Affine>) -> Vec<u8> {
        let mut buffer = vec![0u8; (W as usize) * (H as usize) * 4];
        let mut renderer = VelloCpuImageRenderer::new(W, H);
        renderer.render(|scene| oblique_ops(scene, font, skew), &mut buffer);
        buffer
    }

    fn oblique_replayed(font: &FontData, skew: Option<Affine>) -> Vec<u8> {
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        oblique_ops(&mut rec, font, skew);
        let framed = rec.finish_framed();
        let mut store = ResourceStore::default();
        let key = font_data_key(crate::paint::scene_record::fx_hash_u64(font.data.data()), 0);
        store.insert_font(key, font.clone());
        let (buf, _, _, _) = replay_to_rgba(&framed, &store).unwrap();
        buf
    }

    fn lean(buf: &[u8]) -> f64 {
        let band = |y0: u32, y1: u32| -> Option<f64> {
            let mut sum = 0.0;
            let mut n = 0.0;
            for y in y0..y1 {
                for x in 0..W {
                    let a = buf[((y * W + x) * 4 + 3) as usize];
                    if a > 64 {
                        sum += x as f64;
                        n += 1.0;
                    }
                }
            }
            if n > 0.0 {
                Some(sum / n)
            } else {
                None
            }
        };
        let top = band(26, 38).expect("no ink in the top band");
        let bottom = band(48, 60).expect("no ink in the bottom band");
        top - bottom
    }

    #[test]
    fn a_synthetic_oblique_run_replays_the_way_it_renders() {
        let font = test_font();
        let skew = Some(Affine::skew(-14f64.to_radians().tan(), 0.0));

        let direct = oblique_direct(&font, skew);
        let replayed = oblique_replayed(&font, skew);

        let direct_lean = lean(&direct);
        assert!(
            direct_lean > 0.0,
            "the reference render leans left ({direct_lean:.2}); the skew convention \
             changed and this test is measuring the wrong thing"
        );
        let replay_lean = lean(&replayed);
        assert!(
            replay_lean > 0.0,
            "replayed italic leans LEFT ({replay_lean:.2}) where the painter leans \
             right ({direct_lean:.2}) — a glyph-space shear applied in device space"
        );
        assert_buffers_close(&replayed, &direct, 0.001);
    }

    #[test]
    fn an_upright_run_replays_identically() {
        let font = test_font();
        assert_buffers_close(
            &oblique_replayed(&font, None),
            &oblique_direct(&font, None),
            0.001,
        );
    }

    #[test]
    fn missing_scan_rejects_a_truncated_inline_image_after_a_valid_ref() {
        let (mut framed, _) = record_scene(None, Some(&test_image(2)));
        let header = scene_decode::parse_header(&framed).unwrap();
        let off = header.resource_offset as usize;
        let mut reference = 42u64.to_le_bytes().to_vec();
        reference.extend_from_slice(&1u32.to_le_bytes());
        reference.extend_from_slice(&1u32.to_le_bytes());
        reference.extend_from_slice(&[0, 1, 0, 0]);
        reference.extend_from_slice(&0u32.to_le_bytes());
        framed.splice(off + 4..off + 4, reference);
        framed[off..off + 4].copy_from_slice(&2u32.to_le_bytes());

        let store = ResourceStore::default();
        let mut expected = vec![1, 0, 0, 0, RBI_RESOURCE_KIND_IMAGE];
        expected.extend_from_slice(&42u64.to_le_bytes());
        assert_eq!(missing_resources(&store, &framed), expected);

        framed.pop();
        assert_eq!(missing_resources(&store, &framed), vec![0; 4]);
    }

    #[test]
    fn missing_then_put_resolves_webp_image_and_font() {
        let font = test_font();
        let img = test_image(64);
        let (framed, drains) = record_scene(Some(&font), Some(&img));
        let mut store = ResourceStore::default();

        let missing = missing_resources(&store, &framed);
        let count = u32_le(&missing[0..4]);
        assert_eq!(count, 2, "expect 1 font + 1 webp image missing");

        let mut batch = Vec::new();
        batch.extend_from_slice(&2u32.to_le_bytes());
        let (img_hash, info) = &drains.images[0];
        batch.push(RBI_RESOURCE_KIND_IMAGE);
        batch.extend_from_slice(&img_hash.to_le_bytes());
        batch.extend_from_slice(&((info.wire_bytes.data().len() + 9) as u32).to_le_bytes());
        batch.extend_from_slice(&info.width.to_le_bytes());
        batch.extend_from_slice(&info.height.to_le_bytes());
        batch.push(info.format);
        batch.extend_from_slice(info.wire_bytes.data());
        let (font_hash, blob, idx) = &drains.fonts[0];
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&font_hash.to_le_bytes());
        batch.extend_from_slice(&((blob.data().len() + 5) as u32).to_le_bytes());
        batch.push(FONT_DATA_REF_BLOB);
        batch.extend_from_slice(&idx.to_le_bytes());
        batch.extend_from_slice(blob.data());
        assert_eq!(store.put_batch(&batch), 2);

        let missing_after = missing_resources(&store, &framed);
        assert_eq!(u32_le(&missing_after[0..4]), 0);

        let (buf, _, _, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!(stats.missing_fonts, 0);
        assert_eq!(stats.missing_images, 0);
        let direct = direct_render(Some(&font), Some(&img));
        assert_buffers_close(&buf, &direct, 0.001);
    }

    #[test]
    fn unusable_font_blob_is_refused_and_stops_the_ask_loop() {
        let font = test_font();
        let (framed, drains) = record_scene(Some(&font), None);
        let mut store = ResourceStore::default();
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 1);

        let (font_hash, _, idx) = &drains.fonts[0];
        let body = b"wOF2\xde\xad\xbe\xef not a font at all";
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&font_hash.to_le_bytes());
        batch.extend_from_slice(&((body.len() + 5) as u32).to_le_bytes());
        batch.push(FONT_DATA_REF_BLOB);
        batch.extend_from_slice(&idx.to_le_bytes());
        batch.extend_from_slice(body);

        assert_eq!(
            store.put_batch(&batch),
            0,
            "an unusable face stores nothing"
        );
        assert!(!store.fonts.contains_key(font_hash));
        assert!(store.broken_fonts.contains(font_hash));
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 0);
        let (_, _, _, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!(stats.missing_fonts, 1);
    }

    #[test]
    fn unusable_font_asset_is_refused_and_clears_the_pending_entry() {
        let font = test_font();
        let (framed, drains) = record_scene(Some(&font), None);
        let mut store = ResourceStore::default();
        let (font_hash, _, idx) = &drains.fonts[0];

        let path = "/fonts/NotAFace.ttf";
        let mut body = vec![FONT_DATA_REF_ASSET];
        body.extend_from_slice(&idx.to_le_bytes());
        body.extend_from_slice(path.as_bytes());
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&font_hash.to_le_bytes());
        batch.extend_from_slice(&(body.len() as u32).to_le_bytes());
        batch.extend_from_slice(&body);
        store.put_batch(&batch);
        assert_eq!(
            store.pending_assets.get(font_hash).map(String::as_str),
            Some(path)
        );

        assert_eq!(store.put_font_asset(path, b"OTTO not a real face"), 0);
        assert!(store.broken_fonts.contains(font_hash));
        assert!(!store.pending_assets.contains_key(font_hash));
        assert!(!store.fonts.contains_key(font_hash));
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 0);
    }

    // The renderer reports a url-ref whose pull returned nothing as empty bytes; the next
    // scan must not ask for it again, or every render re-fetches the page-chosen URL.
    #[test]
    fn font_url_ref_that_delivered_nothing_is_not_asked_for_again() {
        let font = test_font();
        let (framed, drains) = record_scene(Some(&font), None);
        let mut store = ResourceStore::default();
        let (font_hash, _, idx) = &drains.fonts[0];

        let path = "https://fonts.example/gone.woff2";
        let mut body = vec![FONT_DATA_REF_ASSET];
        body.extend_from_slice(&idx.to_le_bytes());
        body.extend_from_slice(path.as_bytes());
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&font_hash.to_le_bytes());
        batch.extend_from_slice(&(body.len() as u32).to_le_bytes());
        batch.extend_from_slice(&body);
        store.put_batch(&batch);

        assert_eq!(store.put_font_asset(path, &[]), 0);
        assert!(store.pending_assets.is_empty());
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 0);
    }

    #[test]
    fn asset_ref_flow_pends_then_resolves() {
        let font = test_font();
        let fd_key = font_data_key(crate::paint::scene_record::fx_hash_u64(font.data.data()), 0);
        let mut store = ResourceStore::default();
        let name = b"/fonts/NotoSans.ttf";
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&fd_key.to_le_bytes());
        batch.extend_from_slice(&((name.len() + 5) as u32).to_le_bytes());
        batch.push(FONT_DATA_REF_ASSET);
        batch.extend_from_slice(&0u32.to_le_bytes());
        batch.extend_from_slice(name);
        store.put_batch(&batch);
        assert_eq!(store.pending_assets.len(), 1);
        store.put_font_asset("/fonts/NotoSans.ttf", font.data.data());
        assert!(store.pending_assets.is_empty());
        assert!(store.fonts.contains_key(&fd_key));
    }

    fn engine_ref_batch(key: u64, w: u32, h: u32, hint: (u32, u32)) -> Vec<u8> {
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_IMAGE);
        batch.extend_from_slice(&key.to_le_bytes());
        batch.extend_from_slice(&17u32.to_le_bytes());
        batch.extend_from_slice(&w.to_le_bytes());
        batch.extend_from_slice(&h.to_le_bytes());
        batch.push(crate::paint::scene_record::IMAGE_FORMAT_ENGINE_REF);
        batch.extend_from_slice(&hint.0.to_le_bytes());
        batch.extend_from_slice(&hint.1.to_le_bytes());
        batch
    }

    #[test]
    fn engine_ref_keeps_the_decode_hint() {
        let mut store = ResourceStore::default();
        store.put_batch(&engine_ref_batch(42, 800, 600, (200, 150)));
        assert_eq!(store.pending_images.get(&42), Some(&(800, 600, (200, 150))));
    }

    #[test]
    fn abandoned_engine_ref_is_not_re_pended() {
        let store = SceneRasterizer::default();
        store.put_resources(&engine_ref_batch(7, 64, 64, (64, 64)));
        assert_eq!(store.pending_images(), vec!["7".to_string()]);

        assert_eq!(store.abandon_image("7"), 1);
        assert!(store.pending_images().is_empty());

        store.put_resources(&engine_ref_batch(7, 64, 64, (64, 64)));
        assert!(
            store.pending_images().is_empty(),
            "abandoned ref was re-pended by the next replay"
        );
    }

    #[test]
    fn reset_resources_forgets_every_supplied_image() {
        let raster = SceneRasterizer::default();
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_IMAGE);
        batch.extend_from_slice(&9u64.to_le_bytes());
        batch.extend_from_slice(&13u32.to_le_bytes());
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(0);
        batch.extend_from_slice(&[255, 0, 0, 255]);
        assert_eq!(raster.put_resources(&batch), 1);
        assert!(raster.store.borrow().images.contains_key(&9));
        raster.reset_resources();
        assert!(raster.store.borrow().images.is_empty());
    }

    fn png_bytes(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).unwrap();
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn encoded_image(png: Vec<u8>, w: u32, h: u32) -> ImageData {
        ImageData {
            data: Blob::from(png),
            format: peniko::ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: w,
            height: h,
        }
    }

    fn put_image_batch(
        store: &mut ResourceStore,
        hash: u64,
        info: &crate::paint::scene_record::ImageInfo,
    ) {
        let prefix = if info.format == 2 { 17 } else { 9 };
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_IMAGE);
        batch.extend_from_slice(&hash.to_le_bytes());
        batch.extend_from_slice(&((info.wire_bytes.data().len() + prefix) as u32).to_le_bytes());
        batch.extend_from_slice(&info.width.to_le_bytes());
        batch.extend_from_slice(&info.height.to_le_bytes());
        batch.push(info.format);
        if info.format == 2 {
            batch.extend_from_slice(&info.needed_w.to_le_bytes());
            batch.extend_from_slice(&info.needed_h.to_le_bytes());
        }
        batch.extend_from_slice(info.wire_bytes.data());
        assert_eq!(store.put_batch(&batch), 1);
    }

    #[test]
    fn mip_dims_follows_hint_and_ceiling() {
        assert_eq!(mip_dims(1024, 512, 0, 0, 4096), (1024, 512));
        assert_eq!(mip_dims(8192, 4096, 0, 0, 4096), (4096, 2048));
        assert_eq!(mip_dims(1024, 1024, 100, 100, 4096), (128, 128));
        assert_eq!(mip_dims(1024, 1024, 512, 512, 4096), (512, 512));
        assert_eq!(mip_dims(1024, 1024, 513, 513, 4096), (1024, 1024));
        assert_eq!(mip_dims(800, 600, 800, 600, 4096), (800, 600));
        assert_eq!(mip_dims(8192, 8192, 8192, 8192, 4096), (4096, 4096));
    }

    #[test]
    fn encoded_image_ships_original_bytes_and_replays() {
        let decoded = test_image(64);
        let png = png_bytes(decoded.data.data(), 64, 64);
        let enc = encoded_image(png.clone(), 64, 64);

        let (framed, drains) = record_scene(None, Some(&enc));
        assert_eq!(drains.images.len(), 1);
        let (hash, info) = &drains.images[0];
        assert_eq!(info.format, 2);
        assert_eq!(info.wire_bytes.data(), png.as_slice());

        let mut store = ResourceStore::default();
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 1);
        put_image_batch(&mut store, *hash, info);
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 0);

        let (buf, _, _, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!(stats.missing_images, 0);
        let direct = direct_render(None, Some(&decoded));
        assert_buffers_close(&buf, &direct, 0.001);
    }

    #[test]
    fn encoded_image_mip_decode_upscales_via_brush_transform() {
        let (w, h) = (4096u32, 8u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _y in 0..h {
            for x in 0..w {
                let red = (x / 256) % 2 == 0;
                rgba.extend_from_slice(if red {
                    &[255, 0, 0, 255]
                } else {
                    &[0, 0, 255, 255]
                });
            }
        }
        let enc = encoded_image(png_bytes(&rgba, w, h), w, h);

        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        let brush = ImageBrush {
            image: enc.clone(),
            sampler: image_sampler(),
        };
        rec.fill(
            Fill::NonZero,
            Affine::scale(0.25),
            brush.as_ref(),
            None,
            &Rect::new(0.0, 0.0, w as f64, h as f64),
        );
        let images = rec.drain_rbi_images();
        let framed = rec.finish_framed();

        let (hash, info) = &images[0];
        assert_eq!((info.needed_w, info.needed_h), (1024, 2));

        let mut store = ResourceStore::default();
        put_image_batch(&mut store, *hash, info);
        let stored = store.images.get(hash).unwrap();
        assert_eq!((stored.width, stored.height), (1024, 2));
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 0);

        let (buf, bw, _, stats) = replay_to_rgba(&framed, &store).unwrap();
        assert_eq!(stats.missing_images, 0);
        let px = |x: u32, y: u32| {
            let i = ((y * bw + x) * 4) as usize;
            (buf[i], buf[i + 1], buf[i + 2])
        };
        let (r, g, b) = px(35, 1);
        assert!(
            r > 200 && b < 60,
            "expected red at x=35, got {:?}",
            (r, g, b)
        );
        let (r2, g2, b2) = px(70, 1);
        assert!(
            b2 > 200 && r2 < 60,
            "expected blue at x=70, got {:?}",
            (r2, g2, b2)
        );
        let _ = (g, g2);
    }

    #[test]
    fn undersized_cached_decode_counts_as_missing_upgrade() {
        let (w, h) = (1024u32, 8u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[(x % 256) as u8, 0, 0, 255]);
            }
        }
        let enc = encoded_image(png_bytes(&rgba, w, h), w, h);
        let record_at = |scale: f64| {
            let mut rec = RecordingScene::for_replay();
            rec.set_viewport(W, H, 0, 0);
            let brush = ImageBrush {
                image: enc.clone(),
                sampler: image_sampler(),
            };
            rec.fill(
                Fill::NonZero,
                Affine::scale(scale),
                brush.as_ref(),
                None,
                &Rect::new(0.0, 0.0, w as f64, h as f64),
            );
            let images = rec.drain_rbi_images();
            (rec.finish_framed(), images)
        };

        let (framed_small, images_small) = record_at(0.25);
        let mut store = ResourceStore::default();
        let (hash, info) = &images_small[0];
        put_image_batch(&mut store, *hash, info);
        assert_eq!(store.images.get(hash).unwrap().width, 256);
        assert_eq!(u32_le(&missing_resources(&store, &framed_small)[0..4]), 0);

        let (framed_full, images_full) = record_at(1.0);
        assert_eq!(u32_le(&missing_resources(&store, &framed_full)[0..4]), 1);
        let (hash2, info2) = &images_full[0];
        assert_eq!(hash2, hash, "same content hash across frames");
        put_image_batch(&mut store, *hash2, info2);
        assert_eq!(store.images.get(hash).unwrap().width, 1024);
        assert_eq!(u32_le(&missing_resources(&store, &framed_full)[0..4]), 0);
    }

    #[test]
    fn undecodable_image_marks_broken_and_stops_the_miss_loop() {
        let bad_gif: Vec<u8> = vec![
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff,
            0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
            0x00,
        ];
        let enc = encoded_image(bad_gif, 1, 1);
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        let brush = ImageBrush {
            image: enc,
            sampler: image_sampler(),
        };
        rec.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            brush.as_ref(),
            None,
            &Rect::new(0.0, 0.0, 1.0, 1.0),
        );
        let images = rec.drain_rbi_images();
        let framed = rec.finish_framed();
        let (hash, info) = &images[0];

        let mut store = ResourceStore::default();
        assert_eq!(u32_le(&missing_resources(&store, &framed)[0..4]), 1);
        let prefix = if info.format == 2 { 17 } else { 9 };
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_IMAGE);
        batch.extend_from_slice(&hash.to_le_bytes());
        batch.extend_from_slice(&((info.wire_bytes.data().len() + prefix) as u32).to_le_bytes());
        batch.extend_from_slice(&info.width.to_le_bytes());
        batch.extend_from_slice(&info.height.to_le_bytes());
        batch.push(info.format);
        if info.format == 2 {
            batch.extend_from_slice(&info.needed_w.to_le_bytes());
            batch.extend_from_slice(&info.needed_h.to_le_bytes());
        }
        batch.extend_from_slice(info.wire_bytes.data());
        assert_eq!(store.put_batch(&batch), 0, "malformed gif must not decode");
        assert_eq!(
            u32_le(&missing_resources(&store, &framed)[0..4]),
            0,
            "broken image must drop off the missing list"
        );
    }

    #[test]
    fn decode_bomb_dims_rejected_before_decode() {
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&(ihdr.len() as u32).to_be_bytes());
        png.extend_from_slice(b"IHDR");
        let crc = {
            let mut h = crc32fast::Hasher::new();
            h.update(b"IHDR");
            h.update(&ihdr);
            h.finalize()
        };
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc.to_be_bytes());
        assert!(
            decode_image_payload(0, 0, 2, (16, 16), png.as_slice().into()).is_none(),
            "declared-dims bomb must bail before decode"
        );
        assert!(
            decode_image_payload(100_000, 100_000, 1, (0, 0), (&[0u8; 8][..]).into()).is_none()
        );
    }

    #[test]
    fn odd_dims_mip_decode_terminates_the_miss_loop() {
        let (w, h) = (330u32, 325u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 0, 255]);
            }
        }
        let enc = encoded_image(png_bytes(&rgba, w, h), w, h);
        let mut rec = RecordingScene::for_replay();
        rec.set_viewport(W, H, 0, 0);
        let brush = ImageBrush {
            image: enc.clone(),
            sampler: image_sampler(),
        };
        rec.fill(
            Fill::NonZero,
            Affine::scale(0.394),
            brush.as_ref(),
            None,
            &Rect::new(0.0, 0.0, w as f64, h as f64),
        );
        let images = rec.drain_rbi_images();
        let framed = rec.finish_framed();
        let mut store = ResourceStore::default();
        let (hash, info) = &images[0];
        put_image_batch(&mut store, *hash, info);
        let cached = store.images.get(hash).unwrap();
        assert_eq!((cached.width, cached.height), (165, 162));
        assert_eq!(
            u32_le(&missing_resources(&store, &framed)[0..4]),
            0,
            "cached decode satisfies the hint — loop terminates"
        );
    }

    #[test]
    fn asset_ref_resolves_by_path_when_hashes_differ() {
        let full = test_font();
        let stripped_hash_key = font_data_key(0xdead_beef_cafe_f00d, 0);
        let name = b"/fonts/noto-color-emoji.woff2";
        let mut store = ResourceStore::default();
        let mut batch = Vec::new();
        batch.extend_from_slice(&1u32.to_le_bytes());
        batch.push(RBI_RESOURCE_KIND_FONT_DATA);
        batch.extend_from_slice(&stripped_hash_key.to_le_bytes());
        batch.extend_from_slice(&((name.len() + 5) as u32).to_le_bytes());
        batch.push(FONT_DATA_REF_ASSET);
        batch.extend_from_slice(&0u32.to_le_bytes());
        batch.extend_from_slice(name);
        store.put_batch(&batch);
        assert_eq!(store.pending_assets.len(), 1);

        store.put_font_asset("/fonts/noto-color-emoji.woff2", full.data.data());
        assert!(store.pending_assets.is_empty());
        assert!(
            store.fonts.contains_key(&stripped_hash_key),
            "full font must register under the stripped-blob key"
        );
        let content_key =
            font_data_key(crate::paint::scene_record::fx_hash_u64(full.data.data()), 0);
        assert!(store.fonts.contains_key(&content_key));
        let mut store2 = ResourceStore::default();
        store2.put_batch(&batch);
        store2.put_font_asset("/fonts/other.woff2", full.data.data());
        assert!(!store2.fonts.contains_key(&stripped_hash_key));
    }

    #[test]
    fn resource_store_evicts_oldest_over_budget() {
        let mut store = ResourceStore::default();
        for i in 0..8u64 {
            store.insert_image(i, test_image(16));
        }
        store.evict_images_over(3 * 16 * 16 * 4);
        assert!(store.image_bytes_total <= 3 * 16 * 16 * 4);
        assert!(!store.images.contains_key(&0));
        assert!(store.images.contains_key(&7));
        let font = test_font();
        for i in 0..4u64 {
            store.insert_font(i, font.clone());
        }
        store.evict_fonts_over(font.data.data().len() * 2);
        assert!(store.font_bytes_total <= font.data.data().len() * 2);
        assert!(!store.fonts.contains_key(&0));
        assert!(store.fonts.contains_key(&3));
    }

    fn inline_scene(entries: &[(u64, u32, u32, &[u8])]) -> Vec<u8> {
        let (mut scene, _) = record_scene(None, None);
        let offset = (scene.len() as u32).to_le_bytes();
        scene[28..32].copy_from_slice(&offset);
        scene.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (hash, w, h, bytes) in entries {
            scene.extend_from_slice(&hash.to_le_bytes());
            scene.extend_from_slice(&w.to_le_bytes());
            scene.extend_from_slice(&h.to_le_bytes());
            scene.extend_from_slice(&[0, 1, 0, 0]);
            scene.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            scene.extend_from_slice(bytes);
        }
        scene
    }

    fn inline_totals(scene: &[u8]) -> (Vec<u64>, usize) {
        let header = crate::paint::scene_decode::parse_header(scene).unwrap();
        let mut res = crate::paint::scene_decode::parse_resources(scene, &header).unwrap();
        let store = ResourceStore::default();
        let ctx = ReplayContext::new(&store, &mut res);
        let mut keys: Vec<u64> = ctx.inline_images.keys().copied().collect();
        let images = &ctx.inline_images;
        let total: usize = images.values().map(|i| i.data.data().len()).sum();
        drop(ctx);
        keys.sort_unstable();
        let tty = crate::tty::grid::inline_images(scene);
        let mut tty_keys: Vec<u64> = tty.keys().copied().collect();
        tty_keys.sort_unstable();
        assert_eq!(keys, tty_keys);
        let tty_total: usize = tty.values().map(|i| i.rgba.data().len()).sum();
        assert_eq!(total, tty_total);
        (keys, total)
    }

    #[test]
    fn inline_images_share_one_bounded_decode() {
        let mut webp = Vec::new();
        let rgba = vec![255u8; 1024 * 1024 * 4];
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .encode(&rgba, 1024, 1024, image::ExtendedColorType::Rgba8)
            .unwrap();
        let entries: Vec<(u64, u32, u32, &[u8])> =
            (1..=13).map(|i| (i, 1024, 1024, webp.as_slice())).collect();
        let one = inline_scene(&entries[..1]);
        assert_eq!(inline_totals(&one), (vec![1], 1024 * 1024 * 4));
        let many = inline_scene(&entries);
        let expected = ((1..=12).collect(), 12 * 1024 * 1024 * 4);
        assert_eq!(inline_totals(&many), expected);
        let false_header = inline_scene(&[(1, 1024, 768, webp.as_slice())]);
        assert_eq!(inline_totals(&false_header), (vec![], 0));
    }

    fn assert_buffers_close(a: &[u8], b: &[u8], max_diff_frac: f64) {
        assert_eq!(a.len(), b.len());
        let mut diff = 0usize;
        let (a_pixels, _) = a.as_chunks::<4>();
        let (b_pixels, _) = b.as_chunks::<4>();
        for (pa, pb) in a_pixels.iter().zip(b_pixels) {
            let d = pa
                .iter()
                .zip(pb.iter())
                .map(|(x, y)| (*x as i32 - *y as i32).abs())
                .max()
                .unwrap_or(0);
            if d > 8 {
                diff += 1;
            }
        }
        let frac = diff as f64 / (a.len() / 4) as f64;
        assert!(
            frac <= max_diff_frac,
            "pixel diff fraction {} > {} ({} px)",
            frac,
            max_diff_frac,
            diff
        );
    }
}
