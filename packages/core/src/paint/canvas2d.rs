// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Applies serialized Canvas 2D operations to per-canvas raster surfaces.

use std::borrow::Cow;
use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, TAU};
use std::sync::{Arc, LazyLock};

use kurbo::{Affine, Arc as KurboArc, BezPath, Cap, Join, PathEl, Point, Rect, Shape, Stroke, Vec2};
use peniko::color::{parse_color, AlphaColor, PremulRgba8, Srgb};
use peniko::Blob;
use peniko::{
    BlendMode, ColorStop, ColorStops, Compose, Extend, Fill, Gradient, ImageAlphaType, ImageBrush,
    ImageQuality, ImageSampler, Mix,
};
use peniko::{GradientKind, LinearGradientPosition, RadialGradientPosition, SweepGradientPosition};
use serde::Deserialize;
use vello_cpu::{ImageSource, PaintType, PixelMetadata, Pixmap, RenderContext, Resources};

use crate::paint::screenshot::encode_png;

pub const MAX_CANVAS_DIM: u32 = 4096;

const FLATTEN_OP_BUDGET: u32 = 50_000;

pub struct ResolvedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Blob<u8>,
}

#[derive(Deserialize)]
struct RawOp {
    o: String,
    #[serde(default)]
    a: Vec<f64>,
    #[serde(default)]
    s: Option<String>,
    #[serde(default)]
    g: Option<StyleSpec>,
    #[serde(default)]
    id: Option<u32>,
    #[serde(default)]
    oc: Option<bool>,
}

#[derive(Deserialize)]
struct StyleSpec {
    k: String,
    #[serde(default)]
    c: Option<String>,
    #[serde(default)]
    v: Vec<f64>,
    #[serde(default)]
    stops: Vec<(f64, String)>,
    #[serde(default)]
    id: Option<u32>,
    #[serde(default)]
    rep: Option<String>,
    #[serde(default)]
    oc: Option<bool>,
}

#[derive(Clone)]
enum StyleData {
    Solid(AlphaColor<Srgb>),
    Gradient(Gradient),
    Pattern {
        pixmap: Arc<Pixmap>,
        x_extend: Extend,
        y_extend: Extend,
    },
}

#[derive(Clone)]
struct FontSpec {
    size_px: f32,
    families: String,
    weight: f32,
    italic: bool,
}

impl Default for FontSpec {
    fn default() -> Self {
        FontSpec {
            size_px: 10.0,
            families: "sans-serif".to_string(),
            weight: 400.0,
            italic: false,
        }
    }
}

#[derive(Clone)]
struct CanvasState {
    fill_style: StyleData,
    stroke_style: StyleData,
    global_alpha: f32,
    blend: BlendMode,
    stroke: Stroke,
    transform: Affine,
    font: FontSpec,
    text_align: String,
    text_baseline: String,
    smoothing: bool,
    clip_len: usize,
}

impl Default for CanvasState {
    fn default() -> Self {
        CanvasState {
            fill_style: StyleData::Solid(AlphaColor::new([0.0, 0.0, 0.0, 1.0])),
            stroke_style: StyleData::Solid(AlphaColor::new([0.0, 0.0, 0.0, 1.0])),
            global_alpha: 1.0,
            blend: BlendMode::new(Mix::Normal, Compose::SrcOver),
            stroke: default_stroke(),
            transform: Affine::IDENTITY,
            font: FontSpec::default(),
            text_align: "start".to_string(),
            text_baseline: "alphabetic".to_string(),
            smoothing: true,
            clip_len: 0,
        }
    }
}

fn default_stroke() -> Stroke {
    let mut s = Stroke::new(1.0);
    s.join = Join::Miter;
    s.miter_limit = 10.0;
    s.start_cap = Cap::Butt;
    s.end_cap = Cap::Butt;
    s
}

struct ClipEntry {
    path: BezPath,
    rule: Fill,
}

struct CanvasSurface {
    rctx: RenderContext,
    resources: Resources,
    width: u32,
    height: u32,
    state: CanvasState,
    stack: Vec<CanvasState>,
    clips: Vec<ClipEntry>,
    path: BezPath,
    cur: Option<Point>,
    subpath_start: Option<Point>,
    parked_paths: Vec<(BezPath, Option<Point>, Option<Point>)>,
    op_count: u32,
    dirty: bool,
    reset_pending: bool,
    raster_cache: Option<Arc<Pixmap>>,
    origin_clean: bool,
    verbatim_plane: Option<Arc<Vec<u8>>>,
    materialize_count: u32,
}

impl CanvasSurface {
    fn new(width: u32, height: u32) -> Self {
        CanvasSurface {
            rctx: RenderContext::new(width as u16, height as u16),
            resources: Resources::new(),
            width,
            height,
            state: CanvasState::default(),
            stack: Vec::new(),
            clips: Vec::new(),
            path: BezPath::new(),
            cur: None,
            subpath_start: None,
            parked_paths: Vec::new(),
            op_count: 0,
            dirty: true,
            reset_pending: false,
            raster_cache: None,
            origin_clean: true,
            verbatim_plane: None,
            materialize_count: 0,
        }
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
        self.raster_cache = None;
    }

    fn reset_all(&mut self, width: u32, height: u32) {
        *self = CanvasSurface::new(width, height);
    }

    fn ctm(&self) -> Affine {
        self.state.transform
    }

    fn setup_paint(&mut self, use_stroke_style: bool, paint_space: Affine) -> bool {
        let alpha = self.state.global_alpha.clamp(0.0, 1.0);
        let style = if use_stroke_style {
            self.state.stroke_style.clone()
        } else {
            self.state.fill_style.clone()
        };
        match style {
            StyleData::Solid(c) => {
                self.rctx
                    .set_paint(PaintType::Solid(c.multiply_alpha(alpha)));
                self.rctx.set_paint_transform(paint_space);
                false
            }
            StyleData::Gradient(g) => {
                self.rctx.set_paint(PaintType::Gradient(g));
                self.rctx.set_paint_transform(paint_space);
                alpha < 1.0
            }
            StyleData::Pattern {
                pixmap,
                x_extend,
                y_extend,
            } => {
                let quality = if self.state.smoothing {
                    ImageQuality::Medium
                } else {
                    ImageQuality::Low
                };
                self.rctx.set_paint(PaintType::Image(ImageBrush {
                    image: ImageSource::Pixmap(pixmap),
                    sampler: ImageSampler {
                        x_extend,
                        y_extend,
                        quality,
                        alpha,
                    },
                }));
                self.rctx.set_paint_transform(paint_space);
                false
            }
        }
    }

    fn covers_canvas(&self, x: f64, y: f64, w: f64, h: f64) -> bool {
        if !self.clips.is_empty() {
            return false;
        }
        let c = self.ctm().as_coeffs();
        if c[1] != 0.0 || c[2] != 0.0 {
            return false;
        }
        let p0 = self.ctm() * Point::new(x, y);
        let p1 = self.ctm() * Point::new(x + w, y + h);
        let (x0, x1) = (p0.x.min(p1.x), p0.x.max(p1.x));
        let (y0, y1) = (p0.y.min(p1.y), p0.y.max(p1.y));
        x0 <= 0.0 && y0 <= 0.0 && x1 >= self.width as f64 && y1 >= self.height as f64
    }

    fn reset_scene(&mut self) {
        self.rctx.reset();
        self.op_count = 0;
        self.reset_pending = true;
        self.rctx.set_transform(Affine::IDENTITY);
        for clip in &self.clips {
            self.rctx.set_fill_rule(clip.rule);
            self.rctx.push_clip_path(&clip.path);
        }
    }

    fn render_pixmap(&mut self) -> Pixmap {
        let mut pixmap = Pixmap::new(self.width as u16, self.height as u16);
        self.rctx.flush();
        self.rctx.render(&mut pixmap, &mut self.resources);
        pixmap
    }

    fn ensure_raster(&mut self) -> Arc<Pixmap> {
        self.materialize_verbatim();
        if let Some(p) = &self.raster_cache {
            return p.clone();
        }
        let p = Arc::new(self.render_pixmap());
        self.raster_cache = Some(p.clone());
        p
    }

    fn render_rgba(&mut self) -> Vec<u8> {
        let pixmap = self.ensure_raster();
        let mut out = vec![0u8; pixmap.data().len() * 4];
        unpremultiply_into(&mut out, pixmap.data());
        out
    }

