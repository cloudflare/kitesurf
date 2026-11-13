// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;
use blitz_dom::node::TextLayout;
use blitz_dom::{BaseDocument, NodeId};
use std::collections::HashSet;

const PARAGRAPH_KINDS: usize = 8;

/// A scan should keep the resident set to about a third of a long page's roots.
const RESIDENT_BOUND_DIVISOR: usize = 3;

/// The inner scroller cases scroll this far, in this many steps.
const SCROLLER_CONTENT_PX: f64 = 17_000.0;
const SCROLLER_STEPS: u32 = 8;

/// A tall page whose paragraphs cover the inputs a rebuild has to replay: inline
/// boxes, percentage indents, justification, line clamping, bidi, inside markers,
/// preserved tabs and forced breaks, and one paragraph wrapped around a float.
pub(super) fn page(paragraphs: usize) -> String {
    let mut body = String::new();
    for i in 0..paragraphs {
        let words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(3 + i % 5);
        let p = match i % PARAGRAPH_KINDS {
            0 => format!("<p id=p{i}>{words}<em>em {i}</em> <code>code</code> {words}</p>"),
            1 => format!(
                "<p id=p{i} class=indent>{words}<span class=ib></span> after the box \
                 <span id=s{i}>target span {i}</span> {words}</p>"
            ),
            2 => format!("<p id=p{i} class=clamp>{words}{words}{words}</p>"),
            3 => format!("<p id=p{i} dir=rtl>{words} <b>bold</b> {words}</p>"),
            4 => format!("<ul><li id=p{i} class=inside>{words}</li></ul>"),
            5 => format!("<pre id=p{i}>tab\there\tand\there<br>{words}</pre>"),
            6 => format!("<p id=p{i} class=right>{words}<sup>sup</sup> {words}</p>"),
            _ => format!("<p id=p{i} class=indent>{words}</p>"),
        };
        body.push_str(&p);
    }
    format!(
        r#"<!DOCTYPE html><html><head><style>
  body {{ margin: 8px; width: 600px; font: 16px/1.25 serif; }}
  .indent {{ text-indent: 7%; text-align: justify; }}
  .ib {{ display: inline-block; width: 37px; height: 23px; vertical-align: middle; }}
  .clamp {{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
            overflow: hidden; }}
  .inside {{ list-style-position: inside; }}
  .right {{ text-align: right; text-align-last: center; }}
  .float {{ float: left; width: 120px; height: 60px; }}
</style></head><body>
<div class=float></div><p id=floated>{}</p>
<div style="display: flex"><p id=flexed class=indent>{measured}</p></div>
<p id=fit style="display: inline-block; width: fit-content">{measured}</p>
<table><tr><td id=cell class=indent>{measured}<span style="white-space: pre">a   b</span></td>
<td>other cell</td></tr></table>
<div style="position: relative"><p id=abs style="position: absolute; width: fit-content">
{measured}</p></div>
{body}
</body></html>"#,
        "wrapped beside the float ".repeat(12),
        measured = "measured then laid out ".repeat(9),
    )
}

pub(super) fn setup_with(html: &str, eviction: Option<f32>) -> DomHandle {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc
        .borrow_mut()
        .as_mut()
        .set_inline_layout_eviction(eviction);
    dom.resolve_layout();
    dom
}

fn setup(eviction: Option<f32>, paragraphs: usize) -> DomHandle {
    setup_with(&page(paragraphs), eviction)
}

/// The same page loaded twice, first without eviction, then with it.
fn with_and_without_eviction(html: &str) -> (DomHandle, DomHandle) {
    (setup_with(html, None), setup_with(html, Some(2.0)))
}

fn inline_roots(base: &BaseDocument) -> Vec<NodeId> {
    base.tree()
        .iter()
        .filter(|(_, node)| {
            node.flags.is_in_document()
                && node
                    .element_data()
                    .is_some_and(|el| el.inline_layout_data().is_some())
        })
        .map(|(id, _)| id)
        .collect()
}

/// The shaped text of a node, if it has any.
fn inline_layout(base: &BaseDocument, id: NodeId) -> Option<&TextLayout> {
    base.tree()[id].element_data()?.inline_layout_data()
}

/// The shaped text of `id`, which the caller has filtered to inline roots.
fn inline_layout_of_root(base: &BaseDocument, id: NodeId) -> &TextLayout {
    inline_layout(base, id).expect("filtered to inline roots")
}

fn page_height(dom: &DomHandle) -> i32 {
    dom.doc
        .borrow()
        .as_ref()
        .root_element()
        .final_layout()
        .size
        .height as i32
}

/// Lines, glyph runs, inline boxes and span fragments of every inline root.
fn geometry(base: &BaseDocument) -> Vec<(NodeId, String)> {
    inline_roots(base)
        .into_iter()
        .map(|id| (id, geometry_of(base, id)))
        .collect()
}

