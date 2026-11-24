// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::{HtmlDocument, HtmlProvider};
use std::sync::Arc;

use crate::DomHandle;

const PAGE_URL: &str = "https://doc.example/a/page.html";

#[test]
fn image_fetches_resolve_against_the_base_href() {
    let document = HtmlDocument::from_html(
        r#"<!DOCTYPE html><head><base href="/b/"></head><body><img src="p.png">"#,
        DocumentConfig {
            base_url: Some(PAGE_URL.to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            ..Default::default()
        },
    );
    let doc: &BaseDocument = document.as_ref();
    assert_eq!(
        doc.pending_image_nodes("https://doc.example/b/p.png").len(),
        1
    );
    assert!(doc
        .pending_image_nodes("https://doc.example/a/p.png")
        .is_empty());
    assert_eq!(
        doc.url().as_str(),
        PAGE_URL,
        "the document URL does not move"
    );
}

#[test]
fn document_base_url_follows_the_base_href() {
    let dom = DomHandle::new(
        r#"<!DOCTYPE html><head><base href="/b/"></head><body>"#,
        PAGE_URL,
    );
    assert_eq!(dom.document_base_url(), "https://doc.example/b/");
    assert_eq!(dom.base_url(), PAGE_URL, "baseURL() stays the document URL");

    let base = dom.query_selector("base").expect("query ok") as u32;
    assert!(dom.set_attribute(base, "href", "https://c.example/d/"));
    assert_eq!(dom.document_base_url(), "https://c.example/d/");
    assert!(dom.set_attribute(base, "href", "data:/x/"));
    assert_eq!(dom.document_base_url(), PAGE_URL);
}

#[test]
fn document_base_url_without_a_base_is_the_document_url() {
    let dom = DomHandle::new("<!DOCTYPE html><p>no base</p>", PAGE_URL);
    assert_eq!(dom.document_base_url(), PAGE_URL);
}
