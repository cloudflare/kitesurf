// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Differential tests: lines broken from a `parley::BreakSummary` must match the lines parley
//! breaks from the shaped layout at the same width and indent.

use super::inline_eviction::{page, setup_with};
use crate::DomHandle;
use blitz_dom::BaseDocument;
use blitz_dom::node::TextBrush;
use parley::{BreakReason, BreakSummary, IndentOptions, Layout, SummaryLines};

const WIDTHS: [f32; 22] = [
    0.0, 0.5, 1.0, 3.0, 7.5, 12.0, 19.25, 31.0, 47.5, 64.0, 80.3, 100.0, 133.7, 171.0, 222.2,
    299.9, 384.0, 450.0, 517.0, 600.0, 911.0, 4000.0,
];

const fn indent(amount: f32, each_line: bool, hanging: bool) -> (f32, IndentOptions) {
    (amount, IndentOptions { each_line, hanging })
}

const INDENTS: [(f32, IndentOptions); 5] = [
    indent(0.0, false, false),
    indent(29.5, false, false),
    indent(-18.0, false, false),
    indent(24.0, true, false),
    indent(24.0, false, true),
];

const NO_INDENT: (f32, IndentOptions) = indent(0.0, false, false);

const SPAN_STYLES: [&str; 28] = [
    "white-space: pre-wrap",
    "vertical-align: bottom",
    "vertical-align: top; line-height: 3",
    "vertical-align: bottom; font-size: 30px; line-height: 1",
    "font-weight: bold",
    "font-style: italic",
    "font-size: 11px",
    "font-size: 23px",
    "letter-spacing: 1.3px",
    "letter-spacing: -0.4px",
    "word-spacing: 4.7px",
    "line-height: 2",
    "line-height: 9px",
    "line-height: normal",
    "vertical-align: super",
    "vertical-align: sub",
    "vertical-align: 3px",
    "padding: 0 5px; border: 1px solid",
    "white-space: nowrap",
    "white-space: pre",
    "white-space: pre-line",
    "overflow-wrap: anywhere",
    "word-break: break-all",
    "font-family: monospace",
    "vertical-align: top",
    "display: inline-block",
    "text-transform: uppercase",
    "font-variant: small-caps",
];

const PARAGRAPH_STYLES: [&str; 12] = [
    "",
    "white-space: pre-wrap",
    "white-space: pre-wrap; text-align: right",
    "text-align: justify",
    "line-height: 1.7",
    "white-space: pre-line",
    "white-space: pre",
    "direction: rtl",
    "font-size: 13.5px",
    "text-align: center; letter-spacing: 0.25px",
    "overflow-wrap: break-word",
    "font-family: monospace; line-height: 1.1",
];

const WORDS: [&str; 35] = [
    // Out-of-flow boxes, which land on a line without taking space on it.
    "<b style=\"position: absolute; right: 0\">abs</b>",
    "<i style=\"position: absolute; top: 3px\"></i>",
    "<span style=\"display: block; position: absolute\">block</span>",
    "   ",
    "spaces  \n",
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet,",
    "consectetur",
    "a",
    "I",
    "supercalifragilisticexpialidocious",
    "https://example.com/a/very/long/path/without/any/breaks",
    "שלום",
    "עולם",
    "مرحبا",
    "بالعالم",
    "Ελληνικά",
    "emoji😀",
    "co-operate",
    "a—b",
    "nbsp\u{a0}joined",
    "\n",
    "<br>",
    "x",
    "(parenthesised)",
    "quote’s",
    "1234567890",
    "end.",
    "  ",
    "fi ffl",
    "Ünïcödé",
    "trailing ",
];

/// A deterministic generator, so a failure names a reproducible paragraph.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as usize) % bound
    }
}

