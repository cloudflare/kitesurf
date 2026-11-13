// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Encodes RGBA frames as PNG, JPEG, WebP, or raw bytes for screenshot and scene output.

use std::ops::Range;
#[cfg(feature = "blitz")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "blitz")]
use crate::resources::fonts::get_or_init_font_context;

const JPEG_444_QUALITY_THRESHOLD: u8 = 90;
const JPEG_420_MCU_EDGE_PIXELS: u32 = 16;
const JPEG_444_MCU_EDGE_PIXELS: u32 = 8;
const JPEG_MARKER_BYTES: usize = 2;
const RGBA_BYTES_PER_PIXEL: usize = 4;
const RGBA_SCAN_BLOCK_BYTES: usize = 64;

#[derive(Copy, Clone)]
pub(crate) enum ImageFormat {
    Png,
    Jpeg,
    Webp,
    Rgba,
}

impl ImageFormat {
    pub(crate) fn from_str(s: &str) -> ImageFormat {
        if s.eq_ignore_ascii_case("jpeg") || s.eq_ignore_ascii_case("jpg") {
            ImageFormat::Jpeg
        } else if s.eq_ignore_ascii_case("webp") {
            ImageFormat::Webp
        } else if s.eq_ignore_ascii_case("rgba") {
            ImageFormat::Rgba
        } else {
            ImageFormat::Png
        }
    }
}

#[cfg(feature = "blitz")]
pub(crate) fn paint_document_to_image(
    document: &mut blitz_dom::BaseDocument,
    width: u32,
    height: u32,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, String> {
    paint_document_to_image_scrolled(document, width, height, format, quality, (0, 0), false)
}

/// Paint a viewport-sized slice of a resolved document.
/// Scroll offsets are document-space CSS pixels; the painter translates the root
/// by their negatives. Use `set_viewport_scroll` because `paint_scene_bounded`
/// offsets move content the other way. Over-budget SVG layers are skipped, not errors.
#[cfg(feature = "blitz")]
pub(crate) fn paint_document_to_image_scrolled(
    document: &mut blitz_dom::BaseDocument,
    width: u32,
    height: u32,
    format: ImageFormat,
    quality: u8,
    scroll: (u32, u32),
    omit_background: bool,
) -> Result<Vec<u8>, String> {
    use anyrender::{ImageRenderer as _, PaintScene as _};
    use anyrender_vello_cpu::VelloCpuImageRenderer;
    use blitz_dom::util::Color;
    use blitz_paint::paint_scene_bounded;
    use peniko::kurbo::Rect;
    use peniko::Fill;

    let scale: f64 = 1.0;
    let render_w = width;
    let render_h = height;
    let (scroll_x, scroll_y) = scroll;

    document.set_viewport_scroll(blitz_dom::Point {
        x: scroll_x as f64,
        y: scroll_y as f64,
    });

    let effective_omit_bg =
        omit_background && matches!(format, ImageFormat::Png | ImageFormat::Webp);

    let buffer_size = (render_w as usize) * (render_h as usize) * 4;
    let mut buffer = vec![0u8; buffer_size];
    let mut renderer = VelloCpuImageRenderer::new(render_w, render_h);
    renderer.render(
        |scene| {
            if !effective_omit_bg {
                scene.fill(
                    Fill::NonZero,
                    Default::default(),
                    Color::WHITE,
                    Default::default(),
                    &Rect::new(0.0, 0.0, render_w as f64, render_h as f64),
                );
            }
            paint_scene_bounded(scene, document, scale, render_w, render_h, 0, 0);
        },
        &mut buffer,
    );

    match format {
        ImageFormat::Png => encode_png(&buffer, render_w, render_h),
        ImageFormat::Jpeg => encode_jpeg(&mut buffer, render_w, render_h, quality),
        ImageFormat::Webp => encode_webp(&buffer, render_w, render_h),
        ImageFormat::Rgba => encode_png(&buffer, render_w, render_h),
    }
}

#[cfg(feature = "blitz")]
#[wasm_bindgen]
/// Compatibility export for callers that only need PNG output.
pub fn ks_render_html_to_png(html: &str, base_url: &str, width: u32, height: u32) -> Vec<u8> {
    ks_render_html_to_image(html, base_url, width, height, "png", 80)
}

/// Render HTML to PNG, JPEG, or WebP; unknown formats and RGBA fall back to PNG.
/// Quality is clamped to 1 to 100 and applies only to JPEG. HTTP resources are
/// not fetched, so callers must inline their stylesheets and external images.
/// An unusable base URL uses `https://kitesurf.local/`; failures return empty bytes.
#[cfg(feature = "blitz")]
#[wasm_bindgen]
pub fn ks_render_html_to_image(
    html: &str,
    base_url: &str,
    width: u32,
    height: u32,
    format: &str,
    quality: u32,
) -> Vec<u8> {
    let fmt = ImageFormat::from_str(format);
    let q = quality.clamp(1, 100) as u8;
    try_render(html, base_url, width, height, fmt, q).unwrap_or_default()
}

#[cfg(feature = "blitz")]
fn try_render(
    html: &str,
    base_url: &str,
    width: u32,
    height: u32,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, String> {
    use blitz_dom::DocumentConfig;
    use blitz_traits::shell::{ColorScheme, Viewport};
    use std::sync::Arc;

    let scale: f32 = 1.0;

    let resolved_base = match url::Url::parse(base_url) {
        Ok(u) if !u.cannot_be_a_base() => base_url.to_string(),
        _ => "https://kitesurf.local/".to_string(),
    };

    let net_provider = Arc::new(crate::resources::net::KitesurfNetProvider::new());

    // The HTML comes from a page DOM whose scripts ran, so its <noscript> content is text
    // and must stay inert when it is parsed again here.
    let mut document = crate::parse_html_document(
        html,
        DocumentConfig {
            base_url: Some(resolved_base),
            net_provider: Some(net_provider),
            viewport: Some(Viewport::new(width, height, scale, ColorScheme::Light)),
            font_ctx: Some(get_or_init_font_context()),
            ..Default::default()
        },
        true,
    );

    document.as_mut().handle_messages();
    #[cfg(test)]
    let _cascade_guard = crate::STYLE_CASCADE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    document.as_mut().resolve(0.0);
    document.as_mut().handle_messages();
    document.as_mut().resolve(0.0);

    paint_document_to_image(document.as_mut(), width, height, format, quality)
}

pub(crate) fn encode_webp(buffer: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::codecs::webp::WebPEncoder;
    use image::ExtendedColorType;
    let mut out = Vec::new();
    let encoder = WebPEncoder::new_lossless(&mut out);
    encoder
        .encode(buffer, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| format!("webp encode: {}", e))?;
    Ok(out)
}

pub(crate) fn encode_png(buffer: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.set_filter(png::Filter::Paeth);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("png header: {}", e))?;
        writer
            .write_image_data(buffer)
            .map_err(|e| format!("png write: {}", e))?;
        writer.finish().map_err(|e| format!("png finish: {}", e))?;
    }
    Ok(out)
}

