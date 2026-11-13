// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Element geometry: viewport, bounding, inline-aware, and intersection rects, and offset
//! metrics.

use std::panic;

use blitz_dom::{local_name, ns, util::Point, BaseDocument, Node, NodeData};
use blitz_html::HtmlDocument;
use blitz_traits::NodeId;
use parley::{Affinity, Cursor};
use serde::Serialize;
use taffy::Position;
use wasm_bindgen::prelude::*;

use crate::{emulated_color_scheme, DomHandle, LayoutMode};
use crate::dom::tree::{generates_box, has_layout_data};
use crate::layout::scroll::{is_scroll_container, overflow_clips};

pub(crate) fn svg_natural_dimensions(
    width: Option<f32>,
    height: Option<f32>,
    aspect: Option<f32>,
) -> (f32, f32) {
    match (width, height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => match aspect {
            Some(r) => (w, w / r),
            None => (w, 150.0),
        },
        (None, Some(h)) => match aspect {
            Some(r) => (h * r, h),
            None => (300.0, h),
        },
        (None, None) => match aspect {
            Some(r) if r >= 2.0 => (300.0, 300.0 / r),
            Some(r) => (150.0 * r, 150.0),
            None => (300.0, 150.0),
        },
    }
}

// The TypeScript shape of a serialized Rect (getBoundingClientRect).
#[wasm_bindgen(typescript_custom_section)]
const TS_RECT: &str = r#"
export interface KsLayoutRect {
    x: number;
    y: number;
    width: number;
    height: number;
    hasBox?: boolean;
}
"#;

#[derive(Serialize)]
pub(crate) struct Rect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    #[serde(rename = "hasBox", skip_serializing_if = "Option::is_none")]
    has_box: Option<bool>,
}

#[derive(Serialize)]
struct GeometryRect {
    x: f32,
    y: f32,
    top: f32,
    left: f32,
    right: f32,
    bottom: f32,
    width: f32,
    height: f32,
}

impl GeometryRect {
    const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        top: 0.0,
        left: 0.0,
        right: 0.0,
        bottom: 0.0,
        width: 0.0,
        height: 0.0,
    };

    fn from_rect(rect: &Rect, scroll_x: f32, scroll_y: f32) -> Self {
        Self::from_edges(
            rect.x - scroll_x,
            rect.y - scroll_y,
            rect.x - scroll_x + rect.width,
            rect.y - scroll_y + rect.height,
        )
    }

    fn from_edges(left: f32, top: f32, right: f32, bottom: f32) -> Self {
        Self {
            x: left,
            y: top,
            top,
            left,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IntersectionGeometry {
    target: GeometryRect,
    root_bounds: Option<GeometryRect>,
    intersection_rect: GeometryRect,
    is_intersecting: bool,
    intersection_ratio: f32,
}

impl Rect {
    const ZERO: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
        has_box: None,
    };

    const fn resolved(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
            has_box: Some(true),
        }
    }
}

pub(crate) fn composed_transform_for_node(
    doc: &BaseDocument,
    node_id: NodeId,
) -> Option<(kurbo::Affine, f64)> {
    let scale = doc.viewport().scale_f64();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }

    let mut chain = Vec::new();
    let mut has_transform = false;
    let mut current = Some(node_id);
    for _ in 0..4096 {
        let Some(id) = current else { break };
        let node = doc.get_node(id)?;
        chain.push(id);
        if node.transform().is_some() {
            has_transform = true;
        }
        current = node.containing_block();
    }
    if current.is_some() || !has_transform {
        return None;
    }
    chain.reverse();

    let mut composed = kurbo::Affine::IDENTITY;
    for &id in &chain {
        let node = doc.get_node(id)?;
        let parent = node
            .containing_block()
            .and_then(|parent| doc.get_node(parent));
        let (mut parent_scroll_x, mut parent_scroll_y) = parent
            .map(|parent| (parent.scroll_offset().x, parent.scroll_offset().y))
            .unwrap_or((0.0, 0.0));
        // A viewport-fixed box cancels the scroll (see fixed_scroll_anchor).
        if node.taffy_position() == Position::Fixed
            && parent.is_some_and(|parent| parent.id() == doc.root_element().id())
        {
            let viewport_scroll = doc.tree().fixed_anchor_scroll();
            parent_scroll_x = -viewport_scroll.x;
            parent_scroll_y = -viewport_scroll.y;
        }
        composed *= kurbo::Affine::translate((
            (node.final_layout().location.x as f64 - parent_scroll_x) * scale,
            (node.final_layout().location.y as f64 - parent_scroll_y) * scale,
        ));
        if let Some(transform) = node.transform() {
            composed *= transform;
        }
    }

    Some((composed, scale))
}

fn rect_edges(rect: &Rect) -> [f32; 4] {
    [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]
}

fn intersect_edges(a: [f32; 4], b: [f32; 4]) -> Option<[f32; 4]> {
    let out = [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ];
    (out[0] <= out[2] && out[1] <= out[3]).then_some(out)
}