    fn maybe_flatten(&mut self) {
        if self.op_count < FLATTEN_OP_BUDGET {
            return;
        }
        let pixmap = Arc::new(self.render_pixmap());
        for _ in 0..self.clips.len() {
            self.rctx.pop_clip();
        }
        self.rctx.reset();
        self.op_count = 1;
        self.rctx.set_transform(Affine::IDENTITY);
        self.rctx.set_fill_rule(Fill::NonZero);
        self.rctx
            .set_blend_mode(BlendMode::new(Mix::Normal, Compose::Copy));
        self.rctx.set_paint(PaintType::Image(ImageBrush {
            image: ImageSource::Pixmap(pixmap),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        }));
        self.rctx.set_paint_transform(Affine::IDENTITY);
        self.rctx
            .fill_rect(&Rect::new(0.0, 0.0, self.width as f64, self.height as f64));
        for clip in &self.clips {
            self.rctx.set_fill_rule(clip.rule);
            self.rctx.push_clip_path(&clip.path);
        }
    }

    fn fill_shape(&mut self, path: &BezPath, rule: Fill) {
        self.rctx.set_fill_rule(rule);
        self.rctx.set_transform(Affine::IDENTITY);
        self.rctx.set_blend_mode(self.state.blend);
        let ctm = self.ctm();
        let needs_layer = self.setup_paint(false, ctm);
        if needs_layer {
            self.rctx
                .push_opacity_layer(self.state.global_alpha.clamp(0.0, 1.0));
        }
        self.rctx.fill_path(path);
        if needs_layer {
            self.rctx.pop_layer();
        }
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn stroke_shape(&mut self, device_path: &BezPath) {
        let ctm = self.ctm();
        let det = ctm.determinant();
        if det == 0.0 || !det.is_finite() {
            return;
        }
        let mut user_path = device_path.clone();
        user_path.apply_affine(ctm.inverse());
        self.rctx.set_transform(ctm);
        self.rctx.set_stroke(self.state.stroke.clone());
        self.rctx.set_blend_mode(self.state.blend);
        let needs_layer = self.setup_paint(true, Affine::IDENTITY);
        if needs_layer {
            self.rctx
                .push_opacity_layer(self.state.global_alpha.clamp(0.0, 1.0));
        }
        self.rctx.stroke_path(&user_path);
        if needs_layer {
            self.rctx.pop_layer();
        }
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        if self.covers_canvas(x, y, w, h) {
            self.reset_scene();
            self.mark_dirty();
            return;
        }
        self.rctx.set_transform(self.ctm());
        self.rctx.set_fill_rule(Fill::NonZero);
        self.rctx
            .set_blend_mode(BlendMode::new(Mix::Normal, Compose::Clear));
        self.rctx
            .set_paint(PaintType::Solid(AlphaColor::new([0.0, 0.0, 0.0, 1.0])));
        self.rctx.set_paint_transform(Affine::IDENTITY);
        self.rctx.fill_rect(&Rect::new(x, y, x + w, y + h));
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn put_image_data(&mut self, dx: f64, dy: f64, w: u32, h: u32, mut rgba: Vec<u8>) {
        let plane_len = (w as usize) * (h as usize) * 4;
        if dx == 0.0 && dy == 0.0 && w == self.width && h == self.height && rgba.len() >= plane_len
        {
            rgba.truncate(plane_len);
            self.verbatim_plane = Some(Arc::new(rgba));
            self.op_count = 1;
            self.mark_dirty();
            return;
        }
        self.materialize_verbatim();
        self.put_image_data_scene(dx, dy, w, h, &rgba);
    }

    fn materialize_verbatim(&mut self) {
        if let Some(plane) = self.verbatim_plane.take() {
            self.materialize_count = self.materialize_count.wrapping_add(1);
            let (w, h) = (self.width, self.height);
            self.put_image_data_scene(0.0, 0.0, w, h, &plane);
        }
    }

    fn put_image_data_scene(&mut self, dx: f64, dy: f64, w: u32, h: u32, rgba: &[u8]) {
        let Some(pixmap) = pixmap_from_straight_rgba(w, h, rgba) else {
            return;
        };
        let covers_bitmap = dx <= 0.0
            && dy <= 0.0
            && dx + (w as f64) >= self.width as f64
            && dy + (h as f64) >= self.height as f64;
        if covers_bitmap {
            self.reset_scene();
        }
        for _ in 0..self.clips.len() {
            self.rctx.pop_clip();
        }
        self.rctx.set_transform(Affine::IDENTITY);
        self.rctx.set_fill_rule(Fill::NonZero);
        self.rctx
            .set_blend_mode(BlendMode::new(Mix::Normal, Compose::Copy));
        self.rctx.set_paint(PaintType::Image(ImageBrush {
            image: ImageSource::Pixmap(Arc::new(pixmap)),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality: ImageQuality::Low,
                alpha: 1.0,
            },
        }));
        self.rctx.set_paint_transform(Affine::translate((dx, dy)));
        self.rctx
            .fill_rect(&Rect::new(dx, dy, dx + w as f64, dy + h as f64));
        for clip in &self.clips {
            self.rctx.set_fill_rule(clip.rule);
            self.rctx.push_clip_path(&clip.path);
        }
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn draw_image(&mut self, src: Arc<Pixmap>, a: &[f64]) {
        let (sx, sy, mut sw, mut sh, dx, dy, mut dw, mut dh) =
            (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
        if sw < 0.0 {
            sw = src.width() as f64;
        }
        if sh < 0.0 {
            sh = src.height() as f64;
        }
        if dw < 0.0 {
            dw = sw;
        }
        if dh < 0.0 {
            dh = sh;
        }
        if sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
            return;
        }
        let quality = if self.state.smoothing {
            ImageQuality::Medium
        } else {
            ImageQuality::Low
        };
        self.rctx.set_transform(self.ctm());
        self.rctx.set_fill_rule(Fill::NonZero);
        self.rctx.set_blend_mode(self.state.blend);
        self.rctx.set_paint(PaintType::Image(ImageBrush {
            image: ImageSource::Pixmap(src),
            sampler: ImageSampler {
                x_extend: Extend::Pad,
                y_extend: Extend::Pad,
                quality,
                alpha: self.state.global_alpha.clamp(0.0, 1.0),
            },
        }));
        let paint_tf = Affine::translate((dx, dy))
            * Affine::scale_non_uniform(dw / sw, dh / sh)
            * Affine::translate((-sx, -sy));
        self.rctx.set_paint_transform(paint_tf);
        self.rctx.fill_rect(&Rect::new(dx, dy, dx + dw, dy + dh));
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn text(&mut self, text: &str, x: f64, y: f64, max_width: Option<f64>, stroke: bool) {
        let layout = match shape_text(&self.state.font, text) {
            Some(l) => l,
            None => return,
        };
        let width = layout.full_width() as f64;
        if width <= 0.0 && text.is_empty() {
            return;
        }
        let sx = match max_width {
            Some(mw) if mw <= 0.0 => return,
            Some(mw) if width > mw && width > 0.0 => mw / width,
            _ => 1.0,
        };
        let (ascent, descent) = layout_ascent_descent(&layout, self.state.font.size_px);
        let layout_baseline = layout
            .lines()
            .next()
            .map(|l| l.metrics().baseline)
            .unwrap_or(ascent) as f64;
        let align_dx = match self.state.text_align.as_str() {
            "center" => -(width * sx) / 2.0,
            "right" | "end" => -(width * sx),
            _ => 0.0,
        };
        let baseline_dy = match self.state.text_baseline.as_str() {
            "top" | "hanging" => ascent as f64,
            "middle" => (ascent - descent) as f64 / 2.0,
            "bottom" | "ideographic" => -(descent as f64),
            _ => 0.0,
        };
        let local = Affine::translate((x + align_dx, y + baseline_dy - layout_baseline))
            * Affine::scale_non_uniform(sx, 1.0);
        let tf = self.ctm() * local;
        self.rctx.set_transform(tf);
        self.rctx.set_blend_mode(self.state.blend);
        let det = local.determinant();
        let paint_tf = if det != 0.0 && det.is_finite() {
            local.inverse()
        } else {
            Affine::IDENTITY
        };
        let needs_layer = self.setup_paint(stroke, paint_tf);
        if needs_layer {
            self.rctx
                .push_opacity_layer(self.state.global_alpha.clamp(0.0, 1.0));
        }
        if stroke {
            self.rctx.set_stroke(self.state.stroke.clone());
        } else {
            self.rctx.set_fill_rule(Fill::NonZero);
        }
        for line in layout.lines() {
            for item in line.items() {
                let parley::layout::PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let run = glyph_run.run();
                let font = run.font();
                let font_size = run.font_size();
                let synthesis = run.synthesis();
                let glyph_tf = synthesis
                    .skew()
                    .map(|angle| Affine::skew(angle.to_radians().tan() as f64, 0.0))
                    .unwrap_or(Affine::IDENTITY);
                let glyphs = glyph_run.positioned_glyphs().map(|g| vello_cpu::Glyph {
                    id: g.id,
                    x: g.x,
                    y: g.y,
                });
                let builder = self
                    .rctx
                    .glyph_run(&mut self.resources, font)
                    .font_size(font_size)
                    .hint(false)
                    .normalized_coords(bytemuck::cast_slice(run.normalized_coords()))
                    .glyph_transform(glyph_tf);
                // A glyph that fails to render is skipped; the rest of the
                // run still draws, as in anyrender_vello_cpu.
                let _ = if stroke {
                    builder.stroke_glyphs(glyphs)
                } else {
                    builder.fill_glyphs(glyphs)
                };
            }
        }
        if needs_layer {
            self.rctx.pop_layer();
        }
        self.op_count += 1;
        self.mark_dirty();
        self.maybe_flatten();
    }

    fn move_to(&mut self, x: f64, y: f64) {
        let p = self.ctm() * Point::new(x, y);
        self.path.move_to(p);
        self.cur = Some(p);
        self.subpath_start = Some(p);
    }

    fn line_to(&mut self, x: f64, y: f64) {
        let p = self.ctm() * Point::new(x, y);
        if self.cur.is_none() {
            self.path.move_to(p);
            self.subpath_start = Some(p);
        } else {
            self.path.line_to(p);
        }
        self.cur = Some(p);
    }

    fn quad_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) {
        let c = self.ctm() * Point::new(cx, cy);
        let p = self.ctm() * Point::new(x, y);
        if self.cur.is_none() {
            self.path.move_to(c);
            self.subpath_start = Some(c);
        }
        self.path.quad_to(c, p);
        self.cur = Some(p);
    }

    fn bezier_to(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) {
        let c1 = self.ctm() * Point::new(c1x, c1y);
        let c2 = self.ctm() * Point::new(c2x, c2y);
        let p = self.ctm() * Point::new(x, y);
        if self.cur.is_none() {
            self.path.move_to(c1);
            self.subpath_start = Some(c1);
        }
        self.path.curve_to(c1, c2, p);
        self.cur = Some(p);
    }

    fn svg_path(&mut self, data: &str) {
        let Ok(mut parsed) = BezPath::from_svg(data) else {
            return;
        };
        parsed.apply_affine(self.ctm());
        for el in parsed.elements() {
            match *el {
                PathEl::MoveTo(p) => {
                    self.path.move_to(p);
                    self.cur = Some(p);
                    self.subpath_start = Some(p);
                }
                PathEl::LineTo(p) => {
                    self.path.line_to(p);
                    self.cur = Some(p);
                }
                PathEl::QuadTo(c, p) => {
                    self.path.quad_to(c, p);
                    self.cur = Some(p);
                }
                PathEl::CurveTo(c1, c2, p) => {
                    self.path.curve_to(c1, c2, p);
                    self.cur = Some(p);
                }
                PathEl::ClosePath => {
                    self.path.close_path();
                    self.cur = self.subpath_start;
                }
            }
        }
    }

    fn close_path(&mut self) {
        if self.cur.is_some() {
            self.path.close_path();
            self.cur = self.subpath_start;
        }
    }

    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.move_to(x, y);
        self.line_to(x + w, y);
        self.line_to(x + w, y + h);
        self.line_to(x, y + h);
        self.close_path();
        self.move_to(x, y);
    }

    fn round_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: &[f64]) {
        if r.len() < 8 || !w.is_finite() || !h.is_finite() {
            return;
        }
        let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
        let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
        let mut r: Vec<f64> = r[..8].iter().map(|v| v.max(0.0)).collect();
        let mut scale: f64 = 1.0;
        for (a, b, side) in [
            (r[0], r[2], w),
            (r[4], r[6], w),
            (r[1], r[7], h),
            (r[3], r[5], h),
        ] {
            if a + b > side && a + b > 0.0 {
                scale = scale.min(side / (a + b));
            }
        }
        for v in r.iter_mut() {
            *v *= scale;
        }
        let mut p = BezPath::new();
        p.move_to((x + r[0], y));
        p.line_to((x + w - r[2], y));
        let corner = |p: &mut BezPath, cx: f64, cy: f64, rx: f64, ry: f64, a0: f64| {
            if rx <= 0.0 || ry <= 0.0 {
                return;
            }
            let arc = KurboArc {
                center: Point::new(cx, cy),
                radii: Vec2::new(rx, ry),
                start_angle: a0,
                sweep_angle: FRAC_PI_2,
                x_rotation: 0.0,
            };
            for el in arc.append_iter(0.1) {
                p.push(el);
            }
        };
        corner(&mut p, x + w - r[2], y + r[3], r[2], r[3], -FRAC_PI_2);
        p.line_to((x + w, y + h - r[5]));
        corner(&mut p, x + w - r[4], y + h - r[5], r[4], r[5], 0.0);
        p.line_to((x + r[6], y + h));
        corner(&mut p, x + r[6], y + h - r[7], r[6], r[7], FRAC_PI_2);
        p.line_to((x, y + r[1]));
        corner(&mut p, x + r[0], y + r[1], r[0], r[1], std::f64::consts::PI);
        p.close_path();
        p.apply_affine(self.ctm());
        for el in p.elements() {
            self.path.push(*el);
        }
        self.move_to(x, y);
    }

