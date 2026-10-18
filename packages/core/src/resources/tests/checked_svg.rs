// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::resources::net::decode_data_url;

const UNCHECKED_URL: &str = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2240%22%20height%3D%2240%22%20viewBox%3D%22-10%20-18%20100%20135%22%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2250%22%20fill%3D%22none%22%20stroke%3D%22%23949494%22%20stroke-width%3D%223%22/%3E%3C/svg%3E";

const CHECKED_URL: &str = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2240%22%20height%3D%2240%22%20viewBox%3D%22-10%20-18%20100%20135%22%3E%3Ccircle%20cx%3D%2250%22%20cy%3D%2250%22%20r%3D%2250%22%20fill%3D%22none%22%20stroke%3D%22%2359A193%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20fill%3D%22%233EA390%22%20d%3D%22M72%2025L42%2071%2027%2056l-4%204%2020%2020%2034-52z%22%2F%3E%3C%2Fsvg%3E";

#[test]
fn unchecked_svg_decodes_and_parses() {
    let bytes = decode_data_url(UNCHECKED_URL).expect("decode unchecked");
    let s = std::str::from_utf8(&bytes).expect("utf8");
    println!("UNCHECKED decoded ({} bytes):\n{}", bytes.len(), s);
    let tree = blitz_dom::util::parse_svg_image(&bytes)
        .expect("usvg parse unchecked")
        .tree;
    let size = tree.size();
    println!("UNCHECKED tree size: {}x{}", size.width(), size.height());
    assert!(size.width() > 0.0);
}

#[test]
fn checked_svg_decodes_and_parses() {
    let bytes = decode_data_url(CHECKED_URL).expect("decode checked");
    let s = std::str::from_utf8(&bytes).expect("utf8");
    println!("CHECKED decoded ({} bytes):\n{}", bytes.len(), s);
    let tree = blitz_dom::util::parse_svg_image(&bytes)
        .expect("usvg parse checked")
        .tree;
    let size = tree.size();
    println!("CHECKED tree size: {}x{}", size.width(), size.height());
    assert!(size.width() > 0.0);
}
