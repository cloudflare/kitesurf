// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Wasm-facing document core: owns page DOM state and exposes style, layout,
//! paint, and resource APIs.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use blitz_dom::{
    BaseDocument, DocumentConfig, NodeData, UserAgentStylesheet, DEFAULT_CSS as BLITZ_DEFAULT_CSS,
};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::NodeId;
use wasm_bindgen::prelude::*;

use paint::render::{DamageFanout, RbiImageRecency};
use style::transitions::{
    collect_animation_events, AnimationEvent, AnimationStates, TransitionEvent, TransitionStates,
};

mod dom;
mod js;
#[cfg(target_arch = "wasm32")]
mod boa_code_store;
#[cfg(any(target_arch = "wasm32", test))]
mod small_alloc;
#[cfg(target_arch = "wasm32")]
mod swap_alloc;

// The counting allocator: it is what lets the store know when wasm memory is under pressure,
// so the store's own paths are the only callers of its hook.
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: swap_alloc::SwapAlloc = swap_alloc::SwapAlloc;
mod ks_tracing;
mod layout;
mod paint;
mod resources;
mod style;
#[cfg(test)]
mod test_assets;
#[cfg(test)]
mod test_support;
mod text_encoding;
mod tty;

type HandleMap<K, V> = rustc_hash::FxHashMap<K, V>;

/// Stable `u32` handles for nodes, as given out to JS. Seeded nodes take handle
/// `slot - 1` (the root is handle 0), so only their versions are stored.
/// `sparse_latest` and `latest_beyond` track later generations; older ones that
/// still resolve stay in `displaced`.
pub(crate) struct NodeHandleMap {
    next_external: u32,
    /// The version seeded handle `e` was given for slot `e + 1`; 0 for a slot
    /// that was free when seeded, or once the handle is retired.
    seeded_versions: SeededVersions,
    dynamic_forward: HandleMap<u32, NodeId>,
    /// Latest handle of each slot past the seeded range, from its first slot.
    latest_beyond: Vec<u32>,
    /// Latest handle of a seeded-range slot that has one besides its seeded
    /// handle (`NO_EXTERNAL` once that one is retired), and of outlier slots.
    sparse_latest: HandleMap<u32, u32>,
    displaced: HandleMap<NodeId, u32>,
}

/// [`NodeHandleMap::seeded_versions`] in about two bits a slot: almost every
/// slot of a parsed tree holds its first version, so only the others are kept.
struct SeededVersions {
    len: usize,
    /// Bit `e`: handle `e` is live.
    live: Box<[u32]>,
    /// Bit `e`: handle `e`'s version is in `other`, not [`Self::FIRST`].
    has_other: Box<[u32]>,
    other: HandleMap<u32, u32>,
}

impl SeededVersions {
    /// The version a node tree gives a slot's first node.
    const FIRST: u32 = 1;
    /// The version of a handle that is no longer live.
    const RETIRED: u32 = 0;

    fn new(len: usize, versions: impl IntoIterator<Item = (usize, u32)>) -> Self {
        let words = len.div_ceil(32);
        let mut seeded = Self {
            len,
            live: vec![0; words].into_boxed_slice(),
            has_other: vec![0; words].into_boxed_slice(),
            other: HandleMap::default(),
        };
        for (index, version) in versions {
            debug_assert_ne!(version, Self::RETIRED, "a live node's version is never 0");
            Self::set(&mut seeded.live, index);
            if version != Self::FIRST {
                Self::set(&mut seeded.has_other, index);
                seeded.other.insert(index as u32, version);
            }
        }
        seeded
    }

    #[inline]
    fn len(&self) -> usize {
        self.len
    }

    /// Set bit `index` of `bits`, which packs 32 slots to a word.
    #[inline]
    fn set(bits: &mut [u32], index: usize) {
        bits[index / 32] |= 1 << (index % 32);
    }

    /// Clear bit `index` of `bits`.
    #[inline]
    fn clear(bits: &mut [u32], index: usize) {
        bits[index / 32] &= !(1 << (index % 32));
    }

    #[inline]
    fn bit(bits: &[u32], index: usize) -> bool {
        bits[index / 32] & (1 << (index % 32)) != 0
    }

    /// Handle `index`'s version, [`Self::RETIRED`] once retired; `None` past the seeded range.
    #[inline]
    fn get(&self, index: usize) -> Option<u32> {
        if index >= self.len {
            return None;
        }
        if !Self::bit(&self.live, index) {
            return Some(Self::RETIRED);
        }
        if !Self::bit(&self.has_other, index) {
            return Some(Self::FIRST);
        }
        Some(self.other[&(index as u32)])
    }

    /// Retire handle `index`, returning whether it is in the seeded range.
    fn retire(&mut self, index: usize) -> bool {
        if index >= self.len {
            return false;
        }
        Self::clear(&mut self.live, index);
        if Self::bit(&self.has_other, index) {
            Self::clear(&mut self.has_other, index);
            self.other.remove(&(index as u32));
        }
        true
    }
}

