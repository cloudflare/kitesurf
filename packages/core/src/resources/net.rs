// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Routes Blitz resource requests through PageScript's fetch bridge and settles pending handlers.

use std::sync::Mutex;

use blitz_dom::net::kitesurf_set_pending_image;
use blitz_traits::net::{http, Bytes, NetHandler, NetProvider, Request};

use wasm_bindgen::prelude::*;

use crate::resources::fonts::strip_fetched_font_for_session;

const MAX_RESOURCE_EXTENSION_BYTES: usize = 8;

#[wasm_bindgen]
extern "C" {
    /// Request IDs and resource labels are consumed by PageScript's fetch bridge.
    // FFI: build-wasm rewrites this declaration to a module-private import so page
    // code cannot call or replace the bridge.
    #[wasm_bindgen(js_namespace = ["globalThis", "__ks_state"], js_name = "fetchResource")]
    fn js_fetch_resource(request_id: u32, url: &str, kind: &str, cors_mode: &str);
}

pub(crate) struct PendingRequest {
    handler: Box<dyn NetHandler>,
    url: String,
    kind: &'static str,
}

pub struct KitesurfNetProvider {
    next_id: Mutex<u32>,
    pending: Mutex<std::collections::HashMap<u32, PendingRequest>>,
}

impl Default for KitesurfNetProvider {
    fn default() -> Self {
        Self {
            next_id: Mutex::new(1),
            pending: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl KitesurfNetProvider {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn take_pending(&self, request_id: u32) -> Option<PendingRequest> {
        self.pending.lock().ok()?.remove(&request_id)
    }
}

impl NetProvider for KitesurfNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();

        if url.starts_with("data:") {
            if let Ok(bytes) = decode_data_url(&url) {
                let bytes = if infer_resource_kind(&request) == "Font" {
                    strip_fetched_font_for_session(bytes, &url, 0)
                } else {
                    bytes
                };
                handler.bytes(url.clone(), Bytes::from(bytes));
            } else {
                settle_unfetchable(handler, url, infer_resource_kind(&request));
            }
            return;
        }

        if !(url.starts_with("http://") || url.starts_with("https://")) {
            settle_unfetchable(handler, url, infer_resource_kind(&request));
            return;
        }

        let id = {
            let mut next = self.next_id.lock().expect("net_provider next_id");
            let id = *next;
            *next = next.wrapping_add(1).max(1);
            id
        };
        let kind = infer_resource_kind(&request);
        {
            let mut pending = self.pending.lock().expect("net_provider pending");
            pending.insert(
                id,
                PendingRequest {
                    handler,
                    url: url.clone(),
                    kind,
                },
            );
        }

        let cors_mode = cors_mode_from_content_type(&request);
        js_fetch_resource(id, &url, kind, cors_mode);
    }
}

/// Infer the JS/gateway resource kind from tagged MIME, Accept, then URL extension.
/// The returned labels are wire values shared with PageScript; do not rename them.
pub(crate) fn infer_resource_kind(request: &Request) -> &'static str {
    if let Some(ct) = request.content_type.as_deref() {
        let essence = mime_essence(ct);
        if !essence.is_empty() {
            if let Some(kind) = kind_from_mime(essence) {
                return kind;
            }
        }
    }
    if let Some(accept) = request
        .headers
        .get(http::header::ACCEPT)
        .and_then(|h| h.to_str().ok())
    {
        if let Some(kind) = kind_from_accept(accept) {
            return kind;
        }
    }
    if let Some(kind) = kind_from_extension(request.url.path()) {
        return kind;
    }
    "Other"
}

fn mime_essence(content_type: &str) -> &str {
    match content_type.split_once(';') {
        Some((essence, _)) => essence.trim(),
        None => content_type.trim(),
    }
}

fn cors_mode_from_content_type(request: &Request) -> &'static str {
    let Some(ct) = request.content_type.as_deref() else {
        return "";
    };
    for param in ct.split(';').skip(1) {
        let Some((name, value)) = param.split_once('=') else {
            continue;
        };
        if name.trim() != "ks-cors" {
            continue;
        }
        return match value.trim() {
            "cors" => "cors",
            "no-cors" => "no-cors",
            _ => "",
        };
    }
    ""
}