    fn ellipse_arc(
        &mut self,
        center: Point,
        radii: Vec2,
        rotation: f64,
        a0: f64,
        a1: f64,
        ccw: bool,
    ) {
        if radii.x < 0.0 || radii.y < 0.0 || !radii.x.is_finite() || !radii.y.is_finite() {
            return;
        }
        let mut sweep = a1 - a0;
        if ccw {
            if sweep <= -TAU {
                sweep = -TAU;
            } else {
                sweep = sweep.rem_euclid(TAU);
                if sweep > 0.0 {
                    sweep -= TAU;
                }
            }
        } else if sweep >= TAU {
            sweep = TAU;
        } else {
            sweep = sweep.rem_euclid(TAU);
        }
        let arc = KurboArc {
            center,
            radii,
            start_angle: a0,
            sweep_angle: sweep,
            x_rotation: rotation,
        };
        let mut seg = BezPath::new();
        let start = Point::new(
            center.x + radii.x * a0.cos() * rotation.cos() - radii.y * a0.sin() * rotation.sin(),
            center.y + radii.x * a0.cos() * rotation.sin() + radii.y * a0.sin() * rotation.cos(),
        );
        seg.move_to(start);
        for el in arc.append_iter(0.1) {
            seg.push(el);
        }
        seg.apply_affine(self.ctm());
        let dev_start = self.ctm() * start;
        if self.cur.is_some() {
            self.path.line_to(dev_start);
        } else {
            self.path.move_to(dev_start);
            self.subpath_start = Some(dev_start);
        }
        let mut last = dev_start;
        for el in seg.elements().iter().skip(1) {
            self.path.push(*el);
            last = match el {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => *p,
                PathEl::QuadTo(_, p) => *p,
                PathEl::CurveTo(_, _, p) => *p,
                PathEl::ClosePath => last,
            };
        }
        self.cur = Some(last);
    }

    fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, r: f64) {
        if r < 0.0 {
            return;
        }
        let inv = self.ctm().inverse();
        let p0 = match self.cur {
            Some(dev) => inv * dev,
            None => {
                self.move_to(x1, y1);
                return;
            }
        };
        let p1 = Point::new(x1, y1);
        let p2 = Point::new(x2, y2);
        let v0 = (p0 - p1).normalize();
        let v1 = (p2 - p1).normalize();
        let cross = v0.x * v1.y - v0.y * v1.x;
        if !v0.x.is_finite() || !v1.x.is_finite() || cross.abs() < 1e-9 || r == 0.0 {
            self.line_to(x1, y1);
            return;
        }
        let half = (v0.dot(v1)).clamp(-1.0, 1.0).acos() / 2.0;
        let dist = r / half.tan();
        let t0 = p1 + v0 * dist;
        let t1 = p1 + v1 * dist;
        let bisector = (v0 + v1).normalize();
        let center = p1 + bisector * (r / half.sin());
        let a0 = (t0.y - center.y).atan2(t0.x - center.x);
        let a1 = (t1.y - center.y).atan2(t1.x - center.x);
        self.line_to(t0.x, t0.y);
        let ccw = cross < 0.0;
        let mut sweep = a1 - a0;
        if ccw && sweep > 0.0 {
            sweep -= TAU;
        } else if !ccw && sweep < 0.0 {
            sweep += TAU;
        }
        let arc = KurboArc {
            center,
            radii: Vec2::new(r, r),
            start_angle: a0,
            sweep_angle: sweep,
            x_rotation: 0.0,
        };
        let mut seg = BezPath::new();
        seg.move_to(t0);
        for el in arc.append_iter(0.1) {
            seg.push(el);
        }
        seg.apply_affine(self.ctm());
        let mut last = self.ctm() * t0;
        for el in seg.elements().iter().skip(1) {
            self.path.push(*el);
            last = match el {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => *p,
                PathEl::QuadTo(_, p) => *p,
                PathEl::CurveTo(_, _, p) => *p,
                PathEl::ClosePath => last,
            };
        }
        self.cur = Some(last);
    }

    fn clip(&mut self, rule: Fill) {
        let path = self.path.clone();
        self.rctx.set_fill_rule(rule);
        self.rctx.set_transform(Affine::IDENTITY);
        self.rctx.push_clip_path(&path);
        self.clips.push(ClipEntry { path, rule });
    }

    fn save(&mut self) {
        let mut snap = self.state.clone();
        snap.clip_len = self.clips.len();
        self.stack.push(snap);
    }

    fn restore(&mut self) {
        let Some(snap) = self.stack.pop() else { return };
        while self.clips.len() > snap.clip_len {
            self.clips.pop();
            self.rctx.pop_clip();
        }
        self.state = snap;
    }
}

struct ImageCacheEntry {
    rgba_id: u64,
    pixmap: Arc<Pixmap>,
    bytes: usize,
    last_used: u64,
}

const MAX_IMAGE_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct CanvasRegistry {
    surfaces: HashMap<u32, CanvasSurface>,
    image_cache: HashMap<u32, ImageCacheEntry>,
    image_cache_bytes: usize,
    image_cache_clock: u64,
}

impl CanvasRegistry {
    pub fn apply_ops(
        &mut self,
        node_id: u32,
        ops_json: &str,
        resolve_image: &mut dyn FnMut(u32) -> Option<ResolvedImage>,
    ) -> i32 {
        let ops: Vec<RawOp> = match serde_json::from_str(ops_json) {
            Ok(v) => v,
            Err(_) => return -1,
        };
        let mut surf = self
            .surfaces
            .remove(&node_id)
            .unwrap_or_else(|| CanvasSurface::new(300, 150));
        let mut applied = 0;
        for op in &ops {
            if self.apply_one(node_id, &mut surf, op, resolve_image) {
                applied += 1;
            }
        }
        self.surfaces.insert(node_id, surf);
        applied
    }

    fn apply_one(
        &mut self,
        current_id: u32,
        surf: &mut CanvasSurface,
        op: &RawOp,
        resolve_image: &mut dyn FnMut(u32) -> Option<ResolvedImage>,
    ) -> bool {
        let a = &op.a;
        let n = |i: usize| a.get(i).copied().unwrap_or(0.0);
        surf.materialize_verbatim();
        match op.o.as_str() {
            "resize" => {
                let w = (n(0) as u32).clamp(1, MAX_CANVAS_DIM);
                let h = (n(1) as u32).clamp(1, MAX_CANVAS_DIM);
                surf.reset_all(w, h);
            }
            "save" => surf.save(),
            "restore" => surf.restore(),
            "setTransform" => {
                if a.len() >= 6 && a.iter().all(|v| v.is_finite()) {
                    surf.state.transform = Affine::new([n(0), n(1), n(2), n(3), n(4), n(5)]);
                }
            }
            "transform" => {
                if a.len() >= 6 && a.iter().all(|v| v.is_finite()) {
                    surf.state.transform *= Affine::new([n(0), n(1), n(2), n(3), n(4), n(5)]);
                }
            }
            "resetTransform" => surf.state.transform = Affine::IDENTITY,
            "translate" => {
                if a.iter().all(|v| v.is_finite()) {
                    surf.state.transform *= Affine::translate((n(0), n(1)));
                }
            }
            "scale" => {
                if a.iter().all(|v| v.is_finite()) {
                    surf.state.transform *= Affine::scale_non_uniform(n(0), n(1));
                }
            }
            "rotate" => {
                if n(0).is_finite() {
                    surf.state.transform *= Affine::rotate(n(0));
                }
            }
            "fillStyle" | "strokeStyle" => {
                let Some(spec) = &op.g else { return false };
                let Some(style) = self.build_style(current_id, surf, spec, resolve_image) else {
                    return false;
                };
                if op.o == "fillStyle" {
                    surf.state.fill_style = style;
                } else {
                    surf.state.stroke_style = style;
                }
            }
            "alpha" => {
                let v = n(0);
                if v.is_finite() && (0.0..=1.0).contains(&v) {
                    surf.state.global_alpha = v as f32;
                }
            }
            "composite" => {
                if let Some(b) = op.s.as_deref().and_then(parse_composite) {
                    surf.state.blend = b;
                }
            }
            "lineWidth" => {
                let v = n(0);
                if v.is_finite() && v > 0.0 {
                    surf.state.stroke.width = v;
                }
            }
            "miterLimit" => {
                let v = n(0);
                if v.is_finite() && v > 0.0 {
                    surf.state.stroke.miter_limit = v;
                }
            }
            "lineCap" => {
                surf.state.stroke.start_cap = match op.s.as_deref() {
                    Some("round") => Cap::Round,
                    Some("square") => Cap::Square,
                    _ => Cap::Butt,
                };
                surf.state.stroke.end_cap = surf.state.stroke.start_cap;
            }
            "lineJoin" => {
                surf.state.stroke.join = match op.s.as_deref() {
                    Some("round") => Join::Round,
                    Some("bevel") => Join::Bevel,
                    _ => Join::Miter,
                };
            }
            "lineDash" => {
                if a.iter().all(|v| v.is_finite() && *v >= 0.0) {
                    surf.state.stroke.dash_pattern = a.iter().copied().collect();
                }
            }
            "lineDashOffset" => {
                if n(0).is_finite() {
                    surf.state.stroke.dash_offset = n(0);
                }
            }
            "font" => {
                if let Some(spec) = op.s.as_deref().and_then(parse_font_shorthand) {
                    surf.state.font = spec;
                }
            }
            "textAlign" => surf.state.text_align = op.s.clone().unwrap_or_default(),
            "textBaseline" => surf.state.text_baseline = op.s.clone().unwrap_or_default(),
            "smoothing" => surf.state.smoothing = n(0) != 0.0,
            "fillRect" => {
                let (x, y, w, h) = (n(0), n(1), n(2), n(3));
                if w == 0.0 || h == 0.0 {
                    return true;
                }
                let opaque_solid = matches!(
                    (&surf.state.fill_style, surf.state.global_alpha),
                    (StyleData::Solid(c), 1.0) if c.components[3] >= 1.0
                );
                if opaque_solid
                    && surf.state.blend == BlendMode::new(Mix::Normal, Compose::SrcOver)
                    && surf.covers_canvas(x, y, w, h)
                {
                    surf.reset_scene();
                }
                let mut p = BezPath::new();
                p.move_to((x, y));
                p.line_to((x + w, y));
                p.line_to((x + w, y + h));
                p.line_to((x, y + h));
                p.close_path();
                p.apply_affine(surf.ctm());
                surf.fill_shape(&p, Fill::NonZero);
            }
            "strokeRect" => {
                let (x, y, w, h) = (n(0), n(1), n(2), n(3));
                let mut p = BezPath::new();
                p.move_to((x, y));
                p.line_to((x + w, y));
                p.line_to((x + w, y + h));
                p.line_to((x, y + h));
                p.close_path();
                p.apply_affine(surf.ctm());
                surf.stroke_shape(&p);
            }
            "clearRect" => surf.clear_rect(n(0), n(1), n(2), n(3)),
            "beginPath" => {
                surf.path = BezPath::new();
                surf.cur = None;
                surf.subpath_start = None;
            }
            "closePath" => surf.close_path(),
            "pathPush" => {
                let parked = (
                    std::mem::take(&mut surf.path),
                    surf.cur.take(),
                    surf.subpath_start.take(),
                );
                surf.parked_paths.push(parked);
            }
            "pathPop" => {
                if let Some((path, cur, start)) = surf.parked_paths.pop() {
                    surf.path = path;
                    surf.cur = cur;
                    surf.subpath_start = start;
                }
            }
            "svgPath" => surf.svg_path(op.s.as_deref().unwrap_or_default()),
            "moveTo" => surf.move_to(n(0), n(1)),
            "lineTo" => surf.line_to(n(0), n(1)),
            "quad" => surf.quad_to(n(0), n(1), n(2), n(3)),
            "bezier" => surf.bezier_to(n(0), n(1), n(2), n(3), n(4), n(5)),
            "arc" => surf.ellipse_arc(
                Point::new(n(0), n(1)),
                Vec2::new(n(2), n(2)),
                0.0,
                n(3),
                n(4),
                n(5) != 0.0,
            ),
            "arcTo" => surf.arc_to(n(0), n(1), n(2), n(3), n(4)),
            "ellipse" => surf.ellipse_arc(
                Point::new(n(0), n(1)),
                Vec2::new(n(2), n(3)),
                n(4),
                n(5),
                n(6),
                n(7) != 0.0,
            ),
            "rect" => surf.rect(n(0), n(1), n(2), n(3)),
            "roundRect" => {
                let radii: Vec<f64> = a.iter().skip(4).copied().collect();
                surf.round_rect(n(0), n(1), n(2), n(3), &radii);
            }
            "fill" => {
                let rule = fill_rule(op.s.as_deref());
                let p = surf.path.clone();
                surf.fill_shape(&p, rule);
            }
            "stroke" => {
                let p = surf.path.clone();
                surf.stroke_shape(&p);
            }
            "clip" => surf.clip(fill_rule(op.s.as_deref())),
            "fillText" | "strokeText" => {
                let text = op.s.clone().unwrap_or_default();
                let max_w = a.get(2).copied().filter(|v| v.is_finite());
                surf.text(&text, n(0), n(1), max_w, op.o == "strokeText");
            }
            "drawImage" => {
                if a.len() < 8 {
                    return false;
                }
                let Some(src_id) = op.id else { return false };
                let source_clean = match op.s.as_deref() {
                    Some("canvas") if src_id == current_id => true,
                    Some("canvas") => self
                        .surfaces
                        .get(&src_id)
                        .map(|s| s.origin_clean)
                        .unwrap_or(true),
                    _ => op.oc.unwrap_or(true),
                };
                if !source_clean {
                    surf.origin_clean = false;
                }
                if !source_clean && op.s.as_deref() != Some("canvas") {
                    return true;
                }
                let src = match op.s.as_deref() {
                    Some("canvas") if src_id == current_id => Some(surf.ensure_raster()),
                    Some("canvas") => self.snapshot_canvas(src_id),
                    _ => self.resolve_image_pixmap(src_id, resolve_image),
                };
                let Some(src) = src else { return false };
                surf.draw_image(src, a);
            }
            _ => return false,
        }
        true
    }

