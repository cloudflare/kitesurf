// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Tracks CSS transitions and animations across style resolves.
//! Produces the DOM events that PageScript reads after each resolve.

use std::collections::{HashMap, HashSet};

use ::style::animation::{AnimationState, KeyframesIterationState};
use ::style::properties::OwnedPropertyDeclarationId;
use blitz_dom::BaseDocument;
use blitz_traits::NodeId;
use stylo_atoms::Atom;

pub(crate) type TransitionKey = (usize, OwnedPropertyDeclarationId);

pub(crate) type TransitionStates = HashMap<TransitionKey, Tracked>;

pub(crate) type AnimationKey = (usize, Atom, usize);

pub(crate) fn occurrence_ordinals<'a>(
    animations: impl IntoIterator<Item = &'a Atom>,
) -> Vec<usize> {
    // CSS matches duplicate names from the end, so occurrence counts run right to left.
    let animations: Vec<&Atom> = animations.into_iter().collect();
    let mut seen: HashMap<&Atom, usize> = HashMap::new();
    let mut ordinals = vec![0; animations.len()];
    for (index, name) in animations.iter().enumerate().rev() {
        let count = seen.entry(*name).or_insert(0);
        ordinals[index] = *count;
        *count += 1;
    }
    ordinals
}
pub(crate) type AnimationStates = HashMap<AnimationKey, TrackedAnimation>;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) enum Phase {
    Pending = 1,
    Running = 2,
    Finished = 3,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tracked {
    node_id: u32,
    phase: Phase,
    start_time: f64,
    duration: f64,
}

impl Tracked {
    fn phase_at(&self, now: f64) -> Phase {
        phase_at(now, self.start_time, self.duration)
    }
}

fn phase_at(now: f64, start_time: f64, duration: f64) -> Phase {
    if now >= start_time + duration {
        Phase::Finished
    } else if now >= start_time {
        Phase::Running
    } else {
        Phase::Pending
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TrackedAnimation {
    node_id: u32,
    name: String,
    position: usize,
    rank: usize,
    start_time: f64,
    delay: f64,
    duration: f64,
    total_duration: Option<f64>,
    end_time: Option<f64>,
    paused_elapsed: Option<f64>,
    phase: Phase,
    iteration: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct TransitionEvent {
    #[serde(rename = "nodeId")]
    pub node_id: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(rename = "propertyName")]
    pub property_name: String,
    #[serde(rename = "elapsedTime")]
    pub elapsed_time: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct AnimationEvent {
    #[serde(rename = "nodeId")]
    pub node_id: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(rename = "animationName")]
    pub animation_name: String,
    #[serde(rename = "elapsedTime")]
    pub elapsed_time: f64,
}

fn live_animations(
    doc: &BaseDocument,
    now: f64,
    prev: &AnimationStates,
    need_ranks: bool,
    mut external_node_id: impl FnMut(usize) -> Option<u32>,
) -> (
    HashMap<AnimationKey, TrackedAnimation>,
    HashMap<usize, usize>,
) {
    let sets = doc.animations().sets.read();
    let mut live = HashMap::new();
    let ranks = if need_ranks {
        let mut needed: HashSet<usize> = sets
            .keys()
            .filter(|key| key.pseudo_element.is_none())
            .map(|key| key.node.id())
            .collect();
        needed.extend(prev.keys().map(|key| key.0));
        tree_ranks(doc, &needed)
    } else {
        HashMap::new()
    };

    for (key, set) in sets.iter() {
        if key.pseudo_element.is_some() {
            continue;
        }
        let node_id = key.node.id();
        let Some(external_node_id) = external_node_id(node_id) else {
            continue;
        };
        let ordinals = occurrence_ordinals(set.animations.iter().map(|a| &a.name));
        for (position, (animation, occurrence)) in set.animations.iter().zip(ordinals).enumerate() {
            if animation.state == AnimationState::Canceled {
                continue;
            }
            let (iteration, total_duration) = match &animation.iteration_state {
                KeyframesIterationState::Finite(current, max) => {
                    let total = (*max).max(0.0) * animation.duration;
                    (*current, Some(total))
                }
                KeyframesIterationState::Infinite(current) => (*current, None),
            };
            let paused_elapsed = match &animation.state {
                AnimationState::Paused(progress) => {
                    Some((iteration + (*progress).max(0.0)).max(0.0) * animation.duration)
                }
                _ => None,
            };
            let start_time = animation.started_at - iteration * animation.duration;
            let end_time = total_duration.map(|duration| start_time + duration);
            let time_finished = animation.has_ended(now);
            let phase = if time_finished {
                Phase::Finished
            } else if now >= animation.started_at {
                Phase::Running
            } else {
                Phase::Pending
            };
            let animation_key = (node_id, animation.name.clone(), occurrence);
            live.insert(
                animation_key,
                TrackedAnimation {
                    node_id: external_node_id,
                    name: animation.name.to_string(),
                    position,
                    rank: if need_ranks {
                        ranks.get(&node_id).copied().unwrap_or(usize::MAX)
                    } else {
                        prev.get(&(node_id, animation.name.clone(), occurrence))
                            .map(|tracked| tracked.rank)
                            .unwrap_or(usize::MAX)
                    },
                    start_time,
                    delay: animation.delay,
                    duration: animation.duration,
                    total_duration,
                    end_time,
                    paused_elapsed,
                    phase,
                    iteration,
                },
            );
        }
    }
    (live, ranks)
}

fn tree_ranks(doc: &BaseDocument, needed: &HashSet<usize>) -> HashMap<usize, usize> {
    let mut ranks = HashMap::new();
    if needed.is_empty() {
        return ranks;
    }
    let mut counter = 0usize;
    let mut found = 0usize;
    let mut stack: Vec<NodeId> = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let opaque = id.as_u64() as usize;
        if needed.contains(&opaque) {
            ranks.insert(opaque, counter);
            found += 1;
            if found == needed.len() {
                break;
            }
        }
        counter += 1;
        let node = &doc.tree()[id];
        for child in node.flat_children().iter().rev() {
            stack.push(*child);
        }
    }
    ranks
}

pub(crate) fn refresh_tracked_ranks(doc: &BaseDocument, states: &mut AnimationStates) {
    if states.is_empty() {
        return;
    }
    let needed: HashSet<usize> = states.keys().map(|key| key.0).collect();
    let ranks = tree_ranks(doc, &needed);
    for (key, tracked) in states.iter_mut() {
        tracked.rank = ranks.get(&key.0).copied().unwrap_or(tracked.rank);
    }
}

type EventOrder = (usize, u8, usize, u32);

fn push_animation_event(
    out: &mut Vec<(EventOrder, AnimationEvent)>,
    node_id: u32,
    animation: &TrackedAnimation,
    kind: &'static str,
    elapsed_time: f64,
) {
    let canceled_first = u8::from(kind != "animationcancel");
    out.push((
        (animation.rank, canceled_first, animation.position, node_id),
        AnimationEvent {
            node_id,
            kind,
            animation_name: animation.name.clone(),
            elapsed_time,
        },
    ));
}

fn emit_animation_start(
    out: &mut Vec<(EventOrder, AnimationEvent)>,
    node_id: u32,
    animation: &TrackedAnimation,
) {
    let start_elapsed = (-animation.delay)
        .max(0.0)
        .min(animation.total_duration.unwrap_or(f64::INFINITY));
    push_animation_event(out, node_id, animation, "animationstart", start_elapsed);
}

fn emit_animation_iterations(
    out: &mut Vec<(EventOrder, AnimationEvent)>,
    node_id: u32,
    animation: &TrackedAnimation,
    from: f64,
    to: f64,
) {
    if animation.phase != Phase::Running {
        return;
    }
    if to <= from {
        return;
    }
    push_animation_event(
        out,
        node_id,
        animation,
        "animationiteration",
        to * animation.duration,
    );
}

fn emit_animation_end(
    out: &mut Vec<(EventOrder, AnimationEvent)>,
    node_id: u32,
    animation: &TrackedAnimation,
) {
    if let Some(elapsed_time) = animation.total_duration {
        push_animation_event(out, node_id, animation, "animationend", elapsed_time);
    }
}

fn retire_animation(
    out: &mut Vec<(EventOrder, AnimationEvent)>,
    node_id: u32,
    animation: &TrackedAnimation,
    now: f64,
) {
    if animation.phase == Phase::Finished {
        return;
    }
    if animation.paused_elapsed.is_none() && animation.end_time.is_some_and(|end| now >= end) {
        emit_animation_end(out, node_id, animation);
    } else {
        let elapsed_time = animation
            .paused_elapsed
            .unwrap_or(now - animation.start_time)
            .max(0.0)
            .min(animation.total_duration.unwrap_or(f64::INFINITY));
        push_animation_event(out, node_id, animation, "animationcancel", elapsed_time);
    }
}

pub(crate) fn collect_animation_events(
    doc: &BaseDocument,
    now: f64,
    prev: &mut AnimationStates,
    need_ranks: bool,
    out: &mut Vec<AnimationEvent>,
    external_node_id: impl FnMut(usize) -> Option<u32>,
) {
    let (live, ranks) = live_animations(doc, now, prev, need_ranks, external_node_id);
    let mut next = HashMap::with_capacity(live.len());
    let mut ordered: Vec<(EventOrder, AnimationEvent)> = Vec::new();

    for (key, current) in live {
        match prev.get(&key) {
            Some(previous) if previous.node_id == current.node_id => {
                if previous.phase < Phase::Running && current.phase >= Phase::Running {
                    emit_animation_start(&mut ordered, current.node_id, &current);
                }
                if current.phase >= Phase::Running {
                    emit_animation_iterations(
                        &mut ordered,
                        current.node_id,
                        &current,
                        previous.iteration,
                        current.iteration,
                    );
                }
                if previous.phase != Phase::Finished && current.phase == Phase::Finished {
                    emit_animation_end(&mut ordered, current.node_id, &current);
                }
            }
            Some(previous) => {
                let mut previous = previous.clone();
                previous.rank = ranks.get(&key.0).copied().unwrap_or(previous.rank);
                retire_animation(&mut ordered, previous.node_id, &previous, now);
                if current.phase >= Phase::Running {
                    emit_animation_start(&mut ordered, current.node_id, &current);
                }
                if current.phase == Phase::Finished {
                    emit_animation_end(&mut ordered, current.node_id, &current);
                }
            }
            None => {
                if current.phase >= Phase::Running {
                    emit_animation_start(&mut ordered, current.node_id, &current);
                }
                if current.phase == Phase::Finished {
                    emit_animation_end(&mut ordered, current.node_id, &current);
                }
            }
        }
        next.insert(key, current);
    }

    for (key, previous) in prev.iter() {
        if !next.contains_key(key) {
            let mut previous = previous.clone();
            previous.rank = ranks.get(&key.0).copied().unwrap_or(previous.rank);
            retire_animation(&mut ordered, previous.node_id, &previous, now);
        }
    }

    *prev = next;
    ordered.sort_by_key(|(order, _)| *order);
    out.extend(ordered.into_iter().map(|(_, event)| event));
}

fn emit_span(
    out: &mut Vec<TransitionEvent>,
    node_id: u32,
    property: &OwnedPropertyDeclarationId,
    from: Option<Phase>,
    to: Phase,
    duration: f64,
) {
    let first = from.map_or(Phase::Pending as u8, |p| p as u8 + 1);
    for step in first..=(to as u8) {
        let (kind, elapsed) = match step {
            1 => ("transitionrun", 0.0),
            2 => ("transitionstart", 0.0),
            _ => ("transitionend", duration),
        };
        out.push(TransitionEvent {
            node_id,
            kind,
            property_name: property.as_borrowed().name().into_owned(),
            elapsed_time: elapsed,
        });
    }
}

fn live_transitions(
    doc: &BaseDocument,
    mut external_node_id: impl FnMut(usize) -> Option<u32>,
) -> HashMap<TransitionKey, (u32, f64, f64)> {
    let sets = doc.animations().sets.read();
    let mut live: HashMap<TransitionKey, (u32, f64, f64)> = HashMap::new();

    for (key, set) in sets.iter() {
        if key.pseudo_element.is_some() {
            continue;
        }
        let node_id = key.node.id();
        let Some(external_node_id) = external_node_id(node_id) else {
            continue;
        };
        for transition in set.transitions.iter() {
            if transition.state == AnimationState::Canceled {
                continue;
            }
            let property = transition.property_animation.property_id().to_owned();
            let start_time = transition.start_time;
            let duration = transition.property_animation.duration;
            live.entry((node_id, property))
                .and_modify(|seen| {
                    if start_time > seen.1 {
                        *seen = (external_node_id, start_time, duration);
                    }
                })
                .or_insert((external_node_id, start_time, duration));
        }
    }
    live
}

pub(crate) fn collect_events(
    doc: &BaseDocument,
    now: f64,
    prev: &mut TransitionStates,
    out: &mut Vec<TransitionEvent>,
    external_node_id: impl FnMut(usize) -> Option<u32>,
) {
    let live = live_transitions(doc, external_node_id);
    let mut next: TransitionStates = HashMap::with_capacity(live.len());

    for (map_key, (node_id, start_time, duration)) in live {
        let phase = phase_at(now, start_time, duration);
        let from = match prev.get(&map_key) {
            Some(t) if t.node_id == node_id && t.start_time == start_time => Some(t.phase),
            Some(t) => {
                retire(out, &map_key.1, *t, now);
                None
            }
            None => None,
        };
        emit_span(out, node_id, &map_key.1, from, phase, duration);
        next.insert(
            map_key,
            Tracked {
                node_id,
                phase,
                start_time,
                duration,
            },
        );
    }

    for (map_key, tracked) in prev.iter() {
        if next.contains_key(map_key) {
            continue;
        }
        retire(out, &map_key.1, *tracked, now);
    }

    *prev = next;
}

fn retire(
    out: &mut Vec<TransitionEvent>,
    property: &OwnedPropertyDeclarationId,
    tracked: Tracked,
    now: f64,
) {
    if tracked.phase_at(now) == Phase::Finished {
        emit_span(
            out,
            tracked.node_id,
            property,
            Some(tracked.phase),
            Phase::Finished,
            tracked.duration,
        );
    } else {
        cancel(out, property, tracked, now);
    }
}

fn cancel(
    out: &mut Vec<TransitionEvent>,
    property: &OwnedPropertyDeclarationId,
    tracked: Tracked,
    now: f64,
) {
    let active = (now - tracked.start_time).clamp(0.0, tracked.duration);
    out.push(TransitionEvent {
        node_id: tracked.node_id,
        kind: "transitioncancel",
        property_name: property.as_borrowed().name().into_owned(),
        elapsed_time: active,
    });
}
