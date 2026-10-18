// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Borrows a Krilla `Surface` and its active `Page` for one `paint_scene` call.
//! The Wasm path is single-threaded and has no `Send` or `Sync` contract.
//! `layer_pops` tracks pushes made for each anyrender layer so `pop_layer`
//! unwinds the matching Krilla states.

use std::collections::HashMap;
use std::sync::Arc;

use anyrender::{Glyph as AnyGlyph, NormalizedCoord, PaintRef, RenderContext};
use kurbo::{Affine, PathEl, Rect, Shape, Stroke};
use peniko::{BlendMode, Color, Compose, Fill as PenikoFill, Mix, StyleRef};

use krilla::blend::BlendMode as KrillaBlendMode;
use krilla::color::rgb;
use krilla::geom::{
    Path as KrillaPath, PathBuilder, Point as KrillaPoint, Transform as KrillaTransform,
};
use krilla::image::Image as KrillaImage;
use krilla::num::NormalizedF32;
use krilla::paint::{
    Fill as KrillaFill, FillRule as KrillaFillRule, LineCap as KrillaLineCap,
    LineJoin as KrillaLineJoin, Stroke as KrillaStroke,
};
use krilla::surface::Surface;
use krilla::text::{Font as KrillaFont, GlyphId as KrillaGlyphId, KrillaGlyph, Tag as KrillaTag};

use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

const NORMALIZED_COORD_SCALE: f32 = 16_384.0;
const RGBA_ALPHA_MAX: f32 = 255.0;

pub struct KrillaPaintScene<'a, 'b> {
    surface: &'a mut Surface<'b>,
    font_cache: HashMap<FontKey, CachedFont>,
    layer_pops: Vec<u32>,
}

impl<'a, 'b> KrillaPaintScene<'a, 'b> {
    pub fn new(surface: &'a mut Surface<'b>) -> Self {
        Self {
            surface,
            font_cache: HashMap::new(),
            layer_pops: Vec::with_capacity(16),
        }
    }

    /// Push a layer clip and return the Krilla pop count.
    /// Empty paths are skipped because clipping to one erases the layer content.
    /// The transform positions the clip; primitives carry their world transforms.
    fn push_clip(&mut self, fill: PenikoFill, transform: Affine, clip: &impl Shape) -> u32 {
        match shape_to_krilla_path_transformed(clip, transform) {
            Some(path) => {
                self.surface
                    .push_clip_path(&path, &peniko_fill_to_krilla(fill));
                1
            }
            None => 0,
        }
    }
}

struct CachedFont {
    font: KrillaFont,
    gid_to_char: HashMap<u32, char>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct FontKey {
    blob_ptr: usize,
    coord_bytes: Vec<u8>,
}

impl FontKey {
    fn new(blob_ptr: usize, coords: &[NormalizedCoord]) -> Self {
        let mut coord_bytes = Vec::with_capacity(coords.len() * 2);
        for c in coords {
            coord_bytes.extend_from_slice(&c.to_le_bytes());
        }
        Self {
            blob_ptr,
            coord_bytes,
        }
    }
}

impl RenderContext for KrillaPaintScene<'_, '_> {}

impl anyrender::PaintScene for KrillaPaintScene<'_, '_> {
    fn reset(&mut self) {}

    fn push_layer(
        &mut self,
        fill: PenikoFill,
        blend: impl Into<BlendMode>,
        alpha: f32,
        _transform: Affine,
        clip: &impl Shape,
        _filter: Option<Arc<anyrender::Filter>>,
        _backdrop_filter: Option<Arc<anyrender::Filter>>,
    ) {
        let mut pops: u32 = 0;
        let bm: BlendMode = blend.into();
        if let Some(km) = peniko_blend_to_krilla(bm) {
            self.surface.push_blend_mode(km);
            pops += 1;
        }
        if alpha < 1.0 {
            if let Some(n) = NormalizedF32::new(alpha.clamp(0.0, 1.0)) {
                self.surface.push_opacity(n);
                pops += 1;
            }
        }
        pops += self.push_clip(fill, _transform, clip);
        self.layer_pops.push(pops);
    }

