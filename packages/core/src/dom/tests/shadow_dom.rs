// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use blitz_dom::NodeId;

const HTML: &str = r##"<!DOCTYPE html>
<html><body><div id="host"></div><p id="sibling">light</p></body></html>"##;

fn host_id(dom: &DomHandle) -> u32 {
    let id = dom.query_selector("#host").expect("query ok");
    assert!(id >= 0, "#host found");
    id as u32
}

fn internal_id(dom: &DomHandle, external: u32) -> NodeId {
    dom.resolve_node_id(external).expect("node handle is live")
}

#[test]
fn attach_links_host_and_is_idempotent() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);

    let root = dom.attach_shadow(host, "open");
    assert!(root >= 0, "attach returns a node id");
    assert_eq!(dom.shadow_root_id(host), root, "host -> root linkage");
    assert_eq!(dom.shadow_host_id(root as u32), host as i32, "root -> host");

    assert_eq!(dom.attach_shadow(host, "closed"), root);
}

#[test]
fn attach_rejects_non_elements_and_bad_modes() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);

    let text = dom.create_text_node("loose");
    assert_eq!(dom.attach_shadow(text, "open"), -1, "text node rejected");
    assert_eq!(dom.attach_shadow(999_999, "open"), -1, "stale id rejected");
    assert_eq!(
        dom.attach_shadow(host, "sorta-open"),
        -1,
        "bad mode rejected"
    );
    assert_eq!(dom.shadow_root_id(host), -1, "no root left behind");
}

#[test]
fn shadow_content_is_hidden_from_light_tree_walks() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open") as u32;

    let span = dom.create_element("span");
    let text = dom.create_text_node("shadowed");
    assert!(dom.append_child_node(span, text));
    assert!(dom.append_child_node(root, span));

    assert!(
        dom.child_ids(host).is_empty(),
        "host.children stays empty: the root is not a light child"
    );
    assert!(
        !dom.outer_html(host).contains("shadowed"),
        "host serialization must not leak shadow content"
    );
    assert!(
        dom.outer_html(root).contains("shadowed"),
        "serializing the shadow root itself walks its children"
    );
}

#[test]
fn dropping_a_host_frees_its_shadow_subtree() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let baseline = dom.node_count();

    let root = dom.attach_shadow(host, "open") as u32;
    let span = dom.create_element("span");
    assert!(dom.append_child_node(root, span));
    assert_eq!(dom.node_count(), baseline + 2, "root + span added");

    {
        let mut doc = dom.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.remove_and_drop_node(internal_id(&dom, host));
    }
    assert_eq!(
        dom.node_count(),
        baseline - 1,
        "host, shadow root, and shadow children all freed"
    );
}

#[test]
fn shadow_content_is_styled_and_inherits_through_the_flat_tree() {
    let html = r##"<!DOCTYPE html>
<html><head><style>#host { color: rgb(1, 2, 3); }</style></head>
<body><div id="host"></div><p id="sibling">light</p></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let host = host_id(&dom);
    let sibling = dom.query_selector("#sibling").expect("query ok") as u32;

    let root = dom.attach_shadow(host, "open") as u32;
    let span = dom.create_element("span");
    assert!(dom.append_child_node(root, span));
    dom.resolve_layout();

    let doc = dom.doc.borrow();
    let span_styles = doc
        .get_node(internal_id(&dom, span))
        .expect("span alive")
        .primary_styles()
        .expect("the style traversal must reach shadow content via the flat tree");
    let host_styles = doc
        .get_node(internal_id(&dom, host))
        .expect("host alive")
        .primary_styles()
        .expect("host styled");
    let sibling_styles = doc
        .get_node(internal_id(&dom, sibling))
        .expect("sibling alive")
        .primary_styles()
        .expect("sibling styled");

    let span_color = format!("{:?}", span_styles.clone_color());
    let host_color = format!("{:?}", host_styles.clone_color());
    let sibling_color = format!("{:?}", sibling_styles.clone_color());
    assert_eq!(span_color, host_color, "shadow span inherits host color");
    assert_ne!(
        span_color, sibling_color,
        "the inherited color is the host override, not the default"
    );
}

