// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The global allocator: small requests from size-class slabs (small_alloc.rs), the rest from
// std's System (dlmalloc), counting live bytes so pressure forces a boa swap round first; prod
// condemns a facet long before a grow can fail.

use crate::small_alloc::{Slabs, class_of};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicUsize, Ordering::Relaxed};

const STEP: usize = 4 << 20;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static BUDGET: AtomicUsize = AtomicUsize::new(usize::MAX);
static TRIGGER: AtomicUsize = AtomicUsize::new(usize::MAX);
static IN_ROUND: AtomicBool = AtomicBool::new(false);
static HOOK: AtomicPtr<()> = AtomicPtr::new(std::ptr::null_mut());
static ROUNDS: AtomicUsize = AtomicUsize::new(0);
static RESCUED: AtomicUsize = AtomicUsize::new(0);
static FREED: AtomicUsize = AtomicUsize::new(0);
static NULLS: AtomicUsize = AtomicUsize::new(0);
// wasm pages are one-way, so the worst moment an isolate ever had is what it is charged for
// from then on: the high-water, not the current live bytes, is the number to optimise.
static PEAK: AtomicUsize = AtomicUsize::new(0);
static PEAK_WINDOW: AtomicUsize = AtomicUsize::new(0);

struct SlabCell(UnsafeCell<Slabs>);

// SAFETY: wasm32 here has one thread, and no slab call reenters the allocator: pages come
// from `System` directly, and the swap round runs before or after a slab call, not inside it.
unsafe impl Sync for SlabCell {}

static SLABS: SlabCell = SlabCell(UnsafeCell::new(Slabs::new()));

/// # Safety
/// `layout` has a nonzero size.
///
/// `layout` from the slabs when it is small, else from `System`. Which one serves a block is
/// decided by its layout alone, so `dealloc` and `realloc` find it again.
#[inline(never)]
unsafe fn raw_alloc(layout: Layout, zeroed: bool) -> *mut u8 {
    match class_of(layout) {
        Some(class) => {
            // SAFETY: single-threaded and not reentrant (see `SlabCell`).
            let slot = unsafe { (*SLABS.0.get()).alloc(class) };
            if zeroed && !slot.is_null() {
                // SAFETY: the slot holds at least `layout.size()` bytes.
                unsafe { slot.write_bytes(0, layout.size()) };
            }
            slot
        }
        // SAFETY: the caller's contract is `System`'s.
        None if zeroed => unsafe { System.alloc_zeroed(layout) },
        None => unsafe { System.alloc(layout) },
    }
}

/// # Safety
/// `ptr` is live and came from `raw_alloc` or `raw_realloc` with `layout`.
#[inline(never)]
unsafe fn raw_dealloc(ptr: *mut u8, layout: Layout) {
    match class_of(layout) {
        // SAFETY: the same layout picked the same class when `ptr` was allocated.
        Some(class) => unsafe { (*SLABS.0.get()).dealloc(ptr, class) },
        None => unsafe { System.dealloc(ptr, layout) },
    }
}

/// # Safety
/// `GlobalAlloc::realloc`'s contract, with `ptr` from `raw_alloc` or `raw_realloc`.
///
/// Null leaves `ptr` allocated as it was.
#[inline(never)]
unsafe fn raw_realloc(ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    // SAFETY: the caller guarantees `new_size` rounded to `layout.align()` does not overflow.
    let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
    match (class_of(layout), class_of(new_layout)) {
        (Some(old), Some(new)) if old == new => ptr,
        // SAFETY: both layouts are `System`'s, so this is `System.realloc`'s contract.
        (None, None) => unsafe { System.realloc(ptr, layout, new_size) },
        _ => {
            // SAFETY: `new_size` is nonzero by `realloc`'s contract.
            let moved = unsafe { raw_alloc(new_layout, false) };
            if !moved.is_null() {
                // SAFETY: distinct live blocks, each holding at least the bytes copied.
                unsafe {
                    std::ptr::copy_nonoverlapping(ptr, moved, layout.size().min(new_size));
                    raw_dealloc(ptr, layout);
                }
            }
            moved
        }
    }
}

// Its methods and the raw_* paths stay out of line: inlined into every caller under LTO, the
// slab branches made wasm32 LLVM's CFGStackify crash on an unrelated large function (krilla's
// glyph drawing).
pub struct SwapAlloc;

// SAFETY: every method forwards to `raw_*` with the arguments it was given, which serve each
// layout from one source (`System` or a slab slot of at least its size and alignment) and find
// that source again from the layout; the counters and the hook are side work.
unsafe impl GlobalAlloc for SwapAlloc {
    #[inline(never)]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `alloc`'s contract for `layout`.
        allocate(layout.size(), || unsafe { raw_alloc(layout, false) })
    }

    #[inline(never)]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `alloc_zeroed`'s contract for `layout`.
        allocate(layout.size(), || unsafe { raw_alloc(layout, true) })
    }

    #[inline(never)]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from this allocator with `layout`.
        unsafe { raw_dealloc(ptr, layout) };
        released(layout.size());
    }

    #[inline(never)]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let grows = new_size.saturating_sub(layout.size());
        if grows > 0 {
            pressure(grows);
        }
        // SAFETY: `ptr` came from this allocator with `layout`, and the caller upholds
        // `realloc`'s contract for `new_size`.
        let mut moved = unsafe { raw_realloc(ptr, layout, new_size) };
        if moved.is_null() && round(grows) {
            // SAFETY: a failed realloc leaves `ptr` allocated as it was, so the same contract
            // holds for the retry.
            moved = unsafe { raw_realloc(ptr, layout, new_size) };
        }
        if moved.is_null() {
            NULLS.fetch_add(1, Relaxed);
        } else {
            record_peak(LIVE.fetch_add(new_size, Relaxed) + new_size);
            released(layout.size());
        }
        moved
    }
}