fn resolve_margins(margins: &[f32], width: f32, height: f32) -> [f32; 4] {
    std::array::from_fn(|side| {
        let value = margins.get(side * 2).copied().unwrap_or(0.0);
        if margins.get(side * 2 + 1).copied().unwrap_or(0.0) == 0.0 {
            value
        } else {
            value * if side % 2 == 0 { height } else { width } / 100.0
        }
    })
}

fn padding_edges(node: &Node, [l, t, r, b]: [f32; 4]) -> [f32; 4] {
    let border = node.final_layout().border;
    let (left, top) = (l + border.left, t + border.top);
    [
        left,
        top,
        (r - border.right).max(left),
        (b - border.bottom).max(top),
    ]
}

fn containing_block_of(doc: &HtmlDocument, node: &Node) -> Option<NodeId> {
    use ::style::properties::generated::longhands::position::computed_value::T as Position;
    use ::style::values::specified::box_::DisplayOutside;
    let position = node
        .primary_styles()
        .map_or(Position::Static, |s| s.clone_position());
    let mut current = node.parent_id();
    while let Some(id) = current {
        let parent = doc.get_node(id)?;
        if let Some(styles) = parent.primary_styles().filter(|_| parent.is_element()) {
            let transformed = !styles.clone_transform().0.is_empty();
            let establishes = match position {
                Position::Fixed => transformed,
                Position::Absolute => transformed || styles.clone_position() != Position::Static,
                _ => styles.clone_display().outside() != DisplayOutside::None,
            };
            if establishes {
                return Some(id);
            }
        }
        current = parent.parent_id();
    }
    None
}

fn clip_to_containing_blocks(
    doc: &HtmlDocument,
    target: &Node,
    root: Option<NodeId>,
    scroll_margin: &[f32],
    mut rect: [f32; 4],
) -> Option<[f32; 4]> {
    let root_element = doc.root_element();
    let body_propagates = overflow_clips(root_element) == (false, false);
    let mut node = target;
    loop {
        let Some(id) = containing_block_of(doc, node) else {
            return root.is_none().then_some(rect);
        };
        if Some(id) == root {
            return Some(rect);
        }
        node = doc.get_node(id)?;
        let is_body = node.parent_id() == Some(root_element.id())
            && node
                .element_data()
                .is_some_and(|e| &*e.name.local == "body");
        if id == root_element.id() || (is_body && body_propagates) {
            continue;
        }
        let (clip_x, clip_y) = overflow_clips(node);
        let border_box = rect_edges(&bounding_rect_for_node(doc, node));
        let shape_clip = clip_path_edges(node, border_box);
        if !clip_x && !clip_y && shape_clip.is_none() {
            continue;
        }
        let padding_box = padding_edges(node, border_box);
        let grow = |[l, t, r, b]: [f32; 4]| {
            if !is_scroll_container(node) {
                return [l, t, r, b];
            }
            let [top, right, bottom, left] = resolve_margins(
                scroll_margin,
                padding_box[2] - padding_box[0],
                padding_box[3] - padding_box[1],
            );
            [l - left, t - top, r + right, b + bottom]
        };
        let mut clip = grow(padding_box);
        if !clip_x {
            (clip[0], clip[2]) = (f32::NEG_INFINITY, f32::INFINITY);
        }
        if !clip_y {
            (clip[1], clip[3]) = (f32::NEG_INFINITY, f32::INFINITY);
        }
        if let Some(shape) = shape_clip {
            clip = intersect_edges(clip, grow(shape))?;
        }
        rect = intersect_edges(rect, clip)?;
    }
}

fn clip_path_edges(node: &Node, [l, t, r, b]: [f32; 4]) -> Option<[f32; 4]> {
    use ::style::values::computed::basic_shape::ClipPath;
    use ::style::values::computed::CSSPixelLength;
    use ::style::values::generics::basic_shape::{GenericBasicShape, ShapeBox, ShapeGeometryBox};
    let clip_path = node.primary_styles()?.clone_clip_path();
    let layout = node.final_layout();
    let reference = |geometry: &ShapeGeometryBox| match geometry {
        ShapeGeometryBox::ShapeBox(ShapeBox::PaddingBox) => padding_edges(node, [l, t, r, b]),
        ShapeGeometryBox::FillBox | ShapeGeometryBox::ShapeBox(ShapeBox::ContentBox) => {
            let [l, t, r, b] = padding_edges(node, [l, t, r, b]);
            let p = layout.padding;
            [
                l + p.left,
                t + p.top,
                (r - p.right).max(l + p.left),
                (b - p.bottom).max(t + p.top),
            ]
        }
        _ => [l, t, r, b],
    };
    match clip_path {
        ClipPath::Box(geometry) => Some(reference(&geometry)),
        ClipPath::Shape(shape, geometry) => {
            let GenericBasicShape::Rect(inset) = &*shape else {
                return None;
            };
            let [l, t, r, b] = reference(&geometry);
            let px = |lp: &::style::values::computed::LengthPercentage, basis: f32| {
                lp.resolve(CSSPixelLength::new(basis)).px()
            };
            let (w, h) = (r - l, b - t);
            let left = l + px(&inset.rect.3, w);
            let top = t + px(&inset.rect.0, h);
            Some([
                left,
                top,
                (r - px(&inset.rect.1, w)).max(left),
                (b - px(&inset.rect.2, h)).max(top),
            ])
        }
        _ => None,
    }
}

