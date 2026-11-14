// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Form-control state, focus, and the DOM selection.

use wasm_bindgen::prelude::*;

use crate::DomHandle;

#[wasm_bindgen]
impl DomHandle {
    /// Update live checkedness and restyle the input and parent for `:checked` siblings.
    /// The `checked` attribute is `defaultChecked` and stays untouched; rebuilt paint documents
    /// serialize live checkedness instead. Returns false for stale or non-checkable IDs.
    #[wasm_bindgen(js_name = "setCheckboxChecked")]
    pub fn set_checkbox_checked(&self, node_id: u32, checked: bool) -> bool {
        let Some(nid) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(nid).is_none() {
            return false;
        }

        doc.snapshot_node(nid);

        {
            use blitz_dom::local_name;
            use blitz_dom::node::SpecialElementData;
            let Some(node) = doc.get_node_mut(nid) else {
                return false;
            };
            let Some(elem) = node.element_data_mut() else {
                return false;
            };
            if elem.name.local != local_name!("input") {
                return false;
            }
            match elem.special_data_mut() {
                Some(SpecialElementData::CheckboxInput(slot)) => {
                    *slot = checked;
                }
                // `special_data_mut` yields `None` for `SpecialElementData::None`.
                None => {
                    elem.set_special_data(SpecialElementData::CheckboxInput(checked));
                }
                Some(_) => return false,
            }
        }

        {
            use ::style::invalidation::element::restyle_hints::RestyleHint;
            let parent_id = doc.get_node(nid).and_then(|n| n.parent_id());
            if let Some(node) = doc.get_node_mut(nid) {
                if let Some(mut data) = node.stylo_element_data_mut().get_mut() {
                    data.hint |= RestyleHint::restyle_subtree();
                }
            }
            if let Some(pid) = parent_id {
                if let Some(parent) = doc.get_node_mut(pid) {
                    if let Some(mut data) = parent.stylo_element_data_mut().get_mut() {
                        data.hint |= RestyleHint::restyle_subtree();
                    }
                }
            }
            if let Some(node) = doc.get_node(nid) {
                node.mark_ancestors_dirty();
            }
        }

        drop(doc);
        self.layout_dirty.set(true);
        true
    }

    #[wasm_bindgen(js_name = "setInputText")]
    pub fn set_input_text(&self, node_id: u32, value: &str) -> bool {
        let Some(nid) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        {
            use blitz_dom::node::SpecialElementData;
            let is_range = doc
                .get_node(nid)
                .and_then(|n| n.element_data())
                .map(|e| matches!(e.special_data(), SpecialElementData::RangeInput(_)))
                .unwrap_or(false);
            if is_range {
                let Ok(v) = value.parse::<f64>() else {
                    return false;
                };
                if !v.is_finite() {
                    return false;
                }
                doc.snapshot_node(nid);
                if let Some(elem) = doc.get_node_mut(nid).and_then(|n| n.element_data_mut()) {
                    elem.set_special_data(SpecialElementData::RangeInput(Box::new(v)));
                }
                if let Some(node) = doc.get_node(nid) {
                    node.mark_ancestors_dirty();
                }
                drop(doc);
                self.layout_dirty.set(true);
                return true;
            }
        }
        let changed = doc.mutate().set_text_input_value(nid, value);
        drop(doc);
        if changed {
            self.layout_dirty.set(true);
        }
        changed
    }

    #[wasm_bindgen(js_name = "setInputSelection")]
    pub fn set_input_selection(&self, node_id: u32, start: u32, end: u32) -> bool {
        let Some(nid) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        let changed = doc
            .mutate()
            .set_text_input_selection(nid, start as usize, end as usize);
        drop(doc);
        if changed {
            self.layout_dirty.set(true);
        }
        changed
    }

    #[wasm_bindgen(js_name = "setFocus")]
    pub fn set_focus(&self, node_id: u32) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if doc.get_node(node_id).is_none() {
            return false;
        }
        let changed = doc.set_focus_to(node_id);
        drop(doc);
        if changed {
            self.layout_dirty.set(true);
        }
        changed
    }

    #[wasm_bindgen(js_name = "getFocusedNodeId")]
    pub fn get_focused_node_id(&self) -> i32 {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        match doc.get_focussed_node_id() {
            Some(id) => self.external_node_id_i32(id),
            None => -1,
        }
    }

    #[wasm_bindgen(js_name = "clearFocus")]
    pub fn clear_focus(&self) {
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        let had_focus = doc.get_focussed_node_id().is_some();
        doc.clear_focus();
        drop(doc);
        if had_focus {
            self.layout_dirty.set(true);
        }
    }

    #[wasm_bindgen(js_name = "setDomSelection")]
    pub fn set_dom_selection(
        &self,
        anchor_id: u32,
        anchor_offset: u32,
        focus_id: u32,
        focus_offset: u32,
    ) -> bool {
        let (Some(anchor_id), Some(focus_id)) = (
            self.resolve_node_id(anchor_id),
            self.resolve_node_id(focus_id),
        ) else {
            return false;
        };
        self.ensure_layout();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return false,
        };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.set_dom_selection(
                anchor_id,
                anchor_offset as usize,
                focus_id,
                focus_offset as usize,
            )
        }));
        r.unwrap_or(false)
    }

    #[wasm_bindgen(js_name = "clearDomSelection")]
    pub fn clear_dom_selection(&self) {
        if let Ok(mut doc) = self.doc.try_borrow_mut() {
            doc.clear_text_selection();
        }
    }
}