pub(crate) fn encode_jpeg(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    composite_rgba_over_white_in_place(buffer);
    encode_jpeg_rgba(buffer, width, height, quality)
}

pub(crate) fn encode_jpeg_retained(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    quality: u8,
    opaque: bool,
    scratch: &mut Vec<u8>,
) -> Result<Vec<u8>, String> {
    if opaque {
        scratch.clear();
        return encode_jpeg_rgba(buffer, width, height, quality);
    }
    let encoded = {
        let input = RetainedJpegInput::new(buffer, scratch);
        encode_jpeg_rgba(input.bytes(), width, height, quality)
    };
    scratch.clear();
    encoded
}

fn jpeg_sampling(quality: u8) -> (jpeg_encoder::SamplingFactor, u32) {
    if quality < JPEG_444_QUALITY_THRESHOLD {
        (
            jpeg_encoder::SamplingFactor::F_2_2,
            JPEG_420_MCU_EDGE_PIXELS,
        )
    } else {
        (
            jpeg_encoder::SamplingFactor::F_1_1,
            JPEG_444_MCU_EDGE_PIXELS,
        )
    }
}

fn encode_jpeg_rgba(
    buffer: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    use jpeg_encoder::{ColorType, Encoder};
    let (sampling, mcu) = jpeg_sampling(quality);
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, quality);
    encoder.set_sampling_factor(sampling);
    encoder.set_restart_interval(width.div_ceil(mcu) as u16);
    encoder
        .encode(buffer, width as u16, height as u16, ColorType::Rgba)
        .map_err(|e| format!("jpeg encode: {:?}", e))?;
    Ok(out)
}