#[inline]
fn slot_of(id: NodeId) -> usize {
    id.as_u64() as u32 as usize
}

impl NodeHandleMap {
    const NO_EXTERNAL: u32 = u32::MAX;

    fn seeded(doc: &BaseDocument) -> Self {
        let root = doc.root_node().id();
        assert_eq!(slot_of(root), 1, "the document root must be handle 0");
        let slots = doc
            .tree()
            .iter()
            .map(|(id, _)| slot_of(id))
            .max()
            .unwrap_or(0);
        let seeded_versions = SeededVersions::new(
            slots,
            doc.tree()
                .iter()
                .map(|(id, _)| (slot_of(id) - 1, (id.as_u64() >> 32) as u32)),
        );
        Self {
            next_external: u32::try_from(slots).expect("external node handle space exhausted"),
            seeded_versions,
            dynamic_forward: HandleMap::default(),
            latest_beyond: Vec::new(),
            sparse_latest: HandleMap::default(),
            displaced: HandleMap::default(),
        }
    }

    /// The live seeded handle for `slot`, if any (slot 0 is the node tree's sentinel).
    #[inline]
    fn seeded_external(&self, slot: usize) -> Option<u32> {
        let index = slot.checked_sub(1)?;
        (self.seeded_versions.get(index)? != SeededVersions::RETIRED).then_some(index as u32)
    }

    #[inline]
    fn latest(&self, slot: usize) -> Option<u32> {
        let seeded = self.seeded_versions.len();
        let latest = match self.sparse_latest.get(&(slot as u32)) {
            Some(&external) => external,
            None if slot > seeded => *self.latest_beyond.get(slot - seeded - 1)?,
            None => return self.seeded_external(slot),
        };
        (latest != Self::NO_EXTERNAL).then_some(latest)
    }

    #[inline]
    pub(crate) fn resolve(&self, external: u32) -> Option<NodeId> {
        let Some(version) = self.seeded_versions.get(external as usize) else {
            return self.dynamic_forward.get(&external).copied();
        };
        (version != SeededVersions::RETIRED)
            .then(|| NodeId::from_u64((u64::from(version) << 32) | u64::from(external + 1)))
    }

    #[inline]
    pub(crate) fn external_for_opaque(&self, opaque: usize) -> Option<u32> {
        let id = NodeId::from_u64(opaque as u64);
        // An opaque ID carries the generation on 64-bit, but not on wasm32, where
        // the slot's latest handle is the only answer available.
        if usize::BITS == 32 {
            return self.latest(slot_of(id));
        }
        self.existing_external(id)
    }

    #[inline]
    pub(crate) fn existing_external(&self, id: NodeId) -> Option<u32> {
        self.latest(slot_of(id))
            .filter(|&external| self.resolve(external) == Some(id))
            .or_else(|| self.displaced.get(&id).copied())
    }

    fn external_for_live_opaque(&mut self, doc: &BaseDocument, opaque: usize) -> Option<u32> {
        // OpaqueNode omits the NodeId generation on wasm32; check its slot against the live tree.
        if let Some(external) = self.external_for_opaque(opaque) {
            if self.resolve(external).is_some_and(|internal| {
                internal.as_u64() as usize == opaque && doc.get_node(internal).is_some()
            }) {
                return Some(external);
            }
        }

        let internal = doc
            .tree()
            .iter()
            .find_map(|(id, _)| (id.as_u64() as usize == opaque).then_some(id))?;
        Some(self.external_for(internal))
    }

    #[inline]
    pub(crate) fn external_for(&mut self, internal: NodeId) -> u32 {
        if let Some(external) = self.existing_external(internal) {
            return external;
        }
        let external = self.next_external;
        self.next_external = self
            .next_external
            .checked_add(1)
            .expect("external node handle space exhausted");
        self.dynamic_forward.insert(external, internal);

        if let Some(previous) = self.set_latest(slot_of(internal), external) {
            // The older generation still resolves, so keep its handle reachable.
            if let Some(previous_id) = self.resolve(previous) {
                self.displaced.insert(previous_id, previous);
            }
        }
        external
    }

    /// Make `external` the latest handle of `slot` and return the one it replaced.
    fn set_latest(&mut self, slot: usize, external: u32) -> Option<u32> {
        if slot <= self.seeded_versions.len() {
            // Slots are reused rarely, so the seeded range keeps its other handles sparse.
            self.sparse_latest
                .insert(slot as u32, external)
                .or_else(|| self.seeded_external(slot))
        } else if slot > self.next_external as usize {
            // A forged ID must not allocate a reverse vector up to its slot, so
            // outliers take a sparse entry rather than grow the dense vector.
            self.sparse_latest.insert(slot as u32, external)
        } else {
            self.set_latest_beyond(slot, external)
        }
    }

