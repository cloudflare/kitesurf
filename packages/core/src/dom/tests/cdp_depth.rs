// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::dom::cdp::{
    check_subtree_budget, describe_node, subtree_size, Subtree, SUBTREE_BUDGET_BYTES,
};
use crate::DomHandle;
use serde_json::Value;

const HTML: &str = "<!DOCTYPE html><html><head></head><body>\
    <div id=\"host\"><span>light</span></div><p>text</p><ul><li>a</li><li>b</li></ul></body></html>";

fn describe(dom: &DomHandle, node: u32, subtree: Option<Subtree>) -> Value {
    let id = dom.resolve_node_id(node).expect("live node");
    let doc = dom.doc.borrow();
    let mut handles = dom.node_handles.borrow_mut();
    let node = describe_node(&doc, id, "https://test.example/", subtree, &mut handles);
    serde_json::to_value(node.expect("described")).expect("serializes")
}

fn names(node: &Value) -> Vec<&str> {
    node["children"]
        .as_array()
        .map(|c| c.iter().map(|n| n["nodeName"].as_str().unwrap()).collect())
        .unwrap_or_default()
}

fn find<'a>(node: &'a Value, name: &str) -> &'a Value {
    node["children"]
        .as_array()
        .and_then(|c| c.iter().find(|n| n["nodeName"] == name))
        .unwrap_or_else(|| panic!("{name} under {}", node["nodeName"]))
}

fn node_id(dom: &DomHandle, selector: &str) -> u32 {
    let id = dom
        .query_selector(selector)
        .expect("selector query succeeds");
    u32::try_from(id).expect("node exists")
}

#[test]
fn depth_one_lists_children_without_their_children() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let doc = describe(
        &dom,
        0,
        Some(Subtree {
            depth: 1,
            pierce: false,
        }),
    );
    assert_eq!(names(&doc), ["HTML"]);
    let html = find(&doc, "HTML");
    assert_eq!(html["childNodeCount"], 2);
    assert!(html.get("children").is_none());
}

#[test]
fn a_lone_text_child_is_included_at_the_depth_limit() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let body = node_id(&dom, "body");
    let body = describe(
        &dom,
        body,
        Some(Subtree {
            depth: 1,
            pierce: false,
        }),
    );
    assert_eq!(names(&body), ["DIV", "P", "UL"]);
    assert_eq!(names(find(&body, "P")), ["#text"]);
    assert_eq!(find(find(&body, "P"), "#text")["nodeValue"], "text");
    // Two element children: only the count.
    assert!(find(&body, "UL").get("children").is_none());
    assert_eq!(find(&body, "UL")["childNodeCount"], 2);
}

#[test]
fn an_element_without_a_shadow_root_lists_no_children_at_the_depth_limit() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = node_id(&dom, "#host");
    let limit = describe(
        &dom,
        host,
        Some(Subtree {
            depth: 0,
            pierce: false,
        }),
    );
    assert!(limit.get("children").is_none());
    assert_eq!(limit["childNodeCount"], 1);
}

#[test]
fn negative_depth_describes_the_whole_tree() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let doc = describe(
        &dom,
        0,
        Some(Subtree {
            depth: -1,
            pierce: true,
        }),
    );
    let body = find(find(&doc, "HTML"), "BODY");
    let ul = find(body, "UL");
    assert_eq!(names(ul), ["LI", "LI"]);
    assert_eq!(names(find(ul, "LI")), ["#text"]);
}

#[test]
fn shadow_roots_follow_pierce() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = node_id(&dom, "#host");
    let root = u32::try_from(dom.attach_shadow(host, "open")).expect("shadow root");
    let slot = dom.create_element("i");
    assert!(dom.append_child_node(root, slot));
    let other = dom.create_element("b");
    assert!(dom.append_child_node(root, other));

    let shallow = describe(
        &dom,
        host,
        Some(Subtree {
            depth: 2,
            pierce: false,
        }),
    );
    let roots = shallow["shadowRoots"]
        .as_array()
        .expect("shadow root listed");
    assert_eq!(roots[0]["childNodeCount"], 2);
    assert!(roots[0].get("children").is_none());
    assert_eq!(names(&shallow), ["SPAN"]);

    let pierced = describe(
        &dom,
        host,
        Some(Subtree {
            depth: 2,
            pierce: true,
        }),
    );
    assert_eq!(names(&pierced["shadowRoots"][0]), ["I", "B"]);

    // A shadow host's children are listed even at the depth limit.
    let limit = describe(
        &dom,
        host,
        Some(Subtree {
            depth: 0,
            pierce: false,
        }),
    );
    assert_eq!(names(&limit), ["SPAN"]);
    assert!(
        find(&limit, "SPAN").get("children").is_some(),
        "lone text child"
    );

    let info = describe(&dom, host, None);
    assert!(info.get("children").is_none() && info.get("shadowRoots").is_none());
}