pub(crate) struct JpegRowCache {
    width: u32,
    height: u32,
    quality: u8,
    jpeg: Vec<u8>,
    header_len: usize,
    rows: Vec<Range<usize>>,
    hashes: Vec<u64>,
}

impl JpegRowCache {
    pub(crate) fn encode(
        buffer: &mut [u8],
        width: u32,
        height: u32,
        quality: u8,
        opaque: bool,
        scratch: &mut Vec<u8>,
    ) -> Result<(Vec<u8>, Self), String> {
        let jpeg = encode_jpeg_retained(buffer, width, height, quality, opaque, scratch)?;
        let (header_len, rows) = split_jpeg_rows(&jpeg)?;
        if rows.len() != height.div_ceil(jpeg_sampling(quality).1) as usize {
            return Err(format!("jpeg row split: {} segments", rows.len()));
        }
        let cache = Self {
            width,
            height,
            quality,
            jpeg,
            header_len,
            rows,
            hashes: Vec::new(),
        };
        Ok((cache.jpeg.clone(), cache))
    }

    pub(crate) fn encode_reusing(
        buffer: &mut [u8],
        width: u32,
        height: u32,
        quality: u8,
        sources: &[JpegRowCache],
        opaque: bool,
        scratch: &mut Vec<u8>,
    ) -> Result<Option<(Vec<u8>, Self)>, String> {
        let hashes = row_hashes(buffer, width, quality);
        let sources: Vec<&Self> = sources
            .iter()
            .filter(|s| s.matches(width, height, quality) && s.hashes.len() == hashes.len())
            .collect();
        let found: Vec<Option<&[u8]>> = hashes
            .iter()
            .map(|h| {
                sources.iter().find_map(|s| {
                    let k = s.hashes.iter().position(|x| x == h)?;
                    Some(&s.jpeg[s.rows[k].clone()])
                })
            })
            .collect();
        let Some(header) = sources.first().map(|s| &s.jpeg[..s.header_len]) else {
            return Ok(None);
        };
        if found.iter().all(Option::is_none) {
            return Ok(None);
        }
        let mcu = jpeg_sampling(quality).1 as usize;
        let stride = width as usize * RGBA_BYTES_PER_PIXEL;
        let mut bands: Vec<(usize, Vec<u8>, Vec<Range<usize>>)> = Vec::new();
        let mut r = 0;
        while r < found.len() {
            if found[r].is_some() {
                r += 1;
                continue;
            }
            let r0 = r;
            while r < found.len() && found[r].is_none() {
                r += 1;
            }
            let (py0, py1) = (r0 * mcu, (r * mcu).min(height as usize));
            let band = encode_jpeg_retained(
                &mut buffer[py0 * stride..py1 * stride],
                width,
                (py1 - py0) as u32,
                quality,
                opaque,
                scratch,
            )?;
            let (_, ranges) = split_jpeg_rows(&band)?;
            if ranges.len() != r - r0 {
                return Err(format!("jpeg band split: {} segments", ranges.len()));
            }
            bands.push((r0, band, ranges));
        }
        let segments = found
            .iter()
            .enumerate()
            .map(|(i, seg)| {
                seg.or_else(|| {
                    let (r0, band, ranges) = bands.iter().rev().find(|(r0, ..)| *r0 <= i)?;
                    Some(&band[ranges[i - r0].clone()])
                })
                .ok_or_else(|| format!("jpeg reuse: row {i} has no segment"))
            })
            .collect::<Result<Vec<&[u8]>, String>>()?;
        let (jpeg, rows) = assemble_rows(header, segments.len(), |i| segments[i]);
        let cache = Self {
            width,
            height,
            quality,
            jpeg,
            header_len: header.len(),
            rows,
            hashes,
        };
        Ok(Some((cache.jpeg.clone(), cache)))
    }

    pub(crate) fn hash_rows(&mut self, buffer: &[u8]) {
        if self.hashes.is_empty() {
            self.hashes = row_hashes(buffer, self.width, self.quality);
        }
    }

    pub(crate) fn matches(&self, width: u32, height: u32, quality: u8) -> bool {
        self.width == width && self.height == height && self.quality == quality
    }