fn allocate(size: usize, mut alloc: impl FnMut() -> *mut u8) -> *mut u8 {
    pressure(size);
    let mut ptr = alloc();
    if ptr.is_null() && round(size) {
        ptr = alloc();
    }
    if ptr.is_null() {
        NULLS.fetch_add(1, Relaxed);
    } else {
        record_peak(LIVE.fetch_add(size, Relaxed) + size);
    }
    ptr
}

fn pressure(size: usize) {
    if LIVE.load(Relaxed).saturating_add(size) > TRIGGER.load(Relaxed) {
        round(size);
    }
}

fn record_peak(live: usize) {
    PEAK.fetch_max(live, Relaxed);
    PEAK_WINDOW.fetch_max(live, Relaxed);
}

fn released(size: usize) {
    let live = LIVE.fetch_sub(size, Relaxed) - size;
    let budget = BUDGET.load(Relaxed);
    // Back under the budget by a step: the next crossing of it gets a round of its own, but
    // hovering at it does not run one per allocation.
    if live.saturating_add(STEP) < budget && TRIGGER.load(Relaxed) != budget {
        TRIGGER.store(budget, Relaxed);
    }
}

// Runs the hook once, outside System (so it may free), and never inside itself: what a round
// allocates goes straight through. Returns whether it ran.
fn round(size: usize) -> bool {
    let hook = HOOK.load(Relaxed);
    if hook.is_null() || IN_ROUND.swap(true, Relaxed) {
        return false;
    }
    // SAFETY: HOOK only ever holds a `fn() -> usize` or null, both stored by `set_hook`, and
    // null returned above.
    let hook: fn() -> usize = unsafe { std::mem::transmute::<*mut (), fn() -> usize>(hook) };
    let before = LIVE.load(Relaxed);
    let _ = std::panic::catch_unwind(hook); // an allocator must not unwind
    let after = LIVE.load(Relaxed);
    ROUNDS.fetch_add(1, Relaxed);
    FREED.fetch_add(before.saturating_sub(after), Relaxed);
    let budget = BUDGET.load(Relaxed);
    if after.saturating_add(size) <= budget {
        RESCUED.fetch_add(1, Relaxed);
        TRIGGER.store(budget, Relaxed);
    } else {
        TRIGGER.store(after.saturating_add(size).saturating_add(STEP), Relaxed);
    }
    IN_ROUND.store(false, Relaxed);
    true
}

/// What memory pressure calls: boa's forced swap round once a code store is installed
/// (boa_code_store.rs), else nothing.
pub fn set_hook(hook: Option<fn() -> usize>) {
    HOOK.store(hook.map_or(std::ptr::null_mut(), |f| f as *mut ()), Relaxed);
}

/// Bytes of wasm linear memory this instance holds, which only ever grows: the pages behind
/// a freed allocation stay charged to the isolate.
pub fn wasm_memory_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65536
}

/// Live bytes past which an allocation first runs a swap round; usize::MAX turns it off.
/// Set under the current live bytes, the next allocation runs one.
pub fn set_budget(bytes: usize) {
    BUDGET.store(bytes, Relaxed);
    TRIGGER.store(bytes, Relaxed);
}

/// Starts a new diagnostic peak window without changing the lifetime high-water mark.
pub fn reset_peak_window() {
    PEAK_WINDOW.store(LIVE.load(Relaxed), Relaxed);
}

/// The allocator's gauges as JSON, for Kitesurf.getMemoryStats (`bridge.swapAlloc`): live
/// bytes, the budget (-1 when off), and what the rounds it ran did.
pub fn stats_json() -> String {
    use core::fmt::Write as _;
    let budget = BUDGET.load(Relaxed);
    // SAFETY: a read between allocator calls on the one thread.
    let slab_page_bytes = unsafe { (*SLABS.0.get()).page_bytes() } as i64;
    // Written field by field rather than as one wide format!: that macro expands to enough IR
    // to overflow LLVM's function pass manager at codegen-units=1.
    let mut out = String::with_capacity(256);
    out.push('{');
    for (name, value) in [
        ("liveBytes", LIVE.load(Relaxed) as i64),
        (
            "budgetBytes",
            if budget == usize::MAX {
                -1
            } else {
                budget as i64
            },
        ),
        ("rounds", ROUNDS.load(Relaxed) as i64),
        ("rescued", RESCUED.load(Relaxed) as i64),
        ("freedBytes", FREED.load(Relaxed) as i64),
        ("failedAllocs", NULLS.load(Relaxed) as i64),
        ("peakLiveBytes", PEAK_WINDOW.load(Relaxed) as i64),
        ("lifetimePeakLiveBytes", PEAK.load(Relaxed) as i64),
        ("wasmBytes", wasm_memory_bytes() as i64),
        ("slabPageBytes", slab_page_bytes),
    ] {
        if out.len() > 1 {
            out.push(',');
        }
        let _ = write!(out, "\"{name}\":{value}");
    }
    out.push('}');
    out
}