fn geometry_of(base: &BaseDocument, id: NodeId) -> String {
    use parley::PositionedLayoutItem;
    use std::fmt::Write;
    let layout = inline_layout_of_root(base, id).layout(base.tree());
    let mut out = format!(
        "{} {} {} {:?}\n",
        layout.width(),
        layout.height(),
        layout.full_width(),
        layout.span_fragments()
    );
    for line in layout.lines() {
        writeln!(out, "{:?} {:?}", line.metrics(), line.text_range()).unwrap();
        for item in line.items() {
            match item {
                PositionedLayoutItem::GlyphRun(run) => {
                    let glyphs: Vec<_> = run.positioned_glyphs().collect();
                    writeln!(out, "  run {} {:?}", run.offset(), glyphs).unwrap();
                }
                PositionedLayoutItem::InlineBox(ibox) => {
                    writeln!(out, "  box {ibox:?}").unwrap();
                }
            }
        }
    }
    out
}

/// The geometry dump without `inline_max_coord`, the one field two roots can
/// differ in when their lines broke at widths that round apart.
fn geometry_without_max_coord(geometry: Vec<(NodeId, String)>) -> Vec<(NodeId, Vec<String>)> {
    geometry
        .into_iter()
        .map(|(id, dump)| {
            let lines = dump
                .lines()
                .map(|line| match line.find("inline_max_coord") {
                    Some(start) => {
                        let end = start + line[start..].find(',').unwrap_or(0);
                        format!("{}{}", &line[..start], &line[end..])
                    }
                    None => line.to_owned(),
                });
            (id, lines.collect::<Vec<_>>())
        })
        .collect()
}

fn is_evicted(dom: &DomHandle, id: &str) -> bool {
    let doc = dom.doc.borrow();
    let base = doc.as_ref();
    let id = base.get_element_by_id(id).expect("element exists");
    inline_layout(base, id).is_some_and(|inline| inline.is_evicted())
}

/// The inline roots of a document without eviction that have a break summary.
fn summarized_roots(dom: &DomHandle) -> HashSet<NodeId> {
    let doc = dom.doc.borrow();
    let base = doc.as_ref();
    inline_roots(base)
        .into_iter()
        .filter(|&id| {
            inline_layout(base, id)
                .is_some_and(|inline| inline.layout(base.tree()).break_summary().is_some())
        })
        .collect()
}

fn evicted_count(base: &BaseDocument) -> usize {
    inline_roots(base)
        .into_iter()
        .filter(|&id| inline_layout(base, id).is_some_and(|inline| inline.is_evicted()))
        .count()
}

fn evicted_root_count(dom: &DomHandle) -> usize {
    evicted_count(dom.doc.borrow().as_ref())
}

/// The scan spares layouts laid out or read since the last one, so evicting a
/// root that was just read takes two passes.
fn evict_after_grace(dom: &DomHandle) {
    for _ in 0..2 {
        dom.doc
            .borrow_mut()
            .as_mut()
            .evict_offscreen_inline_layouts();
    }
}

#[test]
fn rebuilt_layouts_reproduce_their_lines_and_glyphs() {
    let dom = setup(None, 24);
    let summarized = summarized_roots(&dom);
    let mut doc = dom.doc.borrow_mut();
    let base = doc.as_mut();
    let before = geometry(base);
    assert!(
        before.len() >= 24,
        "precondition: one inline root per paragraph"
    );
    assert!(
        summarized.len() > before.len() / 2 && summarized.len() < before.len(),
        "precondition: inline boxes and tabs leave some roots unsummarized"
    );

    let floated = base
        .get_element_by_id("floated")
        .expect("floated paragraph");
    for id in inline_roots(base) {
        assert_eq!(
            base.evict_inline_layout(id),
            id != floated && summarized.contains(&id),
            "only roots with a summary that floats did not shape evict ({id:?})"
        );
    }
    assert!(
        !base.evict_inline_layout(floated),
        "lines shaped by a float cannot be replayed without its block context"
    );

    let after = geometry(base);
    assert_eq!(
        evicted_count(base),
        0,
        "reading geometry rebuilds every layout"
    );
    assert_eq!(before.len(), after.len());
    for ((id, b), (_, a)) in before.iter().zip(&after) {
        assert_eq!(b, a, "inline root {id:?} rebuilt with different geometry");
    }
}

#[test]
fn offscreen_layouts_are_evicted_without_changing_paint_or_geometry() {
    let keep = setup(None, 120);
    let evict = setup(Some(2.0), 120);
    let total = inline_roots(evict.doc.borrow().as_ref()).len();
    let far = evicted_count(evict.doc.borrow().as_ref());
    assert!(
        far > total / 2,
        "a resolve at the top should evict most of a long page ({far} of {total})"
    );
    assert_eq!(evicted_count(keep.doc.borrow().as_ref()), 0);

    let height = page_height(&keep);
    assert!(
        is_evicted(&evict, "p119"),
        "precondition: the bottom starts evicted"
    );
    for scroll_y in [0, height / 3, height / 2, height - 600] {
        assert_eq!(
            keep.render_scene(0, scroll_y, 0, 0, false, true),
            evict.render_scene(0, scroll_y, 0, 0, false, true),
            "scene differs at scroll {scroll_y}"
        );
    }
    assert!(
        !is_evicted(&evict, "p119"),
        "painting the bottom rebuilds it"
    );
    assert!(
        is_evicted(&evict, "p0"),
        "scrolling to the bottom evicts the top"
    );
    assert!(
        !is_evicted(&evict, "p1"),
        "a root with an inline box has no summary, so stays shaped"
    );
    // Just painted, the bottom gets one scan of grace, then goes.
    evict.render_scene(0, 0, 0, 0, false, true);
    assert!(
        !is_evicted(&evict, "p119"),
        "a layout read since the last scan is spared once"
    );
    evict.render_scene(0, 0, 0, 0, false, true);
    assert!(
        is_evicted(&evict, "p119"),
        "scrolling back evicts the bottom again"
    );

    for i in (1..120).step_by(PARAGRAPH_KINDS * 3) {
        let span = format!("#s{i}");
        let a = keep.test_get_inline_aware_rect(keep.query_selector(&span).unwrap() as u32);
        let b = evict.test_get_inline_aware_rect(evict.query_selector(&span).unwrap() as u32);
        assert!(a.2 > 0.0, "precondition: {span} has a box");
        assert_eq!(a, b, "{span} geometry differs after eviction");
    }
}