    fn push_clip_layer(&mut self, fill: PenikoFill, transform: Affine, clip: &impl Shape) {
        // Blitz supplies the padding-box clip for replaced content; dropping it
        // makes rounded `<img>` boxes square in PDFs while raster keeps the corners.
        let pops = self.push_clip(fill, transform, clip);
        self.layer_pops.push(pops);
    }

    fn pop_layer(&mut self) {
        let n = self.layer_pops.pop().unwrap_or(0);
        for _ in 0..n {
            self.surface.pop();
        }
    }

    fn stroke<'p>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'p>>,
        _brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint_ref: PaintRef<'p> = brush.into();
        let color = paint_ref_to_solid_color(&paint_ref);

        let pushed_transform = if !affine_is_identity(transform) {
            self.surface.push_transform(&affine_to_krilla(transform));
            true
        } else {
            false
        };

        let krilla_stroke = KrillaStroke {
            paint: rgb::Color::new(color.r, color.g, color.b).into(),
            width: style.width as f32,
            miter_limit: style.miter_limit as f32,
            line_cap: kurbo_cap_to_krilla(style.start_cap),
            line_join: kurbo_join_to_krilla(style.join),
            opacity: NormalizedF32::new(color.a as f32 / RGBA_ALPHA_MAX)
                .unwrap_or(NormalizedF32::ONE),
            dash: None,
        };
        self.surface.set_stroke(Some(krilla_stroke));

        if let Some(path) = shape_to_krilla_path(shape) {
            self.surface.draw_path(&path);
        }
        self.surface.set_stroke(None);

        if pushed_transform {
            self.surface.pop();
        }
    }

    fn fill<'p>(
        &mut self,
        style: PenikoFill,
        transform: Affine,
        brush: impl Into<PaintRef<'p>>,
        _brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint_ref: PaintRef<'p> = brush.into();

        let pushed_transform = if !affine_is_identity(transform) {
            self.surface.push_transform(&affine_to_krilla(transform));
            true
        } else {
            false
        };

        if let anyrender::Paint::Image(img_ref) = &paint_ref {
            if let Some(img) = image_brush_to_krilla(img_ref) {
                let bounds = shape.bounding_box();
                let img_w = bounds.width() as f32;
                let img_h = bounds.height() as f32;
                let tx = bounds.x0 as f32;
                let ty = bounds.y0 as f32;
                if img_w > 0.0 && img_h > 0.0 {
                    self.surface
                        .push_transform(&KrillaTransform::from_translate(tx, ty));
                    let size = krilla::geom::Size::from_wh(img_w, img_h)
                        .unwrap_or(krilla::geom::Size::from_wh(1.0, 1.0).unwrap());
                    self.surface.draw_image(img, size);
                    self.surface.pop();
                }
                if pushed_transform {
                    self.surface.pop();
                }
                return;
            }
        }

        let color = paint_ref_to_solid_color(&paint_ref);
        let fill = KrillaFill {
            paint: rgb::Color::new(color.r, color.g, color.b).into(),
            opacity: NormalizedF32::new(color.a as f32 / RGBA_ALPHA_MAX)
                .unwrap_or(NormalizedF32::ONE),
            rule: peniko_fill_to_krilla(style),
        };
        self.surface.set_fill(Some(fill));

        if let Some(path) = shape_to_krilla_path(shape) {
            self.surface.draw_path(&path);
        }
        self.surface.set_fill(None);

