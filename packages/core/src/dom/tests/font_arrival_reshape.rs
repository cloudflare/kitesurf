// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! A web font that arrives after layout reshapes the text that uses it at the next resolve.

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use std::sync::{Arc, Mutex};

const MONO: &[u8] = include_bytes!("../../../../engine/public/fonts/NotoSansMono.ttf");

/// Serves the stylesheet at once and holds every other request until `deliver`.
#[derive(Default)]
struct HeldFonts {
    stylesheet: String,
    held: Mutex<Vec<(String, Box<dyn NetHandler>)>>,
}

impl NetProvider for HeldFonts {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        if request.url.path() == "/style.css" {
            handler.bytes(url, Bytes::from(self.stylesheet.clone()));
        } else {
            self.held.lock().expect("held lock").push((url, handler));
        }
    }
}

impl HeldFonts {
    fn deliver(&self) -> usize {
        let held = std::mem::take(&mut *self.held.lock().expect("held lock"));
        let count = held.len();
        for (url, handler) in held {
            handler.bytes(url, Bytes::from_static(MONO));
        }
        count
    }
}

fn width(document: &mut HtmlDocument) -> f32 {
    let doc: &mut BaseDocument = document.as_mut();
    doc.resolve(0.0);
    let id = doc.query_selector("#s").expect("query ok").expect("#s");
    doc.get_node(id).expect("node").final_layout().size.width
}

#[test]
fn late_web_fonts_reshape_text_once_delivered() {
    let net = Arc::new(HeldFonts {
        stylesheet: r#"@font-face { font-family: "Late"; src: url("/a"); }
@font-face { font-family: "Later"; src: url("/b"); }
#s { display: inline-block; font: 20px "Late", "Later", serif; }"#
            .to_string(),
        ..Default::default()
    });
    let mut document = HtmlDocument::from_html(
        r#"<link rel="stylesheet" href="/style.css"><span id="s">iiiiiiiiii</span>"#,
        DocumentConfig {
            base_url: Some("https://fonts.test/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            net_provider: Some(net.clone()),
            font_ctx: Some(crate::resources::fonts::get_or_init_font_context()),
            viewport: Some(blitz_traits::shell::Viewport::new(
                800,
                600,
                1.0,
                blitz_traits::shell::ColorScheme::Light,
            )),
            ..Default::default()
        },
    );
    width(&mut document);
    let fallback = width(&mut document);
    assert!(net.deliver() > 0, "the faces were requested");
    let late = width(&mut document);
    assert!(
        late > fallback * 1.5,
        "monospace i is wider: {fallback} -> {late}"
    );
}