/// Every in-document element's committed box.
fn boxes(base: &BaseDocument) -> Vec<(NodeId, String)> {
    base.tree()
        .iter()
        .filter(|(_, node)| node.flags.is_in_document() && node.element_data().is_some())
        .map(|(id, node)| (id, format!("{:?}", node.final_layout())))
        .collect()
}

/// Width changes lay evicted roots out from their break summaries without
/// reshaping them, and give the boxes, lines and paint of a document that
/// never evicted.
#[test]
fn width_changes_lay_out_evicted_roots_without_reshaping() {
    let html = page(120).replace("width: 600px;", "");
    let (keep, evict) = with_and_without_eviction(&html);
    let far = evicted_count(evict.doc.borrow().as_ref());
    assert!(
        far > 60,
        "precondition: most of the page is evicted ({far})"
    );

    for width in [530, 140, 700] {
        let stats = blitz_dom::node::inline_summary_stats();
        let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
        evict.set_viewport(width, 600);
        evict.resolve_layout();
        let after = blitz_dom::node::inline_summary_stats();
        let summarized = after.summarized - stats.summarized;
        let fallbacks = after.ambiguous - stats.ambiguous + after.unsummarized - stats.unsummarized;
        let rebuilt = blitz_dom::node::inline_layout_rebuild_count() - rebuilds;
        assert!(
            summarized as usize > far / 2,
            "most evicted roots break from their summary at {width}px ({summarized} of {far})"
        );
        assert_eq!(
            rebuilt, fallbacks,
            "only fallbacks reshape at {width}px ({summarized} summarized)"
        );

        keep.set_viewport(width, 600);
        keep.resolve_layout();
        assert_eq!(
            boxes(keep.doc.borrow().as_ref()),
            boxes(evict.doc.borrow().as_ref()),
            "boxes differ at {width}px"
        );
    }
    let height = page_height(&keep);
    for scroll_y in [0, height / 2, height - 600] {
        assert_eq!(
            keep.render_scene(0, scroll_y, 0, 0, false, true),
            evict.render_scene(0, scroll_y, 0, 0, false, true),
            "scene differs at scroll {scroll_y}"
        );
    }
    assert_eq!(
        geometry(keep.doc.borrow().as_ref()),
        geometry(evict.doc.borrow().as_ref()),
        "rebuilt roots have the lines of the last width"
    );
}

/// The fidelity page plus paragraphs holding absolutely positioned boxes whose
/// static position comes from their line.
fn annotated_page() -> String {
    let words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4);
    let annotated: String = (0..40)
        .map(|i| {
            format!(
                "<p id=o{i} class=rel><a class=self href=#o{i}>§</a>{words}\
                 <span class=anno>note {i}</span>{words}<b class=pin></b> end</p>"
            )
        })
        .collect();
    page(120)
        .replace("width: 600px;", "")
        .replace(
            "</style>",
            ".rel { position: relative; }\n\
             .anno { position: absolute; display: block; right: 0.3em; }\n\
             .self { position: absolute; top: 0; left: -2.5em; }\n\
             .pin { position: absolute; right: 4px; top: auto; width: 3px; height: 3px; }\n</style>",
        )
        .replace(
            "</body>",
            &format!("{annotated}<p id=static>{words}<i class=static>s</i>{words}</p></body>"),
        )
}

/// Roots holding absolutely positioned boxes whose static position needs
/// only their line (block-level, or with a horizontal inset) are evicted and
/// laid out from their summaries, placing the boxes as a live layout does.
#[test]
fn width_changes_place_absolute_boxes_of_evicted_roots() {
    let (keep, evict) = with_and_without_eviction(&annotated_page());
    assert!(
        is_evicted(&evict, "o39"),
        "a root with placeable boxes evicts"
    );
    for width in [530, 140, 700] {
        let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
        evict.set_viewport(width, 600);
        evict.resolve_layout();
        let rebuilt = blitz_dom::node::inline_layout_rebuild_count() - rebuilds;
        assert!(
            is_evicted(&evict, "o39"),
            "the root stays evicted at {width}px"
        );
        assert_eq!(rebuilt, 0, "evicted roots were rebuilt at {width}px");
        keep.set_viewport(width, 600);
        keep.resolve_layout();
        assert_eq!(
            boxes(keep.doc.borrow().as_ref()),
            boxes(evict.doc.borrow().as_ref()),
            "boxes differ at {width}px"
        );
    }
    let height = page_height(&keep);
    assert_eq!(
        keep.render_scene(0, height - 600, 0, 0, false, true),
        evict.render_scene(0, height - 600, 0, 0, false, true),
        "scene differs at the bottom"
    );
}

