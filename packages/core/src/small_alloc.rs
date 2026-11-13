// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Size-class pages for small allocations. dlmalloc gives every chunk a header and rounds it to
//! 8 bytes (a 16-byte request takes 24), and a page holds a million small objects at a time.
//! Here a slot is the class size with no header: `dealloc` gets the `Layout` back, so the class
//! is known, and the page header sits at the page-aligned address below the slot.

use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr::null_mut;

/// Page size and alignment; a page header is found by masking a slot's address.
pub(crate) const PAGE: usize = 16 * 1024;
/// Largest request served from pages; anything larger goes to `System`.
pub(crate) const MAX_SMALL: usize = 256;
/// Largest alignment a slot guarantees: page-aligned pages, an 8-byte header, and the classes
/// used for 8-aligned requests are multiples of 8.
const MAX_ALIGN: usize = 8;

/// Every 4 bytes up to 48, where most live objects are, then every 8: rounding a struct up to
/// the next class wastes at most 7 bytes, and each class strands at most one partial page.
const CLASSES: [u16; 38] = classes();

/// The last class before the step doubles to 8.
const ALIGN4_CLASS_MAX: u16 = 48;

const fn classes() -> [u16; 38] {
    let mut classes = [0u16; 38];
    let mut i = 0;
    let mut size = 4;
    while size <= ALIGN4_CLASS_MAX {
        classes[i] = size;
        size += 4;
        i += 1;
    }
    while i < classes.len() {
        classes[i] = classes[i - 1] + 8;
        i += 1;
    }
    classes
}

const _: () = assert!(CLASSES[37] as usize == MAX_SMALL);

/// Class index for a size, by `size.div_ceil(4)`: the smallest class that fits.
const CLASS_BY_SIZE4: [u8; MAX_SMALL / 4 + 1] = class_table(4);
/// The same for 8-aligned requests: the smallest class that fits and is a multiple of 8.
const CLASS_BY_SIZE4_ALIGN8: [u8; MAX_SMALL / 4 + 1] = class_table(8);

const fn class_table(align: u16) -> [u8; MAX_SMALL / 4 + 1] {
    let mut table = [0u8; MAX_SMALL / 4 + 1];
    let mut size4 = 0;
    while size4 <= MAX_SMALL / 4 {
        let size = (size4 * 4) as u16;
        let mut class = 0;
        while CLASSES[class] < size || !CLASSES[class].is_multiple_of(align) {
            class += 1;
        }
        table[size4] = class as u8;
        size4 += 1;
    }
    table
}

/// The class serving `layout`, or `None` when it goes to `System`.
#[inline]
pub(crate) fn class_of(layout: Layout) -> Option<usize> {
    // A free slot holds a link, so no class is smaller than a pointer (4 bytes on wasm32).
    let size = layout.size().max(size_of::<FreeSlot>());
    if layout.size() == 0 || size > MAX_SMALL || layout.align() > MAX_ALIGN {
        return None;
    }
    let size4 = size.div_ceil(4);
    Some(if layout.align() > 4 {
        CLASS_BY_SIZE4_ALIGN8[size4]
    } else {
        CLASS_BY_SIZE4[size4]
    } as usize)
}

/// A free slot, linked through its first word.
struct FreeSlot {
    next: *mut FreeSlot,
}

/// The start of every page. Pages with a free slot are on their class's list.
#[repr(C, align(8))]
struct Page {
    prev: *mut Page,
    next: *mut Page,
    free: *mut FreeSlot,
    /// Offset of the first slot never handed out; slots past it need no free-list entry.
    bump: u32,
    used: u32,
    listed: bool,
}

const HEADER: usize = size_of::<Page>().next_multiple_of(MAX_ALIGN);

/// Per-class lists of pages with free slots. Not thread-safe: the global instance is only
/// used on single-threaded wasm32.
pub(crate) struct Slabs {
    partial: [*mut Page; CLASSES.len()],
    /// Pages in use by some class.
    pages: usize,
    /// Empty pages any class may take, linked through `Page::next`.
    free_pages: *mut Page,
    /// The unused tail of the newest chunk.
    chunk_next: usize,
    chunk_end: usize,
    chunk_bytes: usize,
}

/// Pages come from `System` this many at a time: a page-aligned request costs dlmalloc up to a
/// page of alignment slack, which a lone page would pay every time.
const CHUNK: usize = 64 * PAGE;

impl Slabs {
    pub(crate) const fn new() -> Self {
        Slabs {
            partial: [null_mut(); CLASSES.len()],
            pages: 0,
            free_pages: null_mut(),
            chunk_next: 0,
            chunk_end: 0,
            chunk_bytes: 0,
        }
    }

    /// Bytes taken from `System` for pages, used or not.
    pub(crate) fn page_bytes(&self) -> usize {
        self.chunk_bytes
    }