fn fuzz_page(paragraphs: usize) -> String {
    let mut rng = Lcg(0x5eed);
    let mut body = String::new();
    for i in 0..paragraphs {
        let style = PARAGRAPH_STYLES[rng.next(PARAGRAPH_STYLES.len())];
        body.push_str(&format!("<p id=f{i} style=\"{style}\">"));
        let mut open = 0;
        for _ in 0..(4 + rng.next(60)) {
            match rng.next(8) {
                0 if open < 3 => {
                    let span = SPAN_STYLES[rng.next(SPAN_STYLES.len())];
                    body.push_str(&format!("<span style=\"{span}\">"));
                    open += 1;
                }
                1 if open > 0 => {
                    body.push_str("</span>");
                    open -= 1;
                }
                _ => {}
            }
            body.push_str(WORDS[rng.next(WORDS.len())]);
            if rng.next(5) != 0 {
                body.push(' ');
            }
        }
        body.push_str(&"</span>".repeat(open));
        body.push_str("</p>");
    }
    format!(
        r#"<!DOCTYPE html><html><head><style>
  body {{ margin: 8px; width: 600px; font: 16px/1.25 serif; }}
</style></head><body>{body}
<p id=neg-a>{control}</p>
<p id=neg-b>{control}<span style="letter-spacing: 0.3px">{control}</span></p>
<p id=neg-c>{control}{control}</p>
</body></html>"#,
        control = "measured then laid out once more ".repeat(6),
    )
}

/// Paragraphs with out-of-flow boxes, preserved whitespace that hangs conditionally, and
/// `top`/`bottom` spans that size lines apart from the baseline-aligned content.
const TARGETED: [&str; 14] = [
    // Out-of-flow boxes first, between words, at breaks, after newlines and after the last one.
    "<p><i style=\"position: absolute\"></i>box first then words that wrap at narrow widths</p>",
    "<p>before <b style=\"position: absolute; right: 0\">a</b>after words that wrap across \
     lines<span style=\"position: absolute\"></span> at narrow widths <i \
     style=\"position: absolute\"></i>end<br><i style=\"position: absolute\"></i>next line</p>",
    "<p style=\"white-space: pre-wrap\">trailing   <i style=\"position: absolute\"></i>   \
     spaces then words\n<i style=\"position: absolute\"></i>after\n</p>",
    // A span that starts a word the line then breaks before.
    "<p>aaa bbb <span style=\"vertical-align: top; line-height: 60px\">tall</span>erword ccc \
     ddd <span style=\"vertical-align: bottom; line-height: 70px\">b</span>ottomword eee fff \
     <span style=\"vertical-align: top; line-height: 80px\">t</span>opword ggg</p>",
    "<p style=\"white-space: pre-wrap\">alpha beta   \ngamma delta    \nepsilon zeta eta   </p>",
    "<p style=\"white-space: pre-wrap; text-align: right\">words that wrap at narrow \
     widths     <br>after    </p>",
    "<p>collapsible then <span style=\"white-space: pre-wrap\">preserved   </span><br>more \
     <span style=\"white-space: pre-wrap\">kept  </span></p>",
    "<p style=\"white-space: pre-wrap\">lead   <span style=\"white-space: normal\">collapse \
     </span>   <br>tail  <span style=\"white-space: normal\"> </span></p>",
    "<p>text <span style=\"vertical-align: top; line-height: 3\">tall top</span> more text that \
     wraps across several lines at the narrower widths</p>",
    "<p>text <span style=\"vertical-align: bottom; font-size: 30px\">big bottom</span> more text \
     that wraps across several lines at the narrower widths</p>",
    "<p>both <span style=\"vertical-align: top; font-size: 8px; line-height: 40px\">t</span> and \
     <span style=\"vertical-align: bottom; line-height: 50px\">b</span> words that wrap</p>",
    "<p>sup inside top <span style=\"vertical-align: top; line-height: 2\">top <sup>sup</sup> \
     <span style=\"font-size: 30px\">big</span></span> and the rest of the words</p>",
    "<p>two tops <span style=\"vertical-align: top; line-height: 30px\">a</span> words \
     <span style=\"vertical-align: top; font-size: 25px\">b c d</span> after them</p>",
    "<p style=\"white-space: pre-line\">line\n<span style=\"vertical-align: bottom; \
     line-height: 40px\">bottom then break\n</span></p>",
];

fn load(html: &str) -> DomHandle {
    setup_with(html, None)
}

fn layouts(base: &BaseDocument) -> Vec<(String, Layout<TextBrush>)> {
    base.tree()
        .iter()
        .filter(|(_, node)| node.flags.is_in_document())
        .filter_map(|(id, node)| {
            let inline = node.element_data()?.inline_layout_data()?;
            let name = node
                .attr(blitz_dom::local_name!("id"))
                .map_or_else(|| format!("{id:?}"), str::to_owned);
            Some((name, inline.layout(base.tree()).clone()))
        })
        .collect()
}

