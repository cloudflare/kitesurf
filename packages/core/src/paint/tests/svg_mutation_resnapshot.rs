// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;
use blitz_dom::node::{ImageData, SpecialElementData};

fn svg_tree_of(dom: &DomHandle, sel: &str) -> Option<std::sync::Arc<usvg::Tree>> {
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {sel}");
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32))?;
    let elem = node.element_data()?;
    match elem.special_data() {
        SpecialElementData::Image(data) => match &**data {
            ImageData::Svg(svg) => Some(svg.tree.clone()),
            _ => None,
        },
        _ => None,
    }
}

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

const PAGE: &str = r##"<html><body>
    <div id="out">outside</div>
    <svg id="s" xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect id="r" width="100" height="100" fill="#ff0000"/>
    </svg>
</body></html>"##;

#[test]
fn attribute_mutation_inside_svg_updates_the_snapshot() {
    let dom = DomHandle::new(PAGE, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    assert_eq!(
        first_fill_rgb(&svg_tree_of(&dom, "#s").expect("initial parse")),
        Some((255, 0, 0)),
    );

    let rect_id = dom.query_selector("#r").unwrap();
    assert!(dom.set_attribute(rect_id as u32, "fill", "#008000"));
    dom.resolve_layout();

    assert_eq!(
        first_fill_rgb(&svg_tree_of(&dom, "#s").expect("post-mutation parse")),
        Some((0, 128, 0)),
        "snapshot froze at first paint after a child attribute mutation"
    );
}

#[test]
fn viewbox_mutation_on_the_root_updates_the_snapshot() {
    let dom = DomHandle::new(PAGE, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let svg_id = dom.query_selector("#s").unwrap();
    assert!(dom.set_attribute(svg_id as u32, "viewBox", "0 0 0 100"));
    dom.resolve_layout();

    let tree = svg_tree_of(&dom, "#s");
    let painted = tree.as_deref().and_then(first_fill_rgb);
    assert_eq!(
        painted, None,
        "root viewBox mutation was not re-serialized into the snapshot"
    );
}

#[test]
fn mutation_outside_the_svg_leaves_the_snapshot_untouched() {
    let dom = DomHandle::new(PAGE, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let before = svg_tree_of(&dom, "#s").expect("initial parse");

    let out_id = dom.query_selector("#out").unwrap();
    assert!(dom.set_attribute(out_id as u32, "class", "changed"));
    dom.resolve_layout();

    let after = svg_tree_of(&dom, "#s").expect("post-mutation parse");
    assert!(
        std::sync::Arc::ptr_eq(&before, &after),
        "unrelated mutation rebuilt the svg snapshot"
    );
}
