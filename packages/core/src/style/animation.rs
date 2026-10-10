// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Web Animations calls and CSS transition and animation events.

use wasm_bindgen::prelude::*;

use crate::DomHandle;
use crate::style::transitions::{AnimationEvent, TransitionEvent};

#[wasm_bindgen]
impl DomHandle {
    #[wasm_bindgen(js_name = "hasPendingTransitions")]
    pub fn has_pending_transitions(&self) -> bool {
        self.transition_states
            .try_borrow()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    /// Create or replace animation `id`'s keyframe effect on `node_id` (0: no target).
    /// Errs with the TypeError message Chrome throws for an invalid easing.
    #[wasm_bindgen(js_name = "waapiSetEffect")]
    pub fn waapi_set_effect(
        &self,
        id: u32,
        node_id: u32,
        keyframes_json: &str,
        timing: &[f64],
        easing: &str,
    ) -> Result<(), JsError> {
        let timing =
            crate::style::waapi::parse_timing(timing, easing).map_err(|e| JsError::new(&e))?;
        let target = if node_id == 0 {
            None
        } else {
            self.resolve_node_id(node_id)
        };
        let doc = self
            .doc
            .try_borrow()
            .map_err(|_| JsError::new("document is busy"))?;
        self.waapi
            .borrow_mut()
            .set_effect(doc.as_ref(), id, target, keyframes_json, timing)
            .map_err(|e| JsError::new(&e))?;
        drop(doc);
        self.layout_dirty.set(true);
        Ok(())
    }

    /// Animation `id`'s current time is `hold_ms` when given, else the animation clock
    /// (Date.now()-based epoch ms, as `now_for_animations`) since `start_epoch_ms` at `rate`.
    #[wasm_bindgen(js_name = "waapiSetPlayback")]
    pub fn waapi_set_playback(
        &self,
        id: u32,
        start_epoch_ms: Option<f64>,
        hold_ms: Option<f64>,
        rate: f64,
    ) {
        self.waapi.borrow_mut().set_playback(
            id,
            crate::style::waapi::Playback {
                start_epoch_ms,
                hold_ms,
                rate,
            },
        );
        self.layout_dirty.set(true);
    }

    /// Return `getComputedTiming()` fields from the same model sampled by the cascade.
    /// Returns `[phase, activeDuration, endTime, progress, currentIteration]`; phase is 0
    /// before, 1 active, 2 after, 3 idle. Missing progress or iteration is NaN; the shim maps
    /// it to null.
    #[wasm_bindgen(js_name = "waapiComputedTiming")]
    pub fn waapi_computed_timing(
        &self,
        timing: &[f64],
        easing: &str,
        local_time: Option<f64>,
        rate: f64,
    ) -> Result<Vec<f64>, JsError> {
        let timing =
            crate::style::waapi::parse_timing(timing, easing).map_err(|e| JsError::new(&e))?;
        let out = crate::style::waapi::computed_timing(&timing, local_time, rate);
        let phase = match out.phase {
            crate::style::waapi::Phase::Before => 0.0,
            crate::style::waapi::Phase::Active => 1.0,
            crate::style::waapi::Phase::After => 2.0,
            crate::style::waapi::Phase::Idle => 3.0,
        };
        Ok(vec![
            phase,
            out.active_duration,
            out.end_time,
            out.progress.unwrap_or(f64::NAN),
            out.current_iteration.unwrap_or(f64::NAN),
        ])
    }

    /// Drop animation `id` (canceled, or its Animation collected); its target restyles
    /// without it on the next resolve.
    #[wasm_bindgen(js_name = "waapiRemove")]
    pub fn waapi_remove(&self, id: u32) {
        self.waapi.borrow_mut().remove(id);
        self.layout_dirty.set(true);
    }

    /// Whether the resolve should collect CSS animation events. Only
    /// true while the isolate has an `animation*` listener; see the
    /// `animation_events_requested` field docs. Flips on
    /// `armTransitionDrain(true/false)` in page-script.
    #[wasm_bindgen(js_name = "setAnimationEventsRequested")]
    pub fn set_animation_events_requested(&self, requested: bool) {
        let was = self.animation_events_requested.get();
        self.animation_events_requested.set(requested);
        if requested && !was {
            if let (Ok(doc), Ok(mut states)) = (
                self.doc.try_borrow(),
                self.animation_states.try_borrow_mut(),
            ) {
                crate::style::transitions::refresh_tracked_ranks(doc.as_ref(), &mut states);
            }
        } else if !requested {
            self.animation_events.borrow_mut().clear();
        }
    }

    /// Does not resolve. The drain tick in transitions.ts decides whether its turn needs
    /// `resolveLayout`; a resolve here would re-cascade every running animation on each tick.
    #[wasm_bindgen(js_name = "takeTransitionEvents")]
    pub fn take_transition_events(&self) -> Result<JsValue, JsError> {
        let drained: Vec<TransitionEvent> = match self.transition_events.try_borrow_mut() {
            Ok(mut e) => std::mem::take(&mut *e),
            Err(_) => Vec::new(),
        };
        serde_wasm_bindgen::to_value(&drained).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Does not resolve, like `takeTransitionEvents`.
    #[wasm_bindgen(js_name = "takeAnimationEvents")]
    pub fn take_animation_events(&self) -> Result<JsValue, JsError> {
        let drained: Vec<AnimationEvent> = match self.animation_events.try_borrow_mut() {
            Ok(mut e) => std::mem::take(&mut *e),
            Err(_) => Vec::new(),
        };
        serde_wasm_bindgen::to_value(&drained).map_err(|e| JsError::new(&e.to_string()))
    }
}