/// Roots with absolutely positioned boxes at their static inline position, at four
/// alignment inputs: an IDL pre block, plain, RTL and centred text.
fn static_offset_page() -> String {
    let words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4);
    let statics: String = (0..40)
        .map(|i| match i % 4 {
            0 => format!(
                "<pre id=st{i}><code class=idl>interface I{i} {{\n  attribute long a;\n}};</code></pre>"
            ),
            1 => format!("<p id=st{i}>{words}<i class=static>s</i>{words}</p>"),
            2 => format!("<p id=st{i} dir=rtl>{words}<i class=static>s</i> {words}</p>"),
            _ => format!("<p id=st{i} class=center>{words}<i class=static>s</i>{words}</p>"),
        })
        .collect();
    page(120)
        .replace("width: 600px;", "")
        .replace(
            "</style>",
            "pre, p { position: relative; }\n\
             code.idl::before { content: 'IDL'; position: absolute; top: auto; \
             margin: -0.7em 0 0 -3.75em; width: 1.5em; }\n\
             .static { position: absolute; }\n\
             .center { text-align: center; }\n</style>",
        )
        .replace("</body>", &format!("{statics}</body>"))
}

/// The far roots of `static_offset_page` that the scan evicts at the top.
const FAR_STATIC_ROOTS: [&str; 4] = ["st36", "st37", "st38", "st39"];

/// The fixture laid out twice: once with eviction off, once evicting far roots.
fn static_offset_pair() -> (DomHandle, DomHandle) {
    let html = static_offset_page();
    (setup_with(&html, None), setup_with(&html, Some(2.0)))
}

/// Dirties `roots` on both documents, so the next resolve re-collects them.
fn dirty_roots(keep: &DomHandle, evict: &DomHandle, roots: &[&str]) {
    for dom in [keep, evict] {
        for id in roots {
            let root = dom.query_selector(&format!("#{id}")).unwrap() as u32;
            assert!(dom.set_attribute(root, "style", "padding-bottom: 1px"));
        }
    }
}

/// Roots holding absolutely positioned boxes at their static inline position
/// evict with each box's offset along its line.
#[test]
fn evicted_roots_place_boxes_at_their_static_inline_position() {
    let (keep, evict) = static_offset_pair();
    for id in FAR_STATIC_ROOTS {
        assert!(
            is_evicted(&evict, id),
            "{id} evicts with its static offsets"
        );
    }
    assert_eq!(
        boxes(keep.doc.borrow().as_ref()),
        boxes(evict.doc.borrow().as_ref()),
        "boxes differ before any relayout"
    );
}

/// A pass with the inputs those lines were aligned with places the boxes from
/// the recorded offsets instead of rebuilding them.
#[test]
fn same_width_relayout_places_static_boxes_from_recorded_offsets() {
    let (keep, evict) = static_offset_pair();
    dirty_roots(&keep, &evict, &FAR_STATIC_ROOTS);

    let stats = blitz_dom::node::inline_summary_stats();
    let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
    evict.resolve_layout();
    keep.resolve_layout();
    assert!(
        blitz_dom::node::inline_summary_stats().summarized - stats.summarized
            >= FAR_STATIC_ROOTS.len() as _,
        "the dirtied roots break from their summaries"
    );
    assert_eq!(
        blitz_dom::node::inline_layout_rebuild_count() - rebuilds,
        0,
        "unchanged alignment inputs reuse the recorded offsets"
    );
    for id in FAR_STATIC_ROOTS {
        assert!(is_evicted(&evict, id), "{id} stays evicted");
    }
    assert_eq!(
        boxes(keep.doc.borrow().as_ref()),
        boxes(evict.doc.borrow().as_ref()),
        "boxes differ after a same-width relayout"
    );
}

/// New alignment inputs rebuild the roots that need their static offsets.
#[test]
fn new_alignment_inputs_rebuild_static_box_offsets() {
    let (keep, evict) = static_offset_pair();
    for width in [530, 140, 700] {
        let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
        evict.set_viewport(width, 600);
        evict.resolve_layout();
        assert!(
            blitz_dom::node::inline_layout_rebuild_count() > rebuilds,
            "new alignment inputs rebuild roots that need static offsets at {width}px"
        );
        keep.set_viewport(width, 600);
        keep.resolve_layout();
        assert_eq!(
            boxes(keep.doc.borrow().as_ref()),
            boxes(evict.doc.borrow().as_ref()),
            "boxes differ at {width}px"
        );
    }
    let height = keep
        .doc
        .borrow()
        .as_ref()
        .root_element()
        .final_layout()
        .size
        .height as i32;
    assert_eq!(
        keep.render_scene(0, height - 600, 0, 0, false, true),
        evict.render_scene(0, height - 600, 0, 0, false, true),
        "scene differs at the bottom"
    );
}

