// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Web Animations timing and Stylo keyframe integration.

use std::collections::BTreeMap;

use blitz_dom::BaseDocument;
use blitz_traits::NodeId;
use cssparser::{Parser, SourceLocation};
use servo_arc::Arc;
use style::animation::{AnimationSetKey, ScriptAnimation};
use style::context::QuirksMode;
use style::dom::OpaqueNode;
use style::invalidation::element::restyle_hints::RestyleHint;
use style::parser::{Parse, ParserContext};
use style::properties::declaration_block::{parse_one_declaration_into, Importance};
use style::properties::{PropertyDeclarationBlock, PropertyId, SourcePropertyDeclaration};
use style::stylesheets::keyframes_rule::{
    Keyframe, KeyframePercentage, KeyframeSelectors, KeyframesAnimation,
};
use style::stylesheets::{CssRuleType, Origin, UrlExtraData};
use style::values::computed::TimingFunction as ComputedTimingFunction;
use style::values::generics::easing::BeforeFlag;
use style::values::specified::TimingFunction;
use style_traits::ParsingMode;

/// Blink's kBezierEpsilon. Solving tighter or looser than Blink shifts the digits pages
/// read back, and pages expect Blink's exact output.
const EASING_EPSILON: f64 = 1e-7;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Direction {
    Normal,
    Reverse,
    Alternate,
    AlternateReverse,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Fill {
    None,
    Forwards,
    Backwards,
    Both,
}

#[derive(Clone, Debug)]
pub(crate) struct Timing {
    pub delay: f64,
    pub end_delay: f64,
    pub duration: f64,
    pub iterations: f64,
    pub iteration_start: f64,
    pub direction: Direction,
    pub fill: Fill,
    pub easing: ComputedTimingFunction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Phase {
    Before,
    Active,
    After,
    Idle,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComputedTiming {
    pub phase: Phase,
    pub active_duration: f64,
    pub end_time: f64,
    pub progress: Option<f64>,
    pub current_iteration: Option<f64>,
}

pub(crate) fn parse_easing(text: &str) -> Result<ComputedTimingFunction, String> {
    let url = UrlExtraData::from(url::Url::parse("about:kitesurf-easing").expect("static url"));
    let context = ParserContext::new(
        Origin::Author,
        &url,
        None,
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    let mut parser = Parser::new(text);
    parser
        .parse_entirely(|p| TimingFunction::parse(&context, p))
        .map(|t| t.to_computed_value_without_context())
        .map_err(|_| format!("'{text}' is not a valid value for easing"))
}

/// `timing` is `[delay, endDelay, duration, iterations, iterationStart, direction, fill]` in ms;
/// direction and fill use IDL enum order, and `Infinity` stays numeric.
pub(crate) fn parse_timing(timing: &[f64], easing: &str) -> Result<Timing, String> {
    let &[delay, end_delay, duration, iterations, iteration_start, direction, fill] = timing else {
        return Err("effect timing needs 7 fields".into());
    };
    let direction = match direction as u8 {
        1 => Direction::Reverse,
        2 => Direction::Alternate,
        3 => Direction::AlternateReverse,
        _ => Direction::Normal,
    };
    let fill = match fill as u8 {
        1 => Fill::Forwards,
        2 => Fill::Backwards,
        3 => Fill::Both,
        _ => Fill::None,
    };
    Ok(Timing {
        delay,
        end_delay,
        duration,
        iterations,
        iteration_start,
        direction,
        fill,
        easing: parse_easing(easing)?,
    })
}

/// web-animations-1 §4.8–4.10: phase, active time, iteration, direction, easing. `rate` is
/// the animation's playback rate; its sign breaks the tie at an exact phase boundary.
pub(crate) fn computed_timing(t: &Timing, local_time: Option<f64>, rate: f64) -> ComputedTiming {
    let active_duration = if t.duration == 0.0 || t.iterations == 0.0 {
        0.0
    } else {
        t.duration * t.iterations
    };
    let end_time = (t.delay + active_duration + t.end_delay).max(0.0);
    let mut out = ComputedTiming {
        phase: Phase::Idle,
        active_duration,
        end_time,
        progress: None,
        current_iteration: None,
    };
    let Some(local) = local_time else {
        return out;
    };
    let before_active = t.delay.min(end_time).max(0.0);
    let active_after = (t.delay + active_duration).min(end_time).max(0.0);
    let backwards = rate < 0.0;
    let phase = if local < before_active || (backwards && local == before_active) {
        Phase::Before
    } else if local > active_after || (!backwards && local >= active_after) {
        Phase::After
    } else {
        Phase::Active
    };
    out.phase = phase;
    let active_time = match phase {
        Phase::Before => {
            matches!(t.fill, Fill::Backwards | Fill::Both).then(|| (local - t.delay).max(0.0))
        }
        Phase::Active => Some(local - t.delay),
        Phase::After => matches!(t.fill, Fill::Forwards | Fill::Both)
            .then(|| (local - t.delay).min(active_duration).max(0.0)),
        Phase::Idle => None,
    };
    let Some(active_time) = active_time else {
        return out;
    };
    let overall = if t.duration == 0.0 {
        if phase == Phase::Before {
            0.0
        } else {
            t.iterations
        }
    } else {
        active_time / t.duration
    } + t.iteration_start;
    let mut simple = if overall.is_infinite() {
        t.iteration_start % 1.0
    } else {
        overall % 1.0
    };
    if simple == 0.0
        && matches!(phase, Phase::Active | Phase::After)
        && active_time == active_duration
        && t.iterations != 0.0
    {
        simple = 1.0;
    }
    let current_iteration = if phase == Phase::After && t.iterations.is_infinite() {
        f64::INFINITY
    } else if simple == 1.0 {
        overall.floor() - 1.0
    } else {
        overall.floor()
    };
    let forwards = match t.direction {
        Direction::Normal => true,
        Direction::Reverse => false,
        Direction::Alternate | Direction::AlternateReverse => {
            let d = current_iteration + f64::from(t.direction == Direction::AlternateReverse);
            d.is_infinite() || d % 2.0 == 0.0
        }
    };
    let directed = if forwards { simple } else { 1.0 - simple };
    let before_flag =
        if (phase == Phase::Before && forwards) || (phase == Phase::After && !forwards) {
            BeforeFlag::Set
        } else {
            BeforeFlag::Unset
        };
    out.progress = Some(
        t.easing
            .calculate_output(directed, before_flag, EASING_EPSILON),
    );
    out.current_iteration = Some(current_iteration);
    out
}

#[derive(serde::Deserialize)]
pub(crate) struct KeyframeIn {
    offset: f64,
    easing: Option<String>,
    props: Vec<(String, String)>,
}

/// Keyframes arrive with computed offsets, in order. Each value parses on its own, as a
/// property in a keyframe block would, so a bad value drops alone and can't inject others.
fn parse_keyframes(doc: &BaseDocument, json: &str) -> Result<Arc<KeyframesAnimation>, String> {
    let frames: Vec<KeyframeIn> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let url = UrlExtraData::from(doc.url().clone());
    let lock = doc.guard();
    let mut keyframes = Vec::with_capacity(frames.len());
    for frame in &frames {
        let mut block = PropertyDeclarationBlock::new();
        let mut add = |name: &str, value: &str| {
            let Ok(id) = PropertyId::parse_enabled_for_all_content(name) else {
                return false;
            };
            let mut declarations = SourcePropertyDeclaration::default();
            let parsed = parse_one_declaration_into(
                &mut declarations,
                id,
                value,
                Origin::Author,
                &url,
                None,
                ParsingMode::DEFAULT,
                QuirksMode::NoQuirks,
                CssRuleType::Keyframe,
            );
            if parsed.is_ok() {
                block.extend(declarations.drain(), Importance::Normal);
            }
            parsed.is_ok()
        };
        for (name, value) in &frame.props {
            add(name, value);
        }
        if let Some(easing) = &frame.easing {
            parse_easing(easing)?;
            add("animation-timing-function", easing);
        }
        let keyframe = Keyframe {
            selector: KeyframeSelectors::new_for_unit_testing(vec![KeyframePercentage::new(
                frame.offset.clamp(0.0, 1.0) as f32,
            )]),
            block: Arc::new(lock.wrap(block)),
            source_location: SourceLocation { line: 0, column: 0 },
        };
        keyframes.push(Arc::new(lock.wrap(keyframe)));
    }
    let guard = lock.read();
    Ok(Arc::new(KeyframesAnimation::from_keyframes(
        &keyframes, None, &guard,
    )))
}

/// The animation's current time follows `hold` when set (paused, idle-seeked, finished),
/// otherwise the shared animation clock from `start` at `rate`; all in ms.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Playback {
    pub start_epoch_ms: Option<f64>,
    pub hold_ms: Option<f64>,
    pub rate: f64,
}

impl Playback {
    fn local_time(&self, now_ms: f64) -> Option<f64> {
        self.hold_ms.or_else(|| {
            self.start_epoch_ms
                .map(|start| (now_ms - start) * self.rate)
        })
    }
}

struct Effect {
    target: Option<NodeId>,
    keyframes: Option<Arc<KeyframesAnimation>>,
    timing: Timing,
    playback: Playback,
    attached: Option<(NodeId, Arc<KeyframesAnimation>)>, // stylo set + keyframes it holds
}

/// Every live `Animation` with a keyframe effect, by id. Ids are creation order, which is
/// also script-animation composite order, so a BTreeMap keeps stylo's sets sorted.
#[derive(Default)]
pub(crate) struct Waapi {
    effects: BTreeMap<u32, Effect>,
    detached: Vec<(u32, NodeId)>,
}

fn set_key(node: NodeId) -> AnimationSetKey {
    AnimationSetKey::new_for_non_pseudo(OpaqueNode(node.as_u64() as usize))
}

impl Waapi {
    pub(crate) fn set_effect(
        &mut self,
        doc: &BaseDocument,
        id: u32,
        target: Option<NodeId>,
        keyframes_json: &str,
        timing: Timing,
    ) -> Result<(), String> {
        let keyframes = match target {
            Some(_) => Some(parse_keyframes(doc, keyframes_json)?),
            None => None,
        };
        let playback = self
            .effects
            .get(&id)
            .map(|e| e.playback)
            .unwrap_or_default();
        if let Some(old) = self.effects.remove(&id) {
            if let Some((node, _)) = old.attached {
                self.detached.push((id, node));
            }
        }
        self.effects.insert(
            id,
            Effect {
                target,
                keyframes,
                timing,
                playback,
                attached: None,
            },
        );
        Ok(())
    }

    pub(crate) fn set_playback(&mut self, id: u32, playback: Playback) {
        if let Some(effect) = self.effects.get_mut(&id) {
            effect.playback = playback;
        }
    }

    pub(crate) fn remove(&mut self, id: u32) {
        if let Some(Effect {
            attached: Some((node, _)),
            ..
        }) = self.effects.remove(&id)
        {
            self.detached.push((id, node));
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.effects.is_empty() && self.detached.is_empty()
    }

    /// Push every effect's progress at `now_ms` into stylo and restyle the targets whose
    /// output changed. Returns whether any effect will change as the clock advances.
    pub(crate) fn sample(&mut self, doc: &mut BaseDocument, now_ms: f64) -> bool {
        let mut restyle = Vec::new();
        let mut running = false;
        {
            let animations = doc.animations().clone();
            let mut sets = animations.sets.write();
            for (id, node) in self.detached.drain(..) {
                if let Some(set) = sets.get_mut(&set_key(node)) {
                    set.script_animations.retain(|a| a.id() != u64::from(id));
                    restyle.push(node);
                }
            }
            for (&id, effect) in self.effects.iter_mut() {
                let (Some(target), Some(keyframes)) = (effect.target, effect.keyframes.clone())
                else {
                    continue;
                };
                if !doc
                    .get_node(target)
                    .is_some_and(|n| n.flags.is_in_document())
                {
                    continue;
                }
                let local = effect.playback.local_time(now_ms);
                let timing = computed_timing(&effect.timing, local, effect.playback.rate);
                let set = sets.entry(set_key(target)).or_default();
                // Stylo can drop an element's animation set with its style, so an effect we
                // attached earlier may be gone: re-attach it rather than trust the bookkeeping.
                let fresh = !effect
                    .attached
                    .as_ref()
                    .is_some_and(|(n, k)| *n == target && Arc::ptr_eq(k, &keyframes))
                    || !set
                        .script_animations
                        .iter()
                        .any(|a| a.id() == u64::from(id));
                if fresh {
                    set.script_animations.retain(|a| a.id() != u64::from(id));
                    let at = set
                        .script_animations
                        .partition_point(|a| a.id() < u64::from(id));
                    set.script_animations
                        .insert(at, ScriptAnimation::new(u64::from(id), keyframes.clone()));
                    effect.attached = Some((target, keyframes));
                }
                let Some(entry) = set
                    .script_animations
                    .iter_mut()
                    .find(|a| a.id() == u64::from(id))
                else {
                    continue;
                };
                if entry.set_progress(timing.progress) || fresh {
                    restyle.push(target);
                }
                let playing = effect.playback.hold_ms.is_none()
                    && effect.playback.start_epoch_ms.is_some()
                    && effect.playback.rate != 0.0;
                let ahead = local.is_some_and(|t| {
                    if effect.playback.rate > 0.0 {
                        t < timing.end_time
                    } else {
                        t > 0.0
                    }
                });
                running |= playing && ahead;
            }
        }
        for node in restyle {
            if let Some(node) = doc.get_node_mut(node) {
                node.set_restyle_hint(RestyleHint::RESTYLE_SELF);
            }
        }
        running
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::query_selector_id;

    // Animates `selector`'s opacity 0 -> 1 over 1 s and seeks it to 250 ms.
    fn animated_dom(html: &str, selector: &str) -> (crate::DomHandle, u32) {
        let dom = crate::DomHandle::new(html, "https://test.example/");
        dom.resolve_layout();
        let node_id = query_selector_id(&dom, selector);
        let keyframes = r#"[
            {"offset":0,"props":[["opacity","0"]]},
            {"offset":1,"props":[["opacity","1"]]}
        ]"#;
        let timing = [0.0, 0.0, 1000.0, 1.0, 0.0, 0.0, 0.0];
        dom.waapi_set_effect(1, node_id, keyframes, &timing, "linear")
            .expect("valid effect");
        dom.waapi_set_playback(1, None, Some(250.0), 1.0);
        dom.resolve_layout();
        (dom, node_id)
    }

    fn opacity(dom: &crate::DomHandle, node_id: u32) -> String {
        dom.computed_style_value(node_id, "opacity")
            .expect("computed opacity")
    }

    fn timing(fill: Fill, direction: Direction, iterations: f64, delay: f64) -> Timing {
        Timing {
            delay,
            end_delay: 0.0,
            duration: 1000.0,
            iterations,
            iteration_start: 0.0,
            direction,
            fill,
            easing: parse_easing("linear").unwrap(),
        }
    }

    // Expectations are Chrome 155's getComputedTiming() for the same timing and time,
    // taken with the chrome-devtools MCP.
    #[test]
    fn phases_fill_and_direction_match_chrome() {
        let none = timing(Fill::None, Direction::Normal, 1.0, 500.0);
        assert_eq!(computed_timing(&none, Some(100.0), 1.0).progress, None);
        let back = timing(Fill::Backwards, Direction::Normal, 1.0, 500.0);
        assert_eq!(computed_timing(&back, Some(100.0), 1.0).progress, Some(0.0));
        let alt = timing(Fill::None, Direction::Alternate, 3.0, 0.0);
        let at = computed_timing(&alt, Some(1250.0), 1.0);
        assert_eq!((at.progress, at.current_iteration), (Some(0.75), Some(1.0)));
        let fwd = timing(Fill::Forwards, Direction::Normal, 1.0, 0.0);
        let end = computed_timing(&fwd, Some(5000.0), 1.0);
        assert_eq!(
            (end.phase, end.progress, end.current_iteration),
            (Phase::After, Some(1.0), Some(0.0))
        );
    }

    #[test]
    fn effect_easing_applies_to_the_directed_progress() {
        let mut t = timing(Fill::None, Direction::Normal, 1.0, 0.0);
        t.easing = parse_easing("ease-in").unwrap();
        let p = computed_timing(&t, Some(300.0), 1.0).progress.unwrap();
        assert!((p - 0.12957676074547098).abs() < 1e-6, "{p}");
        assert!(parse_easing("bogus").is_err());
        assert!(parse_easing("initial").is_err());
    }

    #[test]
    fn infinite_iterations_give_an_infinite_active_duration() {
        let t = timing(Fill::Forwards, Direction::Normal, f64::INFINITY, 0.0);
        let at = computed_timing(&t, Some(2500.0), 1.0);
        assert_eq!(
            (at.phase, at.progress, at.active_duration),
            (Phase::Active, Some(0.5), f64::INFINITY)
        );
    }

    #[test]
    fn progress_changes_reapply_script_animation_values() {
        let (dom, node_id) = animated_dom("<div id=t></div>", "#t");
        assert_eq!(opacity(&dom, node_id), "0.25");

        dom.waapi_set_playback(1, None, Some(750.0), 1.0);
        dom.resolve_layout();

        assert_eq!(opacity(&dom, node_id), "0.75");
    }

    #[test]
    fn script_animation_does_not_reach_a_reused_wasm32_slot() {
        let (dom, old) = animated_dom(
            "<div id=host><div id=old></div><div id=dummy></div></div>",
            "#old",
        );
        let host = query_selector_id(&dom, "#host");
        let dummy = query_selector_id(&dom, "#dummy");
        assert_eq!(opacity(&dom, old), "0.25");

        let old_internal = dom.resolve_node_id(old).expect("mapped old child");
        // wasm32's OpaqueNode is the slot index alone; forge that key form on the 64-bit host.
        let truncated_key =
            AnimationSetKey::new_for_non_pseudo(OpaqueNode(old_internal.as_u64() as u32 as usize));
        let doc = dom.doc.borrow();
        let mut sets = doc.animations().sets.write();
        let old_set = sets
            .remove(&set_key(old_internal))
            .expect("old child has an animation set");
        assert_eq!(old_set.script_animations.len(), 1);
        sets.insert(truncated_key.clone(), old_set);
        drop(sets);
        drop(doc);

        assert!(dom.drop_node(old), "old child dropped explicitly");
        let doc = dom.doc.borrow();
        assert!(
            !doc.animations().sets.read().contains_key(&truncated_key),
            "the truncated animation set must be gone before the slot is reused"
        );
        drop(doc);
        assert!(dom.drop_node(dummy), "reuse spacer dropped explicitly");
        let ops =
            format!(r#"[{{"kind":"setInnerHtml","node":{host},"html":"<div id=new></div>"}}]"#);
        assert_eq!(dom.apply_ops(&ops).expect("innerHTML applied"), 1);
        dom.resolve_layout();

        let new = query_selector_id(&dom, "#new");
        let new_internal = dom.resolve_node_id(new).expect("mapped new child");
        assert_ne!(old_internal, new_internal);
        assert_eq!(old_internal.as_u64() as u32, new_internal.as_u64() as u32);
        assert_eq!(opacity(&dom, new), "1");
    }
}