/// Document-space scroll compensation shared by geometry and IntersectionObserver.
/// A viewport-fixed box stays put on screen, so its document-space position adds the scroll.
pub(crate) fn fixed_scroll_anchor(doc: &BaseDocument, node: &blitz_dom::Node) -> (f32, f32) {
    let root_element_id = doc.root_element().id();
    let mut cur = Some(node);
    while let Some(n) = cur {
        let cb = n.containing_block().and_then(|id| doc.get_node(id));
        if n.taffy_position() == Position::Fixed {
            return match cb {
                Some(cb) if cb.id() == root_element_id => {
                    let viewport_scroll = doc.tree().fixed_anchor_scroll();
                    (
                        cb.scroll_offset().x as f32 + viewport_scroll.x as f32,
                        cb.scroll_offset().y as f32 + viewport_scroll.y as f32,
                    )
                }
                // A fixed box inside a transformed ancestor scrolls with it.
                _ => (0.0, 0.0),
            };
        }
        cur = cb;
    }
    (0.0, 0.0)
}

/// `Node::absolute_position(0, 0)` in doc space: pinned for boxes in a
/// viewport-fixed box (see [`fixed_scroll_anchor`]).
pub(crate) fn doc_position(doc: &BaseDocument, node: &Node) -> Point<f32> {
    let pos = node.absolute_position(0.0, 0.0);
    let (x, y) = fixed_scroll_anchor(doc, node);
    Point {
        x: pos.x + x,
        y: pos.y + y,
    }
}

pub(crate) fn bounding_rect_for_node(doc: &HtmlDocument, node: &Node) -> Rect {
    let mut ancestor = Some(node);
    while let Some(n) = ancestor {
        if let Some(styles) = n.primary_styles() {
            use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
            let display = styles.clone_display();
            let is_none = display.outside() == DisplayOutside::None
                && display.inside() == DisplayInside::None;
            let is_self_boxless =
                std::ptr::eq(n, node) && display.outside() == DisplayOutside::None;
            if is_none || is_self_boxless {
                return Rect {
                    x: 0.0,
                    y: 0.0,
                    width: -1.0,
                    height: -1.0,
                    has_box: None,
                };
            }
        }
        ancestor = n.parent_id().and_then(|p| doc.get_node(p));
    }
    // Only box-bearing nodes have Blitz layout storage; text nodes use their
    // inline geometry, while comments and other non-box nodes have no rect.
    if !has_layout_data(node) {
        return match node.data {
            NodeData::Text(_) => text_node_rect(doc.as_ref(), node).unwrap_or(Rect::ZERO),
            _ => Rect::ZERO,
        };
    }
    // `absolute_position` subtracts this node's scroll as well as its ancestors';
    // add it back because scrolling content does not move the border box.
    let raw_pos = doc_position(doc, node);
    let pos = Point {
        x: raw_pos.x + node.scroll_offset().x as f32,
        y: raw_pos.y + node.scroll_offset().y as f32,
    };
    let size = node.final_layout().size;
    if size.width <= 0.0 || size.height <= 0.0 {
        if let Some(rect) = svg_descendant_rect_for_node(doc.as_ref(), node.id()) {
            return rect;
        }
        if let Some(rect) = inline_aware_rect_for_node(doc, node.id()) {
            return rect;
        }
    }
    if let Some(rect) = transformed_rect_for_node(doc, node.id()) {
        return rect;
    }
    Rect::resolved(pos.x, pos.y, size.width, size.height)
}

fn transformed_rect_for_node(doc: &BaseDocument, node_id: NodeId) -> Option<Rect> {
    let size = doc.get_node(node_id)?.final_layout().size;
    let (composed, scale) = composed_transform_for_node(doc, node_id)?;

    let local = kurbo::Rect::new(
        0.0,
        0.0,
        size.width as f64 * scale,
        size.height as f64 * scale,
    );
    let rect = composed.transform_rect_bbox(local);
    Some(Rect::resolved(
        (rect.x0 / scale) as f32,
        (rect.y0 / scale) as f32,
        ((rect.x1 - rect.x0) / scale) as f32,
        ((rect.y1 - rect.y0) / scale) as f32,
    ))
}

// The TypeScript shape of OffsetMetrics.
#[wasm_bindgen(typescript_custom_section)]
const TS_OFFSET_METRICS: &str = r#"
export interface KsOffsetMetrics {
    parent: number;
    top: number;
    left: number;
}
"#;

#[derive(Serialize)]
struct OffsetMetrics {
    parent: f64,
    top: f64,
    left: f64,
}