#[test]
fn subtree_estimate_matches_described_traversal() {
    fn count(node: &Value) -> usize {
        1 + ["children", "shadowRoots"]
            .into_iter()
            .map(|key| {
                node[key]
                    .as_array()
                    .map_or(0, |children| children.iter().map(count).sum())
            })
            .sum::<usize>()
    }
    fn serialized_upper(value: &Value) -> usize {
        fn varint(mut n: u64) -> usize {
            let mut len = 1;
            while n >= 128 {
                n >>= 7;
                len += 1;
            }
            len
        }
        fn string(value: &str) -> usize {
            let wide = value.chars().any(|ch| ch > '\u{ff}');
            let bytes = value.encode_utf16().count() * if wide { 2 } else { 1 };
            1 + varint(bytes as u64) + bytes + usize::from(wide)
        }
        match value {
            Value::String(s) => string(s),
            Value::Number(n) => 1 + varint(n.as_u64().unwrap() * 2),
            Value::Array(a) => {
                3 + 2 * varint(a.len() as u64) + a.iter().map(serialized_upper).sum::<usize>()
            }
            Value::Object(o) => {
                3 + o
                    .iter()
                    .filter(|(k, _)| k.as_str() != "attributeNamespaces")
                    .map(|(k, v)| string(k) + serialized_upper(v))
                    .sum::<usize>()
            }
            _ => panic!("unexpected CDP value"),
        }
    }
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = node_id(&dom, "#host");
    let shadow = u32::try_from(dom.attach_shadow(host, "open")).expect("shadow root");
    let nested = dom.create_element("section");
    assert!(dom.append_child_node(shadow, nested));
    let nested_shadow = u32::try_from(dom.attach_shadow(nested, "closed")).expect("nested shadow");
    let leaf = dom.create_element("i");
    assert!(dom.set_attribute(leaf, "title", "café 漢🪁"));
    assert!(dom.append_child_node(nested_shadow, leaf));
    let text = dom.create_text_node("shadow text 🪁");
    assert!(dom.append_child_node(leaf, text));
    let svg = dom.create_element_ns("http://www.w3.org/2000/svg", "svg");
    assert!(dom.set_attribute(svg, "viewBox", "0 0 10 10"));
    assert!(dom.append_child_node(nested_shadow, svg));
    for node in [0, host, nested] {
        for depth in [-1, 0, 1, 2, 3] {
            for pierce in [false, true] {
                let subtree = Subtree { depth, pierce };
                let described = describe(&dom, node, Some(subtree));
                let id = dom.resolve_node_id(node).unwrap();
                let doc = dom.doc.borrow();
                let handles = dom.node_handles.borrow();
                let estimate = subtree_size(&doc, id, "https://test.example/", subtree, &handles);
                drop(handles);
                drop(doc);
                assert_eq!(
                    estimate.nodes,
                    count(&described),
                    "node={node}, depth={depth}, pierce={pierce}"
                );
                assert!(estimate.at_least_bytes >= 2 + serialized_upper(&described));
            }
        }
    }
}

#[test]
fn subtree_estimate_accounts_for_large_values() {
    let dom = DomHandle::new("<div></div>", "https://test.example/");
    let node = node_id(&dom, "div");
    assert!(dom.set_attribute(node, "title", &"\n".repeat(34_000_000)));
    let id = dom.resolve_node_id(node).unwrap();
    let doc = dom.doc.borrow();
    let handles = dom.node_handles.borrow();
    let estimate = subtree_size(
        &doc,
        id,
        "https://test.example/",
        Subtree {
            depth: 0,
            pierce: false,
        },
        &handles,
    );
    assert_eq!(estimate.nodes, 1);
    assert!(estimate.at_least_bytes > SUBTREE_BUDGET_BYTES);
    let error = check_subtree_budget(
        &doc,
        id,
        "https://test.example/",
        Subtree {
            depth: 0,
            pierce: false,
        },
        &handles,
    )
    .expect("oversized node rejected");
    assert!(error.at_least_bytes > error.budget);
}

#[test]
fn single_node_budget_ignores_large_text_child() {
    use crate::dom::cdp::check_node_budget;

    let dom = DomHandle::new("<div></div>", "https://test.example/");
    let node = node_id(&dom, "div");
    let text = dom.create_text_node(&"漢".repeat(17_000_000));
    assert!(dom.append_child_node(node, text));
    let id = dom.resolve_node_id(node).unwrap();
    let doc = dom.doc.borrow();
    let handles = dom.node_handles.borrow();
    assert!(check_node_budget(&doc, id, "https://test.example/", &handles).is_none());
}

#[test]
fn subtree_counts_wide_nested_siblings() {
    let markup = format!("<main>{}</main>", "<i><b>x</b></i>".repeat(10_000));
    let dom = DomHandle::new(&markup, "https://test.example/");
    let id = dom.resolve_node_id(0).unwrap();
    let doc = dom.doc.borrow();
    let handles = dom.node_handles.borrow();
    let estimate = subtree_size(
        &doc,
        id,
        "https://test.example/",
        Subtree {
            depth: -1,
            pierce: true,
        },
        &handles,
    );
    drop(handles);
    drop(doc);
    assert_eq!(estimate.nodes, 30_005);
    let described = describe(
        &dom,
        0,
        Some(Subtree {
            depth: -1,
            pierce: true,
        }),
    );
    let main = find(find(find(&described, "HTML"), "BODY"), "MAIN");
    assert_eq!(main["children"].as_array().unwrap().len(), 10_000);
}