/// The shaped layout broken again at `width`, as the breaker would break it.
fn rebreak(
    layout: &Layout<TextBrush>,
    width: f32,
    (amount, options): (f32, IndentOptions),
) -> Layout<TextBrush> {
    let mut layout = layout.clone();
    layout.set_text_indent(amount, options);
    layout.break_all_lines(Some(width));
    layout
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() <= 1e-4 * a.abs().max(b.abs()).max(1.0)
}

/// Compare everything inline layout reads from broken lines: breaks, heights,
/// baselines and the trailing empty line exactly; widths and advances up to the
/// summary's rounding.
fn compare_lines(shaped: &Layout<TextBrush>, replayed: &SummaryLines) -> Result<(), String> {
    if shaped.len() != replayed.lines().len() {
        return Err(format!(
            "{} lines, summary has {}",
            shaped.len(),
            replayed.lines().len()
        ));
    }
    if shaped.height() != replayed.height() {
        return Err(format!(
            "height {} vs summary {}",
            shaped.height(),
            replayed.height()
        ));
    }
    if !close(shaped.width(), replayed.width()) {
        return Err(format!(
            "width {} vs summary {}",
            shaped.width(),
            replayed.width()
        ));
    }
    let mut previous_reason = None;
    for (index, (line, summary_line)) in shaped.lines().zip(replayed.lines()).enumerate() {
        let metrics = line.metrics();
        let trailing_empty = previous_reason == Some(BreakReason::Explicit)
            && line.text_range().is_empty()
            && line.items().next().is_none();
        previous_reason = Some(line.break_reason());
        let same = line.break_reason() == summary_line.break_reason
            && metrics.line_height == summary_line.line_height
            && metrics.baseline == summary_line.baseline
            && metrics.block_min_coord == summary_line.block_min_coord
            && metrics.block_max_coord == summary_line.block_max_coord
            && trailing_empty == summary_line.is_trailing_empty
            && close(metrics.advance, summary_line.advance);
        if !same {
            return Err(format!(
                "line {index}: {:?} h={} base={} max={} adv={} empty={trailing_empty} \
                 vs summary {summary_line:?}",
                line.break_reason(),
                metrics.line_height,
                metrics.baseline,
                metrics.block_max_coord,
                metrics.advance,
            ));
        }
    }
    let box_lines = box_lines(shaped);
    if box_lines != replayed.box_lines() {
        return Err(format!(
            "box lines {box_lines:?} vs summary {:?}",
            replayed.box_lines()
        ));
    }
    Ok(())
}

/// The line each inline box is on, in the order of `Layout::inline_boxes`.
fn box_lines(layout: &Layout<TextBrush>) -> Vec<u32> {
    let ids: Vec<u64> = layout.inline_boxes().map(|ibox| ibox.id).collect();
    let mut lines = vec![u32::MAX; ids.len()];
    for (index, line) in layout.lines().enumerate() {
        for item in line.items() {
            if let parley::PositionedLayoutItem::InlineBox(ibox) = item {
                let at = ids
                    .iter()
                    .position(|&id| id == ibox.id)
                    .expect("a known box");
                lines[at] = u32::try_from(index).expect("few lines");
            }
        }
    }
    lines
}

#[derive(Default, Debug)]
struct Tally {
    roots: usize,
    summarized: usize,
    /// Summarized roots with out-of-flow boxes.
    with_boxes: usize,
    breaks: usize,
    ambiguous: usize,
}

fn check_page(html: &str) -> Tally {
    let dom = load(html);
    let doc = dom.doc.borrow();
    let mut tally = Tally::default();
    for (name, layout) in layouts(doc.as_ref()) {
        check_root(&name, &layout, &mut tally);
    }
    tally
}

/// Break one root at every width and indent, and its lines clamped to two.
fn check_root(name: &str, layout: &Layout<TextBrush>, tally: &mut Tally) {
    tally.roots += 1;
    let Some(summary) = layout.break_summary() else {
        return;
    };
    tally.summarized += 1;
    tally.with_boxes += usize::from(layout.inline_boxes().len() > 0);
    for width in WIDTHS {
        for indent in INDENTS {
            tally.breaks += 1;
            if !check_break(name, layout, &summary, width, indent) {
                tally.ambiguous += 1;
            }
        }
    }
}