        if pushed_transform {
            self.surface.pop();
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
        let (krilla_font, gid_to_char) =
            match get_or_register_font(&mut self.font_cache, font, normalized_coords) {
                Some(c) => (c.font.clone(), c.gid_to_char.clone()),
                None => return,
            };

        let paint_ref: PaintRef<'p> = brush.into();
        let mut color = paint_ref_to_solid_color(&paint_ref);
        color.a = ((color.a as f32) * brush_alpha.clamp(0.0, 1.0)).round() as u8;

        let collected: Vec<AnyGlyph> = glyphs.collect();
        if collected.is_empty() {
            return;
        }

        let combined = if let Some(gt) = glyph_transform {
            transform * gt
        } else {
            transform
        };
        let pushed_transform = if !affine_is_identity(combined) {
            self.surface.push_transform(&affine_to_krilla(combined));
            true
        } else {
            false
        };

        let fill = KrillaFill {
            paint: rgb::Color::new(color.r, color.g, color.b).into(),
            opacity: NormalizedF32::new(color.a as f32 / 255.0).unwrap_or(NormalizedF32::ONE),
            rule: KrillaFillRule::NonZero,
        };
        self.surface.set_fill(Some(fill));

        let start = KrillaPoint::from_xy(collected[0].x, collected[0].y);
        let n = collected.len();
        let mut krilla_glyphs: Vec<KrillaGlyph> = Vec::with_capacity(n);

        let mut text_buf = String::with_capacity(n);

        for i in 0..n {
            let g = &collected[i];
            let (next_dx, next_dy) = if i + 1 < n {
                let nx = collected[i + 1].x - g.x;
                let ny = collected[i + 1].y - g.y;
                (nx, ny)
            } else {
                (0.0, 0.0)
            };
            let text_range = if let Some(ch) = gid_to_char.get(&g.id) {
                let start = text_buf.len();
                text_buf.push(*ch);
                start..text_buf.len()
            } else {
                let cursor = text_buf.len();
                cursor..cursor
            };

            krilla_glyphs.push(KrillaGlyph::new(
                KrillaGlyphId::new(g.id),
                next_dx / font_size,
                0.0,
                0.0,
                next_dy / font_size,
                text_range,
                None,
            ));
        }

        self.surface.draw_glyphs(
            start,
            &krilla_glyphs,
            krilla_font,
            &text_buf,
            font_size,
            false,
        );

        self.surface.set_fill(None);

        if pushed_transform {
            self.surface.pop();
        }
    }

    fn draw_box_shadow(
        &mut self,
        _transform: Affine,
        _rect: Rect,
        _brush: Color,
        _radius: f64,
        _std_dev: f64,
    ) {
    }
}

fn affine_is_identity(a: Affine) -> bool {
    let c = a.as_coeffs();
    c[0] == 1.0 && c[1] == 0.0 && c[2] == 0.0 && c[3] == 1.0 && c[4] == 0.0 && c[5] == 0.0
}

fn affine_to_krilla(a: Affine) -> KrillaTransform {
    let c = a.as_coeffs();
    KrillaTransform::from_row(
        c[0] as f32,
        c[1] as f32,
        c[2] as f32,
        c[3] as f32,
        c[4] as f32,
        c[5] as f32,
    )
}

fn peniko_fill_to_krilla(f: PenikoFill) -> KrillaFillRule {
    match f {
        PenikoFill::NonZero => KrillaFillRule::NonZero,
        PenikoFill::EvenOdd => KrillaFillRule::EvenOdd,
    }
}

fn kurbo_cap_to_krilla(c: kurbo::Cap) -> KrillaLineCap {
    match c {
        kurbo::Cap::Butt => KrillaLineCap::Butt,
        kurbo::Cap::Round => KrillaLineCap::Round,
        kurbo::Cap::Square => KrillaLineCap::Square,
    }
}

fn kurbo_join_to_krilla(j: kurbo::Join) -> KrillaLineJoin {
    match j {
        kurbo::Join::Miter => KrillaLineJoin::Miter,
        kurbo::Join::Round => KrillaLineJoin::Round,
        kurbo::Join::Bevel => KrillaLineJoin::Bevel,
    }
}