    /// Store `external` in the dense reverse index, growing it to cover the slot.
    fn set_latest_beyond(&mut self, slot: usize, external: u32) -> Option<u32> {
        let index = slot - self.seeded_versions.len() - 1;
        if index >= self.latest_beyond.len() {
            self.grow_latest_beyond(index);
        }

        let previous = self
            .sparse_latest
            .remove(&(slot as u32))
            .unwrap_or(self.latest_beyond[index]);
        self.latest_beyond[index] = external;
        Some(previous)
    }

    /// Grow the dense reverse index to cover `index`, by an eighth of its length
    /// per step: doubling for one new slot would hold megabytes of headroom on a
    /// large document.
    fn grow_latest_beyond(&mut self, index: usize) {
        let len = self.latest_beyond.len();
        if index >= self.latest_beyond.capacity() {
            self.latest_beyond
                .reserve_exact((index + 1 - len).max(len / 8));
        }
        self.latest_beyond.resize(index + 1, Self::NO_EXTERNAL);
    }

    fn retire(&mut self, internal: NodeId) {
        let Some(external) = self.existing_external(internal) else {
            return;
        };
        let slot = slot_of(internal);
        self.forget_handle(slot, external);
        self.displaced.remove(&internal);
        self.forget_latest(slot, external);
    }

    /// Drop `external` itself: a seeded version, or the dynamic forward entry.
    fn forget_handle(&mut self, slot: usize, external: u32) {
        if !self.seeded_versions.retire(external as usize) {
            self.dynamic_forward.remove(&external);
            return;
        }
        // The slot's tombstone only shadowed this handle.
        if self.sparse_latest.get(&(slot as u32)) == Some(&Self::NO_EXTERNAL) {
            self.sparse_latest.remove(&(slot as u32));
        }
    }

    /// Leave the slot without a latest handle if `external` was it. A displaced
    /// seeded handle must not become the slot's latest again.
    fn forget_latest(&mut self, slot: usize, external: u32) {
        if self.sparse_latest.get(&(slot as u32)) == Some(&external) {
            if self.seeded_external(slot).is_some() {
                self.sparse_latest.insert(slot as u32, Self::NO_EXTERNAL);
            } else {
                self.sparse_latest.remove(&(slot as u32));
            }
        }

        let seeded = self.seeded_versions.len();
        if let Some(current) = slot
            .checked_sub(seeded + 1)
            .and_then(|index| self.latest_beyond.get_mut(index))
        {
            if *current == external {
                *current = Self::NO_EXTERNAL;
            }
        }
    }
}

#[cfg(test)]
fn blitz_node_id(external: u32) -> NodeId {
    NodeId::from_u64((1u64 << 32) | u64::from(external + 1))
}

#[cfg(test)]
fn wasm_node_id(internal: NodeId) -> u32 {
    (internal.as_u64() as u32) - 1
}

#[wasm_bindgen(start)]
pub fn start() {
    install_panic_hook();
    ks_tracing::init();
    style::cssom::init_style_prefs();
}

fn install_panic_hook() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let payload = info.payload();
            let msg: &str = if let Some(s) = payload.downcast_ref::<&str>() {
                s
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.as_str()
            } else {
                ""
            };
            let location = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_default();
            let stylo_cascade = location.contains("stylo")
                || location.contains("data.rs")
                || msg.contains("primary_styles")
                || msg.contains("Option::unwrap()` on a `None` value");
            let refcell_cascade =
                msg.contains("RefCell already") || msg.contains("already mutably borrowed");
            if stylo_cascade || refcell_cascade {
                ks_panic_log(&location, msg);
                return;
            }
            #[cfg(feature = "console_error_panic_hook")]
            console_error_panic_hook::hook(info);
        }));
    });
}

// Console-error extern + JS `Error` constructor for stack capture.
// Bare extern matches the technique `console_error_panic_hook` itself
// uses internally (see registry source); keeps the dep graph unchanged.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(msg: &str);

    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(msg: &str);
}

pub(crate) fn console_warn_str(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    console_warn(msg);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{msg}");
}

#[wasm_bindgen]
extern "C" {

    // FFI: Keep a distinct Rust name because `JsError` is imported; `js_class`
    // still binds this type to the global JavaScript `Error` constructor.
    #[wasm_bindgen(js_name = "Error")]
    type KsPanicError;

    #[wasm_bindgen(constructor, js_class = "Error")]
    fn new() -> KsPanicError;

    #[wasm_bindgen(structural, method, getter, js_class = "Error")]
    fn stack(this: &KsPanicError) -> String;
}

fn ks_panic_log(location: &str, msg: &str) {
    let err = KsPanicError::new();
    let stack = err.stack();
    let head = if location.is_empty() {
        format!("[cs panic] {}", msg)
    } else {
        format!("[cs panic] @{} :: {}", location, msg)
    };
    let full = format!("{}\n{}", head, stack);
    console_error(&full);
}

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
enum LayoutMode {
    Full,
    Off,
}

#[cfg(test)]
pub(crate) static STYLE_CASCADE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

