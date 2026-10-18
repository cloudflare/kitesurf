// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use blitz_dom::util::apply_svg_view_fragment;

const VIEWS: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" viewBox="0 0 100 100">
  <view id="transform" viewBox="-100 -100 200 200"/>
  <view id="invalid" viewBox="0 0 -100 200"/>
  <rect width="100" height="100" fill="green"/>
</svg>"##;

#[test]
fn matched_view_overrides_the_root_viewbox() {
    let out = apply_svg_view_fragment(VIEWS, "transform").expect("must rewrite");
    let root = &out[..out.find('>').unwrap()];
    assert!(
        root.contains(r#"viewBox="-100 -100 200 200""#),
        "root: {root}"
    );
    assert!(
        !root.contains(r#"viewBox="0 0 100 100""#),
        "old viewBox kept: {root}"
    );
    let tree = blitz_dom::util::parse_svg_image(out.as_bytes())
        .expect("parse")
        .tree;
    assert_eq!(tree.size().width(), 100.0);
}

#[test]
fn unmatched_fragment_leaves_the_source_alone() {
    assert!(apply_svg_view_fragment(VIEWS, "nope").is_none());
    assert!(apply_svg_view_fragment(VIEWS, "").is_none());
}

#[test]
fn invalid_view_viewbox_falls_back_to_the_normal_view() {
    assert!(apply_svg_view_fragment(VIEWS, "invalid").is_none());
}

#[test]
fn view_without_viewbox_is_a_no_op() {
    let src = r##"<svg xmlns="http://www.w3.org/2000/svg"><view id="v"/><rect width="10" height="10"/></svg>"##;
    assert!(apply_svg_view_fragment(src, "v").is_none());
}

#[test]
fn view_preserveaspectratio_rides_along() {
    let src = r##"<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" viewBox="0 0 10 10">
      <view id="v" viewBox="0 0 4 2" preserveAspectRatio="none"/>
    </svg>"##;
    let out = apply_svg_view_fragment(src, "v").expect("must rewrite");
    let root = &out[..out.find('>').unwrap()];
    assert!(root.contains(r#"viewBox="0 0 4 2""#));
    assert!(root.contains(r#"preserveAspectRatio="none""#));
    assert!(!root.contains("xMidYMid"), "root kept its own PAR: {root}");
}

const STACK: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><style><![CDATA[svg>[id]{display:none}svg>[id]:target{display:inline}]]></style><rect id="a" width="10" height="10"/><rect id="b" x="20" width="10" height="10"/></svg>"##;

fn visible_children(src: &str) -> usize {
    blitz_dom::util::parse_svg_image(src.as_bytes())
        .expect("parse")
        .tree
        .root()
        .children()
        .len()
}

#[test]
fn target_fragment_shows_only_the_targeted_icon() {
    use blitz_dom::util::apply_svg_target_fragment;
    assert_eq!(visible_children(STACK), 0);
    let out = apply_svg_target_fragment(STACK, "b").expect("must rewrite");
    assert_eq!(visible_children(&out), 1, "rewritten: {out}");
    let tree = blitz_dom::util::parse_svg_image(out.as_bytes())
        .unwrap()
        .tree;
    let bbox = tree.root().abs_bounding_box();
    assert_eq!(
        (bbox.x(), bbox.width()),
        (20.0, 10.0),
        "icon #a shown instead of #b"
    );
}

#[test]
fn target_fragment_refuses_a_quote_breaking_id() {
    use blitz_dom::util::apply_svg_target_fragment;
    assert!(apply_svg_target_fragment(STACK, "b\"]{}").is_none());
    assert!(apply_svg_target_fragment(STACK, "").is_none());
    assert!(apply_svg_target_fragment(VIEWS, "transform").is_none());
}