    fn build_style(
        &mut self,
        current_id: u32,
        surf: &mut CanvasSurface,
        spec: &StyleSpec,
        resolve_image: &mut dyn FnMut(u32) -> Option<ResolvedImage>,
    ) -> Option<StyleData> {
        let v = |i: usize| spec.v.get(i).copied().unwrap_or(0.0);
        match spec.k.as_str() {
            "color" => {
                let css = spec.c.as_deref()?;
                let color = parse_color(css).ok()?.to_alpha_color::<Srgb>();
                Some(StyleData::Solid(color))
            }
            "linear" | "radial" | "conic" => {
                let stops = ColorStops(
                    spec.stops
                        .iter()
                        .filter_map(|(off, css)| {
                            let c = parse_color(css).ok()?;
                            Some(ColorStop {
                                offset: *off as f32,
                                color: c,
                            })
                        })
                        .collect(),
                );
                if stops.is_empty() {
                    return Some(StyleData::Solid(AlphaColor::new([0.0, 0.0, 0.0, 0.0])));
                }
                let kind = match spec.k.as_str() {
                    "linear" => GradientKind::Linear(LinearGradientPosition {
                        start: Point::new(v(0), v(1)),
                        end: Point::new(v(2), v(3)),
                    }),
                    "radial" => GradientKind::Radial(RadialGradientPosition {
                        start_center: Point::new(v(0), v(1)),
                        start_radius: v(2) as f32,
                        end_center: Point::new(v(3), v(4)),
                        end_radius: v(5) as f32,
                    }),
                    _ => GradientKind::Sweep(SweepGradientPosition {
                        center: Point::new(v(1), v(2)),
                        start_angle: v(0) as f32,
                        end_angle: (v(0) + TAU) as f32,
                    }),
                };
                Some(StyleData::Gradient(Gradient {
                    kind,
                    extend: Extend::Pad,
                    stops,
                    ..Gradient::default()
                }))
            }
            "pattern" => {
                let src_id = spec.id?;
                let source_clean = match spec.rep.as_deref() {
                    Some(r) if r.starts_with("canvas") && src_id == current_id => true,
                    Some(r) if r.starts_with("canvas") => self
                        .surfaces
                        .get(&src_id)
                        .map(|s| s.origin_clean)
                        .unwrap_or(true),
                    _ => spec.oc.unwrap_or(true),
                };
                if !source_clean {
                    surf.origin_clean = false;
                }
                let is_canvas_src = spec.rep.as_deref().is_some_and(|r| r.starts_with("canvas"));
                if !source_clean && !is_canvas_src {
                    return None;
                }
                let pixmap = match spec.rep.as_deref() {
                    Some(r) if r.starts_with("canvas") && src_id == current_id => {
                        Some(surf.ensure_raster())
                    }
                    Some(r) if r.starts_with("canvas") => self.snapshot_canvas(src_id),
                    _ => self.resolve_image_pixmap(src_id, resolve_image),
                }?;
                let repetition = spec
                    .rep
                    .as_deref()
                    .and_then(|r| r.split(':').nth(1))
                    .unwrap_or("repeat");
                let (x_extend, y_extend) = match repetition {
                    "repeat-x" => (Extend::Repeat, Extend::Pad),
                    "repeat-y" => (Extend::Pad, Extend::Repeat),
                    "no-repeat" => (Extend::Pad, Extend::Pad),
                    _ => (Extend::Repeat, Extend::Repeat),
                };
                Some(StyleData::Pattern {
                    pixmap,
                    x_extend,
                    y_extend,
                })
            }
            _ => None,
        }
    }

    fn snapshot_canvas(&mut self, node_id: u32) -> Option<Arc<Pixmap>> {
        let surf = self.surfaces.get_mut(&node_id)?;
        Some(surf.ensure_raster())
    }

    pub fn put_image_data(
        &mut self,
        node_id: u32,
        dx: f64,
        dy: f64,
        w: u32,
        h: u32,
        rgba: Vec<u8>,
    ) {
        let surf = self
            .surfaces
            .entry(node_id)
            .or_insert_with(|| CanvasSurface::new(300, 150));
        surf.put_image_data(dx, dy, w, h, rgba);
    }

    pub fn get_image_data(&mut self, node_id: u32, sx: i64, sy: i64, sw: u32, sh: u32) -> Vec<u8> {
        let Some(surf) = self.surfaces.get_mut(&node_id) else {
            return vec![0u8; (sw as usize) * (sh as usize) * 4];
        };
        let (cw, ch) = (surf.width as i64, surf.height as i64);
        let mut out = vec![0u8; (sw as usize) * (sh as usize) * 4];
        if let Some(plane) = &surf.verbatim_plane {
            for row in 0..sh as i64 {
                let src_y = sy + row;
                if src_y < 0 || src_y >= ch {
                    continue;
                }
                for col in 0..sw as i64 {
                    let src_x = sx + col;
                    if src_x < 0 || src_x >= cw {
                        continue;
                    }
                    let si = (((src_y * cw + src_x) * 4) as usize).min(plane.len() - 4);
                    let di = ((row * sw as i64 + col) * 4) as usize;
                    out[di..di + 4].copy_from_slice(&plane[si..si + 4]);
                }
            }
            return out;
        }
        let pixmap = surf.ensure_raster();
        let data = pixmap.data();
        let col0 = (-sx).clamp(0, sw as i64);
        let col1 = (cw - sx).clamp(col0, sw as i64);
        if col0 == col1 {
            return out;
        }
        for row in 0..sh as i64 {
            let src_y = sy + row;
            if src_y < 0 || src_y >= ch {
                continue;
            }
            let si = (src_y * cw + sx + col0) as usize;
            let di = ((row * sw as i64 + col0) * 4) as usize;
            let n = (col1 - col0) as usize;
            unpremultiply_into(&mut out[di..di + n * 4], &data[si..si + n]);
        }
        out
    }

