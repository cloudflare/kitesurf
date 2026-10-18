// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Computes sticky offsets from scroll containers, viewport overflow, and inset constraints.

use blitz_dom::{BaseDocument, NodeId};
use style::properties::generated::longhands::direction::computed_value::T as Direction;
use style::properties::generated::longhands::overflow_y::computed_value::T as Overflow;
use style::properties::generated::longhands::position::computed_value::T as Position;
use style::values::computed::Inset;
use style::values::computed::Margin;

const MAX_STICKY_ANCESTOR_DEPTH: usize = 4096;

#[derive(Clone, Copy, Default)]
pub(crate) struct PageScroll {
    pub x: f32,
    pub y: f32,
}

fn inset_px(inset: &Inset, scrollport_px: f32) -> Option<f32> {
    match inset {
        Inset::Auto => None,
        Inset::LengthPercentage(lp) => Some(
            lp.to_used_value(app_units::Au::from_f32_px(scrollport_px))
                .to_f32_px(),
        ),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Axis {
    X,
    Y,
}

#[derive(Clone, Copy)]
struct AxisRange {
    start: f32,
    end: f32,
}

fn overflow_propagates_to_viewport(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(root) = doc.try_root_element() else {
        return false;
    };
    if root.id == id {
        return true;
    }
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let is_body = node
        .element_data()
        .is_some_and(|e| e.name.local == blitz_dom::local_name!("body"));
    if !is_body || node.parent != Some(root.id) {
        return false;
    }
    root.primary_styles().is_some_and(|s| {
        let b = s.get_box();
        b.overflow_x == Overflow::Visible && b.overflow_y == Overflow::Visible
    })
}

fn is_scroll_container(doc: &BaseDocument, id: NodeId, axis: Axis) -> bool {
    if overflow_propagates_to_viewport(doc, id) {
        return false;
    }
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let Some(styles) = node.primary_styles() else {
        return false;
    };
    let o = match axis {
        Axis::X => styles.get_box().overflow_x,
        Axis::Y => styles.get_box().overflow_y,
    };
    matches!(o, Overflow::Scroll | Overflow::Auto | Overflow::Hidden)
}

fn scrollport_of(doc: &BaseDocument, id: NodeId, axis: Axis) -> (Option<NodeId>, bool) {
    let mut fixed_context = false;
    let mut cur = doc.get_node(id).and_then(|n| n.containing_block());
    while let Some(parent) = cur {
        if is_scroll_container(doc, parent, axis) {
            return (Some(parent), fixed_context);
        }
        if let Some(styles) = doc.get_node(parent).and_then(|n| n.primary_styles()) {
            if styles.clone_position() == Position::Fixed {
                fixed_context = true;
            }
        }
        cur = doc.get_node(parent).and_then(|n| n.containing_block());
    }
    (None, fixed_context)
}

fn used_margin(style_margin: &Margin, laid_out: f32) -> f32 {
    match style_margin {
        Margin::Auto => 0.0,
        _ => laid_out,
    }
}

fn laid_out_pos(doc: &BaseDocument, id: NodeId) -> Option<(f32, f32)> {
    let node = doc.get_node(id)?;
    // absolute_position subtracts every ancestor's scroll offset AND the
    // node's own, but a box doesn't move when it scrolls its own content.
    let abs = crate::layout::geometry::doc_position(doc, node);
    Some((
        abs.x + node.scroll_offset().x as f32,
        abs.y + node.scroll_offset().y as f32,
    ))
}

pub(crate) fn reset_departed_pins(
    doc: &mut BaseDocument,
    previous: &mut Vec<NodeId>,
    current: &[NodeId],
) {
    let mut moved = Vec::new();
    for id in previous.drain(..) {
        if current.contains(&id) {
            continue;
        }
        if let Some(node) = doc.get_node_mut(id) {
            if node.set_pin_offset(0.0, 0.0) {
                moved.push(id);
            }
        }
    }
    doc.note_boxes_moved(&moved);
    previous.extend_from_slice(current);
}

pub(crate) fn collect_sticky_nodes(doc: &BaseDocument) -> Vec<NodeId> {
    let mut ids = Vec::new();
    for (id, node) in doc.tree().iter() {
        let Some(styles) = node.primary_styles() else {
            continue;
        };
        if styles.clone_position() == Position::Sticky {
            ids.push(id);
        }
    }
    let depth = |mut id: NodeId| -> usize {
        let mut d = 0;
        while let Some(p) = doc.get_node(id).and_then(|n| n.containing_block()) {
            d += 1;
            id = p;
            if d > MAX_STICKY_ANCESTOR_DEPTH {
                break;
            }
        }
        d
    };
    ids.sort_by_key(|&id| depth(id));
    ids
}

fn axis_shift(
    static_pos: f32,
    size: f32,
    start_inset: Option<f32>,
    mut end_inset: Option<f32>,
    port: AxisRange,
    cb_range: AxisRange,
    end_first: bool,
) -> f32 {
    let port_start = port.start;
    let port_end = port.end;
    let mut start_inset = start_inset;
    if let (Some(s), Some(e)) = (start_inset, end_inset) {
        let port_size = port_end - port_start;
        if port_size - s - e < size {
            if end_first {
                start_inset = Some((port_size - e - size).min(s));
            } else {
                end_inset = Some((port_size - s - size).min(e));
            }
        }
    }
    let pin_start = |shift: &mut f32| {
        if let Some(start) = start_inset {
            *shift = (port_start + start - static_pos).max(0.0);
        }
    };
    let pin_end = |shift: &mut f32| {
        if let Some(end) = end_inset {
            *shift = (port_end - end - (static_pos + size)).min(0.0);
        }
    };
    let mut shift = 0.0f32;
    if end_first {
        pin_end(&mut shift);
        if shift == 0.0 {
            pin_start(&mut shift);
        }
    } else {
        pin_start(&mut shift);
        if shift == 0.0 {
            pin_end(&mut shift);
        }
    }
    let max_down = cb_range.end - (static_pos + size);
    let max_up = cb_range.start - static_pos;
    shift.clamp(max_up.min(0.0), max_down.max(0.0))
}

pub(crate) fn apply_sticky_offsets(
    doc: &mut BaseDocument,
    sticky_ids: &[NodeId],
    page_scroll: PageScroll,
    insets_out: &mut std::collections::HashMap<NodeId, [Option<f32>; 4]>,
) {
    if sticky_ids.is_empty() {
        return;
    }

    let mut moved = Vec::new();
    for &id in sticky_ids {
        let Some(computed) = compute_shift(doc, id, page_scroll) else {
            continue;
        };
        insets_out.insert(id, computed.insets);
        if let Some(node) = doc.get_node_mut(id) {
            if node.set_pin_offset(computed.shift_x, computed.shift_y) {
                moved.push(id);
            }
        }
    }
    doc.note_boxes_moved(&moved);
}

struct StickyShift {
    shift_x: f32,
    shift_y: f32,
    insets: [Option<f32>; 4],
}

fn compute_shift(doc: &BaseDocument, id: NodeId, page_scroll: PageScroll) -> Option<StickyShift> {
    {
        let node = doc.get_node(id)?;
        let styles = node.primary_styles()?;
        let rtl = node
            .layout_parent
            .get()
            .and_then(|p| doc.get_node(p))
            .and_then(|p| p.primary_styles())
            .map(|s| s.clone_direction())
            .unwrap_or_else(|| styles.clone_direction())
            == Direction::Rtl;
        let pos = styles.get_position();
        let style_margin = styles.get_margin();
        let size = node.final_layout().size;
        let laid_margin = node.final_layout().margin;
        let margin = (
            used_margin(&style_margin.margin_left, laid_margin.left),
            used_margin(&style_margin.margin_top, laid_margin.top),
            used_margin(&style_margin.margin_right, laid_margin.right),
            used_margin(&style_margin.margin_bottom, laid_margin.bottom),
        );

        let (laid_x, laid_y) = laid_out_pos(doc, id)?;
        // Remove the prior absolute pin before recomputing from layout position.
        let pinned = doc.get_node(id)?.pin_offset();
        let static_x = laid_x - pinned.x;
        let static_y = laid_y - pinned.y;

        let port_rect = |axis: Axis| -> Option<(f32, f32, f32, f32)> {
            let (port_node, fixed_context) = scrollport_of(doc, id, axis);
            match port_node {
                Some(port) => {
                    let p = doc.get_node(port)?;
                    let abs = crate::layout::geometry::doc_position(doc, p);
                    let border = p.final_layout().border;
                    let left = abs.x + p.scroll_offset().x as f32 + border.left;
                    let top = abs.y + p.scroll_offset().y as f32 + border.top;
                    let w = (p.final_layout().size.width - border.left - border.right).max(0.0);
                    let h = (p.final_layout().size.height - border.top - border.bottom).max(0.0);
                    Some((left, top, left + w, top + h))
                }
                None => {
                    let v = doc.viewport();
                    let w = v.window_size.0 as f32 / v.scale();
                    let h = v.window_size.1 as f32 / v.scale();
                    let (sx, sy) = if fixed_context {
                        (0.0, 0.0)
                    } else {
                        (page_scroll.x, page_scroll.y)
                    };
                    Some((sx, sy, sx + w, sy + h))
                }
            }
        };
        let (port_l, _, port_r, _) = port_rect(Axis::X)?;
        let (_, port_t, _, port_b) = port_rect(Axis::Y)?;

        let top = inset_px(&pos.top, port_b - port_t);
        let bottom = inset_px(&pos.bottom, port_b - port_t);
        let left = inset_px(&pos.left, port_r - port_l);
        let right = inset_px(&pos.right, port_r - port_l);

        let cb = node
            .layout_parent
            .get()
            .and_then(|p| {
                let pid = p;
                doc.get_node(p).map(|p| (pid, p))
            })
            .map(|(pid, p)| {
                // The children's coordinate frame is the SCROLLED content:
                // absolute_position already subtracts p's own scroll, keep it.
                let abs = crate::layout::geometry::doc_position(doc, p);
                let (px, py) = (abs.x, abs.y);
                let l = p.final_layout().border;
                let pad = p.final_layout().padding;
                let client_w = (p.final_layout().size.width - l.left - l.right).max(0.0);
                let client_h = (p.final_layout().size.height - l.top - l.bottom).max(0.0);
                let mut content_w = (client_w - pad.left - pad.right).max(0.0);
                let mut content_h = (client_h - pad.top - pad.bottom).max(0.0);
                if is_scroll_container(doc, pid, Axis::X) {
                    let scrollable =
                        client_w + p.final_layout().scroll_width() - pad.left - pad.right;
                    content_w = content_w.max(scrollable);
                }
                if is_scroll_container(doc, pid, Axis::Y) {
                    let scrollable =
                        client_h + p.final_layout().scroll_height() - pad.top - pad.bottom;
                    content_h = content_h.max(scrollable);
                }
                let content_l = px + l.left + pad.left;
                let content_t = py + l.top + pad.top;
                (
                    AxisRange {
                        start: content_l + margin.0,
                        end: content_l + content_w - margin.2,
                    },
                    AxisRange {
                        start: content_t + margin.1,
                        end: content_t + content_h - margin.3,
                    },
                )
            })
            .unwrap_or((
                AxisRange {
                    start: f32::MIN,
                    end: f32::MAX,
                },
                AxisRange {
                    start: f32::MIN,
                    end: f32::MAX,
                },
            ));

        let shift_x = axis_shift(
            static_x,
            size.width,
            left,
            right,
            AxisRange {
                start: port_l,
                end: port_r,
            },
            cb.0,
            rtl,
        );
        let shift_y = axis_shift(
            static_y,
            size.height,
            top,
            bottom,
            AxisRange {
                start: port_t,
                end: port_b,
            },
            cb.1,
            false,
        );
        Some(StickyShift {
            shift_x,
            shift_y,
            insets: [top, right, bottom, left],
        })
    }
}
