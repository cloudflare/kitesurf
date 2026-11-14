// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Computed and resolved style values for `getComputedStyle` and CDP.

use std::panic;

use blitz_dom::BaseDocument;
use blitz_traits::NodeId;
use serde::Serialize;
use ::style::properties::{property_counts, LonghandId, NonCustomPropertyId, ShorthandId};
use taffy::CoreStyle;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode};

/// The style traversal culls `display: none` subtrees, so their elements store no styles;
/// `getComputedStyle` still reports them, resolved on demand and not stored.
fn element_styles(
    doc: &BaseDocument,
    node: &blitz_dom::Node,
) -> Option<::style::servo_arc::Arc<::style::properties::ComputedValues>> {
    match node.primary_styles() {
        Some(styles) => Some(::style::servo_arc::Arc::clone(&styles)),
        None => doc.resolve_undisplayed_style(node.id()),
    }
}

fn grid_template_resolved(doc: &BaseDocument, node_id: NodeId, columns: bool) -> Option<String> {
    let info = doc.grid_track_info(node_id)?;
    let mut tracks = if columns {
        info.columns.clone()
    } else {
        info.rows.clone()
    };
    let total = tracks.positions.len();
    let neg = tracks.negative_implicit_tracks as usize;
    let expl = tracks.explicit_tracks as usize;
    if total > neg + expl && tracks.positions[total - 1].start == tracks.positions[total - 1].end {
        tracks.positions.pop();
    }
    if tracks.positions.is_empty() {
        return None;
    }
    let mut out = String::new();
    tracks.write_track_list(&mut out, 1.0).ok()?;
    Some(out)
}

/// Per-element facts that decide whether a longhand reports a used value from layout.
#[derive(Clone, Copy)]
struct LonghandContext {
    has_box: bool,
    rendered_layout_box: bool,
    width_applies: bool,
    layout_margin_available: bool,
}

impl LonghandContext {
    fn new(
        doc: &blitz_dom::BaseDocument,
        node: &blitz_dom::Node,
        styles: &::style::properties::ComputedValues,
    ) -> Self {
        Self {
            has_box: has_own_box(styles),
            rendered_layout_box: rendered_layout_box(doc, node, styles),
            width_applies: width_applies(node, styles),
            layout_margin_available: layout_margin_available(styles),
        }
    }

    /// Whether the used size and box metrics come from this element's layout box.
    fn has_layout_box(&self) -> bool {
        self.has_box && self.rendered_layout_box && self.width_applies
    }
}

/// Whether the element generates a box at all: `display: none` and `contents` do not.
fn has_own_box(styles: &::style::properties::ComputedValues) -> bool {
    use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
    let display = styles.get_box().clone_display();
    !(display.outside() == DisplayOutside::None && display.inside() == DisplayInside::None)
        && display.inside() != DisplayInside::Contents
}

/// Whether the element has a layout box connected to the document, not only a computed display.
fn rendered_layout_box(
    doc: &blitz_dom::BaseDocument,
    node: &blitz_dom::Node,
    styles: &::style::properties::ComputedValues,
) -> bool {
    use ::style::values::specified::box_::DisplayOutside;
    let no_box = |d: ::style::values::specified::box_::Display| {
        use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
        d.outside() == DisplayOutside::None && d.inside() == DisplayInside::None
    };
    let root_id = doc.root_node().id();
    let mut connected = node.id() == root_id;
    let mut has_box = if node.id() == root_id {
        node.display_constructed_as().outside() != DisplayOutside::None
    } else {
        styles.clone_display().outside() != DisplayOutside::None
    };
    let mut cur = node.parent_id();
    while has_box {
        let Some(pid) = cur else { break };
        let Some(parent) = doc.get_node(pid) else {
            break;
        };
        if parent.is_element() && no_box(parent.display_constructed_as()) {
            has_box = false;
            break;
        }
        if pid == root_id {
            connected = true;
            break;
        }
        cur = parent.parent_id();
    }
    has_box && connected
}

