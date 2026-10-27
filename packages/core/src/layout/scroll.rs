// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Scroll containers, scroll offsets, and sticky positioning.

use blitz_dom::local_name;
use blitz_traits::NodeId;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::DomHandle;
use crate::dom::tree::has_layout_data;

pub(crate) fn overflow_clips(node: &blitz_dom::Node) -> (bool, bool) {
    use ::style::values::computed::Overflow;
    node.primary_styles().map_or((false, false), |styles| {
        (
            styles.clone_overflow_x() != Overflow::Visible,
            styles.clone_overflow_y() != Overflow::Visible,
        )
    })
}

pub(crate) fn is_scroll_container(node: &blitz_dom::Node) -> bool {
    use ::style::values::computed::Overflow;
    node.primary_styles().is_some_and(|styles| {
        [styles.clone_overflow_x(), styles.clone_overflow_y()]
            .iter()
            .any(|o| matches!(o, Overflow::Hidden | Overflow::Scroll | Overflow::Auto))
    })
}

// The TypeScript shapes of ScrollInfo and ScrollOffset.
#[wasm_bindgen(typescript_custom_section)]
const TS_SCROLL: &str = r#"
export interface KsScrollInfo {
    scrollTop: number;
    scrollLeft: number;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    clientTop: number;
    clientLeft: number;
    contentWidth: number;
    contentHeight: number;
    hasBox: boolean;
    overflowsX: boolean;
    overflowsY: boolean;
    userScrollableX: boolean;
    userScrollableY: boolean;
    stopScrollChainX: boolean;
    stopScrollChainY: boolean;
}
export interface KsScrollOffset {
    x: number;
    y: number;
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScrollInfo {
    scroll_top: f64,
    scroll_left: f64,
    scroll_width: f64,
    pub(crate) scroll_height: f64,
    client_width: f64,
    client_height: f64,
    client_top: f64,
    client_left: f64,
    content_width: f64,
    content_height: f64,
    has_box: bool,
    overflows_x: bool,
    overflows_y: bool,
    user_scrollable_x: bool,
    user_scrollable_y: bool,
    stop_scroll_chain_x: bool,
    stop_scroll_chain_y: bool,
}

#[derive(Serialize)]
pub(crate) struct ScrollOffset {
    x: f64,
    pub(crate) y: f64,
}

#[wasm_bindgen]
impl DomHandle {
    pub(crate) fn apply_sticky(&self, after_layout: bool) {
        let mut nodes = match self.sticky_nodes.try_borrow_mut() {
            Ok(n) => n,
            Err(_) => return,
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        let mut insets = match self.sticky_insets.try_borrow_mut() {
            Ok(i) => i,
            Err(_) => return,
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if after_layout {
                *nodes = crate::layout::sticky::collect_sticky_nodes(doc.as_ref());
                if let Ok(mut previous) = self.pinned_nodes.try_borrow_mut() {
                    crate::layout::sticky::reset_departed_pins(doc.as_mut(), &mut previous, &nodes);
                }
                insets.retain(|id, _| nodes.contains(id));
            }
            if nodes.is_empty() {
                return;
            }
            crate::layout::sticky::apply_sticky_offsets(
                doc.as_mut(),
                &nodes,
                self.page_scroll.get(),
                &mut insets,
            );
        }));
    }

    pub(crate) fn sticky_resolved_insets(&self, id: NodeId) -> Option<[Option<f32>; 4]> {
        self.sticky_insets.try_borrow().ok()?.get(&id).copied()
    }