static DIMS_ONLY_IMAGES: AtomicBool = AtomicBool::new(false);

thread_local! {
    static TTY_UA_SHEET: RefCell<Option<UserAgentStylesheet>> =
        const { RefCell::new(None) };
}

#[wasm_bindgen(js_name = "setTtyUaCss")]
pub fn set_tty_ua_css(css: String) {
    TTY_UA_SHEET.with(|c| {
        *c.borrow_mut() = if css.trim().is_empty() {
            None
        } else {
            Some(UserAgentStylesheet::parse(&css))
        };
    });
}

thread_local! {
    static TTY_CELL: Cell<Option<(f32, f32)>> = const { Cell::new(None) };
}

#[wasm_bindgen(js_name = "setTtyCellGrid")]
pub fn set_tty_cell_grid(w: f32, h: f32) {
    let ok = |v: f32| v.is_finite() && v >= 1.0;
    TTY_CELL.with(|c| c.set(if ok(w) && ok(h) { Some((w, h)) } else { None }));
}

fn tty_ua_sheet() -> Option<UserAgentStylesheet> {
    TTY_UA_SHEET.with(|c| c.borrow().clone())
}

static DARK_COLOR_SCHEME: AtomicBool = AtomicBool::new(false);

#[wasm_bindgen(js_name = "setDarkColorScheme")]
pub fn set_dark_color_scheme(dark: bool) {
    DARK_COLOR_SCHEME.store(dark, Ordering::Relaxed);
}

pub(crate) fn dark_color_scheme() -> bool {
    DARK_COLOR_SCHEME.load(Ordering::Relaxed)
}

pub(crate) fn emulated_color_scheme() -> blitz_traits::shell::ColorScheme {
    use blitz_traits::shell::ColorScheme;
    if dark_color_scheme() {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    }
}

#[wasm_bindgen(js_name = "setDimsOnlyImages")]
pub fn set_dims_only_images(enabled: bool) {
    DIMS_ONLY_IMAGES.store(enabled, Ordering::Relaxed);
}

pub(crate) fn renderer_mode() -> bool {
    DIMS_ONLY_IMAGES.load(Ordering::Relaxed)
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static ANIMATION_CLOCK: Cell<Option<f64>> = const { Cell::new(None) };
}

fn now_for_animations() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        if let Some(now) = ANIMATION_CLOCK.get() {
            return now;
        }
        // Local workerd advances Date.now() during synchronous script execution, so layout flushes
        // share one sample until the script yields.
        wasm_bindgen_futures::spawn_local(async {
            ANIMATION_CLOCK.set(None);
        });
        // Date.now() can freeze during execution, so the parent stamps its own clock onto every
        // message and page-script mirrors the max into ksInternals.clockFloorMs. Take whichever
        // clock is further along.
        let mut now_ms = js_sys::Date::now();
        if let Some(floor) = js::internals::get("clockFloorMs").and_then(|v| v.as_f64()) {
            if floor > now_ms {
                now_ms = floor;
            }
        }
        let now = now_ms / 1000.0;
        ANIMATION_CLOCK.set(Some(now));
        now
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    }
}

/// Resolve-pipeline dirtiness. Every change that dirties layout also dirties styles, so a
/// style-only flush (`ensure_style`) stays valid until the next one.
struct LayoutDirty {
    layout: std::cell::Cell<bool>,
    style: std::cell::Cell<bool>,
}

impl LayoutDirty {
    fn new() -> Self {
        Self {
            layout: std::cell::Cell::new(true),
            style: std::cell::Cell::new(true),
        }
    }

    fn get(&self) -> bool {
        self.layout.get()
    }

    fn set(&self, dirty: bool) {
        self.layout.set(dirty);
        self.style.set(dirty);
    }
}