fn peniko_blend_to_krilla(bm: BlendMode) -> Option<KrillaBlendMode> {
    if matches!(bm.compose, Compose::SrcOver) {
        match bm.mix {
            Mix::Normal => None,
            Mix::Multiply => Some(KrillaBlendMode::Multiply),
            Mix::Screen => Some(KrillaBlendMode::Screen),
            Mix::Overlay => Some(KrillaBlendMode::Overlay),
            Mix::Darken => Some(KrillaBlendMode::Darken),
            Mix::Lighten => Some(KrillaBlendMode::Lighten),
            Mix::ColorDodge => Some(KrillaBlendMode::ColorDodge),
            Mix::ColorBurn => Some(KrillaBlendMode::ColorBurn),
            Mix::HardLight => Some(KrillaBlendMode::HardLight),
            Mix::SoftLight => Some(KrillaBlendMode::SoftLight),
            Mix::Difference => Some(KrillaBlendMode::Difference),
            Mix::Exclusion => Some(KrillaBlendMode::Exclusion),
            Mix::Hue => Some(KrillaBlendMode::Hue),
            Mix::Saturation => Some(KrillaBlendMode::Saturation),
            Mix::Color => Some(KrillaBlendMode::Color),
            Mix::Luminosity => Some(KrillaBlendMode::Luminosity),
        }
    } else {
        None
    }
}

fn shape_to_krilla_path(shape: &impl Shape) -> Option<KrillaPath> {
    shape_to_krilla_path_transformed(shape, Affine::IDENTITY)
}

fn shape_to_krilla_path_transformed(shape: &impl Shape, transform: Affine) -> Option<KrillaPath> {
    let mut pb = PathBuilder::new();
    let mut had_move = false;
    for el in shape.path_elements(0.1) {
        match transform * el {
            PathEl::MoveTo(p) => {
                pb.move_to(p.x as f32, p.y as f32);
                had_move = true;
            }
            PathEl::LineTo(p) => {
                pb.line_to(p.x as f32, p.y as f32);
            }
            PathEl::QuadTo(c, p) => {
                pb.quad_to(c.x as f32, c.y as f32, p.x as f32, p.y as f32);
            }
            PathEl::CurveTo(c1, c2, p) => {
                pb.cubic_to(
                    c1.x as f32,
                    c1.y as f32,
                    c2.x as f32,
                    c2.y as f32,
                    p.x as f32,
                    p.y as f32,
                );
            }
            PathEl::ClosePath => {
                pb.close();
            }
        }
    }
    if !had_move {
        return None;
    }
    pb.finish()
}

fn paint_ref_to_solid_color(p: &PaintRef<'_>) -> peniko::color::Rgba8 {
    match p {
        anyrender::Paint::Solid(c) => c.to_rgba8(),
        _ => Color::TRANSPARENT.to_rgba8(),
    }
}

fn image_brush_to_krilla(brush: &peniko::ImageBrushRef<'_>) -> Option<KrillaImage> {
    use peniko::ImageFormat;
    let img = brush.image;
    if img.width == 0 || img.height == 0 {
        return None;
    }
    let bytes = img.data.data();
    match img.format {
        ImageFormat::Rgba8 => Some(KrillaImage::from_rgba8(
            bytes.to_vec(),
            img.width,
            img.height,
        )),
        _ => None,
    }
}

fn get_or_register_font<'c>(
    cache: &'c mut HashMap<FontKey, CachedFont>,
    font_data: &peniko::FontData,
    normalized_coords: &[NormalizedCoord],
) -> Option<&'c CachedFont> {
    let bytes_slice = font_data.data.data();
    let key = FontKey::new(bytes_slice.as_ptr() as usize, normalized_coords);
    if !cache.contains_key(&key) {
        let owned: Vec<u8> = bytes_slice.to_vec();

        let mut gid_to_char: HashMap<u32, char> = HashMap::new();
        let font_ref_res = FontRef::from_index(&owned, font_data.index);
        if let Ok(ref font_ref) = font_ref_res {
            let cmap = font_ref.charmap();
            for (codepoint, gid) in cmap.mappings() {
                if let Some(ch) = char::from_u32(codepoint) {
                    gid_to_char.entry(gid.to_u32()).or_insert(ch);
                }
            }
        }

        let has_variation = normalized_coords.iter().any(|c| *c != 0);
        let kfont = if has_variation {
            let design_coords = font_ref_res
                .as_ref()
                .ok()
                .and_then(|fr| normalized_to_design_coords(fr, normalized_coords))
                .unwrap_or_default();
            if design_coords.is_empty() {
                KrillaFont::new(owned.into(), font_data.index)?
            } else {
                KrillaFont::new_variable(owned.into(), font_data.index, &design_coords)?
            }
        } else {
            KrillaFont::new(owned.into(), font_data.index)?
        };
        cache.insert(
            key.clone(),
            CachedFont {
                font: kfont,
                gid_to_char,
            },
        );
    }
    cache.get(&key)
}

