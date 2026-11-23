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
fn fonts_api_demand_fetches_only_matching_faces() {
    let stylesheet = r#"
        @font-face { font-family: "Used"; src: url("/used.woff2"); }
        @font-face { font-family: "Unused"; src: url("/unused.woff2"); }
        @font-face { font-family: "Subset"; src: url("/subset"); unicode-range: U+0370-03FF; }
        p { font-family: "Used"; }
    "#;
    // Lazy by default: only the face the styles use.
    assert_eq!(
        fetch_requests(stylesheet, "<p>hello</p>"),
        ["https://fonts.test/used.woff2"]
    );

    // Apply the stylesheet first so its @font-face rules are pending, then demand only "Unused".
    let (mut document, net_provider) = document_with_stylesheet(stylesheet, "<p>hello</p>");
    resolve(&mut document, 1);
    {
        let doc: &mut BaseDocument = document.as_mut();
        doc.demand_font_faces(&["Unused".to_string()], false, 400, " ");
    }
    resolve(&mut document, 2);
    let mut requests = net_provider.requests();
    requests.sort();
    assert_eq!(
        requests,
        [
            "https://fonts.test/unused.woff2",
            "https://fonts.test/used.woff2",
        ]
    );

    // A subset whose unicode-range does not cover the sample text stays unfetched until matched.
    {
        let doc: &mut BaseDocument = document.as_mut();
        doc.demand_font_faces(&["Subset".to_string()], false, 400, " ");
    }
    assert_eq!(net_provider.requests().len(), 2);
    {
        let doc: &mut BaseDocument = document.as_mut();
        doc.demand_font_faces(&["Subset".to_string()], false, 400, "Ω");
    }
    let mut requests = net_provider.requests();
    requests.sort();
    assert_eq!(
        requests,
        [
            "https://fonts.test/subset",
            "https://fonts.test/unused.woff2",
            "https://fonts.test/used.woff2",
        ]
    );
}