/// Compute viewport bounds from inline fragments when Taffy has no per-node box.
/// Undecorated wrappers can use descendant in-flow content.
fn inline_aware_rect_for_node(doc: &HtmlDocument, node_id: NodeId) -> Option<Rect> {
    let base: &BaseDocument = doc.as_ref();
    let node = base.get_node(node_id)?;
    let inline_root = node.inline_root_ancestor()?;
    let elem = inline_root.element_data()?;
    let inline = elem.inline_layout_data()?;
    let layout = inline.layout(node.tree());

    let lines: Vec<parley::layout::Line<'_, _>> = layout.lines().collect();

    // Inline root's content-box origin in viewport coords.
    let root_abs = doc_position(doc, inline_root);
    let content_off_x =
        inline_root.final_layout().padding.left + inline_root.final_layout().border.left;
    let content_off_y =
        inline_root.final_layout().padding.top + inline_root.final_layout().border.top;
    let composed = composed_transform_for_node(base, inline_root.id());
    let root_scroll = inline_root.scroll_offset();
    let transform_bounds = |x0: f32, y0: f32, x1: f32, y1: f32| {
        let Some((composed, scale)) = composed.as_ref() else {
            return (x0, y0, x1, y1);
        };
        let local = kurbo::Rect::new(
            (x0 - root_abs.x - root_scroll.x as f32) as f64 * scale,
            (y0 - root_abs.y - root_scroll.y as f32) as f64 * scale,
            (x1 - root_abs.x - root_scroll.x as f32) as f64 * scale,
            (y1 - root_abs.y - root_scroll.y as f32) as f64 * scale,
        );
        let transformed = composed.transform_rect_bbox(local);
        (
            (transformed.x0 / scale) as f32,
            (transformed.y0 / scale) as f32,
            (transformed.x1 / scale) as f32,
            (transformed.y1 / scale) as f32,
        )
    };

    use ::style::properties::generated::longhands::position::computed_value::T as Position;
    let out_of_flow = |id: NodeId| -> bool {
        base.get_node(id)
            .and_then(|n| n.primary_styles())
            .is_some_and(|s| matches!(s.clone_position(), Position::Absolute | Position::Fixed))
    };

    let accepted = |styled_id: NodeId| -> bool {
        if styled_id == node_id {
            return true;
        }
        if out_of_flow(styled_id) {
            return false;
        }
        let mut cur = styled_id;
        for _ in 0..32 {
            let Some(n) = base.get_node(cur) else {
                return false;
            };
            let Some(parent) = n.parent_id() else {
                return false;
            };
            if parent == node_id {
                return true;
            }
            if parent == inline_root.id() {
                return false;
            }
            if out_of_flow(parent) {
                return false;
            }
            cur = parent;
        }
        false
    };

    // Fragments contribute only the queried inline's own padding and border. Its text and
    // atomic children come from the glyph runs and in-flow inline boxes below.
    let styles = layout.styles();
    let fragment_bounds = layout.span_fragments().iter().filter_map(|fragment| {
        let style = styles.get(fragment.style_index as usize)?;
        let decorations = style.box_decorations.as_deref()?;
        let has_padding_or_border = decorations.padding_inline_start > 0.0
            || decorations.padding_inline_end > 0.0
            || decorations.padding_block_start > 0.0
            || decorations.padding_block_end > 0.0
            || decorations.border_inline_start_width > 0.0
            || decorations.border_inline_end_width > 0.0
            || decorations.border_block_start_width > 0.0
            || decorations.border_block_end_width > 0.0;
        if style.brush.id != node_id || !has_padding_or_border {
            return None;
        }
        let metrics = lines.get(fragment.line_index as usize)?.metrics();
        let x_origin = metrics.inline_min_coord + metrics.offset;
        let x0 = root_abs.x + content_off_x + x_origin + fragment.x_start;
        let x1 = root_abs.x + content_off_x + x_origin + fragment.x_end;
        let y0 = root_abs.y + content_off_y + metrics.block_min_coord;
        let y1 = root_abs.y + content_off_y + metrics.block_max_coord;
        Some(transform_bounds(x0, y0, x1, y1))
    });
    let item_bounds = lines
        .iter()
        .flat_map(|line| line.items())
        .filter_map(|item| match item {
            parley::layout::PositionedLayoutItem::GlyphRun(run)
                if accepted(run.style().brush.id) =>
            {
                // Glyph-run coordinates include the line's alignment offset.
                let metrics = run.run().font_metrics();
                let baseline = run.baseline();
                let x0 = root_abs.x + content_off_x + run.offset();
                let x1 = x0 + run.advance();
                let y0 = root_abs.y + content_off_y + baseline - metrics.ascent;
                let y1 = root_abs.y + content_off_y + baseline + metrics.descent;
                Some(transform_bounds(x0, y0, x1, y1))
            }
            parley::layout::PositionedLayoutItem::InlineBox(ibox)
                if ibox.kind == parley::InlineBoxKind::InFlow
                    && accepted(NodeId::from_u64(ibox.id)) =>
            {
                let x0 = root_abs.x + content_off_x + ibox.x;
                let y0 = root_abs.y + content_off_y + ibox.y;
                Some(transform_bounds(x0, y0, x0 + ibox.width, y0 + ibox.height))
            }
            _ => None,
        });
    let (min_x, min_y, max_x, max_y) = fragment_bounds.chain(item_bounds).reduce(
        |(ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1)| {
            (ax0.min(bx0), ay0.min(by0), ax1.max(bx1), ay1.max(by1))
        },
    )?;
    Some(Rect::resolved(min_x, min_y, max_x - min_x, max_y - min_y))
}

