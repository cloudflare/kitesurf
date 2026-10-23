// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::DomHandle;

pub(crate) fn query_selector_id(dom: &DomHandle, selector: &str) -> u32 {
    let id = dom.query_selector(selector).expect("selector should parse");
    u32::try_from(id).unwrap_or_else(|_| panic!("selector {selector:?} matched no element"))
}