/// A page of fractional-width table cells, whose content slots round.
fn rounded_cell_page() -> String {
    let mut body = String::new();
    for i in 0..160 {
        let pad = 3.37 + (i % 7) as f32 * 1.13;
        body.push_str(&format!(
            "<table style=\"border-spacing: 1.3px; width: {:.2}%\"><tr>\
             <td style=\"padding: 0 {pad}px\">{}</td><td>{}</td><td>cell {i}</td></tr></table>",
            61.7 + (i % 9) as f32 * 3.9,
            "words that wrap in a cell ".repeat(1 + i % 4),
            "more words ".repeat(2 + i % 3),
        ));
    }
    format!(
        "<!DOCTYPE html><html><head><style>body {{ margin: 7.7px; font: 16px/1.25 serif; }}\
         </style></head><body><div style=\"display: flow-root; padding: 0 1.9px\">{body}</div>\
         </body></html>"
    )
}

/// Table cells with fractional widths have content slots that differ from
/// their content width by rounding. That is no float, so the cells still
/// break from their summaries, and their lines match a document that never
/// evicted.
#[test]
fn rounded_content_slots_do_not_count_as_floats() {
    let (keep, evict) = with_and_without_eviction(&rounded_cell_page());
    for width in [613, 800] {
        let stats = blitz_dom::node::inline_summary_stats();
        evict.set_viewport(width, 600);
        evict.resolve_layout();
        let after = blitz_dom::node::inline_summary_stats();
        assert_eq!(
            after.unsummarized - stats.unsummarized,
            0,
            "every evicted root breaks from its summary at {width}px ({} summarized)",
            after.summarized - stats.summarized
        );
        keep.set_viewport(width, 600);
        keep.resolve_layout();
        assert_eq!(
            boxes(keep.doc.borrow().as_ref()),
            boxes(evict.doc.borrow().as_ref()),
            "boxes differ at {width}px"
        );
    }
    // Taffy re-measures a cell at the slot's rounded width and serves its
    // layout from cache, so a live root keeps lines broken at that width while
    // a rebuilt one replays the committed width: their lines end at a
    // different line max advance, and nowhere else.
    assert_eq!(
        geometry_without_max_coord(geometry(keep.doc.borrow().as_ref())),
        geometry_without_max_coord(geometry(evict.doc.borrow().as_ref()))
    );
}

fn summary_heap_size(base: &BaseDocument) -> usize {
    inline_roots(base)
        .into_iter()
        .filter_map(|id| inline_layout(base, id))
        .map(|inline| inline.break_summary_heap_size())
        .sum()
}

/// A rebuilt root's live layout makes its break summary redundant, so the
/// rebuild drops it, and evicting the root again summarizes it afresh.
#[test]
fn rebuilding_an_evicted_root_drops_its_summary() {
    let dom = setup(Some(2.0), 120);
    let evicted = summary_heap_size(dom.doc.borrow().as_ref());
    assert!(evicted > 0, "precondition: evicted roots keep summaries");

    let before = geometry(dom.doc.borrow().as_ref());
    assert_eq!(
        summary_heap_size(dom.doc.borrow().as_ref()),
        0,
        "reading every root rebuilt it and dropped its summary"
    );

    // The first scan spares layouts read since the last one; the next evicts them.
    evict_after_grace(&dom);
    assert_eq!(summary_heap_size(dom.doc.borrow().as_ref()), evicted);
    assert_eq!(geometry(dom.doc.borrow().as_ref()), before);
}

#[test]
fn editing_an_evicted_paragraph_lays_out_the_new_text() {
    let keep = setup(None, 120);
    let evict = setup(Some(2.0), 120);
    let edit = |dom: &DomHandle| {
        let p = dom.query_selector("#p119").unwrap() as u32;
        let text = dom.child_ids(p)[0];
        assert!(dom.set_node_text(text, &"replacement words ".repeat(40)));
        dom.resolve_layout();
        dom.test_bounding_rect(p)
    };
    assert!(
        is_evicted(&evict, "p119"),
        "precondition: the last paragraph is evicted"
    );
    assert_eq!(edit(&keep), edit(&evict));
    assert_eq!(
        geometry(keep.doc.borrow().as_ref()),
        geometry(evict.doc.borrow().as_ref())
    );
}

fn text_and_ranges(base: &BaseDocument) -> Vec<(NodeId, String, String)> {
    inline_roots(base)
        .into_iter()
        .map(|id| {
            let inline = inline_layout_of_root(base, id);
            (
                id,
                inline.text(base.tree()).to_owned(),
                format!("{:?}", inline.node_ranges(base.tree())),
            )
        })
        .collect()
}

