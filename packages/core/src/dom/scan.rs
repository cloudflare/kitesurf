// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Tokenizes HTML to collect script, import-map, and iframe metadata before page setup.

use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, Tag, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
pub(crate) struct ScanScript {
    pub src: Option<String>,
    pub kind: &'static str,
    pub defer: bool,
    #[serde(rename = "async")]
    pub is_async: bool,
    pub body: String,
    #[serde(rename = "crossOrigin")]
    pub cross_origin: Option<String>,
    pub integrity: Option<String>,
    pub nonce: Option<String>,
    #[serde(rename = "scriptDomIndex")]
    pub script_dom_index: usize,
}

#[derive(Serialize)]
pub(crate) struct ScanIframe {
    pub src: Option<String>,
    pub name: Option<String>,
    pub loading: Option<String>,
    #[serde(rename = "docOrderIndex")]
    pub doc_order_index: usize,
}

#[derive(Serialize)]
pub(crate) struct ScanImportMap {
    pub body: String,
    #[serde(rename = "scriptDomIndex")]
    pub script_dom_index: usize,
    #[serde(rename = "baseHref")]
    pub base_href: Option<String>,
    pub nonce: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ScanResult {
    pub title: String,
    #[serde(rename = "baseHref")]
    pub base_href: Option<String>,
    #[serde(rename = "metaCsp")]
    pub meta_csp: Vec<String>,
    #[serde(rename = "importMaps")]
    pub import_maps: Vec<ScanImportMap>,
    pub scripts: Vec<ScanScript>,
    pub iframes: Vec<ScanIframe>,
}

enum Capture {
    Script {
        attrs: Vec<(String, String)>,
        body: String,
        index: Option<usize>,
        foreign: bool,
        nesting: usize,
    },
    Title {
        text: String,
    },
}

fn is_xhtml_document(html: &str) -> bool {
    html.starts_with("<?xml")
        || (html.starts_with("<!DOCTYPE") && {
            let first_line = html.lines().next().unwrap_or("");
            let prolog = &first_line[..prolog_end(first_line)];
            prolog.contains("XHTML") || prolog.contains("xhtml")
        })
}

fn prolog_end(line: &str) -> usize {
    let bytes = line.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'<' if bytes[i..].starts_with(b"<!--") => match line[i + 4..].find("-->") {
                Some(end) => i += 4 + end + 3,
                None => return bytes.len(),
            },
            q @ (b'"' | b'\'') if depth > 0 => match bytes[i + 1..].iter().position(|&c| c == q) {
                Some(end) => i += end + 2,
                None => return bytes.len(),
            },
            b'<' => {
                let rest = &bytes[i + 1..];
                let is_start_tag = rest.first().is_some_and(|c| c.is_ascii_alphabetic());
                let is_root = rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(b"html");
                if is_start_tag && !is_root {
                    return i;
                }
                if is_start_tag || matches!(rest.first(), Some(b'!' | b'?')) {
                    depth += 1;
                }
                i += 1;
            }
            b'>' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    bytes.len()
}

fn decode_xml_refs(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let semi = tail[1..]
            .char_indices()
            .take(10)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i + 1);
        let Some(semi) = semi else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..semi];
        let decoded = match name {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix('#')
                .and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => n.parse::<u32>().ok(),
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn xml_script_text(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("<![CDATA[") {
        out.push_str(&decode_xml_refs(&rest[..start]));
        let after = &rest[start + "<![CDATA[".len()..];
        let Some(end) = after.find("]]>") else {
            out.push_str(after);
            return out;
        };
        out.push_str(&after[..end]);
        rest = &after[end + "]]>".len()..];
    }
    out.push_str(&decode_xml_refs(rest));
    out
}

#[derive(Default)]
struct ScanState {
    title: Option<String>,
    base_href: Option<String>,
    meta_csp: Vec<String>,
    import_maps: Vec<ScanImportMap>,
    scripts: Vec<ScanScript>,
    iframes: Vec<ScanIframe>,
    capture: Option<Capture>,
    template_depth: usize,
    foreign_depth: usize,
    script_counter: usize,
    is_xhtml: bool,
}

struct ScanSink {
    state: RefCell<ScanState>,
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn tag_attrs(tag: &Tag) -> Vec<(String, String)> {
    tag.attrs
        .iter()
        .map(|a| (str::to_ascii_lowercase(&a.name.local), a.value.to_string()))
        .collect()
}

impl ScanState {
    fn finish_script(&mut self, attrs: Vec<(String, String)>, body: String, index: Option<usize>) {
        let Some(index) = index else { return };
        let raw_type = attr(&attrs, "type")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if raw_type == "importmap" {
            if attr(&attrs, "src").is_none() && !body.trim().is_empty() {
                self.import_maps.push(ScanImportMap {
                    body,
                    script_dom_index: index,
                    base_href: self.base_href.clone(),
                    nonce: attr(&attrs, "nonce")
                        .filter(|v| !v.is_empty())
                        .map(|v| v.to_string()),
                });
            }
            return;
        }
        if !raw_type.is_empty()
            && raw_type != "text/javascript"
            && raw_type != "application/javascript"
            && raw_type != "module"
        {
            return;
        }
        let src = attr(&attrs, "src").map(str::trim).unwrap_or("");
        let body = if src.is_empty() { body } else { String::new() };
        let body = if self.is_xhtml {
            xml_script_text(&body)
        } else {
            body
        };
        if src.is_empty() && body.trim().is_empty() {
            return;
        }
        self.scripts.push(ScanScript {
            src: if src.is_empty() {
                None
            } else {
                Some(src.to_string())
            },
            kind: if raw_type == "module" {
                "module"
            } else {
                "classic"
            },
            defer: attr(&attrs, "defer").is_some(),
            is_async: attr(&attrs, "async").is_some(),
            body,
            cross_origin: attr(&attrs, "crossorigin").map(|v| v.to_string()),
            integrity: attr(&attrs, "integrity")
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string()),
            nonce: attr(&attrs, "nonce")
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string()),
            script_dom_index: index,
        });
    }

    fn start_script(&mut self, tag: &Tag, foreign: bool) {
        // Count non-template scripts before filtering type.
        // Indices therefore follow the document's script order.
        let index = if self.template_depth == 0 {
            let i = self.script_counter;
            self.script_counter += 1;
            Some(i)
        } else {
            None
        };
        let attrs = tag_attrs(tag);
        if (foreign || self.is_xhtml) && tag.self_closing {
            self.finish_script(attrs, String::new(), index);
            return;
        }
        self.capture = Some(Capture::Script {
            attrs,
            body: String::new(),
            index,
            foreign,
            nesting: 0,
        });
    }
}

