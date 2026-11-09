// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

const DEEP_NESTING: usize = 8_000;
// A recursive walk of DEEP_NESTING levels overflows this stack, as it did the wasm one.
const SMALL_STACK_BYTES: usize = 512 * 1024;

fn id(dom: &DomHandle, selector: &str) -> u32 {
    let found = dom.query_selector(selector).ok().unwrap_or(-1);
    u32::try_from(found).unwrap_or_else(|_| panic!("{selector} not found"))
}

#[test]
fn lists_descendants_of_a_tree_deeper_than_the_call_stack() {
    let html = format!(
        "{}leaf{}",
        "<div>".repeat(DEEP_NESTING),
        "</div>".repeat(DEEP_NESTING)
    );
    // DomHandle is not Send, so it is built on the small-stack thread too.
    let count = std::thread::Builder::new()
        .stack_size(SMALL_STACK_BYTES)
        .spawn(move || {
            let dom = DomHandle::new(&html, "https://example.test/");
            let body = id(&dom, "body");
            dom.descendants_of(body).len()
        })
        .expect("spawn walker thread")
        .join()
        .expect("walker thread");

    // Every div plus the leaf text node.
    assert_eq!(count, DEEP_NESTING + 1);
}

#[test]
fn lists_descendants_in_document_order() {
    let dom = DomHandle::new(
        "<body><p id=a><b id=b></b><i id=c></i></p><span id=d></span></body>",
        "https://example.test/",
    );
    let expected: Vec<u32> = ["#a", "#b", "#c", "#d"]
        .iter()
        .map(|s| id(&dom, s))
        .collect();
    assert_eq!(dom.descendants_of(id(&dom, "body")), expected);
}
