// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use blitz_dom::node::NodeData;
use blitz_dom::{BaseDocument, DocumentConfig, NodeId};
use blitz_html::{HtmlDocument, HtmlProvider};
use serde_json::{json, Value};
use std::sync::Arc;

fn parse_full(html: &str) -> HtmlDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some("https://example.com/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            ..Default::default()
        },
    )
}

fn scan_value(html: &str) -> Value {
    let mut scanner = crate::dom::scan::DocScanner::new();
    scanner.push(html.as_bytes());
    serde_json::from_str(&scanner.finish()).expect("scan JSON parses")
}

fn scan_in_chunks(html: &str, chunk_bytes: usize) -> Value {
    serde_json::to_value(crate::dom::scan::scan_document_in_chunks(html, chunk_bytes))
        .expect("scan serializes")
}

#[test]
fn scan_is_the_same_whatever_the_input_chunking() {
    let html = "<!DOCTYPE html>\r\n<html><head><title>T\u{e9}st &amp;\r\n caf\u{e9} \u{1f600}</title>\
        <base href=\"/b/\"><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self'\">\
        <script type=\"importmap\">{\"imports\":{\"a\":\"./\u{e9}.js\"}}</script></head><body>\
        <!-- c --><script src=\"x.js\" nonce=\"n\"></script><script>let s = '</scr' + 'ipt>\u{e9}';\0\
        </script><svg><script>1</script></svg><textarea><script>no</script></textarea>\
        <iframe src=\"f.html\" srcdoc=\"&lt;p&gt;\"></iframe><p>&notin;&#x1F600;&#128512;</p></body></html>";
    let whole = scan_in_chunks(html, html.len());
    assert_eq!(
        whole,
        scan_value(html),
        "the exported scan reads the same document"
    );
    assert!(
        whole["scripts"].as_array().is_some_and(|s| s.len() >= 2),
        "{whole}"
    );
    for chunk_bytes in [1, 2, 3, 5, 7, 64] {
        assert_eq!(
            scan_in_chunks(html, chunk_bytes),
            whole,
            "chunks of {chunk_bytes} bytes"
        );
    }
}

// The XHTML sniff settles only at the root tag, after the leading comment; until then the scan
// holds the input back, since XHTML closes `<script/>` where HTML would read on as script text.
#[test]
fn xhtml_scan_is_the_same_whatever_the_input_chunking() {
    let html = "<!-- lead \u{e9} -->\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head>\
        <title>X</title><script src=\"a.js\"/><script src=\"b.js\"></script></head><body/></html>";
    let whole = scan_value(html);
    assert_eq!(
        whole["scripts"].as_array().map(Vec::len),
        Some(2),
        "{whole}"
    );
    for chunk_bytes in [1, 2, 3, 5, 7, 64, html.len()] {
        assert_eq!(
            scan_in_chunks(html, chunk_bytes),
            whole,
            "chunks of {chunk_bytes} bytes"
        );
    }
}

fn element_local(doc: &BaseDocument, id: NodeId) -> Option<&str> {
    match &doc.get_node(id)?.data {
        NodeData::Element(d) => Some(&*d.name.local),
        _ => None,
    }
}

fn element_is_html_ns(doc: &BaseDocument, id: NodeId) -> bool {
    match &doc.get_node(id).map(|n| &n.data) {
        Some(NodeData::Element(d)) => &**d.namespace() == "http://www.w3.org/1999/xhtml",
        _ => false,
    }
}

fn has_ancestor_in(doc: &BaseDocument, id: NodeId, names: &[&str]) -> bool {
    let mut cur = doc.get_node(id).and_then(|n| n.parent_id());
    while let Some(pid) = cur {
        if let Some(local) = element_local(doc, pid) {
            if names.contains(&local) {
                return true;
            }
        }
        cur = doc.get_node(pid).and_then(|n| n.parent_id());
    }
    false
}