/// The first pass shapes each root in its layout call, keeps the ones near the
/// viewport for the first paint and evicts the rest, with or without the pass
/// outgrowing its window of recently laid out roots.
fn assert_first_pass_keeps_roots_near_the_viewport(paragraphs: usize) {
    let keep = setup(None, paragraphs);
    let shaped_before = blitz_dom::node::inline_layout_rebuild_count();
    let evict = setup(Some(2.0), paragraphs);
    let shaped = blitz_dom::node::inline_layout_rebuild_count() - shaped_before;
    let total = inline_roots(evict.doc.borrow().as_ref()).len();
    assert_eq!(evicted_root_count(&keep), 0, "precondition: eager shaping");
    assert!(
        shaped as usize >= total,
        "construction leaves roots unshaped for layout to shape ({shaped} of {total})"
    );
    assert!(!is_evicted(&evict, "p0"), "the first paint needs p0 shaped");
    let last = format!("p{}", paragraphs - 1);
    assert!(is_evicted(&evict, &last), "far roots are evicted");
    assert!(
        !is_evicted(&evict, "floated"),
        "lines shaped by a float stay live"
    );
    // The layout call that first builds a root also fills its text and ranges.
    assert_eq!(
        text_and_ranges(keep.doc.borrow().as_ref()),
        text_and_ranges(evict.doc.borrow().as_ref())
    );
    let before_paint = blitz_dom::node::inline_layout_rebuild_count();
    assert_eq!(
        keep.render_scene(0, 0, 0, 0, false, true),
        evict.render_scene(0, 0, 0, 0, false, true),
        "the first paint matches eager shaping"
    );
    assert_eq!(
        blitz_dom::node::inline_layout_rebuild_count(),
        before_paint,
        "the first paint reshapes nothing"
    );
}

#[test]
fn the_first_pass_keeps_only_roots_near_the_viewport() {
    assert_first_pass_keeps_roots_near_the_viewport(120);
    let keep = setup(None, 120);
    let evict = setup(Some(2.0), 120);
    assert_eq!(
        geometry(keep.doc.borrow().as_ref()),
        geometry(evict.doc.borrow().as_ref())
    );
}

#[test]
fn a_first_pass_longer_than_its_window_keeps_only_roots_near_the_viewport() {
    assert_first_pass_keeps_roots_near_the_viewport(2600);
}

/// A flex item is measured before it is laid out. Roots its measure broke
/// leave the pass window as laid out ones do, so the final layout breaks the
/// far ones from their summaries instead of the whole subtree staying shaped.
#[test]
fn a_flex_measure_evicts_roots_before_the_final_layout() {
    let html = page(2600)
        .replacen(
            "<body>",
            "<body><div style=\"display: flex\"><div style=\"flex: 1 1 66%; overflow: hidden\">",
            1,
        )
        .replacen("</body>", "</div></div></body>", 1);
    let keep = setup_with(&html, None);
    let before = blitz_dom::node::inline_summary_stats().summarized;
    let evict = setup_with(&html, Some(2.0));
    let summarized = blitz_dom::node::inline_summary_stats().summarized - before;
    assert!(
        summarized > 0,
        "the final layout reuses no summary, so the measure kept every root shaped"
    );
    assert_eq!(
        geometry(keep.doc.borrow().as_ref()),
        geometry(evict.doc.borrow().as_ref())
    );
    assert_eq!(
        keep.render_scene(0, 0, 0, 0, false, true),
        evict.render_scene(0, 0, 0, 0, false, true),
        "the first paint matches eager shaping"
    );
}

#[test]
fn the_eviction_scan_visits_only_resident_roots() {
    let summarized = summarized_roots(&setup(None, 240));
    let dom = setup(Some(2.0), 240);
    let total = inline_roots(dom.doc.borrow().as_ref()).len();
    let height = page_height(&dom);
    for step in 0..=8 {
        dom.render_scene(0, (height - 600) * step / 8, 0, 0, false, true);
        let doc = dom.doc.borrow();
        let base = doc.as_ref();
        // Roots that cannot replay or have no break summary are never
        // evicted, so need no visits.
        let live = inline_roots(base)
            .into_iter()
            .filter(|&id| {
                inline_layout(base, id)
                    .is_some_and(|inline| inline.replayable_break && !inline.is_evicted())
                    && summarized.contains(&id)
            })
            .count();
        let resident = base.inline_resident_count();
        assert!(
            resident >= live,
            "every live root must be resident ({resident} < {live})"
        );
        assert!(
            resident < total / RESIDENT_BOUND_DIVISOR,
            "the resident set should stay near the viewport ({resident} of {total})"
        );
    }
}

#[test]
fn reads_during_a_follow_up_scan_are_eventually_evicted() {
    let dom = setup(Some(2.0), 120);
    let scan = || {
        dom.doc
            .borrow_mut()
            .as_mut()
            .evict_offscreen_inline_layouts()
    };
    let read = |name: &str| {
        let doc = dom.doc.borrow();
        let base = doc.as_ref();
        let id = base.get_element_by_id(name).expect("paragraph exists");
        base.tree()[id]
            .element_data()
            .and_then(|element| element.inline_layout_data())
            .expect("paragraph has inline layout")
            .layout(base.tree());
    };
    scan();
    scan();
    assert!(
        is_evicted(&dom, "p112") && is_evicted(&dom, "p119"),
        "precondition: both paragraphs start evicted"
    );
    for id in ["p112", "p119"] {
        read(id);
        scan();
        assert!(!is_evicted(&dom, id), "a fresh read gets one scan of grace");
    }
    scan();
    scan();
    assert!(
        is_evicted(&dom, "p119"),
        "two scans after the read evict it"
    );
}

#[test]
fn printing_releases_far_rebuilt_layouts_before_returning() {
    let dom = setup(Some(2.0), 120);
    assert!(is_evicted(&dom, "p112"));
    let pdf = dom.record_pdf_scenes(400, 300, 10, 10, 10, 10);
    assert!(!pdf.is_empty(), "the fixture must produce PDF scenes");
    assert!(
        is_evicted(&dom, "p112"),
        "printing must not retain offscreen shaped text on an idle document"
    );
}

