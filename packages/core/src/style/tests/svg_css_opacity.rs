// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use blitz_dom::node::{ImageData, SpecialElementData};

fn svg_tree(html: &str) -> usvg::Tree {
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector("svg").unwrap_or(-1);
    assert!(id > 0, "svg must match");
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32)).expect("node");
    let elem = node.element_data().expect("element");
    let tree = match elem.special_data() {
        SpecialElementData::Image(data) => match &**data {
            ImageData::Svg(svg) => (*svg.tree).clone(),
            _ => panic!("expected svg image data"),
        },
        _ => panic!("no image data on svg"),
    };
    drop(doc);
    tree
}

/// The opacity and blend mode of the group around each path, in paint order.
fn path_groups(tree: &usvg::Tree) -> Vec<(f32, usvg::BlendMode)> {
    fn walk(group: &usvg::Group, out: &mut Vec<(f32, usvg::BlendMode)>) {
        for child in group.children() {
            match child {
                usvg::Node::Group(g) => {
                    if g.children()
                        .iter()
                        .any(|c| matches!(c, usvg::Node::Path(_)))
                    {
                        out.push((g.opacity().get(), g.blend_mode()));
                    }
                    walk(g, out);
                }
                usvg::Node::Path(_) if group.opacity().get() == 1.0 => {
                    out.push((1.0, usvg::BlendMode::Normal));
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(tree.root(), &mut out);
    out
}

#[test]
fn author_rule_opacity_reaches_inner_svg_elements() {
    let tree = svg_tree(
        r##"<html><head><style>
            .faded { opacity: 0.2; }
        </style></head><body>
            <svg width="20" height="20"><rect class="faded" width="20" height="20" fill="red"/></svg>
        </body></html>"##,
    );
    let groups = path_groups(&tree);
    assert!(
        groups.iter().any(|(o, _)| (o - 0.2).abs() < 0.01),
        "expected a 0.2 opacity group, got {groups:?}"
    );
}

#[test]
fn author_rule_blend_mode_reaches_inner_svg_elements() {
    let tree = svg_tree(
        r##"<html><head><style>
            .blend { mix-blend-mode: multiply; }
        </style></head><body>
            <svg width="20" height="20"><rect class="blend" width="20" height="20" fill="red"/></svg>
        </body></html>"##,
    );
    let groups = path_groups(&tree);
    assert!(
        groups.iter().any(|(_, b)| *b == usvg::BlendMode::Multiply),
        "expected a multiply group, got {groups:?}"
    );
}

#[test]
fn author_rule_opacity_wins_over_the_attribute() {
    let tree = svg_tree(
        r##"<html><head><style>
            .faded { opacity: 0.2; }
        </style></head><body>
            <svg width="20" height="20"><rect class="faded" opacity="0.9" width="20" height="20" fill="red"/></svg>
        </body></html>"##,
    );
    let groups = path_groups(&tree);
    assert!(
        groups.iter().any(|(o, _)| (o - 0.2).abs() < 0.01),
        "expected the rule's 0.2 over the attribute's 0.9, got {groups:?}"
    );
}

#[test]
fn opacity_attribute_alone_is_kept() {
    let tree = svg_tree(
        r##"<html><body>
            <svg width="20" height="20"><rect opacity="0.5" width="20" height="20" fill="red"/></svg>
        </body></html>"##,
    );
    let groups = path_groups(&tree);
    assert!(
        groups.iter().any(|(o, _)| (o - 0.5).abs() < 0.01),
        "expected the attribute's 0.5, got {groups:?}"
    );
}
