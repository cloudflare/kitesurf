// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use blitz_dom::node::{ImageData, SpecialElementData};

fn first_fill_rgb(tree: &usvg::Tree) -> Option<(u8, u8, u8)> {
    fn walk(node: &usvg::Node) -> Option<(u8, u8, u8)> {
        match node {
            usvg::Node::Group(g) => g.children().iter().find_map(walk),
            usvg::Node::Path(p) => match p.fill().map(|f| f.paint()) {
                Some(usvg::Paint::Color(c)) => Some((c.red, c.green, c.blue)),
                _ => None,
            },
            _ => None,
        }
    }
    walk(&usvg::Node::Group(Box::new(tree.root().clone())))
}

fn icon_tree(html: &str) -> usvg::Tree {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector(".icon").unwrap_or(-1);
    assert!(id > 0, ".icon must match");
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32)).expect("node");
    let elem = node.element_data().expect("element");
    match elem.special_data() {
        SpecialElementData::Image(data) => match &**data {
            ImageData::Svg(svg) => (*svg.tree).clone(),
            _ => panic!("expected svg image data"),
        },
        _ => panic!("no image data on .icon"),
    }
}

#[test]
fn css_fill_currentcolor_colors_bare_paths() {
    let tree = icon_tree(
        r##"<html><head><style>
            .icon { color: rgb(0, 81, 195); fill: currentcolor; }
        </style></head><body>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>
        </body></html>"##,
    );
    assert_eq!(first_fill_rgb(&tree), Some((0, 81, 195)));
}

#[test]
fn css_fill_absolute_color_is_stamped() {
    let tree = icon_tree(
        r##"<html><head><style>
            .icon { fill: rgb(10, 20, 30); }
        </style></head><body>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>
        </body></html>"##,
    );
    assert_eq!(first_fill_rgb(&tree), Some((10, 20, 30)));
}

#[test]
fn oklch_color_still_yields_parseable_stamp() {
    let tree = icon_tree(
        r##"<html><head><style>
            .icon { color: oklch(0.6 0.2 250); fill: currentcolor; }
        </style></head><body>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>
        </body></html>"##,
    );
    let (r, g, b) = first_fill_rgb(&tree).expect("filled path");
    assert!(b > r && b > 60, "expected blue-ish, got rgb({r},{g},{b})");
}

#[test]
fn modern_svg_fill_attributes_are_resolved_before_usvg() {
    for fill in ["lch(100% 0 0)", "lab(100% 0 0)", "color(srgb 1 1 1)"] {
        let html = format!(
            r#"<html><body>
                <svg class="icon" width="20" height="20" viewBox="0 0 20 20">
                    <path fill="{fill}" d="M0 0h20v20H0z"/>
                </svg>
            </body></html>"#
        );
        let (r, g, b) = first_fill_rgb(&icon_tree(&html)).expect("filled path");
        assert!(
            r > 240 && g > 240 && b > 240,
            "expected white from {fill}, got rgb({r},{g},{b})"
        );
    }
}

#[test]
fn semi_transparent_fill_stamps_parseable_rgba() {
    let tree = icon_tree(
        r##"<html><head><style>
            .icon { fill: rgb(10 20 30 / 50%); }
        </style></head><body>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>
        </body></html>"##,
    );
    assert_eq!(first_fill_rgb(&tree), Some((10, 20, 30)));
}

#[test]
fn root_fill_attribute_wins_over_stamp() {
    let tree = icon_tree(
        r##"<html><body>
            <svg class="icon" width="20" height="20" viewBox="0 0 20 20" fill="rgb(200,0,0)"><path d="M0 0h20v20H0z"/></svg>
        </body></html>"##,
    );
    assert_eq!(first_fill_rgb(&tree), Some((200, 0, 0)));
}

#[test]
fn sprite_symbol_gets_css_fill_from_use_site() {
    let tree = icon_tree(
        r##"<html><head><style>
            .icon { color: rgb(0, 81, 195); fill: currentcolor; }
        </style></head><body>
            <svg style="display:none"><symbol id="bots" viewBox="0 0 12 12"><path d="M0 0h12v12H0z"/></symbol></svg>
            <svg class="icon" width="20" height="20"><use href="#bots"/></svg>
        </body></html>"##,
    );
    assert_eq!(first_fill_rgb(&tree), Some((0, 81, 195)));
}
