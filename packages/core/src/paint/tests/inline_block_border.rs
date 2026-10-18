// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Inline-block padding and borders must paint once, through the block path, not again as
//! inline decoration.

#![cfg(test)]

use crate::DomHandle;

#[test]
fn inline_block_anchor_emits_no_fragment_for_its_own_box() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
nav a.btn {
  display: inline-block;
  padding: 6px 10px;
  border: 1px solid #777;
  border-radius: 3px;
  text-decoration: none;
}
</style></head>
<body>
<nav>
<a class="btn" href="#">Download</a>
<a class="btn" href="#">View</a>
</nav>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!("=== inline-block anchor report ===\n{}", report);

    let bad_lines: Vec<&str> = report
        .lines()
        .filter(|l| l.contains("<a>") && !l.contains("0 fragment(s)"))
        .collect();

    assert!(
        bad_lines.is_empty(),
        "display:inline-block <a> should not emit a span fragment for itself; \
         got these <a>-with-fragment lines:\n{}\n\
         Full report:\n{}\n\
         If a fragment is emitted, the inline-span box-decoration painter \
         (target/vendor-patched/blitz-paint-0.3.0-alpha.2/src/text_box_decorations.rs) will draw a SECOND \
         border around the inner text rect, on top of the block-level \
         border at the border-box edge — the visible 'double border' bug. \
         Fix: ensure \
         target/vendor-patched/blitz-dom-0.3.0-alpha.2/src/stylo_to_parley.rs::extract_box_decorations \
         gates on `display.inside() == Flow` so inline-block / inline-flex / \
         inline-grid / inline-table all return empty decorations.",
        bad_lines.join("\n"),
        report,
    );
}

#[test]
fn true_inline_anchor_still_emits_fragment() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
p { padding: 0; }
a.pill {
  /* display: inline by default */
  padding: 3px 7px;
  border: 1px solid rgba(175, 47, 47, 0.4);
  border-radius: 3px;
  text-decoration: none;
}
</style></head>
<body>
<p>before <a class="pill" href="#">All</a> after</p>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!("=== true inline anchor report ===\n{}", report);

    let p_line = report
        .lines()
        .find(|l| l.contains("<p>") && l.contains("fragment(s)"))
        .expect("<p> should host an inline layout");
    eprintln!("p line: {}", p_line);
    assert!(
        !p_line.contains("0 fragment(s)"),
        "<p> containing an inline <a class=pill> with border should emit \
         exactly 1 fragment (for the <a>). Got: {}. \
         If this line says 0 fragment(s), the gate in \
         target/vendor-patched/blitz-dom-0.3.0-alpha.2/src/stylo_to_parley.rs::extract_box_decorations \
         was tightened too far — it should let `display: inline` (outside=Inline, \
         inside=Flow) through.",
        p_line,
    );
}

#[test]
fn inline_flex_anchor_emits_no_fragment_for_its_own_box() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
nav a.btn {
  display: inline-flex;
  padding: 6px 10px;
  border: 1px solid #777;
  text-decoration: none;
}
</style></head>
<body>
<nav>
<a class="btn" href="#">Hello</a>
</nav>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!("=== inline-flex anchor report ===\n{}", report);

    let bad_lines: Vec<&str> = report
        .lines()
        .filter(|l| l.contains("<a>") && !l.contains("0 fragment(s)"))
        .collect();
    assert!(
        bad_lines.is_empty(),
        "display:inline-flex <a> should not emit a span fragment for itself; \
         got:\n{}\nFull report:\n{}",
        bad_lines.join("\n"),
        report,
    );
}