    pub(crate) fn encode_rows(
        &mut self,
        buffer: &mut [u8],
        y0: u32,
        y1: u32,
        opaque: bool,
        scratch: &mut Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        let mcu = jpeg_sampling(self.quality).1;
        let r0 = (y0 / mcu) as usize;
        let r1 = (y1.min(self.height).div_ceil(mcu) as usize).min(self.rows.len());
        if r0 >= r1 {
            return Ok(self.jpeg.clone());
        }
        let stride = self.width as usize * RGBA_BYTES_PER_PIXEL;
        let py0 = r0 * mcu as usize;
        let py1 = (r1 * mcu as usize).min(self.height as usize);
        let band = encode_jpeg_retained(
            &mut buffer[py0 * stride..py1 * stride],
            self.width,
            (py1 - py0) as u32,
            self.quality,
            opaque,
            scratch,
        )?;
        let (_, band_rows) = split_jpeg_rows(&band)?;
        if band_rows.len() != r1 - r0 {
            return Err(format!("jpeg band split: {} segments", band_rows.len()));
        }
        let segment = |i: usize| -> &[u8] {
            if (r0..r1).contains(&i) {
                &band[band_rows[i - r0].clone()]
            } else {
                &self.jpeg[self.rows[i].clone()]
            }
        };
        let (jpeg, rows) = assemble_rows(&self.jpeg[..self.header_len], self.rows.len(), segment);
        self.jpeg = jpeg;
        self.rows = rows;
        self.hashes.clear();
        Ok(self.jpeg.clone())
    }
}

fn assemble_rows<'a>(
    header: &[u8],
    n: usize,
    segment: impl Fn(usize) -> &'a [u8],
) -> (Vec<u8>, Vec<Range<usize>>) {
    let len = header.len()
        + (0..n)
            .map(|i| segment(i).len() + JPEG_MARKER_BYTES)
            .sum::<usize>()
        + JPEG_MARKER_BYTES;
    let mut out = Vec::with_capacity(len);
    let mut rows = Vec::with_capacity(n);
    out.extend_from_slice(header);
    for i in 0..n {
        if i > 0 {
            out.extend_from_slice(&[0xFF, 0xD0 + ((i - 1) % 8) as u8]);
        }
        let start = out.len();
        out.extend_from_slice(segment(i));
        rows.push(start..out.len());
    }
    out.extend_from_slice(&[0xFF, 0xD9]);
    (out, rows)
}

fn row_hashes(buffer: &[u8], width: u32, quality: u8) -> Vec<u64> {
    use std::hash::BuildHasher;
    let row_bytes = width as usize * RGBA_BYTES_PER_PIXEL * jpeg_sampling(quality).1 as usize;
    let state = foldhash::fast::FixedState::default();
    buffer
        .chunks(row_bytes)
        .map(|row| state.hash_one(row))
        .collect()
}

fn split_jpeg_rows(bytes: &[u8]) -> Result<(usize, Vec<Range<usize>>), String> {
    let err = || "jpeg row split: malformed stream".to_string();
    let mut pos = 2;
    let header_end = loop {
        let segment = bytes.get(pos..pos + 4).ok_or_else(err)?;
        if segment[0] != 0xFF {
            return Err(err());
        }
        let end = pos + 2 + u16::from_be_bytes([segment[2], segment[3]]) as usize;
        if segment[1] == 0xDA {
            break end;
        }
        pos = end;
    };
    let mut rows = Vec::new();
    let mut start = header_end;
    let mut i = header_end;
    while let Some(off) = bytes
        .get(i..)
        .and_then(|s| s.iter().position(|&b| b == 0xFF))
    {
        i += off;
        let next = *bytes.get(i + 1).ok_or_else(err)?;
        if (0xD0..=0xD7).contains(&next) || next == 0xD9 {
            rows.push(start..i);
            if next == 0xD9 {
                return Ok((header_end, rows));
            }
            start = i + 2;
        }
        i += 2;
    }
    Err(err())
}

const JPEG_ALPHA_BACKUP_RECORD_BYTES: usize = 7;

struct RetainedJpegInput<'a> {
    buffer: &'a mut [u8],
    scratch: &'a mut Vec<u8>,
    sparse: bool,
}