/// Viewport-space bounds of a text node's laid-out text: the union of
/// the per-line selection rects over the node's byte range in its
/// inline root, the same geometry the selection highlight paints. None
/// when the text was not laid out (whitespace-only, or collapsed away).
fn text_node_rect(doc: &BaseDocument, node: &Node) -> Option<Rect> {
    // Anonymous blocks wrap loose text and are only on the layout chain.
    let mut cur = node.layout_parent_id().or(node.parent_id());
    let mut inline_root = None;
    for _ in 0..512 {
        let n = doc.get_node(cur?)?;
        if n.flags.is_inline_root() {
            inline_root = Some(n);
            break;
        }
        cur = n.layout_parent_id().or(n.parent_id());
    }
    let inline_root = inline_root?;
    let inline = inline_root.element_data()?.inline_layout_data()?;
    let range = inline
        .node_ranges(node.tree())
        .iter()
        .find(|(id, _)| *id == node.id())?
        .1
        .clone();
    let layout = inline.layout(node.tree());
    let scale = layout.scale();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let anchor = Cursor::from_byte_index(layout, range.start, Affinity::Downstream);
    let focus = Cursor::from_byte_index(layout, range.end, Affinity::Downstream);
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    parley::Selection::new(anchor, focus).geometry_with(layout, |r, _line| {
        x0 = x0.min(r.x0);
        y0 = y0.min(r.y0);
        x1 = x1.max(r.x1);
        y1 = y1.max(r.y1);
    });
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let scale = scale as f64;
    let root_layout = inline_root.final_layout();
    let origin_x = (root_layout.padding.left + root_layout.border.left) as f64;
    let origin_y = (root_layout.padding.top + root_layout.border.top + inline.block_offset) as f64;
    let local = kurbo::Rect::new(
        origin_x + x0 / scale,
        origin_y + y0 / scale,
        origin_x + x1 / scale,
        origin_y + y1 / scale,
    );
    // Text scrolls with its inline root's content. absolute_position
    // already subtracts the root's own scroll offset; the composed
    // transform maps the unscrolled box, so that branch subtracts it.
    let rect = match composed_transform_for_node(doc, inline_root.id()) {
        Some((composed, device)) => {
            let scroll = inline_root.scroll_offset();
            let local = local - kurbo::Vec2::new(scroll.x, scroll.y);
            let r = composed.transform_rect_bbox(local.scale_from_origin(device));
            r.scale_from_origin(1.0 / device)
        }
        None => {
            let abs = inline_root.absolute_position(0.0, 0.0);
            local + kurbo::Vec2::new(abs.x as f64, abs.y as f64)
        }
    };
    Some(Rect::resolved(
        rect.x0 as f32,
        rect.y0 as f32,
        rect.width() as f32,
        rect.height() as f32,
    ))
}

/// Return a snapshot element's transformed object bounds, unioning children
/// when usvg omits a wrapper.
fn svg_canvas_bbox(
    doc: &BaseDocument,
    tree: &usvg::Tree,
    host: &Node,
    node: &Node,
    depth: u32,
) -> Option<usvg::Rect> {
    let elem = node.element_data()?;
    let synthetic;
    let key: &str = match elem.attr(local_name!("id")).filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => {
            synthetic = host.svg_snapshot_id(node.id())?;
            &synthetic
        }
    };
    if let Some(unode) = tree.node_by_id(key) {
        return unode.bounding_box().transform(unode.abs_transform());
    }
    if depth >= 32 {
        return None;
    }
    let mut union: Option<usvg::Rect> = None;
    for child_id in node.children() {
        let Some(child) = doc.get_node(child_id) else {
            continue;
        };
        if child.element_data().is_none() {
            continue;
        }
        let Some(r) = svg_canvas_bbox(doc, tree, host, child, depth + 1) else {
            continue;
        };
        union = Some(match union {
            None => r,
            Some(u) => usvg::Rect::from_ltrb(
                u.left().min(r.left()),
                u.top().min(r.top()),
                u.right().max(r.right()),
                u.bottom().max(r.bottom()),
            )?,
        });
    }
    union
}

