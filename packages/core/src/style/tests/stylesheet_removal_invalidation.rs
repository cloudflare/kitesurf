// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

//! Removing a `<style>` element must invalidate only what that sheet matched.
//! Blitz used to force every stylesheet origin dirty on removal, which
//! recascaded the whole document: a long stall on pages whose runtime adds
//! and removes a temporary `<style>`.

use crate::DomHandle;

fn generated_sheet(rules: usize) -> String {
    (0..rules)
        .map(|i| format!(".c{i} {{ color: rgb({}, 1, 2); }}", i % 250))
        .collect::<Vec<_>>()
        .join("\n")
}

fn page(tail: &str) -> String {
    format!(
        r#"<!DOCTYPE html><html><head><style>{}</style>{tail}</head>
<body><p id="u">unrelated</p><p id="t-only" class="only-t">tinted</p></body></html>"#,
        generated_sheet(2000)
    )
}

fn setup(html: &str) -> (DomHandle, u32, u32) {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let u = dom.query_selector("#u").expect("u") as u32;
    let t_only = dom.query_selector("#t-only").expect("t-only") as u32;
    (dom, u, t_only)
}

/// Identity of the element's computed values. The old Arc is leaked so the
/// allocator cannot hand its address to the restyled value: a changed pointer
/// means the element really was recascaded.
fn style_ptr(dom: &DomHandle, id: u32) -> *const () {
    let kept = {
        let doc = dom.doc.borrow();
        let node = doc.get_node(crate::blitz_node_id(id)).expect("node exists");
        node.primary_styles().map(|styles| (*styles).clone())
    };
    match kept {
        Some(styles) => {
            let leaked: &'static _ = Box::leak(Box::new(styles));
            &**leaked as *const _ as *const ()
        }
        None => std::ptr::null(),
    }
}

fn color(dom: &DomHandle, id: u32) -> String {
    dom.computed_style_value(id, "color").unwrap_or_default()
}

/// Removes the `<style id="t">` element and returns nothing.
fn remove_sheet(dom: &DomHandle, selector: &str) {
    let id = dom.query_selector(selector).expect("style element") as u32;
    assert!(dom.remove_node(id), "style element removed");
}

#[test]
fn removing_a_class_only_sheet_keeps_unrelated_styles() {
    let (dom, u, _) = setup(&page(
        r#"<style id="t">.only-t { color: rgb(9, 9, 9); }</style>"#,
    ));
    // First read commits the sheet into the stylist.
    let _ = dom.computed_style_value(u, "direction");
    let before = style_ptr(&dom, u);

    remove_sheet(&dom, "#t");
    let _ = dom.computed_style_value(u, "direction");
    let after = style_ptr(&dom, u);

    assert_eq!(
        before, after,
        "removing a sheet that never matched #u must not recascade it"
    );
}

#[test]
fn removing_a_class_only_sheet_reverts_the_elements_it_styled() {
    let (dom, _, t_only) = setup(&page(
        r#"<style id="t">.only-t { color: rgb(9, 9, 9); }</style>"#,
    ));
    assert_eq!(color(&dom, t_only), "rgb(9, 9, 9)");

    remove_sheet(&dom, "#t");
    assert_ne!(
        color(&dom, t_only),
        "rgb(9, 9, 9)",
        "an element the removed sheet styled must restyle"
    );
}

#[test]
fn removing_a_universal_sheet_still_recascades_everything() {
    let (dom, u, _) = setup(&page(r#"<style id="t">* { color: rgb(7, 7, 7); }</style>"#));
    assert_eq!(color(&dom, u), "rgb(7, 7, 7)");
    let before = style_ptr(&dom, u);

    remove_sheet(&dom, "#t");
    assert_ne!(color(&dom, u), "rgb(7, 7, 7)", "the universal rule is gone");
    let after = style_ptr(&dom, u);
    assert_ne!(
        before, after,
        "a universal selector must still invalidate the whole document"
    );
}
