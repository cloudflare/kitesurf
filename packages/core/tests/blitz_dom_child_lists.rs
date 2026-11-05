// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use blitz_dom::{
    local_name, ns, Attribute, BaseDocument, DocumentConfig, DocumentMutator, LocalName, NodeId,
    QualName,
};

const VIEWPORT_WIDTH: u32 = 100;
// Tall enough that every row of the largest list stays inside the viewport for hit tests.
const VIEWPORT_HEIGHT: u32 = 800;
const ROW_WIDTH: f32 = 20.0;
const ROW_HEIGHT: f32 = 10.0;
const MAX_ROWS: usize = 64;
// Amortized doubling from one slot to MAX_ROWS slots allocates log2(64) + 1 times.
const MAX_CAPACITY_CHANGES: usize = 7;
const ZERO_BOX: &str = "display: block; margin: 0; padding: 0; border: 0";

struct Page {
    doc: BaseDocument,
    container: NodeId,
    rows: Vec<NodeId>,
}

struct PaintList {
    ids: Vec<NodeId>,
    capacity: usize,
    data: *const NodeId,
}

fn create_block(mutator: &mut DocumentMutator<'_>, tag: LocalName, style: &str) -> NodeId {
    let style = Attribute::new(
        QualName::new(None, ns!(), local_name!("style")),
        style.to_string(),
    );
    mutator.create_element(QualName::new(None, ns!(html), tag), vec![style])
}

fn create_row(mutator: &mut DocumentMutator<'_>) -> NodeId {
    let style = format!("{ZERO_BOX}; width: {ROW_WIDTH}px; height: {ROW_HEIGHT}px");
    create_block(mutator, local_name!("div"), &style)
}