    pub fn flush(&mut self, node_id: u32) -> Option<(u32, u32, Arc<Vec<u8>>)> {
        let surf = self.surfaces.get_mut(&node_id)?;
        if !surf.dirty {
            return None;
        }
        if surf.reset_pending && surf.op_count == 0 && surf.verbatim_plane.is_none() {
            surf.reset_pending = false;
            return None;
        }
        surf.reset_pending = false;
        surf.dirty = false;
        if let Some(plane) = &surf.verbatim_plane {
            return Some((surf.width, surf.height, plane.clone()));
        }
        let rgba = surf.render_rgba();
        Some((surf.width, surf.height, Arc::new(rgba)))
    }

    pub fn encode_png(&mut self, node_id: u32) -> Vec<u8> {
        let Some(surf) = self.surfaces.get_mut(&node_id) else {
            return Vec::new();
        };
        let (w, h) = (surf.width, surf.height);
        if let Some(plane) = &surf.verbatim_plane {
            return encode_png(plane, w, h).unwrap_or_default();
        }
        if surf.raster_cache.is_some() {
            let rgba = surf.render_rgba();
            return encode_png(&rgba, w, h).unwrap_or_default();
        }
        let mut pixmap = surf.render_pixmap();
        for px in pixmap.data_mut() {
            let [r, g, b, a] = unpremultiply(*px);
            *px = PremulRgba8 { r, g, b, a };
        }
        encode_png(pixmap.data_as_u8_slice(), w, h).unwrap_or_default()
    }

    pub fn is_point_in_path(&mut self, node_id: u32, x: f64, y: f64, even_odd: bool) -> bool {
        let Some(surf) = self.surfaces.get_mut(&node_id) else {
            return false;
        };
        let w = surf.path.winding(Point::new(x, y));
        if even_odd {
            w % 2 != 0
        } else {
            w != 0
        }
    }

    pub fn release(&mut self, node_id: u32) {
        self.surfaces.remove(&node_id);
        if let Some(e) = self.image_cache.remove(&node_id) {
            self.image_cache_bytes = self.image_cache_bytes.saturating_sub(e.bytes);
        }
    }

    pub fn is_origin_clean(&self, node_id: u32) -> bool {
        self.surfaces
            .get(&node_id)
            .map(|s| s.origin_clean)
            .unwrap_or(true)
    }

    fn resolve_image_pixmap(
        &mut self,
        src_id: u32,
        resolve_image: &mut dyn FnMut(u32) -> Option<ResolvedImage>,
    ) -> Option<Arc<Pixmap>> {
        let resolved = resolve_image(src_id)?;
        let id = resolved.rgba.id();
        let tick = {
            self.image_cache_clock += 1;
            self.image_cache_clock
        };
        if let Some(entry) = self.image_cache.get_mut(&src_id) {
            if entry.rgba_id == id {
                entry.last_used = tick;
                return Some(entry.pixmap.clone());
            }
        }
        let pixmap = Arc::new(pixmap_from_straight_rgba(
            resolved.width,
            resolved.height,
            resolved.rgba.data(),
        )?);
        let bytes = pixmap.data().len() * 4;
        if let Some(prev) = self.image_cache.insert(
            src_id,
            ImageCacheEntry {
                rgba_id: id,
                pixmap: pixmap.clone(),
                bytes,
                last_used: tick,
            },
        ) {
            self.image_cache_bytes = self.image_cache_bytes.saturating_sub(prev.bytes);
        }
        self.image_cache_bytes += bytes;
        self.evict_image_cache(src_id);
        Some(pixmap)
    }

    fn evict_image_cache(&mut self, keep: u32) {
        while self.image_cache_bytes > MAX_IMAGE_CACHE_BYTES {
            let victim = self
                .image_cache
                .iter()
                .filter(|(k, _)| **k != keep)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| *k);
            let Some(v) = victim else { break };
            if let Some(e) = self.image_cache.remove(&v) {
                self.image_cache_bytes = self.image_cache_bytes.saturating_sub(e.bytes);
            }
        }
    }
}

fn fill_rule(s: Option<&str>) -> Fill {
    match s {
        Some("evenodd") => Fill::EvenOdd,
        _ => Fill::NonZero,
    }
}

static UNPREMULTIPLY: LazyLock<Box<[[u8; 256]]>> = LazyLock::new(|| {
    (0..256u32)
        .map(|a| {
            let mut row = [0u8; 256];
            for c in 0..256u32 {
                row[c as usize] = if a == 0 || a == 255 {
                    c as u8
                } else {
                    ((c * 255 + a / 2) / a).min(255) as u8
                };
            }
            row
        })
        .collect()
});

fn unpremultiply_with(table: &[[u8; 256]], px: PremulRgba8) -> [u8; 4] {
    let row = &table[px.a as usize];
    [
        row[px.r as usize],
        row[px.g as usize],
        row[px.b as usize],
        px.a,
    ]
}

fn unpremultiply(px: PremulRgba8) -> [u8; 4] {
    unpremultiply_with(&UNPREMULTIPLY, px)
}

fn unpremultiply_into(out: &mut [u8], src: &[PremulRgba8]) {
    let table: &[[u8; 256]] = &UNPREMULTIPLY;
    let (out_blocks, out_remainder) = out.as_chunks_mut::<16>();
    let (src_blocks, src_remainder) = src.as_chunks::<4>();
    for (out_block, src_block) in out_blocks.iter_mut().zip(src_blocks) {
        let pass = src_block.iter().all(|p| matches!(p.a, 0 | 255));
        for (o, p) in out_block.as_chunks_mut::<4>().0.iter_mut().zip(src_block) {
            o.copy_from_slice(&if pass {
                [p.r, p.g, p.b, p.a]
            } else {
                unpremultiply_with(table, *p)
            });
        }
    }
    for (o, p) in out_remainder
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(src_remainder)
    {
        o.copy_from_slice(&unpremultiply_with(table, *p));
    }
}

fn pixmap_from_straight_rgba(w: u32, h: u32, rgba: &[u8]) -> Option<Pixmap> {
    if w == 0 || h == 0 || w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM {
        return None;
    }
    let expected = (w as usize) * (h as usize) * 4;
    if rgba.len() != expected {
        return None;
    }
    // Premultiply here, rounding to nearest: `Pixmap::from_parts` would
    // round with `(c * a + 255) >> 8` and shift putImageData bytes.
    let mut data = Vec::with_capacity(expected);
    let mut may_have_transparency = false;
    for px in rgba.as_chunks::<4>().0 {
        let a = px[3] as u32;
        let pm = |c: u8| ((c as u32 * a + 127) / 255) as u8;
        data.extend_from_slice(&[pm(px[0]), pm(px[1]), pm(px[2]), px[3]]);
        may_have_transparency |= px[3] != 255;
    }
    Some(Pixmap::from_parts(
        data,
        w as u16,
        h as u16,
        PixelMetadata::new(ImageAlphaType::AlphaPremultiplied, may_have_transparency),
    ))
}

fn parse_composite(s: &str) -> Option<BlendMode> {
    let m = |mix, compose| Some(BlendMode::new(mix, compose));
    match s {
        "source-over" => m(Mix::Normal, Compose::SrcOver),
        "source-in" => m(Mix::Normal, Compose::SrcIn),
        "source-out" => m(Mix::Normal, Compose::SrcOut),
        "source-atop" => m(Mix::Normal, Compose::SrcAtop),
        "destination-over" => m(Mix::Normal, Compose::DestOver),
        "destination-in" => m(Mix::Normal, Compose::DestIn),
        "destination-out" => m(Mix::Normal, Compose::DestOut),
        "destination-atop" => m(Mix::Normal, Compose::DestAtop),
        "lighter" => m(Mix::Normal, Compose::Plus),
        "copy" => m(Mix::Normal, Compose::Copy),
        "xor" => m(Mix::Normal, Compose::Xor),
        "multiply" => m(Mix::Multiply, Compose::SrcOver),
        "screen" => m(Mix::Screen, Compose::SrcOver),
        "overlay" => m(Mix::Overlay, Compose::SrcOver),
        "darken" => m(Mix::Darken, Compose::SrcOver),
        "lighten" => m(Mix::Lighten, Compose::SrcOver),
        "color-dodge" => m(Mix::ColorDodge, Compose::SrcOver),
        "color-burn" => m(Mix::ColorBurn, Compose::SrcOver),
        "hard-light" => m(Mix::HardLight, Compose::SrcOver),
        "soft-light" => m(Mix::SoftLight, Compose::SrcOver),
        "difference" => m(Mix::Difference, Compose::SrcOver),
        "exclusion" => m(Mix::Exclusion, Compose::SrcOver),
        "hue" => m(Mix::Hue, Compose::SrcOver),
        "saturation" => m(Mix::Saturation, Compose::SrcOver),
        "color" => m(Mix::Color, Compose::SrcOver),
        "luminosity" => m(Mix::Luminosity, Compose::SrcOver),
        _ => None,
    }
}

