// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Debug dumps of layout state, and test-only layout probes.

use blitz_dom::BaseDocument;
use blitz_traits::NodeId;
use wasm_bindgen::prelude::*;

use crate::DomHandle;
use crate::dom::tree::{collect_descendants, collect_descendants_with_pseudos};
#[cfg(test)]
use crate::layout::geometry::bounding_rect_for_node;

fn debug_write_pseudo_child(
    handle: &DomHandle,
    base: &BaseDocument,
    child_id: NodeId,
    out: &mut String,
) {
    use std::fmt::Write;
    let Some(child) = base.get_node(child_id) else {
        return;
    };
    if let Some(text) = child.text_data() {
        let _ = writeln!(
            out,
            "    child #{}: text={:?}",
            handle.external_node_id(child_id),
            text.content.as_str()
        );
    } else {
        let _ = writeln!(
            out,
            "    child #{}: (non-text)",
            handle.external_node_id(child_id)
        );
    }
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "debugDumpNodeChildren")]
    pub fn debug_dump_node_children(&self, node_id: u32) -> String {
        use std::fmt::Write;
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return format!("no node #{}", node_id);
        };
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let Some(node) = base.get_node(internal_id) else {
            return format!("no node #{}", node_id);
        };
        let mut out = String::new();
        let _ = writeln!(out, "node #{} children:", node_id);
        let _ = writeln!(
            out,
            "  before: {:?}",
            node.pe_by_index(1).map(|id| self.external_node_id(id))
        );
        let _ = writeln!(
            out,
            "  after: {:?}",
            node.pe_by_index(0).map(|id| self.external_node_id(id))
        );
        let children: Vec<u32> = node
            .children()
            .iter()
            .map(|id| self.external_node_id(id))
            .collect();
        let _ = writeln!(out, "  children: {:?}", children);
        if let Some(pc) = node.paint_children() {
            let paint_children: Vec<u32> = pc.iter().map(|&id| self.external_node_id(id)).collect();
            let _ = writeln!(out, "  paint_children: {:?}", paint_children);
        } else {
            let _ = writeln!(out, "  paint_children: None");
        }
        if let Some(sc) = node.stacking_context() {
            let _ = writeln!(
                out,
                "  stacking_context children: {:?}",
                sc.children
                    .iter()
                    .map(|c| {
                        let position = c.position(base.tree(), internal_id);
                        (
                            self.external_node_id(c.node_id),
                            c.z_index,
                            (position.x, position.y),
                        )
                    })
                    .collect::<Vec<_>>()
            );
        } else {
            let _ = writeln!(out, "  stacking_context: None");
        }
        out
    }

    #[wasm_bindgen(js_name = "debugDumpNodeLayout")]
    pub fn debug_dump_node_layout(&self, node_id: u32) -> String {
        use std::fmt::Write;
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return format!("no node #{}", node_id);
        };
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let Some(node) = base.get_node(internal_id) else {
            return format!("no node #{}", node_id);
        };
        let mut out = String::new();
        let lay = node.final_layout();
        let abs = node.absolute_position(0.0, 0.0);
        let parent = node.layout_parent_id().map(|id| self.external_node_id(id));
        let _ = writeln!(
            out,
            "node #{}: location=({:.1},{:.1}), size={:.1}x{:.1}, absolute=({:.1},{:.1}), layout_parent={:?}",
            node_id,
            lay.location.x, lay.location.y,
            lay.size.width, lay.size.height,
            abs.x, abs.y,
            parent,
        );
        let _ = writeln!(
            out,
            "  border=({:.1},{:.1},{:.1},{:.1}) padding=({:.1},{:.1},{:.1},{:.1})",
            lay.border.left,
            lay.border.right,
            lay.border.top,
            lay.border.bottom,
            lay.padding.left,
            lay.padding.right,
            lay.padding.top,
            lay.padding.bottom,
        );
        if let Some(elem) = node.element_data() {
            let _ = writeln!(out, "  tag=<{}>", elem.name.local);
        }
        if let Some(styles) = node.primary_styles() {
            let pos = styles.clone_position();
            let _ = writeln!(out, "  position={:?}", pos);
        }
        out
    }

    #[wasm_bindgen(js_name = "debugDumpPseudoElements")]
    pub fn debug_dump_pseudo_elements(&self, node_id: u32) -> String {
        use std::fmt::Write;
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return format!("no node #{}", node_id);
        };
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let Some(node) = base.get_node(internal_id) else {
            return format!("no node #{}", node_id);
        };
        let mut out = String::new();
        let lay = node.final_layout();
        let _ = writeln!(
            out,
            "node #{} @ ({:.1}, {:.1}) {:.1}x{:.1} pseudo-elements:",
            node_id, lay.location.x, lay.location.y, lay.size.width, lay.size.height,
        );
        for (label, pe_id) in [
            ("::before", node.pe_by_index(1)),
            ("::after", node.pe_by_index(0)),
        ] {
            match pe_id {
                None => {
                    let _ = writeln!(out, "  {}: none", label);
                }
                Some(id) => {
                    let external_id = self.external_node_id(id);
                    let _ = writeln!(out, "  {}: pe-node-id={}", label, external_id);
                    if let Some(pe_node) = base.get_node(id) {
                        let pl = pe_node.final_layout();
                        let _ = writeln!(
                            out,
                            "    pe layout: ({:.1}, {:.1}) {:.1}x{:.1}",
                            pl.location.x, pl.location.y, pl.size.width, pl.size.height,
                        );
                        let children: Vec<u32> = pe_node
                            .children()
                            .iter()
                            .map(|id| self.external_node_id(id))
                            .collect();
                        let _ = writeln!(out, "    children: {:?}", children);
                        if let Some(styles) = pe_node.primary_styles() {
                            let f = styles.get_font();
                            let _ =
                                writeln!(out, "    font-size={:?}", f.font_size.used_size.0.px());
                            let display = styles.clone_display();
                            let _ = writeln!(out, "    display={:?}", display);
                            let counters = styles.get_counters();
                            let _ = writeln!(out, "    content={:?}", counters.content);
                        } else {
                            let _ = writeln!(out, "    no primary_styles");
                        }
                        for child_id in pe_node.children() {
                            debug_write_pseudo_child(self, base, child_id, &mut out);
                        }
                    }
                }
            }
        }
        out
    }

    #[wasm_bindgen(js_name = "debugDumpBorderColors")]
    pub fn debug_dump_border_colors(&self, node_id: u32) -> String {
        use std::fmt::Write;
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return format!("no node #{}", node_id);
        };
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let Some(node) = base.get_node(internal_id) else {
            return format!("no node #{}", node_id);
        };
        let Some(primary) = node.primary_styles() else {
            return format!("node #{} has no primary_styles", node_id);
        };
        let current_color = primary.clone_color();
        let border = primary.get_border();
        let top = border.border_top_color.resolve_to_absolute(&current_color);
        let right = border
            .border_right_color
            .resolve_to_absolute(&current_color);
        let bottom = border
            .border_bottom_color
            .resolve_to_absolute(&current_color);
        let left = border.border_left_color.resolve_to_absolute(&current_color);
        let mut out = String::new();
        let _ = writeln!(out, "node #{} border colors:", node_id);
        let _ = writeln!(out, "  top    = {:?}", top);
        let _ = writeln!(out, "  right  = {:?}", right);
        let _ = writeln!(out, "  bottom = {:?}", bottom);
        let _ = writeln!(out, "  left   = {:?}", left);
        let _ = writeln!(out, "  border-top-style    = {:?}", border.border_top_style);
        let _ = writeln!(
            out,
            "  border-right-style  = {:?}",
            border.border_right_style
        );
        let _ = writeln!(
            out,
            "  border-bottom-style = {:?}",
            border.border_bottom_style
        );
        let _ = writeln!(
            out,
            "  border-left-style   = {:?}",
            border.border_left_style
        );
        out
    }

    #[wasm_bindgen(js_name = "debugDumpLineOffsets")]
    pub fn debug_dump_line_offsets(&self) -> String {
        use std::fmt::Write;
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let mut out = String::new();
        let mut all_ids: Vec<u32> = Vec::new();
        let root_id = base.root_node().id();
        all_ids.push(self.external_node_id(root_id));
        collect_descendants(
            base,
            root_id,
            &mut all_ids,
            &mut self.node_handles.borrow_mut(),
        );
        for &nid in &all_ids {
            let Some(node) = self.resolve_node_id(nid).and_then(|id| base.get_node(id)) else {
                continue;
            };
            let Some(elem) = node.element_data() else {
                continue;
            };
            let Some(inline) = elem.inline_layout_data() else {
                continue;
            };
            for (idx, line) in inline.layout(base.tree()).lines().enumerate() {
                let m = line.metrics();
                let _ = writeln!(
                    out,
                    "node #{} <{}> line#{}: offset={:.2}, inline_min_coord={:.2}, advance={:.2}",
                    nid, elem.name.local, idx, m.offset, m.inline_min_coord, m.advance,
                );
            }
        }
        out
    }

    #[cfg(test)]
    pub fn debug_dump_background_images(&self) -> String {
        use std::fmt::Write;
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let mut out = String::new();
        for (id, node) in base.tree().iter() {
            let Some(el) = node.element_data() else {
                continue;
            };
            if el.background_images().is_empty() {
                continue;
            }
            let states: Vec<&str> = el
                .background_images()
                .iter()
                .map(|s| if s.is_some() { "Some" } else { "None" })
                .collect();
            let _ = writeln!(
                out,
                "node {} bg_images: [{}]",
                self.external_node_id(id),
                states.join(", ")
            );
        }
        out
    }

    #[wasm_bindgen(js_name = "debugDumpInlineLayouts")]
    pub fn debug_dump_inline_layouts(&self) -> String {
        use std::fmt::Write;
        let doc = self.doc.borrow();
        let base: &BaseDocument = doc.as_ref();
        let mut out = String::new();
        let mut all_ids: Vec<u32> = Vec::new();
        let root_id = base.root_node().id();
        all_ids.push(self.external_node_id(root_id));
        collect_descendants_with_pseudos(
            base,
            root_id,
            &mut all_ids,
            &mut self.node_handles.borrow_mut(),
        );

        for &nid in &all_ids {
            let Some(node) = self.resolve_node_id(nid).and_then(|id| base.get_node(id)) else {
                continue;
            };
            let Some(elem) = node.element_data() else {
                continue;
            };
            let Some(inline) = elem.inline_layout_data() else {
                continue;
            };
            let layout = inline.layout(base.tree());
            let frags = layout.span_fragments();
            let lay = node.final_layout();
            let text_align = node
                .primary_styles()
                .map(|s| format!("{:?}", s.clone_text_align()))
                .unwrap_or_else(|| "?".to_string());
            let display = node
                .primary_styles()
                .map(|s| format!("{:?}", s.clone_display()))
                .unwrap_or_else(|| "?".to_string());
            let _ = writeln!(
                out,
                "node #{} <{}> @ ({:.1}, {:.1}) {:.1}x{:.1}: \
                 display={}, text-align={}, {} fragment(s), text={:?}",
                nid,
                elem.name.local,
                lay.location.x,
                lay.location.y,
                lay.size.width,
                lay.size.height,
                display,
                text_align,
                frags.len(),
                inline.text(base.tree()),
            );
            for f in frags {
                let style = layout.styles().get(f.style_index as usize);
                let style_node_id = style.map(|s| s.brush.id).unwrap_or_default();
                let style_node_tag = base
                    .get_node(style_node_id)
                    .and_then(|n| n.element_data())
                    .map(|e| e.name.local.to_string())
                    .unwrap_or_else(|| "?".to_string());
                let _ = writeln!(
                    out,
                    "  frag: x_start={:.2}, x_end={:.2}, width={:.2}, line={}, \
                     style_node_id={} <{}>",
                    f.x_start,
                    f.x_end,
                    f.x_end - f.x_start,
                    f.line_index,
                    self.external_node_id(style_node_id),
                    style_node_tag,
                );
            }
        }
        out
    }
}