fn kind_from_mime(mime: &str) -> Option<&'static str> {
    let lower = mime.to_ascii_lowercase();
    if lower.starts_with("text/css") {
        return Some("Stylesheet");
    }
    if lower.starts_with("image/") {
        return Some("Image");
    }
    if lower.starts_with("font/") || lower == "application/font-woff" {
        return Some("Font");
    }
    if lower.starts_with("audio/") || lower.starts_with("video/") {
        return Some("Media");
    }
    if lower.starts_with("text/html") || lower.starts_with("application/xhtml") {
        return Some("Document");
    }
    if lower == "application/javascript"
        || lower == "text/javascript"
        || lower == "application/ecmascript"
    {
        return Some("Script");
    }
    None
}

fn kind_from_accept(accept: &str) -> Option<&'static str> {
    let first = accept.split(',').next()?.trim();
    let mime = first.split(';').next()?.trim();
    kind_from_mime(mime)
}

fn kind_from_extension(path: &str) -> Option<&'static str> {
    let last_seg = path.rsplit('/').next()?;
    let dot = last_seg.rfind('.')?;
    let ext = &last_seg[dot + 1..];
    let mut buf = [0u8; MAX_RESOURCE_EXTENSION_BYTES];
    if ext.len() > MAX_RESOURCE_EXTENSION_BYTES {
        return None;
    }
    for (i, b) in ext.bytes().enumerate() {
        buf[i] = b.to_ascii_lowercase();
    }
    let lower = &buf[..ext.len()];
    match lower {
        b"css" => Some("Stylesheet"),
        b"png" | b"jpg" | b"jpeg" | b"gif" | b"webp" | b"svg" | b"avif" | b"ico" => Some("Image"),
        b"woff" | b"woff2" | b"ttf" | b"otf" | b"eot" => Some("Font"),
        b"mp3" | b"mp4" | b"webm" | b"ogg" | b"wav" | b"m4a" => Some("Media"),
        b"js" | b"mjs" => Some("Script"),
        b"html" | b"htm" => Some("Document"),
        _ => None,
    }
}

pub(crate) fn decode_data_url(url: &str) -> Result<Vec<u8>, &'static str> {
    let after_scheme = url.strip_prefix("data:").ok_or("not a data: URL")?;
    let comma_idx = after_scheme.find(',').ok_or("no comma in data: URL")?;
    let meta = &after_scheme[..comma_idx];
    let payload = &after_scheme[comma_idx + 1..];
    let is_base64 = meta.split(';').any(|s| s.eq_ignore_ascii_case("base64"));
    if is_base64 {
        let cleaned: Vec<u8> = payload
            .bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        decode_base64(&cleaned)
    } else {
        Ok(percent_decode(payload.as_bytes()))
    }
}

