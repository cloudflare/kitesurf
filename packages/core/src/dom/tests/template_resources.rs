// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::{HtmlDocument, HtmlProvider};
use std::sync::Arc;

#[test]
fn template_images_stay_inert_until_inserted_into_the_document() {
    const TEMPLATE_URL: &str = "https://template.test/template.png";
    const UPDATED_URL: &str = "https://template.test/updated.png";
    const FRAGMENT_URL: &str = "https://template.test/fragment.png";
    let mut document = HtmlDocument::from_html(
        &format!(r#"<template><img src="{TEMPLATE_URL}"></template>"#),
        DocumentConfig {
            base_url: Some("https://template.test/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            ..Default::default()
        },
    );

    let (template_id, image_id) = {
        let doc: &BaseDocument = document.as_ref();
        let mut template_id = None;
        let mut image_id = None;
        for (id, node) in doc.tree().iter() {
            if let Some(element) = node.element_data() {
                match &*element.name.local {
                    "template" => template_id = Some(id),
                    "img" => image_id = Some(id),
                    _ => {}
                }
            }
        }
        (
            template_id.expect("parsed template exists"),
            image_id.expect("parsed template image exists"),
        )
    };

    assert!(
        document
            .as_ref()
            .get_node(template_id)
            .expect("template node exists")
            .flags
            .is_in_document(),
        "template element must remain connected"
    );

    assert!(
        document
            .as_ref()
            .pending_image_nodes(TEMPLATE_URL)
            .is_empty(),
        "parsing template contents must not start an image request"
    );

    {
        let doc: &mut BaseDocument = document.as_mut();
        let mut mutator = doc.mutate();
        mutator.set_attribute(image_id, blitz_dom::qual_name!("src"), UPDATED_URL);
    }
    assert!(
        document
            .as_ref()
            .pending_image_nodes(UPDATED_URL)
            .is_empty(),
        "changing a template image's src must not start a request"
    );

    {
        let doc: &mut BaseDocument = document.as_mut();
        let mut mutator = doc.mutate();
        let fragment = mutator.create_element(
            blitz_dom::QualName::new(
                None,
                blitz_dom::ns!(html),
                blitz_dom::LocalName::from("#document-fragment"),
            ),
            Vec::new(),
        );
        mutator.append_children(fragment, &[image_id]);
        mutator.set_attribute(image_id, blitz_dom::qual_name!("src"), FRAGMENT_URL);
    }
    assert!(
        document
            .as_ref()
            .pending_image_nodes(FRAGMENT_URL)
            .is_empty(),
        "changing a template image's src in its content fragment must not start a request"
    );

    {
        let doc: &mut BaseDocument = document.as_mut();
        let root_id = doc.root_node().id();
        let mut mutator = doc.mutate();
        mutator.append_children(root_id, &[image_id]);
    }
    assert_eq!(
        document.as_ref().pending_image_nodes(FRAGMENT_URL),
        [image_id],
        "inserting the image into the document must start its request"
    );
}

#[test]
fn inserting_a_detached_template_keeps_its_contents_inert() {
    const IMAGE_URL: &str = "https://template.test/detached.png";
    let mut document = HtmlDocument::from_html(
        "",
        DocumentConfig {
            base_url: Some("https://template.test/".to_string()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            ..Default::default()
        },
    );

    {
        let doc: &mut BaseDocument = document.as_mut();
        let root_id = doc.root_node().id();
        let mut mutator = doc.mutate();
        let host = mutator.create_element(blitz_dom::qual_name!("div", html), Vec::new());
        mutator.set_inner_html(
            host,
            &format!(r#"<template><p><img src="{IMAGE_URL}"></p></template>"#),
        );
        mutator.append_children(root_id, &[host]);
    }

    assert!(
        document.as_ref().pending_image_nodes(IMAGE_URL).is_empty(),
        "inserting a subtree must not start requests for its template contents"
    );
}