pub fn serialize_css_color(css: &str) -> Option<String> {
    let color = parse_color(css).ok()?.to_alpha_color::<Srgb>();
    let [r, g, b, a] = color.components;
    let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if a >= 1.0 {
        Some(format!("#{:02x}{:02x}{:02x}", to8(r), to8(g), to8(b)))
    } else {
        let mut alpha = format!("{:.3}", a.clamp(0.0, 1.0));
        while alpha.ends_with('0') {
            alpha.pop();
        }
        if alpha.ends_with('.') {
            alpha.pop();
        }
        Some(format!(
            "rgba({}, {}, {}, {})",
            to8(r),
            to8(g),
            to8(b),
            alpha
        ))
    }
}

fn parse_font_shorthand(s: &str) -> Option<FontSpec> {
    let mut weight = 400.0f32;
    let mut italic = false;
    let mut size_px: Option<f32> = None;
    let mut family = String::new();
    let tokens: Vec<&str> = s.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if size_px.is_none() {
            match tok {
                "italic" | "oblique" => {
                    italic = true;
                    i += 1;
                    continue;
                }
                "bold" => {
                    weight = 700.0;
                    i += 1;
                    continue;
                }
                "bolder" => {
                    weight = 700.0;
                    i += 1;
                    continue;
                }
                "lighter" => {
                    weight = 300.0;
                    i += 1;
                    continue;
                }
                "normal" | "small-caps" => {
                    i += 1;
                    continue;
                }
                _ => {}
            }
            if let Ok(w) = tok.parse::<f32>() {
                if (1.0..=1000.0).contains(&w) {
                    weight = w;
                    i += 1;
                    continue;
                }
            }
            let size_part = tok.split('/').next().unwrap_or(tok);
            if let Some(px) = parse_css_length(size_part) {
                size_px = Some(px);
                i += 1;
                continue;
            }
            return None;
        }
        family = tokens[i..].join(" ");
        break;
    }
    let size_px = size_px?;
    if family.is_empty() {
        return None;
    }
    Some(FontSpec {
        size_px,
        families: family,
        weight,
        italic,
    })
}

fn parse_css_length(s: &str) -> Option<f32> {
    let units: &[(&str, f32)] = &[
        ("px", 1.0),
        ("pt", 4.0 / 3.0),
        ("rem", 16.0),
        ("em", 16.0),
        ("%", 0.16),
    ];
    for (suffix, factor) in units {
        if let Some(num) = s.strip_suffix(suffix) {
            let v: f32 = num.parse().ok()?;
            if v.is_finite() && v >= 0.0 {
                return Some(v * factor);
            }
        }
    }
    None
}

type Brush = u32;

fn shape_text(font: &FontSpec, text: &str) -> Option<parley::Layout<Brush>> {
    if text.is_empty() {
        return None;
    }
    let mut fcx = crate::resources::fonts::get_or_init_font_context();
    let mut lcx: parley::LayoutContext<Brush> = parley::LayoutContext::new();
    let mut style = parley::style::TextStyle::<'_, '_, Brush>::default();
    style.font_family = parley::style::FontFamily::Source(Cow::Owned(font.families.clone()));
    style.font_size = font.size_px;
    style.font_weight = parley::style::FontWeight::new(font.weight);
    if font.italic {
        style.font_style = parley::style::FontStyle::Italic;
    }
    let mut tb = lcx.tree_builder(&mut fcx, 1.0, true, &style);
    tb.push_text(text);
    let (mut layout, _text) = tb.build();
    layout.break_all_lines(None);
    Some(layout)
}

fn layout_ascent_descent(layout: &parley::Layout<Brush>, size_px: f32) -> (f32, f32) {
    for line in layout.lines() {
        for item in line.items() {
            if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
                let m = gr.run().font_metrics();
                return (m.ascent, m.descent);
            }
        }
    }
    (size_px * 0.8, size_px * 0.2)
}

pub fn measure_text(text: &str, font_shorthand: &str) -> String {
    let font = parse_font_shorthand(font_shorthand).unwrap_or_default();
    let Some(layout) = shape_text(&font, text) else {
        return "{\"width\":0,\"actualBoundingBoxLeft\":0,\"actualBoundingBoxRight\":0,\
                \"actualBoundingBoxAscent\":0,\"actualBoundingBoxDescent\":0,\
                \"fontBoundingBoxAscent\":0,\"fontBoundingBoxDescent\":0}"
            .to_string();
    };
    let width = layout.full_width();
    let (ascent, descent) = layout_ascent_descent(&layout, font.size_px);
    format!(
        "{{\"width\":{},\"actualBoundingBoxLeft\":0,\"actualBoundingBoxRight\":{},\
         \"actualBoundingBoxAscent\":{},\"actualBoundingBoxDescent\":{},\
         \"fontBoundingBoxAscent\":{},\"fontBoundingBoxDescent\":{}}}",
        width, width, ascent, descent, ascent, descent
    )
}

#[cfg(test)]
mod fused_put_tests {
    use super::*;

    fn plane(w: u32, h: u32, v: u8) -> Vec<u8> {
        vec![v; (w as usize) * (h as usize) * 4]
    }

    fn no_images(_: u32) -> Option<ResolvedImage> {
        None
    }

    #[test]
    fn consecutive_full_plane_puts_never_materialize() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[64,48]}]"#, &mut no_images);
        for i in 0..10u8 {
            reg.put_image_data(1, 0.0, 0.0, 64, 48, plane(64, 48, i));
        }
        let surf = reg.surfaces.get(&1).expect("surface");
        assert_eq!(
            surf.materialize_count, 0,
            "fused full-plane put path materialized a pending plane",
        );
        assert!(surf.verbatim_plane.is_some(), "plane should stay verbatim");
    }

    #[test]
    fn flush_between_puts_keeps_the_fused_path() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[32,32]}]"#, &mut no_images);
        for i in 0..5u8 {
            reg.put_image_data(1, 0.0, 0.0, 32, 32, plane(32, 32, i));
            let (_w, _h, out) = reg.flush(1).expect("flush");
            assert_eq!(out[0], i);
        }
        assert_eq!(reg.surfaces.get(&1).unwrap().materialize_count, 0);
    }

    #[test]
    fn a_drawing_op_after_a_put_materializes_once() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[32,32]}]"#, &mut no_images);
        reg.put_image_data(1, 0.0, 0.0, 32, 32, plane(32, 32, 7));
        let ops = r#"[{"o":"fillRect","a":[0,0,4,4]}]"#;
        reg.apply_ops(1, ops, &mut no_images);
        assert_eq!(reg.surfaces.get(&1).unwrap().materialize_count, 1);
    }

    #[test]
    fn a_flush_between_clear_and_redraw_keeps_the_previous_raster() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[40,20]}]"#, &mut no_images);
        reg.apply_ops(1, r#"[{"o":"fillRect","a":[0,0,40,20]}]"#, &mut no_images);
        let first = reg.flush(1).expect("frame 1 installs");
        assert!(
            first.2.iter().skip(3).step_by(4).any(|&a| a > 0),
            "frame 1 painted"
        );

        reg.apply_ops(1, r#"[{"o":"clearRect","a":[0,0,40,20]}]"#, &mut no_images);
        assert!(
            reg.flush(1).is_none(),
            "a reset-only scene must not overwrite the last good frame",
        );

        reg.apply_ops(1, r#"[{"o":"fillRect","a":[0,0,40,20]}]"#, &mut no_images);
        let second = reg.flush(1).expect("the completed frame installs");
        assert!(
            second.2.iter().skip(3).step_by(4).any(|&a| a > 0),
            "frame 2 painted"
        );
    }

    #[test]
    fn a_canvas_that_clears_and_draws_nothing_still_goes_blank() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[40,20]}]"#, &mut no_images);
        reg.apply_ops(1, r#"[{"o":"fillRect","a":[0,0,40,20]}]"#, &mut no_images);
        assert!(reg.flush(1).is_some());

        reg.apply_ops(1, r#"[{"o":"clearRect","a":[0,0,40,20]}]"#, &mut no_images);
        assert!(reg.flush(1).is_none(), "first flush holds the old frame");
        let blank = reg.flush(1).expect("second flush installs the clear");
        assert!(
            blank.2.iter().skip(3).step_by(4).all(|&a| a == 0),
            "the cleared plane is transparent",
        );
    }

    #[test]
    fn an_unchanged_surface_still_reports_clean() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[40,20]}]"#, &mut no_images);
        reg.apply_ops(1, r#"[{"o":"fillRect","a":[0,0,40,20]}]"#, &mut no_images);
        assert!(reg.flush(1).is_some());
        assert!(reg.flush(1).is_none());
        assert!(reg.flush(1).is_none());
    }
}