#[test]
fn shadow_content_lays_out_and_light_children_do_not() {
    let html = r##"<!DOCTYPE html>
<html><body><div id="host"><p id="light">light text</p></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let host = host_id(&dom);
    let light = dom.query_selector("#light").expect("query ok") as u32;

    let root = dom.attach_shadow(host, "open") as u32;
    let sdiv = dom.create_element("div");
    assert!(dom.set_attribute(sdiv, "style", "width: 120px; height: 40px;"));
    assert!(dom.append_child_node(root, sdiv));
    dom.resolve_layout();

    let doc = dom.doc.borrow();
    let sdiv_layout = doc
        .get_node(internal_id(&dom, sdiv))
        .expect("sdiv alive")
        .final_layout();
    assert_eq!(
        (sdiv_layout.size.width, sdiv_layout.size.height),
        (120.0, 40.0),
        "shadow content gets real boxes via the flat tree"
    );

    let host_layout = doc
        .get_node(internal_id(&dom, host))
        .expect("host alive")
        .final_layout();
    assert!(
        host_layout.size.height >= 40.0,
        "host box contains its shadow content (got {:?})",
        host_layout.size
    );

    let light_layout = doc
        .get_node(internal_id(&dom, light))
        .expect("light alive")
        .final_layout();
    assert_eq!(
        (light_layout.size.width, light_layout.size.height),
        (0.0, 0.0),
        "unslotted light children don't render"
    );
}

#[test]
fn scroll_queries_on_a_shadow_root_return_none_without_panicking() {
    use std::panic;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    let html = r##"<!DOCTYPE html>
<html><body><div id="host" style="width:100px;height:100px;overflow:scroll"></div></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open") as u32;
    let tall = dom.create_element("div");
    assert!(dom.set_attribute(tall, "style", "width:400px;height:400px"));
    assert!(dom.append_child_node(root, tall));
    dom.resolve_layout();

    let panicked = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&panicked);
    let this_thread = thread::current().id();
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |_| {
        if thread::current().id() == this_thread {
            flag.store(true, Ordering::SeqCst);
        }
    }));
    let root_info = dom.read_scroll_info(root);
    let root_write = dom.write_scroll_offset(root, 0.0, 40.0);
    panic::set_hook(prev);

    assert!(root_info.is_none(), "a shadow root has no scroll metrics");
    assert!(root_write.is_none(), "a shadow root has no scroll offset");
    assert!(
        !panicked.load(Ordering::SeqCst),
        "layout-less node access must not panic"
    );

    let host_info = dom
        .read_scroll_info(host)
        .expect("the host has scroll metrics");
    assert!(host_info.scroll_height > 0.0);
    let host_write = dom
        .write_scroll_offset(host, 0.0, 40.0)
        .expect("the host accepts a scroll offset");
    assert_eq!(host_write.y, 40.0);
}

fn build_shadow_tree(dom: &DomHandle, root: u32, css: &str) -> u32 {
    let style = dom.create_element("style");
    let css_text = dom.create_text_node(css);
    assert!(dom.append_child_node(style, css_text));
    assert!(dom.append_child_node(root, style));

    let span = dom.create_element("span");
    let text = dom.create_text_node("shadowed");
    assert!(dom.append_child_node(span, text));
    assert!(dom.append_child_node(root, span));
    span
}

fn color_of(dom: &DomHandle, node_id: u32) -> String {
    let doc = dom.doc.borrow();
    let styles = doc
        .get_node(internal_id(dom, node_id))
        .expect("node alive")
        .primary_styles()
        .expect("node styled");
    format!("{:?}", styles.clone_color())
}

#[test]
fn shadow_styles_are_scoped_in_both_directions() {
    let html = r##"<!DOCTYPE html>
<html><head><style>span { color: rgb(7, 8, 9); }</style></head>
<body><div id="host"></div><span id="lightspan">light</span></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let host = host_id(&dom);
    let light_span = dom.query_selector("#lightspan").expect("query ok") as u32;

    let root = dom.attach_shadow(host, "open") as u32;
    let shadow_span = build_shadow_tree(&dom, root, "span { color: rgb(4, 5, 6); }");
    dom.resolve_layout();

    let shadow_color = color_of(&dom, shadow_span);
    let light_color = color_of(&dom, light_span);
    assert!(
        shadow_color.contains("0.015686275"),
        "shadow rule styles shadow content (rgb(4,5,6) has g=5/255): {shadow_color}"
    );
    assert!(
        light_color.contains("0.02745098"),
        "document rule keeps styling light content (rgb(7,8,9) has b=9/255): {light_color}"
    );
    assert_ne!(
        shadow_color, light_color,
        "document span rule must NOT leak into the shadow tree, nor vice versa"
    );
}