    /// # Safety
    /// `self` must not be used concurrently.
    ///
    /// A slot of `class`, or null when no page can be had.
    pub(crate) unsafe fn alloc(&mut self, class: usize) -> *mut u8 {
        let size = CLASSES[class] as usize;
        let mut page_ptr = self.partial[class];
        if page_ptr.is_null() {
            page_ptr = unsafe { self.new_page() };
            if page_ptr.is_null() {
                return null_mut();
            }
            unsafe { self.push(class, page_ptr) };
        }
        // SAFETY: `page_ptr` is a live page of this class, listed, so it has a free or unused slot.
        let page = unsafe { &mut *page_ptr };
        let slot = if !page.free.is_null() {
            let entry = page.free;
            // SAFETY: free-list entries are slots of this page holding a `FreeSlot`, 4-aligned
            // only, which is a pointer's alignment on wasm32 but not on native test hosts.
            page.free = unsafe { entry.read_unaligned().next };
            entry.cast::<u8>()
        } else {
            let slot = unsafe { page_ptr.cast::<u8>().add(page.bump as usize) };
            page.bump += size as u32;
            slot
        };
        page.used += 1;
        if page.free.is_null() && page.bump as usize + size > PAGE {
            unsafe { self.unlink(class, page_ptr) };
        }
        slot
    }

    /// # Safety
    /// `slot` must be live and come from `alloc` with the same `class`, and `self` must not be
    /// used concurrently.
    ///
    /// Returns `slot`, from `alloc(class)`, to its page.
    pub(crate) unsafe fn dealloc(&mut self, slot: *mut u8, class: usize) {
        let page_ptr = (slot as usize & !(PAGE - 1)) as *mut Page;
        // SAFETY: every slot lies in a page whose header is at its page-aligned base.
        let page = unsafe { &mut *page_ptr };
        let entry = slot.cast::<FreeSlot>();
        // SAFETY: `class_of` never picks a class smaller than a pointer.
        unsafe { entry.write_unaligned(FreeSlot { next: page.free }) };
        page.free = entry;
        page.used -= 1;
        if !page.listed {
            unsafe { self.push(class, page_ptr) };
        }
        // Keep a class's last page even when empty, so a class hovering at a page boundary
        // does not take and give back a page on every allocation.
        if page.used == 0 && (!page.prev.is_null() || !page.next.is_null()) {
            unsafe {
                self.unlink(class, page_ptr);
                (*page_ptr).next = self.free_pages;
            }
            self.free_pages = page_ptr;
            self.pages -= 1;
        }
    }

    unsafe fn new_page(&mut self) -> *mut Page {
        let page = if !self.free_pages.is_null() {
            let page = self.free_pages;
            // SAFETY: free pages are pages of a live chunk, linked through `next`.
            self.free_pages = unsafe { (*page).next };
            page
        } else {
            if self.chunk_next == self.chunk_end {
                // SAFETY: `chunk_layout` has a nonzero size.
                let chunk = unsafe { System.alloc(chunk_layout()) };
                if chunk.is_null() {
                    return null_mut();
                }
                self.chunk_next = chunk as usize;
                self.chunk_end = chunk as usize + CHUNK;
                self.chunk_bytes += CHUNK;
            }
            let page = self.chunk_next as *mut Page;
            self.chunk_next += PAGE;
            page
        };
        self.pages += 1;
        // SAFETY: a fresh page is writable and aligned for `Page`.
        unsafe {
            page.write(Page {
                prev: null_mut(),
                next: null_mut(),
                free: null_mut(),
                bump: HEADER as u32,
                used: 0,
                listed: false,
            })
        };
        page
    }

    unsafe fn push(&mut self, class: usize, page: *mut Page) {
        let head = self.partial[class];
        // SAFETY: `page` and a non-null `head` are live pages of `class`.
        unsafe {
            (*page).prev = null_mut();
            (*page).next = head;
            (*page).listed = true;
            if !head.is_null() {
                (*head).prev = page;
            }
        }
        self.partial[class] = page;
    }

    unsafe fn unlink(&mut self, class: usize, page: *mut Page) {
        // SAFETY: `page` is listed for `class`, so its neighbours are live pages of it.
        unsafe {
            let (prev, next) = ((*page).prev, (*page).next);
            if prev.is_null() {
                self.partial[class] = next;
            } else {
                (*prev).next = next;
            }
            if !next.is_null() {
                (*next).prev = prev;
            }
            (*page).prev = null_mut();
            (*page).next = null_mut();
            (*page).listed = false;
        }
    }
}

