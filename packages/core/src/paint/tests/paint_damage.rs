// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Marked damage reads share blitz's one summary with the screencast's
//! partial frames: neither reader may take damage the other still needs.

#![cfg(test)]

use crate::DomHandle;

const STRIP: &str = r#"<!DOCTYPE html><style>.d{color:#333}.d.on{background:#c00;color:#fff}.d.hover{outline:2px solid #00c}</style>
<body><div><button id="mon" class="d on">Mon</button><button id="tue" class="d">Tue</button><button id="wed" class="d">Wed</button></div>"#;

fn strip() -> (DomHandle, u32, u32) {
    let dom = DomHandle::new(STRIP, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    dom.take_damage_summary();
    let mon = dom.query_selector("#mon").unwrap() as u32;
    let tue = dom.query_selector("#tue").unwrap() as u32;
    (dom, mon, tue)
}

fn marked_ids(json: &str) -> Vec<u32> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    v["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as u32)
        .collect()
}

fn screencast_ids(json: &str) -> Vec<u32> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    ["layout", "paint", "ink"]
        .iter()
        .flat_map(|k| {
            v[*k]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap() as u32)
        })
        .collect()
}

fn select(dom: &DomHandle, from: u32, to: u32) {
    dom.set_attribute(from, "class", "d");
    dom.set_attribute(to, "class", "d on");
    dom.resolve_layout();
}

#[test]
fn a_sibling_restyled_by_the_click_is_damage_outside_the_control() {
    let (dom, mon, tue) = strip();
    dom.paint_damage_mark();
    select(&dom, mon, tue);
    let ids = marked_ids(&dom.paint_damage_since(tue));
    assert!(ids.contains(&mon), "mon lost its highlight: {ids:?}");
    assert!(
        !ids.contains(&tue),
        "the clicked control's own restyle is not the page's: {ids:?}"
    );
}

#[test]
fn a_marked_read_leaves_the_screencast_its_damage() {
    let (dom, mon, tue) = strip();
    dom.paint_damage_mark();
    select(&dom, mon, tue);
    dom.paint_damage_since(tue);
    let ids = screencast_ids(&dom.take_damage_summary());
    assert!(
        ids.contains(&mon) && ids.contains(&tue),
        "the next partial frame must repaint both: {ids:?}"
    );
}

#[test]
fn a_screencast_take_leaves_the_marked_reader_its_damage() {
    let (dom, mon, tue) = strip();
    dom.paint_damage_mark();
    select(&dom, mon, tue);
    dom.take_damage_summary();
    assert!(marked_ids(&dom.paint_damage_since(tue)).contains(&mon));
}

#[test]
fn damage_before_the_mark_and_inside_the_control_is_not_the_clicks() {
    let (dom, mon, tue) = strip();
    select(&dom, mon, tue);
    dom.paint_damage_mark();
    dom.set_attribute(tue, "class", "d on hover");
    dom.resolve_layout();
    assert_eq!(marked_ids(&dom.paint_damage_since(tue)), Vec::<u32>::new());
}

#[test]
fn a_read_without_a_mark_reports_nothing() {
    let (dom, mon, tue) = strip();
    select(&dom, mon, tue);
    assert_eq!(dom.paint_damage_since(tue), "");
}