#[cfg(test)]
mod encode_png_tests {
    use super::*;

    fn no_images(_: u32) -> Option<ResolvedImage> {
        None
    }

    fn decode(png: &[u8]) -> Vec<u8> {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .expect("png info");
        let mut buf = vec![0u8; reader.output_buffer_size().expect("buf size")];
        reader.next_frame(&mut buf).expect("png frame");
        buf
    }

    #[test]
    fn encoding_leaves_no_memoized_raster_and_matches_flush() {
        let mut reg = CanvasRegistry::default();
        let ops = r#"[{"o":"resize","a":[40,20]},{"o":"alpha","a":[0.5]},{"o":"fillRect","a":[0,0,30,20]}]"#;
        reg.apply_ops(1, ops, &mut no_images);
        let png = reg.encode_png(1);
        assert!(
            reg.surfaces[&1].raster_cache.is_none(),
            "encode memoized its raster"
        );
        let (_, _, flushed) = reg.flush(1).expect("flush");
        assert_eq!(decode(&png), *flushed);
        assert!(
            flushed[3] > 0 && flushed[3] < 255,
            "expected a partial-alpha pixel"
        );
    }

    #[test]
    fn unpremultiply_table_matches_rounded_division() {
        for a in 0..=255u8 {
            for c in 0..=255u8 {
                let want = if a == 0 || a == 255 {
                    c
                } else {
                    ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
                };
                let px = PremulRgba8 {
                    r: c,
                    g: c,
                    b: c,
                    a,
                };
                assert_eq!(unpremultiply(px), [want, want, want, a], "c={c} a={a}");
            }
        }
    }

    #[test]
    fn unpremultiply_into_matches_per_pixel_conversion() {
        let px = |c: u8, a: u8| PremulRgba8 {
            r: c,
            g: c / 2,
            b: c / 3,
            a,
        };
        let src = [
            px(10, 255),
            px(0, 0),
            px(200, 255),
            px(7, 0),
            px(10, 255),
            px(60, 128),
            px(0, 0),
            px(255, 255),
            px(1, 1),
            px(90, 200),
            px(30, 31),
        ];
        let mut out = vec![0u8; src.len() * 4];
        unpremultiply_into(&mut out, &src);
        let want: Vec<u8> = src.iter().flat_map(|p| unpremultiply(*p)).collect();
        assert_eq!(out, want);
    }

    #[test]
    fn get_image_data_crops_off_canvas_edges_like_the_flushed_plane() {
        let (w, h) = (13i64, 7i64);
        let mut reg = CanvasRegistry::default();
        let ops = r#"[{"o":"resize","a":[13,7]},{"o":"fillStyle","g":{"k":"color","c":"rgb(200,100,50)"}},{"o":"alpha","a":[0.5]},{"o":"fillRect","a":[0,0,13,7]},{"o":"alpha","a":[1]},{"o":"fillRect","a":[4.5,1.5,8.5,3]},{"o":"clearRect","a":[0,5,3,2]}]"#;
        reg.apply_ops(1, ops, &mut no_images);
        let (_, _, plane) = reg.flush(1).expect("flush");
        assert!(
            plane
                .as_chunks::<4>()
                .0
                .iter()
                .any(|p| p[3] > 0 && p[3] < 255),
            "expected partial alpha"
        );
        for (sx, sy, sw, sh) in [(0, 0, 13, 7), (-3, -2, 18, 11), (5, 3, 4, 9), (-1, 6, 2, 1)] {
            let got = reg.get_image_data(1, sx, sy, sw, sh);
            let mut want = vec![0u8; (sw * sh * 4) as usize];
            for row in 0..sh as i64 {
                for col in 0..sw as i64 {
                    let (x, y) = (sx + col, sy + row);
                    if (0..w).contains(&x) && (0..h).contains(&y) {
                        let si = ((y * w + x) * 4) as usize;
                        let di = ((row * sw as i64 + col) * 4) as usize;
                        want[di..di + 4].copy_from_slice(&plane[si..si + 4]);
                    }
                }
            }
            assert_eq!(got, want, "crop {sx},{sy} {sw}x{sh}");
        }
        assert!(reg.get_image_data(1, 20, 0, 3, 3).iter().all(|&b| b == 0));
        assert!(reg.get_image_data(1, -5, 0, 3, 3).iter().all(|&b| b == 0));
    }

    #[test]
    fn a_verbatim_plane_encodes_without_rasterizing() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[8,4]}]"#, &mut no_images);
        let plane: Vec<u8> = (0..8 * 4 * 4).map(|i| i as u8).collect();
        reg.put_image_data(1, 0.0, 0.0, 8, 4, plane.clone());
        assert_eq!(decode(&reg.encode_png(1)), plane);
        let surf = &reg.surfaces[&1];
        assert!(surf.verbatim_plane.is_some() && surf.raster_cache.is_none());
    }
}

#[cfg(test)]
mod path2d_tests {
    use super::*;

    fn no_images(_: u32) -> Option<ResolvedImage> {
        None
    }

    fn alphas(reg: &mut CanvasRegistry, points: &[(usize, usize)]) -> Vec<u8> {
        let (w, _h, px) = reg.flush(1).expect("flush");
        points
            .iter()
            .map(|&(x, y)| px[(y * w as usize + x) * 4 + 3])
            .collect()
    }

    #[test]
    fn a_path2d_fill_leaves_the_default_path_alone() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[40,20]}]"#, &mut no_images);
        let ops = r#"[
            {"o":"beginPath"},{"o":"rect","a":[0,0,10,10]},
            {"o":"pathPush"},{"o":"svgPath","s":"M20 0h10v10h-10z"},{"o":"fill","s":"nonzero"},{"o":"pathPop"},
            {"o":"fill","s":"nonzero"}
        ]"#;
        reg.apply_ops(1, ops, &mut no_images);
        let a = alphas(&mut reg, &[(25, 5), (5, 5), (15, 5)]);
        assert!(a[0] > 0, "the Path2D was not filled");
        assert!(a[1] > 0, "the default path was lost");
        assert_eq!(a[2], 0, "filled outside both paths");
    }

    #[test]
    fn svg_path_data_follows_the_current_transform() {
        let mut reg = CanvasRegistry::default();
        reg.apply_ops(1, r#"[{"o":"resize","a":[40,20]}]"#, &mut no_images);
        let ops = r#"[
            {"o":"translate","a":[20,0]},
            {"o":"pathPush"},{"o":"svgPath","s":"M0 0 L10 0 L10 10 L0 10 Z"},{"o":"fill","s":"nonzero"},{"o":"pathPop"}
        ]"#;
        reg.apply_ops(1, ops, &mut no_images);
        let a = alphas(&mut reg, &[(25, 5), (5, 5)]);
        assert!(a[0] > 0);
        assert_eq!(a[1], 0);
    }
}

#[cfg(test)]
mod font_shorthand_tests {
    use super::measure_text;

    fn metrics(font: &str) -> serde_json::Value {
        serde_json::from_str(&measure_text("M", font)).expect("TextMetrics JSON")
    }

    #[test]
    fn measure_text_accepts_rem_without_changing_em() {
        let px = metrics("16px sans-serif");
        assert_eq!(metrics("1em sans-serif"), px);
        assert_eq!(metrics("1rem sans-serif"), px);
        assert!(px["width"].as_f64().is_some_and(|width| width > 0.0));
    }
}
