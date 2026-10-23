// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::js::boa_cc_graph::condense;

#[test]
fn sccs_sharing_a_handle_share_a_group() {
    let edges = vec![Vec::new(), Vec::new()];
    let g = condense(vec![(1, 0), (2, 1)], &edges, vec![vec![7], vec![7]]);
    let (a, b) = (g.pins[0].1, g.pins[1].1);
    assert_ne!(a, b);
    assert_eq!(g.group[a], g.group[b]);
}

#[test]
fn cycles_collapse_with_deduplicated_handles_and_children_first() {
    let edges = vec![vec![1, 1], vec![0, 2], vec![3], vec![2], vec![]];
    let owned = vec![vec![7, 7], vec![8], vec![9], vec![9], vec![10]];
    let g = condense(vec![(1, 0), (2, 1), (3, 2), (4, 3), (5, 4)], &edges, owned);
    let parent = g.pins[0].1;
    let child = g.pins[2].1;
    let isolated = g.pins[4].1;
    assert_eq!(parent, g.pins[1].1);
    assert_eq!(child, g.pins[3].1);
    assert_ne!(parent, child);
    assert!(child < parent);
    assert_eq!(g.handles[parent], vec![7, 8]);
    assert_eq!(g.handles[child], vec![9]);
    assert_eq!(g.children[parent], vec![child]);
    assert!(g.children[child].is_empty());
    assert_eq!(g.group[parent], g.group[child]);
    assert_ne!(g.group[parent], g.group[isolated]);
}