/// Whether the summary broke the lines at this width and indent; the lines it
/// broke must match the shaped ones, clamped or not.
fn check_break(
    name: &str,
    layout: &Layout<TextBrush>,
    summary: &BreakSummary,
    width: f32,
    indent: (f32, IndentOptions),
) -> bool {
    let Some(mut replayed) = summary.break_lines(width, indent.0, indent.1) else {
        return false;
    };
    let mut shaped = rebreak(layout, width, indent);
    if let Err(err) = compare_lines(&shaped, &replayed) {
        panic!("{name} at width {width} indent {indent:?}: {err}");
    }
    shaped.truncate_lines(2);
    replayed.truncate_lines(2);
    assert_eq!(
        shaped.height(),
        replayed.height(),
        "{name} clamped at width {width} indent {indent:?}"
    );
    true
}

#[test]
fn summary_breaks_match_parley_on_the_fidelity_page() {
    let tally = check_page(&page(24));
    eprintln!("fidelity page: {tally:?}");
    assert!(
        tally.summarized * 2 >= tally.roots,
        "most fidelity roots should be summarized: {tally:?}"
    );
    assert!(
        tally.ambiguous * 10 <= tally.breaks,
        "few breaks should be ambiguous: {tally:?}"
    );
}

#[test]
fn summary_breaks_match_parley_on_fuzzed_paragraphs() {
    let tally = check_page(&fuzz_page(160));
    eprintln!("fuzzed paragraphs: {tally:?}");
    assert!(
        tally.summarized * 3 >= tally.roots,
        "many fuzzed roots should be summarized: {tally:?}"
    );
    assert!(
        tally.with_boxes >= 10,
        "fuzzed roots with out-of-flow boxes should be summarized: {tally:?}"
    );
    assert!(
        tally.ambiguous * 4 <= tally.breaks,
        "most breaks should not be ambiguous: {tally:?}"
    );
}

#[test]
fn summary_breaks_match_parley_with_conditional_hanging_and_top_bottom_spans() {
    let html = format!(
        "<!DOCTYPE html><html><head><style>body {{ margin: 8px; width: 600px; \
         font: 16px/1.25 serif; }}</style></head><body>{}</body></html>",
        TARGETED.concat()
    );
    let tally = check_page(&html);
    eprintln!("targeted paragraphs: {tally:?}");
    // The roots are the paragraphs and the boxes that hold text.
    assert_eq!(
        tally.summarized, tally.roots,
        "every targeted paragraph is summarized: {tally:?}"
    );
    assert_eq!(
        tally.with_boxes, 3,
        "the paragraphs with boxes are summarized: {tally:?}"
    );
    assert!(
        tally.ambiguous * 10 <= tally.breaks,
        "few breaks should be ambiguous: {tally:?}"
    );
}

/// The comparison must notice a summary of different text: one that is a few hundredths of a pixel
/// wider per character, or one that is the same text twice.
#[test]
fn a_summary_of_other_text_is_detected() {
    let dom = load(&fuzz_page(0));
    let doc = dom.doc.borrow();
    let all = layouts(doc.as_ref());
    let paragraph = |id: &str| {
        all.iter()
            .find(|(name, _)| name == id)
            .map(|(_, layout)| layout)
            .expect("control paragraph")
    };
    let summary = paragraph("neg-b")
        .break_summary()
        .expect("plain text is summarized");
    let (amount, options) = NO_INDENT;
    for other in ["neg-c", "neg-a"] {
        let mismatches = WIDTHS
            .iter()
            .filter(|&&width| {
                summary
                    .break_lines(width, amount, options)
                    .is_some_and(|replayed| {
                        compare_lines(&rebreak(paragraph(other), width, NO_INDENT), &replayed)
                            .is_err()
                    })
            })
            .count();
        assert!(
            mismatches > 0,
            "comparing the neg-b summary against {other} found no difference"
        );
    }
    // And the summary matches its own paragraph.
    for width in WIDTHS {
        if let Some(replayed) = summary.break_lines(width, amount, options) {
            compare_lines(&rebreak(paragraph("neg-b"), width, NO_INDENT), &replayed)
                .unwrap_or_else(|err| panic!("neg-b at {width}: {err}"));
        }
    }
}
