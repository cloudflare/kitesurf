// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const MOVER: &str = r#"<!DOCTYPE html><body style="margin:0">
<div id="m" style="position:absolute;left:100px;top:200px;width:60px;height:60px">
<div style="position:absolute;left:70px;top:20px;width:20px;height:20px"></div>
</div>"#;

#[test]
fn ink_rect_covers_descendants_and_follows_the_transform() {
    let dom = DomHandle::new(MOVER, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector("#m").unwrap() as u32;
    assert_eq!(dom.ink_rect(id), Some(vec![100.0, 200.0, 90.0, 60.0]));

    dom.set_attribute(
        id,
        "style",
        "position:absolute;left:100px;top:200px;width:60px;height:60px;transform:translateX(200px)",
    );
    dom.resolve_layout();
    assert_eq!(dom.ink_rect(id), Some(vec![300.0, 200.0, 90.0, 60.0]));
}

#[test]
fn ink_rect_covers_text_that_overflows_its_box() {
    let cases = [
        (
            "nowrap text wider than the box",
            r#"<div id="m" style="position:absolute;left:100px;top:100px;width:40px;height:40px;white-space:nowrap;font:40px sans-serif">MMMMMMMMMM</div>"#,
        ),
        (
            "wrapped text taller than the box",
            r#"<div id="m" style="position:absolute;left:100px;top:100px;width:40px;height:20px;font:20px sans-serif">MM MM MM MM MM MM MM MM</div>"#,
        ),
        (
            "a descendant's nowrap text",
            r#"<div id="m" style="position:absolute;left:100px;top:100px;width:40px;height:40px"><div style="white-space:nowrap;font:40px sans-serif">MMMMMMMMMM</div></div>"#,
        ),
    ];
    for (name, body) in cases {
        let html = format!(r#"<!DOCTYPE html><body style="margin:0">{body}"#);
        let dom = DomHandle::new(&html, "https://example.com/");
        dom.set_viewport(800, 600);
        dom.resolve_layout();
        let id = dom.query_selector("#m").unwrap() as u32;
        let r = dom.ink_rect(id).unwrap();
        assert_eq!((r[0], r[1]), (100.0, 100.0), "{name}: origin {r:?}");
        assert!(
            r[2] > 200.0 || r[3] > 100.0,
            "{name}: text extent missing {r:?}"
        );
    }

    let dom = DomHandle::new(
        r#"<!DOCTYPE html><body style="margin:0"><div id="m" style="position:absolute;left:500px;top:100px;width:40px;height:40px;direction:rtl;white-space:nowrap;font:40px sans-serif">MMMMMMMMMM</div>"#,
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let id = dom.query_selector("#m").unwrap() as u32;
    let r = dom.ink_rect(id).unwrap();
    assert!(r[0] < 300.0, "rtl: text extent missing on the left {r:?}");
    assert_eq!(
        r[0] + r[2],
        540.0,
        "rtl: rect runs past the box's right edge {r:?}"
    );
}

#[test]
fn pinned_rects_follow_the_page_scroll() {
    let rows = r#"<div style="height:3000px"></div>"#;
    let dom = DomHandle::new(
        &format!(
            r#"<!DOCTYPE html><body style="margin:0">
<div id="f" style="position:fixed;top:0;left:0;width:300px;height:40px"></div>
<div style="height:370px"></div>
<div id="s" style="position:sticky;top:50px;width:200px;height:20px"></div>{rows}"#
        ),
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let f = dom.query_selector("#f").unwrap() as f64;
    let s = dom.query_selector("#s").unwrap() as f64;
    assert_eq!(
        dom.pinned_rects(),
        Some(vec![f, 0.0, 0.0, 300.0, 40.0, s, 0.0, 370.0, 200.0, 20.0])
    );
    dom.set_page_scroll(0.0, 700.0);
    assert_eq!(
        dom.pinned_rects(),
        Some(vec![f, 0.0, 700.0, 300.0, 40.0, s, 0.0, 750.0, 200.0, 20.0])
    );

    let bg = DomHandle::new(
        r#"<!DOCTYPE html><body style="background:linear-gradient(red,blue) fixed"><p>x</p>"#,
        "https://example.com/",
    );
    bg.set_viewport(800, 600);
    bg.resolve_layout();
    assert_eq!(
        bg.pinned_rects(),
        None,
        "a fixed background cannot be shifted"
    );
}

fn pinned_rect_of(style: &str) -> Option<Vec<f64>> {
    pinned_rect_with("", style)
}

fn pinned_rect_with(sheet: &str, style: &str) -> Option<Vec<f64>> {
    let dom = DomHandle::new(
        &format!(
            r#"<!DOCTYPE html><style>{sheet}</style><body style="margin:0"><div style="height:200px"></div>
<div id="p" style="position:fixed;top:100px;left:100px;width:300px;height:40px;{style}"></div>"#
        ),
        "https://example.com/",
    );
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom.pinned_rects().map(|r| r[1..].to_vec())
}

#[test]
fn pinned_rects_cover_shadows_and_outlines() {
    assert_eq!(
        pinned_rect_of("box-shadow:0 4px 24px 2px black"),
        Some(vec![34.0, 34.0, 432.0, 172.0])
    );
    assert_eq!(
        pinned_rect_of("box-shadow:inset 0 0 40px black"),
        Some(vec![100.0, 100.0, 300.0, 40.0])
    );
    assert_eq!(
        pinned_rect_of("outline:10px solid red;outline-offset:6px"),
        Some(vec![84.0, 84.0, 332.0, 72.0])
    );
    assert_eq!(
        pinned_rect_of("filter:blur(4px)"),
        None,
        "a filter's reach is not modelled"
    );
}

#[test]
fn pinned_rects_cover_pseudo_element_shadows() {
    assert_eq!(
        pinned_rect_with(
            r#"#p::after{content:"";position:absolute;inset:0;box-shadow:0 0 20px 4px black}"#,
            ""
        ),
        Some(vec![46.0, 46.0, 408.0, 148.0])
    );
    assert_eq!(
        pinned_rect_with(
            r#"#p::before{content:"";position:absolute;inset:0;outline:10px solid red}"#,
            ""
        ),
        Some(vec![90.0, 90.0, 320.0, 60.0])
    );
}

#[test]
fn pinned_rects_scale_a_transformed_shadow() {
    assert_eq!(
        pinned_rect_of("transform:scale(3);box-shadow:0 0 12px 2px black"),
        Some(vec![-296.0, -36.0, 1092.0, 312.0])
    );
}