#[test]
fn scrolling_through_clipped_strips_evicts_what_scrolled_away() {
    let dom = setup(Some(2.0), 240);
    let total = inline_roots(dom.doc.borrow().as_ref()).len();
    let height = page_height(&dom);
    assert!(
        !dom.render_scene_clip(0, 0, 800, 600, false, true)
            .is_empty(),
        "precondition: the top strip renders"
    );
    assert!(!is_evicted(&dom, "p0"), "precondition: the top is shaped");
    for step in 1..=8 {
        let y = (height - 600) * step / 8;
        dom.set_page_scroll(0.0, y as f64);
        assert!(
            !dom.render_scene_clip(0, y, 800, 600, false, true)
                .is_empty(),
            "the strip at {y} renders"
        );
        let resident = dom.doc.borrow().as_ref().inline_resident_count();
        assert!(
            resident < total / RESIDENT_BOUND_DIVISOR,
            "strips keep the resident set near the viewport ({resident} of {total})"
        );
    }
    assert!(
        is_evicted(&dom, "p0"),
        "the top is evicted once scrolled away"
    );
}

/// Scrolls `#box` down by an eighth of its content per step, by either path.
fn assert_inner_scroll_evicts_what_scrolled_away(scroll: impl Fn(&DomHandle, u32, f64)) {
    let paragraphs: String = (0..240)
        .map(|i| format!("<p id=q{i}>{}</p>", "words inside a scroller ".repeat(8)))
        .collect();
    let dom = DomHandle::new(
        &format!(
            "<!DOCTYPE html><body style=\"margin: 0; font: 16px/1.25 serif\">\
             <div id=box style=\"height: 600px; width: 600px; overflow: auto\">{paragraphs}</div>"
        ),
        "https://test.example/",
    );
    dom.set_viewport(800, 600);
    dom.doc
        .borrow_mut()
        .as_mut()
        .set_inline_layout_eviction(Some(2.0));
    dom.resolve_layout();
    dom.render_scene(0, 0, 0, 0, false, true);
    assert!(!is_evicted(&dom, "q0"), "precondition: the top is shaped");
    let scroller = dom.query_selector("#box").expect("query parses") as u32;
    for step in 1..=SCROLLER_STEPS {
        scroll(
            &dom,
            scroller,
            SCROLLER_CONTENT_PX * f64::from(step) / f64::from(SCROLLER_STEPS),
        );
        dom.render_scene(0, 0, 0, 0, false, true);
    }
    let scrolled = {
        let doc = dom.doc.borrow();
        let base = doc.as_ref();
        let box_id = base.get_element_by_id("box").expect("the scroller");
        base.tree()[box_id].scroll_offset().y
    };
    assert!(
        scrolled > 15_000.0,
        "precondition: the box scrolled ({scrolled})"
    );
    assert!(
        is_evicted(&dom, "q0"),
        "the scroller's top is evicted once scrolled away, though the viewport never moved"
    );
}

#[test]
fn setting_an_inner_scroll_offset_evicts_what_scrolled_away() {
    assert_inner_scroll_evicts_what_scrolled_away(|dom, scroller, y| {
        assert!(dom.write_scroll_offset(scroller, 0.0, y).is_some());
    });
}

#[test]
fn scrolling_an_inner_scroller_by_a_delta_evicts_what_scrolled_away() {
    assert_inner_scroll_evicts_what_scrolled_away(|dom, scroller, _| {
        dom.scroll_node_by(scroller, 0.0, 2_200.0);
    });
}

#[test]
fn a_far_layout_read_every_frame_is_not_rebuilt_every_frame() {
    let dom = setup(Some(2.0), 120);
    let span = dom.query_selector("#p112 em").unwrap() as u32;
    assert!(is_evicted(&dom, "p112"), "precondition: far from the top");
    // The first paint reshapes the visible roots the first pass evicted.
    dom.render_scene(0, 0, 0, 0, false, true);
    let first = dom.test_get_inline_aware_rect(span);
    let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
    for _ in 0..4 {
        dom.render_scene(0, 0, 0, 0, false, true);
        assert_eq!(dom.test_get_inline_aware_rect(span), first);
    }
    assert_eq!(
        blitz_dom::node::inline_layout_rebuild_count(),
        rebuilds,
        "a layout read between frames should stay live"
    );
}

#[test]
fn evicted_shrink_to_fit_roots_are_measured_without_rebuilding() {
    // Fit-content boxes are measured at each width, at the bottom of the page.
    let fitted: String = (0..40)
        .map(|i| {
            let pin = if i % 2 == 0 {
                "<b style=\"position:absolute;right:4px\">pin</b>"
            } else {
                ""
            };
            format!("<p id=c{i} style=\"width: fit-content;position:relative\">box {i} sized to its content{pin}</p>")
        })
        .collect();
    let html = page(120)
        .replace("width: 600px;", "")
        .replace("</body>", &format!("{fitted}</body>"));
    let (keep, evict) = with_and_without_eviction(&html);
    assert!(
        is_evicted(&evict, "c39"),
        "precondition: the boxes start evicted"
    );
    for width in [530, 700] {
        let rebuilds = blitz_dom::node::inline_layout_rebuild_count();
        evict.set_viewport(width, 600);
        evict.resolve_layout();
        assert!(
            is_evicted(&evict, "c39"),
            "the boxes stay evicted at {width}px"
        );
        let rebuilt = blitz_dom::node::inline_layout_rebuild_count() - rebuilds;
        keep.set_viewport(width, 600);
        keep.resolve_layout();
        assert_eq!(
            boxes(keep.doc.borrow().as_ref()),
            boxes(evict.doc.borrow().as_ref()),
            "boxes differ at {width}px"
        );
        assert_eq!(
            rebuilt, 0,
            "evicted roots were rebuilt to measure them at {width}px"
        );
    }
}

