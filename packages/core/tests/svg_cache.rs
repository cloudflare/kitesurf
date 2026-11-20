// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use std::sync::Arc;

#[test]
fn cache_shares_a_live_svg_tree() {
    let source = br#"<svg xmlns="http://www.w3.org/2000/svg" width="9" height="4"><rect width="2" height="1"/></svg>"#;
    let first = blitz_dom::util::parse_svg_image(source).expect("parse SVG");
    let second = blitz_dom::util::parse_svg_image(source).expect("parse SVG again");

    assert!(Arc::ptr_eq(&first.tree, &second.tree));
}

#[test]
fn svg_cache_does_not_keep_unused_trees_alive() {
    let source = br#"<svg xmlns="http://www.w3.org/2000/svg" width="7" height="3"><rect width="2" height="1"/></svg>"#;
    let image = blitz_dom::util::parse_svg_image(source).expect("parse SVG");
    let tree = Arc::downgrade(&image.tree);
    assert!(tree.upgrade().is_some(), "the parsed tree is live");

    drop(image);
    assert!(
        tree.upgrade().is_none(),
        "the cache retained the unused tree"
    );
}