fn normalized_to_design_coords(
    font_ref: &FontRef<'_>,
    normalized_coords: &[NormalizedCoord],
) -> Option<Vec<(KrillaTag, f32)>> {
    let fvar = font_ref.fvar().ok()?;
    let axes = fvar.axes().ok()?;
    if axes.len() != normalized_coords.len() {
        return None;
    }
    let mut out: Vec<(KrillaTag, f32)> = Vec::with_capacity(axes.len());
    for (axis, ncoord) in axes.iter().zip(normalized_coords.iter()) {
        let normalized = (*ncoord as f32 / NORMALIZED_COORD_SCALE).clamp(-1.0, 1.0);
        let min = axis.min_value().to_f64() as f32;
        let def = axis.default_value().to_f64() as f32;
        let max = axis.max_value().to_f64() as f32;
        let design = if normalized >= 0.0 {
            def + normalized * (max - def)
        } else {
            def + normalized * (def - min)
        };
        let tag_bytes: [u8; 4] = axis.axis_tag().to_be_bytes();
        out.push((KrillaTag::new(&tag_bytes), design));
    }
    Some(out)
}

pub(crate) fn push_px_to_pt_scale(surface: &mut Surface<'_>) {
    const PX_TO_PT: f32 = 72.0 / 96.0;
    let t = KrillaTransform::from_row(PX_TO_PT, 0.0, 0.0, PX_TO_PT, 0.0, 0.0);
    surface.push_transform(&t);
}

pub(crate) fn push_page_clip(surface: &mut Surface<'_>, width: f32, stripe_height: f32) {
    let mut pb = PathBuilder::new();
    pb.move_to(0.0, 0.0);
    pb.line_to(width, 0.0);
    pb.line_to(width, stripe_height);
    pb.line_to(0.0, stripe_height);
    pb.close();
    if let Some(path) = pb.finish() {
        surface.push_clip_path(&path, &KrillaFillRule::NonZero);
    }
}

pub(crate) fn content_box(
    paper_width: u32,
    paper_height: u32,
    margin_top: u32,
    margin_right: u32,
    margin_bottom: u32,
    margin_left: u32,
) -> (u32, u32, u32, u32) {
    let ml = margin_left.min(paper_width.saturating_sub(1));
    let mr = margin_right.min(paper_width.saturating_sub(ml).saturating_sub(1));
    let mt = margin_top.min(paper_height.saturating_sub(1));
    let mb = margin_bottom.min(paper_height.saturating_sub(mt).saturating_sub(1));
    let width = paper_width.saturating_sub(ml).saturating_sub(mr).max(1);
    let height = paper_height.saturating_sub(mt).saturating_sub(mb).max(1);
    (ml, mt, width, height)
}

pub(crate) fn paint_white_background(
    surface: &mut krilla::surface::Surface<'_>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use krilla::color::rgb;
    use krilla::geom::Rect as KRect;
    use krilla::num::NormalizedF32;
    use krilla::paint::{Fill as KFill, FillRule as KFillRule};

    let white = KFill {
        paint: rgb::Color::new(255, 255, 255).into(),
        opacity: NormalizedF32::ONE,
        rule: KFillRule::NonZero,
    };
    surface.set_fill(Some(white));
    if let Some(rect) = KRect::from_xywh(0.0, 0.0, width as f32, height as f32) {
        let mut pb = krilla::geom::PathBuilder::new();
        pb.move_to(rect.left(), rect.top());
        pb.line_to(rect.right(), rect.top());
        pb.line_to(rect.right(), rect.bottom());
        pb.line_to(rect.left(), rect.bottom());
        pb.close();
        if let Some(path) = pb.finish() {
            surface.draw_path(&path);
        }
    }
    surface.set_fill(None);
    Ok(())
}
