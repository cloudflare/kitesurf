// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
.target { background: #fff; }
.target:focus { background: #ffeeee; box-shadow: 0 0 2px 2px #cf7d7d; }
</style></head>
<body>
<input class="target" type="text" />
<button class="target">Click me</button>
</body></html>"##;

#[test]
fn input_matches_focus_after_set_focus_to() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();

    let input_id = dom.query_selector("input.target").expect("query parses");
    assert!(input_id > 0, "input.target must exist");
    let input_id = input_id as u32;

    let pre = dom
        .matches_in_subtree(input_id, ":focus")
        .expect("matches parses");
    assert!(!pre, "input must NOT match :focus before any focus call");

    let was_changed = dom.set_focus(input_id);
    assert!(
        was_changed,
        "set_focus on a fresh focus target should return true"
    );

    let post = dom
        .matches_in_subtree(input_id, ":focus")
        .expect("matches parses");
    assert!(
        post,
        "input must match :focus after set_focus({}); reproduces the \
         todomvc-react focus-ring bug",
        input_id,
    );
}

#[test]
fn focus_moves_between_elements() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();

    let input_id = dom.query_selector("input.target").unwrap() as u32;
    let button_id = dom.query_selector("button.target").unwrap() as u32;
    assert!(input_id != button_id);

    dom.set_focus(input_id);
    assert!(dom.matches_in_subtree(input_id, ":focus").unwrap());
    assert!(!dom.matches_in_subtree(button_id, ":focus").unwrap());

    dom.set_focus(button_id);
    assert!(
        !dom.matches_in_subtree(input_id, ":focus").unwrap(),
        "old focus target must lose :focus after focus moves"
    );
    assert!(
        dom.matches_in_subtree(button_id, ":focus").unwrap(),
        "new focus target must gain :focus"
    );
}

#[test]
fn clear_focus_removes_focus_match() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();

    let input_id = dom.query_selector("input.target").unwrap() as u32;
    dom.set_focus(input_id);
    assert!(dom.matches_in_subtree(input_id, ":focus").unwrap());

    dom.clear_focus();
    assert!(
        !dom.matches_in_subtree(input_id, ":focus").unwrap(),
        "clearFocus() must remove :focus from the previously focused element"
    );
}