#[test]
fn nth_child_matches_direct_children_of_a_shadow_root() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open") as u32;
    let span = build_shadow_tree(&dom, root, "span:nth-child(2) { color: rgb(4, 5, 6); }");
    dom.resolve_layout();

    let color = color_of(&dom, span);
    assert!(
        color.contains("0.015686275"),
        "nth-child counts shadow-root children: {color}"
    );
}

#[test]
fn host_pseudo_class_styles_the_host_from_inside() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let sibling = dom.query_selector("#sibling").expect("query ok") as u32;

    let root = dom.attach_shadow(host, "open") as u32;
    let shadow_span = build_shadow_tree(&dom, root, ":host { color: rgb(11, 12, 13); }");
    dom.resolve_layout();

    let host_color = color_of(&dom, host);
    assert!(
        host_color.contains("0.047058824"),
        ":host styles the host element (rgb(11,12,13) has g=12/255): {host_color}"
    );
    assert_eq!(
        color_of(&dom, shadow_span),
        host_color,
        "shadow content inherits the :host color through the flat tree"
    );
    assert_ne!(
        color_of(&dom, sibling),
        host_color,
        ":host never styles anything outside its own host"
    );
}

#[test]
fn removing_a_shadow_style_unregisters_its_rules() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open") as u32;
    let shadow_span = build_shadow_tree(&dom, root, "span { color: rgb(4, 5, 6); }");
    dom.resolve_layout();
    assert!(color_of(&dom, shadow_span).contains("0.015686275"));

    let style_id = dom.child_ids(root)[0];
    assert!(dom.remove_node(style_id));
    dom.resolve_layout();
    assert!(
        !color_of(&dom, shadow_span).contains("0.015686275"),
        "rules from a removed shadow <style> must stop applying"
    );
}

#[test]
fn shadow_root_inner_html_parses_with_host_context() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open") as u32;

    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{root},"html":"<style>span {{ color: rgb(4, 5, 6); }}</style><span>shadowed</span>"}}]"#
    );
    dom.apply_ops(&ops).expect("ops applied");
    dom.resolve_layout();

    let kids = dom.child_ids(root);
    assert_eq!(kids.len(), 2, "style + span parsed into the root");
    assert!(dom.outer_html(root).contains("shadowed"));
    assert!(
        color_of(&dom, kids[1]).contains("0.015686275"),
        "the scoped style applies to the parsed shadow content"
    );
}

fn build_slotted_tree(dom: &DomHandle, host: u32, shadow_html: &str) -> u32 {
    let root = dom.attach_shadow(host, "open") as u32;
    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{root},"html":"{}"}}]"#,
        shadow_html.replace('"', "\\\""),
    );
    dom.apply_ops(&ops).expect("ops applied");
    root
}

fn find_in_subtree(dom: &DomHandle, root: u32, sel: &str) -> u32 {
    let ids = dom
        .query_selector_all_in_subtree(root, sel)
        .expect("query ok");
    assert!(!ids.is_empty(), "selector {sel} matches in subtree");
    ids[0] as u32
}

