// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use blitz_dom::util::parse_svg_image;

use crate::layout::geometry::svg_natural_dimensions;

fn dims(attrs: &str) -> (u32, u32) {
    let src = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" {attrs}></svg>"#);
    let svg = parse_svg_image(src.as_bytes()).expect("parse");
    let (w, h) = svg_natural_dimensions(
        svg.intrinsic_width(),
        svg.intrinsic_height(),
        svg.viewbox_aspect_ratio(),
    );
    (w.round().max(0.0) as u32, h.round().max(0.0) as u32)
}

#[test]
fn no_dimensions_defaults_to_300x150() {
    assert_eq!(dims(""), (300, 150));
    assert_eq!(dims(r#"width="400%" height="10%""#), (300, 150));
    assert_eq!(dims(r#"width="-400%" height="-10%""#), (300, 150));
}

#[test]
fn single_absolute_dimension_keeps_the_other_default() {
    assert_eq!(dims(r#"width="60""#), (60, 150));
    assert_eq!(dims(r#"height="60""#), (300, 60));
    assert_eq!(dims(r#"width="300""#), (300, 150));
    assert_eq!(dims(r#"height="150""#), (300, 150));
}

#[test]
fn zero_is_a_real_dimension_and_negative_is_absent() {
    assert_eq!(dims(r#"width="0""#), (0, 150));
    assert_eq!(dims(r#"height="0""#), (300, 0));
    assert_eq!(dims(r#"width="-5""#), (300, 150));
    assert_eq!(dims(r#"height="-5""#), (300, 150));
}

#[test]
fn view_box_ratio_derives_the_missing_axis() {
    assert_eq!(dims(r#"viewBox="0 0 600 200""#), (300, 100));
    assert_eq!(
        dims(r#"width="400%" height="10%" viewBox="0 0 600 200""#),
        (300, 100)
    );
    assert_eq!(dims(r#"width="60" viewBox="0 0 600 200""#), (60, 20));
    assert_eq!(dims(r#"height="60" viewBox="0 0 600 200""#), (180, 60));
    assert_eq!(dims(r#"width="0" viewBox="0 0 600 200""#), (0, 0));
    assert_eq!(dims(r#"height="0" viewBox="0 0 600 200""#), (0, 0));
    assert_eq!(dims(r#"width="-5" viewBox="0 0 600 200""#), (300, 100));
}

#[test]
fn narrow_ratio_contain_fits_the_default_object_size() {
    assert_eq!(dims(r#"viewBox="0 0 100 100""#), (150, 150));
    assert_eq!(dims(r#"viewBox="0 0 100 400""#), (38, 150));
}

#[test]
fn degenerate_view_box_is_ignored() {
    assert_eq!(dims(r#"viewBox="0 0 0 0""#), (300, 150));
    assert_eq!(dims(r#"viewBox="0 0 10 0""#), (300, 150));
    assert_eq!(dims(r#"viewBox="0 0 0 10""#), (300, 150));
    assert_eq!(dims(r#"width="60" viewBox="0 0 0 0""#), (60, 150));
    assert_eq!(dims(r#"height="60" viewBox="0 0 10 0""#), (300, 60));
}

#[test]
fn tolerates_xml_whitespace_around_root_attributes() {
    let src = "<svg xmlns=\"http://www.w3.org/2000/svg\"\n\twidth = '0'\n\theight\t= \"60\"></svg>";
    let svg = parse_svg_image(src.as_bytes()).expect("parse");
    let (w, h) = svg_natural_dimensions(
        svg.intrinsic_width(),
        svg.intrinsic_height(),
        svg.viewbox_aspect_ratio(),
    );
    assert_eq!((w.round() as u32, h.round() as u32), (0, 60));
}

#[test]
fn ignores_dimension_words_inside_other_attribute_values() {
    let src = "<svg xmlns=\"http://www.w3.org/2000/svg\" \
data-note=\" width=999 height=999 \" width='0' height='60'></svg>";
    let svg = parse_svg_image(src.as_bytes()).expect("parse");
    let (w, h) = svg_natural_dimensions(
        svg.intrinsic_width(),
        svg.intrinsic_height(),
        svg.viewbox_aspect_ratio(),
    );
    assert_eq!((w.round() as u32, h.round() as u32), (0, 60));
}

#[test]
fn both_attrs_win_over_view_box() {
    assert_eq!(dims(r#"width="60" height="40""#), (60, 40));
    assert_eq!(
        dims(r#"width="60" height="40" viewBox="0 0 600 200""#),
        (60, 40)
    );
    assert_eq!(
        dims(r#"width="0" height="0" viewBox="0 0 600 200""#),
        (0, 0)
    );
    assert_eq!(
        dims(r#"width="-5" height="-5" viewBox="0 0 600 200""#),
        (300, 100)
    );
    assert_eq!(dims(r#"width="300" viewBox="0 0 300 150""#), (300, 150));
}