fn svg_descendant_rect_for_node(doc: &BaseDocument, node_id: NodeId) -> Option<Rect> {
    let node = doc.get_node(node_id)?;
    let elem = node.element_data()?;
    if *elem.namespace() != ns!(svg) {
        return None;
    }
    let mut host: Option<&Node> = None;
    let mut cur = node.parent_id();
    while let Some(pid) = cur {
        let p = doc.get_node(pid)?;
        let Some(pel) = p.element_data() else { break };
        if *pel.namespace() != ns!(svg) {
            break;
        }
        if pel.svg_image_data().is_some() {
            host = Some(p);
        }
        cur = p.parent_id();
    }
    let host = host?;
    let host_layout = host.final_layout();
    if host_layout.size.width <= 0.0 || host_layout.size.height <= 0.0 {
        return None;
    }
    let data = host.element_data()?.svg_image_data()?;
    let tree = &data.tree;
    let bbox = svg_canvas_bbox(doc, tree, host, node, 0)?;

    let content_w = host_layout.content_box_width();
    let content_h = host_layout.content_box_height();
    let (fit_x, fit_y, scale_x, scale_y) = if data.viewbox_aspect_ratio().is_none() {
        (0.0f32, 0.0f32, 1.0f32, 1.0f32)
    } else {
        let svg_w = tree.size().width();
        let svg_h = tree.size().height();
        if svg_w <= 0.0 || svg_h <= 0.0 {
            return None;
        }
        let scale = (content_w / svg_w).min(content_h / svg_h);
        let paint_w = svg_w * scale;
        let paint_h = svg_h * scale;
        let position = host.primary_styles()?.clone_object_position();
        use ::style::values::computed::CSSPixelLength;
        let off_x = position
            .horizontal
            .resolve(CSSPixelLength::new(content_w - paint_w))
            .px();
        let off_y = position
            .vertical
            .resolve(CSSPixelLength::new(content_h - paint_h))
            .px();
        (off_x, off_y, scale, scale)
    };

    // Border-box origin of the host in viewport space; the svg's own
    // scroll offset is always zero, so absolute_position needs no add-back.
    let host_abs = doc_position(doc, host);
    let origin_x = host_abs.x + host_layout.padding.left + host_layout.border.left + fit_x;
    let origin_y = host_abs.y + host_layout.padding.top + host_layout.border.top + fit_y;
    let x0 = origin_x + bbox.x() * scale_x;
    let y0 = origin_y + bbox.y() * scale_y;
    let x1 = x0 + bbox.width() * scale_x;
    let y1 = y0 + bbox.height() * scale_y;

    let (x0, y0, x1, y1) = match composed_transform_for_node(doc, host.id()) {
        Some((composed, scale)) => {
            let local = kurbo::Rect::new(
                (x0 - host_abs.x) as f64 * scale,
                (y0 - host_abs.y) as f64 * scale,
                (x1 - host_abs.x) as f64 * scale,
                (y1 - host_abs.y) as f64 * scale,
            );
            let t = composed.transform_rect_bbox(local);
            (
                (t.x0 / scale) as f32,
                (t.y0 / scale) as f32,
                (t.x1 / scale) as f32,
                (t.y1 / scale) as f32,
            )
        }
        None => (x0, y0, x1, y1),
    };
    Some(Rect::resolved(x0, y0, x1 - x0, y1 - y0))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "setLayoutMode")]
    pub fn set_layout_mode(&self, mode: &str) {
        let new_mode = match mode {
            "off" | "OFF" | "Off" | "none" => LayoutMode::Off,
            _ => LayoutMode::Full,
        };
        let prev = self.layout_mode.get();
        if prev == new_mode {
            return;
        }
        self.layout_mode.set(new_mode);
        if new_mode == LayoutMode::Full {
            self.layout_dirty.set(true);
        }
    }

    #[wasm_bindgen(js_name = "layoutMode")]
    pub fn layout_mode_str(&self) -> String {
        match self.layout_mode.get() {
            LayoutMode::Full => "full".to_string(),
            LayoutMode::Off => "off".to_string(),
        }
    }

    #[wasm_bindgen(js_name = "viewportSize")]
    pub fn viewport_size(&self) -> Vec<u32> {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return vec![800, 600],
        };
        let v = doc.viewport();
        vec![v.window_size.0, v.window_size.1]
    }

    #[wasm_bindgen(
        js_name = "getBoundingClientRect",
        unchecked_return_type = "KsLayoutRect | null"
    )]
    pub fn get_bounding_client_rect(&self, node_id: u32) -> Result<JsValue, JsError> {
        if self.layout_mode.get() == LayoutMode::Off {
            return serde_wasm_bindgen::to_value(&Rect::ZERO)
                .map_err(|e| JsError::new(&e.to_string()));
        }
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id);
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let rect_result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let Some(node) = internal_id.and_then(|id| doc.get_node(id)) else {
                return Rect::ZERO;
            };
            bounding_rect_for_node(&doc, node)
        }));
        let rect = rect_result.unwrap_or(Rect::ZERO);
        serde_wasm_bindgen::to_value(&rect).map_err(|e| JsError::new(&e.to_string()))
    }

    /// ResizeObserver's two boxes in one call: `[contentWidth, contentHeight, borderWidth,
    /// borderHeight]` from the layout box, so transforms do not count. A node that generates no
    /// box measures zero. Empty when there is no layout to read, so the caller falls back to its
    /// CSSOM reads. With `resolve` false this reads the last committed layout.
    #[wasm_bindgen(js_name = "resizeObserverBoxes")]
    pub fn resize_observer_boxes(&self, node_id: u32, resolve: bool) -> Vec<f32> {
        if self.layout_mode.get() == LayoutMode::Off {
            return Vec::new();
        }
        if resolve {
            self.ensure_layout();
        }
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return Vec::new();
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let node = doc.get_node(internal_id)?;
            if !has_layout_data(node) {
                return None;
            }
            if !generates_box(&doc, node) {
                return Some(vec![0.0; 4]);
            }
            let layout = node.final_layout();
            let content_width = (layout.size.width
                - layout.border.left
                - layout.border.right
                - layout.padding.left
                - layout.padding.right)
                .max(0.0);
            let content_height = (layout.size.height
                - layout.border.top
                - layout.border.bottom
                - layout.padding.top
                - layout.padding.bottom)
                .max(0.0);
            Some(vec![
                content_width,
                content_height,
                layout.size.width,
                layout.size.height,
            ])
        }));
        drop(doc);
        result.ok().flatten().unwrap_or_default()
    }

    /// Compute one Intersection Observer geometry result.
    /// Margins are four `[value, is_percent]` pairs in top, right, bottom, left order.
    #[allow(
        clippy::too_many_arguments,
        reason = "The wasm ABI exposes these intersection geometry fields as scalar arguments."
    )]
    #[wasm_bindgen(js_name = "intersectionGeometry")]
    pub fn intersection_geometry(
        &self,
        target_id: u32,
        root_id: i32,
        root_margin: Vec<f32>,
        scroll_margin: Vec<f32>,
        scroll_x: f32,
        scroll_y: f32,
        resolve: bool,
    ) -> Result<String, JsError> {
        if resolve && self.layout_mode.get() != LayoutMode::Off {
            self.ensure_layout();
        }
        let target_internal = self.connected_node_id(target_id);
        let root_internal = (root_id >= 0).then(|| self.connected_node_id(root_id as u32));
        let doc = self
            .doc
            .try_borrow()
            .map_err(|e| JsError::new(&e.to_string()))?;
        let geometry = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let boxed = |id: Option<NodeId>| {
                id.and_then(|id| doc.get_node(id))
                    .map(|node| (node, bounding_rect_for_node(&doc, node)))
                    .filter(|(_, rect)| rect.has_box == Some(true))
            };
            let root = match root_internal {
                None => {
                    let (width, height) = doc.viewport().window_size;
                    Some([
                        scroll_x,
                        scroll_y,
                        scroll_x + width as f32,
                        scroll_y + height as f32,
                    ])
                }
                Some(id) => boxed(id).map(|(node, rect)| {
                    if overflow_clips(node) == (false, false) {
                        rect_edges(&rect)
                    } else {
                        padding_edges(node, rect_edges(&rect))
                    }
                }),
            };
            let target = boxed(target_internal);
            let Some(root) = root else {
                return IntersectionGeometry {
                    target: target
                        .map(|(_, rect)| GeometryRect::from_rect(&rect, scroll_x, scroll_y))
                        .unwrap_or(GeometryRect::ZERO),
                    root_bounds: None,
                    intersection_rect: GeometryRect::ZERO,
                    is_intersecting: false,
                    intersection_ratio: 0.0,
                };
            };
            let Some((target_node, target)) = target else {
                return IntersectionGeometry {
                    target: GeometryRect::ZERO,
                    root_bounds: Some(GeometryRect::ZERO),
                    intersection_rect: GeometryRect::ZERO,
                    is_intersecting: false,
                    intersection_ratio: 0.0,
                };
            };
            let [top, right, bottom, left] =
                resolve_margins(&root_margin, root[2] - root[0], root[3] - root[1]);
            let expanded = [
                root[0] - left,
                root[1] - top,
                root[2] + right,
                root[3] + bottom,
            ];
            let to_viewport = |[l, t, r, b]: [f32; 4]| {
                GeometryRect::from_edges(l - scroll_x, t - scroll_y, r - scroll_x, b - scroll_y)
            };
            let root_node = root_internal.flatten();
            let intersection = (root_node != Some(target_node.id()))
                .then(|| {
                    clip_to_containing_blocks(
                        &doc,
                        target_node,
                        root_node,
                        &scroll_margin,
                        rect_edges(&target),
                    )
                })
                .flatten()
                .and_then(|clipped| intersect_edges(clipped, expanded));
            let target_area = target.width * target.height;
            IntersectionGeometry {
                target: GeometryRect::from_rect(&target, scroll_x, scroll_y),
                root_bounds: Some(to_viewport(expanded)),
                intersection_rect: intersection.map_or(GeometryRect::ZERO, to_viewport),
                is_intersecting: intersection.is_some(),
                intersection_ratio: match intersection {
                    None => 0.0,
                    Some(_) if target_area <= 0.0 => 1.0,
                    Some([l, t, r, b]) => ((r - l) * (b - t) / target_area).min(1.0),
                },
            }
        }));
        drop(doc);
        let geometry = geometry.map_err(|_| JsError::new("intersection geometry panicked"))?;
        serde_json::to_string(&geometry).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(
        js_name = "offsetMetrics",
        unchecked_return_type = "KsOffsetMetrics | null"
    )]
    pub fn offset_metrics(&self, node_id: u32) -> Result<JsValue, JsError> {
        use ::style::properties::generated::longhands::position::computed_value::T as Position;
        if self.layout_mode.get() == LayoutMode::Off {
            return Ok(JsValue::NULL);
        }
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id);
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let node = doc.get_node(internal_id?)?;
            let root_element_id = doc.root_element().id();

            let local_name =
                |n: &Node| -> Option<String> { n.element_data().map(|e| e.name.local.to_string()) };
            let no_box = |d: ::style::values::specified::box_::Display| {
                use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
                d.outside() == DisplayOutside::None && d.inside() == DisplayInside::None
            };
            let has_layout_box = |id: NodeId| -> bool {
                let mut cur = Some(id);
                while let Some(cid) = cur {
                    let Some(n) = doc.get_node(cid) else {
                        return false;
                    };
                    if n.is_element() && no_box(n.display_constructed_as()) {
                        return false;
                    }
                    cur = n.parent_id();
                }
                true
            };

            let own_position = node
                .primary_styles()
                .map(|s| s.clone_position())
                .unwrap_or(Position::Static);
            let own_name = local_name(node).unwrap_or_default();

            let self_boxless = node
                .primary_styles()
                .map(|s| {
                    use ::style::values::specified::box_::DisplayOutside;
                    s.clone_display().outside() == DisplayOutside::None
                })
                .unwrap_or(true);

            if own_name == "body"
                || node.id() == root_element_id
                || !node.is_element()
                || self_boxless
                || !has_layout_box(node.id())
            {
                return Some(OffsetMetrics {
                    parent: -1.0,
                    top: 0.0,
                    left: 0.0,
                });
            }

            let generates_box = |p: &Node| -> bool {
                use ::style::values::specified::box_::DisplayOutside;
                p.primary_styles()
                    .map(|s| s.clone_display().outside() != DisplayOutside::None)
                    .unwrap_or(false)
            };
            let offset_parent: Option<NodeId> = if own_position == Position::Fixed {
                None
            } else {
                let mut found = None;
                let mut cur = node.parent_id();
                while let Some(pid) = cur {
                    let Some(p) = doc.get_node(pid) else { break };
                    if p.is_element() && generates_box(p) {
                        let p_pos = p
                            .primary_styles()
                            .map(|s| s.clone_position())
                            .unwrap_or(Position::Static);
                        let p_name = local_name(p).unwrap_or_default();
                        let table_part = own_position == Position::Static
                            && matches!(p_name.as_str(), "td" | "th" | "table");
                        if p_pos != Position::Static || p_name == "body" || table_part {
                            found = Some(pid);
                            break;
                        }
                    }
                    cur = p.parent_id();
                }
                found
            };

            let viewport_pos = |id: NodeId| -> Option<(f32, f32)> {
                let n = doc.get_node(id)?;
                let size = n.final_layout().size;
                if (size.width <= 0.0 || size.height <= 0.0) && id != root_element_id {
                    if let Some(r) = inline_aware_rect_for_node(&doc, id) {
                        return Some((r.x, r.y));
                    }
                }
                let raw = doc_position(&doc, n);
                Some((
                    raw.x + n.scroll_offset().x as f32,
                    raw.y + n.scroll_offset().y as f32,
                ))
            };

            let (node_x, node_y) = viewport_pos(node.id())?;
            let Some(op_id) = offset_parent else {
                return Some(OffsetMetrics {
                    parent: -1.0,
                    top: node_y as f64,
                    left: node_x as f64,
                });
            };
            let (op_x, op_y) = viewport_pos(op_id)?;
            let op = doc.get_node(op_id)?;
            let op_is_body = local_name(op).as_deref() == Some("body");
            let stop_id = if op_is_body { root_element_id } else { op_id };

            let mut scroll_x = 0.0f32;
            let mut scroll_y = 0.0f32;
            let mut cur = node.containing_block();
            let mut hops = 0;
            while let Some(cid) = cur {
                let Some(n) = doc.get_node(cid) else { break };
                scroll_x += n.scroll_offset().x as f32;
                scroll_y += n.scroll_offset().y as f32;
                if cid == stop_id {
                    break;
                }
                // The offsetParent came off the DOM parent chain; if it
                // isn't on the containing-block chain (fixed boxes), stop.
                if cid == root_element_id {
                    scroll_x = 0.0;
                    scroll_y = 0.0;
                    break;
                }
                hops += 1;
                if hops > 4096 {
                    break;
                }
                cur = n.containing_block();
            }

            if op_is_body {
                return Some(OffsetMetrics {
                    parent: f64::from(self.external_node_id(op_id)),
                    top: (node_y + scroll_y) as f64,
                    left: (node_x + scroll_x) as f64,
                });
            }
            let border = op.final_layout().border;
            Some(OffsetMetrics {
                parent: f64::from(self.external_node_id(op_id)),
                top: (node_y - op_y + scroll_y - border.top) as f64,
                left: (node_x - op_x + scroll_x - border.left) as f64,
            })
        }));
        match result.unwrap_or(None) {
            Some(m) => serde_wasm_bindgen::to_value(&m).map_err(|e| JsError::new(&e.to_string())),
            None => Ok(JsValue::NULL),
        }
    }

    #[wasm_bindgen(js_name = "setViewport")]
    pub fn set_viewport(&self, width: u32, height: u32) {
        use blitz_traits::shell::Viewport;
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        let current = doc.viewport();
        if current.window_size.0 == width && current.window_size.1 == height {
            return;
        }
        doc.set_viewport(Viewport::new(width, height, 1.0, emulated_color_scheme()));
        self.layout_dirty.set(true);
    }
}
