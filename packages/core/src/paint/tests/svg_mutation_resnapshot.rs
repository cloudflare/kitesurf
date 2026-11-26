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

#[test]
fn stylesheet_fill_and_stroke_reach_inline_svg_snapshot() {
    let html = r##"<html><head><style>
        .logo rect { fill: #a31f34; stroke: #00ff00; }
    </style></head><body>
        <svg id="s" class="logo" width="40" height="40" viewBox="0 0 40 40">
            <rect x="0" y="0" width="40" height="40" fill="black"/>
        </svg>
    </body></html>"##;
    let dom = DomHandle::new(html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let tree = svg_tree_of(&dom, "#s").expect("inline svg must parse");
    assert_eq!(first_fill_rgb(&tree), Some((0xa3, 0x1f, 0x34)));
}

fn all_path_fills(tree: &usvg::Tree) -> Vec<Option<(u8, u8, u8)>> {
    fn walk(node: &usvg::Node, out: &mut Vec<Option<(u8, u8, u8)>>) {
        match node {
            usvg::Node::Group(g) => {
                for child in g.children() {
                    walk(child, out);
                }
            }
            usvg::Node::Path(p) => {
                let rgb = match p.fill().map(|f| f.paint()) {
                    Some(usvg::Paint::Color(c)) => Some((c.red, c.green, c.blue)),
                    _ => None,
                };
                out.push(rgb);
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&usvg::Node::Group(Box::new(tree.root().clone())), &mut out);
    out
}

#[test]
fn inherited_css_fill_does_not_override_child_fill_none_or_explicit_color() {
    // Case 1: `.icon { fill: currentColor; color: #dd0000 }` with a `<path fill="none">`
    // bounding box plus an unattributed glyph path.
    let html_none = r##"<html><head><style>
        .icon { fill: currentColor; color: #dd0000; }
    </style></head><body>
        <svg id="i" class="icon" width="96" height="96" viewBox="0 0 24 24">
            <path fill="none" d="M0 0h24v24H0z"/>
            <path d="M8 8h8v8H8z"/>
        </svg>
    </body></html>"##;
    let dom_none = DomHandle::new(html_none, "https://example.com/");
    dom_none.set_viewport(800, 600);
    dom_none.resolve_layout();
    let tree_none = svg_tree_of(&dom_none, "#i").expect("icon svg must parse");
    let fills_none = all_path_fills(&tree_none);
    // usvg omits invisible fill="none" paths or keeps fill() == None; either way
    // only the glyph path has red fill, never the fill="none" bounding box.
    assert!(
        fills_none.iter().filter(|f| f.is_some()).count() == 1,
        "only the glyph path should be filled, not fill=\"none\": {fills_none:?}"
    );
    assert_eq!(
        fills_none.into_iter().flatten().next(),
        Some((0xdd, 0x00, 0x00))
    );

    // Case 2: `svg { fill: #dd0000 }` with `<rect fill="#0000ff">`.
    let html_blue = r##"<html><head><style>
        svg { fill: #dd0000; }
    </style></head><body>
        <svg id="b" width="96" height="96" viewBox="0 0 96 96">
            <rect x="0" y="0" width="96" height="96" fill="#0000ff"/>
        </svg>
    </body></html>"##;
    let dom_blue = DomHandle::new(html_blue, "https://example.com/");
    dom_blue.set_viewport(800, 600);
    dom_blue.resolve_layout();
    let tree_blue = svg_tree_of(&dom_blue, "#b").expect("blue svg must parse");
    assert_eq!(
        first_fill_rgb(&tree_blue),
        Some((0x00, 0x00, 0xff)),
        "inherited svg CSS fill must not override child's own fill=\"#0000ff\" attribute"
    );
}

#[test]
fn inherited_css_fill_does_not_override_ancestor_group_or_use_fill() {
    // Case 1: `svg { fill: #dd0000 }` with `<g fill="#0000ff"><rect/></g>` paints a blue rect.
    let html_group_blue = r##"<html><head><style>
        svg { fill: #dd0000; }
    </style></head><body>
        <svg id="g1" width="96" height="96" viewBox="0 0 96 96">
            <g fill="#0000ff">
                <rect x="0" y="0" width="96" height="96"/>
            </g>
        </svg>
    </body></html>"##;
    let dom_blue = DomHandle::new(html_group_blue, "https://example.com/");
    dom_blue.set_viewport(800, 600);
    dom_blue.resolve_layout();
    let tree_blue = svg_tree_of(&dom_blue, "#g1").expect("group blue svg must parse");
    assert_eq!(
        first_fill_rgb(&tree_blue),
        Some((0x00, 0x00, 0xff)),
        "inherited svg CSS fill must not override ancestor <g fill=\"#0000ff\">"
    );

    // Case 2: `svg { fill: #dd0000 }` with `<g fill="none"><rect/></g>` paints no fill.
    let html_group_none = r##"<html><head><style>
        svg { fill: #dd0000; }
    </style></head><body>
        <svg id="g2" width="96" height="96" viewBox="0 0 96 96">
            <g fill="none">
                <rect x="0" y="0" width="96" height="96"/>
            </g>
        </svg>
    </body></html>"##;
    let dom_none = DomHandle::new(html_group_none, "https://example.com/");
    dom_none.set_viewport(800, 600);
    dom_none.resolve_layout();
    let tree_none = svg_tree_of(&dom_none, "#g2").expect("group none svg must parse");
    let fills_none = all_path_fills(&tree_none);
    assert!(
        fills_none.iter().all(|f| f.is_none()),
        "inherited svg CSS fill must not override ancestor <g fill=\"none\">: {fills_none:?}"
    );

    // Case 3: `<symbol>` used through `<use fill="#0000ff">` inherits the `<use>` color.
    let html_use = r##"<html><head><style>
        svg { fill: #dd0000; }
    </style></head><body>
        <svg id="u" width="96" height="96" viewBox="0 0 96 96">
            <defs><symbol id="sym"><rect x="0" y="0" width="96" height="96"/></symbol></defs>
            <use href="#sym" fill="#0000ff"/>
        </svg>
    </body></html>"##;
    let dom_use = DomHandle::new(html_use, "https://example.com/");
    dom_use.set_viewport(800, 600);
    dom_use.resolve_layout();
    let tree_use = svg_tree_of(&dom_use, "#u").expect("use svg must parse");
    assert_eq!(
        first_fill_rgb(&tree_use),
        Some((0x00, 0x00, 0xff)),
        "inherited svg CSS fill must not override <use fill=\"#0000ff\">"
    );
}

#[test]
fn deeply_nested_calc_in_picture_media_does_not_overflow_stack() {
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";
    let depth = 5_000;
    let media = format!(
        "(max-width: {}1px{})",
        "calc(".repeat(depth),
        ")".repeat(depth)
    );
    let html = format!(
        r#"<html><body><picture><source media="{media}" srcset="{png}"><img src="{png}"></picture></body></html>"#
    );
    let dom = DomHandle::new(&html, "https://example.com/");
    dom.resolve_layout();
}