#[test]
fn printing_evicted_roots_matches_printing_live_ones() {
    let keep = setup(None, 120);
    let evict = setup(Some(2.0), 120);
    for dom in [&keep, &evict] {
        dom.set_media_type("print");
    }
    let pdf = |dom: &DomHandle| dom.record_pdf_scenes(400, 300, 10, 10, 10, 10);
    let expected = pdf(&keep);
    assert!(!expected.is_empty(), "the fixture must produce PDF scenes");
    assert_eq!(pdf(&evict), expected);
}

#[test]
fn a_failed_print_does_not_keep_its_rows_shaped() {
    let dom = setup(Some(2.0), 120);
    geometry(dom.doc.borrow().as_ref());
    assert!(!is_evicted(&dom, "p119"), "geometry rebuilt the bottom");

    // Holding the font borrow makes the print fail part way through.
    let fonts = dom.rbi_font_bytes.borrow_mut();
    assert!(dom.record_pdf_scenes(400, 300, 10, 10, 10, 10).is_empty());
    drop(fonts);
    assert!(
        is_evicted(&dom, "p119"),
        "failed printing releases shaped text"
    );
    geometry(dom.doc.borrow().as_ref());
    assert!(
        !is_evicted(&dom, "p119"),
        "the geometry read rebuilt the bottom"
    );
    evict_after_grace(&dom);
    assert!(
        is_evicted(&dom, "p119"),
        "the failed print released its keep extent"
    );
}

/// The fidelity page plus a paragraph whose absolutely positioned pin loses its
/// horizontal inset.
fn pinned_page() -> String {
    let annotated: String = (0..40)
        .map(|i| {
            format!(
                "<p id=o{i} class=rel>words before the pin \
                 <b id=pin{i} style=\"position:absolute;right:4px\">pin</b> after</p>"
            )
        })
        .collect();
    page(120)
        .replace("</style>", ".rel { position: relative; }</style>")
        .replace("</body>", &format!("{annotated}</body>"))
}

#[test]
fn removing_an_absolute_inset_rebuilds_the_static_inline_position() {
    let (keep, evict) = with_and_without_eviction(&pinned_page());
    assert!(is_evicted(&evict, "o39"), "the pin initially has an inset");
    for dom in [&keep, &evict] {
        let pin = dom.query_selector("#pin39").unwrap() as u32;
        assert!(dom.set_attribute(pin, "style", "position:absolute;right:auto"));
        dom.resolve_layout();
    }
    assert_eq!(
        boxes(keep.doc.borrow().as_ref()),
        boxes(evict.doc.borrow().as_ref())
    );
}

#[test]
fn a_zero_height_viewport_keeps_roots_and_bounds_the_resident_queue() {
    let dom = DomHandle::new(&page(2600), "https://test.example/");
    dom.set_viewport(800, 0);
    dom.doc
        .borrow_mut()
        .as_mut()
        .set_inline_layout_eviction(Some(2.0));
    dom.resolve_layout();
    let total = inline_roots(dom.doc.borrow().as_ref()).len();
    assert!(total > 256, "the layout pass must overflow its window");
    assert_eq!(
        evicted_root_count(&dom),
        0,
        "no keep band means no eviction"
    );
    for _ in 0..4 {
        geometry(dom.doc.borrow().as_ref());
        dom.doc
            .borrow_mut()
            .as_mut()
            .evict_offscreen_inline_layouts();
        assert!(dom.doc.borrow().as_ref().inline_resident_count() <= total);
        assert_eq!(evicted_root_count(&dom), 0);
    }
}

#[test]
fn roots_in_the_keep_extent_stay_shaped_until_it_is_cleared() {
    // Longer than the pass's window, so roots leave it mid-pass.
    let dom = DomHandle::new(&page(2600), "https://test.example/");
    dom.set_viewport(800, 600);
    let set_keep_extent = |extent| dom.doc.borrow_mut().as_mut().set_inline_keep_extent(extent);
    set_keep_extent(Some((0.0, f64::MAX)));
    dom.resolve_layout();
    assert_eq!(
        evicted_root_count(&dom),
        0,
        "the pass evicted a root in the extent"
    );
    dom.render_scene(0, 0, 0, 0, false, true);
    assert_eq!(
        evicted_root_count(&dom),
        0,
        "a scan evicted a root in the extent"
    );
    set_keep_extent(None);
    dom.render_scene(0, 0, 0, 0, false, true);
    assert!(
        evicted_root_count(&dom) > 0,
        "clearing the extent evicts far roots"
    );
}