fn decode_base64(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &b in input {
        let v: u32 = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err("invalid base64 char"),
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn percent_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' && i + 2 < input.len() {
            let hi = hex_val(input[i + 1]);
            let lo = hex_val(input[i + 2]);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(if input[i] == b'+' { b' ' } else { input[i] });
        i += 1;
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn deliver_bytes(
    provider: &KitesurfNetProvider,
    request_id: u32,
    bytes: Vec<u8>,
    resource_key: u64,
    dims: Option<(u32, u32)>,
) -> bool {
    let Some(req) = provider.take_pending(request_id) else {
        return false;
    };
    let bytes = if req.kind == "Font" {
        strip_fetched_font_for_session(bytes, &req.url, resource_key)
    } else {
        bytes
    };
    let (w, h) = dims.unwrap_or((0, 0));
    kitesurf_set_pending_image(resource_key, w, h);
    req.handler.bytes(req.url, Bytes::from(bytes));
    kitesurf_set_pending_image(0, 0, 0);
    true
}

pub fn drop_pending(provider: &KitesurfNetProvider, request_id: u32) -> bool {
    let Some(req) = provider.take_pending(request_id) else {
        return false;
    };
    req.handler.bytes(req.url, Bytes::new());
    true
}

fn settle_unfetchable(handler: Box<dyn NetHandler>, url: String, kind: &str) {
    if matches!(kind, "Font" | "Stylesheet") {
        handler.bytes(url, Bytes::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_base64_roundtrip() {
        let bytes = decode_base64(b"SGVsbG8=").unwrap();
        assert_eq!(bytes, b"Hello");
    }

    #[test]
    fn data_url_base64() {
        let bytes = decode_data_url("data:text/plain;base64,SGVsbG8=").unwrap();
        assert_eq!(bytes, b"Hello");
    }

    #[test]
    fn data_url_url_encoded() {
        let bytes = decode_data_url("data:text/plain,Hello%20world").unwrap();
        assert_eq!(bytes, b"Hello world");
    }

    #[test]
    fn data_url_no_meta() {
        let bytes = decode_data_url("data:,Hi").unwrap();
        assert_eq!(bytes, b"Hi");
    }

    #[test]
    fn data_url_base64_with_whitespace() {
        let bytes = decode_data_url("data:image/png;base64,SGVs\n  bG8=").unwrap();
        assert_eq!(bytes, b"Hello");
    }

    #[test]
    fn image_crate_decodes_red_png() {
        let red_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
        let bytes = decode_base64(red_png_b64.as_bytes()).unwrap();
        assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n");
        let img = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .expect("guessed format")
            .decode()
            .expect("png decode");
        assert_eq!(img.width(), 8);
        assert_eq!(img.height(), 8);
    }

    fn req_with_accept(accept: &str, url: &str) -> Request {
        let mut r = Request::get(url::Url::parse(url).unwrap());
        if !accept.is_empty() {
            r.headers
                .insert(http::header::ACCEPT, accept.parse().unwrap());
        }
        r
    }

    #[test]
    fn infer_kind_accept_css() {
        let r = req_with_accept("text/css,*/*;q=0.1", "https://example.com/a.css");
        assert_eq!(infer_resource_kind(&r), "Stylesheet");
    }

    #[test]
    fn infer_kind_accept_image() {
        let r = req_with_accept("image/avif,image/webp,*/*", "https://example.com/x");
        assert_eq!(infer_resource_kind(&r), "Image");
    }

    #[test]
    fn infer_kind_accept_font() {
        let r = req_with_accept("font/woff2", "https://example.com/x");
        assert_eq!(infer_resource_kind(&r), "Font");
    }

    #[test]
    fn infer_kind_accept_media() {
        let r = req_with_accept("audio/webm", "https://example.com/x");
        assert_eq!(infer_resource_kind(&r), "Media");
    }

    #[test]
    fn infer_kind_accept_document() {
        let r = req_with_accept(
            "text/html,application/xhtml+xml,application/xml;q=0.9",
            "https://example.com/",
        );
        assert_eq!(infer_resource_kind(&r), "Document");
    }

    #[test]
    fn infer_kind_extension_fallback_woff2() {
        let r = req_with_accept("", "https://cdn.example.com/static/Noto.woff2");
        assert_eq!(infer_resource_kind(&r), "Font");
    }

    #[test]
    fn infer_kind_extension_fallback_css() {
        let r = req_with_accept("*/*", "https://cdn.example.com/site.css");
        assert_eq!(infer_resource_kind(&r), "Stylesheet");
    }

    #[test]
    fn infer_kind_extension_uppercase() {
        let r = req_with_accept("*/*", "https://cdn.example.com/Image.PNG");
        assert_eq!(infer_resource_kind(&r), "Image");
    }

    #[test]
    fn infer_kind_no_signal() {
        let r = req_with_accept("*/*", "https://api.example.com/endpoint");
        assert_eq!(infer_resource_kind(&r), "Other");
    }

    #[test]
    fn infer_kind_content_type_css() {
        let mut r = Request::get(
            url::Url::parse("https://en.wikipedia.org/w/load.php?lang=en&modules=skins").unwrap(),
        );
        r.content_type = Some("text/css".to_string());
        assert_eq!(infer_resource_kind(&r), "Stylesheet");
    }

    #[test]
    fn infer_kind_content_type_image() {
        let mut r = Request::get(
            url::Url::parse("https://upload.wikimedia.org/thumb.php?f=Foo.jpg").unwrap(),
        );
        r.content_type = Some("image/*".to_string());
        assert_eq!(infer_resource_kind(&r), "Image");
    }

    #[test]
    fn infer_kind_content_type_wins_over_extension() {
        let mut r = Request::get(url::Url::parse("https://example.com/foo.png").unwrap());
        r.content_type = Some("text/css".to_string());
        assert_eq!(infer_resource_kind(&r), "Stylesheet");
    }

    mod settle_policy {
        use super::super::settle_unfetchable;
        use blitz_traits::net::{Bytes, NetHandler};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        struct Spy(Arc<AtomicBool>);
        impl NetHandler for Spy {
            fn bytes(self: Box<Self>, _url: String, _bytes: Bytes) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        fn settled(kind: &str) -> bool {
            let flag = Arc::new(AtomicBool::new(false));
            settle_unfetchable(Box::new(Spy(flag.clone())), "x:y".to_string(), kind);
            flag.load(Ordering::SeqCst)
        }

        #[test]
        fn font_and_stylesheet_settle_other_kinds_drop() {
            assert!(settled("Font"), "an unsettled face blocks its family");
            assert!(settled("Stylesheet"), "an unsettled sheet parks paint");
            assert!(!settled("Image"), "an image holds its pre-load look");
            assert!(!settled("Other"));
        }
    }

    mod font_block_period {
        use blitz_dom::net::{clear_unloaded_face, face_pending_for_style, note_unloaded_faces};
        use parley::fontique::FontStyle;

        fn note(family: &str, style: Option<FontStyle>) {
            note_unloaded_faces([(family.to_string(), style)]);
        }

        #[test]
        fn pending_face_blocks_only_its_own_style() {
            note("ks-blocks-own", Some(FontStyle::Italic));
            assert!(face_pending_for_style("ks-blocks-own", FontStyle::Italic));
            assert!(!face_pending_for_style("ks-blocks-own", FontStyle::Normal));
            clear_unloaded_face("ks-blocks-own", Some(FontStyle::Italic));
        }

        #[test]
        fn delivery_unblocks_the_family() {
            note("ks-unblocks", Some(FontStyle::Normal));
            assert!(face_pending_for_style("ks-unblocks", FontStyle::Normal));
            clear_unloaded_face("ks-unblocks", Some(FontStyle::Normal));
            assert!(!face_pending_for_style("ks-unblocks", FontStyle::Normal));
        }

        #[test]
        fn face_without_a_style_descriptor_blocks_every_style() {
            note("ks-nodesc", None);
            assert!(face_pending_for_style("ks-nodesc", FontStyle::Normal));
            assert!(face_pending_for_style("ks-nodesc", FontStyle::Italic));
            clear_unloaded_face("ks-nodesc", None);
            assert!(!face_pending_for_style("ks-nodesc", FontStyle::Normal));
        }

        #[test]
        fn clearing_one_face_leaves_a_sibling_pending() {
            note("ks-two-faces", Some(FontStyle::Italic));
            note("ks-two-faces", Some(FontStyle::Normal));
            clear_unloaded_face("ks-two-faces", Some(FontStyle::Italic));
            assert!(!face_pending_for_style("ks-two-faces", FontStyle::Italic));
            assert!(face_pending_for_style("ks-two-faces", FontStyle::Normal));
            clear_unloaded_face("ks-two-faces", Some(FontStyle::Normal));
        }

        #[test]
        fn an_undeclared_family_never_blocks() {
            assert!(!face_pending_for_style("ks-undeclared", FontStyle::Normal));
        }
    }
}
