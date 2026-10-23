// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Graph half of the boa<->V8 cycle collector, free of wasm and boa types so host tests reach it.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::collections::HashMap;

/// Boa objects reachable from a gray pin but not from a boa root, condensed into SCCs numbered
/// children first.
pub(crate) struct GrayGraph {
    /// Gray pins with the SCC of their object.
    pub(crate) pins: Vec<(u64, usize)>,
    /// Per SCC: the V8 pins it owns that no boa root also reaches.
    pub(crate) handles: Vec<Vec<u64>>,
    pub(crate) children: Vec<Vec<usize>>,
    /// Per SCC: its revocation group. SCCs joined by a boa edge or sharing an owned V8 pin share
    /// a group.
    pub(crate) group: Vec<usize>,
}

fn find(group: &mut [usize], mut x: usize) -> usize {
    while group[x] != x {
        group[x] = group[group[x]];
        x = group[x];
    }
    x
}

fn union(group: &mut [usize], a: usize, b: usize) {
    let (a, b) = (find(group, a), find(group, b));
    group[a] = b;
}

/// Iterative Tarjan: an SCC is emitted only after every SCC it reaches.
pub(crate) fn condense(
    gray_pins: Vec<(u64, usize)>,
    edges: &[Vec<usize>],
    owned: Vec<Vec<u64>>,
) -> GrayGraph {
    const UNSEEN: usize = usize::MAX;
    let n = edges.len();
    let mut order = vec![UNSEEN; n];
    let mut low = vec![0; n];
    let mut on_stack = vec![false; n];
    let mut scc_of = vec![UNSEEN; n];
    let mut tarjan: Vec<usize> = Vec::new();
    let mut next = 0;
    let mut sccs = 0;
    for root in 0..n {
        if order[root] != UNSEEN {
            continue;
        }
        let mut call: Vec<(usize, usize)> = vec![(root, 0)];
        order[root] = next;
        low[root] = next;
        next += 1;
        tarjan.push(root);
        on_stack[root] = true;
        while let Some(&mut (v, ref mut i)) = call.last_mut() {
            if let Some(&w) = edges[v].get(*i) {
                *i += 1;
                if order[w] == UNSEEN {
                    order[w] = next;
                    low[w] = next;
                    next += 1;
                    tarjan.push(w);
                    on_stack[w] = true;
                    call.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(order[w]);
                }
                continue;
            }
            call.pop();
            if let Some(&(u, _)) = call.last() {
                low[u] = low[u].min(low[v]);
            }
            if low[v] == order[v] {
                let split = tarjan
                    .iter()
                    .rposition(|&w| w == v)
                    .expect("an SCC root stays on the Tarjan stack");
                for w in tarjan.drain(split..) {
                    on_stack[w] = false;
                    scc_of[w] = sccs;
                }
                sccs += 1;
            }
        }
    }
    let mut handles = vec![Vec::new(); sccs];
    let mut children = vec![Vec::new(); sccs];
    let mut group: Vec<usize> = (0..sccs).collect();
    for (v, hs) in owned.into_iter().enumerate() {
        handles[scc_of[v]].extend(hs);
    }
    for (v, out) in edges.iter().enumerate() {
        let s = scc_of[v];
        for &w in out {
            let t = scc_of[w];
            if s != t {
                children[s].push(t);
                union(&mut group, s, t);
            }
        }
    }
    // A shared pin is weakened once under one group, so every SCC owning it must share that group.
    let mut owner: HashMap<u64, usize> = HashMap::new();
    for (s, hs) in handles.iter().enumerate() {
        for &h in hs {
            if let Some(&o) = owner.get(&h) {
                union(&mut group, s, o);
            } else {
                owner.insert(h, s);
            }
        }
    }
    for s in 0..sccs {
        handles[s].sort_unstable();
        handles[s].dedup();
        children[s].sort_unstable();
        children[s].dedup();
    }
    let group = (0..sccs).map(|s| find(&mut group, s)).collect();
    let pins = gray_pins.into_iter().map(|(p, v)| (p, scc_of[v])).collect();
    GrayGraph {
        pins,
        handles,
        children,
        group,
    }
}