#[test]
fn named_and_default_slots_assign_and_render() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);

    let span = dom.create_element("span");
    assert!(dom.set_attribute(span, "slot", "a"));
    assert!(dom.append_child_node(span, dom.create_text_node("A")));
    let text = dom.create_text_node("T");
    let em = dom.create_element("em");
    assert!(dom.append_child_node(em, dom.create_text_node("E")));
    let block = dom.create_element("div");
    assert!(dom.set_attribute(block, "style", "width: 60px; height: 25px;"));
    for id in [span, text, em, block] {
        assert!(dom.append_child_node(host, id));
    }

    let root = build_slotted_tree(
        &dom,
        host,
        r#"<div id="wrap"><slot name="a"></slot><slot><p>fallback</p></slot></div>"#,
    );
    dom.resolve_layout();

    let named_slot = find_in_subtree(&dom, root, "slot[name=a]");
    let default_slot = find_in_subtree(&dom, root, "slot:not([name])");

    let doc = dom.doc.borrow();
    let named = doc.get_node(internal_id(&dom, named_slot)).unwrap();
    assert_eq!(
        named.assigned_nodes().map(|nodes| &nodes[..]),
        Some(&[internal_id(&dom, span)][..]),
        "named slot gets the slot=a child"
    );
    let default = doc.get_node(internal_id(&dom, default_slot)).unwrap();
    assert_eq!(
        default.assigned_nodes().map(|nodes| &nodes[..]),
        Some(
            &[
                internal_id(&dom, text),
                internal_id(&dom, em),
                internal_id(&dom, block),
            ][..]
        ),
        "default slot gets text + un-attributed elements, in host order"
    );
    assert_eq!(
        doc.get_node(internal_id(&dom, span))
            .unwrap()
            .assigned_slot(),
        Some(internal_id(&dom, named_slot)),
        "slottable back-pointer"
    );

    let fallback_p = doc
        .get_node(internal_id(&dom, default_slot))
        .unwrap()
        .children()
        .first()
        .unwrap();
    assert_eq!(
        (doc.get_node(fallback_p).unwrap().final_layout().size.height),
        0.0,
        "fallback content must not render while nodes are assigned"
    );
    let block_size = doc
        .get_node(internal_id(&dom, block))
        .unwrap()
        .final_layout()
        .size;
    assert_eq!(
        (block_size.width, block_size.height),
        (60.0, 25.0),
        "slotted light content renders through the slot"
    );
}

#[test]
fn empty_slots_render_fallback_until_content_arrives() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = build_slotted_tree(
        &dom,
        host,
        r#"<slot><div style="width: 80px; height: 30px;"></div></slot>"#,
    );
    dom.resolve_layout();

    let slot = find_in_subtree(&dom, root, "slot");
    {
        let doc = dom.doc.borrow();
        let fb = doc
            .get_node(internal_id(&dom, slot))
            .unwrap()
            .children()
            .first()
            .unwrap();
        let size = doc.get_node(fb).unwrap().final_layout().size;
        assert_eq!((size.width, size.height), (80.0, 30.0), "fallback renders");
    }

    let div = dom.create_element("div");
    assert!(dom.set_attribute(div, "style", "width: 50px; height: 20px;"));
    assert!(dom.append_child_node(host, div));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let host_size = doc
        .get_node(internal_id(&dom, host))
        .unwrap()
        .final_layout()
        .size;
    assert_eq!(
        host_size.height, 20.0,
        "host box holds exactly the assigned div; the 30px fallback is gone"
    );
    let size = doc
        .get_node(internal_id(&dom, div))
        .unwrap()
        .final_layout()
        .size;
    assert_eq!((size.width, size.height), (50.0, 20.0), "assigned renders");
}

#[test]
fn nested_slot_rebuilds_when_light_children_change_after_layout() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = build_slotted_tree(
        &dom,
        host,
        r#"<div id="content" style="display: flex"><slot></slot></div>"#,
    );
    dom.resolve_layout();

    let div = dom.create_element("div");
    assert!(dom.set_attribute(div, "style", "width: 50px; height: 20px;"));
    assert!(dom.append_child_node(host, div));
    dom.resolve_layout();
    let content = find_in_subtree(&dom, root, "#content");
    {
        let doc = dom.doc.borrow();
        let size = doc
            .get_node(internal_id(&dom, div))
            .unwrap()
            .final_layout()
            .size;
        assert_eq!(
            (size.width, size.height),
            (50.0, 20.0),
            "late slottable renders"
        );
        let content_h = doc
            .get_node(internal_id(&dom, content))
            .unwrap()
            .final_layout()
            .size
            .height;
        assert_eq!(content_h, 20.0, "slot container holds the late slottable");
    }

    assert!(dom.remove_node(div));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let content_h = doc
        .get_node(internal_id(&dom, content))
        .unwrap()
        .final_layout()
        .size
        .height;
    assert_eq!(content_h, 0.0, "slot container drops the removed slottable");
}