impl TokenSink for ScanSink {
    type Handle = ();

    fn adjusted_current_node_present_but_not_in_html_namespace(&self) -> bool {
        self.state.borrow().foreign_depth > 0
    }

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        let mut s = self.state.borrow_mut();

        if s.capture.is_some() {
            let done = match (&mut s.capture, &token) {
                (Some(Capture::Script { body, .. }), Token::CharacterTokens(t)) => {
                    body.push_str(t);
                    false
                }
                (Some(Capture::Script { body, .. }), Token::NullCharacterToken) => {
                    body.push('\u{FFFD}');
                    false
                }
                (
                    Some(Capture::Script {
                        foreign, nesting, ..
                    }),
                    Token::TagToken(tag),
                ) if &*tag.name == "script" => match tag.kind {
                    // Only reachable for foreign scripts: raw-text
                    // script content never tokenizes nested tags.
                    TagKind::StartTag => {
                        if *foreign && !tag.self_closing {
                            *nesting += 1;
                        }
                        false
                    }
                    TagKind::EndTag => {
                        if *nesting > 0 {
                            *nesting -= 1;
                            false
                        } else {
                            true
                        }
                    }
                },
                (Some(Capture::Title { text }), Token::CharacterTokens(t)) => {
                    text.push_str(t);
                    false
                }
                (Some(Capture::Title { text }), Token::NullCharacterToken) => {
                    text.push('\u{FFFD}');
                    false
                }
                (Some(Capture::Title { .. }), Token::TagToken(tag))
                    if tag.kind == TagKind::EndTag && &*tag.name == "title" =>
                {
                    true
                }
                (Some(_), Token::EOFToken) => true,
                _ => false,
            };
            if done {
                match s.capture.take() {
                    Some(Capture::Script {
                        attrs, body, index, ..
                    }) => s.finish_script(attrs, body, index),
                    Some(Capture::Title { text }) if s.title.is_none() => {
                        s.title = Some(text);
                    }
                    Some(Capture::Title { .. }) | None => {}
                }
            }
            return TokenSinkResult::Continue;
        }