/// Whether a width resolves here. An element styled on demand has no box, and `layout_style()`
/// needs stored styles.
fn width_applies(node: &blitz_dom::Node, styles: &::style::properties::ComputedValues) -> bool {
    use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
    if node.primary_styles().is_none() {
        return false;
    }
    let display = styles.clone_display();
    CoreStyle::is_replaced(&node.layout_style())
        || display.outside() != DisplayOutside::Inline
        || display.inside() != DisplayInside::Flow
}

/// Whether layout resolves this element's margins: a floating or inline box has none of its own.
fn layout_margin_available(styles: &::style::properties::ComputedValues) -> bool {
    use ::style::values::specified::box_::DisplayOutside;
    !styles.clone_float().is_floating()
        && !matches!(
            styles.clone_display().outside(),
            DisplayOutside::Inline | DisplayOutside::InternalTable
        )
}

#[derive(Serialize)]
pub(crate) struct CdpComputedProp {
    pub(crate) name: String,
    pub(crate) value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    computed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unresolved: Option<String>,
}

impl CdpComputedProp {
    /// A resolved value, keeping the plain computed serialization only when it differs.
    fn resolved(
        name: &str,
        value: String,
        computed: Option<String>,
        unresolved: Option<String>,
    ) -> Self {
        Self {
            name: name.to_string(),
            computed: computed.filter(|computed| computed != &value),
            value,
            unresolved,
        }
    }
}

/// Preserve CSSOM's `-webkit-line-clamp` name for Stylo's disabled longhand.
fn computed_prop_name(id: LonghandId) -> &'static str {
    if id == LonghandId::LineClamp
        && !::style::properties::PropertyId::NonCustom(id.into()).enabled_for_all_content()
    {
        return "-webkit-line-clamp";
    }
    NonCustomPropertyId::from(id).name()
}

/// Whether Typed OM may need the plain computed serialization in addition to
/// CSSOM's resolved value. Most longhands are byte-for-byte identical, so
/// serializing both for every bulk style fetch only doubles their work.
fn needs_plain_computed_value(id: LonghandId) -> bool {
    matches!(
        id,
        LonghandId::AccentColor
            | LonghandId::AnimationDuration
            | LonghandId::BackdropFilter
            | LonghandId::BackgroundColor
            | LonghandId::BackgroundImage
            | LonghandId::BorderBlockEndColor
            | LonghandId::BorderBlockStartColor
            | LonghandId::BorderBottomColor
            | LonghandId::BorderImageSource
            | LonghandId::BorderInlineEndColor
            | LonghandId::BorderInlineStartColor
            | LonghandId::BorderLeftColor
            | LonghandId::BorderRightColor
            | LonghandId::BorderTopColor
            | LonghandId::BoxShadow
            | LonghandId::CaretColor
            | LonghandId::ColumnRuleColor
            | LonghandId::Color
            | LonghandId::Content
            | LonghandId::Fill
            | LonghandId::Filter
            | LonghandId::ListStyleImage
            | LonghandId::MaskImage
            | LonghandId::OutlineColor
            | LonghandId::ScrollbarColor
            | LonghandId::ShapeOutside
            | LonghandId::Stroke
            | LonghandId::TextDecorationColor
            | LonghandId::TextEmphasisColor
            | LonghandId::TextShadow
            | LonghandId::WebkitTextFillColor
    ) || computed_style_overrides(id)
}

