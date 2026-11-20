// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Builds rendered text from DOM nodes using computed visibility and whitespace.
//! Applies computed text transforms when collecting text runs.

use ::style::computed_values::white_space_collapse::T as WhiteSpaceCollapse;
use ::style::properties::generated::longhands::visibility::computed_value::T as Visibility;
use ::style::values::computed::TextTransform;
use ::style::values::specified::box_::{DisplayInside, DisplayOutside};
use blitz_dom::{local_name, BaseDocument, LocalName, NodeId};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Collapse,
    Preserve,
    PreserveBreaks,
}

#[derive(Clone, Copy, PartialEq)]
enum Case {
    None,
    Upper,
    Lower,
    Capitalize,
}

enum Item {
    Text {
        data: String,
        mode: Mode,
        case: Case,
    },
    HardBreak,
    CellTab,
    Required(u8),
    Atomic(Vec<Item>),
}

#[derive(Clone, Copy)]
struct Ctx {
    mode: Mode,
    case: Case,
    visible: bool,
}

pub(crate) fn inner_text(doc: &BaseDocument, node_id: NodeId) -> Option<String> {
    let node = doc.get_node(node_id)?;
    if !node.is_element() {
        return None;
    }
    let root_id = doc.root_node().id();
    let mut cur = Some(node_id);
    let mut connected = false;
    while let Some(id) = cur {
        let n = doc.get_node(id)?;
        if n.is_element() {
            if let Some(styles) = n.primary_styles() {
                let display = styles.clone_display();
                if display.outside() == DisplayOutside::None
                    && display.inside() == DisplayInside::None
                {
                    return None;
                }
            }
        }
        if id == root_id {
            connected = true;
        }
        cur = n.parent_id();
    }
    if !connected {
        return None;
    }
    if let Some(name) = node.element_data().map(|e| e.name.local.clone()) {
        if is_replaced_host(&name) {
            return Some(String::new());
        }
    }
    let ctx = element_ctx(
        doc,
        node_id,
        Ctx {
            mode: Mode::Collapse,
            case: Case::None,
            visible: true,
        },
    );
    let mut items = Vec::new();
    collect_children(doc, node_id, ctx, &mut items);
    Some(resolve(&items))
}

fn element_ctx(doc: &BaseDocument, id: NodeId, inherited: Ctx) -> Ctx {
    let Some(node) = doc.get_node(id) else {
        return inherited;
    };
    let Some(styles) = node.primary_styles() else {
        return inherited;
    };
    let text = styles.get_inherited_text();
    let mode = match text.white_space_collapse {
        WhiteSpaceCollapse::Collapse => Mode::Collapse,
        WhiteSpaceCollapse::Preserve => Mode::Preserve,
        WhiteSpaceCollapse::PreserveBreaks => Mode::PreserveBreaks,
        WhiteSpaceCollapse::BreakSpaces => Mode::Preserve,
    };
    let tt = styles.clone_text_transform();
    let case = if tt.intersects(TextTransform::UPPERCASE) {
        Case::Upper
    } else if tt.intersects(TextTransform::LOWERCASE) {
        Case::Lower
    } else if tt.intersects(TextTransform::CAPITALIZE) {
        Case::Capitalize
    } else {
        Case::None
    };
    let visible = styles.get_inherited_box().visibility == Visibility::Visible;
    Ctx {
        mode,
        case,
        visible,
    }
}

fn is_replaced_host(name: &LocalName) -> bool {
    *name == local_name!("textarea")
        || *name == local_name!("input")
        || *name == local_name!("img")
        || *name == local_name!("iframe")
        || *name == local_name!("video")
        || *name == local_name!("audio")
        || *name == local_name!("canvas")
        || *name == local_name!("object")
        || *name == local_name!("embed")
        || *name == local_name!("svg")
        || *name == local_name!("math")
        || *name == local_name!("progress")
        || *name == local_name!("meter")
        || *name == local_name!("template")
}

