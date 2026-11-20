// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Print output: PDF scenes, the page box, and the print media type.

use std::panic;

use wasm_bindgen::prelude::*;

use crate::{emulated_color_scheme, DomHandle, LayoutMode};
use crate::paint::pdf::{
    compute_page_bands, evict_recorded_page_layouts, max_printed_height, record_doc_pdf_page,
};
use crate::paint::pdf_paint::content_box;

#[wasm_bindgen]
pub struct PdfSceneStream {
    bands: Vec<(f64, f64)>,
    content_width: u32,
    next: usize,
}

#[wasm_bindgen]
impl PdfSceneStream {
    #[wasm_bindgen(getter, js_name = "pageCount")]
    pub fn page_count(&self) -> usize {
        self.bands.len()
    }

    #[wasm_bindgen(js_name = "nextPage")]
    pub fn next_page(&mut self, dom: &DomHandle) -> Result<Vec<u8>, JsError> {
        let Some(&band) = self.bands.get(self.next) else {
            // A stream that records no page never reaches `record_stream_page`'s clear.
            dom.release_inline_keep_extent();
            return Ok(Vec::new());
        };
        let page = record_stream_page(dom, self.content_width, band)?;
        self.next += 1;
        Ok(page)
    }
}

// Keep this boundary separate: pinned LLVM WebAssemblyCFGStackify has SIGBUS'd on print codegen.
#[inline(never)]
fn record_stream_page(
    dom: &DomHandle,
    content_width: u32,
    band: (f64, f64),
) -> Result<Vec<u8>, JsError> {
    let mut doc = dom
        .doc
        .try_borrow_mut()
        .map_err(|_| JsError::new("PDF document busy"))?;
    let mut fonts = dom
        .rbi_font_bytes
        .try_borrow_mut()
        .map_err(|_| JsError::new("PDF font cache busy"))?;
    let mut images = dom
        .rbi_image_cache
        .try_borrow_mut()
        .map_err(|_| JsError::new("PDF image cache busy"))?;
    let mut seen_images = Vec::new();
    let recorded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        record_doc_pdf_page(
            &mut doc,
            content_width,
            band,
            &mut fonts,
            &mut images,
            &mut seen_images,
        )
    }));
    drop(images);
    drop(fonts);
    doc.set_inline_keep_extent(None);
    let cleanup = cleanup_stream_page(&mut doc);
    drop(doc);
    if let Ok(mut recency) = dom.rbi_image_recency.try_borrow_mut() {
        recency.note(seen_images);
    }
    let page = recorded.map_err(|_| JsError::new("PDF page recording panicked"))?;
    cleanup.map_err(|_| JsError::new("PDF page cleanup panicked"))?;
    Ok(page)
}

