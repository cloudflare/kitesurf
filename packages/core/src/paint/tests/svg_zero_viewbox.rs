// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

fn tree_of(src: &str) -> std::sync::Arc<usvg::Tree> {
    blitz_dom::util::parse_svg_image(src.as_bytes())
        .expect("parse")
        .tree
}

fn painted_path_count(tree: &usvg::Tree) -> usize {
    fn count(node: &usvg::Node) -> usize {
        match node {
            usvg::Node::Group(g) => g.children().iter().map(count).sum(),
            usvg::Node::Path(p) => usize::from(p.fill().is_some() || p.stroke().is_some()),
            _ => 0,
        }
    }
    count(&usvg::Node::Group(Box::new(tree.root().clone())))
}

fn paints_fill(tree: &usvg::Tree, want: (u8, u8, u8)) -> bool {
    fn walk(node: &usvg::Node, want: (u8, u8, u8)) -> bool {
        match node {
            usvg::Node::Group(g) => g.children().iter().any(|c| walk(c, want)),
            usvg::Node::Path(p) => matches!(
                p.fill().map(|f| f.paint()),
                Some(usvg::Paint::Color(c)) if (c.red, c.green, c.blue) == want
            ),
            _ => false,
        }
    }
    walk(&usvg::Node::Group(Box::new(tree.root().clone())), want)
}

const GREEN: (u8, u8, u8) = (0, 128, 0);

#[test]
fn zero_viewbox_on_the_root_disables_rendering() {
    for vb in ["0 0 0 100", "0 0 100 0", "0 0 0 0", "0, 0, 0, 100"] {
        let tree = tree_of(&format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="{vb}">
                  <rect width="100" height="100" fill="green"/>
                </svg>"##
        ));
        assert_eq!(
            painted_path_count(&tree),
            0,
            "viewBox=\"{vb}\" still rendered content"
        );
    }
}

#[test]
fn repeated_comma_viewbox_is_ignored_instead_of_disabling_rendering() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0,,0,0,100">
              <rect width="100" height="100" fill="green"/>
            </svg>"##,
    );
    assert!(
        paints_fill(&tree, GREEN),
        "a malformed viewBox with repeated commas disabled rendering"
    );
}

#[test]
fn zero_viewbox_on_a_nested_svg_disables_only_that_subtree() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <svg viewBox="0 0 0 100" width="100" height="100">
                <rect width="100" height="100" fill="green"/>
              </svg>
              <rect x="100" width="100" height="100" fill="blue"/>
            </svg>"##,
    );
    assert!(
        !paints_fill(&tree, GREEN),
        "nested zero-viewBox content rendered"
    );
    assert!(
        paints_fill(&tree, (0, 0, 255)),
        "the sibling must still render"
    );
}

#[test]
fn zero_viewbox_on_a_symbol_disables_its_use() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <symbol id="s" viewBox="0 0 0 100"><rect width="100" height="100" fill="green"/></symbol>
              <use href="#s" x="0" y="0" width="200" height="200"/>
            </svg>"##,
    );
    assert!(!paints_fill(&tree, GREEN), "zero-viewBox symbol rendered");
}

#[test]
fn zero_viewbox_on_a_pattern_disables_the_fill() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <pattern id="p" viewBox="0 0 0 100" width="200" height="200" patternUnits="userSpaceOnUse">
                <rect width="100" height="100" fill="green"/>
              </pattern>
              <rect width="200" height="200" fill="url(#p)"/>
            </svg>"##,
    );
    assert!(
        !paints_fill(&tree, GREEN),
        "zero-viewBox pattern content rendered"
    );
    assert_eq!(
        painted_path_count(&tree),
        0,
        "the rect referencing the pattern still paints"
    );
}

#[test]
fn zero_viewbox_on_a_marker_keeps_the_stroke() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
              <defs>
                <marker id="m" viewBox="0 0 0 100" markerWidth="100" markerHeight="100" refX="0" refY="0" markerUnits="userSpaceOnUse">
                  <rect width="100" height="100" fill="green"/>
                </marker>
              </defs>
              <path d="M20,20 L180,20" stroke="black" stroke-width="1" fill="none" marker-start="url(#m)"/>
            </svg>"##,
    );
    assert!(!paints_fill(&tree, GREEN), "zero-viewBox marker rendered");
    assert_eq!(
        painted_path_count(&tree),
        1,
        "the stroked path itself must survive"
    );
}

#[test]
fn a_valid_viewbox_still_renders() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 100 100">
              <rect width="100" height="100" fill="green"/>
            </svg>"##,
    );
    assert!(
        paints_fill(&tree, GREEN),
        "a valid viewBox stopped rendering"
    );
}

#[test]
fn negative_viewbox_is_an_error_and_renders_the_normal_view() {
    let tree = tree_of(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 -100 100">
              <rect width="100" height="100" fill="green"/>
            </svg>"##,
    );
    assert!(
        paints_fill(&tree, GREEN),
        "negative viewBox wrongly disabled rendering"
    );
}
