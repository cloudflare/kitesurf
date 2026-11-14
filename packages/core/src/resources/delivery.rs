// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Host resource delivery: fetched bytes, font upgrades, and pending images.

use wasm_bindgen::prelude::*;

use crate::DomHandle;
use crate::layout::geometry::svg_natural_dimensions;

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "pendingAuthorFontUpgrades")]
    pub fn pending_author_font_upgrades(&self) -> Vec<String> {
        let Ok(mut d) = self.doc.try_borrow_mut() else {
            return Vec::new();
        };
        let regs = d.as_mut().take_author_font_registrations();
        drop(d);
        crate::resources::fonts::stash_author_upgrades(regs)
    }

    #[wasm_bindgen(js_name = "fontsUpgraded")]
    pub fn fonts_upgraded(&self) {
        if let Ok(mut d) = self.doc.try_borrow_mut() {
            d.as_mut().fonts_upgraded();
        }
        self.layout_dirty.set(true);
    }

    #[wasm_bindgen(js_name = "nonLatinTextWrites")]
    pub fn non_latin_text_writes(&self) -> u32 {
        self.doc
            .try_borrow()
            .map_or(0, |d| d.as_ref().non_latin_text_writes())
    }

    #[wasm_bindgen(js_name = "textUsesCodepoints")]
    pub fn text_uses_codepoints(&self, ranges: Vec<u32>) -> bool {
        let pairs: Vec<(u32, u32)> = ranges
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[start, end]| (*start, *end))
            .collect();
        self.doc
            .try_borrow_mut()
            .is_ok_and(|mut d| d.as_mut().text_uses_codepoints(&pairs))
    }

    #[wasm_bindgen(js_name = "deliverResource")]
    pub fn deliver_resource(&self, request_id: u32, bytes: Vec<u8>) -> bool {
        self.deliver_inner(request_id, bytes, 0, None)
    }

    #[wasm_bindgen(js_name = "deliverResourceMeta")]
    pub fn deliver_resource_meta(
        &self,
        request_id: u32,
        resource_key: &str,
        width: u32,
        height: u32,
    ) -> bool {
        let Ok(key) = resource_key.parse::<u64>() else {
            return false;
        };
        if key == 0 || width == 0 || height == 0 {
            return false;
        }
        self.deliver_inner(request_id, Vec::new(), key, Some((width, height)))
    }

    #[wasm_bindgen(js_name = "deliverFontResource")]
    pub fn deliver_font_resource(
        &self,
        request_id: u32,
        bytes: Vec<u8>,
        resource_key: &str,
    ) -> bool {
        let key = resource_key.parse::<u64>().unwrap_or(0);
        self.deliver_inner(request_id, bytes, key, None)
    }

    fn deliver_inner(
        &self,
        request_id: u32,
        bytes: Vec<u8>,
        key: u64,
        dims: Option<(u32, u32)>,
    ) -> bool {
        let dispatched =
            crate::resources::net::deliver_bytes(&self.net_provider, request_id, bytes, key, dims);
        if dispatched {
            if let Ok(mut d) = self.doc.try_borrow_mut() {
                d.as_mut().handle_messages();
            }
            self.layout_dirty.set(true);
        }
        dispatched
    }

    /// Settle a pending fetch with an empty body.
    /// Returns `false` if its request ID is no longer pending.
    #[wasm_bindgen(js_name = "deliverResourceError")]
    pub fn deliver_resource_error(&self, request_id: u32) -> bool {
        let dispatched = crate::resources::net::drop_pending(&self.net_provider, request_id);
        if dispatched {
            if let Ok(mut d) = self.doc.try_borrow_mut() {
                d.as_mut().handle_messages();
            }
            self.layout_dirty.set(true);
        }
        dispatched
    }

    #[wasm_bindgen(js_name = "pumpResourceMessages")]
    pub fn pump_resource_messages(&self) {
        if let Ok(mut d) = self.doc.try_borrow_mut() {
            d.as_mut().handle_messages();
            self.layout_dirty.set(true);
        }
    }

    #[wasm_bindgen(js_name = "pendingImageNodes")]
    pub fn pending_image_nodes(&self, url: &str) -> Vec<u32> {
        match self.doc.try_borrow() {
            Ok(d) => d
                .pending_image_nodes(url)
                .into_iter()
                .map(|id| self.external_node_id(id))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = "discoverPendingImages")]
    pub fn discover_pending_images(&self) -> u32 {
        const MAX_IMAGE_DISCOVERY_PASSES: usize = 3;
        let mut pending = 0u32;
        let mut last = u32::MAX;
        for _ in 0..MAX_IMAGE_DISCOVERY_PASSES {
            self.ensure_layout();
            pending = match self.doc.try_borrow() {
                Ok(d) => d.as_ref().pending_images_count() as u32,
                Err(_) => 0,
            };
            if pending == 0 || pending >= last {
                break;
            }
            last = pending;
            self.layout_dirty.set(true);
        }
        if pending > 0 {
            self.layout_dirty.set(true);
        }
        pending
    }

    #[wasm_bindgen(js_name = "pendingImagesCount")]
    pub fn pending_images_count(&self) -> u32 {
        match self.doc.try_borrow() {
            Ok(d) => d.as_ref().pending_images_count() as u32,
            Err(_) => 0,
        }
    }

    #[wasm_bindgen(js_name = "imageCacheHas")]
    pub fn image_cache_has(&self, url: &str) -> bool {
        match self.doc.try_borrow() {
            Ok(d) => d.image_cache_has(url),
            Err(_) => false,
        }
    }

    #[wasm_bindgen(js_name = "imageIsPending")]
    pub fn image_is_pending(&self, node_id: u32) -> bool {
        let Some(node_id) = self.resolve_node_id(node_id) else {
            return false;
        };
        match self.doc.try_borrow() {
            Ok(d) => d.node_has_pending_image(node_id),
            Err(_) => true,
        }
    }

    #[wasm_bindgen(js_name = "imageNaturalSize")]
    pub fn image_natural_size(&self, node_id: u32) -> Vec<u32> {
        use blitz_dom::node::{ImageData, SpecialElementData};
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
        let Some(elem) = node.element_data() else {
            return Vec::new();
        };
        match elem.special_data() {
            SpecialElementData::Image(data) => match &**data {
                ImageData::Raster(raster) => vec![raster.width, raster.height],
                ImageData::Svg(svg) => {
                    let (w, h) = svg_natural_dimensions(
                        svg.intrinsic_width(),
                        svg.intrinsic_height(),
                        svg.viewbox_aspect_ratio(),
                    );
                    vec![w.round().max(0.0) as u32, h.round().max(0.0) as u32]
                }
                ImageData::None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }
}
