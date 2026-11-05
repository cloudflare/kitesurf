// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Repeated selector queries reuse parsed selectors yet still see DOM changes and errors.

use crate::DomHandle;

fn page(body: &str) -> DomHandle {
    DomHandle::new(
        &format!("<!DOCTYPE html><body>{body}"),
        "https://example.com/",
    )
}

fn ids(dom: &DomHandle, selector: &str) -> Vec<String> {
    let doc = dom.doc.borrow();
    doc.query_selector_all(selector)
        .expect("query ok")
        .into_iter()
        .map(|node| {
            doc.get_node(node)
                .and_then(|n| n.attr(blitz_dom::local_name!("id")))
                .unwrap_or("")
                .into()
        })
        .collect()
}

#[test]
fn repeated_query_sees_later_mutations() {
    let dom = page(r#"<ul id="u"><li id="a" class="x"></li><li id="b"></li></ul>"#);
    assert_eq!(ids(&dom, "li.x"), ["a"]);
    let b = dom.query_selector("#b").expect("query ok") as u32;
    assert!(dom.set_attribute(b, "class", "x"));
    assert_eq!(ids(&dom, "li.x"), ["a", "b"]);
}

#[test]
fn invalid_selector_fails_every_time() {
    let dom = page("<p></p>");
    let doc = dom.doc.borrow();
    assert!(doc.try_parse_selector_list("p[").is_err());
    assert!(doc.try_parse_selector_list("p[").is_err());
    assert!(doc.try_parse_selector_list("p").is_ok());
}

#[test]
fn base_url_change_keeps_queries_working() {
    let dom = page(r#"<p id="p"></p>"#);
    assert_eq!(ids(&dom, "p"), ["p"]);
    dom.doc.borrow_mut().set_base_url("https://other.example/");
    assert_eq!(ids(&dom, "p"), ["p"]);
}

#[test]
fn child_indexes_stay_exact_after_reordering() {
    let items = |prefix: &str| -> String {
        (0..70)
            .map(|i| format!("<i id=\"{prefix}{i}\"></i>"))
            .collect()
    };
    let (a_items, b_items) = (items("i"), items("j"));
    let dom = page(&format!(
        r#"<div id="a">{a_items}</div><div id="b">{b_items}</div>"#
    ));
    let indexes = |dom: &DomHandle, parent: &str| -> Vec<Option<usize>> {
        let doc = dom.doc.borrow();
        let parent = doc
            .query_selector(parent)
            .expect("query ok")
            .expect("parent");
        let children = doc.get_node(parent).expect("parent").children();
        children
            .iter()
            .map(|id| doc.get_node(id).expect("child").child_index())
            .collect()
    };
    let expected: Vec<Option<usize>> = (0..70).map(Some).collect();
    assert_eq!(indexes(&dom, "#a"), expected);
    assert_eq!(indexes(&dom, "#b"), expected);
    let a = dom.query_selector("#a").expect("query ok") as u32;
    for _ in 0..3 {
        let last = dom.query_selector("#a > i:last-child").expect("query ok") as u32;
        let first = dom.query_selector("#a > i").expect("query ok") as u32;
        assert!(dom.insert_before_node(a, last, first));
        assert_eq!(indexes(&dom, "#a"), expected);
    }
    assert_eq!(ids(&dom, "#a > i:first-child"), ["i67"]);
    assert_eq!(ids(&dom, "#i67 + i"), ["i68"]);
    assert_eq!(ids(&dom, "#i66 + i"), Vec::<String>::new());
}

#[test]
fn sibling_combinators_skip_text_and_comments() {
    let dom = page(
        r#"<div><i id="a"></i> text <!-- c --> more <b id="b"></b> <!-- d --> <s id="c"></s></div>"#,
    );
    assert_eq!(ids(&dom, "#a + b"), ["b"]);
    assert_eq!(ids(&dom, "#b + s"), ["c"]);
    assert_eq!(ids(&dom, "#a ~ *"), ["b", "c"]);
    assert_eq!(ids(&dom, "b:nth-child(2)"), ["b"]);
    assert_eq!(ids(&dom, "i:nth-last-child(3)"), ["a"]);
    assert_eq!(ids(&dom, "b:nth-last-of-type(1)"), ["b"]);
    assert_eq!(ids(&dom, "i + s"), Vec::<String>::new());
    assert_eq!(ids(&dom, "s:last-child, i:first-child"), ["a", "c"]);
}
