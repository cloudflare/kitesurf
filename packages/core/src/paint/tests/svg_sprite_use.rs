// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use blitz_dom::node::{ImageData, SpecialElementData};
use usvg::{Node, Tree};

fn first_fill_rgb(tree: &Tree) -> Option<(u8, u8, u8)> {
    fn walk(node: &Node) -> Option<(u8, u8, u8)> {
        match node {
            Node::Group(g) => g.children().iter().find_map(walk),
            Node::Path(p) => match p.fill().map(|f| f.paint()) {
                Some(usvg::Paint::Color(c)) => Some((c.red, c.green, c.blue)),
                _ => None,
            },
            _ => None,
        }
    }
    walk(&Node::Group(Box::new(tree.root().clone())))
}

fn path_count(tree: &Tree) -> usize {
    fn walk(node: &Node) -> usize {
        match node {
            Node::Group(g) => g.children().iter().map(walk).sum(),
            Node::Path(_) => 1,
            _ => 0,
        }
    }
    walk(&Node::Group(Box::new(tree.root().clone())))
}

fn svg_tree_for(dom: &DomHandle, sel: &str) -> Option<std::sync::Arc<Tree>> {
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {}", sel);
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32))?;
    let elem = node.element_data()?;
    match &elem.special_data {
        SpecialElementData::Image(data) => match &**data {
            ImageData::Svg(svg) => Some(svg.tree.clone()),
            _ => None,
        },
        _ => None,
    }
}

#[test]
fn use_resolves_symbol_from_external_sprite() {
    let html = r##"<html><body>
        <svg style="display:none"><defs>
          <symbol id="icon-star" viewBox="0 0 20 20"><path d="M0 0h20v20H0z" fill="#ff0000"/></symbol>
        </defs></svg>
        <svg class="icon" width="20" height="20"><use href="#icon-star"/></svg>
    </body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let tree = svg_tree_for(&dom, ".icon").expect("icon svg must parse");
    assert!(path_count(&tree) > 0, "sprite <use> resolved to no paths");
    assert_eq!(first_fill_rgb(&tree), Some((255, 0, 0)));
}

#[test]
fn sprite_currentcolor_resolves_at_use_site_not_sprite_site() {
    let html = r##"<html><head><style>
        .sprite { display: none; color: rgb(0, 128, 0); }
        .icon { color: rgb(0, 160, 160); }
    </style></head><body>
        <svg class="sprite"><symbol id="icon-dot" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="currentColor"/></symbol></svg>
        <svg class="icon" width="20" height="20"><use href="#icon-dot"/></svg>
    </body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let tree = svg_tree_for(&dom, ".icon").expect("icon svg must parse");
    assert_eq!(first_fill_rgb(&tree), Some((0, 160, 160)));
}

#[test]
fn symbol_chaining_to_another_symbol_resolves() {
    let html = r##"<html><body>
        <svg style="display:none">
          <symbol id="inner" viewBox="0 0 20 20"><path d="M0 0h20v20H0z" fill="#0000ff"/></symbol>
          <symbol id="outer" viewBox="0 0 20 20"><use href="#inner"/></symbol>
        </svg>
        <svg class="icon" width="20" height="20"><use href="#outer"/></svg>
    </body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let tree = svg_tree_for(&dom, ".icon").expect("icon svg must parse");
    assert!(path_count(&tree) > 0, "chained sprite <use> lost its path");
}

fn first_fill_is_gradient(tree: &Tree) -> bool {
    fn walk(node: &Node) -> Option<bool> {
        match node {
            Node::Group(g) => g.children().iter().find_map(walk),
            Node::Path(p) => Some(matches!(
                p.fill().map(|f| f.paint()),
                Some(usvg::Paint::LinearGradient(_))
            )),
            _ => None,
        }
    }
    walk(&Node::Group(Box::new(tree.root().clone()))).unwrap_or(false)
}

fn gradient_hoisted_via(ref_tag: &str) -> bool {
    let html = format!(
        r##"<html><body>
        <svg style="display:none"><linearGradient id="grad"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></svg>
        <svg class="icon" width="20" height="20" viewBox="0 0 20 20">{ref_tag}<path d="M0 0h20v20H0z" fill="url(#grad)"/></svg>
    </body></html>"##
    );
    let dom = DomHandle::new(&html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let tree = svg_tree_for(&dom, ".icon").expect("icon svg must parse");
    first_fill_is_gradient(&tree)
}

#[test]
fn anchor_href_hoists_nothing() {
    assert!(
        !gradient_hoisted_via(r##"<a href="#grad"></a>"##),
        "an <a> fragment ref hoisted its target"
    );
}

#[test]
fn use_and_image_refs_still_hoist() {
    assert!(
        gradient_hoisted_via(r##"<use href="#grad"/>"##),
        "<use> stopped hoisting"
    );
    assert!(
        gradient_hoisted_via(r##"<image href="#grad"/>"##),
        "<image> stopped hoisting"
    );
}

#[test]
fn tag_prefix_lookalike_hoists_nothing() {
    assert!(
        !gradient_hoisted_via(r##"<useful-thing href="#grad"></useful-thing>"##),
        "a tag sharing the <use prefix hoisted its target"
    );
}

#[test]
fn bare_url_paint_ref_does_not_hoist() {
    assert!(
        !gradient_hoisted_via(""),
        "url(#id) alone triggered a hoist"
    );
}

#[test]
fn missing_target_stays_harmless() {
    let html = r##"<html><body>
        <svg class="icon" width="20" height="20"><use href="#nope"/></svg>
    </body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    if let Some(tree) = svg_tree_for(&dom, ".icon") {
        assert_eq!(path_count(&tree), 0);
    }
}
