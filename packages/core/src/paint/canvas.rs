// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! The `<canvas>` 2D API on `DomHandle`.

use std::panic;
use std::sync::Arc;

use blitz_dom::local_name;
use wasm_bindgen::prelude::*;

use crate::DomHandle;
use crate::paint::canvas2d::ResolvedImage;

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "setCanvasPixels")]
    pub fn set_canvas_pixels(&self, node_id: u32, width: u32, height: u32, rgba: &[u8]) -> i32 {
        const MAX_CANVAS_DIM: u32 = 4096;
        if width == 0 || height == 0 || width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM {
            return -1;
        }
        let expected = (width as usize) * (height as usize) * 4;
        if rgba.len() != expected {
            return -1;
        }
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return -2,
        };
        let rc = doc.kitesurf_set_canvas_image(internal_id, width, height, Arc::new(rgba.to_vec()));
        drop(doc);
        if rc == 1 {
            self.layout_dirty.set(true);
        }
        rc
    }

    #[wasm_bindgen(js_name = "clearCanvasPixels")]
    pub fn clear_canvas_pixels(&self, node_id: u32) {
        let internal_id = self.resolve_node_id(node_id);
        if let Ok(mut d) = self.doc.try_borrow_mut() {
            if let Some(internal_id) = internal_id {
                d.kitesurf_clear_canvas_image(internal_id);
                drop(d);
                self.layout_dirty.set(true);
            }
        }
        if let Ok(mut reg) = self.canvas2d.try_borrow_mut() {
            reg.release(node_id);
        }
    }

    #[wasm_bindgen(
        js_name = "canvasSourceInfo",
        unchecked_return_type = "{ kind: \"canvas\" | \"img\"; src: string } | null"
    )]
    pub fn canvas_source_info(&self, node_id: u32) -> Result<JsValue, JsError> {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return Ok(JsValue::NULL);
        };
        let doc = match self.doc.try_borrow() {
            Ok(doc) => doc,
            Err(_) => return Ok(JsValue::NULL),
        };
        let Some(element) = doc
            .get_node(internal_id)
            .and_then(|node| node.element_data())
        else {
            return Ok(JsValue::NULL);
        };
        let kind = if element
            .name
            .local
            .eq_ignore_ascii_case(&local_name!("canvas"))
        {
            "canvas"
        } else if element.name.local.eq_ignore_ascii_case(&local_name!("img")) {
            "img"
        } else {
            return Ok(JsValue::NULL);
        };
        #[derive(serde::Serialize)]
        struct SourceInfo<'a> {
            kind: &'static str,
            src: &'a str,
        }
        let src = element
            .attrs
            .iter()
            .find(|attribute| {
                attribute
                    .name
                    .local
                    .eq_ignore_ascii_case(&local_name!("src"))
            })
            .map(|attribute| attribute.value.as_str())
            .unwrap_or("");
        let result = serde_wasm_bindgen::to_value(&SourceInfo { kind, src })
            .map_err(|error| JsError::new(&error.to_string()));
        drop(doc);
        result
    }

    #[wasm_bindgen(js_name = "canvasApplyOps")]
    pub fn canvas_apply_ops(&self, node_id: u32, ops_json: &str) -> i32 {
        let mut reg = match self.canvas2d.try_borrow_mut() {
            Ok(r) => r,
            Err(_) => return -2,
        };
        let doc_cell = &self.doc;
        let node_handles = &self.node_handles;
        // The ops come from the page realm, so a drawImage can name any node. Only an <img> is
        // an image source: an <iframe> also holds a raster, its cross-origin child's frame.
        let is_img = |el: &&blitz_dom::node::ElementData| {
            el.name.local.eq_ignore_ascii_case(&local_name!("img"))
        };
        let mut resolve = |id: u32| -> Option<ResolvedImage> {
            let internal_id = node_handles.borrow().resolve(id)?;
            {
                let needs_decode = {
                    let doc = doc_cell.try_borrow().ok()?;
                    doc.get_node(internal_id)
                        .and_then(|n| n.element_data())
                        .filter(is_img)
                        .and_then(|el| el.raster_image_data())
                        .is_some_and(|img| img.encoded)
                };
                if needs_decode {
                    let mut doc = doc_cell.try_borrow_mut().ok()?;
                    doc.kitesurf_materialize_node_image(
                        internal_id,
                        crate::paint::canvas2d::MAX_CANVAS_DIM,
                    );
                }
            }
            let doc = doc_cell.try_borrow().ok()?;
            let node = doc.get_node(internal_id)?;
            let el = node.element_data().filter(is_img)?;
            let img = el.raster_image_data()?;
            if img.encoded {
                return None;
            }
            Some(ResolvedImage {
                width: img.width,
                height: img.height,
                rgba: img.data.clone(),
            })
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            reg.apply_ops(node_id, ops_json, &mut resolve)
        }));
        match result {
            Ok(rc) => rc,
            Err(_) => {
                reg.release(node_id);
                -3
            }
        }
    }

    #[wasm_bindgen(js_name = "canvasFlush")]
    pub fn canvas_flush(&self, node_id: u32) -> i32 {
        let Some(internal_id) = self.resolve_node_id(node_id) else {
            return -1;
        };
        let mut reg = match self.canvas2d.try_borrow_mut() {
            Ok(r) => r,
            Err(_) => return -2,
        };
        let rendered = panic::catch_unwind(panic::AssertUnwindSafe(|| reg.flush(node_id)));
        let (w, h, rgba) = match rendered {
            Ok(Some(t)) => t,
            Ok(None) => return 2,
            Err(_) => {
                reg.release(node_id);
                return -3;
            }
        };
        drop(reg);
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return -2,
        };
        let rc = doc.kitesurf_set_canvas_image(internal_id, w, h, rgba);
        drop(doc);
        if rc == 1 {
            self.layout_dirty.set(true);
        }
        rc
    }

    #[wasm_bindgen(js_name = "canvasPutImageData")]
    pub fn canvas_put_image_data(
        &self,
        node_id: u32,
        dx: f64,
        dy: f64,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    ) -> i32 {
        let mut reg = match self.canvas2d.try_borrow_mut() {
            Ok(r) => r,
            Err(_) => return -2,
        };
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            reg.put_image_data(node_id, dx, dy, width, height, rgba);
        }));
        match result {
            Ok(()) => 0,
            Err(_) => {
                reg.release(node_id);
                -3
            }
        }
    }

    #[wasm_bindgen(js_name = "canvasGetImageData")]
    pub fn canvas_get_image_data(
        &self,
        node_id: u32,
        sx: i32,
        sy: i32,
        sw: u32,
        sh: u32,
    ) -> Vec<u8> {
        if sw == 0 || sh == 0 || sw > 4096 || sh > 4096 {
            return Vec::new();
        }
        let mut reg = match self.canvas2d.try_borrow_mut() {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            reg.get_image_data(node_id, sx as i64, sy as i64, sw, sh)
        }))
        .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "canvasEncodePng")]
    pub fn canvas_encode_png(&self, node_id: u32) -> Vec<u8> {
        let mut reg = match self.canvas2d.try_borrow_mut() {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        panic::catch_unwind(panic::AssertUnwindSafe(|| reg.encode_png(node_id))).unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "canvasIsOriginClean")]
    pub fn canvas_is_origin_clean(&self, node_id: u32) -> bool {
        match self.canvas2d.try_borrow() {
            Ok(reg) => reg.is_origin_clean(node_id),
            Err(_) => false,
        }
    }

    #[wasm_bindgen(js_name = "canvasIsPointInPath")]
    pub fn canvas_is_point_in_path(&self, node_id: u32, x: f64, y: f64, even_odd: bool) -> bool {
        match self.canvas2d.try_borrow_mut() {
            Ok(mut reg) => reg.is_point_in_path(node_id, x, y, even_odd),
            Err(_) => false,
        }
    }

    #[wasm_bindgen(js_name = "canvasSerializeColor")]
    pub fn canvas_serialize_color(&self, css: &str) -> String {
        crate::paint::canvas2d::serialize_css_color(css).unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "canvasMeasureText")]
    pub fn canvas_measure_text(&self, text: &str, font: &str) -> String {
        panic::catch_unwind(panic::AssertUnwindSafe(|| {
            crate::paint::canvas2d::measure_text(text, font)
        }))
        .unwrap_or_else(|_| "{\"width\":0}".to_string())
    }
}