/// Holds one page's DOM and associated mutable state behind the Wasm handle.
/// Dropping the handle releases that state; Boa fast-path references hold only weak links.
#[wasm_bindgen]
pub struct DomHandle {
    // Rc so the boa→blitz fast path (dom_fastpath.rs) can hold a Weak
    // and never dangle if JS frees the handle: upgrade fails → slow path.
    doc: Rc<RefCell<HtmlDocument>>,
    /// Maps blitz node IDs to the stable IDs JavaScript and CDP see. Shared with the Boa fast
    /// path, which mints IDs for nodes it returns.
    node_handles: Rc<RefCell<NodeHandleMap>>,
    /// The document URL; relative URLs resolve against it.
    base_url: String,
    /// Set by DOM and viewport changes; the next geometry read runs a resolve.
    layout_dirty: LayoutDirty,
    /// A transition or animation was running at the last resolve, so later reads resolve again
    /// even when the DOM is unchanged.
    animating: Cell<bool>,
    /// Animation clock of the last resolve. An animating page skips a resolve when the clock has
    /// not advanced.
    last_resolve_now: Cell<f64>,
    /// Bumped by every resolve that succeeded (a panicked one leaves it), so a size
    /// poll can tell "nothing relaid out since I looked" without re-reading geometry.
    layout_epoch: Cell<u32>,
    /// Resolves run so far: `[mutation-driven, animation-only]`. An animation-only resolve
    /// re-cascades every running animation with nothing else to show for it. Reported through
    /// Kitesurf.getMemoryStats.
    resolve_counts: std::cell::Cell<[u32; 2]>,
    #[cfg(test)]
    style_passes: std::cell::Cell<u32>,
    /// Per-(node, property) transition state as of the last resolve.
    /// Diffed against the next one to synthesise the DOM events;
    /// stylo clears `is_new` before we ever see it.
    transition_states: RefCell<TransitionStates>,
    /// Transition events queued for `takeTransitionEvents`.
    transition_events: RefCell<Vec<TransitionEvent>>,
    /// Per-animation phase as of the last resolve, diffed like `transition_states`.
    animation_states: RefCell<AnimationStates>,
    /// Animation events queued for `takeAnimationEvents`.
    animation_events: RefCell<Vec<AnimationEvent>>,
    /// True while the page has an `animation*` listener. Resolves always track animation
    /// phases, but rank and queue events only while this is set.
    animation_events_requested: Cell<bool>,
    /// Element.animate effects. Each resolve samples them into stylo's script animations,
    /// and a running one keeps `animating` set the way a CSS animation does.
    waapi: RefCell<style::waapi::Waapi>,
    /// `Off` skips style and layout entirely, for callers that only need the DOM.
    layout_mode: Cell<LayoutMode>,
    /// `position: sticky` nodes found by the last layout.
    sticky_nodes: RefCell<Vec<NodeId>>,
    /// Sticky nodes from the previous layout, so a node that stops being sticky has its pin
    /// offset cleared.
    pinned_nodes: RefCell<Vec<NodeId>>,
    /// Page scroll position that sticky offsets are computed against.
    page_scroll: Cell<layout::sticky::PageScroll>,
    /// Resolved top, right, bottom, and left sticky insets per node, for computed style.
    sticky_insets: RefCell<HashMap<NodeId, [Option<f32>; 4]>>,
    /// Queues the document's resource fetches for the host and receives their results.
    net_provider: Arc<crate::resources::net::KitesurfNetProvider>,
    /// Backing surfaces for the page's `<canvas>` 2D contexts.
    canvas2d: RefCell<paint::canvas2d::CanvasRegistry>,
    // Resources referenced by recorded scenes, kept so the renderer can fetch the ones it lacks
    // (`getPaintResources`).
    /// Glyph outline paths by glyph hash.
    rbi_glyph_cache: RefCell<HashMap<u64, Vec<u8>>>,
    /// Glyphs whose outlines were already extracted, per font.
    rbi_glyph_seen: RefCell<crate::paint::scene_record::GlyphSeen>,
    /// Reverse cmap and advance tables per font, reused across recordings.
    rbi_font_tables: RefCell<crate::paint::scene_record::FontTableCache>,
    /// Font data and face index by font hash.
    rbi_font_bytes: RefCell<HashMap<u64, (peniko::Blob<u8>, u32)>>,
    /// Encoded images by image hash.
    rbi_image_cache: RefCell<HashMap<u64, crate::paint::scene_record::ImageInfo>>,
    /// Last recording that used each image, for evicting stale entries.
    rbi_image_recency: RefCell<RbiImageRecency>,
    /// The last scene recorded for the host to copy out of linear memory (`stagedScenePtr`).
    staged_scene: RefCell<Vec<u8>>,
    /// Shares blitz's single damage summary between screencast and other readers.
    damage_fanout: RefCell<DamageFanout>,
}

// wasm-bindgen requires this marker for exported receivers. The handle is
// isolate-local, unwinding drops its RefCell guards, and layout recovery clears
// style snapshots and rebuilds inline trees stranded by a panic.
impl std::panic::RefUnwindSafe for DomHandle {}

#[wasm_bindgen]
impl DomHandle {
    #[inline]
    fn resolve_node_id(&self, external: u32) -> Option<NodeId> {
        self.node_handles.borrow().resolve(external)
    }

    #[inline]
    fn external_node_id(&self, internal: NodeId) -> u32 {
        self.node_handles.borrow_mut().external_for(internal)
    }

    #[inline]
    fn external_node_id_i32(&self, internal: NodeId) -> i32 {
        self.external_node_id(internal) as i32
    }