fn chunk_layout() -> Layout {
    // PAGE is a power of two, so it is a valid alignment, and CHUNK is a multiple of it.
    Layout::from_size_align(CHUNK, PAGE).expect("PAGE is a power of two")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(size: usize, align: usize) -> Layout {
        Layout::from_size_align(size, align).unwrap()
    }

    fn slots_per_page(class: usize) -> usize {
        (PAGE - HEADER) / CLASSES[class] as usize
    }

    /// Three full pages plus part of a fourth, so page reuse has pages to reuse.
    fn slots_spanning_four_pages(class: usize) -> usize {
        slots_per_page(class) * 3 + 5
    }

    fn alloc_slots(slabs: &mut Slabs, class: usize, count: usize) -> Vec<*mut u8> {
        (0..count).map(|_| unsafe { slabs.alloc(class) }).collect()
    }

    #[test]
    fn classes_fit_and_keep_alignment() {
        for size in 1..=MAX_SMALL {
            for align in [1, 2, 4, 8] {
                let class = class_of(layout(size, align)).unwrap();
                let slot = CLASSES[class] as usize;
                assert!(slot >= size, "{size}/{align} -> {slot}");
                assert!(
                    slot.is_multiple_of(align.clamp(4, 8)),
                    "{size}/{align} -> {slot}"
                );
                if class > 0 {
                    let smaller = CLASSES[class - 1] as usize;
                    let need = size.max(size_of::<FreeSlot>());
                    assert!(
                        smaller < need || !smaller.is_multiple_of(align),
                        "{size}/{align}"
                    );
                }
            }
        }
        assert_eq!(class_of(layout(MAX_SMALL + 1, 8)), None);
        assert_eq!(class_of(layout(16, 16)), None);
        assert_eq!(HEADER % MAX_ALIGN, 0);
    }

    #[test]
    fn slots_are_distinct_and_aligned() {
        let mut slabs = Slabs::new();
        let class = class_of(layout(24, 8)).unwrap();
        let slots = alloc_slots(&mut slabs, class, slots_spanning_four_pages(class));

        let mut distinct = slots.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), slots.len());
        assert!(slots.iter().all(|&s| (s as usize).is_multiple_of(8)));
        assert_eq!(slabs.pages, 4);
    }

    #[test]
    fn every_slot_holds_its_own_value() {
        // A slot overlapping a page header or a neighbour would lose this write.
        let mut slabs = Slabs::new();
        let class = class_of(layout(24, 8)).unwrap();
        let slots = alloc_slots(&mut slabs, class, slots_spanning_four_pages(class));

        for (i, &s) in slots.iter().enumerate() {
            unsafe { s.cast::<u64>().write(i as u64) };
        }
        for (i, &s) in slots.iter().enumerate() {
            assert_eq!(unsafe { s.cast::<u64>().read() }, i as u64);
        }
    }

    #[test]
    fn a_freed_slot_is_reused_first() {
        let mut slabs = Slabs::new();
        let class = class_of(layout(24, 8)).unwrap();
        let slots = alloc_slots(&mut slabs, class, slots_spanning_four_pages(class));

        let freed = slots[7];
        unsafe { slabs.dealloc(freed, class) };
        assert_eq!(unsafe { slabs.alloc(class) }, freed);
    }

    #[test]
    fn empty_pages_return_to_the_chunk_and_another_class_reuses_them() {
        let mut slabs = Slabs::new();
        let class = class_of(layout(24, 8)).unwrap();
        let slots = alloc_slots(&mut slabs, class, slots_spanning_four_pages(class));
        for &s in &slots {
            unsafe { slabs.dealloc(s, class) };
        }

        // Empty pages go back, except the class's last one.
        assert_eq!(slabs.pages, 1);
        let again = unsafe { slabs.alloc(class) };
        assert!(!again.is_null());
        unsafe { slabs.dealloc(again, class) };
        assert_eq!(slabs.pages, 1);

        // Another class takes the pages given back instead of a new chunk.
        let other = class_of(layout(100, 4)).unwrap();
        let bump = slabs.chunk_next;
        let more = alloc_slots(&mut slabs, other, slots_per_page(other) * 3);
        assert_eq!(slabs.pages, 4);
        assert_eq!(slabs.chunk_next, bump, "the three freed pages are reused");
        assert_eq!(slabs.page_bytes(), CHUNK);
        for &s in &more {
            unsafe { slabs.dealloc(s, other) };
        }
    }

    #[test]
    fn a_full_page_rejoins_its_list_when_a_slot_frees() {
        let mut slabs = Slabs::new();
        let class = class_of(layout(256, 8)).unwrap();
        let first = alloc_slots(&mut slabs, class, slots_per_page(class));
        assert!(
            slabs.partial[class].is_null(),
            "a full page leaves the list"
        );
        unsafe { slabs.dealloc(first[3], class) };
        assert_eq!(unsafe { slabs.alloc(class) }, first[3]);
        assert_eq!(slabs.pages, 1);
        for &s in &first {
            unsafe { slabs.dealloc(s, class) };
        }
    }
}