fn computed_style_overrides(id: LonghandId) -> bool {
    matches!(
        id,
        LonghandId::GridTemplateColumns
            | LonghandId::GridTemplateRows
            | LonghandId::Transform
            | LonghandId::TransformOrigin
            | LonghandId::PerspectiveOrigin
            | LonghandId::Width
            | LonghandId::Height
            | LonghandId::InlineSize
            | LonghandId::BlockSize
            | LonghandId::MarginTop
            | LonghandId::MarginRight
            | LonghandId::MarginBottom
            | LonghandId::MarginLeft
            | LonghandId::MarginBlockStart
            | LonghandId::MarginBlockEnd
            | LonghandId::MarginInlineStart
            | LonghandId::MarginInlineEnd
            | LonghandId::PaddingTop
            | LonghandId::PaddingRight
            | LonghandId::PaddingBottom
            | LonghandId::PaddingLeft
            | LonghandId::PaddingBlockStart
            | LonghandId::PaddingBlockEnd
            | LonghandId::PaddingInlineStart
            | LonghandId::PaddingInlineEnd
            | LonghandId::MinWidth
            | LonghandId::MinHeight
            | LonghandId::MinInlineSize
            | LonghandId::MinBlockSize
            | LonghandId::Top
            | LonghandId::Right
            | LonghandId::Bottom
            | LonghandId::Left
            | LonghandId::InsetBlockStart
            | LonghandId::InsetBlockEnd
            | LonghandId::InsetInlineStart
            | LonghandId::InsetInlineEnd
    )
}

// ---- helpers ------------------------------------------------------

/// Serialize CSSOM's resolved transform as Blink's `matrix()` or `matrix3d()` value.
/// Percentages use the border box; numbers use six significant digits.
fn resolved_transform(
    transform: &::style::values::computed::Transform,
    width: f32,
    height: f32,
) -> String {
    type CLen = ::style::values::computed::Length;
    if transform.0.is_empty() {
        return "none".to_string();
    }
    let reference = euclid::default::Rect::new(
        euclid::point2(CLen::new(0.0), CLen::new(0.0)),
        euclid::size2(CLen::new(width), CLen::new(height)),
    );
    let Ok((m, _)) = transform.to_transform_3d_matrix_f64(Some(&reference)) else {
        return "none".to_string();
    };
    // Blink chooses matrix() by the matrix being affine, not by the functions used, so
    // translateZ(0) still reads back as 2D. Snap first: rotateX(360deg) leaves sin's ~2e-16.
    let a = m.to_array().map(snap_near_zero);
    let affine = [2, 3, 6, 7, 8, 9, 11, 14].iter().all(|&i| a[i] == 0.0)
        && (a[10] - 1.0).abs() < 1e-12
        && (a[15] - 1.0).abs() < 1e-12;
    let (name, values) = if affine {
        ("matrix", vec![a[0], a[1], a[4], a[5], a[12], a[13]])
    } else {
        ("matrix3d", a.to_vec())
    };
    let values: Vec<String> = values.into_iter().map(css_number_g6).collect();
    format!("{name}({})", values.join(", "))
}

/// Snap trigonometric residue so quarter-turn rotations match Blink.
fn snap_near_zero(v: f64) -> f64 {
    if v.abs() < 1e-12 {
        0.0
    } else {
        v
    }
}