    /// Parse `html` into a page document and use `base_url` for relative resources.
    /// Invalid URLs and URLs that cannot serve as a base use `https://kitesurf.local/`.
    #[wasm_bindgen(constructor)]
    pub fn new(html: &str, base_url: &str) -> DomHandle {
        use blitz_traits::shell::Viewport;
        let _ks_span =
            tracing::info_span!("wasm.parse_document", html_bytes = html.len()).entered();

        let net_provider = Arc::new(crate::resources::net::KitesurfNetProvider::new());

        let resolved_base = match url::Url::parse(base_url) {
            Ok(u) if !u.cannot_be_a_base() => base_url.to_string(),
            _ => "https://kitesurf.local/".to_string(),
        };

        let config = DocumentConfig {
            base_url: Some(resolved_base.clone()),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            net_provider: Some(net_provider.clone()),
            viewport: Some(Viewport::new(1280, 720, 1.0, emulated_color_scheme())),
            font_ctx: Some(crate::resources::fonts::get_or_init_font_context()),
            dims_only_images: DIMS_ONLY_IMAGES.load(Ordering::Relaxed),
            ..Default::default()
        };
        let mut doc = HtmlDocument::from_html(html, config);
        doc.shrink_node_storage();
        if let Some(sheet) = tty_ua_sheet() {
            doc.add_user_agent_stylesheet(sheet);
        }
        if let Some((cw, ch)) = TTY_CELL.with(|c| c.get()) {
            let base: &mut BaseDocument = doc.as_mut();
            base.set_round_grid(cw, ch);
        }
        let node_handles = NodeHandleMap::seeded(&doc);
        DomHandle {
            doc: Rc::new(RefCell::new(doc)),
            node_handles: Rc::new(RefCell::new(node_handles)),
            base_url: resolved_base,
            layout_dirty: LayoutDirty::new(),
            animating: Cell::new(false),
            last_resolve_now: Cell::new(f64::NEG_INFINITY),
            layout_epoch: Cell::new(0),
            resolve_counts: Cell::new([0, 0]),
            #[cfg(test)]
            style_passes: std::cell::Cell::new(0),
            transition_states: RefCell::new(TransitionStates::default()),
            transition_events: RefCell::new(Vec::new()),
            animation_states: RefCell::new(AnimationStates::default()),
            animation_events: RefCell::new(Vec::new()),
            animation_events_requested: Cell::new(false),
            waapi: RefCell::new(style::waapi::Waapi::default()),
            sticky_nodes: RefCell::new(Vec::new()),
            pinned_nodes: RefCell::new(Vec::new()),
            page_scroll: Cell::new(Default::default()),
            sticky_insets: RefCell::new(HashMap::new()),
            layout_mode: Cell::new(LayoutMode::Full),
            net_provider,
            canvas2d: RefCell::new(paint::canvas2d::CanvasRegistry::default()),
            rbi_glyph_cache: RefCell::new(HashMap::new()),
            rbi_glyph_seen: RefCell::new(Default::default()),
            rbi_font_tables: RefCell::new(Default::default()),
            rbi_font_bytes: RefCell::new(HashMap::new()),
            rbi_image_cache: RefCell::new(HashMap::new()),
            rbi_image_recency: RefCell::new(RbiImageRecency::default()),
            staged_scene: RefCell::new(Vec::new()),
            damage_fanout: RefCell::new(DamageFanout::default()),
        }
    }

    /// Parse `head + insert + tail` like [`DomHandle::new`]. Joining here, not in JS, avoids
    /// flattening a document-sized JS string that lives until the next major GC.
    #[wasm_bindgen(js_name = "newSpliced")]
    pub fn new_spliced(head: &str, insert: &str, tail: &str, base_url: &str) -> DomHandle {
        let mut html = String::with_capacity(head.len() + insert.len() + tail.len());
        html.push_str(head);
        html.push_str(insert);
        html.push_str(tail);
        DomHandle::new(&html, base_url)
    }

    /// Parse a UTF-8 document like [`DomHandle::new_spliced`], with `insert` at byte `insert_at`.
    /// Bytes let PageScript free the source right away; a JS string lives until a major GC.
    #[wasm_bindgen(js_name = "newUtf8")]
    pub fn new_utf8(source: &[u8], insert_at: usize, insert: &str, base_url: &str) -> DomHandle {
        let source = String::from_utf8_lossy(source);
        if insert.is_empty() || insert_at > source.len() || !source.is_char_boundary(insert_at) {
            return DomHandle::new(&source, base_url);
        }
        let (head, tail) = source.split_at(insert_at);
        DomHandle::new_spliced(head, insert, tail, base_url)
    }

    #[wasm_bindgen(js_name = "nodeCount")]
    pub fn node_count(&self) -> usize {
        match self.doc.try_borrow() {
            Ok(d) => d.tree().len(),
            Err(_) => 0,
        }
    }

    #[wasm_bindgen(js_name = "isPoisoned")]
    pub fn is_poisoned(&self) -> bool {
        self.doc.try_borrow().is_err()
    }

    #[wasm_bindgen(js_name = "panicProbe")]
    pub fn panic_probe(&self, kind: &str) -> i32 {
        match kind {
            "borrow-mut-then-panic" => {
                let _guard = self.doc.borrow_mut();
                panic!("[panic-probe] deliberate panic with borrow_mut guard live");
            }
            "noop" => 0,
            _ => -1,
        }
    }