    #[wasm_bindgen(js_name = "stickyShift")]
    pub fn sticky_shift(&self, node_id: u32) -> Vec<f32> {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return vec![0.0, 0.0];
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return vec![0.0, 0.0];
        };
        let Some(node) = doc.as_ref().get_node(node_id) else {
            return vec![0.0, 0.0];
        };
        // scrollIntoView subtracts sticky shifts only. Fixed boxes keep
        // no pin_offset: paint cancels the viewport scroll for them.
        use ::style::properties::generated::longhands::position::computed_value::T as Position;
        let sticky = node
            .primary_styles()
            .is_some_and(|s| s.clone_position() == Position::Sticky);
        if !sticky {
            return vec![0.0, 0.0];
        }
        vec![node.pin_offset().x, node.pin_offset().y]
    }

    #[wasm_bindgen(js_name = "setPageScroll")]
    pub fn set_page_scroll(&self, x: f64, y: f64) {
        let next = crate::layout::sticky::PageScroll {
            x: x as f32,
            y: y as f32,
        };
        let cur = self.page_scroll.get();
        if (cur.x - next.x).abs() < 0.01 && (cur.y - next.y).abs() < 0.01 {
            return;
        }
        self.page_scroll.set(next);
        if let Ok(mut doc) = self.doc.try_borrow_mut() {
            doc.as_mut().set_viewport_scroll(blitz_dom::Point { x, y });
        }
        if !self.layout_dirty.get() {
            self.apply_sticky(false);
        }
    }

    #[wasm_bindgen(
        js_name = "nodeScrollInfo",
        unchecked_return_type = "KsScrollInfo | null"
    )]
    pub fn node_scroll_info(&self, node_id: u32) -> Result<JsValue, JsError> {
        match self.read_scroll_info(node_id) {
            Some(i) => serde_wasm_bindgen::to_value(&i).map_err(|e| JsError::new(&e.to_string())),
            None => Ok(JsValue::NULL),
        }
    }

    pub(crate) fn read_scroll_info(&self, node_id: u32) -> Option<ScrollInfo> {
        use ::style::properties::generated::longhands::position::computed_value::T as Position;
        use ::style::values::computed::{Overflow, OverscrollBehavior};
        self.ensure_layout();
        let internal_id = self.resolve_node_id(node_id);
        let doc = self.doc.try_borrow().ok()?;
        let info_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let node = internal_id.and_then(|id| doc.get_node(id))?;
            if !has_layout_data(node) {
                return None;
            }
            let layout = node.final_layout();
            let (
                overflows_x,
                overflows_y,
                user_scrollable_x,
                user_scrollable_y,
                stop_scroll_chain_x,
                stop_scroll_chain_y,
            ) = node
                .primary_styles()
                .map(|styles| {
                    let ox = styles.clone_overflow_x();
                    let oy = styles.clone_overflow_y();
                    let overscroll_x = styles.clone_overscroll_behavior_x();
                    let overscroll_y = styles.clone_overscroll_behavior_y();
                    (
                        matches!(ox, Overflow::Scroll | Overflow::Auto | Overflow::Hidden),
                        matches!(oy, Overflow::Scroll | Overflow::Auto | Overflow::Hidden),
                        matches!(ox, Overflow::Scroll | Overflow::Auto),
                        matches!(oy, Overflow::Scroll | Overflow::Auto),
                        matches!(
                            overscroll_x,
                            OverscrollBehavior::Contain | OverscrollBehavior::None
                        ),
                        matches!(
                            overscroll_y,
                            OverscrollBehavior::Contain | OverscrollBehavior::None
                        ),
                    )
                })
                .unwrap_or((false, false, false, false, false, false));
            let no_box = |d: ::style::values::specified::box_::Display| {
                use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
                d.outside() == DisplayOutside::None && d.inside() == DisplayInside::None
            };
            let mut has_box = !no_box(*node.display_constructed_as());
            if has_box {
                let root_id = doc.root_node().id;
                let mut connected = node.id == root_id;
                let mut cur = node.parent;
                while let Some(pid) = cur {
                    let Some(p) = doc.get_node(pid) else { break };
                    if p.is_element() && no_box(*p.display_constructed_as()) {
                        has_box = false;
                        break;
                    }
                    if pid == root_id {
                        connected = true;
                        break;
                    }
                    cur = p.parent;
                }
                if !connected {
                    has_box = false;
                }
            }
            let mut scroll_width = layout.scroll_width();
            let mut scroll_height = layout.scroll_height();
            if node.id == doc.root_element().id {
                scroll_width = 0.0;
                scroll_height = 0.0;
                let root_client_width =
                    (layout.size.width - layout.border.left - layout.border.right).max(0.0);
                let root_client_height =
                    (layout.size.height - layout.border.top - layout.border.bottom).max(0.0);
                let body_layout = doc.root_element().children.iter().find_map(|child_id| {
                    let child = doc.get_node(*child_id)?;
                    (child
                        .element_data()
                        .is_some_and(|element| element.name.local == local_name!("body"))
                        && child
                            .primary_styles()
                            .is_none_or(|styles| styles.clone_position() != Position::Fixed))
                    .then(|| child.final_layout())
                });
                if let Some(body_layout) = body_layout {
                    let body_bottom = body_layout.location.y
                        + body_layout.size.height
                        + body_layout.scroll_height();
                    let body_right = body_layout.location.x
                        + body_layout.size.width
                        + body_layout.scroll_width();
                    scroll_width = (body_right - root_client_width).max(0.0);
                    scroll_height = (body_bottom - root_client_height).max(0.0);
                }
                // Root and root-hoisted abspos children contribute to document
                // scroll; fixed boxes do not.
                let layout_children = doc.root_element().layout_children.borrow();
                let hoisted_children = doc.root_element().hoisted_children.borrow();
                let root_children = layout_children
                    .iter()
                    .flatten()
                    .chain(hoisted_children.iter());
                for child in root_children.filter_map(|id| doc.get_node(*id)) {
                    if child
                        .primary_styles()
                        .is_some_and(|styles| styles.clone_position() == Position::Fixed)
                    {
                        continue;
                    }
                    let child_layout = child.final_layout();
                    let child_right = child_layout.location.x
                        + child_layout.size.width
                        + child_layout.scroll_width();
                    let child_bottom = child_layout.location.y
                        + child_layout.size.height
                        + child_layout.scroll_height();
                    scroll_width = scroll_width.max(child_right - root_client_width);
                    scroll_height = scroll_height.max(child_bottom - root_client_height);
                }
            }
            Some(ScrollInfo {
                scroll_top: node.scroll_offset().y,
                scroll_left: node.scroll_offset().x,
                scroll_width: scroll_width as f64,
                scroll_height: scroll_height as f64,
                client_width: (layout.size.width - layout.border.left - layout.border.right)
                    .max(0.0) as f64,
                client_height: (layout.size.height - layout.border.top - layout.border.bottom)
                    .max(0.0) as f64,
                client_top: layout.border.top as f64,
                client_left: layout.border.left as f64,
                content_width: (layout.size.width
                    - layout.border.left
                    - layout.border.right
                    - layout.padding.left
                    - layout.padding.right)
                    .max(0.0) as f64,
                content_height: (layout.size.height
                    - layout.border.top
                    - layout.border.bottom
                    - layout.padding.top
                    - layout.padding.bottom)
                    .max(0.0) as f64,
                has_box,
                overflows_x,
                overflows_y,
                user_scrollable_x,
                user_scrollable_y,
                stop_scroll_chain_x,
                stop_scroll_chain_y,
            })
        }));
        info_result.unwrap_or(None)
    }

    #[wasm_bindgen(
        js_name = "setNodeScrollOffset",
        unchecked_return_type = "KsScrollOffset | null"
    )]
    pub fn set_node_scroll_offset(&self, node_id: u32, x: f64, y: f64) -> Result<JsValue, JsError> {
        match self.write_scroll_offset(node_id, x, y) {
            Some(o) => serde_wasm_bindgen::to_value(&o).map_err(|e| JsError::new(&e.to_string())),
            None => Ok(JsValue::NULL),
        }
    }

    pub(crate) fn write_scroll_offset(&self, node_id: u32, x: f64, y: f64) -> Option<ScrollOffset> {
        let node_id = self.resolve_node_id(node_id)?;
        let mut doc = self.doc.try_borrow_mut().ok()?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let node = doc.get_node_mut(node_id)?;
            if !has_layout_data(node) {
                return None;
            }
            let layout = node.final_layout();
            let scroll_width = layout.scroll_width() as f64;
            let scroll_height = layout.scroll_height() as f64;
            let clamped_x = x.clamp(0.0, scroll_width.max(0.0));
            let clamped_y = y.clamp(0.0, scroll_height.max(0.0));
            node.scroll_offset_mut().x = clamped_x;
            node.scroll_offset_mut().y = clamped_y;
            doc.note_boxes_moved(&[node_id]);
            Some(ScrollOffset {
                x: clamped_x,
                y: clamped_y,
            })
        }));
        let offset = result.unwrap_or(None);
        drop(doc);
        if offset.is_some() {
            self.apply_sticky(false);
        }
        offset
    }

    #[wasm_bindgen(js_name = "scrollNodeBy")]
    pub fn scroll_node_by(&self, node_id: u32, dx: f64, dy: f64) -> bool {
        self.ensure_layout();
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.scroll_node_by_has_changed(node_id, -dx, -dy, |_event| {})
        }));
        drop(doc);
        let scrolled = res.unwrap_or(false);
        if scrolled {
            self.apply_sticky(false);
        }
        scrolled
    }
}