/// C's `%.6g`, which Blink's resolved-value numbers follow, with near-zero snapped to 0.
pub(crate) fn css_number_g6(v: f64) -> String {
    let v = snap_near_zero(v);
    if v == 0.0 {
        return "0".to_string();
    }
    let trim = |s: String| -> String {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            s
        }
    };
    let sci = format!("{v:.5e}");
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    if !(-4..6).contains(&exponent) {
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!("{}e{sign}{:02}", trim(mantissa.to_string()), exponent.abs());
    }
    let decimals = (5 - exponent).max(0) as usize;
    trim(format!("{v:.decimals$}"))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "computedStylePseudo")]
    pub fn computed_style_pseudo(&self, node_id: u32, pseudo: &str) -> Result<JsValue, JsError> {
        use ::style::selector_parser::PseudoElement as P;
        use ::style::stylist::RuleInclusion;
        if self.layout_mode.get() == LayoutMode::Off {
            return serde_wasm_bindgen::to_value(&Vec::<CdpComputedProp>::new())
                .map_err(|e| JsError::new(&e.to_string()));
        }
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id);
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Ok(JsValue::NULL),
        };
        let normalized = pseudo.trim().trim_start_matches(':').to_ascii_lowercase();
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let Some(node) = internal_id.and_then(|id| doc.get_node(id)) else {
                return Vec::new();
            };
            let Some(primary) = element_styles(&doc, node) else {
                return Vec::new();
            };
            let pseudo_enum = match normalized.as_str() {
                "before" => P::Before,
                "after" => P::After,
                "selection" => P::Selection,
                "first-letter" => P::FirstLetter,
                "marker" => P::Marker,
                _ => return Vec::new(),
            };
            let use_eager =
                pseudo_enum.is_eager() && !pseudo_enum.is_lazy_painted_highlight_pseudo();
            let lazy = || {
                let guard = doc.guard().read();
                let guards = ::style::shared_lock::StylesheetGuards::same(&guard);
                doc.stylist.lazily_compute_pseudo_element_style(
                    &guards,
                    node,
                    &pseudo_enum,
                    RuleInclusion::All,
                    &primary,
                    false,
                    None,
                )
            };
            let stored = if use_eager {
                node.stylo_element_data()
                    .get()
                    .and_then(|d| d.styles.pseudos.get(&pseudo_enum).cloned())
            } else {
                None
            };
            let styles = if use_eager {
                stored.or_else(lazy)
            } else {
                lazy()
            };
            let Some(styles) = styles else {
                return Vec::new();
            };
            let n = property_counts::LONGHANDS;
            let mut out: Vec<CdpComputedProp> = Vec::with_capacity(n);
            // SAFETY: LonghandId is repr(u16) with consecutive values from the
            // generated property list that defines `LONGHANDS`.
            for i in 0..(n as u16) {
                let id: LonghandId = unsafe { std::mem::transmute::<u16, LonghandId>(i) };
                let mut computed = needs_plain_computed_value(id).then(String::new);
                if let Some(computed) = computed.as_mut() {
                    if styles
                        .computed_or_resolved_value(id, None, computed)
                        .is_err()
                    {
                        continue;
                    }
                }
                let mut value = String::new();
                let mut resolved_ctx = ::style::values::resolved::Context {
                    style: &styles,
                    for_property: ::style::properties::PropertyId::NonCustom(id.into()),
                    current_longhand: None,
                };
                if styles
                    .computed_or_resolved_value(id, Some(&mut resolved_ctx), &mut value)
                    .is_err()
                {
                    continue;
                }
                let name = computed_prop_name(id);
                out.push(CdpComputedProp {
                    name: name.to_string(),
                    computed: computed.filter(|computed| computed != &value),
                    value,
                    unresolved: None,
                });
            }
            out
        }));
        match result {
            Ok(props) => {
                serde_wasm_bindgen::to_value(&props).map_err(|e| JsError::new(&e.to_string()))
            }
            Err(_) => serde_wasm_bindgen::to_value(&Vec::<CdpComputedProp>::new())
                .map_err(|e| JsError::new(&e.to_string())),
        }
    }

    #[wasm_bindgen(js_name = "computedStyle")]
    pub fn computed_style(&self, node_id: u32) -> Result<JsValue, JsError> {
        match self.computed_props(node_id) {
            Some(props) => {
                serde_wasm_bindgen::to_value(&props).map_err(|e| JsError::new(&e.to_string()))
            }
            None => Ok(JsValue::NULL),
        }
    }

    /// Every longhand's `getComputedStyle` entry; `None` while the document is borrowed.
    pub(crate) fn computed_props(&self, node_id: u32) -> Option<Vec<CdpComputedProp>> {
        if self.layout_mode.get() == LayoutMode::Off {
            return Some(Vec::new());
        }
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id);
        let doc = self.doc.try_borrow().ok()?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Some(node) = internal_id.and_then(|id| doc.get_node(id)) else {
                return Vec::new();
            };
            let Some(styles) = element_styles(&doc, node) else {
                return Vec::new();
            };
            let cx = LonghandContext::new(&doc, node, &styles);
            let n = property_counts::LONGHANDS;
            let mut out: Vec<CdpComputedProp> = Vec::with_capacity(n);
            // SAFETY: LonghandId is repr(u16) with consecutive values from the
            // generated property list that defines `LONGHANDS`.
            for i in 0..(n as u16) {
                let id: LonghandId = unsafe { std::mem::transmute::<u16, LonghandId>(i) };
                out.extend(self.resolved_longhand(&doc, node, &styles, &cx, id));
            }
            out
        }));
        Some(result.unwrap_or_default())
    }

    /// One longhand's `getComputedStyle` entry, `None` when Stylo cannot serialize it. Needs
    /// up-to-date layout: sizes, margins, paddings and transforms read used values.
    fn resolved_longhand(
        &self,
        doc: &blitz_dom::BaseDocument,
        node: &blitz_dom::Node,
        styles: &::style::properties::ComputedValues,
        cx: &LonghandContext,
        id: LonghandId,
    ) -> Option<CdpComputedProp> {
        let mut computed = needs_plain_computed_value(id).then(String::new);
        if let Some(plain) = computed.as_mut() {
            if styles.computed_or_resolved_value(id, None, plain).is_err() {
                return None;
            }
        }
        if let Some((name, value)) = own_value_longhand(doc, node, styles, id) {
            return Some(CdpComputedProp::resolved(name, value, computed, None));
        }

        let mut value = resolved_value(styles, id)?;
        if let Some(used) = used_box_metric(node, styles, id, &value, cx) {
            value = used;
        }
        if let Some(used) = min_size_used_value(doc, node, id, &value, cx) {
            value = used;
        }
        if let Some(used) = self.sticky_inset_used_value(node, styles, id, cx) {
            value = used;
        }

        let unresolved = unresolved_alternative(styles, id, &value);
        Some(CdpComputedProp::resolved(
            computed_prop_name(id),
            value,
            computed,
            unresolved,
        ))
    }

    /// A sticky element's inset reports the offset layout actually applied to it.
    fn sticky_inset_used_value(
        &self,
        node: &blitz_dom::Node,
        styles: &::style::properties::ComputedValues,
        id: LonghandId,
        cx: &LonghandContext,
    ) -> Option<String> {
        if !cx.has_box || !is_inset_longhand(id) {
            return None;
        }
        use ::style::logical_geometry::{LogicalSide, PhysicalSide, WritingMode};
        use ::style::properties::generated::longhands::position::computed_value::T as Position;
        if styles.clone_position() != Position::Sticky {
            return None;
        }
        let insets = self.sticky_resolved_insets(node.id())?;
        let wm = WritingMode::new(styles.get_inherited_box());
        let physical = match id {
            LonghandId::Top => PhysicalSide::Top,
            LonghandId::Right => PhysicalSide::Right,
            LonghandId::Bottom => PhysicalSide::Bottom,
            LonghandId::Left => PhysicalSide::Left,
            LonghandId::InsetBlockStart => LogicalSide::BlockStart.to_physical(wm),
            LonghandId::InsetBlockEnd => LogicalSide::BlockEnd.to_physical(wm),
            LonghandId::InsetInlineStart => LogicalSide::InlineStart.to_physical(wm),
            LonghandId::InsetInlineEnd => LogicalSide::InlineEnd.to_physical(wm),
            _ => unreachable!(),
        };
        let index = match physical {
            PhysicalSide::Top => 0,
            PhysicalSide::Right => 1,
            PhysicalSide::Bottom => 2,
            PhysicalSide::Left => 3,
        };
        use style_traits::ToCss as _;
        type CLen = ::style::values::computed::Length;
        Some(CLen::new(insets[index]?).to_css_string())
    }

    // `--name`'s computed value with var() substituted, "" when unset. Scripts parseInt() CSS
    // variables read this way, and "" for a set one gave them NaN.
    fn computed_custom_property(&self, node_id: u32, name: &str) -> Option<String> {
        if name.is_empty() {
            return None;
        }
        self.ensure_style();
        let internal_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            use style_traits::ToCss as _;
            let styles = element_styles(&doc, doc.get_node(internal_id)?)?;
            let atom = ::stylo_atoms::Atom::from(name);
            let value = styles.custom_properties().get_for_cssom(&atom);
            Some(value.map(|v| v.to_css_string()).unwrap_or_default())
        }))
        .ok()
        .flatten()
    }

    #[wasm_bindgen(js_name = "computedStyleValue")]
    pub fn computed_style_value(&self, node_id: u32, name: &str) -> Option<String> {
        if self.layout_mode.get() == LayoutMode::Off {
            return None;
        }
        // computedStyle's bulk list holds longhands only, so a custom property answers here.
        if let Some(custom) = name.strip_prefix("--") {
            return self.computed_custom_property(node_id, custom);
        }
        let id = ::style::properties::PropertyId::parse_enabled_for_all_content(name)
            .ok()?
            .longhand_id()?;
        if NonCustomPropertyId::from(id).name() != name {
            return None;
        }
        if computed_style_overrides(id) {
            // Used values: lay out and resolve exactly as the bulk computedStyle does.
            self.ensure_layout();
            let internal_id = self.resolve_node_id(node_id)?;
            let doc = self.doc.try_borrow().ok()?;
            return std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let node = doc.get_node(internal_id)?;
                let styles = element_styles(&doc, node)?;
                let cx = LonghandContext::new(&doc, node, &styles);
                Some(self.resolved_longhand(&doc, node, &styles, &cx, id)?.value)
            }))
            .ok()
            .flatten();
        }
        self.ensure_style();
        let internal_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let styles = element_styles(&doc, doc.get_node(internal_id)?)?;
            let mut value = String::new();
            let mut ctx = ::style::values::resolved::Context {
                style: &styles,
                for_property: ::style::properties::PropertyId::NonCustom(id.into()),
                current_longhand: None,
            };
            styles
                .computed_or_resolved_value(id, Some(&mut ctx), &mut value)
                .ok()?;
            Some(value)
        }))
        .ok()
        .flatten()
    }
}