#[cfg(test)]
impl DomHandle {
    /// getBoundingClientRect's rect as `(x, y, width, height)`, with no
    /// catch_unwind, so a panic in the geometry fails the test.
    pub fn test_bounding_rect(&self, node_id: u32) -> (f32, f32, f32, f32) {
        self.ensure_layout();
        let doc = self.doc.borrow();
        let node = self
            .resolve_node_id(node_id)
            .and_then(|id| doc.get_node(id))
            .expect("node exists");
        let r = bounding_rect_for_node(&doc, node);
        (r.x, r.y, r.width, r.height)
    }

    /// The containing block that claimed an out-of-flow box, or `None`
    /// for an in-flow box.
    pub fn test_containing_block(&self, node_id: u32) -> Option<u32> {
        let node_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        let cb = doc.get_node(node_id)?.oof_containing_block()?;
        Some(self.external_node_id(cb))
    }

    /// Every `(out-of-flow box, containing block)` claim, sorted. A claim
    /// lost by a skipped pass is invisible to geometry (the previous pass's
    /// rect survives in cache) until paint.
    pub fn test_oof_containing_blocks(&self) -> Vec<(u32, u32)> {
        let Ok(doc) = self.doc.try_borrow() else {
            return Vec::new();
        };
        let mut claims: Vec<(u32, u32)> = doc
            .tree()
            .iter()
            .filter_map(|(_, node)| {
                let cb = node.oof_containing_block()?;
                Some((self.external_node_id(node.id()), self.external_node_id(cb)))
            })
            .collect();
        claims.sort_unstable();
        claims
    }

