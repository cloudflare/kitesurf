// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use std::sync::{Arc, Mutex};

const FONT_URL: &str = "https://fonts.test/subset";

struct RecordingNetProvider {
    requests: Mutex<Vec<String>>,
    stylesheet: String,
}

impl NetProvider for RecordingNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        if request.url.path() == "/style.css" {
            handler.bytes(url, Bytes::from(self.stylesheet.clone()));
            return;
        }
        self.requests
            .lock()
            .expect("request lock is not poisoned")
            .push(url.clone());
        handler.bytes(url, Bytes::new());
    }
}

impl RecordingNetProvider {
    fn requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("request lock is not poisoned")
            .clone()
    }
}

fn document_with_stylesheet(
    stylesheet: &str,
    body: &str,
) -> (HtmlDocument, Arc<RecordingNetProvider>) {
    let net_provider = Arc::new(RecordingNetProvider {
        requests: Mutex::new(Vec::new()),
        stylesheet: stylesheet.to_string(),
    });
    let markup = format!(r#"<link rel="stylesheet" href="/style.css">{body}"#);
    let document = HtmlDocument::from_html(
        &markup,
        DocumentConfig {
            base_url: Some("https://fonts.test/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            net_provider: Some(net_provider.clone()),
            ..Default::default()
        },
    );
    (document, net_provider)
}

fn resolve(document: &mut HtmlDocument, passes: usize) {
    for _ in 0..passes {
        let doc: &mut BaseDocument = document.as_mut();
        doc.resolve(0.0);
    }
}

fn fetch_requests(stylesheet: &str, body: &str) -> Vec<String> {
    let (mut document, net_provider) = document_with_stylesheet(stylesheet, body);
    resolve(&mut document, 2);
    net_provider.requests()
}

// One `@font-face` for the "Subset" family at /subset, with an optional unicode-range.
fn face(unicode_range: Option<&str>) -> String {
    let range = unicode_range.map_or(String::new(), |r| format!("unicode-range: {r};"));
    format!(r#"@font-face {{ font-family: "Subset"; src: url("/subset"); {range} }}"#)
}

#[test]
fn same_url_font_faces_keep_distinct_unicode_ranges() {
    let latin = face(Some("U+0000-00FF"));
    let cyrillic = face(Some("U+0400-04FF"));
    for (faces, expected) in [
        (face(None), &[FONT_URL][..]),
        (latin.clone(), &[]),
        (cyrillic.clone(), &[FONT_URL]),
        (format!("{latin}\n{cyrillic}"), &[FONT_URL]),
    ] {
        let stylesheet = format!(r#"{faces} p {{ font-family: "Subset"; }}"#);
        assert_eq!(fetch_requests(&stylesheet, "<p>Ж</p>"), expected, "{faces}");
    }
}

#[test]
fn template_text_does_not_trigger_a_font_subset_fetch() {
    let stylesheet = format!(
        r#"{} p {{ font-family: "Subset"; }}"#,
        face(Some("U+0370-03FF"))
    );
    let requests = fetch_requests(&stylesheet, "<p>Ж</p><template>Ω</template>");

    assert!(requests.is_empty());
}

#[test]
fn detached_text_triggers_a_subset_fetch_only_after_insertion() {
    let stylesheet = format!(
        r#"{} p {{ font-family: "Subset"; }}"#,
        face(Some("U+0370-03FF"))
    );
    let (mut document, net_provider) = document_with_stylesheet(&stylesheet, "<p>Ж</p>");
    resolve(&mut document, 2);
    assert!(net_provider.requests().is_empty());

    let text_id = {
        let doc: &mut BaseDocument = document.as_mut();
        let mut mutator = doc.mutate();
        mutator.create_text_node("Ω")
    };
    resolve(&mut document, 1);
    assert!(net_provider.requests().is_empty());

    {
        let doc: &mut BaseDocument = document.as_mut();
        let root_id = doc.root_node().id;
        let mut mutator = doc.mutate();
        mutator.append_children(root_id, &[text_id]);
    }
    resolve(&mut document, 1);

    assert_eq!(net_provider.requests(), [FONT_URL]);
}

#[test]
fn generated_content_triggers_a_subset_fetch() {
    let stylesheet = format!(
        r#"{} p {{ font-family: "Subset"; }} p::before {{ content: "Ω"; }}"#,
        face(Some("U+0370-03FF"))
    );

    assert_eq!(fetch_requests(&stylesheet, "<p>x</p>"), [FONT_URL]);
}