impl<'a> RetainedJpegInput<'a> {
    fn new(buffer: &'a mut [u8], scratch: &'a mut Vec<u8>) -> Self {
        scratch.clear();
        let mut input = Self {
            buffer,
            scratch,
            sparse: true,
        };
        input.sparse = composite_rgba_over_white_sparse(input.buffer, input.scratch);
        if !input.sparse {
            input.scratch.extend_from_slice(input.buffer);
            composite_rgba_over_white_in_place(input.scratch);
        }
        input
    }

    fn bytes(&self) -> &[u8] {
        if self.sparse {
            self.buffer
        } else {
            self.scratch
        }
    }
}

impl Drop for RetainedJpegInput<'_> {
    fn drop(&mut self) {
        if self.sparse {
            restore_alpha_backup(self.buffer, self.scratch);
        }
    }
}

fn composite_rgba_over_white_sparse(buffer: &mut [u8], backup: &mut Vec<u8>) -> bool {
    let buffer_len = buffer.len();
    if buffer_len > u32::MAX as usize {
        return false;
    }

    let mut sparse = true;
    let mut processed = 0;
    let (blocks, remainder) = buffer.as_chunks_mut::<RGBA_SCAN_BLOCK_BYTES>();
    for block in blocks {
        if rgba_block_all_opaque(block) {
            processed += RGBA_SCAN_BLOCK_BYTES;
            continue;
        }
        for (pixel, px) in block
            .as_chunks_mut::<RGBA_BYTES_PER_PIXEL>()
            .0
            .iter_mut()
            .enumerate()
        {
            if px[3] == 255 {
                continue;
            }
            if backup.len().saturating_add(JPEG_ALPHA_BACKUP_RECORD_BYTES) > buffer_len {
                sparse = false;
                break;
            }
            let byte_offset = processed + pixel * RGBA_BYTES_PER_PIXEL;
            backup.extend_from_slice(&(byte_offset as u32).to_le_bytes());
            backup.extend_from_slice(&px[..3]);
            composite_rgba_pixel_over_white(px);
        }
        if !sparse {
            break;
        }
        processed += RGBA_SCAN_BLOCK_BYTES;
    }
    if sparse {
        for (pixel, px) in remainder
            .as_chunks_mut::<RGBA_BYTES_PER_PIXEL>()
            .0
            .iter_mut()
            .enumerate()
        {
            if px[3] == 255 {
                continue;
            }
            if backup.len().saturating_add(JPEG_ALPHA_BACKUP_RECORD_BYTES) > buffer_len {
                sparse = false;
                break;
            }
            let byte_offset = processed + pixel * RGBA_BYTES_PER_PIXEL;
            backup.extend_from_slice(&(byte_offset as u32).to_le_bytes());
            backup.extend_from_slice(&px[..3]);
            composite_rgba_pixel_over_white(px);
        }
    }

    if !sparse {
        restore_alpha_backup(buffer, backup);
        backup.clear();
    }
    sparse
}

#[inline(always)]
fn rgba_block_all_opaque(block: &[u8]) -> bool {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;

        for pixels in block.as_chunks::<16>().0 {
            // SAFETY: each SIMD load reads one complete 16-byte RGBA group.
            let rgba = unsafe { v128_load(pixels.as_ptr() as *const v128) };
            let alpha = u32x4_shr(rgba, 24);
            if !u32x4_all_true(u32x4_eq(alpha, u32x4_splat(255))) {
                return false;
            }
        }
        true
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        let alphas: u32 = (block[3] as u32)
            & (block[7] as u32)
            & (block[11] as u32)
            & (block[15] as u32)
            & (block[19] as u32)
            & (block[23] as u32)
            & (block[27] as u32)
            & (block[31] as u32)
            & (block[35] as u32)
            & (block[39] as u32)
            & (block[43] as u32)
            & (block[47] as u32)
            & (block[51] as u32)
            & (block[55] as u32)
            & (block[59] as u32)
            & (block[63] as u32);
        alphas == 255
    }
}

fn restore_alpha_backup(buffer: &mut [u8], backup: &[u8]) {
    for record in backup.as_chunks::<JPEG_ALPHA_BACKUP_RECORD_BYTES>().0 {
        let offset = u32::from_le_bytes([record[0], record[1], record[2], record[3]]) as usize;
        if let Some(end) = offset.checked_add(3) {
            if let Some(pixel) = buffer.get_mut(offset..end) {
                pixel.copy_from_slice(&record[4..7]);
            }
        }
    }
}

