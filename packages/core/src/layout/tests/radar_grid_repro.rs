// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const FULL_PAGE: &str = include_str!("../../../tests_data/radar-page.html");

fn height(dom: &DomHandle, sel: &str) -> f32 {
    let id = dom.query_selector(sel).unwrap_or(-1);
    assert!(id > 0, "selector must match: {}", sel);
    let (_, _, _, h) = dom.test_get_inline_aware_rect(id as u32);
    h
}

fn rect(dom: &DomHandle, id: i32) -> (f32, f32, f32, f32) {
    dom.test_get_inline_aware_rect(id as u32)
}

#[test]
fn repeated_resolves_are_geometrically_stable_under_incremental_layout() {
    let measure = |inc: bool| {
        let dom = DomHandle::new(FULL_PAGE, "https://radar.cloudflare.com/");
        dom.set_viewport(1436, 900);
        dom.doc.borrow_mut().as_mut().set_incremental_layout(inc);
        (1..=3)
            .map(|_| {
                dom.resolve_layout();
                (
                    height(&dom, "main.radar-page"),
                    height(&dom, "article:has(.radar-xychart-svg)"),
                    height(&dom, "figure:has(.radar-xychart-svg)"),
                )
            })
            .collect::<Vec<_>>()
    };

    let base = measure(false);
    let inc = measure(true);
    assert_eq!(
        base[0], base[1],
        "non-incremental resolve is not idempotent"
    );
    assert_eq!(base, inc, "incremental layout changed the geometry");
    assert!(inc[0].0 > 2000.0, "page collapsed: {:?}", inc[0]);
}

#[test]
fn hoisted_fixed_boxes_survive_resolves_that_skip_their_parent() {
    let measure = |inc: bool| {
        let dom = DomHandle::new(FULL_PAGE, "https://radar.cloudflare.com/");
        dom.set_viewport(1436, 900);
        dom.doc.borrow_mut().as_mut().set_incremental_layout(inc);
        (1..=4)
            .map(|_| {
                dom.resolve_layout();
                height(&dom, "header.radar-header")
            })
            .collect::<Vec<_>>()
    };

    let base = measure(false);
    let inc = measure(true);
    assert!(
        base[0] > 0.0,
        "fixed header has no height even non-incrementally"
    );
    assert!(
        inc.iter().all(|&h| h > 0.0),
        "fixed header disappeared across resolves: {:?}",
        inc
    );
    assert_eq!(base, inc, "incremental layout changed the fixed header");
}

#[test]
fn radar_full_page_traffic_row_keeps_content_height() {
    let dom = DomHandle::new(FULL_PAGE, "https://radar.cloudflare.com/");
    dom.set_viewport(1436, 900);
    dom.resolve_layout();

    let main = height(&dom, "main.radar-page");
    let art = height(&dom, "article:has(.radar-xychart-svg)");
    let fig = height(&dom, "figure:has(.radar-xychart-svg)");
    println!("main={} article={} figure={}", main, art, fig);

    assert!(fig >= 229.0, "figure lost its min-height floor: {}", fig);
    assert!(art >= 350.0, "traffic article collapsed: h={}", art);
    assert!(main > 2000.0, "main did not floor at content: h={}", main);
}

#[test]
fn overview_side_rail_does_not_overlap_popularity_cards() {
    let dom = DomHandle::new(FULL_PAGE, "https://radar.cloudflare.com/");
    dom.set_viewport(1280, 900);
    dom.resolve_layout();

    let articles = dom
        .query_selector_all("article.radar-card-article")
        .unwrap();
    assert!(
        articles.len() > 11,
        "captured overview article count changed: {}",
        articles.len()
    );

    let internet_services = rect(&dom, articles[7]);
    let ddos_report = rect(&dom, articles[11]);
    assert!(
        internet_services.1 >= ddos_report.1 + ddos_report.3,
        "popularity card overlaps the side rail: popularity={:?} ddos={:?}",
        internet_services,
        ddos_report,
    );
}