#[test]
fn fonts_api_demand_respects_weight_style_and_unicode_range_on_multi_slice_sheet() {
    // Google Fonts css2 shape: 2 families x 3 weights x 7 unicode-range slices = 42 faces.
    let slices = [
        ("latin", "U+0000-00FF"),
        ("latin-ext", "U+0100-02BA"),
        ("cyrillic", "U+0400-045F"),
        ("cyrillic-ext", "U+0460-052F"),
        ("greek", "U+0370-0377"),
        ("greek-ext", "U+1F00-1FFF"),
        ("vietnamese", "U+0102-0103"),
    ];
    let mut stylesheet = String::new();
    for family in ["Body", "Display"] {
        for weight in [400, 600, 700] {
            for (slice, range) in slices {
                stylesheet.push_str(&format!(
                    r#"@font-face {{ font-family: "{family}"; font-weight: {weight}; src: url("/{family}-{weight}-{slice}.woff2"); unicode-range: {range}; }}
"#
                ));
            }
        }
    }
    stylesheet.push_str(r#"p { font-family: "Body"; font-weight: 400; }"#);

    let (mut document, net_provider) = document_with_stylesheet(&stylesheet, "<p>hello</p>");
    resolve(&mut document, 1);
    assert_eq!(
        net_provider.requests(),
        ["https://fonts.test/Body-400-latin.woff2"]
    );

    {
        let doc: &mut BaseDocument = document.as_mut();
        doc.demand_font_faces(&["Display".to_string()], false, 700, " ");
    }
    resolve(&mut document, 2);
    let mut requests = net_provider.requests();
    requests.sort();
    assert_eq!(
        requests,
        [
            "https://fonts.test/Body-400-latin.woff2",
            "https://fonts.test/Display-700-latin.woff2",
        ]
    );
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
        let root_id = doc.root_node().id();
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

#[test]
fn a_style_only_resolve_starts_the_font_fetch() {
    let stylesheet = format!(r#"{} p {{ font-family: "Subset"; }}"#, face(None));
    let (mut document, net_provider) = document_with_stylesheet(&stylesheet, "<p>x</p>");
    for _ in 0..2 {
        let doc: &mut BaseDocument = document.as_mut();
        doc.resolve_style(0.0);
    }

    assert_eq!(net_provider.requests(), [FONT_URL]);
}

#[test]
fn unused_weights_styles_and_display_none_faces_are_deferred() {
    let stylesheet = r#"
        @font-face { font-family: "Multi"; src: url("/w100.woff2"); font-weight: 100; font-style: normal; }
        @font-face { font-family: "Multi"; src: url("/w400.woff2"); font-weight: 400; font-style: normal; }
        @font-face { font-family: "Multi"; src: url("/w700.woff2"); font-weight: 700; font-style: normal; }
        @font-face { font-family: "Multi"; src: url("/w400i.woff2"); font-weight: 400; font-style: italic; }
        @font-face { font-family: "HiddenOnly"; src: url("/hidden.woff2"); font-weight: 400; }
        p { font-family: "Multi"; font-weight: 400; }
        .gone { display: none; font-family: "HiddenOnly"; }
    "#;
    let requests = fetch_requests(stylesheet, r#"<p>hello</p><div class="gone">secret</div>"#);
    assert_eq!(requests, ["https://fonts.test/w400.woff2"]);
}

#[test]
fn css_weight_fallback_and_variable_fonts_select_expected_faces() {
    let stylesheet = r#"
        @font-face { font-family: "Mid"; src: url("/m300.woff2"); font-weight: 300; }
        @font-face { font-family: "Mid"; src: url("/m500.woff2"); font-weight: 500; }
        @font-face { font-family: "Mid"; src: url("/m700.woff2"); font-weight: 700; }
        @font-face { font-family: "Var"; src: url("/var.woff2"); font-weight: 100 900; }
        .a { font-family: "Mid"; font-weight: 450; }
        .b { font-family: "Var"; font-weight: 650; }
    "#;
    let mut requests = fetch_requests(stylesheet, r#"<p class="a">a</p><p class="b">b</p>"#);
    requests.sort();
    assert_eq!(
        requests,
        [
            "https://fonts.test/m500.woff2",
            "https://fonts.test/var.woff2",
        ]
    );
}

#[test]
fn fallback_family_is_deferred_while_primary_covers_or_is_pending() {
    const MONO: &[u8] = include_bytes!("../../../../engine/public/fonts/NotoSansMono.ttf");

    struct FontProvider {
        requests: Mutex<Vec<String>>,
        stylesheet: String,
        primary_bytes: &'static [u8],
    }

    impl NetProvider for FontProvider {
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
            let body = if request.url.path() == "/primary.woff2" {
                Bytes::from_static(self.primary_bytes)
            } else {
                Bytes::new()
            };
            handler.bytes(url, body);
        }
    }

    let stylesheet = r#"
        @font-face { font-family: "Primary"; src: url("/primary.woff2"); }
        @font-face { font-family: "Fallback"; src: url("/fallback.woff2"); }
        @font-face { font-family: "HiddenChild"; src: url("/hidden-child.woff2"); }
        @font-face { font-family: "Def"; src: url("/def-reg.woff2"); }
        @font-face { font-family: "Def"; src: url("/def-bold.woff2"); font-weight: 700; }
        .p { font-family: "Primary", "Fallback"; }
        .m { font-family: "NotInstalled", "Fallback"; }
        .gone { display: none; }
        .hc { font-family: "HiddenChild"; }
        .d { font-family: "Def"; }
    "#;

    let run = |body: &str, primary_bytes: &'static [u8]| -> Vec<String> {
        let net = Arc::new(FontProvider {
            requests: Mutex::new(Vec::new()),
            stylesheet: stylesheet.to_string(),
            primary_bytes,
        });
        let markup = format!(r#"<link rel="stylesheet" href="/style.css">{body}"#);
        let mut doc = HtmlDocument::from_html(
            &markup,
            DocumentConfig {
                base_url: Some("https://fonts.test/".to_string()),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                net_provider: Some(net.clone()),
                ..Default::default()
            },
        );
        resolve(&mut doc, 3);
        let mut reqs = net.requests.lock().expect("lock").clone();
        reqs.sort();
        reqs
    };

    // Primary covers Latin text: Fallback, HiddenChild, and unused Def bold stay deferred.
    assert_eq!(
        run(
            r#"<p class="p">hello</p><div class="gone"><span class="hc">secret</span></div><p class="d">reg</p>"#,
            MONO,
        ),
        [
            "https://fonts.test/def-reg.woff2",
            "https://fonts.test/primary.woff2",
        ]
    );

    // Primary loads but lacks Hangul glyph: Fallback is fetched on the follow-up pass.
    assert_eq!(
        run(r#"<p class="p">hello 한</p>"#, MONO),
        [
            "https://fonts.test/fallback.woff2",
            "https://fonts.test/primary.woff2",
        ]
    );

    // Primary fails (empty bytes): Fallback is fetched on recovery pass.
    assert_eq!(
        run(r#"<p class="p">hello</p>"#, b""),
        [
            "https://fonts.test/fallback.woff2",
            "https://fonts.test/primary.woff2",
        ]
    );

    // Uninstalled leading family falls through to Fallback immediately.
    assert_eq!(
        run(r#"<p class="m">hello</p>"#, MONO),
        ["https://fonts.test/fallback.woff2"]
    );

    // No text still loads the primary family: font-relative units (cap, ch, ex, ic) read
    // their metrics from it. Fallbacks need glyph coverage, so they stay deferred.
    assert_eq!(
        run(r#"<div class="p"></div>"#, MONO),
        ["https://fonts.test/primary.woff2"]
    );
}

#[test]
fn same_source_keeps_both_variable_weight_ranges() {
    let requests = fetch_requests(
        r#"
        @font-face { font-family: F; src: url("/var.woff2"); font-weight: 100 300; }
        @font-face { font-family: F; src: url("/var.woff2"); font-weight: 700 900; }
        @font-face { font-family: F; src: url("/w600.woff2"); font-weight: 600; }
        p { font-family: F; font-weight: 800; }
        "#,
        "<p>hello</p>",
    );
    assert_eq!(requests, ["https://fonts.test/var.woff2"]);
}

#[test]
fn matching_width_query_is_critical_and_print_or_disabled_are_not() {
    struct HoldingNetProvider {
        requests: Mutex<Vec<String>>,
    }

    impl NetProvider for HoldingNetProvider {
        fn fetch(&self, _doc_id: usize, request: Request, _handler: Box<dyn NetHandler>) {
            self.requests
                .lock()
                .expect("lock")
                .push(request.url.to_string());
        }
    }

    let make = |head_link: &str| {
        let net = Arc::new(HoldingNetProvider {
            requests: Mutex::new(Vec::new()),
        });
        let doc = HtmlDocument::from_html(
            &format!("<head>{head_link}</head><p>hello</p>"),
            DocumentConfig {
                base_url: Some("https://fonts.test/".into()),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                net_provider: Some(net.clone()),
                ..Default::default()
            },
        );
        let reqs = net.requests.lock().expect("lock").clone();
        (doc.as_ref().has_pending_critical_resources(), reqs)
    };

    let (crit_mq, reqs_mq) =
        make(r#"<link rel="stylesheet" href="/mq.css" media="screen and (min-width: 1px)">"#);
    assert!(crit_mq, "matching media query must remain render-blocking");
    assert_eq!(reqs_mq, ["https://fonts.test/mq.css"]);

    let (crit_print, reqs_print) =
        make(r#"<link rel="stylesheet" href="/print.css" media="print">"#);
    assert!(!crit_print, "print stylesheet must not block DCL");
    assert_eq!(reqs_print, ["https://fonts.test/print.css"]);

    let (crit_disabled, reqs_disabled) =
        make(r#"<link rel="stylesheet" href="/off.css" disabled>"#);
    assert!(!crit_disabled, "disabled stylesheet must not block DCL");
    assert!(
        reqs_disabled.is_empty(),
        "disabled stylesheet is not fetched"
    );
}

#[test]
fn pseudo_element_icon_font_fetches_during_style_resolve_and_mixed_family_gates_fallback() {
    let css = r#"
        @font-face { font-family: "Icons"; src: url("/icons.woff2"); unicode-range: U+F000-F8FF; }
        @font-face { font-family: "Mixed"; src: url("/mixed-plain.woff2"); }
        @font-face { font-family: "Mixed"; src: url("/mixed-cjk.woff2"); unicode-range: U+4E00-9FFF; }
        @font-face { font-family: "Fallback"; src: url("/fallback.woff2"); }
        .ico::before { font-family: "Icons"; content: "\f002"; }
        p { font-family: "Mixed", "Fallback"; }
    "#;
    let (mut doc, net) = document_with_stylesheet(css, "<span class='ico'></span><p>hello</p>");
    doc.as_mut().handle_messages();
    doc.as_mut().resolve_style(0.0);

    let mut reqs = net.requests();
    reqs.sort();
    assert_eq!(
        reqs,
        [
            "https://fonts.test/icons.woff2",
            "https://fonts.test/mixed-plain.woff2",
        ],
        "pseudo-element icon font must fetch on resolve_style and plain face must gate Fallback"
    );
}

#[test]
fn script_and_style_non_latin_text_does_not_bump_non_latin_writes() {
    let html = "<script>const s = '\u{4E2D}\u{6587}';</script><style>/* \u{65E5}\u{672C} */</style><p>ascii</p>";
    let (doc, _net) = document_with_stylesheet("", html);
    assert_eq!(
        doc.as_ref().non_latin_text_writes(),
        0,
        "non-rendered script/style text must not bump non_latin_text_writes"
    );
}

#[test]
fn setting_disabled_on_loaded_link_unloads_stylesheet() {
    let css = "p { color: rgb(255, 0, 0); }";
    let (mut doc, _net) = document_with_stylesheet(css, "<p id='p'>hi</p>");
    doc.as_mut().handle_messages();
    doc.as_mut().resolve_style(0.0);

    let link_id = doc
        .as_ref()
        .query_selector("link")
        .expect("selector")
        .expect("link");
    let p_id = doc
        .as_ref()
        .query_selector("#p")
        .expect("selector")
        .expect("#p");
    let red = doc
        .as_ref()
        .get_node(p_id)
        .unwrap()
        .primary_styles()
        .unwrap()
        .clone_color();
    assert_eq!(red.components.0, 1.0);
    assert_eq!(red.components.1, 0.0);
    assert_eq!(red.components.2, 0.0);

    let mut mutator = doc.as_mut().mutate();
    mutator.set_attribute(
        link_id,
        blitz_dom::QualName::new(None, blitz_dom::ns!(), blitz_dom::local_name!("disabled")),
        "",
    );
    drop(mutator);
    doc.as_mut().resolve_style(0.0);
    let after = doc
        .as_ref()
        .get_node(p_id)
        .unwrap()
        .primary_styles()
        .unwrap()
        .clone_color();
    assert_ne!(
        (after.components.0, after.components.1, after.components.2),
        (1.0, 0.0, 0.0),
        "setting disabled on a loaded <link> must unload its stylesheet"
    );

    // Removing href after disabled unload must not panic on already-cleared special data.
    let mut mutator = doc.as_mut().mutate();
    mutator.clear_attribute(
        link_id,
        blitz_dom::QualName::new(None, blitz_dom::ns!(), blitz_dom::local_name!("href")),
    );
    drop(mutator);
    doc.as_mut().resolve_style(0.0);
}

#[test]
fn dynamic_pseudo_content_fetches_subset_when_family_already_used_by_body() {
    let css = r#"
        @font-face { font-family: "Icons"; src: url("/icons.woff2"); unicode-range: U+E900-E9FF; }
        body { font-family: "Icons", sans-serif; }
        .ico::before { font-family: "Icons"; content: "\e900"; }
    "#;
    let (mut doc, net) = document_with_stylesheet(css, "<div id='host'>plain</div>");
    doc.as_mut().handle_messages();
    doc.as_mut().resolve_style(0.0);
    assert!(
        net.requests().is_empty(),
        "subset stays deferred without U+E900"
    );

    let host_id = doc
        .as_ref()
        .query_selector("#host")
        .expect("selector")
        .expect("#host");
    let mut mutator = doc.as_mut().mutate();
    let span = mutator.create_element(
        blitz_dom::QualName::new(None, blitz_dom::ns!(html), blitz_dom::local_name!("span")),
        vec![blitz_dom::Attribute::new(
            blitz_dom::QualName::new(None, blitz_dom::ns!(), blitz_dom::local_name!("class")),
            "ico".to_string(),
        )],
    );
    mutator.append_children(host_id, &[span]);
    drop(mutator);
    doc.as_mut().resolve_style(0.0);

    assert_eq!(
        net.requests(),
        ["https://fonts.test/icons.woff2"],
        "dynamically added ::before content must trigger subset fetch on resolve_style"
    );
}