/// Longhands for the physical and logical inset offsets.
fn is_inset_longhand(id: LonghandId) -> bool {
    matches!(
        id,
        LonghandId::Top
            | LonghandId::Right
            | LonghandId::Bottom
            | LonghandId::Left
            | LonghandId::InsetBlockStart
            | LonghandId::InsetBlockEnd
            | LonghandId::InsetInlineStart
            | LonghandId::InsetInlineEnd
    )
}

/// A longhand whose value comes from the box or transform rather than Stylo's resolved value.
fn own_value_longhand(
    doc: &BaseDocument,
    node: &blitz_dom::Node,
    styles: &::style::properties::ComputedValues,
    id: LonghandId,
) -> Option<(&'static str, String)> {
    match id {
        LonghandId::GridTemplateColumns | LonghandId::GridTemplateRows => {
            let columns = id == LonghandId::GridTemplateColumns;
            let value = grid_template_resolved(doc, node.id(), columns)?;
            Some((NonCustomPropertyId::from(id).name(), value))
        }
        LonghandId::Transform => Some(("transform", transform_value(node, styles))),
        LonghandId::TransformOrigin | LonghandId::PerspectiveOrigin => {
            let value = origin_value(node, styles, id);
            Some((NonCustomPropertyId::from(id).name(), value))
        }
        _ => None,
    }
}