// Keep cleanup separate for the same pinned-toolchain WebAssemblyCFGStackify SIGBUS workaround.
#[inline(never)]
fn cleanup_stream_page(doc: &mut blitz_dom::BaseDocument) -> std::thread::Result<()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        evict_recorded_page_layouts(doc);
    }))
}

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "startPdfSceneStream")]
    pub fn start_pdf_scene_stream(
        &self,
        width: u32,
        height: u32,
        margin_top: u32,
        margin_right: u32,
        margin_bottom: u32,
        margin_left: u32,
    ) -> Option<PdfSceneStream> {
        if self.layout_mode.get() == LayoutMode::Off {
            return None;
        }
        let (_, _, content_width, content_height) = content_box(
            width,
            height,
            margin_top,
            margin_right,
            margin_bottom,
            margin_left,
        );
        // Set before the layout passes it protects: the resolve below and the print-viewport
        // `ensure_layout` end with an eviction scan.
        let mut doc = self.doc.try_borrow_mut().ok()?;
        doc.set_inline_keep_extent(Some((0.0, max_printed_height(content_height))));
        drop(doc);
        self.resolve_until_images_settle();
        let mut doc = self.doc.try_borrow_mut().ok()?;
        let viewport = doc.viewport();
        if viewport.window_size.0 != content_width || viewport.window_size.1 != content_height {
            doc.set_viewport(blitz_traits::shell::Viewport::new(
                content_width,
                content_height,
                1.0,
                emulated_color_scheme(),
            ));
            drop(doc);
            self.layout_dirty.set(true);
            self.ensure_layout();
            doc = self.doc.try_borrow_mut().ok()?;
        }
        let bands = compute_page_bands(&mut doc, content_height);
        drop(doc);
        Some(PdfSceneStream {
            bands,
            content_width,
            next: 0,
        })
    }

    #[wasm_bindgen(js_name = "recordPdfScenes")]
    pub fn record_pdf_scenes(
        &self,
        width: u32,
        height: u32,
        margin_top: u32,
        margin_right: u32,
        margin_bottom: u32,
        margin_left: u32,
    ) -> Vec<u8> {
        let _ks_span = tracing::info_span!("wasm.record_pdf_scenes", width, height).entered();
        if self.layout_mode.get() == LayoutMode::Off {
            return Vec::new();
        }
        let (_ml, _mt, content_w, content_h) = content_box(
            width,
            height,
            margin_top,
            margin_right,
            margin_bottom,
            margin_left,
        );

        // Set before the layout passes it protects: both the resolve below and the
        // print-viewport layout end with an eviction scan.
        if !self.hold_inline_keep_extent(content_h) {
            return Vec::new();
        }
        let scenes = self.record_pdf_scenes_at(content_w, content_h);
        self.release_inline_keep_extent();
        let released = self.release_print_only_layouts();

        match scenes {
            Some(env)
                if released && env.len() > crate::paint::scene_replay::PDF_ENVELOPE_U32_BYTES =>
            {
                env
            }
            _ => Vec::new(),
        }
    }

    /// Releases the text this print rebuilt. Returns false when the eviction panicked
    /// or the document is already borrowed.
    fn release_print_only_layouts(&self) -> bool {
        let Ok(mut doc) = self.doc.try_borrow_mut() else {
            return false;
        };
        cleanup_stream_page(&mut doc).is_ok()
    }

    /// Records the PDF scenes of the document laid out at the paper box.
    fn record_pdf_scenes_at(&self, content_w: u32, content_h: u32) -> Option<Vec<u8>> {
        self.resolve_until_images_settle();
        if !self.fit_print_viewport(content_w, content_h) {
            return None;
        }

        let mut doc = self.doc.try_borrow_mut().ok()?;
        let (Ok(mut fonts), Ok(mut images)) = (
            self.rbi_font_bytes.try_borrow_mut(),
            self.rbi_image_cache.try_borrow_mut(),
        ) else {
            return None;
        };

        let mut pdf_images = Vec::new();
        let scenes = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            crate::paint::pdf::record_doc_pdf_scenes(
                &mut doc,
                content_w,
                content_h,
                &mut fonts,
                &mut images,
                &mut pdf_images,
            )
        }));

        if let Ok(mut recency) = self.rbi_image_recency.try_borrow_mut() {
            recency.note(pdf_images);
        }
        scenes.ok()
    }

    /// Lays the document out at the paper box. Returns false when the document is
    /// already borrowed.
    fn fit_print_viewport(&self, content_w: u32, content_h: u32) -> bool {
        use blitz_traits::shell::Viewport;

        let Ok(mut doc) = self.doc.try_borrow_mut() else {
            return false;
        };
        if doc.viewport().window_size == (content_w, content_h) {
            return true;
        }

        doc.set_viewport(Viewport::new(
            content_w,
            content_h,
            1.0,
            emulated_color_scheme(),
        ));
        drop(doc);
        self.layout_dirty.set(true);
        self.ensure_layout();
        true
    }

    /// Keeps inline layouts shaped down to the last printed row, so this print's
    /// layout passes do not evict the text they just shaped. Returns false when
    /// the document is already borrowed.
    fn hold_inline_keep_extent(&self, content_h: u32) -> bool {
        let Ok(mut doc) = self.doc.try_borrow_mut() else {
            return false;
        };
        doc.set_inline_keep_extent(Some((
            0.0,
            crate::paint::pdf::max_printed_height(content_h),
        )));
        true
    }

    fn release_inline_keep_extent(&self) {
        if let Ok(mut doc) = self.doc.try_borrow_mut() {
            doc.set_inline_keep_extent(None);
        }
    }

    #[wasm_bindgen(js_name = "setMediaType")]
    pub fn set_media_type(&self, media: &str) {
        use ::style::media_queries::MediaType;
        let mt = match media {
            "print" => MediaType::print(),
            "" | "screen" => MediaType::screen(),
            _ => return,
        };
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        if doc.media_type() == &mt {
            return;
        }
        doc.set_media_type(mt);
        self.layout_dirty.set(true);
    }

    #[wasm_bindgen(js_name = "pageBoxJson")]
    pub fn page_box_json(&self) -> String {
        let computed = panic::catch_unwind(panic::AssertUnwindSafe(|| self.compute_page_box()));
        match computed {
            Ok(Ok(pb)) => pb,
            Ok(Err(e)) => format!(
                "{{\"hasSize\":false,\"hasMargin\":false,\"error\":\"{}\"}}",
                e.replace('"', "'")
            ),
            Err(_) => String::from("{\"hasSize\":false,\"hasMargin\":false,\"error\":\"panic\"}"),
        }
    }
}