        let Token::TagToken(tag) = &token else {
            return TokenSinkResult::Continue;
        };
        let name: &str = tag.name.as_ref();

        if tag.kind == TagKind::EndTag {
            match name {
                "template" => s.template_depth = s.template_depth.saturating_sub(1),
                "svg" | "math" => s.foreign_depth = s.foreign_depth.saturating_sub(1),
                _ => {}
            }
            return TokenSinkResult::Continue;
        }

        if s.foreign_depth > 0 {
            match name {
                "svg" | "math" => {
                    if !tag.self_closing {
                        s.foreign_depth += 1;
                    }
                }
                "script" => s.start_script(tag, true),
                _ => {}
            }
            return TokenSinkResult::Continue;
        }

        let xml_closed = s.is_xhtml && tag.self_closing;

        match name {
            "script" => {
                s.start_script(tag, false);
                if xml_closed {
                    TokenSinkResult::Continue
                } else {
                    TokenSinkResult::RawData(RawKind::ScriptData)
                }
            }
            "title" => {
                if xml_closed {
                    return TokenSinkResult::Continue;
                }
                if s.title.is_none() && s.template_depth == 0 {
                    s.capture = Some(Capture::Title {
                        text: String::new(),
                    });
                }
                TokenSinkResult::RawData(RawKind::Rcdata)
            }
            "textarea" if !xml_closed => TokenSinkResult::RawData(RawKind::Rcdata),
            "style" | "xmp" | "noembed" | "noframes" | "noscript" if !xml_closed => {
                TokenSinkResult::RawData(RawKind::Rawtext)
            }
            "iframe" => {
                if s.template_depth == 0 {
                    let attrs = tag_attrs(tag);
                    let idx = s.iframes.len();
                    s.iframes.push(ScanIframe {
                        src: attr(&attrs, "src").map(|v| v.to_string()),
                        name: attr(&attrs, "name").map(|v| v.to_string()),
                        loading: attr(&attrs, "loading").map(|v| v.to_string()),
                        doc_order_index: idx,
                    });
                }
                if xml_closed {
                    TokenSinkResult::Continue
                } else {
                    TokenSinkResult::RawData(RawKind::Rawtext)
                }
            }
            "plaintext" if !xml_closed => TokenSinkResult::Plaintext,
            "base" => {
                if s.base_href.is_none() && s.template_depth == 0 {
                    if let Some(href) = attr(&tag_attrs(tag), "href") {
                        s.base_href = Some(href.to_string());
                    }
                }
                TokenSinkResult::Continue
            }
            "meta" => {
                capture_meta_csp(&mut s, tag);
                TokenSinkResult::Continue
            }
            "template" => {
                if !xml_closed {
                    s.template_depth += 1;
                }
                TokenSinkResult::Continue
            }
            "svg" | "math" => {
                if !tag.self_closing {
                    s.foreign_depth += 1;
                }
                TokenSinkResult::Continue
            }
            _ => TokenSinkResult::Continue,
        }
    }
}

fn capture_meta_csp(state: &mut ScanState, tag: &Tag) {
    if state.template_depth != 0 {
        return;
    }
    let attrs = tag_attrs(tag);
    let equiv = attr(&attrs, "http-equiv")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if equiv != "content-security-policy" {
        return;
    }
    if let Some(content) = attr(&attrs, "content") {
        let content = content.trim();
        if !content.is_empty() {
            state.meta_csp.push(content.to_string());
        }
    }
}

pub(crate) fn scan_document(html: &str) -> ScanResult {
    let sink = ScanSink {
        state: RefCell::new(ScanState {
            is_xhtml: is_xhtml_document(html),
            ..ScanState::default()
        }),
    };
    let tokenizer = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(html));
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    let s = tokenizer.sink.state.into_inner();
    ScanResult {
        title: s.title.unwrap_or_default(),
        base_href: s.base_href,
        meta_csp: s.meta_csp,
        import_maps: s.import_maps,
        scripts: s.scripts,
        iframes: s.iframes,
    }
}

#[wasm_bindgen]
pub fn ks_scan_document(html: &str) -> String {
    serde_json::to_string(&scan_document(html)).unwrap_or_else(|_| {
        "{\"title\":\"\",\"baseHref\":null,\"metaCsp\":[],\"importMaps\":[],\"scripts\":[],\"iframes\":[]}"
            .to_string()
    })
}