/// Blink's resolved `transform`: `none` without a box, else the matrix of the used size.
fn transform_value(node: &blitz_dom::Node, styles: &::style::properties::ComputedValues) -> String {
    use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
    let display = styles.get_box().clone_display();
    let boxless = (display.outside() == DisplayOutside::None
        && display.inside() == DisplayInside::None)
        || display.inside() == DisplayInside::Contents;
    if boxless {
        return "none".to_string();
    }
    let size = node.final_layout().size;
    resolved_transform(&styles.get_box().clone_transform(), size.width, size.height)
}

/// `transform-origin` or `perspective-origin` resolved against the used border box.
fn origin_value(
    node: &blitz_dom::Node,
    styles: &::style::properties::ComputedValues,
    id: LonghandId,
) -> String {
    use style_traits::ToCss as _;
    type CLen = ::style::values::computed::Length;
    let size = node.final_layout().size;
    let box_style = styles.get_box();
    let px = |l: CLen| l.to_css_string();
    if id == LonghandId::TransformOrigin {
        let origin = box_style.clone_transform_origin();
        let x = origin.horizontal.resolve(CLen::new(size.width));
        let y = origin.vertical.resolve(CLen::new(size.height));
        return if origin.depth.px() == 0.0 {
            format!("{} {}", px(x), px(y))
        } else {
            format!("{} {} {}", px(x), px(y), px(origin.depth))
        };
    }
    let origin = box_style.clone_perspective_origin();
    let x = origin.horizontal.resolve(CLen::new(size.width));
    let y = origin.vertical.resolve(CLen::new(size.height));
    format!("{} {}", px(x), px(y))
}

