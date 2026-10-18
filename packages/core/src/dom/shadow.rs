// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Shadow roots and slot assignment.

use blitz_dom::node::ShadowRootMode;
use wasm_bindgen::prelude::*;

use crate::DomHandle;

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "attachShadow")]
    pub fn attach_shadow(&self, host_id: u32, mode: &str) -> i32 {
        let mode = match mode {
            "open" => ShadowRootMode::Open,
            "closed" => ShadowRootMode::Closed,
            _ => return -1,
        };
        let Some(host_id) = self.resolve_node_id(host_id) else {
            return -1;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        let is_element = doc
            .get_node(host_id)
            .map(|n| n.element_data().is_some())
            .unwrap_or(false);
        if !is_element {
            return -1;
        }
        let mut mutr = doc.mutate();
        let id = mutr.attach_shadow(host_id, mode);
        drop(mutr);
        self.layout_dirty.set(true);
        self.external_node_id_i32(id)
    }

    #[wasm_bindgen(js_name = "shadowRootId")]
    pub fn shadow_root_id(&self, host_id: u32) -> i32 {
        let Some(host_id) = self.resolve_node_id(host_id) else {
            return -1;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        doc.get_node(host_id)
            .and_then(|n| n.attached_shadow_root_id())
            .map(|id| self.external_node_id_i32(id))
            .unwrap_or(-1)
    }

    #[wasm_bindgen(js_name = "assignedNodesOf")]
    pub fn assigned_nodes_of(&self, slot_id: u32) -> Vec<u32> {
        let Some(slot_id) = self.resolve_node_id(slot_id) else {
            return Vec::new();
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        doc.flush_slot_assignments();
        doc.get_node(slot_id)
            .and_then(|n| n.assigned_nodes.as_ref())
            .map(|v| {
                v.iter()
                    .copied()
                    .map(|id| self.external_node_id(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "assignedSlotOf")]
    pub fn assigned_slot_of(&self, node_id: u32) -> i32 {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        doc.flush_slot_assignments();
        doc.get_node(node_id)
            .and_then(|n| n.assigned_slot)
            .map(|id| self.external_node_id_i32(id))
            .unwrap_or(-1)
    }

    #[wasm_bindgen(js_name = "containingShadowRootId")]
    pub fn containing_shadow_root_id(&self, node_id: u32) -> i32 {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        doc.get_node(node_id)
            .and_then(|n| n.containing_shadow_root_id())
            .map(|id| self.external_node_id_i32(id))
            .unwrap_or(-1)
    }

    #[wasm_bindgen(js_name = "detachedRoots")]
    pub fn detached_roots(&self, node_ids: Vec<u32>) -> Vec<i32> {
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return vec![-1; node_ids.len()],
        };
        let root = doc.root_node().id;
        let mut out = Vec::with_capacity(node_ids.len());
        for external in node_ids {
            let Some(mut cur) = self.resolve_node_id(external) else {
                out.push(-2);
                continue;
            };
            if doc.get_node(cur).is_none() {
                out.push(-2);
                continue;
            }
            for _ in 0..100_000 {
                let Some(node) = doc.get_node(cur) else { break };
                if let Some(p) = node.parent {
                    cur = p;
                } else if let Some(d) = node.shadow_root_data() {
                    cur = d.host;
                } else {
                    break;
                }
            }
            out.push(if cur == root {
                -1
            } else {
                self.external_node_id_i32(cur)
            });
        }
        drop(doc);
        out
    }

    #[wasm_bindgen(js_name = "shadowHostId")]
    pub fn shadow_host_id(&self, node_id: u32) -> i32 {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return -1,
        };
        doc.get_node(node_id)
            .and_then(|n| n.shadow_root_data())
            .map(|d| self.external_node_id_i32(d.host))
            .unwrap_or(-1)
    }
}
