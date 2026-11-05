// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;
use crate::dom::accessibility::{AxStart, AxStartError, build_json, start_accessibility_with_budget};
use crate::dom::tree::OuterHtmlBytes;
use crate::dom::accessibility::{
    abs_url, collapse, js_number, js_parse_int, js_trim, split_js_ws, write_number, write_string,
};

fn node_id(dom: &DomHandle, selector: &str) -> u32 {
    let id = dom
        .query_selector(selector)
        .expect("selector query succeeds");
    u32::try_from(id).expect("node exists")
}

fn drain_bytes(mut bytes: OuterHtmlBytes, max: usize) -> Vec<u8> {
    let mut output = Vec::new();
    loop {
        let chunk = bytes.next_chunk(max);
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= max.max(1));
        output.extend_from_slice(&chunk);
    }
    output
}

fn drain_start(mut start: AxStart, dom: &DomHandle, max: usize) -> Vec<u8> {
    assert_eq!(start.budget_error(), None);
    if let Some(mut stream) = start.take_stream() {
        let mut output = Vec::new();
        loop {
            let chunk = stream.next_chunk(dom, max);
            if chunk.is_empty() {
                break;
            }
            assert!(chunk.len() <= max.max(1));
            output.extend_from_slice(&chunk);
        }
        assert_eq!(output.len(), stream.byte_length());
        assert!(stream.next_chunk(dom, max).is_empty());
        output
    } else {
        let bytes = start.take_bytes().expect("buffered AX reply");
        let expected_len = bytes.byte_length();
        let output = drain_bytes(bytes, max);
        assert_eq!(output.len(), expected_len);
        output
    }
}

fn ax_request(method: &str) -> String {
    serde_json::json!({"method": method, "frameId": "F", "title": "title"}).to_string()
}

#[test]
fn accessibility_visibility_scan_prunes_display_none_but_visits_hidden_descendants() {
    let dom = DomHandle::new(
        "<div id='gone' style='display:none'><span id='pruned'></span></div>\
         <div id='hidden' style='visibility:hidden'><span id='inherited'></span>\
         <span id='visible' style='visibility:visible'></span></div>",
        "https://example.test/",
    );
    let gone = node_id(&dom, "#gone");
    let pruned = node_id(&dom, "#pruned");
    let hidden = node_id(&dom, "#hidden");
    let inherited = node_id(&dom, "#inherited");
    let visible = node_id(&dom, "#visible");

    let result = dom.not_rendered_ids();
    assert!(result.display_none.contains(&gone));
    assert!(!result.display_none.contains(&pruned));
    assert!(!result.invisible.contains(&pruned));
    assert!(result.invisible.contains(&hidden));
    assert!(result.invisible.contains(&inherited));
    assert!(!result.invisible.contains(&visible));
}

#[test]
fn accessibility_visibility_scan_preserves_reverse_sibling_order() {
    let dom = DomHandle::new(
        "<div id='first' style='display:none'></div>\
         <div id='last' style='display:none'></div>",
        "https://example.test/",
    );
    let first = node_id(&dom, "#first");
    let last = node_id(&dom, "#last");

    let display_none = dom.not_rendered_ids().display_none;
    let siblings = display_none
        .into_iter()
        .filter(|id| *id == first || *id == last)
        .collect::<Vec<_>>();
    assert_eq!(siblings, [last, first]);
}

#[test]
fn accessibility_visibility_scan_is_empty_when_layout_is_off() {
    let dom = DomHandle::new(
        "<div style='display:none'></div><div style='visibility:hidden'></div>",
        "https://example.test/",
    );
    dom.set_layout_mode("off");
    let result = dom.not_rendered_ids();
    assert!(result.display_none.is_empty());
    assert!(result.invisible.is_empty());
}