    /// A node's resolved layout children.
    pub fn test_layout_children(&self, node_id: u32) -> Vec<u32> {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let Some(node) = doc.get_node(node_id) else {
            return Vec::new();
        };
        let kids = node
            .layout_children()
            .as_ref()
            .map(|v| {
                v.iter()
                    .copied()
                    .map(|id| self.external_node_id(id))
                    .collect()
            })
            .unwrap_or_default();
        kids
    }

    pub fn test_placed_floats(&self, node_id: u32) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return false;
        };
        doc.get_node(node_id)
            .map(|n| n.placed_floats())
            .unwrap_or(false)
    }

    pub fn test_rehomed_paint_children(&self, node_id: u32) -> Vec<u32> {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return Vec::new();
        };
        let Ok(doc) = self.doc.try_borrow() else {
            return Vec::new();
        };
        let Some(node) = doc.get_node(node_id) else {
            return Vec::new();
        };
        node.rehomed_paint_children()
            .map(|children| {
                children
                    .iter()
                    .copied()
                    .map(|id| self.external_node_id(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn test_rehomed_reach(&self, node_id: u32) -> Option<(f32, f32, f32, f32)> {
        let node_id = self.resolve_node_id(node_id)?;
        let doc = self.doc.try_borrow().ok()?;
        doc.get_node(node_id)?.rehomed_reach()
    }

    pub fn test_get_inline_aware_rect(&self, node_id: u32) -> (f32, f32, f32, f32) {
        self.ensure_layout();
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return (0.0, 0.0, 0.0, 0.0);
        };
        let doc = match self.doc.try_borrow() {
            Ok(d) => d,
            Err(_) => return (0.0, 0.0, 0.0, 0.0),
        };
        let Some(node) = doc.get_node(node_id) else {
            return (0.0, 0.0, 0.0, 0.0);
        };
        let rect = bounding_rect_for_node(&doc, node);
        (rect.x, rect.y, rect.width, rect.height)
    }
}
