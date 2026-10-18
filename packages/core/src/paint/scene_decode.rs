// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Decodes the KSC0 paint stream emitted by `scene_record`.
//! The encoder and decoder share wire constants. Decode errors identify
//! unsupported versions, unknown tags, and malformed or truncated input.

use crate::paint::scene_record::{
    FONT_METADATA_BYTES, FONT_METADATA_HASH_BYTES, HEADER_MAGIC, HEADER_SIZE, PAINT_GRADIENT,
    PAINT_IMAGE, PAINT_SOLID, PATH_CLOSE, PATH_CURVE, PATH_END_TAG, PATH_LINE, PATH_MOVE,
    PATH_PREC_F32, PATH_PREC_Q3, PATH_QUAD, Q3_PIXELS_PER_UNIT, RES_KIND_FONT_METADATA,
    RES_KIND_GLYPH_OUTLINE, RES_KIND_IMAGE, TAG_BOX_SHADOW, TAG_FILL, TAG_GLYPH_RUN, TAG_PART,
    SCENE_RESOURCE_COUNT_BYTES, TAG_POP_LAYER, TAG_PUSH_CLIP_LAYER, TAG_PUSH_LAYER, TAG_STROKE,
    TAG_TEXT_RUN, TXFORM_FULL, TXFORM_IDENTITY, TXFORM_SAME_AS_PREV, WIRE_VERSION,
};

/// Error returned when a KSC0 scene stream cannot be decoded.
/// Byte-level failures include the offset where parsing stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    ShortHeader { got: usize },
    BadMagic { got: [u8; 4] },
    UnsupportedVersion { got: u32, want: u32 },
    UnexpectedEof { offset: usize, needed: usize },
    UnknownOpTag { offset: usize, tag: u8 },
    UnknownPathTag { offset: usize, tag: u8 },
    UnknownPaintTag { offset: usize, tag: u8 },
    UnknownPartMarker { offset: usize, marker: u8 },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::ShortHeader { got } => {
                write!(
                    f,
                    "scene header short: got {} bytes, need {}",
                    got, HEADER_SIZE
                )
            }
            DecodeError::BadMagic { got } => {
                write!(
                    f,
                    "scene header magic mismatch: got {:?}, want {:?}",
                    got, HEADER_MAGIC
                )
            }
            DecodeError::UnsupportedVersion { got, want } => {
                write!(
                    f,
                    "scene wire version {} unsupported (this build handles {})",
                    got, want
                )
            }
            DecodeError::UnexpectedEof { offset, needed } => {
                write!(
                    f,
                    "scene truncated at offset {}: needed {} more bytes",
                    offset, needed
                )
            }
            DecodeError::UnknownOpTag { offset, tag } => {
                write!(f, "unknown op tag 0x{:02x} at offset {}", tag, offset)
            }
            DecodeError::UnknownPathTag { offset, tag } => {
                write!(f, "unknown path el tag 0x{:02x} at offset {}", tag, offset)
            }
            DecodeError::UnknownPaintTag { offset, tag } => {
                write!(f, "unknown paint tag 0x{:02x} at offset {}", tag, offset)
            }
            DecodeError::UnknownPartMarker { offset, marker } => {
                write!(
                    f,
                    "unknown part marker 0x{:02x} at offset {}",
                    marker, offset
                )
            }
        }
    }
}

impl std::error::Error for DecodeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SceneHeader {
    pub version: u32,
    pub viewport_w: u32,
    pub viewport_h: u32,
    pub scroll_x: u32,
    pub scroll_y: u32,
    pub op_count: u32,
    pub resource_offset: u32,
    pub render_top_y: u32,
    pub render_h: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    Image,
    GlyphOutline,
    FontMetadata,
    Unknown(u8),
}

