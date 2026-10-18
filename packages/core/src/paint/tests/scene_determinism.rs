// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const PAGE: &str = r#"<!doctype html>
<style>
  body { margin: 0; font: 16px serif; }
  .b { font-family: monospace; font-weight: 700; }
</style>
<p>the quick brown fox</p>
<p class="b">jumps over the lazy dog</p>
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAA/wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
"#;

fn render(dom: &DomHandle, scroll_y: i32) -> Vec<u8> {
    dom.render_scene(0, scroll_y, 0, 0, false, true)
}

#[test]
fn repeated_render_of_same_state_is_byte_identical() {
    let dom = DomHandle::new(PAGE, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let first = render(&dom, 0);
    assert!(!first.is_empty(), "scene should not be empty");
    for i in 0..6 {
        assert_eq!(
            first,
            render(&dom, 0),
            "scene bytes drifted on repeat render {i}"
        );
    }
}

#[test]
fn revisited_scroll_offset_reproduces_bytes() {
    let dom = DomHandle::new(PAGE, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let at_zero = render(&dom, 0);
    let at_fifty = render(&dom, 50);
    render(&dom, 120);

    assert_eq!(at_zero, render(&dom, 0), "scroll 0 not reproducible");
    assert_eq!(at_fifty, render(&dom, 50), "scroll 50 not reproducible");
}

#[test]
fn resource_entries_are_emitted_sorted_by_key() {
    let dom = DomHandle::new(PAGE, "https://example.test/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let scene = render(&dom, 0);

    let keys = resource_keys_by_kind(&scene);
    assert!(
        keys.iter().any(|(_, k)| k.len() > 1),
        "fixture produced no multi-entry resource table, so ordering is \
         untested; keys={keys:?}"
    );
    for (kind, k) in &keys {
        let mut sorted = k.clone();
        sorted.sort_unstable();
        assert_eq!(k, &sorted, "resource kind {kind} emitted out of order");
    }
}

fn resource_keys_by_kind(scene: &[u8]) -> Vec<(u8, Vec<u64>)> {
    let u32_at = |o: usize| u32::from_le_bytes(scene[o..o + 4].try_into().unwrap()) as usize;
    let offset = u32_at(28);
    if offset == 0 {
        return Vec::new();
    }

    let count = u32_at(offset);
    let mut pos = offset + 4;
    let mut out: Vec<(u8, Vec<u64>)> = Vec::new();
    for _ in 0..count {
        let hash = u64::from_le_bytes(scene[pos..pos + 8].try_into().unwrap());
        let kind = scene[pos + 16];
        let payload_len = u32_at(pos + 20);
        match out.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, keys)) => keys.push(hash),
            None => out.push((kind, vec![hash])),
        }
        pos += 24 + payload_len;
    }
    out
}