/// Stylo's CSSOM resolved value for one longhand.
fn resolved_value(styles: &::style::properties::ComputedValues, id: LonghandId) -> Option<String> {
    let mut value = String::new();
    let mut ctx = ::style::values::resolved::Context {
        style: styles,
        for_property: ::style::properties::PropertyId::NonCustom(id.into()),
        current_longhand: None,
    };
    styles
        .computed_or_resolved_value(id, Some(&mut ctx), &mut value)
        .ok()?;
    Some(value)
}

/// Longhands whose used value is read from the laid-out box.
fn is_used_box_metric(id: LonghandId) -> bool {
    matches!(
        id,
        LonghandId::Width
            | LonghandId::Height
            | LonghandId::InlineSize
            | LonghandId::BlockSize
            | LonghandId::MarginTop
            | LonghandId::MarginRight
            | LonghandId::MarginBottom
            | LonghandId::MarginLeft
            | LonghandId::MarginBlockStart
            | LonghandId::MarginBlockEnd
            | LonghandId::MarginInlineStart
            | LonghandId::MarginInlineEnd
            | LonghandId::PaddingTop
            | LonghandId::PaddingRight
            | LonghandId::PaddingBottom
            | LonghandId::PaddingLeft
            | LonghandId::PaddingBlockStart
            | LonghandId::PaddingBlockEnd
            | LonghandId::PaddingInlineStart
            | LonghandId::PaddingInlineEnd
    )
}