fn attrs_of(doc: &BaseDocument, id: NodeId) -> Vec<(String, String)> {
    match &doc.get_node(id).map(|n| &n.data) {
        Some(NodeData::Element(d)) => d
            .attrs
            .iter()
            .map(|a| (str::to_ascii_lowercase(&a.name.local), a.value.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn ground_truth(html: &str) -> Value {
    let document = parse_full(html);
    let doc: &BaseDocument = &document;
    let sel = |s: &str| -> Vec<NodeId> {
        doc.query_selector_all(s)
            .map(|ids| ids.into_iter().collect())
            .unwrap_or_default()
    };
    let script_ids = sel("script");
    let iframe_ids = sel("iframe");
    let link_ids = sel("link");
    let title_ids = sel("title");
    let base_ids = sel("base");
    let meta_ids = sel("meta");

    let hidden = ["template", "noscript"];

    let mut scripts = Vec::new();
    let mut import_maps = Vec::new();
    let visible_scripts: Vec<NodeId> = script_ids
        .iter()
        .filter_map(|&id| (!has_ancestor_in(doc, id, &hidden)).then_some(id))
        .collect();
    for (i, &id) in visible_scripts.iter().enumerate() {
        let attrs = attrs_of(doc, id);
        let raw_type = attr(&attrs, "type")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if raw_type == "importmap" {
            let body = doc
                .get_node(id)
                .map(|n| n.text_content())
                .unwrap_or_default();
            if attr(&attrs, "src").is_none() && !body.trim().is_empty() {
                import_maps.push(json!({
                    "body": body,
                    "scriptDomIndex": i,
                    "baseHref": base_ids
                        .iter()
                        .copied()
                        .filter(|&base_id| base_id < id)
                        .find_map(|base_id| {
                            attr(&attrs_of(doc, base_id), "href").map(str::to_string)
                        }),
                    "nonce": attr(&attrs, "nonce").filter(|v| !v.is_empty()),
                }));
            }
            continue;
        }
        if !raw_type.is_empty()
            && raw_type != "text/javascript"
            && raw_type != "application/javascript"
            && raw_type != "module"
        {
            continue;
        }
        let src = attr(&attrs, "src").map(str::trim).unwrap_or("");
        let body = if src.is_empty() {
            doc.get_node(id)
                .map(|n| n.text_content())
                .unwrap_or_default()
        } else {
            String::new()
        };
        if src.is_empty() && body.trim().is_empty() {
            continue;
        }
        scripts.push(json!({
            "src": if src.is_empty() { Value::Null } else { src.into() },
            "kind": if raw_type == "module" { "module" } else { "classic" },
            "defer": attr(&attrs, "defer").is_some(),
            "async": attr(&attrs, "async").is_some(),
            "body": body,
            "crossOrigin": attr(&attrs, "crossorigin"),
            "integrity": attr(&attrs, "integrity")
                .map(str::trim)
                .filter(|v| !v.is_empty()),
            "nonce": attr(&attrs, "nonce").filter(|v| !v.is_empty()),
            "scriptDomIndex": i,
        }));
    }

    let mut iframes = Vec::new();
    for &id in iframe_ids.iter() {
        if has_ancestor_in(doc, id, &["template", "noscript", "svg", "math"]) {
            continue;
        }
        let attrs = attrs_of(doc, id);
        iframes.push(json!({
            "src": attr(&attrs, "src"),
            "srcdoc": attr(&attrs, "srcdoc"),
            "sandbox": attr(&attrs, "sandbox"),
            "name": attr(&attrs, "name"),
            "id": attr(&attrs, "id"),
            "loading": attr(&attrs, "loading"),
            "docOrderIndex": iframes.len(),
        }));
    }

    let mut module_preloads = Vec::new();
    for &id in link_ids.iter() {
        if !element_is_html_ns(doc, id) || has_ancestor_in(doc, id, &hidden) {
            continue;
        }
        let attrs = attrs_of(doc, id);
        let is_modulepreload = attr(&attrs, "rel")
            .unwrap_or("")
            .split_ascii_whitespace()
            .any(|rel| rel.eq_ignore_ascii_case("modulepreload"));
        let script_destination = attr(&attrs, "as")
            .map(|value| value.is_empty() || value.eq_ignore_ascii_case("script"))
            .unwrap_or(true);
        if let Some(href) = attr(&attrs, "href").filter(|href| !href.is_empty()) {
            if is_modulepreload && script_destination {
                module_preloads.push(json!({
                    "href": href,
                    "nonce": attr(&attrs, "nonce"),
                    "integrity": attr(&attrs, "integrity"),
                    "crossOrigin": attr(&attrs, "crossorigin"),
                }));
            }
        }
    }

    let title = title_ids
        .iter()
        .copied()
        .find(|&id| element_is_html_ns(doc, id) && !has_ancestor_in(doc, id, &hidden))
        .map(|id| {
            doc.get_node(id)
                .map(|n| n.text_content())
                .unwrap_or_default()
        })
        .unwrap_or_default();

    let base_href = base_ids
        .iter()
        .copied()
        .filter(|&id| !has_ancestor_in(doc, id, &hidden))
        .find_map(|id| attr(&attrs_of(doc, id), "href").map(|v| v.to_string()));

    let meta_csp: Vec<String> = meta_ids
        .iter()
        .copied()
        .filter(|&id| !has_ancestor_in(doc, id, &hidden))
        .filter_map(|id| {
            let attrs = attrs_of(doc, id);
            let equiv = attr(&attrs, "http-equiv")
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            (equiv == "content-security-policy")
                .then(|| {
                    attr(&attrs, "content")
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                })
                .flatten()
                .map(|v| v.to_string())
        })
        .collect();

    json!({
        "title": title,
        "baseHref": base_href,
        "metaCsp": meta_csp,
        "importMaps": import_maps,
        "scripts": scripts,
        "iframes": iframes,
        "modulePreloads": module_preloads,
    })
}

fn check(html: &str) {
    let scan = scan_value(html);
    let truth = ground_truth(html);
    assert_eq!(
        scan, truth,
        "scan vs full-parse mismatch for:\n{html}\nscan: {scan}\ntruth: {truth}"
    );
}

fn fixture_bodies() -> Vec<String> {
    let root = crate::test_assets::engine_dir().join("test/fixtures-worker/assets");
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("fixture assets readable ({}): {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("fixture asset entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "html") {
                out.push(std::fs::read_to_string(&path).expect("fixture asset readable"));
            }
        }
    }
    out
}

#[test]
fn differential_against_fixture_worker_documents() {
    let bodies = fixture_bodies();
    assert!(
        bodies.len() >= 60,
        "expected >= 60 fixture documents on disk, got {}",
        bodies.len()
    );
    for html in &bodies {
        check(html);
    }
}

#[test]
fn script_containing_markup_lookalikes() {
    check(r#"<script>var a = "</div>"; if (x<!--y) { z(); } //--></script><div>after</div>"#);
    check("<script><!-- document.write('<script>inner<\\/script>'); --></script><script>tail()</script>");
}

#[test]
fn script_type_filtering_and_index_consumption() {
    let html = concat!(
        "<script type=text/plain>data blob</script>",
        "<script type='application/ld+json'>{\"a\":1}</script>",
        "<script>real()</script>",
        "<script type=module src=/m.js></script>",
    );
    check(html);
    let v = scan_value(html);
    assert_eq!(v["scripts"][0]["scriptDomIndex"], 2);
    assert_eq!(v["scripts"][1]["scriptDomIndex"], 3);
    assert_eq!(v["scripts"][1]["kind"], "module");
}

#[test]
fn import_maps_are_captured_in_document_order() {
    let html = concat!(
        r#"<script type="importmap">{"imports":{"one":"/one.js"}}</script>"#,
        "<script type=module>import 'one'</script>",
        r#"<script type="importmap" nonce="r4nd0m">{"imports":{"two":"/two.js"}}</script>"#,
    );
    check(html);
    let v = scan_value(html);
    assert_eq!(v["importMaps"].as_array().unwrap().len(), 2);
    assert!(v["importMaps"][0]["body"].as_str().unwrap().contains("one"));
    assert_eq!(v["importMaps"][0]["nonce"], Value::Null);
    assert_eq!(v["importMaps"][1]["nonce"], "r4nd0m");
    assert_eq!(v["importMaps"][1]["scriptDomIndex"], 2);
    assert_eq!(v["scripts"][0]["scriptDomIndex"], 1);
}

#[test]
fn attributes_with_weird_quoting() {
    check(concat!(
        "<script src = ok.js defer async=async crossorigin=''></script>",
        "<script SRC=\"upper.js\" CrossOrigin=use-credentials></script>",
        "<iframe src='a.html' name=frame1></iframe>",
    ));
}

#[test]
fn uppercase_tags() {
    check(concat!(
        "<HTML><HEAD><TITLE>Shouty</TITLE><BASE HREF='/sub/'></HEAD>",
        "<BODY><SCRIPT>UP()</SCRIPT><IFRAME SRC=F.HTML></IFRAME></BODY></HTML>",
    ));
}

#[test]
fn title_with_entities_and_base_relative() {
    check("<title>a &amp; b &lt;c&gt;</title><base href=sub/dir/><script>x()</script>");
    check("<base target=_blank><base href=/late/><title>one</title><title>two</title>");
}

#[test]
fn unclosed_script_swallows_rest_of_document() {
    check("<div>before</div><script>tail = '<div>not a div</div>'");
    check("<title>never closed");
}

#[test]
fn iframe_sandbox_and_srcdoc_are_captured() {
    check(concat!(
        "<iframe src=a.html sandbox></iframe>",
        r#"<iframe srcdoc="<p>x</p>" sandbox="allow-scripts"></iframe>"#,
        "<iframe src=b.html sandbox=\"  ALLOW-FORMS  \"></iframe>",
    ));
    // An absent attribute and an empty one must stay distinguishable; the raw value is preserved.
    let v = scan_value("<iframe src=a.html></iframe><iframe src=b.html sandbox></iframe>");
    assert_eq!(v["iframes"][0]["sandbox"], Value::Null);
    assert_eq!(v["iframes"][1]["sandbox"], "");
}

#[test]
fn iframe_inside_select_and_tables() {
    // html5ever (since 0.39) follows the modern spec: no InSelect insertion
    // mode, so the iframe is a real element on both paths.
    check("<select><iframe src=inner.html name=n1></iframe></select>");
    check("<table><script>inTable()</script><tr><td><iframe src=cell.html></iframe></table>");
}

#[test]
fn svg_foreign_content_scripts() {
    check(concat!(
        "<svg><script>svgScript(1 < 2)</script></svg>",
        "<script>htmlAfterSvg()</script>",
    ));
    check("<svg><script><![CDATA[if (a < b && c > d) run();]]></script></svg>");
    check("<svg><svg><script>nested()</script></svg></svg><script>after()</script>");
}

#[test]
fn nested_template_scripts_are_skipped() {
    let html = concat!(
        "<template><script>t1()</script>",
        "<template><script>t2()</script></template></template>",
        "<script>live()</script>",
        "<template><iframe src=t.html></iframe></template>",
    );
    check(html);
    let document = parse_full(html);
    assert_eq!(document.query_selector_all("script").unwrap().len(), 3);
    let v = scan_value(html);
    assert_eq!(v["scripts"].as_array().unwrap().len(), 1);
    assert_eq!(v["scripts"][0]["body"], "live()");
    assert_eq!(v["scripts"][0]["scriptDomIndex"], 0);
    assert_eq!(v["iframes"].as_array().unwrap().len(), 0);
}

#[test]
fn noscript_content_is_inert() {
    let html = concat!(
        "<body><noscript><script>never()</script>",
        "<iframe src=fallback.html></iframe></noscript>",
        "<script>runs()</script></body>",
    );
    check(html);
    let document = parse_full(html);
    assert_eq!(document.query_selector_all("script").unwrap().len(), 2);
    assert_eq!(document.query_selector_all("iframe").unwrap().len(), 1);
    let v = scan_value(html);
    assert_eq!(v["scripts"].as_array().unwrap().len(), 1);
    assert_eq!(v["scripts"][0]["body"], "runs()");
    assert_eq!(v["scripts"][0]["scriptDomIndex"], 0);
    assert_eq!(v["iframes"].as_array().unwrap().len(), 0);
}

#[test]
fn noscript_in_head_ejects_children_in_blitz_only() {
    let html = "<head><noscript><script>never()</script></noscript></head>";
    let v = scan_value(html);
    assert_eq!(v["scripts"].as_array().unwrap().len(), 0);
    let document = parse_full(html);
    let ids = document.query_selector_all("script").unwrap();
    assert_eq!(ids.len(), 1);
    let doc: &BaseDocument = &document;
    assert!(!has_ancestor_in(doc, ids[0], &["noscript"]));
}

#[test]
fn blank_and_srcd_script_bodies() {
    let html = concat!(
        "<script>   \n\t  </script>",
        "<script src=/a.js>ignored inline text</script>",
    );
    check(html);
    let v = scan_value(html);
    assert_eq!(v["scripts"].as_array().unwrap().len(), 1);
    assert_eq!(v["scripts"][0]["scriptDomIndex"], 1);
    assert_eq!(v["scripts"][0]["body"], "");
}

#[test]
fn xhtml_cdata_script_body_matches_the_xml_parse() {
    let html = concat!(
        "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.1//EN\" ",
        "\"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd\">\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script type=\"text/javascript\"><![CDATA[\n",
        "  var x = 1 < 2;\n",
        "]]></script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert!(!body.contains("CDATA"), "markers survived: {body:?}");
    assert!(body.contains("var x = 1 < 2;"), "code lost: {body:?}");
}

#[test]
fn xml_prolog_document_also_strips_cdata() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script><![CDATA[ var a = 1 < 2; ]]></script>",
        "</body></html>",
    );
    check(html);
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert!(!body.contains("CDATA"), "markers survived: {body:?}");
    assert!(body.contains("var a = 1 < 2;"), "code lost: {body:?}");
}

#[test]
fn xhtml_multi_and_empty_cdata_sections() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body>",
        "<script><![CDATA[var a = 1;]]> <![CDATA[var b = 2;]]></script>",
        "<script><![CDATA[]]></script>",
        "</body></html>",
    );
    check(html);
    let v = scan_value(html);
    let scripts = v["scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 1, "empty-section script must drop out");
    let body = scripts[0]["body"].as_str().unwrap();
    assert!(body.contains("var a = 1;"), "first section lost: {body:?}");
    assert!(body.contains("var b = 2;"), "second section lost: {body:?}");
}

#[test]
fn html_document_keeps_cdata_markers_verbatim() {
    let html = concat!(
        "<!DOCTYPE html><html><head><title>t</title></head><body>",
        "<script><![CDATA[ var y = 1; ]]></script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert!(body.contains("<![CDATA["), "markers stripped: {body:?}");
}

#[test]
fn html_doctype_with_xhtml_later_on_its_line_parses_as_html() {
    let html = concat!(
        "<!DOCTYPE html><html><head><link rel=\"preconnect\" href=\"https://a/\">",
        "<link rel=\"preconnect\" href=\"https://b/\"><title>T</title>",
        "<script>var x = ct === \"application/xhtml+xml\";</script>",
        "</head><body><p>x</p></body></html>",
    );
    check(html);
    let document = parse_full(html);
    let doc: &BaseDocument = &document;
    let title = doc.query_selector_all("title").unwrap()[0];
    let parent = doc.get_node(title).and_then(|n| n.parent_id()).unwrap();
    assert_eq!(
        element_local(doc, parent),
        Some("head"),
        "title nested under a void element"
    );
    assert!(element_is_html_ns(doc, title), "parsed as XML, not HTML");
}

#[test]
fn internal_subset_doctype_with_xhtml_root_stays_xml() {
    let html = concat!(
        "<!DOCTYPE html [<!--x-->]><html xmlns=\"http://www.w3.org/1999/xhtml\">\n",
        "<head><title>t</title><script src=\"/a.js\" /><script>b();</script></head></html>",
    );
    check(html);
    let scripts = scan_value(html)["scripts"].as_array().unwrap().len();
    assert_eq!(
        scripts, 2,
        "self-closing script swallowed its sibling: parsed as HTML"
    );
}

#[test]
fn xhtml_doctype_after_prolog_misc_stays_xml() {
    let doctype = concat!(
        "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" ",
        "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n",
    );
    let body = "<html><head><script src=\"/a.js\" /><script>b();</script></head></html>";

    for prolog_misc in [
        "<!-- comment before doctype -->\n",
        "<?xml-stylesheet href=\"theme.css\"?>\n",
    ] {
        let html = format!("{prolog_misc}{doctype}{body}");
        check(&html);
        let scripts = scan_value(&html)["scripts"].as_array().unwrap().len();
        assert_eq!(
            scripts, 2,
            "XHTML doctype after prolog misc was ignored: {html}"
        );
    }
}

#[test]
fn start_tag_text_inside_prolog_markup_keeps_the_xhtml_root() {
    for prolog in [
        "<!DOCTYPE html><!-- <svg> --><html ",
        "<!DOCTYPE html [<!ENTITY e \"<b>\">]><html ",
        "<!DOCTYPE html><html data-x=\"<b>\" ",
    ] {
        let html = format!(
            "{prolog}xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>\
             <script src=\"/a.js\" /><script>b();</script></head></html>"
        );
        check(&html);
        let scripts = scan_value(&html)["scripts"].as_array().unwrap().len();
        assert_eq!(scripts, 2, "parsed as HTML: {html}");
    }
}

#[test]
fn html_doctype_sniff_ignores_xhtml_outside_the_doctype_and_root_namespace() {
    for html in [
        "<!DOCTYPE html><!-- XHTML --><html><head><script src=\"/a.js\" /><script>b();</script></head></html>",
        "<!DOCTYPE html><htmlish xmlns=\"http://www.w3.org/1999/xhtml\"><head><script src=\"/a.js\" /><script>b();</script></head></htmlish>",
        "<!DOCTYPE html><html data-note=\"xhtml\"><head><script src=\"/a.js\" /><script>b();</script></head></html>",
        "<!DOCTYPE html><html>text says xhtml<head><script src=\"/a.js\" /><script>b();</script></head></html>",
        "<htmlish xmlns=\"http://www.w3.org/1999/xhtml\"><head><script src=\"/a.js\" /><script>b();</script></head></htmlish>",
        "<!DOCTYPE html><html\u{000c}xmlns=\"http://www.w3.org/1999/xhtml\"><head><script src=\"/a.js\" /><script>b();</script></head></html>",
        "<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><script src=\"/a.js\" /><script>b();</script></head></html>",
    ] {
        check(html);
        let scripts = scan_value(html)["scripts"].as_array().unwrap().len();
        assert_eq!(scripts, 1, "misrouted as XML: {html}");
    }
}

#[test]
fn xml_stylesheet_processing_instruction_is_not_an_xml_declaration() {
    let html = concat!(
        "<?xml-stylesheet href=\"theme.css\"?><html><head>",
        "<script src=\"/a.js\" /><script>b();</script></head></html>",
    );
    check(html);
    assert_eq!(scan_value(html)["scripts"].as_array().unwrap().len(), 1);
}

#[test]
fn xhtml_self_closing_script_does_not_swallow_siblings() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "<script src=\"/resources/testharness.js\" type=\"text/javascript\" />",
        "<script src=\"/resources/testharnessreport.js\" type=\"text/javascript\" />",
        "<style type=\"text/css\"><![CDATA[ div { color: red } ]]></style>",
        "</head><body><script>run();</script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let scripts = v["scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 3, "sibling scripts lost: {scripts:?}");
    assert_eq!(scripts[1]["src"], "/resources/testharnessreport.js");
    assert_eq!(scripts[2]["body"], "run();");
}

#[test]
fn xhtml_self_closing_iframe_does_not_swallow_siblings() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body>",
        "<iframe id=\"subset1\" src=\"iframe1.xml\" />",
        "<iframe id=\"subset2\" src=\"iframe2.xml\" />",
        "</body></html>",
    );
    check(html);
    let v = scan_value(html);
    let iframes = v["iframes"].as_array().unwrap();
    assert_eq!(iframes.len(), 2, "second iframe swallowed: {iframes:?}");
    assert_eq!(iframes[1]["src"], "iframe2.xml");
}

