// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use std::collections::HashSet;

use crate::DomHandle;
use crate::paint::render::{RBI_ENCODED_IMAGE_BUDGET_BYTES, RBI_IMAGE_KEEP_RECORDS};

const SIDE: u32 = 512;
const FRAMES: u32 = 80;

fn encoded_bytes(dom: &DomHandle) -> usize {
    dom.rbi_image_cache
        .borrow()
        .values()
        .filter(|i| i.format == 1)
        .map(|i| i.wire_bytes.data().len())
        .sum()
}

fn noise(seed: u32) -> Vec<u8> {
    noise_of(SIDE, seed)
}

fn noise_of(side: u32, seed: u32) -> Vec<u8> {
    let mut s = seed.wrapping_mul(2_654_435_761) | 1;
    (0..side * side * 4)
        .map(|i| {
            if i % 4 == 3 {
                return 255;
            }
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as u8
        })
        .collect()
}

#[test]
fn raw_renderer_records_preserve_pixels_and_compressed_rbi_images() {
    let dom = DomHandle::new(
        "<!doctype html><body style=margin:0><canvas width=64 height=64></canvas>",
        "https://example.test/",
    );
    dom.set_viewport(64, 64);
    let canvas = dom.query_selector("canvas").unwrap() as u32;
    let pixels = noise_of(64, 42);
    assert!(dom.set_canvas_pixels(canvas, 64, 64, &pixels) >= 0);
    let image = |scene: Vec<u8>| {
        let header = crate::paint::scene_decode::parse_header(&scene).unwrap();
        let resources = crate::paint::scene_decode::parse_resources(&scene, &header).unwrap();
        let images: Vec<_> = resources
            .by_hash
            .into_values()
            .filter(|r| r.kind == crate::paint::scene_decode::ResourceKind::Image)
            .collect();
        assert_eq!(images.len(), 1);
        images.into_iter().next().unwrap()
    };
    let raw = image(dom.render_scene_raw(0, 0, 0, 0, false, false));
    assert_eq!(raw.format, 0);
    assert_eq!(raw.data, pixels);
    assert!(dom.rbi_image_cache.borrow().is_empty());

    let external = image(dom.render_scene(0, 0, 0, 0, false, true));
    assert_eq!(external.format, 1);
    assert_eq!(external.content_hash, raw.content_hash);
    assert!(external.data.is_empty());
    let encoded = dom.rbi_image_cache.borrow()[&raw.content_hash]
        .wire_bytes
        .data()
        .to_vec();
    assert_eq!(
        image::load_from_memory(&encoded)
            .unwrap()
            .to_rgba8()
            .as_raw(),
        &pixels,
    );

    let clip = image(dom.render_scene_clip_raw(0, 0, 32, 32, false, false));
    assert_eq!(clip.format, 0);
    assert_eq!(clip.data, pixels);
    assert_eq!(clip.content_hash, raw.content_hash);
    assert_eq!(
        dom.rbi_image_cache.borrow()[&raw.content_hash]
            .wire_bytes
            .data(),
        encoded,
    );
    let external_clip = image(dom.render_scene_clip(0, 0, 32, 32, false, true));
    assert_eq!(external_clip.format, 1);
    assert_eq!(external_clip.content_hash, raw.content_hash);
}

#[test]
fn canvas_frames_do_not_accumulate_encoded_images() {
    let html =
        format!("<!doctype html><body style=margin:0><canvas width={SIDE} height={SIDE}></canvas>");
    let dom = DomHandle::new(&html, "https://example.test/");
    dom.set_viewport(800, 600);
    let canvas = dom.query_selector("canvas").unwrap() as u32;
    let mut largest = 0;
    let mut peak = 0;
    let mut current = 0;
    for f in 0..FRAMES {
        assert!(dom.set_canvas_pixels(canvas, SIDE, SIDE, &noise(f)) >= 0);
        let before: HashSet<u64> = dom.rbi_image_cache.borrow().keys().copied().collect();
        assert!(!dom.render_scene(0, 0, 0, 0, false, false).is_empty());
        let cache = dom.rbi_image_cache.borrow();
        let fresh: Vec<u64> = cache
            .keys()
            .copied()
            .filter(|h| !before.contains(h))
            .collect();
        assert_eq!(fresh.len(), 1, "frame {f} recorded one new image");
        current = fresh[0];
        largest = largest.max(cache[&current].wire_bytes.data().len());
        drop(cache);
        assert!(dom.set_canvas_pixels(canvas, SIDE, SIDE, &noise(f + FRAMES)) >= 0);
        assert!(!dom.render_scene_clip(0, 0, 50, 50, false, false).is_empty());
        assert!(
            dom.rbi_image_cache.borrow().contains_key(&current),
            "frame {f}: an interleaved record evicted the image just recorded"
        );
        peak = peak.max(encoded_bytes(&dom));
    }
    assert!(
        largest * FRAMES as usize > 2 * RBI_ENCODED_IMAGE_BUDGET_BYTES,
        "fixture frames ({largest} B each) are too small to reach the budget"
    );
    let slack = largest * RBI_IMAGE_KEEP_RECORDS as usize;
    assert!(
        peak <= RBI_ENCODED_IMAGE_BUDGET_BYTES + slack,
        "encoded images peaked at {peak} B"
    );
    assert!(dom.rbi_image_cache.borrow().contains_key(&current));
}

const PDF_SIDE: u32 = 1024;

#[test]
fn a_pdf_record_keeps_its_images_through_the_next_record() {
    let html = format!(
        "<!doctype html><body style=margin:0><canvas width={PDF_SIDE} height={PDF_SIDE}></canvas>"
    );
    let dom = DomHandle::new(&html, "https://example.test/");
    dom.set_viewport(800, 600);
    let canvas = dom.query_selector("canvas").unwrap() as u32;
    let draw = |seed| {
        let pixels = noise_of(PDF_SIDE, seed);
        assert!(dom.set_canvas_pixels(canvas, PDF_SIDE, PDF_SIDE, &pixels) >= 0);
    };
    let warm_up = RBI_IMAGE_KEEP_RECORDS as u32;
    for f in 0..warm_up {
        draw(f);
        assert!(!dom.render_scene(0, 0, 0, 0, false, false).is_empty());
    }
    assert!(
        encoded_bytes(&dom) > RBI_ENCODED_IMAGE_BUDGET_BYTES,
        "fixture images are too small to reach the budget"
    );
    draw(warm_up);
    let before: HashSet<u64> = dom.rbi_image_cache.borrow().keys().copied().collect();
    assert!(!dom.record_pdf_scenes(800, 600, 0, 0, 0, 0).is_empty());
    let pdf_images: Vec<u64> = dom
        .rbi_image_cache
        .borrow()
        .keys()
        .copied()
        .filter(|h| !before.contains(h))
        .collect();
    assert_eq!(
        pdf_images.len(),
        1,
        "the PDF recorded the canvas as a new image"
    );
    draw(warm_up + 1);
    assert!(!dom.render_scene_clip(0, 0, 50, 50, false, false).is_empty());
    assert!(dom.rbi_image_cache.borrow().contains_key(&pdf_images[0]));
}