fn composite_rgba_over_white_in_place(buffer: &mut [u8]) {
    let (blocks, remainder) = buffer.as_chunks_mut::<RGBA_SCAN_BLOCK_BYTES>();
    for block in blocks {
        if rgba_block_all_opaque(block) {
            continue;
        }
        for px in block.as_chunks_mut::<RGBA_BYTES_PER_PIXEL>().0.iter_mut() {
            composite_rgba_pixel_over_white(px);
        }
    }
    for px in remainder
        .as_chunks_mut::<RGBA_BYTES_PER_PIXEL>()
        .0
        .iter_mut()
    {
        composite_rgba_pixel_over_white(px);
    }
}

#[inline(always)]
fn composite_rgba_pixel_over_white(px: &mut [u8]) {
    let a = px[3] as u32;
    if a == 255 {
        return;
    }
    let inv = 255 - a;
    let bias = 127u32;
    let r = px[0] as u32;
    let g = px[1] as u32;
    let b = px[2] as u32;
    px[0] = ((r * a + 255 * inv + bias) / 255) as u8;
    px[1] = ((g * a + 255 * inv + bias) / 255) as u8;
    px[2] = ((b * a + 255 * inv + bias) / 255) as u8;
}

#[cfg(test)]
mod tests {
    use super::{encode_jpeg, encode_jpeg_retained, encode_jpeg_rgba, JpegRowCache, RetainedJpegInput};

    #[test]
    fn row_cache_splice_matches_full_encode() {
        const WIDTH: u32 = 203;
        const HEIGHT: u32 = 75;
        let mut seed = 0x2545_f491_u32;
        let mut frame: Vec<u8> = (0..WIDTH * HEIGHT * 4)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if i % 4 == 3 {
                    255
                } else {
                    (seed >> 24) as u8
                }
            })
            .collect();
        for quality in [80, 95] {
            let mut scratch = Vec::new();
            let (_, mut cache) =
                JpegRowCache::encode(&mut frame, WIDTH, HEIGHT, quality, false, &mut scratch)
                    .unwrap();
            for (y0, y1) in [(0, 1), (17, 40), (70, HEIGHT), (0, HEIGHT), (30, 30)] {
                for y in y0..y1 {
                    let row = (y * WIDTH * 4) as usize;
                    for px in frame[row + 40..row + 160].as_chunks_mut::<4>().0.iter_mut() {
                        px[0] = px[0].wrapping_add(97);
                        px[2] = px[2].wrapping_sub(31);
                    }
                }
                let spliced = cache
                    .encode_rows(&mut frame, y0, y1, false, &mut scratch)
                    .unwrap();
                let full = encode_jpeg_retained(
                    &mut frame.clone(),
                    WIDTH,
                    HEIGHT,
                    quality,
                    false,
                    &mut scratch,
                )
                .unwrap();
                assert!(
                    spliced == full,
                    "q{quality} rows {y0}..{y1}: splice differs from full encode"
                );
            }
        }
    }

    #[test]
    fn retained_jpeg_matches_composited_output_and_restores_sparse_alpha() {
        const WIDTH: u32 = 64;
        const HEIGHT: u32 = 48;
        let mut original = vec![255; (WIDTH * HEIGHT * 4) as usize];
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let offset = ((y * WIDTH + x) * 4) as usize;
                original[offset] = (x * 3) as u8;
                original[offset + 1] = (y * 5) as u8;
                original[offset + 2] = (x + y) as u8;
            }
        }
        original[3] = 0;
        original[7] = 128;

        let mut composited = original.clone();
        let expected = encode_jpeg(&mut composited, WIDTH, HEIGHT, 80).unwrap();
        let mut retained = original.clone();
        let mut scratch = Vec::new();
        let input = RetainedJpegInput::new(&mut retained, &mut scratch);
        assert!(input.sparse, "fixture exercises sparse alpha staging");
        assert!(
            !input.scratch.is_empty() && input.scratch.len() < original.len(),
            "sparse alpha stages only the changed pixels"
        );
        let actual = encode_jpeg_rgba(input.bytes(), WIDTH, HEIGHT, 80).unwrap();
        drop(input);

        assert_eq!(actual, expected, "sparse alpha keeps JPEG output unchanged");
        assert_eq!(retained, original, "retained RGBA pixels are restored");
    }
}