#[test]
fn iframe_loading_attribute_is_scanned() {
    let html = concat!(
        "<html><body>",
        "<iframe src=\"a.html\"></iframe>",
        "<iframe src=\"b.html\" loading=\"lazy\"></iframe>",
        "<iframe src=\"c.html\" LOADING=\"LAZY\"></iframe>",
        "<iframe src=\"d.html\" loading=\"eager\"></iframe>",
        "</body></html>",
    );
    check(html);
    let v = scan_value(html);
    let iframes = v["iframes"].as_array().unwrap();
    assert_eq!(iframes.len(), 4);
    assert!(iframes[0]["loading"].is_null());
    assert_eq!(iframes[1]["loading"], "lazy");
    assert_eq!(iframes[2]["loading"], "LAZY");
    assert_eq!(iframes[3]["loading"], "eager");
}

#[test]
fn iframe_name_and_id_are_scanned() {
    let html = concat!(
        "<html><body>",
        "<iframe src=\"a.html\" name=\"named\" id=\"first\"></iframe>",
        "<iframe src=\"b.html\" id=\"second\"></iframe>",
        "<iframe src=\"c.html\"></iframe>",
        "</body></html>",
    );
    check(html);
    let v = scan_value(html);
    let iframes = v["iframes"].as_array().unwrap();
    assert_eq!(iframes.len(), 3);
    assert_eq!(iframes[0]["name"], "named");
    assert_eq!(iframes[0]["id"], "first");
    assert!(iframes[1]["name"].is_null());
    assert_eq!(iframes[1]["id"], "second");
    assert!(iframes[2]["id"].is_null());
}