#[test]
fn slotted_selector_and_inheritance_come_from_the_slot() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let span = dom.create_element("span");
    assert!(dom.append_child_node(span, dom.create_text_node("S")));
    assert!(dom.append_child_node(host, span));

    let root = build_slotted_tree(
        &dom,
        host,
        r#"<style>slot { color: rgb(21, 22, 23); } ::slotted(span) { background-color: rgb(31, 32, 33); }</style><slot></slot>"#,
    );
    dom.resolve_layout();

    let slot = find_in_subtree(&dom, root, "slot");
    let doc = dom.doc.borrow();
    let span_styles = doc
        .get_node(internal_id(&dom, span))
        .unwrap()
        .primary_styles()
        .expect("slotted content styled");
    let slot_color = format!(
        "{:?}",
        doc.get_node(internal_id(&dom, slot))
            .unwrap()
            .primary_styles()
            .expect("slot styled")
            .clone_color()
    );
    assert_eq!(
        format!("{:?}", span_styles.clone_color()),
        slot_color,
        "slotted content inherits from its slot, not the host"
    );
    let bg = format!("{:?}", span_styles.get_background().background_color);
    assert!(
        bg.contains("31") || bg.contains("0.12156863"),
        "::slotted() rule from the shadow sheet applies: {bg}"
    );
}

#[test]
fn slot_attribute_change_reassigns() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let span = dom.create_element("span");
    assert!(dom.append_child_node(span, dom.create_text_node("S")));
    assert!(dom.append_child_node(host, span));

    let root = build_slotted_tree(&dom, host, r#"<slot name="a"></slot><slot></slot>"#);
    dom.resolve_layout();

    let named_slot = find_in_subtree(&dom, root, "slot[name=a]");
    let default_slot = find_in_subtree(&dom, root, "slot:not([name])");
    {
        let doc = dom.doc.borrow();
        assert_eq!(
            doc.get_node(internal_id(&dom, span))
                .unwrap()
                .assigned_slot(),
            Some(internal_id(&dom, default_slot)),
            "no slot attr -> default slot"
        );
    }

    assert!(dom.set_attribute(span, "slot", "a"));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    assert_eq!(
        doc.get_node(internal_id(&dom, span))
            .unwrap()
            .assigned_slot(),
        Some(internal_id(&dom, named_slot)),
        "slot attr flip moves the assignment"
    );
    assert_eq!(
        doc.get_node(internal_id(&dom, default_slot))
            .unwrap()
            .assigned_nodes()
            .map(|nodes| &nodes[..]),
        Some(&[][..]),
        "old slot loses it"
    );
}

#[test]
fn shadow_ids_never_touch_the_document_id_map() {
    let html = r##"<!DOCTYPE html>
<html><body><div id="host"></div><p id="needle">light</p></body></html>"##;
    let dom = DomHandle::new(html, "https://test.example/");
    let host = host_id(&dom);
    let light = internal_id(
        &dom,
        dom.query_selector("#needle").expect("query ok") as u32,
    );

    let root = dom.attach_shadow(host, "open") as u32;
    let imposter = dom.create_element("span");
    assert!(dom.set_attribute(imposter, "id", "needle"));
    assert!(dom.append_child_node(root, imposter));
    {
        let doc = dom.doc.borrow();
        assert_eq!(
            doc.get_element_by_id("needle"),
            Some(light),
            "shadow imposter must not clobber the light entry"
        );
    }

    assert!(dom.remove_node(imposter));
    {
        let doc = dom.doc.borrow();
        assert_eq!(
            doc.get_element_by_id("needle"),
            Some(light),
            "removing the shadow imposter must not evict the light entry"
        );
    }

    let hidden = dom.create_element("span");
    assert!(dom.set_attribute(hidden, "id", "shadow-only"));
    assert!(dom.append_child_node(root, hidden));
    let doc = dom.doc.borrow();
    assert_eq!(
        doc.get_element_by_id("shadow-only"),
        None,
        "shadow-only ids are invisible to the document id map"
    );
}