impl ResourceKind {
    fn from_u8(v: u8) -> Self {
        match v {
            RES_KIND_IMAGE => ResourceKind::Image,
            RES_KIND_GLYPH_OUTLINE => ResourceKind::GlyphOutline,
            RES_KIND_FONT_METADATA => ResourceKind::FontMetadata,
            other => ResourceKind::Unknown(other),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodedResource {
    #[cfg(test)]
    pub content_hash: u64,
    pub width: u32,
    pub height: u32,
    pub format: u8,
    pub kind: ResourceKind,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DecodedFontMeta {
    pub blob_hash: u64,
    pub face_index: u32,
}

#[derive(Debug, Default, Clone)]
pub struct DecodedResources {
    pub by_hash: std::collections::HashMap<u64, DecodedResource>,
    pub glyph_outlines: std::collections::HashMap<u64, Vec<u8>>,
    pub font_meta: std::collections::HashMap<u32, DecodedFontMeta>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DecodedGradientStop {
    pub offset: f32,
    pub cs: u8,
    pub components: [f32; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DecodedGradientKind {
    Linear {
        start: (f32, f32),
        end: (f32, f32),
    },
    Radial {
        start_center: (f32, f32),
        start_radius: f32,
        end_center: (f32, f32),
        end_radius: f32,
    },
    Sweep {
        center: (f32, f32),
        start_angle: f32,
        end_angle: f32,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedGradient {
    pub kind: DecodedGradientKind,
    pub extend: u8,
    pub interpolation_cs: u8,
    pub hue_direction: u8,
    pub interpolation_alpha_space: u8,
    pub stops: Vec<DecodedGradientStop>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedPaint {
    Solid { r: u8, g: u8, b: u8, a: u8 },
    Gradient(DecodedGradient),
    Image { content_hash: u64 },
}

impl DecodedGradient {
    pub fn to_peniko_gradient(&self) -> peniko::Gradient {
        use peniko::color::HueDirection;
        use peniko::{
            Color, Extend, Gradient, GradientKind, InterpolationAlphaSpace, LinearGradientPosition,
            RadialGradientPosition, SweepGradientPosition,
        };
        let kind = match self.kind {
            DecodedGradientKind::Linear { start, end } => {
                GradientKind::Linear(LinearGradientPosition {
                    start: kurbo::Point::new(start.0 as f64, start.1 as f64),
                    end: kurbo::Point::new(end.0 as f64, end.1 as f64),
                })
            }
            DecodedGradientKind::Radial {
                start_center,
                start_radius,
                end_center,
                end_radius,
            } => GradientKind::Radial(RadialGradientPosition {
                start_center: kurbo::Point::new(start_center.0 as f64, start_center.1 as f64),
                start_radius,
                end_center: kurbo::Point::new(end_center.0 as f64, end_center.1 as f64),
                end_radius,
            }),
            DecodedGradientKind::Sweep {
                center,
                start_angle,
                end_angle,
            } => GradientKind::Sweep(SweepGradientPosition {
                center: kurbo::Point::new(center.0 as f64, center.1 as f64),
                start_angle,
                end_angle,
            }),
        };
        let extend = match self.extend {
            0 => Extend::Pad,
            1 => Extend::Repeat,
            2 => Extend::Reflect,
            _ => Extend::Pad,
        };
        let interpolation_cs = color_space_tag_from_u8(self.interpolation_cs);
        let hue_direction = match self.hue_direction {
            0 => HueDirection::Shorter,
            1 => HueDirection::Longer,
            2 => HueDirection::Increasing,
            3 => HueDirection::Decreasing,
            _ => HueDirection::Shorter,
        };
        let interpolation_alpha_space = match self.interpolation_alpha_space {
            0 => InterpolationAlphaSpace::Premultiplied,
            1 => InterpolationAlphaSpace::Unpremultiplied,
            _ => InterpolationAlphaSpace::Premultiplied,
        };
        let mut g = Gradient {
            kind,
            extend,
            interpolation_cs,
            hue_direction,
            interpolation_alpha_space,
            stops: Default::default(),
        };
        for s in &self.stops {
            let cs = color_space_tag_from_u8(s.cs);
            let dyn_color = peniko::color::DynamicColor {
                cs,
                flags: peniko::color::Flags::default(),
                components: s.components,
            };
            g.stops.0.push(peniko::ColorStop {
                offset: s.offset,
                color: dyn_color,
            });
        }
        let _ = Color::TRANSPARENT;
        g
    }
}

fn color_space_tag_from_u8(v: u8) -> peniko::color::ColorSpaceTag {
    use peniko::color::ColorSpaceTag;
    match v {
        0 => ColorSpaceTag::Srgb,
        1 => ColorSpaceTag::LinearSrgb,
        2 => ColorSpaceTag::Lab,
        3 => ColorSpaceTag::Lch,
        4 => ColorSpaceTag::Hsl,
        5 => ColorSpaceTag::Hwb,
        6 => ColorSpaceTag::Oklab,
        7 => ColorSpaceTag::Oklch,
        8 => ColorSpaceTag::DisplayP3,
        9 => ColorSpaceTag::A98Rgb,
        10 => ColorSpaceTag::ProphotoRgb,
        11 => ColorSpaceTag::Rec2020,
        12 => ColorSpaceTag::AcesCg,
        13 => ColorSpaceTag::XyzD50,
        14 => ColorSpaceTag::XyzD65,
        15 => ColorSpaceTag::Aces2065_1,
        _ => ColorSpaceTag::Srgb,
    }
}

fn bytecount_utf8_chars(bytes: &[u8]) -> usize {
    bytes.iter().filter(|b| (**b as i8) >= -0x40).count()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DecodedPathEl {
    Move {
        x: f32,
        y: f32,
    },
    Line {
        x: f32,
        y: f32,
    },
    Quad {
        cx: f32,
        cy: f32,
        x: f32,
        y: f32,
    },
    Curve {
        c1x: f32,
        c1y: f32,
        c2x: f32,
        c2y: f32,
        x: f32,
        y: f32,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DecodedTransform(pub [f32; 6]);

impl DecodedTransform {
    pub fn is_identity(&self) -> bool {
        let c = self.0;
        c[0] == 1.0 && c[1] == 0.0 && c[2] == 0.0 && c[3] == 1.0 && c[4] == 0.0 && c[5] == 0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodedCap {
    Butt,
    Round,
    Square,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodedJoin {
    Miter,
    Round,
    Bevel,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodedFillRule {
    NonZero,
    EvenOdd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScenePart {
    Background,
    Border,
    Outline,
    TableBorder,
    TableRowBackground,
    TextDecoration,
    Marker,
    Checkbox { checked: bool },
    Radio { checked: bool },
    Unknown,
}

impl ScenePart {
    fn from_code(c: u8) -> Self {
        match c {
            0 => Self::Background,
            1 => Self::Border,
            2 => Self::Outline,
            3 => Self::TableBorder,
            4 => Self::TableRowBackground,
            5 => Self::TextDecoration,
            6 => Self::Marker,
            7 => Self::Checkbox { checked: false },
            8 => Self::Checkbox { checked: true },
            9 => Self::Radio { checked: false },
            10 => Self::Radio { checked: true },
            _ => Self::Unknown,
        }
    }
}

pub trait SceneVisitor {
    fn on_push_layer(
        &mut self,
        blend_mix: u8,
        blend_compose: u8,
        alpha: f32,
        transform: DecodedTransform,
        clip_path: &[DecodedPathEl],
    );
    fn on_push_clip_layer(&mut self, transform: DecodedTransform, clip_path: &[DecodedPathEl]);
    fn on_pop_layer(&mut self);
    fn on_fill(
        &mut self,
        fill_rule: DecodedFillRule,
        transform: DecodedTransform,
        brush_transform: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    );
    #[allow(
        clippy::too_many_arguments,
        reason = "KSC0 Stroke fields stay separate and ordered in this visitor callback."
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
    );
    fn on_glyph_run(
        &mut self,
        font_id: u32,
        font_size: f32,
        normalized_coords: &[i16],
        transform: DecodedTransform,
        paint: DecodedPaint,
        glyphs: &[(u32, f32, f32)],
    );
    #[allow(
        clippy::too_many_arguments,
        reason = "KSC0 BoxShadow fields stay separate and ordered in this visitor callback."
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
    );
    #[allow(
        clippy::too_many_arguments,
        reason = "KSC0 TextRun fields stay separate and ordered in this visitor callback."
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
    }

    fn on_op_bytes(&mut self, _tag: u8, _bytes: usize) {}

    fn on_part_begin(&mut self, _node_id: u64, _part: ScenePart) {}
    fn on_part_end(&mut self) {}
}

pub fn parse_header(bytes: &[u8]) -> Result<SceneHeader, DecodeError> {
    if bytes.len() < HEADER_SIZE {
        return Err(DecodeError::ShortHeader { got: bytes.len() });
    }
    let mut magic = [0u8; 4];
    magic.copy_from_slice(&bytes[0..4]);
    if magic != HEADER_MAGIC {
        return Err(DecodeError::BadMagic { got: magic });
    }
    let version = u32_le(&bytes[4..8]);
    if version != WIRE_VERSION {
        return Err(DecodeError::UnsupportedVersion {
            got: version,
            want: WIRE_VERSION,
        });
    }
    Ok(SceneHeader {
        version,
        viewport_w: u32_le(&bytes[8..12]),
        viewport_h: u32_le(&bytes[12..16]),
        scroll_x: u32_le(&bytes[16..20]),
        scroll_y: u32_le(&bytes[20..24]),
        op_count: u32_le(&bytes[24..28]),
        resource_offset: u32_le(&bytes[28..32]),
        render_top_y: u32_le(&bytes[32..36]),
        render_h: u32_le(&bytes[36..40]),
    })
}

pub fn parse_resources(
    bytes: &[u8],
    header: &SceneHeader,
) -> Result<DecodedResources, DecodeError> {
    parse_resource_table(bytes, header, true)
}

pub(crate) fn parse_resource_refs(
    bytes: &[u8],
    header: &SceneHeader,
) -> Result<DecodedResources, DecodeError> {
    parse_resource_table(bytes, header, false)
}

fn parse_resource_table(
    bytes: &[u8],
    header: &SceneHeader,
    include_inline_data: bool,
) -> Result<DecodedResources, DecodeError> {
    let mut out = DecodedResources::default();
    if header.resource_offset == 0 {
        return Ok(out);
    }
    let off = header.resource_offset as usize;
    if off < HEADER_SIZE {
        return Err(DecodeError::UnexpectedEof {
            offset: off,
            needed: HEADER_SIZE - off,
        });
    }
    let count_bytes = SCENE_RESOURCE_COUNT_BYTES;
    if off > bytes.len() || bytes.len() - off < count_bytes {
        return Err(DecodeError::UnexpectedEof {
            offset: off,
            needed: count_bytes,
        });
    }
    let mut cur = Cursor {
        buf: bytes,
        pos: off,
        last_transform: None,
    };
    let count = cur.read_u32()? as usize;
    for _ in 0..count {
        let hash = cur.read_u64()?;
        let width = cur.read_u32()?;
        let height = cur.read_u32()?;
        let kind_byte = cur.read_u8()?;
        let format = cur.read_u8()?;
        let _ = cur.read_u8()?;
        let _ = cur.read_u8()?;
        let byte_len = cur.read_u32()? as usize;
        cur.need(byte_len)?;
        let kind = ResourceKind::from_u8(kind_byte);
        let data = if include_inline_data
            || kind == ResourceKind::FontMetadata
            || (kind == ResourceKind::Image && format == 2)
        {
            bytes[cur.pos..cur.pos + byte_len].to_vec()
        } else {
            Vec::new()
        };
        cur.pos += byte_len;
        let entry = DecodedResource {
            #[cfg(test)]
            content_hash: hash,
            width,
            height,
            format,
            kind,
            data,
        };
        match kind {
            ResourceKind::Image => {
                out.by_hash.insert(hash, entry);
            }
            ResourceKind::GlyphOutline => {
                if include_inline_data {
                    out.glyph_outlines.insert(hash, entry.data);
                }
            }
            ResourceKind::FontMetadata => {
                let font_id = hash as u32;
                let (blob_hash, face_index) = if entry.data.len() >= FONT_METADATA_BYTES {
                    let mut buf = [0u8; FONT_METADATA_HASH_BYTES];
                    buf.copy_from_slice(&entry.data[8..16]);
                    let blob_hash = u64::from_le_bytes(buf);
                    let mut ibuf = [0u8; 4];
                    ibuf.copy_from_slice(&entry.data[16..20]);
                    (blob_hash, u32::from_le_bytes(ibuf))
                } else {
                    (0, 0)
                };
                out.font_meta.insert(
                    font_id,
                    DecodedFontMeta {
                        blob_hash,
                        face_index,
                    },
                );
            }
            ResourceKind::Unknown(_) => {
                // The entry length was consumed before dispatch, preserving framing when skipped.
            }
        }
    }
    Ok(out)
}

pub fn decode<V: SceneVisitor>(bytes: &[u8], visitor: &mut V) -> Result<SceneHeader, DecodeError> {
    let header = parse_header(bytes)?;
    let op_stream_end = if header.resource_offset != 0 {
        header.resource_offset as usize
    } else {
        bytes.len()
    };
    if op_stream_end < HEADER_SIZE {
        return Err(DecodeError::UnexpectedEof {
            offset: op_stream_end,
            needed: HEADER_SIZE - op_stream_end,
        });
    }
    if op_stream_end > bytes.len() {
        return Err(DecodeError::UnexpectedEof {
            offset: bytes.len(),
            needed: op_stream_end - bytes.len(),
        });
    }
    let mut cur = Cursor {
        buf: &bytes[..op_stream_end],
        pos: HEADER_SIZE,
        last_transform: None,
    };
    let mut path_scratch: Vec<DecodedPathEl> = Vec::with_capacity(64);
    let mut glyph_scratch: Vec<(u32, f32, f32)> = Vec::with_capacity(64);
    let mut dash_scratch: Vec<f32> = Vec::with_capacity(8);
    let mut coord_scratch: Vec<i16> = Vec::with_capacity(8);

    while cur.pos < cur.buf.len() {
        let op_start = cur.pos;
        let tag = cur.read_u8()?;
        match tag {
            TAG_PUSH_LAYER => {
                let blend = cur.read_u16()?;
                let alpha = cur.read_f32()?;
                let t = cur.read_transform()?;
                path_scratch.clear();
                cur.read_path(&mut path_scratch)?;
                visitor.on_push_layer(
                    (blend & 0xff) as u8,
                    (blend >> 8) as u8,
                    alpha,
                    t,
                    &path_scratch,
                );
            }
            TAG_PUSH_CLIP_LAYER => {
                let t = cur.read_transform()?;
                path_scratch.clear();
                cur.read_path(&mut path_scratch)?;
                visitor.on_push_clip_layer(t, &path_scratch);
            }
            TAG_POP_LAYER => visitor.on_pop_layer(),
            TAG_FILL => {
                let rule = match cur.read_u8()? {
                    0 => DecodedFillRule::NonZero,
                    _ => DecodedFillRule::EvenOdd,
                };
                let t = cur.read_transform()?;
                let bt = cur.read_brush_transform()?;
                let paint = cur.read_paint()?;
                path_scratch.clear();
                cur.read_path(&mut path_scratch)?;
                visitor.on_fill(rule, t, bt, paint, &path_scratch);
            }
            TAG_STROKE => {
                let width = cur.read_f32()?;
                let miter = cur.read_f32()?;
                let cap = match cur.read_u8()? {
                    0 => DecodedCap::Butt,
                    1 => DecodedCap::Round,
                    _ => DecodedCap::Square,
                };
                let join = match cur.read_u8()? {
                    0 => DecodedJoin::Miter,
                    1 => DecodedJoin::Round,
                    _ => DecodedJoin::Bevel,
                };
                let dash_offset = cur.read_f32()?;
                let dash_len = cur.read_u8()? as usize;
                dash_scratch.clear();
                dash_scratch.reserve(dash_len);
                for _ in 0..dash_len {
                    dash_scratch.push(cur.read_f32()?);
                }
                let t = cur.read_transform()?;
                let bt = cur.read_brush_transform()?;
                let paint = cur.read_paint()?;
                path_scratch.clear();
                cur.read_path(&mut path_scratch)?;
                visitor.on_stroke(
                    width,
                    miter,
                    cap,
                    join,
                    dash_offset,
                    &dash_scratch,
                    t,
                    bt,
                    paint,
                    &path_scratch,
                );
            }
            TAG_GLYPH_RUN => {
                let font_id = cur.read_u32()?;
                let size = cur.read_f32()?;
                let coord_len = cur.read_u16()? as usize;
                coord_scratch.clear();
                coord_scratch.reserve(coord_len);
                for _ in 0..coord_len {
                    coord_scratch.push(cur.read_i16()?);
                }
                let t = cur.read_transform()?;
                let paint = cur.read_paint()?;
                let n = cur.read_u32()? as usize;
                glyph_scratch.clear();
                glyph_scratch.reserve(n);
                for _ in 0..n {
                    let id = cur.read_u32()?;
                    let x = cur.read_f32()?;
                    let y = cur.read_f32()?;
                    glyph_scratch.push((id, x, y));
                }
                visitor.on_glyph_run(font_id, size, &coord_scratch, t, paint, &glyph_scratch);
            }
            TAG_BOX_SHADOW => {
                let t = cur.read_transform()?;
                let x0 = cur.read_f32()?;
                let y0 = cur.read_f32()?;
                let x1 = cur.read_f32()?;
                let y1 = cur.read_f32()?;
                let r = cur.read_u8()?;
                let g = cur.read_u8()?;
                let b = cur.read_u8()?;
                let a = cur.read_u8()?;
                let radius = cur.read_f32()?;
                let std_dev = cur.read_f32()?;
                visitor.on_box_shadow(t, x0, y0, x1, y1, (r, g, b, a), radius, std_dev);
            }
            TAG_PART => {
                let marker_offset = cur.pos;
                match cur.read_u8()? {
                    1 => {
                        let node_id = cur.read_u64()?;
                        let part = ScenePart::from_code(cur.read_u8()?);
                        visitor.on_part_begin(node_id, part);
                    }
                    0 => visitor.on_part_end(),
                    marker => {
                        return Err(DecodeError::UnknownPartMarker {
                            offset: marker_offset,
                            marker,
                        });
                    }
                }
            }
            TAG_TEXT_RUN => {
                let font_id = cur.read_u32()?;
                let size = cur.read_f32()?;
                let coord_len = cur.read_u16()? as usize;
                coord_scratch.clear();
                coord_scratch.reserve(coord_len);
                for _ in 0..coord_len {
                    coord_scratch.push(cur.read_i16()?);
                }
                let t = cur.read_transform()?;
                let paint = cur.read_paint()?;
                let rgba = match paint {
                    DecodedPaint::Solid { r, g, b, a } => (r, g, b, a),
                    _ => {
                        return Err(DecodeError::UnknownPaintTag {
                            offset: cur.pos,
                            tag: PAINT_SOLID,
                        })
                    }
                };
                let start_x_q3 = cur.read_i16()?;
                let start_y_q3 = cur.read_i16()?;
                let text_len = cur.read_u16()? as usize;
                cur.need(text_len)?;
                let text_bytes = &cur.buf[cur.pos..cur.pos + text_len];
                let text_vec: Vec<u8> = text_bytes.to_vec();
                cur.pos += text_len;
                let kern_count = cur.read_u16()? as usize;
                let mut kerns: Vec<(u16, i8)> = Vec::with_capacity(kern_count);
                for _ in 0..kern_count {
                    let idx = cur.read_u16()?;
                    let dx = cur.read_u8()? as i8;
                    kerns.push((idx, dx));
                }
                let flags = cur.read_u8()?;
                visitor.on_text_run(
                    font_id,
                    size,
                    &coord_scratch,
                    t,
                    rgba,
                    start_x_q3,
                    start_y_q3,
                    &text_vec,
                    &kerns,
                    flags,
                );
            }
            _ => {
                return Err(DecodeError::UnknownOpTag {
                    offset: cur.pos - 1,
                    tag,
                });
            }
        }
        visitor.on_op_bytes(tag, cur.pos - op_start);
    }
    Ok(header)
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
    last_transform: Option<[f32; 6]>,
}

impl<'a> Cursor<'a> {
    #[inline]
    fn need(&self, n: usize) -> Result<(), DecodeError> {
        if self.pos > self.buf.len() || n > self.buf.len() - self.pos {
            Err(DecodeError::UnexpectedEof {
                offset: self.pos,
                needed: n,
            })
        } else {
            Ok(())
        }
    }
    fn read_u8(&mut self) -> Result<u8, DecodeError> {
        self.need(1)?;
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }
    fn read_u16(&mut self) -> Result<u16, DecodeError> {
        self.need(2)?;
        let v = u16_le(&self.buf[self.pos..self.pos + 2]);
        self.pos += 2;
        Ok(v)
    }
    fn read_u32(&mut self) -> Result<u32, DecodeError> {
        self.need(4)?;
        let v = u32_le(&self.buf[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(v)
    }
    fn read_u64(&mut self) -> Result<u64, DecodeError> {
        self.need(8)?;
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(u64::from_le_bytes(b))
    }
    fn read_i16(&mut self) -> Result<i16, DecodeError> {
        self.need(2)?;
        let mut b = [0u8; 2];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 2]);
        self.pos += 2;
        Ok(i16::from_le_bytes(b))
    }
    fn read_f32(&mut self) -> Result<f32, DecodeError> {
        self.need(4)?;
        let mut b = [0u8; 4];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(f32::from_le_bytes(b))
    }
    fn read_transform(&mut self) -> Result<DecodedTransform, DecodeError> {
        let flag = self.read_u8()?;
        match flag {
            TXFORM_IDENTITY => {
                let ident = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                self.last_transform = Some(ident);
                Ok(DecodedTransform(ident))
            }
            TXFORM_SAME_AS_PREV => {
                let prev = self.last_transform.ok_or(DecodeError::UnknownPathTag {
                    offset: self.pos - 1,
                    tag: TXFORM_SAME_AS_PREV,
                })?;
                Ok(DecodedTransform(prev))
            }
            TXFORM_FULL => {
                let mut c = [0f32; 6];
                for slot in &mut c {
                    *slot = self.read_f32()?;
                }
                self.last_transform = Some(c);
                Ok(DecodedTransform(c))
            }
            _ => Err(DecodeError::UnknownPathTag {
                offset: self.pos - 1,
                tag: flag,
            }),
        }
    }
    fn read_brush_transform(&mut self) -> Result<Option<DecodedTransform>, DecodeError> {
        let flag = self.read_u8()?;
        match flag {
            0 => Ok(None),
            1 => {
                let mut c = [0f32; 6];
                for slot in &mut c {
                    *slot = self.read_f32()?;
                }
                Ok(Some(DecodedTransform(c)))
            }
            _ => Err(DecodeError::UnknownPathTag {
                offset: self.pos - 1,
                tag: flag,
            }),
        }
    }
    fn read_paint(&mut self) -> Result<DecodedPaint, DecodeError> {
        let tag = self.read_u8()?;
        match tag {
            PAINT_SOLID => {
                let r = self.read_u8()?;
                let g = self.read_u8()?;
                let b = self.read_u8()?;
                let a = self.read_u8()?;
                Ok(DecodedPaint::Solid { r, g, b, a })
            }
            PAINT_GRADIENT => {
                let kind_tag = self.read_u8()?;
                let extend = self.read_u8()?;
                let interpolation_cs = self.read_u8()?;
                let hue_direction = self.read_u8()?;
                let interpolation_alpha_space = self.read_u8()?;
                let kind = match kind_tag {
                    0 => {
                        let sx = self.read_f32()?;
                        let sy = self.read_f32()?;
                        let ex = self.read_f32()?;
                        let ey = self.read_f32()?;
                        DecodedGradientKind::Linear {
                            start: (sx, sy),
                            end: (ex, ey),
                        }
                    }
                    1 => {
                        let scx = self.read_f32()?;
                        let scy = self.read_f32()?;
                        let sr = self.read_f32()?;
                        let ecx = self.read_f32()?;
                        let ecy = self.read_f32()?;
                        let er = self.read_f32()?;
                        DecodedGradientKind::Radial {
                            start_center: (scx, scy),
                            start_radius: sr,
                            end_center: (ecx, ecy),
                            end_radius: er,
                        }
                    }
                    2 => {
                        let cx = self.read_f32()?;
                        let cy = self.read_f32()?;
                        let sa = self.read_f32()?;
                        let ea = self.read_f32()?;
                        DecodedGradientKind::Sweep {
                            center: (cx, cy),
                            start_angle: sa,
                            end_angle: ea,
                        }
                    }
                    _ => {
                        return Err(DecodeError::UnknownPaintTag {
                            offset: self.pos - 5,
                            tag: kind_tag,
                        });
                    }
                };
                let stop_count = self.read_u16()? as usize;
                let mut stops = Vec::with_capacity(stop_count);
                for _ in 0..stop_count {
                    let offset = self.read_f32()?;
                    let cs = self.read_u8()?;
                    let c0 = self.read_f32()?;
                    let c1 = self.read_f32()?;
                    let c2 = self.read_f32()?;
                    let c3 = self.read_f32()?;
                    stops.push(DecodedGradientStop {
                        offset,
                        cs,
                        components: [c0, c1, c2, c3],
                    });
                }
                Ok(DecodedPaint::Gradient(DecodedGradient {
                    kind,
                    extend,
                    interpolation_cs,
                    hue_direction,
                    interpolation_alpha_space,
                    stops,
                }))
            }
            PAINT_IMAGE => {
                let content_hash = self.read_u64()?;
                Ok(DecodedPaint::Image { content_hash })
            }
            _ => Err(DecodeError::UnknownPaintTag {
                offset: self.pos - 1,
                tag,
            }),
        }
    }
    fn read_path(&mut self, out: &mut Vec<DecodedPathEl>) -> Result<(), DecodeError> {
        let prec = self.read_u8()?;
        let is_q3 = match prec {
            PATH_PREC_Q3 => true,
            PATH_PREC_F32 => false,
            _ => {
                return Err(DecodeError::UnknownPathTag {
                    offset: self.pos - 1,
                    tag: prec,
                });
            }
        };
        loop {
            let tag = self.read_u8()?;
            match tag {
                PATH_MOVE => {
                    let x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    out.push(DecodedPathEl::Move { x, y });
                }
                PATH_LINE => {
                    let x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    out.push(DecodedPathEl::Line { x, y });
                }
                PATH_QUAD => {
                    let cx = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let cy = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    out.push(DecodedPathEl::Quad { cx, cy, x, y });
                }
                PATH_CURVE => {
                    let c1x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let c1y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let c2x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let c2y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let x = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    let y = if is_q3 {
                        self.read_q3()?
                    } else {
                        self.read_f32()?
                    };
                    out.push(DecodedPathEl::Curve {
                        c1x,
                        c1y,
                        c2x,
                        c2y,
                        x,
                        y,
                    });
                }
                PATH_CLOSE => out.push(DecodedPathEl::Close),
                PATH_END_TAG => return Ok(()),
                _ => {
                    return Err(DecodeError::UnknownPathTag {
                        offset: self.pos - 1,
                        tag,
                    });
                }
            }
        }
    }
    #[inline]
    fn read_q3(&mut self) -> Result<f32, DecodeError> {
        let q = self.read_i16()?;
        Ok(q as f32 * Q3_PIXELS_PER_UNIT)
    }
}

#[inline]
fn u16_le(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}
#[inline]
fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[derive(Debug, Default, Clone)]
pub struct StatsVisitor {
    pub push_layer: u32,
    pub push_clip_layer: u32,
    pub pop_layer: u32,
    pub fill: u32,
    pub stroke: u32,
    pub glyph_run: u32,
    pub box_shadow: u32,
    pub text_run: u32,
    pub text_char_total: u64,
    pub glyph_total: u64,
    pub distinct_font_ids: std::collections::HashSet<u32>,
    pub distinct_image_hashes: std::collections::HashSet<u64>,
    pub solid_paints: u32,
    pub gradient_paints: u32,
    pub image_paints: u32,
    pub gradient_stops: u64,
    pub max_layer_depth: u32,
    layer_depth: u32,
    pub bytes_by_tag: [u64; 16],
    pub count_by_tag: [u64; 16],
}

impl StatsVisitor {
    fn push(&mut self) {
        self.layer_depth += 1;
        if self.layer_depth > self.max_layer_depth {
            self.max_layer_depth = self.layer_depth;
        }
    }
    fn record_paint(&mut self, paint: &DecodedPaint) {
        match paint {
            DecodedPaint::Solid { .. } => self.solid_paints += 1,
            DecodedPaint::Gradient(g) => {
                self.gradient_paints += 1;
                self.gradient_stops += g.stops.len() as u64;
            }
            DecodedPaint::Image { content_hash } => {
                self.image_paints += 1;
                self.distinct_image_hashes.insert(*content_hash);
            }
        }
    }
}

impl SceneVisitor for StatsVisitor {
    fn on_push_layer(
        &mut self,
        _mix: u8,
        _compose: u8,
        _alpha: f32,
        _t: DecodedTransform,
        _clip: &[DecodedPathEl],
    ) {
        self.push_layer += 1;
        self.push();
    }
    fn on_push_clip_layer(&mut self, _t: DecodedTransform, _clip: &[DecodedPathEl]) {
        self.push_clip_layer += 1;
        self.push();
    }
    fn on_pop_layer(&mut self) {
        self.pop_layer += 1;
        self.layer_depth = self.layer_depth.saturating_sub(1);
    }
    fn on_fill(
        &mut self,
        _rule: DecodedFillRule,
        _t: DecodedTransform,
        _bt: Option<DecodedTransform>,
        paint: DecodedPaint,
        _path: &[DecodedPathEl],
    ) {
        self.fill += 1;
        self.record_paint(&paint);
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Preserves separate, ordered KSC0 Stroke fields in the visitor."
    )]
    fn on_stroke(
        &mut self,
        _w: f32,
        _m: f32,
        _c: DecodedCap,
        _j: DecodedJoin,
        _do: f32,
        _dashes: &[f32],
        _t: DecodedTransform,
        _bt: Option<DecodedTransform>,
        paint: DecodedPaint,
        _path: &[DecodedPathEl],
    ) {
        self.stroke += 1;
        self.record_paint(&paint);
    }
    fn on_glyph_run(
        &mut self,
        font_id: u32,
        _size: f32,
        _coords: &[i16],
        _t: DecodedTransform,
        paint: DecodedPaint,
        glyphs: &[(u32, f32, f32)],
    ) {
        self.glyph_run += 1;
        self.glyph_total += glyphs.len() as u64;
        self.distinct_font_ids.insert(font_id);
        self.record_paint(&paint);
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Preserves separate, ordered KSC0 TextRun fields in the visitor."
    )]
    fn on_text_run(
        &mut self,
        font_id: u32,
        _size: f32,
        _coords: &[i16],
        _t: DecodedTransform,
        _rgba: (u8, u8, u8, u8),
        _sx: i16,
        _sy: i16,
        text: &[u8],
        _kerns: &[(u16, i8)],
        _flags: u8,
    ) {
        self.text_run += 1;
        self.distinct_font_ids.insert(font_id);
        self.text_char_total += bytecount_utf8_chars(text) as u64;
        self.solid_paints += 1;
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "Preserves separate, ordered KSC0 BoxShadow fields in the visitor."
    )]
    fn on_box_shadow(
        &mut self,
        _t: DecodedTransform,
        _x0: f32,
        _y0: f32,
        _x1: f32,
        _y1: f32,
        _rgba: (u8, u8, u8, u8),
        _radius: f32,
        _std_dev: f32,
    ) {
        self.box_shadow += 1;
    }
    fn on_op_bytes(&mut self, tag: u8, bytes: usize) {
        let i = (tag as usize) & 0x0f;
        self.bytes_by_tag[i] = self.bytes_by_tag[i].saturating_add(bytes as u64);
        self.count_by_tag[i] = self.count_by_tag[i].saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::scene_record::RecordingScene;
    use anyrender::PaintScene as _;
    use kurbo::{Affine, Rect};
    use peniko::{Color, Fill};

    fn empty_frame_with_resource_offset(offset: u32) -> Vec<u8> {
        let mut bytes = vec![0; HEADER_SIZE];
        bytes[..4].copy_from_slice(&HEADER_MAGIC);
        bytes[4..8].copy_from_slice(&WIRE_VERSION.to_le_bytes());
        bytes[28..32].copy_from_slice(&offset.to_le_bytes());
        bytes
    }

    #[test]
    fn cursor_need_rejects_overflowing_end() {
        let cursor = Cursor {
            buf: &[],
            pos: usize::MAX,
            last_transform: None,
        };

        assert_eq!(
            cursor.need(1),
            Err(DecodeError::UnexpectedEof {
                offset: usize::MAX,
                needed: 1,
            }),
        );
    }

    #[test]
    fn decode_rejects_resource_offset_inside_header() {
        let offset = (HEADER_SIZE - 4) as u32;
        let bytes = empty_frame_with_resource_offset(offset);
        let expected = DecodeError::UnexpectedEof {
            offset: HEADER_SIZE - 4,
            needed: 4,
        };

        assert_eq!(
            decode(&bytes, &mut StatsVisitor::default()),
            Err(expected.clone())
        );
        let header = parse_header(&bytes).expect("header");
        let resource_error = match parse_resources(&bytes, &header) {
            Err(error) => error,
            Ok(_) => panic!("resource table inside the header was accepted"),
        };
        assert_eq!(resource_error, expected);
    }

    #[test]
    fn decode_rejects_resource_offset_past_frame() {
        let offset = HEADER_SIZE as u32 + 1;
        let bytes = empty_frame_with_resource_offset(offset);

        assert_eq!(
            decode(&bytes, &mut StatsVisitor::default()),
            Err(DecodeError::UnexpectedEof {
                offset: HEADER_SIZE,
                needed: 1,
            }),
        );
        let header = parse_header(&bytes).expect("header");
        let resource_error = match parse_resources(&bytes, &header) {
            Err(error) => error,
            Ok(_) => panic!("resource table past the frame was accepted"),
        };
        assert_eq!(
            resource_error,
            DecodeError::UnexpectedEof {
                offset: HEADER_SIZE + 1,
                needed: 4,
            },
        );
    }

    #[test]
    fn round_trip_scripted_scene() {
        let mut scene = RecordingScene::new();
        scene.set_viewport(800, 600, 0, 0);

        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(255, 0, 0, 255),
            None,
            &Rect::new(0.0, 0.0, 100.0, 50.0),
        );
        scene.push_clip_layer(
            peniko::Fill::NonZero,
            Affine::IDENTITY,
            &Rect::new(10.0, 10.0, 90.0, 40.0),
        );
        scene.fill(
            Fill::EvenOdd,
            Affine::translate((5.0, 5.0)),
            Color::from_rgba8(0, 255, 0, 128),
            None,
            &Rect::new(20.0, 20.0, 80.0, 30.0),
        );
        scene.stroke(
            &kurbo::Stroke::new(2.0),
            Affine::IDENTITY,
            Color::from_rgba8(0, 0, 255, 255),
            None,
            &Rect::new(30.0, 25.0, 70.0, 35.0),
        );
        scene.pop_layer();
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(0, 0, 0, 255),
            None,
            &Rect::new(0.0, 0.0, 100.0, 50.0),
        );

        let stats_json = scene.stats_json();
        let framed = scene.finish_framed();

        let mut vis = StatsVisitor::default();
        let header = decode(&framed, &mut vis).expect("decode framed scene");
        assert_eq!(header.version, WIRE_VERSION);
        assert_eq!(header.viewport_w, 800);
        assert_eq!(header.viewport_h, 600);

        let want_fill = extract_number(&stats_json, "\"fill\":");
        let want_stroke = extract_number(&stats_json, "\"stroke\":");
        let want_push_clip = extract_number(&stats_json, "\"pushClipLayer\":");
        let want_pop = extract_number(&stats_json, "\"popLayer\":");
        let want_ops = extract_number(&stats_json, "\"opCount\":");

        assert_eq!(vis.fill as u64, want_fill);
        assert_eq!(vis.stroke as u64, want_stroke);
        assert_eq!(vis.push_clip_layer as u64, want_push_clip);
        assert_eq!(vis.pop_layer as u64, want_pop);
        let total_ops = (vis.push_layer
            + vis.push_clip_layer
            + vis.pop_layer
            + vis.fill
            + vis.stroke
            + vis.glyph_run
            + vis.box_shadow) as u64;
        assert_eq!(total_ops, want_ops);
    }

    #[test]
    fn part_markers_round_trip_without_counting_as_ops() {
        #[derive(Default)]
        struct Parts {
            seen: Vec<(u64, ScenePart)>,
            ends: usize,
        }
        impl SceneVisitor for Parts {
            fn on_part_begin(&mut self, node_id: u64, part: ScenePart) {
                self.seen.push((node_id, part));
            }
            fn on_part_end(&mut self) {
                self.ends += 1;
            }
            fn on_push_layer(
                &mut self,
                _mix: u8,
                _compose: u8,
                _alpha: f32,
                _t: DecodedTransform,
                _clip: &[DecodedPathEl],
            ) {
            }
            fn on_push_clip_layer(&mut self, _t: DecodedTransform, _clip: &[DecodedPathEl]) {}
            fn on_pop_layer(&mut self) {}
            fn on_fill(
                &mut self,
                _rule: DecodedFillRule,
                _t: DecodedTransform,
                _bt: Option<DecodedTransform>,
                _paint: DecodedPaint,
                _path: &[DecodedPathEl],
            ) {
            }
            #[allow(
                clippy::too_many_arguments,
                reason = "Matches the KSC0 Stroke visitor payload."
            )]
            fn on_stroke(
                &mut self,
                _width: f32,
                _miter: f32,
                _cap: DecodedCap,
                _join: DecodedJoin,
                _dash_offset: f32,
                _dashes: &[f32],
                _t: DecodedTransform,
                _bt: Option<DecodedTransform>,
                _paint: DecodedPaint,
                _path: &[DecodedPathEl],
            ) {
            }
            fn on_glyph_run(
                &mut self,
                _font_id: u32,
                _size: f32,
                _coords: &[i16],
                _t: DecodedTransform,
                _paint: DecodedPaint,
                _glyphs: &[(u32, f32, f32)],
            ) {
            }
            #[allow(
                clippy::too_many_arguments,
                reason = "Matches the KSC0 BoxShadow visitor payload."
            )]
            fn on_box_shadow(
                &mut self,
                _t: DecodedTransform,
                _x0: f32,
                _y0: f32,
                _x1: f32,
                _y1: f32,
                _rgba: (u8, u8, u8, u8),
                _radius: f32,
                _std_dev: f32,
            ) {
            }
        }

        let mut scene = RecordingScene::new();
        scene.set_viewport(200, 100, 0, 0);
        let rect = Rect::new(0.0, 0.0, 10.0, 10.0);
        let node_id = (1u64 << 32) | 7;
        for part in [
            anyrender::ScenePart::Background,
            anyrender::ScenePart::TextDecoration,
            anyrender::ScenePart::Checkbox { checked: true },
            anyrender::ScenePart::Radio { checked: false },
        ] {
            scene.begin_part(node_id, part);
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(0, 0, 0, 255),
                None,
                &rect,
            );
            scene.end_part();
        }
        let stats_json = scene.stats_json();
        let framed = scene.finish_framed();

        let mut parts = Parts::default();
        decode(&framed, &mut parts).expect("decode framed scene");
        assert_eq!(
            parts.seen,
            vec![
                (node_id, ScenePart::Background),
                (node_id, ScenePart::TextDecoration),
                (node_id, ScenePart::Checkbox { checked: true }),
                (node_id, ScenePart::Radio { checked: false }),
            ]
        );
        assert_eq!(parts.ends, 4);

        assert_eq!(extract_number(&stats_json, "\"opCount\":"), 4);
    }

    #[test]
    fn replay_scenes_omit_part_markers() {
        let mut scene = RecordingScene::for_replay();
        scene.begin_part(7, anyrender::ScenePart::Background);
        scene.end_part();
        assert_eq!(scene.finish_framed().len(), HEADER_SIZE);
    }

    #[test]
    fn decoder_rejects_unknown_part_marker() {
        let mut scene = RecordingScene::new();
        scene.begin_part(7, anyrender::ScenePart::Background);
        let mut framed = scene.finish_framed();
        framed[HEADER_SIZE + 1] = 2;

        let err = decode(&framed, &mut StatsVisitor::default()).unwrap_err();
        assert_eq!(
            err,
            DecodeError::UnknownPartMarker {
                offset: HEADER_SIZE + 1,
                marker: 2,
            }
        );
    }

    #[test]
    fn header_rejects_bad_magic() {
        let mut bad = vec![0u8; HEADER_SIZE];
        bad[0..4].copy_from_slice(b"XXXX");
        let err = parse_header(&bad).unwrap_err();
        assert!(matches!(err, DecodeError::BadMagic { .. }));
    }

    #[test]
    fn header_rejects_short_buffer() {
        let err = parse_header(b"KSC0").unwrap_err();
        assert!(matches!(err, DecodeError::ShortHeader { got: 4 }));
    }

    #[test]
    fn header_rejects_wrong_version() {
        let mut buf = vec![0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(&HEADER_MAGIC);
        buf[4..8].copy_from_slice(&99u32.to_le_bytes());
        let err = parse_header(&buf).unwrap_err();
        assert!(matches!(
            err,
            DecodeError::UnsupportedVersion { got: 99, .. }
        ));
    }

    #[test]
    fn round_trip_image_resource() {
        use peniko::{Blob, ImageAlphaType, ImageBrush, ImageData, ImageFormat};
        let rgba: Vec<u8> = vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0];
        let data = ImageData {
            data: Blob::new(std::sync::Arc::new(rgba.clone())),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: 2,
            height: 2,
        };
        let brush = ImageBrush::new(data);

        let mut scene = RecordingScene::new();
        scene.set_viewport(100, 100, 0, 0);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            brush.as_ref(),
            None,
            &Rect::new(0.0, 0.0, 50.0, 50.0),
        );
        let framed = scene.finish_framed();

        let header = parse_header(&framed).expect("header");
        assert!(header.resource_offset != 0, "resource_offset should be set");

        let resources = parse_resources(&framed, &header).expect("parse resources");
        assert_eq!(resources.by_hash.len(), 1);
        let entry = resources.by_hash.values().next().unwrap();
        assert_eq!(entry.width, 2);
        assert_eq!(entry.height, 2);
        assert_eq!(entry.format, 0);
        assert_eq!(entry.kind, ResourceKind::Image);
        assert_eq!(entry.data, rgba);
    }

    #[test]
    fn round_trip_gradient_linear_srgb() {
        use peniko::color::{ColorSpaceTag, DynamicColor, Flags, HueDirection};
        use peniko::{
            ColorStop, ColorStops, Extend, Gradient, GradientKind, InterpolationAlphaSpace,
            LinearGradientPosition,
        };
        let stops = ColorStops(smallvec::smallvec![
            ColorStop {
                offset: 0.0,
                color: DynamicColor {
                    cs: ColorSpaceTag::Srgb,
                    flags: Flags::default(),
                    components: [1.0, 0.0, 0.0, 1.0],
                },
            },
            ColorStop {
                offset: 0.5,
                color: DynamicColor {
                    cs: ColorSpaceTag::Srgb,
                    flags: Flags::default(),
                    components: [0.0, 1.0, 0.0, 0.5],
                },
            },
            ColorStop {
                offset: 1.0,
                color: DynamicColor {
                    cs: ColorSpaceTag::Oklab,
                    flags: Flags::default(),
                    components: [0.0, 0.0, 1.0, 1.0],
                },
            },
        ]);
        let gradient = Gradient {
            kind: GradientKind::Linear(LinearGradientPosition {
                start: kurbo::Point::new(10.0, 20.0),
                end: kurbo::Point::new(110.0, 220.0),
            }),
            extend: Extend::Reflect,
            interpolation_cs: ColorSpaceTag::Oklab,
            hue_direction: HueDirection::Longer,
            interpolation_alpha_space: InterpolationAlphaSpace::Unpremultiplied,
            stops,
        };

        let mut scene = RecordingScene::new();
        scene.set_viewport(200, 200, 0, 0);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &gradient,
            None,
            &Rect::new(0.0, 0.0, 100.0, 100.0),
        );
        let framed = scene.finish_framed();

        #[derive(Default)]
        struct CapturePaint {
            seen: Option<DecodedPaint>,
        }
        impl SceneVisitor for CapturePaint {
            fn on_push_layer(
                &mut self,
                _: u8,
                _: u8,
                _: f32,
                _: DecodedTransform,
                _: &[DecodedPathEl],
            ) {
            }
            fn on_push_clip_layer(&mut self, _: DecodedTransform, _: &[DecodedPathEl]) {}
            fn on_pop_layer(&mut self) {}
            fn on_fill(
                &mut self,
                _: DecodedFillRule,
                _: DecodedTransform,
                _: Option<DecodedTransform>,
                p: DecodedPaint,
                _: &[DecodedPathEl],
            ) {
                self.seen = Some(p);
            }
            #[allow(
                clippy::too_many_arguments,
                reason = "Matches the KSC0 Stroke visitor payload."
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
                reason = "Matches the KSC0 BoxShadow visitor payload."
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
        let mut cap = CapturePaint::default();
        decode(&framed, &mut cap).expect("decode");
        let paint = cap.seen.expect("paint captured");
        let dg = match paint {
            DecodedPaint::Gradient(g) => g,
            other => panic!("expected gradient, got {:?}", other),
        };

        assert_eq!(dg.extend, Extend::Reflect as u8);
        assert_eq!(dg.interpolation_cs, ColorSpaceTag::Oklab as u8);
        assert_eq!(dg.hue_direction, HueDirection::Longer as u8);
        assert_eq!(
            dg.interpolation_alpha_space,
            InterpolationAlphaSpace::Unpremultiplied as u8
        );
        match dg.kind {
            DecodedGradientKind::Linear { start, end } => {
                assert_eq!(start, (10.0, 20.0));
                assert_eq!(end, (110.0, 220.0));
            }
            other => panic!("expected linear, got {:?}", other),
        }
        assert_eq!(dg.stops.len(), 3);
        assert_eq!(dg.stops[0].offset, 0.0);
        assert_eq!(dg.stops[0].cs, ColorSpaceTag::Srgb as u8);
        assert_eq!(dg.stops[0].components, [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(dg.stops[1].offset, 0.5);
        assert_eq!(dg.stops[1].components, [0.0, 1.0, 0.0, 0.5]);
        assert_eq!(dg.stops[2].cs, ColorSpaceTag::Oklab as u8);
        assert_eq!(dg.stops[2].components, [0.0, 0.0, 1.0, 1.0]);

        let rebuilt = dg.to_peniko_gradient();
        assert!(matches!(rebuilt.kind, GradientKind::Linear(_)));
        assert_eq!(rebuilt.stops.0.len(), 3);
    }

    #[test]
    fn round_trip_gradient_brush_transform_survives() {
        use peniko::color::{ColorSpaceTag, DynamicColor, Flags, HueDirection};
        use peniko::{
            ColorStop, ColorStops, Extend, Gradient, GradientKind, InterpolationAlphaSpace,
            SweepGradientPosition,
        };
        let stops = ColorStops(smallvec::smallvec![
            ColorStop {
                offset: 0.0,
                color: DynamicColor {
                    cs: ColorSpaceTag::Srgb,
                    flags: Flags::default(),
                    components: [188.0 / 255.0, 193.0 / 255.0, 205.0 / 255.0, 1.0],
                },
            },
            ColorStop {
                offset: 1.0,
                color: DynamicColor {
                    cs: ColorSpaceTag::Srgb,
                    flags: Flags::default(),
                    components: [1.0, 1.0, 1.0, 1.0],
                },
            },
        ]);
        let gradient = Gradient {
            kind: GradientKind::Sweep(SweepGradientPosition {
                center: kurbo::Point::new(0.0, 0.0),
                start_angle: 0.0,
                end_angle: std::f32::consts::PI * 2.0,
            }),
            extend: Extend::Pad,
            interpolation_cs: ColorSpaceTag::Srgb,
            hue_direction: HueDirection::Shorter,
            interpolation_alpha_space: InterpolationAlphaSpace::Premultiplied,
            stops,
        };

        let brush_xform = Affine::rotate(0.0).then_translate(kurbo::Vec2::new(-100.0, 800.0));

        let mut scene = RecordingScene::new();
        scene.set_viewport(1000, 800, 0, 0);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &gradient,
            Some(brush_xform),
            &Rect::new(0.0, 0.0, 1000.0, 800.0),
        );
        let framed = scene.finish_framed();

        #[derive(Default)]
        struct CaptureBt {
            seen: Option<Option<DecodedTransform>>,
        }
        impl SceneVisitor for CaptureBt {
            fn on_push_layer(
                &mut self,
                _: u8,
                _: u8,
                _: f32,
                _: DecodedTransform,
                _: &[DecodedPathEl],
            ) {
            }
            fn on_push_clip_layer(&mut self, _: DecodedTransform, _: &[DecodedPathEl]) {}
            fn on_pop_layer(&mut self) {}
            fn on_fill(
                &mut self,
                _: DecodedFillRule,
                _: DecodedTransform,
                bt: Option<DecodedTransform>,
                _: DecodedPaint,
                _: &[DecodedPathEl],
            ) {
                self.seen = Some(bt);
            }
            #[allow(
                clippy::too_many_arguments,
                reason = "Matches the KSC0 Stroke visitor payload."
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
                reason = "Matches the KSC0 BoxShadow visitor payload."
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
        let mut cap = CaptureBt::default();
        decode(&framed, &mut cap).expect("decode");
        let bt = cap
            .seen
            .expect("fill visited")
            .expect("brush_transform present");
        let src_c = brush_xform.as_coeffs();
        for (i, slot) in bt.0.iter().enumerate() {
            assert_eq!(*slot, src_c[i] as f32, "coeff {i} mismatch");
        }
    }

    #[test]
    fn round_trip_solid_fill_encodes_none_brush_transform() {
        let mut scene = RecordingScene::new();
        scene.set_viewport(50, 50, 0, 0);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(0, 0, 0, 255),
            None,
            &Rect::new(0.0, 0.0, 10.0, 10.0),
        );
        let framed = scene.finish_framed();

        #[derive(Default)]
        struct Chk {
            bt_was_none: bool,
            visited: bool,
        }
        impl SceneVisitor for Chk {
            fn on_push_layer(
                &mut self,
                _: u8,
                _: u8,
                _: f32,
                _: DecodedTransform,
                _: &[DecodedPathEl],
            ) {
            }
            fn on_push_clip_layer(&mut self, _: DecodedTransform, _: &[DecodedPathEl]) {}
            fn on_pop_layer(&mut self) {}
            fn on_fill(
                &mut self,
                _: DecodedFillRule,
                _: DecodedTransform,
                bt: Option<DecodedTransform>,
                _: DecodedPaint,
                _: &[DecodedPathEl],
            ) {
                self.visited = true;
                self.bt_was_none = bt.is_none();
            }
            #[allow(
                clippy::too_many_arguments,
                reason = "Matches the KSC0 Stroke visitor payload."
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
                reason = "Matches the KSC0 BoxShadow visitor payload."
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
        let mut chk = Chk::default();
        decode(&framed, &mut chk).expect("decode");
        assert!(chk.visited);
        assert!(chk.bt_was_none);
    }

    #[test]
    fn round_trip_no_resources_leaves_offset_zero() {
        let mut scene = RecordingScene::new();
        scene.set_viewport(50, 50, 0, 0);
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgba8(0, 0, 0, 255),
            None,
            &Rect::new(0.0, 0.0, 10.0, 10.0),
        );
        let framed = scene.finish_framed();
        let header = parse_header(&framed).expect("header");
        assert_eq!(header.resource_offset, 0);
        let mut vis = StatsVisitor::default();
        decode(&framed, &mut vis).expect("decode");
        assert_eq!(vis.fill, 1);
    }

    fn extract_number(json: &str, key: &str) -> u64 {
        let start = json.find(key).expect("key present") + key.len();
        let tail = &json[start..];
        let end = tail
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(tail.len());
        tail[..end].parse().expect("number parses")
    }
}