#[test]
fn xhtml_script_body_expands_char_refs() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script>if (a &lt; b &amp;&amp; c &gt; d) run(&apos;x&#41;&apos;);",
        "</script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert_eq!(body, "if (a < b && c > d) run('x)');");
}

#[test]
fn xhtml_cdata_content_keeps_refs_literal() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script>var a = &quot;x&quot;;<![CDATA[var b = \"&quot;\";]]>",
        "</script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert_eq!(body, "var a = \"x\";var b = \"&quot;\";");
}

#[test]
fn xhtml_ref_window_edge_lands_mid_character() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script>var s = \"&京都府京都市京都区;\" + (a &amp;&amp; b);",
        "</script></body></html>",
    );
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert!(
        body.contains("\"&京都府京都市京都区;\""),
        "text mangled: {body:?}"
    );
    assert!(body.contains("(a && b)"), "refs lost: {body:?}");
}

#[test]
fn xhtml_unknown_and_bare_ampersands_survive() {
    let html = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title>",
        "</head><body><script><![CDATA[if (a && b) f(&nope; &verylongentityname;);]]>",
        "</script></body></html>",
    );
    let v = scan_value(html);
    let body = v["scripts"][0]["body"].as_str().unwrap();
    assert_eq!(body, "if (a && b) f(&nope; &verylongentityname;);");
}

