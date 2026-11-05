// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Hit testing: the element, caret, and pseudo-element at a point.

use std::panic;

use blitz_dom::node::SpecialElementData;
use blitz_dom::{BaseDocument, NodeData};
use blitz_traits::NodeId;
use wasm_bindgen::prelude::*;

use crate::{DomHandle, LayoutMode};

fn input_caret_from_point(doc: &mut BaseDocument, x: f32, y: f32) -> Option<(NodeId, usize)> {
    let hit = doc.hit(x, y)?;
    let input_id = hit.node_id;
    doc.with_text_input(input_id, |mut driver| driver.refresh_layout());
    let node = doc.get_node(input_id)?;
    let element = node.element_data()?;
    let SpecialElementData::TextInput(input) = element.special_data() else {
        return None;
    };
    let content_box_x = node.final_layout().padding.left + node.final_layout().border.left;
    let mut content_box_y = node.final_layout().padding.top + node.final_layout().border.top;
    let content_box_height = node.final_layout().content_box_height();
    let is_multiline = input.is_multiline;
    let scroll_offset = input.scroll_offset;
    let layout = input.editor.try_layout()?;
    if !is_multiline {
        let input_height = layout.height() / layout.scale();
        content_box_y += ((content_box_height - input_height) / 2.0).max(0.0);
    }
    let scale = doc.viewport().scale_f64();
    let scroll_offset = scroll_offset as f64 * scale;
    let (scroll_x, scroll_y) = if is_multiline {
        (0.0, scroll_offset)
    } else {
        (scroll_offset, 0.0)
    };
    let tx = (hit.x - content_box_x) as f64 * scale + scroll_x;
    let ty = (hit.y - content_box_y) as f64 * scale + scroll_y;
    let byte_offset = parley::editing::Cursor::from_point(layout, tx as f32, ty as f32).index();
    let offset = input
        .editor
        .raw_text()
        .get(..byte_offset)?
        .encode_utf16()
        .count();
    Some((input_id, offset))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "elementFromPoint")]
    pub fn element_from_point(&self, x: f32, y: f32) -> i32 {
        if self.layout_mode.get() == LayoutMode::Off {
            return -1;
        }
        self.ensure_layout();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let Some(hit) = doc.hit(x, y) else {
                return -1;
            };
            // CSSOM View returns an Element; map anonymous/text hits to the nearest
            // real element.
            let mut id = hit.node_id;
            loop {
                let Some(node) = doc.get_node(id) else {
                    return -1;
                };
                match &node.data {
                    NodeData::AnonymousBlock(_) | NodeData::Text(_) => match node.parent_id() {
                        Some(parent) => id = parent,
                        None => return -1,
                    },
                    _ => return self.external_node_id_i32(id),
                }
            }
        }));
        result.unwrap_or(-1)
    }

    #[wasm_bindgen(js_name = "caretFromPoint")]
    pub fn caret_from_point(&self, x: f32, y: f32) -> JsValue {
        if self.layout_mode.get() == LayoutMode::Off {
            return JsValue::NULL;
        }
        self.ensure_layout();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return JsValue::NULL,
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            input_caret_from_point(&mut doc, x, y).or_else(|| doc.dom_caret_from_point(x, y))
        }));
        match result {
            Ok(Some((node, offset))) => {
                let arr = js_sys::Array::new();
                arr.push(&JsValue::from_f64(f64::from(self.external_node_id(node))));
                arr.push(&JsValue::from_f64(offset as f64));
                arr.into()
            }
            _ => JsValue::NULL,
        }
    }

    #[wasm_bindgen(js_name = "pseudoKindAtPoint")]
    pub fn pseudo_kind_at_point(&self, x: f32, y: f32) -> i32 {
        if self.layout_mode.get() == LayoutMode::Off {
            return 0;
        }
        self.ensure_layout();
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let Some(hit) = doc.hit(x, y) else {
                return 0;
            };
            let mut id = hit.node_id;
            loop {
                let Some(node) = doc.get_node(id) else {
                    return 0;
                };
                if let Some(parent_id) = node.parent_id() {
                    if let Some(parent) = doc.get_node(parent_id) {
                        if parent.before() == Some(id) {
                            return 1;
                        }
                        if parent.after() == Some(id) {
                            return 2;
                        }
                    }
                }
                match &node.data {
                    NodeData::AnonymousBlock(_) | NodeData::Text(_) => match node.parent_id() {
                        Some(parent) => id = parent,
                        None => return 0,
                    },
                    _ => return 0,
                }
            }
        }));
        result.unwrap_or(0)
    }
}