fn resolved_page(row_count: usize) -> Page {
    let mut doc = BaseDocument::new(DocumentConfig::default());
    let mut viewport = doc.get_viewport();
    viewport.window_size = (VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    doc.set_viewport(viewport);
    let root = doc.root_node().id();
    let mut mutator = doc.mutate();
    let html = create_block(&mut mutator, local_name!("html"), ZERO_BOX);
    let body = create_block(&mut mutator, local_name!("body"), ZERO_BOX);
    let container_style = format!("{ZERO_BOX}; width: {ROW_WIDTH}px");
    let container = create_block(&mut mutator, local_name!("div"), &container_style);
    let rows: Vec<NodeId> = (0..row_count).map(|_| create_row(&mut mutator)).collect();
    mutator.append_children(root, &[html]);
    mutator.append_children(html, &[body]);
    mutator.append_children(body, &[container]);
    mutator.append_children(container, &rows);
    drop(mutator);
    doc.resolve(0.0);
    Page {
        doc,
        container,
        rows,
    }
}

fn paint_list(doc: &BaseDocument, id: NodeId) -> PaintList {
    let node = doc.get_node(id).unwrap();
    let paint = node
        .paint_children()
        .expect("a resolved block box has a paint list");
    let list = PaintList {
        ids: paint.to_vec(),
        capacity: paint.capacity(),
        data: paint.as_ptr(),
    };
    drop(paint);
    list
}

fn assert_row_at(doc: &BaseDocument, row: NodeId, index: usize) {
    let top = index as f32 * ROW_HEIGHT;
    let layout = doc.get_node(row).unwrap().final_layout();
    assert_eq!(
        (layout.location.x, layout.location.y),
        (0.0, top),
        "row {index} location"
    );
    assert_eq!(
        (layout.size.width, layout.size.height),
        (ROW_WIDTH, ROW_HEIGHT),
        "row {index} size"
    );
    let hit = doc.element_from_point(ROW_WIDTH / 2.0, top + ROW_HEIGHT / 2.0);
    assert_eq!(hit, Some(row), "row {index} hit target");
}

#[test]
fn initial_paint_list_retains_exactly_its_one_child() {
    let page = resolved_page(1);

    let list = paint_list(&page.doc, page.container);
    assert_eq!(list.ids, page.rows);
    assert_row_at(&page.doc, page.rows[0], 0);
    assert_eq!(list.capacity, 1);
}

#[test]
fn empty_computed_child_lists_retain_no_allocation() {
    let page = resolved_page(0);

    let node = page.doc.get_node(page.container).unwrap();
    let layout = node
        .layout_children()
        .expect("a resolved block box has a layout list");
    assert!(layout.is_empty());
    assert_eq!(layout.capacity(), 0);
    drop(layout);
    let list = paint_list(&page.doc, page.container);
    assert!(list.ids.is_empty());
    assert_eq!(list.capacity, 0);
    let container_layout = node.final_layout();
    assert_eq!(
        (container_layout.size.width, container_layout.size.height),
        (ROW_WIDTH, 0.0)
    );
}

#[test]
fn dirty_appends_reuse_paint_buffers_and_grow_capacity_amortized() {
    let mut page = resolved_page(0);
    let initial = paint_list(&page.doc, page.container);
    let mut previous_capacity = initial.capacity;
    let mut previous_data = initial.data;
    let mut capacity_changes = 0;

    for len in 1..=MAX_ROWS {
        let mut mutator = page.doc.mutate();
        let row = create_row(&mut mutator);
        mutator.append_children(page.container, &[row]);
        drop(mutator);
        page.rows.push(row);
        page.doc.resolve(0.0);

        let list = paint_list(&page.doc, page.container);
        assert_eq!(list.ids, page.rows, "paint order after {len} appends");
        assert!(
            list.capacity <= 2 * len.max(2),
            "capacity {} over-allocates {len} children",
            list.capacity
        );
        if list.capacity == previous_capacity {
            assert_eq!(
                list.data, previous_data,
                "dirty rebuild {len} replaced its buffer"
            );
        } else {
            capacity_changes += 1;
            previous_capacity = list.capacity;
        }
        previous_data = list.data;
        assert_row_at(&page.doc, page.rows[0], 0);
        assert_row_at(&page.doc, row, len - 1);
    }
    assert!(
        capacity_changes <= MAX_CAPACITY_CHANGES,
        "{capacity_changes} paint-list reallocations for {MAX_ROWS} appends"
    );

    let before = paint_list(&page.doc, page.container);
    page.doc.resolve(0.0);

    let after = paint_list(&page.doc, page.container);
    assert_eq!(after.ids, page.rows);
    assert_eq!(after.capacity, before.capacity);
    assert_row_at(&page.doc, page.rows[MAX_ROWS - 1], MAX_ROWS - 1);
}

#[test]
fn box_child_lists_preserve_empty_state_and_reset_on_clone() {
    let mut doc = BaseDocument::new(DocumentConfig::default());
    let element = doc
        .mutate()
        .create_element(QualName::new(None, ns!(html), local_name!("div")), vec![]);
    let text = doc.create_text_node("text");

    let node = doc.get_node(element).unwrap();
    assert!(node.layout_children().is_none());
    node.set_layout_children(Some(Default::default()));
    node.set_paint_children(Some([text].into_iter().collect()));
    let layout = node.layout_children().unwrap();
    let paint = node.paint_children().unwrap();
    assert!(layout.is_empty());
    assert_eq!(&paint[..], &[text]);
    drop(paint);
    drop(layout);

    let clone = doc.deep_clone_node(element);
    assert!(doc.get_node(clone).unwrap().layout_children().is_none());
    assert!(doc.get_node(clone).unwrap().paint_children().is_none());

    let node = doc.get_node(element).unwrap();
    assert!(node.take_layout_children().unwrap().is_empty());
    assert!(node.take_layout_children().is_none());

    let text = doc.get_node(text).unwrap();
    assert!(text.layout_children().is_none());
    assert!(text.paint_children().is_none());
    assert!(text.take_layout_children().is_none());
    assert!(text.take_paint_children().is_none());
}
