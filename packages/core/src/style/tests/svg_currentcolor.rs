// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

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

#[test]
fn currentcolor_without_context_is_black() {
    let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="currentColor"/></svg>"#;
    let tree = blitz_dom::util::parse_svg_image(src).expect("parse").tree;
    assert_eq!(first_fill_rgb(&tree), Some((0, 0, 0)));
}

#[test]
fn root_color_attr_resolves_currentcolor() {
    let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" color="rgb(0,160,160)"><circle cx="50" cy="50" r="40" fill="currentColor"/></svg>"#;
    let tree = blitz_dom::util::parse_svg_image(src).expect("parse").tree;
    assert_eq!(first_fill_rgb(&tree), Some((0, 160, 160)));
}

#[test]
fn root_stamp_guard_scoped_to_opening_tag() {
    let root_tag_has_color = |svg: &str| {
        svg.split_once('>')
            .map(|(o, _)| o.contains(" color=\""))
            .unwrap_or(false)
    };
    assert!(!root_tag_has_color(
        r#"<svg width="24" viewBox="0 0 24 24"><g color="red"><path fill="currentColor"/></g></svg>"#
    ));
    assert!(root_tag_has_color(
        r#"<svg color="teal" width="24"><g/></svg>"#
    ));
}

#[test]
fn descendant_color_does_not_block_child_currentcolor() {
    let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" color="rgb(0,160,160)"><circle cx="50" cy="50" r="40" fill="currentColor"/><g color="rgb(200,0,0)"/></svg>"#;
    let tree = blitz_dom::util::parse_svg_image(src).expect("parse").tree;
    assert_eq!(first_fill_rgb(&tree), Some((0, 160, 160)));
}

#[test]
fn width_percent_falls_back_to_viewbox_size() {
    let src = br#"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="-10.5 -9.45 21 18.9"><circle cx="0" cy="0" r="2" fill="currentColor"/></svg>"#;
    let tree = blitz_dom::util::parse_svg_image(src).expect("parse").tree;
    let s = tree.size();
    assert_eq!(
        (s.width().round() as i32, s.height().round() as i32),
        (21, 19)
    );
}