#[test]
fn accessibility_javascript_whitespace_and_numbers() {
    assert_eq!(js_trim("\u{feff}\u{a0} x \u{feff}"), "x");
    assert_eq!(collapse("\u{feff}a\t\u{a0}b\u{feff}"), "a b");
    assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
    assert_eq!(
        split_js_ws(" \u{feff}a\tb ").collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(split_js_ws(" ").collect::<Vec<_>>(), [""]);
    for (text, value) in [
        ("", 0.0),
        (" 0x10 ", 16.0),
        ("0b11", 3.0),
        ("0o10", 8.0),
        ("1e1", 10.0),
        ("-0", -0.0),
        ("+5", 5.0),
        (".5", 0.5),
        ("5.", 5.0),
        ("\u{a0}1\u{a0}", 1.0),
        ("Infinity", f64::INFINITY),
        ("-Infinity", f64::NEG_INFINITY),
    ] {
        assert_eq!(js_number(text), value, "{text:?}");
    }
    for text in ["abc", "1e", "-0x10", "0b", "inf", "nan", "\u{85}1"] {
        assert!(js_number(text).is_nan(), "{text:?}");
    }
    assert_eq!(js_parse_int("\u{feff}+12.7"), 12.0);
    assert!(js_parse_int("no digits").is_nan());
    assert_eq!(
        abs_url("../a", "https://example.test/x/y"),
        "https://example.test/a"
    );
}

#[test]
fn accessibility_radix_numbers_match_javascript_rounding() {
    let mut cases = vec![
        ("0x37e381050641e52".to_string(), 0x438b_f1c0_8283_20f3),
        ("0x20000000000001".to_string(), 0x4340_0000_0000_0000),
        ("0x20000000000003".to_string(), 0x4340_0000_0000_0002),
        ("0x100000000000008".to_string(), 0x4370_0000_0000_0000),
        ("0x100000000000018".to_string(), 0x4370_0000_0000_0002),
        ("0x1fffffffffffff".to_string(), 0x433f_ffff_ffff_ffff),
        (
            "0x10000000000000000000000000000001".to_string(),
            0x47b0_0000_0000_0000,
        ),
        (
            "0x123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            0x4b72_3456_789a_bcdf,
        ),
        ("0o200000000000000001".to_string(), 0x4330_0000_0000_0001),
        ("0o200000000000000003".to_string(), 0x4330_0000_0000_0003),
        (format!("0b1{}1", "0".repeat(53)), 0x4350_0000_0000_0000),
        (format!("0b1{}11", "0".repeat(53)), 0x4360_0000_0000_0000),
        (format!("0x1{}", "0".repeat(255)), 0x7fb0_0000_0000_0000),
        (format!("0x1{}", "0".repeat(256)), f64::INFINITY.to_bits()),
        (format!("0x{}", "f".repeat(80)), 0x53f0_0000_0000_0000),
        (format!("0o{}", "7".repeat(80)), 0x4ef0_0000_0000_0000),
        (format!("0b{}", "1".repeat(300)), 0x52b0_0000_0000_0000),
        (format!("0b1{}", "0".repeat(1023)), 0x7fe0_0000_0000_0000),
        (format!("0b1{}", "0".repeat(1024)), f64::INFINITY.to_bits()),
        (format!("0o1{}", "0".repeat(342)), f64::INFINITY.to_bits()),
        (format!("0x{}", "f".repeat(256)), f64::INFINITY.to_bits()),
    ];
    cases.push((
        "0X00000000000000000037e381050641e52".into(),
        0x438b_f1c0_8283_20f3,
    ));

    for (value, expected_bits) in cases {
        assert_eq!(
            js_number(&value).to_bits(),
            expected_bits,
            "Number({value:?})"
        );
    }
}

#[test]
fn accessibility_json_encoding_matches_javascript() {
    for (number, expected) in [
        (1e21, "1e+21"),
        (0.1, "0.1"),
        (-0.0, "0"),
        (f64::NAN, "null"),
        (1e-7, "1e-7"),
    ] {
        let mut output = String::new();
        write_number(&mut output, number);
        assert_eq!(output, expected);
    }
    let mut output = String::new();
    write_string(&mut output, "\u{1f}\u{8}\u{c}\n\r\t\"\\\u{2028}");
    assert_eq!(output, "\"\\u001f\\b\\f\\n\\r\\t\\\"\\\\\u{2028}\"");
}

#[test]
fn accessibility_full_and_root_json_preserve_wire_order() {
    let dom = DomHandle::new("<p>Hello</p>", "https://example.test/");
    let full = r#"{"method":"full","frameId":"F","title":"T","url":""}"#;
    let output = build_json(&dom, full).unwrap();
    let expected = concat!(
        r#"{"nodes":[{"nodeId":"root-F","ignored":false,"role":{"type":"internalRole","value":"RootWebArea"},"chromeRole":{"type":"internalRole","value":144},"name":{"type":"computedString","value":"T"},"value":{"type":"string","value":""},"backendDOMNodeId":0,"frameId":"F","childIds":["1"],"properties":[{"name":"url","value":{"type":"string","value":""}},{"name":"focusable","value":{"type":"booleanOrUndefined","value":true}}]},"#,
        r#"{"nodeId":"1","ignored":true,"backendDOMNodeId":1,"frameId":"F","ignoredReasons":[{"name":"uninteresting","value":{"type":"boolean","value":true}}],"role":{"type":"internalRole","value":"none"},"childIds":["3"],"parentId":"root-F"},"#,
        r#"{"nodeId":"3","ignored":false,"backendDOMNodeId":3,"frameId":"F","role":{"type":"internalRole","value":"generic"},"parentId":"1","childIds":["4"]},"#,
        r#"{"nodeId":"4","ignored":false,"backendDOMNodeId":4,"frameId":"F","role":{"type":"internalRole","value":"paragraph"},"parentId":"3","childIds":["5"]},"#,
        r#"{"nodeId":"5","ignored":false,"backendDOMNodeId":5,"frameId":"F","role":{"type":"internalRole","value":"StaticText"},"name":{"type":"computedString","value":"Hello"},"parentId":"4"}]}"#
    );
    assert_eq!(output, expected);
    let root = r#"{"method":"root","frameId":"F","title":"T","url":""}"#;
    let root_json = build_json(&dom, root).unwrap();
    assert_eq!(
        format!("{{\"nodes\":[{}]}}", &root_json[8..root_json.len() - 1]),
        expected
            .split("},{\"nodeId\":\"1\"")
            .next()
            .unwrap()
            .to_string()
            + "}]}"
    );
}

#[test]
fn accessibility_full_handles_5000_nested_elements_without_layout() {
    let dom = DomHandle::new("", "https://example.test/");
    let mut parent = node_id(&dom, "body");
    let mut ids = Vec::with_capacity(5000);
    for _ in 0..5000 {
        let child = dom.create_element("div");
        assert!(dom.append_child_node(parent, child));
        ids.push(child);
        parent = child;
    }
    let before = dom.resolve_counts();
    let output = build_json(&dom, r#"{"method":"full","visibility":false}"#).unwrap();
    assert_eq!(dom.resolve_counts(), before);
    let reply: serde_json::Value = serde_json::from_str(&output).unwrap();
    let nodes = reply["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 5003);
    for (node, id) in nodes[3..].iter().zip(&ids) {
        assert_eq!(node["backendDOMNodeId"], *id);
    }
    assert_eq!(nodes.last().unwrap()["backendDOMNodeId"], parent);
}

#[test]
fn blitz_parent_links_cover_children_and_shadow_roots() {
    let dom = DomHandle::new("<div id='host'><i>light</i></div>", "https://example.test/");
    let host = node_id(&dom, "#host");
    let shadow_root = u32::try_from(dom.attach_shadow(host, "open")).unwrap();
    let shadow_child = dom.create_element("button");
    assert!(dom.append_child_node(shadow_root, shadow_child));

    let doc = dom.doc.borrow();
    let mut pending = vec![doc.root_node().id()];
    while let Some(parent_id) = pending.pop() {
        let parent = doc.get_node(parent_id).unwrap();
        for child_id in parent.children() {
            let child = doc.get_node(child_id).unwrap();
            assert_eq!(child.parent_id(), Some(parent_id), "child {child_id:?}");
            pending.push(child_id);
        }
        if let Some(shadow_id) = parent.attached_shadow_root_id() {
            let shadow = doc.get_node(shadow_id).unwrap();
            assert_eq!(shadow.parent_id(), Some(parent_id));
            let blitz_dom::NodeData::ShadowRoot(data) = &shadow.data else {
                panic!("attached shadow root has ShadowRoot data");
            };
            assert_eq!(data.host, parent_id);
            for child_id in shadow.children() {
                let child = doc.get_node(child_id).unwrap();
                assert_eq!(
                    child.parent_id(),
                    Some(shadow_id),
                    "shadow child {child_id:?}"
                );
                pending.push(child_id);
            }
        }
    }
    assert!(dom.resolve_node_id(shadow_child).is_some());
}

#[test]
fn accessibility_full_uses_live_state_labels_and_document_base() {
    let dom = DomHandle::new(
        "<base href='https://example.test/base/'><label for='c'>First</label>\
         <label for='c'>Second</label><input id='c' type='checkbox' checked>\
         <select id='s'><option id='a' selected>Alpha</option><option id='b'>Beta</option></select>\
         <a id='link' href='page'>Go</a><div id='hidden' hidden><b>pruned</b></div>",
        "https://example.test/",
    );
    let check = node_id(&dom, "#c");
    let select = node_id(&dom, "#s");
    let option_a = node_id(&dom, "#a");
    let option_b = node_id(&dom, "#b");
    let link = node_id(&dom, "#link");
    let hidden = node_id(&dom, "#hidden");
    let request = serde_json::json!({
        "method": "full", "frameId": "F", "url": "https://example.test/start",
        "checked": [[check, false]], "selected": [[option_a, false], [option_b, true]]
    })
    .to_string();
    let result: serde_json::Value =
        serde_json::from_str(&build_json(&dom, &request).unwrap()).unwrap();
    let nodes = result["nodes"].as_array().unwrap();
    let find = |id: u32| {
        nodes
            .iter()
            .find(|node| node["backendDOMNodeId"] == id)
            .unwrap()
    };
    assert_eq!(find(check)["name"]["value"], "First");
    assert_eq!(
        find(check)["properties"],
        serde_json::json!([
            {"name":"focusable","value":{"type":"booleanOrUndefined","value":true}},
            {"name":"checked","value":{"type":"tristate","value":"false"}}
        ])
    );
    assert_eq!(find(select)["value"]["value"], "Beta");
    assert_eq!(
        find(option_b)["properties"],
        serde_json::json!([
            {"name":"selected","value":{"type":"boolean","value":true}}
        ])
    );
    assert_eq!(
        find(link)["properties"][0]["value"]["value"],
        "https://example.test/base/page"
    );
    assert_eq!(find(hidden)["ignoredReasons"][0]["name"], "notRendered");
    assert!(find(hidden).get("childIds").is_none());
    assert!(!nodes.iter().any(|node| node["name"]["value"] == "pruned"));
}

#[test]
fn accessibility_select_value_without_live_state() {
    let value_of = |markup: &str| {
        let dom = DomHandle::new(markup, "https://example.test/");
        let select = node_id(&dom, "#s");
        let result: serde_json::Value =
            serde_json::from_str(&build_json(&dom, r#"{"method":"full"}"#).unwrap()).unwrap();
        result["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["backendDOMNodeId"] == select)
            .unwrap()["value"]["value"]
            .clone()
    };
    // The last option marked selected wins.
    assert_eq!(
        value_of("<select id='s'><option selected>One</option><option selected>Two</option></select>"),
        "Two"
    );
    // The default skips options in a disabled optgroup.
    assert_eq!(
        value_of(
            "<select id='s'><optgroup label='G' disabled><option>Off</option></optgroup>\
             <option>On</option></select>"
        ),
        "On"
    );
    // A listbox has no default choice.
    assert_eq!(
        value_of("<select id='s' size='3'><option>A</option><option>B</option></select>"),
        serde_json::Value::Null
    );
    // A closed single select defaults to its first enabled option.
    assert_eq!(
        value_of("<select id='s' size='1'><option disabled>Nope</option><option>Yes</option></select>"),
        "Yes"
    );
}

#[test]
fn accessibility_form_values_preserve_utf16_code_units() {
    let dom = DomHandle::new(
        "<input id='lone'><textarea id='emoji'></textarea>",
        "https://example.test/",
    );
    let lone = node_id(&dom, "#lone");
    let emoji = node_id(&dom, "#emoji");
    let request = serde_json::json!({
        "method": "full",
        "values": [[lone, [97, 0xd800, 98]], [emoji, "😀"]]
    })
    .to_string();

    let output = build_json(&dom, &request).unwrap();
    assert!(
        output.contains(r#""value":{"type":"string","value":"a\ud800b"}"#),
        "{output}"
    );
    assert!(
        output.contains(r#""value":{"type":"string","value":"😀"}"#),
        "{output}"
    );
}

#[test]
fn accessibility_unavailable_document_and_bad_request() {
    let dom = DomHandle::new("", "https://example.test/");
    assert!(build_json(&dom, "not json").is_err());
    let borrowed = dom.doc.borrow_mut();
    assert_eq!(
        build_json(&dom, r#"{"method":"full"}"#).unwrap(),
        r#"{"nodes":[]}"#
    );
    assert_eq!(
        build_json(&dom, r#"{"method":"root"}"#).unwrap_err(),
        "No document loaded"
    );
    drop(borrowed);
}

#[test]
fn accessibility_scoped_partial_and_children() {
    let dom = DomHandle::new(
        "<div id='outer'><span id='a'></span><span id='b'></span></div>",
        "https://example.test/",
    );
    let outer = node_id(&dom, "#outer");
    let a = node_id(&dom, "#a");
    let b = node_id(&dom, "#b");
    let body = node_id(&dom, "body");
    let html = node_id(&dom, "html");
    let request = |args: serde_json::Value| -> Vec<String> {
        let reply: serde_json::Value =
            serde_json::from_str(&build_json(&dom, &args.to_string()).unwrap()).unwrap();
        reply["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["nodeId"].as_str().unwrap().to_string())
            .collect()
    };
    let as_ids = |ids: &[u32]| ids.iter().map(ToString::to_string).collect::<Vec<_>>();
    assert_eq!(
        request(
            serde_json::json!({"method":"partial","frameId":"F","nodeId":outer,"fetchRelatives":false})
        ),
        as_ids(&[outer, b, a])
    );
    let mut relatives = as_ids(&[outer, b, a, body, html]);
    relatives.push("root-F".into());
    assert_eq!(
        request(
            serde_json::json!({"method":"partial","frameId":"F","nodeId":outer,"fetchRelatives":true})
        ),
        relatives
    );
    assert_eq!(
        request(serde_json::json!({"method":"partial","frameId":"F","nodeId":outer})),
        relatives
    );
    assert_eq!(
        request(serde_json::json!({"method":"children","frameId":"F","axId":"root-F"})),
        as_ids(&[html])
    );
    assert_eq!(
        request(serde_json::json!({"method":"children","frameId":"F","axId":outer.to_string()})),
        as_ids(&[a, b])
    );
    for id in ["05", "bogus", "5.0"] {
        assert!(
            request(serde_json::json!({"method":"children","frameId":"F","axId":id})).is_empty()
        );
    }
    let mut ancestors = as_ids(&[a, outer, body, html]);
    ancestors.push("root-F".into());
    assert_eq!(
        request(serde_json::json!({"method":"ancestors","frameId":"F","nodeId":a})),
        ancestors
    );
}

#[test]
fn accessibility_query_filters_and_root() {
    let dom = DomHandle::new(
        "<div id='scope'><button id='named'>Yes</button><button id='empty'></button></div><button hidden>Hidden</button>",
        "https://example.test/",
    );
    let scope = node_id(&dom, "#scope");
    let named = node_id(&dom, "#named");
    let text = dom.child_ids(named).first().copied().unwrap();
    let empty = node_id(&dom, "#empty");
    let request = |args: serde_json::Value| -> Vec<String> {
        let reply: serde_json::Value =
            serde_json::from_str(&build_json(&dom, &args.to_string()).unwrap()).unwrap();
        reply["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["nodeId"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        request(serde_json::json!({"method":"query","nodeId":scope,"role":"button"})),
        vec![empty.to_string(), named.to_string()]
    );
    assert_eq!(
        request(serde_json::json!({"method":"query","role":"button","accessibleName":""})),
        vec![empty.to_string()]
    );
    assert_eq!(
        request(serde_json::json!({"method":"query","role":"","accessibleName":"Yes"})),
        vec![named.to_string(), text.to_string()]
    );
    assert_eq!(
        request(serde_json::json!({"method":"query","role":"RootWebArea"})),
        vec!["root-"]
    );
    assert!(
        request(serde_json::json!({"method":"query","nodeId":999999,"role":"button"})).is_empty()
    );
}

#[test]
fn accessibility_scoped_shadow_parents_and_pruned_nodes() {
    let dom = DomHandle::new(
        "<div id='host'><i id='light'></i></div><div hidden><span id='pruned'></span></div>",
        "https://example.test/",
    );
    let host = node_id(&dom, "#host");
    let light = node_id(&dom, "#light");
    let pruned = node_id(&dom, "#pruned");
    let root = u32::try_from(dom.attach_shadow(host, "open")).unwrap();
    let shadow = dom.create_element("button");
    assert!(dom.append_child_node(root, shadow));
    let read = |args: serde_json::Value| -> serde_json::Value {
        serde_json::from_str(&build_json(&dom, &args.to_string()).unwrap()).unwrap()
    };
    let children = read(serde_json::json!({"method":"children","axId":host.to_string()}));
    assert_eq!(children["nodes"][0]["nodeId"], shadow.to_string());
    assert_eq!(children["nodes"][1]["nodeId"], light.to_string());
    assert_eq!(children["nodes"][0]["parentId"], host.to_string());
    let ancestors = read(serde_json::json!({"method":"ancestors","nodeId":shadow}));
    assert_eq!(ancestors["nodes"][0]["nodeId"], shadow.to_string());
    assert_eq!(ancestors["nodes"][1]["nodeId"], host.to_string());
    for method in ["partial", "ancestors", "query"] {
        assert_eq!(
            read(serde_json::json!({"method":method,"nodeId":pruned}))["nodes"],
            serde_json::json!([])
        );
    }
}

#[test]
fn accessibility_stream_matches_buffered_replies_at_small_and_large_chunk_sizes() {
    let sources = [
        "<main><h1>Title</h1><button aria-label='go'>text</button></main>",
        "<label for='name'>Name</label><input id='name' value='Ada'>\
         <div hidden><span>not rendered</span></div>",
        "<div id='host'><i>light</i></div>",
    ];
    for source in sources {
        let dom = DomHandle::new(source, "https://example.test/");
        let requests = [ax_request("full"), ax_request("query")];
        for request in requests {
            let mut expected_args: serde_json::Value = serde_json::from_str(&request).unwrap();
            expected_args["buffered"] = serde_json::Value::Bool(true);
            let expected_request = expected_args.to_string();
            let expected = drain_start(
                start_accessibility_with_budget(&dom, &expected_request, usize::MAX).unwrap(),
                &dom,
                1 << 20,
            );
            for max in [1, 7, 4096, 1 << 20] {
                let actual = drain_start(
                    start_accessibility_with_budget(&dom, &request, usize::MAX).unwrap(),
                    &dom,
                    max,
                );
                assert_eq!(actual, expected, "{source:?}, {request}, chunk {max}");
            }
        }
    }
}

#[test]
fn accessibility_stream_ends_short_after_removal_or_same_length_text_change() {
    for change_text in [false, true] {
        let dom = DomHandle::new(
            "<div><span>early</span><span>also early</span><p id='tail'>one</p></div>",
            "https://example.test/",
        );
        let request = ax_request("full");
        let mut start = start_accessibility_with_budget(&dom, &request, usize::MAX).unwrap();
        let mut stream = start.take_stream().expect("full replies stream");
        let first = stream.next_chunk(&dom, 1);
        assert_eq!(first.len(), 1);

        let tail = node_id(&dom, "#tail");
        if change_text {
            let text = dom.child_ids(tail).first().copied().unwrap();
            assert!(dom.set_node_text(text, "two"));
        } else {
            assert!(dom.remove_node(tail));
        }

        let mut output = first;
        while output.len() < stream.byte_length() {
            let chunk = stream.next_chunk(&dom, 7);
            if chunk.is_empty() {
                break;
            }
            output.extend_from_slice(&chunk);
        }
        assert!(output.len() < stream.byte_length());
        assert!(stream.next_chunk(&dom, 7).is_empty());
    }
}

#[test]
fn accessibility_stream_keeps_high_fanout_node_output_within_chunk_size() {
    let children = "<span></span>".repeat(1200);
    let source = format!("<div>{children}</div>");
    let dom = DomHandle::new(&source, "https://example.test/");
    let request = ax_request("full");
    let expected = build_json(&dom, &request).unwrap();
    let mut start = start_accessibility_with_budget(&dom, &request, usize::MAX).unwrap();
    let mut stream = start.take_stream().expect("full replies stream");
    let mut output = Vec::new();
    loop {
        let chunk = stream.next_chunk(&dom, 7);
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= 7);
        output.extend_from_slice(&chunk);
    }
    assert_eq!(stream.byte_length(), expected.len());
    assert_eq!(String::from_utf8(output).unwrap(), expected);
}

#[test]
fn accessibility_stream_serializes_large_name_once() {
    let label = "x".repeat(3 * 1024 * 1024);
    let source = format!("<button aria-label='{label}'></button>");
    let dom = DomHandle::new(&source, "https://example.test/");
    let request = ax_request("full");
    let expected = build_json(&dom, &request).unwrap();
    let expected_nodes: serde_json::Value = serde_json::from_str(&expected).unwrap();
    let expected_node_count = expected_nodes["nodes"].as_array().unwrap().len();
    let mut start = start_accessibility_with_budget(&dom, &request, usize::MAX).unwrap();
    let mut stream = start.take_stream().expect("full replies stream");
    let mut output = Vec::new();
    loop {
        let chunk = stream.next_chunk(&dom, 4096);
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= 4096);
        output.extend_from_slice(&chunk);
    }
    assert_eq!(output, expected.as_bytes());
    assert_eq!(stream.serialized_nodes(), expected_node_count);
}

#[test]
fn accessibility_scoped_methods_return_buffered_bytes() {
    let dom = DomHandle::new(
        "<main id='m'><button>go</button></main>",
        "https://example.test/",
    );
    let main = node_id(&dom, "#m");
    let requests = [
        ax_request("root"),
        serde_json::json!({"method":"children", "frameId":"F", "axId":"root-F"}).to_string(),
        serde_json::json!({"method":"partial", "frameId":"F", "nodeId":main}).to_string(),
        serde_json::json!({"method":"query", "frameId":"F", "nodeId":main, "role":"button"})
            .to_string(),
    ];
    for request in requests {
        let expected = build_json(&dom, &request).unwrap();
        let mut start = start_accessibility_with_budget(&dom, &request, usize::MAX).unwrap();
        assert!(start.take_stream().is_none(), "{request}");
        let bytes = start.take_bytes().expect("scoped replies are buffered");
        assert_eq!(bytes.byte_length(), expected.len(), "{request}");
        assert_eq!(String::from_utf8(drain_bytes(bytes, 7)).unwrap(), expected);
    }
}

#[test]
fn accessibility_budget_reports_exact_counts_before_creating_output() {
    let dom = DomHandle::new("<main><button>go</button></main>", "https://example.test/");
    let request = ax_request("full");
    let expected: serde_json::Value =
        serde_json::from_str(&build_json(&dom, &request).unwrap()).unwrap();
    let bytes = build_json(&dom, &request).unwrap().len();
    let nodes = expected["nodes"].as_array().unwrap().len();

    let error = match start_accessibility_with_budget(&dom, &request, bytes - 1) {
        Err(AxStartError::Budget(error)) => error,
        _ => panic!("expected a typed budget error"),
    };
    assert_eq!(error.nodes, nodes);
    assert_eq!(error.bytes, bytes);
    assert_eq!(error.budget, bytes - 1);

    let accepted = start_accessibility_with_budget(&dom, &request, bytes).unwrap();
    assert_eq!(accepted.byte_length(), bytes);
}

#[test]
fn accessibility_full_depth_limits_nodes_but_keeps_child_ids() {
    let dom = DomHandle::new("<main><button>go</button></main>", "https://example.test/");
    let body_id = node_id(&dom, "body");
    let main_id = node_id(&dom, "main");
    let request =
        |depth| serde_json::json!({"method":"full", "frameId":"F", "depth":depth}).to_string();
    let full: serde_json::Value =
        serde_json::from_str(&build_json(&dom, &request(-1)).unwrap()).unwrap();
    let depth_two: serde_json::Value = serde_json::from_slice(&drain_start(
        start_accessibility_with_budget(&dom, &request(2), usize::MAX).unwrap(),
        &dom,
        4096,
    ))
    .unwrap();
    let nodes = depth_two["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[1]["backendDOMNodeId"], 1);
    assert_eq!(nodes[2]["backendDOMNodeId"], body_id);
    assert_eq!(nodes[2]["childIds"][0], main_id.to_string());
    assert!(full["nodes"].as_array().unwrap().len() > nodes.len());
}