impl DomHandle {
    fn compute_page_box(&self) -> Result<String, String> {
        use ::style::properties::PropertyDeclaration;
        use ::style::stylesheets::Origin;
        use ::style::values::generics::length::GenericMargin;
        use ::style::values::generics::page::{GenericPageSize, PageOrientation, PageSizeOrientation};
        use ::style::values::specified::length::{Length, LengthPercentage, NoCalcLength};
        use ::style::values::specified::page::PaperSize;

        let doc = self
            .doc
            .try_borrow()
            .map_err(|_| String::from("doc locked"))?;

        fn px_to_pt(px: f32) -> f64 {
            px as f64 * 0.75
        }
        fn nocalc_to_pt(l: &NoCalcLength) -> Option<f64> {
            l.to_px_if_absolute().map(px_to_pt)
        }
        fn length_to_pt(l: &Length) -> Option<f64> {
            l.to_computed_pixel_length_without_context()
                .ok()
                .map(px_to_pt)
        }
        fn margin_to_pt(v: &GenericMargin<LengthPercentage>) -> Option<f64> {
            match v {
                GenericMargin::Auto => Some(0.0),
                GenericMargin::LengthPercentage(LengthPercentage::Length(nc)) => nocalc_to_pt(nc),
                _ => None,
            }
        }
        let a4_short = nocalc_to_pt(&PaperSize::A4.short_edge().0).expect("paper edge is absolute");
        let a4_long = nocalc_to_pt(&PaperSize::A4.long_edge().0).expect("paper edge is absolute");

        let mut width_pt: Option<f64> = None;
        let mut height_pt: Option<f64> = None;
        let mut margin_top_pt: Option<f64> = None;
        let mut margin_right_pt: Option<f64> = None;
        let mut margin_bottom_pt: Option<f64> = None;
        let mut margin_left_pt: Option<f64> = None;
        let mut orientation = PageOrientation::Upright;
        let mut had_size = false;
        let mut had_margin = false;

        let guard = doc.guard().read();
        {
            let mut apply_declaration = |decl: &PropertyDeclaration| match decl {
                PropertyDeclaration::Size(size) => match size {
                    GenericPageSize::Auto => {}
                    GenericPageSize::Size(size2d) => {
                        if let (Some(width), Some(height)) = (
                            length_to_pt(&size2d.width.0),
                            length_to_pt(&size2d.height.0),
                        ) {
                            width_pt = Some(width);
                            height_pt = Some(height);
                            had_size = true;
                        }
                    }
                    GenericPageSize::Orientation(value) => {
                        if *value == PageSizeOrientation::Landscape {
                            width_pt = Some(a4_long);
                            height_pt = Some(a4_short);
                        } else {
                            width_pt = Some(a4_short);
                            height_pt = Some(a4_long);
                        }
                        had_size = true;
                    }
                    GenericPageSize::PaperSize(paper, value) => {
                        let short =
                            nocalc_to_pt(&paper.short_edge().0).expect("paper edge is absolute");
                        let long =
                            nocalc_to_pt(&paper.long_edge().0).expect("paper edge is absolute");
                        if *value == PageSizeOrientation::Landscape {
                            width_pt = Some(long);
                            height_pt = Some(short);
                        } else {
                            width_pt = Some(short);
                            height_pt = Some(long);
                        }
                        had_size = true;
                    }
                },
                PropertyDeclaration::PageOrientation(value) => orientation = *value,
                PropertyDeclaration::MarginTop(value) => {
                    if let Some(points) = margin_to_pt(value) {
                        margin_top_pt = Some(points);
                        had_margin = true;
                    }
                }
                PropertyDeclaration::MarginRight(value) => {
                    if let Some(points) = margin_to_pt(value) {
                        margin_right_pt = Some(points);
                        had_margin = true;
                    }
                }
                PropertyDeclaration::MarginBottom(value) => {
                    if let Some(points) = margin_to_pt(value) {
                        margin_bottom_pt = Some(points);
                        had_margin = true;
                    }
                }
                PropertyDeclaration::MarginLeft(value) => {
                    if let Some(points) = margin_to_pt(value) {
                        margin_left_pt = Some(points);
                        had_margin = true;
                    }
                }
                _ => {}
            };

            for (extra_data, origin) in doc.stylist.iter_extra_data_origins() {
                if origin != Origin::Author {
                    continue;
                }
                let empty_atom = ::stylo_atoms::Atom::default();
                let Some(rules) = extra_data.pages.rules.get(&empty_atom) else {
                    continue;
                };
                for rule_data in rules.iter() {
                    let page_rule = rule_data.rule.read_with(&guard);
                    if !page_rule.selectors.is_empty() {
                        continue;
                    }
                    let block = page_rule.block.read_with(&guard);
                    for decl in block.declarations().iter() {
                        apply_declaration(decl);
                    }
                }
            }
        }

        let orient_str = match orientation {
            PageOrientation::Upright => "upright",
            PageOrientation::RotateLeft => "rotate-left",
            PageOrientation::RotateRight => "rotate-right",
        };

        Ok(format!(
            "{{\"hasSize\":{},\"hasMargin\":{},\"widthPt\":{},\"heightPt\":{},\"marginTopPt\":{},\"marginRightPt\":{},\"marginBottomPt\":{},\"marginLeftPt\":{},\"orientation\":\"{}\"}}",
            had_size,
            had_margin,
            width_pt.unwrap_or(0.0),
            height_pt.unwrap_or(0.0),
            margin_top_pt.unwrap_or(0.0),
            margin_right_pt.unwrap_or(0.0),
            margin_bottom_pt.unwrap_or(0.0),
            margin_left_pt.unwrap_or(0.0),
            orient_str,
        ))
    }
}