fn collect_children(doc: &BaseDocument, id: NodeId, ctx: Ctx, out: &mut Vec<Item>) {
    let Some(node) = doc.get_node(id) else {
        return;
    };
    let own_name = node.element_data().map(|e| e.name.local.clone());
    let drop_text = own_name
        .as_ref()
        .map(|n| *n == local_name!("select"))
        .unwrap_or(false)
        || node
            .primary_styles()
            .map(|s| {
                matches!(
                    s.clone_display().inside(),
                    DisplayInside::Table
                        | DisplayInside::TableRowGroup
                        | DisplayInside::TableHeaderGroup
                        | DisplayInside::TableFooterGroup
                        | DisplayInside::TableRow
                )
            })
            .unwrap_or(false);
    let mut saw_cell = false;
    let mut saw_row = false;
    for cid in node.children().iter() {
        let Some(child) = doc.get_node(cid) else {
            continue;
        };
        if let Some(text) = child.text_data() {
            if ctx.visible && !drop_text {
                out.push(Item::Text {
                    data: text.content.to_string(),
                    mode: ctx.mode,
                    case: ctx.case,
                });
            }
            continue;
        }
        if !child.is_element() {
            continue;
        }
        let child_ctx = element_ctx(doc, cid, ctx);
        let name = child
            .element_data()
            .map(|e| e.name.local.clone())
            .unwrap_or_else(|| local_name!("div"));
        if name == local_name!("option") || name == local_name!("optgroup") {
            out.push(Item::Required(1));
            collect_children(doc, cid, child_ctx, out);
            out.push(Item::Required(1));
            continue;
        }
        let styles = child.primary_styles();
        let display = styles.as_ref().map(|s| s.clone_display());
        let (outside, inside) = display
            .map(|d| (d.outside(), d.inside()))
            .unwrap_or((DisplayOutside::Inline, DisplayInside::Flow));
        if outside == DisplayOutside::None {
            if inside == DisplayInside::Contents {
                collect_children(doc, cid, child_ctx, out);
            }
            continue;
        }
        let replaced = is_replaced_host(&name);
        // Hidden visibility suppresses this element's text, but descendants can restore it.
        if !child_ctx.visible {
            if !replaced {
                collect_children(doc, cid, child_ctx, out);
            }
            continue;
        }
        if name == local_name!("br") {
            out.push(Item::HardBreak);
            continue;
        }
        if name == local_name!("p") {
            out.push(Item::Required(2));
            collect_children(doc, cid, child_ctx, out);
            out.push(Item::Required(2));
            continue;
        }
        if replaced && outside == DisplayOutside::Inline {
            out.push(Item::Atomic(Vec::new()));
            continue;
        }
        let is_cell = inside == DisplayInside::TableCell;
        let is_row = inside == DisplayInside::TableRow;
        if is_cell {
            if saw_cell {
                out.push(Item::CellTab);
            }
            saw_cell = true;
            collect_children(doc, cid, child_ctx, out);
            continue;
        }
        if is_row {
            if saw_row {
                out.push(Item::HardBreak);
            }
            saw_row = true;
            collect_children(doc, cid, child_ctx, out);
            continue;
        }
        let is_atomic = outside == DisplayOutside::Inline && inside != DisplayInside::Flow;
        if is_atomic {
            let mut inner = Vec::new();
            collect_children(doc, cid, child_ctx, &mut inner);
            out.push(Item::Atomic(inner));
            continue;
        }
        let required: u8 = if outside == DisplayOutside::Block
            || outside == DisplayOutside::TableCaption
            || inside == DisplayInside::Table
        {
            1
        } else {
            0
        };
        if required > 0 {
            out.push(Item::Required(required));
            if !replaced {
                collect_children(doc, cid, child_ctx, out);
            }
            out.push(Item::Required(required));
        } else if !replaced {
            collect_children(doc, cid, child_ctx, out);
        }
    }
}

struct Resolver {
    out: String,
    pending_space: bool,
    at_line_start: bool,
    pending_breaks: u8,
    last_char: Option<char>,
}

impl Resolver {
    fn new() -> Self {
        Resolver {
            out: String::new(),
            pending_space: false,
            at_line_start: true,
            pending_breaks: 0,
            last_char: None,
        }
    }

    fn flush_breaks(&mut self) {
        if self.pending_breaks > 0 && !self.out.is_empty() {
            for _ in 0..self.pending_breaks {
                self.out.push('\n');
            }
            self.last_char = Some('\n');
            self.at_line_start = true;
        }
        self.pending_breaks = 0;
    }

    fn flush_space(&mut self) {
        if self.pending_space {
            if !self.at_line_start {
                self.out.push(' ');
                self.last_char = Some(' ');
            }
            self.pending_space = false;
        }
    }

    fn push_char(&mut self, ch: char, case: Case) {
        self.flush_breaks();
        self.flush_space();
        let word_start = self.last_char.map(|c| !c.is_alphanumeric()).unwrap_or(true);
        match case {
            Case::Upper => self.push_str_tracked(ch.to_uppercase()),
            Case::Lower => self.push_str_tracked(ch.to_lowercase()),
            Case::Capitalize if word_start => self.push_str_tracked(ch.to_uppercase()),
            _ => {
                self.out.push(ch);
                self.last_char = Some(ch);
            }
        }
        self.at_line_start = false;
    }

    fn push_str_tracked(&mut self, chars: impl Iterator<Item = char>) {
        for c in chars {
            self.out.push(c);
            self.last_char = Some(c);
        }
    }

    fn newline(&mut self) {
        self.pending_space = false;
        self.flush_breaks();
        self.out.push('\n');
        self.last_char = Some('\n');
        self.at_line_start = true;
    }

    fn next_text_char(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<char> {
        let ch = chars.next()?;
        if ch != '\r' {
            return Some(ch);
        }
        if chars.peek() == Some(&'\n') {
            chars.next();
        }
        Some('\n')
    }

    fn run(&mut self, items: &[Item]) {
        for item in items {
            match item {
                Item::Required(n) => {
                    self.pending_space = false;
                    self.pending_breaks = self.pending_breaks.max(*n);
                }
                Item::HardBreak => self.newline(),
                Item::CellTab => {
                    self.pending_space = false;
                    self.flush_breaks();
                    self.out.push('\t');
                    self.last_char = Some('\t');
                    self.at_line_start = true;
                }
                Item::Atomic(inner) => {
                    self.flush_breaks();
                    self.flush_space();
                    let mut sub = Resolver::new();
                    sub.run(inner);
                    if let Some(c) = sub.last_char {
                        self.last_char = Some(c);
                    }
                    self.out.push_str(&sub.out);
                    self.at_line_start = false;
                }
                Item::Text { data, mode, case } => {
                    let mut chars = data.chars().peekable();
                    while let Some(ch) = Self::next_text_char(&mut chars) {
                        match (*mode, ch) {
                            (Mode::Collapse, ' ' | '\t' | '\n' | '\x0c') => {
                                self.pending_space = true;
                            }
                            (Mode::PreserveBreaks, '\n') | (Mode::Preserve, '\n') => {
                                self.newline();
                            }
                            (Mode::PreserveBreaks, ' ' | '\t') => {
                                self.pending_space = true;
                            }
                            (_, ch) => self.push_char(ch, *case),
                        }
                    }
                }
            }
        }
    }
}

fn resolve(items: &[Item]) -> String {
    let mut r = Resolver::new();
    r.run(items);
    r.out
}