/// The used size, margin, or padding this longhand reports from layout, when it has one.
fn used_box_metric(
    node: &blitz_dom::Node,
    styles: &::style::properties::ComputedValues,
    id: LonghandId,
    value: &str,
    cx: &LonghandContext,
) -> Option<String> {
    if !cx.has_layout_box() || !is_used_box_metric(id) {
        return None;
    }
    let is_size = matches!(
        id,
        LonghandId::Width | LonghandId::Height | LonghandId::InlineSize | LonghandId::BlockSize
    );
    let is_margin = matches!(
        id,
        LonghandId::MarginTop
            | LonghandId::MarginRight
            | LonghandId::MarginBottom
            | LonghandId::MarginLeft
            | LonghandId::MarginBlockStart
            | LonghandId::MarginBlockEnd
            | LonghandId::MarginInlineStart
            | LonghandId::MarginInlineEnd
    );
    if !(is_size || value.contains('%')) || (is_margin && !cx.layout_margin_available) {
        return None;
    }

    use ::style::logical_geometry::{LogicalSide, PhysicalSide, WritingMode};
    use style_traits::ToCss as _;
    type CLen = ::style::values::computed::Length;
    let px = |v: f32| CLen::new(v).to_css_string();
    let layout = node.unrounded_layout();
    let wm = WritingMode::new(styles.get_inherited_box());
    let margin = layout.margin;
    let padding = layout.padding;
    let border_box = styles.clone_box_sizing()
        == ::style::properties::generated::longhands::box_sizing::computed_value::T::BorderBox;
    let used_width = if border_box {
        layout.size.width
    } else {
        layout.content_box_width()
    };
    let used_height = if border_box {
        layout.size.height
    } else {
        layout.content_box_height()
    };
    let margin_at = |side: LogicalSide| -> f32 {
        match side.to_physical(wm) {
            PhysicalSide::Top => margin.top,
            PhysicalSide::Right => margin.right,
            PhysicalSide::Bottom => margin.bottom,
            PhysicalSide::Left => margin.left,
        }
    };
    let padding_at = |side: LogicalSide| -> f32 {
        match side.to_physical(wm) {
            PhysicalSide::Top => padding.top,
            PhysicalSide::Right => padding.right,
            PhysicalSide::Bottom => padding.bottom,
            PhysicalSide::Left => padding.left,
        }
    };
    Some(match id {
        LonghandId::Width => px(used_width),
        LonghandId::Height => px(used_height),
        LonghandId::InlineSize => px(if wm.is_vertical() {
            used_height
        } else {
            used_width
        }),
        LonghandId::BlockSize => px(if wm.is_vertical() {
            used_width
        } else {
            used_height
        }),
        LonghandId::MarginTop => px(margin.top),
        LonghandId::MarginRight => px(margin.right),
        LonghandId::MarginBottom => px(margin.bottom),
        LonghandId::MarginLeft => px(margin.left),
        LonghandId::MarginBlockStart => px(margin_at(LogicalSide::BlockStart)),
        LonghandId::MarginBlockEnd => px(margin_at(LogicalSide::BlockEnd)),
        LonghandId::MarginInlineStart => px(margin_at(LogicalSide::InlineStart)),
        LonghandId::MarginInlineEnd => px(margin_at(LogicalSide::InlineEnd)),
        LonghandId::PaddingTop => px(padding.top),
        LonghandId::PaddingRight => px(padding.right),
        LonghandId::PaddingBottom => px(padding.bottom),
        LonghandId::PaddingLeft => px(padding.left),
        LonghandId::PaddingBlockStart => px(padding_at(LogicalSide::BlockStart)),
        LonghandId::PaddingBlockEnd => px(padding_at(LogicalSide::BlockEnd)),
        LonghandId::PaddingInlineStart => px(padding_at(LogicalSide::InlineStart)),
        LonghandId::PaddingInlineEnd => px(padding_at(LogicalSide::InlineEnd)),
        _ => unreachable!(),
    })
}

/// `min-*: auto` reads as `0px` outside a flex or grid item, where Stylo leaves it unresolved.
fn min_size_used_value(
    doc: &BaseDocument,
    node: &blitz_dom::Node,
    id: LonghandId,
    value: &str,
    cx: &LonghandContext,
) -> Option<String> {
    if !cx.has_box || value != "auto" {
        return None;
    }
    if !matches!(
        id,
        LonghandId::MinWidth
            | LonghandId::MinHeight
            | LonghandId::MinInlineSize
            | LonghandId::MinBlockSize
    ) {
        return None;
    }
    use ::style::values::specified::box_::DisplayInside;
    let is_flex_or_grid_item = node
        .layout_parent_id()
        .and_then(|p| doc.get_node(p))
        .and_then(|p| p.primary_styles())
        .is_some_and(|s| {
            matches!(
                s.get_box().clone_display().inside(),
                DisplayInside::Flex | DisplayInside::Grid
            )
        });
    if is_flex_or_grid_item {
        return None;
    }
    Some("0px".to_string())
}

/// Typed OM's `computed` alternative for `text-decoration-color`, when the shorthand differs.
fn unresolved_alternative(
    styles: &::style::properties::ComputedValues,
    id: LonghandId,
    value: &str,
) -> Option<String> {
    if id != LonghandId::TextDecorationColor {
        return None;
    }
    let mut alternative = String::new();
    let mut ctx = ::style::values::resolved::Context {
        style: styles,
        for_property: ::style::properties::PropertyId::NonCustom(
            ShorthandId::TextDecoration.into(),
        ),
        current_longhand: None,
    };
    match styles.computed_or_resolved_value(id, Some(&mut ctx), &mut alternative) {
        Ok(()) if alternative != value => Some(alternative),
        _ => None,
    }
}