#[test]
fn html_document_still_ignores_self_closing_raw_text() {
    let html = concat!(
        "<!DOCTYPE html><html><head><title>t</title>",
        "<script src=\"a.js\" />",
        "<script src=\"b.js\"></script>",
        "</head><body>&lt;kept&gt;<script>x(&lt;1);</script></body></html>",
    );
    check(html);
    let v = scan_value(html);
    let scripts = v["scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 2, "unexpected script split: {scripts:?}");
    assert_eq!(scripts[1]["body"], "x(&lt;1);", "refs must stay verbatim");
}

#[test]
fn rcdata_and_rawtext_containers_do_not_leak() {
    check(concat!(
        "<textarea><script>notAScript()</script></textarea>",
        "<style>/* <script>alsoNot()</script> */</style>",
        "<xmp><iframe src=nope.html></iframe></xmp>",
        "<noembed><script>nope()</script></noembed>",
        "<script>yes()</script>",
    ));
}

#[test]
fn crossorigin_variants() {
    let v = scan_value(concat!(
        "<script src=a.js crossorigin></script>",
        "<script src=b.js crossorigin=anonymous></script>",
        "<script src=c.js></script>",
    ));
    assert_eq!(v["scripts"][0]["crossOrigin"], "");
    assert_eq!(v["scripts"][1]["crossOrigin"], "anonymous");
    assert_eq!(v["scripts"][2]["crossOrigin"], Value::Null);
}

#[test]
fn integrity_and_nonce_are_carried() {
    let v = scan_value(concat!(
        "<script src=a.js integrity=\"sha384-AAA\" crossorigin=anonymous></script>",
        "<script src=b.js integrity=\"  \"></script>",
        "<script nonce=\"r4nd0m\">inline()</script>",
        "<script src=c.js></script>",
    ));
    assert_eq!(v["scripts"][0]["integrity"], "sha384-AAA");
    assert_eq!(v["scripts"][0]["nonce"], Value::Null);
    assert_eq!(v["scripts"][1]["integrity"], Value::Null);
    assert_eq!(v["scripts"][2]["nonce"], "r4nd0m");
    assert_eq!(v["scripts"][3]["integrity"], Value::Null);
}

#[test]
fn modulepreload_links_follow_html_tokenization() {
    let cases: &[(&str, Value)] = &[
        (
            r#"<link data-note=">" rel="modulepreload" href="/a.js?x=1&amp;y=2" integrity="sha384-test" crossorigin="use-credentials">"#,
            json!([{"href": "/a.js?x=1&y=2", "nonce": null, "integrity": "sha384-test", "crossOrigin": "use-credentials"}]),
        ),
        (
            r#"<link rel="ModulePreload" as="script" href="/case.js" nonce="n1">"#,
            json!([{"href": "/case.js", "nonce": "n1", "integrity": null, "crossOrigin": null}]),
        ),
        (
            concat!(
                r#"<script>var s = '<link rel="modulepreload" href="/script.js">';</script>"#,
                r#"<!-- <link rel="modulepreload" href="/comment.js"> -->"#,
                r#"<template><link rel="modulepreload" href="/template.js"></template>"#,
                r#"<svg><link rel="modulepreload" href="/svg.js"></svg>"#,
                r#"<link rel="preload" as="script" href="/classic.js">"#,
                r#"<link rel="modulepreload" as="style" href="/style.css">"#,
            ),
            json!([]),
        ),
    ];
    for (html, expected) in cases {
        check(html);
        assert_eq!(
            scan_value(html)["modulePreloads"],
            *expected,
            "modulePreloads for:\n{html}"
        );
    }
}

#[test]
fn meta_csp_is_captured_in_document_order() {
    let v = scan_value(concat!(
        "<meta charset=utf-8>",
        "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self'\">",
        "<meta http-equiv=\"Content-Security-Policy-Report-Only\" content=\"script-src 'none'\">",
        "<meta http-equiv=\"content-security-policy\" content=\"default-src https:\">",
        "<template><meta http-equiv=\"content-security-policy\" content=\"script-src 'none'\"></template>",
    ));
    let csp = v["metaCsp"].as_array().unwrap();
    assert_eq!(csp.len(), 2);
    assert_eq!(csp[0], "script-src 'self'");
    assert_eq!(csp[1], "default-src https:");
}
