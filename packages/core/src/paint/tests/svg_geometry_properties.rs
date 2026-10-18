// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

fn paints(inner: &str) -> bool {
    let src = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
             <g stroke="red" stroke-width="100">{inner}</g>
           </svg>"#
    );
    let tree = blitz_dom::util::parse_svg_image(src.as_bytes())
        .expect("parse")
        .tree;
    path_count(&tree) > 0
}

fn path_count(tree: &usvg::Tree) -> usize {
    fn count(node: &usvg::Node) -> usize {
        match node {
            usvg::Node::Group(g) => g.children().iter().map(count).sum(),
            usvg::Node::Path(_) => 1,
            _ => 0,
        }
    }
    count(&usvg::Node::Group(Box::new(tree.root().clone())))
}

fn first_path_bbox(tree: &usvg::Tree) -> Option<(i32, i32, i32, i32)> {
    fn walk(node: &usvg::Node) -> Option<usvg::Rect> {
        match node {
            usvg::Node::Group(g) => g.children().iter().find_map(walk),
            usvg::Node::Path(p) => Some(p.bounding_box()),
            _ => None,
        }
    }
    walk(&usvg::Node::Group(Box::new(tree.root().clone()))).map(|r| {
        (
            r.x().round() as i32,
            r.y().round() as i32,
            r.width().round() as i32,
            r.height().round() as i32,
        )
    })
}

fn tree_of(src: &str) -> std::sync::Arc<usvg::Tree> {
    blitz_dom::util::parse_svg_image(src.as_bytes())
        .expect("parse")
        .tree
}

#[test]
fn shapes_with_invalid_geometry_are_not_rendered() {
    let cases: &[&str] = &[
        r#"<rect/>"#,
        r#"<rect width="10"/>"#,
        r#"<rect height="10"/>"#,
        r#"<rect width="10%"/>"#,
        r#"<rect height="10%"/>"#,
        r#"<rect width="0" height="10"/>"#,
        r#"<rect width="-10" height="10"/>"#,
        r#"<rect height="0" width="10"/>"#,
        r#"<rect height="-10" width="10"/>"#,
        r#"<rect style="width: 0"/>"#,
        r#"<rect style="width: 10px"/>"#,
        r#"<rect style="width: 10%"/>"#,
        r#"<rect style="width: calc(10%+10px)"/>"#,
        r#"<rect style="width: 0" height="10"/>"#,
        r#"<rect style="width: -10px"/>"#,
        r#"<rect style="width: -10px" height="10"/>"#,
        r#"<rect style="height: 0"/>"#,
        r#"<rect style="height: 10px"/>"#,
        r#"<rect style="height: 10%"/>"#,
        r#"<rect style="height: calc(10%+10px)"/>"#,
        r#"<rect style="height: 0" width="10"/>"#,
        r#"<rect style="height: -10px"/>"#,
        r#"<rect style="height: -10px" width="10"/>"#,
        r#"<rect style="width: calc(-10px); height: calc(-10px)"/>"#,
        r#"<circle/>"#,
        r#"<circle r="0"/>"#,
        r#"<circle r="-10"/>"#,
        r#"<circle style="r: 0"/>"#,
        r#"<circle style="r: -10px"/>"#,
        r#"<circle style="r: calc(-10px)"/>"#,
        r#"<ellipse/>"#,
        r#"<ellipse rx="0"/>"#,
        r#"<ellipse rx="0" ry="10"/>"#,
        r#"<ellipse ry="0"/>"#,
        r#"<ellipse ry="0" rx="10"/>"#,
        r#"<ellipse style="rx: 0"/>"#,
        r#"<ellipse style="rx: -10px"/>"#,
        r#"<ellipse style="rx: 0" ry="10"/>"#,
        r#"<ellipse style="ry: 0"/>"#,
        r#"<ellipse style="ry: -10px"/>"#,
        r#"<ellipse style="ry: 0" rx="10"/>"#,
        r#"<ellipse style="rx: calc(-10px); ry: calc(-10px)"/>"#,
    ];
    let painted: Vec<&str> = cases.iter().copied().filter(|c| paints(c)).collect();
    assert!(
        painted.is_empty(),
        "these shapes have invalid geometry and must not render: {painted:#?}"
    );
}

#[test]
fn geometry_properties_from_css_are_applied() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="340" height="140">
              <style>circle { cx: 204px; cy: 56px; r: 65px; fill: blue }</style>
              <circle/>
            </svg>"##,
    );
    assert_eq!(path_count(&tree), 1, "CSS-only circle did not render");
    assert_eq!(first_path_bbox(&tree), Some((139, -9, 130, 130)));
}

#[test]
fn geometry_properties_apply_from_a_style_attribute() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <rect style="x: 10px; y: 20px; width: 30px; height: 40px" fill="blue"/>
            </svg>"##,
    );
    assert_eq!(first_path_bbox(&tree), Some((10, 20, 30, 40)));
}

#[test]
fn geometry_properties_do_not_inherit() {
    assert!(
        !paints(r##"<g style="r: 40px"><circle cx="100" cy="100"/></g>"##),
        "r inherited from an ancestor group"
    );
    assert!(
        !paints(r##"<g style="width: 40px; height: 40px"><rect/></g>"##),
        "width/height inherited from an ancestor group"
    );
}

#[test]
fn unparseable_geometry_values_leave_the_shape_unrendered() {
    assert!(!paints(r##"<circle style="r: calc(10px * 10px)"/>"##));
    assert!(!paints(r##"<circle style="r: var(--radius)"/>"##));
}

#[test]
fn linear_calc_resolves_in_geometry_values() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="340" height="140">
              <style>circle { fill: blue; font-size: 40px }</style>
              <circle cx="calc(80px + 60% - 2em)" cy="calc(80px + 40% - 2em)" r="calc(5 * 5%)"/>
            </svg>"##,
    );
    assert_eq!(first_path_bbox(&tree), Some((139, -9, 130, 130)));
}

#[test]
fn calc_resolves_for_ellipse_rx_ry() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
              <ellipse cx="150" cy="100" rx="calc(4 * 25px)" ry="calc(100px / 2)" fill="blue"/>
            </svg>"##,
    );
    assert_eq!(first_path_bbox(&tree), Some((50, 50, 200, 100)));
}

#[test]
fn calc_in_css_geometry_declarations_resolves_too() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <style>circle { cx: calc(40px + 60px); cy: 100px; r: calc(2 * 25px); fill: blue }</style>
              <circle/>
            </svg>"##,
    );
    assert_eq!(first_path_bbox(&tree), Some((50, 50, 100, 100)));
}

#[test]
fn non_ascii_and_malformed_geometry_values_do_not_panic() {
    assert!(!paints(r##"<circle style="r: héllo"/>"##));
    assert!(!paints(r##"<circle r="ééééé"/>"##));
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 bogus 0 100">
              <rect width="100" height="100" fill="green"/></svg>"##,
    );
    assert!(
        path_count(&tree) > 0,
        "malformed viewBox wrongly disabled rendering"
    );
}