#[test]
fn cloned_hosts_do_not_alias_the_original_shadow_tree() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let root = dom.attach_shadow(host, "open");

    let clone = dom.deep_clone_node(host);
    assert!(clone != 0, "clone created");
    assert_eq!(
        dom.shadow_root_id(clone),
        -1,
        "clones never copy (or alias) shadow roots, per spec"
    );
    assert_eq!(dom.shadow_root_id(host), root, "original keeps its root");
}

#[test]
fn comment_text_survives_inner_html_and_clone() {
    let dom = DomHandle::new(
        r##"<!DOCTYPE html><html><body><div id="host"><!--lit$marker$--></div></body></html>"##,
        "https://test.example/",
    );
    let host = dom.query_selector("#host").expect("q") as u32;
    assert!(
        dom.outer_html(host).contains("lit$marker$"),
        "main parse keeps text"
    );
    let kids = dom.child_ids(host);
    assert_eq!(dom.get_comment_data(kids[0]), "lit$marker$");

    let div = dom.create_element("div");
    let ops = format!(
        r#"[{{"kind":"setInnerHtml","node":{div},"html":"<span><!--lit$inner$--></span>"}}]"#
    );
    dom.apply_ops(&ops).expect("ops");
    let span = dom.child_ids(div)[0];
    let c2 = dom.child_ids(span)[0];
    assert_eq!(
        dom.get_comment_data(c2),
        "lit$inner$",
        "innerHTML-parsed comments keep text"
    );

    let div2 = dom.create_element("div");
    let ops2 = format!(
        r#"[{{"kind":"setInnerHtml","node":{div2},"html":"<p>x<?lit$777$></p><!--tail-->"}}]"#
    );
    dom.apply_ops(&ops2).expect("ops2");
    let p2 = dom.child_ids(div2)[0];
    let bogus = dom.child_ids(p2)[1];
    assert_eq!(
        dom.get_comment_data(bogus),
        "?lit$777$",
        "bogus comments carry data"
    );
    let tail = dom.child_ids(div2)[1];
    assert_eq!(
        dom.get_comment_data(tail),
        "tail",
        "zip stays aligned past bogus comments"
    );

    let clone = dom.deep_clone_node(host);
    let ckids = dom.child_ids(clone);
    assert_eq!(
        dom.get_comment_data(ckids[0]),
        "lit$marker$",
        "cloned comments keep their text (fresh ids, copied entries)"
    );
}

#[test]
fn restyle_inside_a_slotted_subtree_reaches_the_style_traversal() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    build_slotted_tree(
        &dom,
        host,
        r#"<div style="display: flex; flex-direction: column; width: 300px; height: 200px"><slot name="m"></slot></div>"#,
    );
    let slotted = dom.create_element("div");
    assert!(dom.set_attribute(slotted, "slot", "m"));
    assert!(dom.set_attribute(slotted, "style", "display: flex; flex: auto"));
    let child = dom.create_element("div");
    assert!(dom.set_attribute(child, "style", "display: none; width: 50px; height: 20px"));
    assert!(dom.append_child_node(slotted, child));
    assert!(dom.append_child_node(host, slotted));
    dom.resolve_layout();

    assert!(dom.set_attribute(child, "style", "display: block; width: 50px; height: 20px"));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let node = doc.get_node(internal_id(&dom, child)).unwrap();
    let display = node
        .primary_styles()
        .map(|s| format!("{:?}", s.clone_display()));
    let size = node.final_layout().size;
    assert_eq!(
        (size.width, size.height),
        (50.0, 20.0),
        "revealed child gets its box (display {display:?})"
    );
}

#[test]
fn freeing_a_slot_clears_its_slottables_assigned_slot() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    let host = host_id(&dom);
    let span = dom.create_element("span");
    let text = dom.create_text_node("hi");
    assert!(dom.append_child_node(span, text));
    assert!(dom.append_child_node(host, span));
    let root = build_slotted_tree(&dom, host, r#"<div id="wrap"><slot></slot></div>"#);
    dom.resolve_layout();

    let wrap = find_in_subtree(&dom, root, "#wrap");
    assert!(dom.drop_node(wrap));
    assert!(dom.set_attribute(span, "class", "y"));
    assert!(dom.set_node_text(text, "changed"));
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    assert_eq!(
        doc.get_node(internal_id(&dom, span))
            .unwrap()
            .assigned_slot(),
        None
    );
}