    #[wasm_bindgen(js_name = "hasPendingCriticalResources")]
    pub fn has_pending_critical_resources(&self) -> bool {
        match self.doc.try_borrow() {
            Ok(d) => d.has_pending_critical_resources(),
            Err(_) => false,
        }
    }

    #[wasm_bindgen(js_name = "forceFullRestyle")]
    pub fn force_full_restyle(&self) -> u32 {
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let root_id = doc.root_node().id();
        let count = Cell::new(0u32);
        let count_ref = &count;
        doc.iter_subtree_mut(root_id, move |node_id, d| {
            if let Some(node) = d.get_node_mut(node_id) {
                if node
                    .try_stylo_element_data()
                    .is_some_and(|data| data.get().is_some())
                {
                    node.set_restyle_hint(
                        ::style::invalidation::element::restyle_hints::RestyleHint::restyle_subtree(
                        ),
                    );
                    count_ref.set(count_ref.get().saturating_add(1));
                }
            }
        });
        self.layout_dirty.set(true);
        count.get()
    }

    #[wasm_bindgen(js_name = "documentNodeId")]
    pub fn document_node_id(&self) -> u32 {
        0
    }

    #[wasm_bindgen(js_name = "prepareForPaint")]
    pub fn prepare_for_paint(&self, width: u32, height: u32) -> u32 {
        use blitz_traits::shell::Viewport;
        let _ks_span = tracing::info_span!("wasm.prepare_for_paint", width, height).entered();

        {
            let mut doc = match self.doc.try_borrow_mut() {
                Ok(d) => d,
                Err(_) => return 0,
            };
            let current = doc.as_ref().viewport();
            if current.window_size != (width, height) || current.scale_f64() != 1.0 {
                doc.as_mut().set_viewport(Viewport::new(
                    width,
                    height,
                    1.0,
                    emulated_color_scheme(),
                ));
            }
        }
        self.layout_dirty.set(true);

        let prev = self.layout_mode.get();
        if prev != LayoutMode::Full {
            self.layout_mode.set(LayoutMode::Full);
        }

        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return 0,
        };
        clear_unstyled_cascade(&mut doc)
    }

    fn flush_slot_assignments(&self) {
        if let Ok(mut doc) = self.doc.try_borrow_mut() {
            doc.flush_slot_assignments();
        }
    }

    fn resolve_until_images_settle(&self) {
        let count_pending = || match self.doc.try_borrow() {
            Ok(d) => d.as_ref().pending_images_count(),
            Err(_) => 0,
        };
        const MAX_RESOURCE_SETTLE_PASSES: usize = 3;
        let mut prev_pending = count_pending();
        for _ in 0..MAX_RESOURCE_SETTLE_PASSES {
            self.ensure_layout();
            let pending = count_pending();
            if pending == 0 || pending == prev_pending {
                break;
            }
            prev_pending = pending;
            self.layout_dirty.set(true);
        }
    }

    fn ensure_layout(&self) {
        self.flush_resolve(false);
    }

    /// For readers of computed values only: restyles without layout, which waits for the next
    /// geometry read or paint.
    fn ensure_style(&self) {
        self.flush_resolve(true);
    }

    fn flush_resolve(&self, requested_style_only: bool) {
        if self.layout_mode.get() == LayoutMode::Off {
            return;
        }
        let dirty = self.layout_dirty.get();
        if !dirty && !self.animating.get() {
            return;
        }
        let styles_fresh = requested_style_only && dirty && !self.layout_dirty.style.get();
        if styles_fresh && !self.animating.get() {
            return;
        }
        let now = now_for_animations();
        // Within one clock sample, a clean or already restyled document has nothing new to show.
        if (!dirty || styles_fresh) && now <= self.last_resolve_now.get() {
            return;
        }
        // An animation-only refresh keeps the full resolve it always ran.
        let style_only = requested_style_only && dirty;
        let mut doc = match self.doc.try_borrow_mut() {
            Ok(d) => d,
            Err(_) => return,
        };
        if !style_only {
            self.count_resolve(!dirty);
        }
        #[cfg(test)]
        let _cascade_guard = STYLE_CASCADE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let waapi_running = {
                let mut waapi = self.waapi.borrow_mut();
                !waapi.is_empty() && waapi.sample(doc.as_mut(), now * 1000.0)
            };
            let laid_out = !style_only || !doc.as_mut().resolve_style(now);
            if laid_out {
                if style_only {
                    self.count_resolve(false);
                }
                doc.as_mut().resolve(now);
            }
            // Inside the same borrow: stylo retires a finished
            // transition during resolve, so the diff has to run before
            // anything else can touch the document.
            let animating = doc.as_ref().has_active_animations() || waapi_running;
            // Mint the external handle while the target's live generation is
            // still available. TransitionStates then keeps that handle if the
            // slot is removed and reused before the event is drained.
            let mut states = self.transition_states.borrow_mut();
            let mut events = self.transition_events.borrow_mut();
            let mut node_handles = self.node_handles.borrow_mut();
            style::transitions::collect_events(
                doc.as_ref(),
                now,
                &mut states,
                &mut events,
                |opaque| node_handles.external_for_live_opaque(doc.as_ref(), opaque),
            );
            let mut animation_states = self.animation_states.borrow_mut();
            if self.animation_events_requested.get() {
                let mut animation_events = self.animation_events.borrow_mut();
                collect_animation_events(
                    doc.as_ref(),
                    now,
                    &mut animation_states,
                    true,
                    &mut animation_events,
                    |opaque| node_handles.external_for_live_opaque(doc.as_ref(), opaque),
                );
            } else {
                let mut discard = Vec::new();
                collect_animation_events(
                    doc.as_ref(),
                    now,
                    &mut animation_states,
                    false,
                    &mut discard,
                    |opaque| node_handles.external_for_live_opaque(doc.as_ref(), opaque),
                );
            }
            (animating, laid_out)
        }));
        drop(doc);
        match result {
            // A style-only flush keeps layout dirty for the next geometry read or paint.
            Ok((animating, false)) => {
                #[cfg(test)]
                self.style_passes.set(self.style_passes.get() + 1);
                self.layout_dirty.style.set(false);
                self.animating.set(animating);
                self.last_resolve_now.set(now);
            }
            // A full resolve clears both flags and advances the epoch geometry polls compare.
            Ok((animating, true)) => {
                self.layout_dirty.set(false);
                self.animating.set(animating);
                self.last_resolve_now.set(now);
                self.layout_epoch
                    .set(self.layout_epoch.get().wrapping_add(1));
                self.apply_sticky(true);
            }
            Err(_) => {
                if let Ok(mut d) = self.doc.try_borrow_mut() {
                    d.as_mut().clear_style_snapshots();
                    d.as_mut().recover_from_layout_panic();
                }
            }
        }
    }

    /// Count one resolve in the mutation-driven or animation-only slot.
    fn count_resolve(&self, animation_only: bool) {
        let mut counts = self.resolve_counts.get();
        let slot = usize::from(animation_only);
        counts[slot] = counts[slot].saturating_add(1);
        self.resolve_counts.set(counts);
    }

    fn connected_node_id(&self, node_id: u32) -> Option<NodeId> {
        let internal_id = self.resolve_node_id(node_id)?;
        let Ok(doc) = self.doc.try_borrow() else {
            return None;
        };
        let root_id = doc.root_node().id();
        let mut current = Some(internal_id);
        while let Some(id) = current {
            if id == root_id {
                return Some(internal_id);
            }
            current = doc.get_node(id).and_then(|node| node.parent_id());
        }
        None
    }

    /// `[mutationResolves, animationResolves]` since the document was built.
    #[wasm_bindgen(js_name = "resolveCounts")]
    pub fn resolve_counts(&self) -> Vec<u32> {
        self.resolve_counts.get().to_vec()
    }

    #[wasm_bindgen(js_name = "resolveLayout")]
    pub fn resolve_layout(&self) {
        self.ensure_layout();
    }

    #[wasm_bindgen(js_name = "isAnimating")]
    pub fn is_animating(&self) -> bool {
        self.animating.get()
    }

    /// Never resolves itself. With layoutClean, a poll whose epoch is
    /// unchanged knows no box moved, so it can skip its geometry reads.
    #[wasm_bindgen(js_name = "layoutEpoch")]
    pub fn layout_epoch(&self) -> u32 {
        self.layout_epoch.get()
    }

    /// Deliberately does NOT resolve: IntersectionObserver samples the last committed layout.
    #[wasm_bindgen(js_name = "layoutClean")]
    pub fn layout_clean(&self) -> bool {
        self.layout_mode.get() == LayoutMode::Full && !self.layout_dirty.get()
    }

    #[cfg(test)]
    pub(crate) fn doc_for_test(&self) -> &RefCell<HtmlDocument> {
        &self.doc
    }
}

fn clear_unstyled_cascade(doc: &mut BaseDocument) -> u32 {
    let root_id = doc.root_node().id();
    let count = Cell::new(0u32);
    let count_ref = &count;
    doc.iter_subtree_mut(root_id, move |node_id, d| {
        if node_id == root_id {
            return;
        }
        let Some(node) = d.get_node(node_id) else {
            return;
        };
        if !matches!(
            node.data,
            NodeData::Element(_) | NodeData::AnonymousBlock(_)
        ) {
            return;
        }
        let unstyled = node.stylo_element_data().has_data()
            && node.stylo_element_data().primary_styles().is_none();
        if !unstyled {
            return;
        }
        // SAFETY: we hold a &mut BaseDocument, and stylo's traversal
        // is not active — callers run BEFORE the next scene record.
        unsafe {
            node.stylo_element_data().clear();
        }
        node.mark_ancestors_dirty();
        count_ref.set(count_ref.get().saturating_add(1));
    });
    count.get()
}
