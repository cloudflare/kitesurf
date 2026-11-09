// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Print output: PDF scenes, the page box, and the print media type.

use std::panic;

use wasm_bindgen::prelude::*;

use crate::{emulated_color_scheme, DomHandle, LayoutMode};
use crate::paint::pdf_paint::content_box;

#[wasm_bindgen]
impl DomHandle {
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
        self.resolve_until_images_settle();
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let (_ml, _mt, content_w, content_h) = content_box(
            width,
            height,
            margin_top,
            margin_right,
            margin_bottom,
            margin_left,
        );
        {
            use blitz_traits::shell::Viewport;
            let cur = doc.viewport();
            if cur.window_size.0 != content_w || cur.window_size.1 != content_h {
                doc.set_viewport(Viewport::new(
                    content_w,
                    content_h,
                    1.0,
                    emulated_color_scheme(),
                ));
                drop(doc);
                self.layout_dirty.set(true);
                self.ensure_layout();
                doc = match self.doc.try_borrow_mut() {
                    Ok(d) => d,
                    Err(_) => return Vec::new(),
                };
            }
        }
        let mut fonts_ref = match self.rbi_font_bytes.try_borrow_mut() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let mut images_ref = match self.rbi_image_cache.try_borrow_mut() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };
        let mut pdf_images = Vec::new();
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let base: &mut blitz_dom::BaseDocument = &mut doc;
            crate::paint::pdf::record_doc_pdf_scenes(
                base,
                content_w,
                content_h,
                &mut fonts_ref,
                &mut images_ref,
                &mut pdf_images,
            )
        }));
        if let Ok(mut recency) = self.rbi_image_recency.try_borrow_mut() {
            recency.note(pdf_images);
        }
        match result {
            Ok(env) if env.len() > crate::paint::scene_replay::PDF_ENVELOPE_U32_BYTES => env,
            _ => Vec::new(),
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
