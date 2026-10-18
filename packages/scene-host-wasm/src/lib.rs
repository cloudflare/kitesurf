// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Exposes the CLI's byte-oriented Wasm ABI for scene replay and terminal rendering.

mod paint;
mod tty;

fn console_warn_str(_msg: &str) {}

use paint::scene_replay::SceneRasterizer;
use std::alloc::{alloc, dealloc, Layout};
use std::cell::{Cell, RefCell};

thread_local! {
    static RASTER: RefCell<SceneRasterizer> = RefCell::new(SceneRasterizer::new());
    static TEXT: RefCell<Option<tty::grid::TtyImages>> = const { RefCell::new(None) };
    static RETAINED_SEQ: Cell<Option<u32>> = const { Cell::new(None) };
}

/// Allocate bytes in guest memory. The host writes input here, calls
/// ks_call, then frees the input with ks_free. Zero length needs no allocation.
#[no_mangle]
pub extern "C" fn ks_alloc(len: u32) -> u32 {
    if len == 0 {
        return 0;
    }
    let layout = Layout::array::<u8>(len as usize).expect("guest allocation length fits a layout");
    // SAFETY: layout describes exactly len bytes; the host must release
    // the returned allocation with ks_free using that same length.
    unsafe { alloc(layout) as u32 }
}

/// Release a buffer from `ks_alloc` or `ks_call` using its original pointer and length.
/// Call once per nonempty buffer; a zero length is a no-op.
#[no_mangle]
pub extern "C" fn ks_free(ptr: u32, len: u32) {
    if len == 0 {
        return;
    }
    let layout = Layout::array::<u8>(len as usize).expect("guest allocation length fits a layout");
    // SAFETY: the host passes back a live pointer from ks_alloc (or ks_call)
    // with the original length, and does not free it more than once.
    unsafe {
        dealloc(ptr as *mut u8, layout);
    }
}

/// FFI: The CLI consumes this byte ABI; keep operation IDs and payload layouts in sync with
/// `packages/kitesurf-cli/src/wasm.rs`.
/// Returns (output length << 32) | output pointer. The host owns the
/// returned allocation and must release it with ks_free.
/// 1=putResources, 2=missingResources, 3=full PNG,
/// 5=pendingFontAssets JSON, 6=putFontAsset,
/// 7=JSON raster diagnostics {error,missingFonts,missingImages,textRuns},
/// 8=pendingImages JSON, 9=abandonImage, 10=partial PNG,
/// 11=partial PNG cropped to the visible viewport.
/// 12=enable ANSI mode, 13=scene to ANSI (LE u32 cols/rows, f32 cell w/h),
/// 14=full RGBA (LE u32 width/height followed by premultiplied pixels).
/// 15=retain full frame ([seq u32, raw u32], scene),
/// 16=composite patch ([seq u32, base u32, x i32, y i32, raw u32], scene).
/// Retaining calls return the full viewport as PNG (raw=0) or RGBA (raw=1).
/// Font input starts with LE u32 path length, then UTF-8 path and font bytes.
/// Cropped input starts with LE u32 left/top/width/height, then the scene.
/// For nonempty input, `ptr` must name a live `len`-byte `ks_alloc` buffer.
/// `ks_call` borrows input until return and does not free that buffer.
#[no_mangle]
pub extern "C" fn ks_call(op: u32, ptr: u32, len: u32) -> u64 {
    const OP_PUT_RESOURCES: u32 = 1;
    const OP_SCENE_MISSING_RESOURCES: u32 = 2;
    const OP_RENDER_PNG: u32 = 3;
    const OP_PENDING_FONTS: u32 = 5;
    const OP_PUT_FONT: u32 = 6;
    const OP_LAST_ERROR: u32 = 7;
    const OP_PENDING_IMAGES: u32 = 8;
    const OP_ABANDON_IMAGE: u32 = 9;
    const OP_RENDER_PARTIAL_PNG: u32 = 10;
    const OP_RENDER_CROPPED_PNG: u32 = 11;
    const OP_ENABLE_ANSI: u32 = 12;
    const OP_RENDER_ANSI: u32 = 13;
    const OP_RENDER_RGBA: u32 = 14;
    const OP_RETAIN_FRAME: u32 = 15;
    const OP_COMPOSITE_FRAME: u32 = 16;
    const FONT_PATH_LENGTH_BYTES: usize = 4;
    const ANSI_PREFIX_BYTES: usize = 16;
    const PACKED_OUTPUT_LENGTH_SHIFT: u32 = 32;

    let input = if len == 0 {
        &[]
    } else {
        // SAFETY: the host owns a live len-byte guest allocation at ptr and
        // does not mutate or free it until this call returns.
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    let output = RASTER.with(|slot| {
        TEXT.with(|text| {
            let raster = slot.borrow();
            match op {
                OP_PUT_RESOURCES => text
                    .borrow_mut()
                    .as_mut()
                    .map_or_else(
                        || raster.put_resources(input),
                        |tty| tty.put_resources(input),
                    )
                    .to_le_bytes()
                    .to_vec(),
                OP_SCENE_MISSING_RESOURCES => text.borrow().as_ref().map_or_else(
                    || raster.missing_resources(input),
                    |tty| tty.missing_images(input),
                ),
                OP_RENDER_PNG | OP_RENDER_PARTIAL_PNG => raster.rasterize(input, "png", 80, false),
                OP_PENDING_FONTS => raster.pending_font_assets().into_bytes(),
                OP_PUT_FONT if input.len() >= FONT_PATH_LENGTH_BYTES => {
                    let path_len = u32::from_le_bytes(
                        input[..FONT_PATH_LENGTH_BYTES]
                            .try_into()
                            .expect("four-byte path length"),
                    ) as usize;
                    if let Some(path) = input
                        .get(
                            FONT_PATH_LENGTH_BYTES..FONT_PATH_LENGTH_BYTES.saturating_add(path_len),
                        )
                        .and_then(|p| std::str::from_utf8(p).ok())
                    {
                        raster
                            .put_font_asset(path, &input[FONT_PATH_LENGTH_BYTES + path_len..])
                            .to_le_bytes()
                            .to_vec()
                    } else {
                        vec![]
                    }
                }
                OP_LAST_ERROR => raster.last_rasterize_info().into_bytes(),
                OP_PENDING_IMAGES => serde_json::to_vec(
                    &text
                        .borrow()
                        .as_ref()
                        .map_or_else(|| raster.pending_images(), |tty| tty.pending_images()),
                )
                .unwrap_or_default(),
                OP_ABANDON_IMAGE => std::str::from_utf8(input)
                    .ok()
                    .map(|key| {
                        text.borrow_mut()
                            .as_mut()
                            .map_or_else(
                                || raster.abandon_image(key),
                                |tty| {
                                    u32::from(
                                        key.parse::<u64>()
                                            .ok()
                                            .is_some_and(|k| tty.abandon_image(k)),
                                    )
                                },
                            )
                            .to_le_bytes()
                            .to_vec()
                    })
                    .unwrap_or_default(),
                OP_RENDER_CROPPED_PNG => cropped_png(&raster, input),
                OP_ENABLE_ANSI => {
                    *text.borrow_mut() = Some(tty::grid::TtyImages::default());
                    Vec::new()
                }
                OP_RENDER_ANSI if input.len() >= ANSI_PREFIX_BYTES => {
                    let cols = u32::from_le_bytes(input[0..4].try_into().expect("four-byte cols"));
                    let rows = u32::from_le_bytes(input[4..8].try_into().expect("four-byte rows"));
                    let cell_w =
                        f32::from_le_bytes(input[8..12].try_into().expect("four-byte cell width"));
                    let cell_h = f32::from_le_bytes(
                        input[12..16].try_into().expect("four-byte cell height"),
                    );
                    text.borrow_mut()
                        .as_mut()
                        .and_then(|tty| {
                            tty.scene_to_ansi(
                                &input[ANSI_PREFIX_BYTES..],
                                cols,
                                rows,
                                cell_w,
                                cell_h,
                                tty::modes::ImageMode::Halfblocks,
                            )
                        })
                        .map(|mut grid| grid.render_ansi().into_bytes())
                        .unwrap_or_default()
                }
                OP_RENDER_RGBA => raster.rasterize(input, "rgba", 0, false),
                OP_RETAIN_FRAME | OP_COMPOSITE_FRAME => {
                    retained_frame(&raster, op == OP_COMPOSITE_FRAME, input)
                }
                _ => vec![],
            }
        })
    });
    if output.is_empty() {
        return 0;
    }
    let len = output.len() as u32;
    let ptr = ks_alloc(len);
    if ptr == 0 {
        return 0;
    }
    // SAFETY: ks_alloc returned a live, non-overlapping len-byte allocation;
    // output remains live for the duration of the copy.
    unsafe {
        std::ptr::copy_nonoverlapping(output.as_ptr(), ptr as *mut u8, len as usize);
    }
    ((len as u64) << PACKED_OUTPUT_LENGTH_SHIFT) | ptr as u64
}

fn retained_frame(raster: &SceneRasterizer, partial: bool, input: &[u8]) -> Vec<u8> {
    const KEY: &str = "cli";
    let Some((seq, input)) = input.split_first_chunk::<4>() else {
        return Vec::new();
    };
    let seq = u32::from_le_bytes(*seq);
    let (expected_base, x, y, input) = if partial {
        let Some((base, input)) = input.split_first_chunk::<4>() else {
            return Vec::new();
        };
        let Some((x, input)) = input.split_first_chunk::<4>() else {
            return Vec::new();
        };
        let Some((y, input)) = input.split_first_chunk::<4>() else {
            return Vec::new();
        };
        (
            Some(u32::from_le_bytes(*base)),
            i32::from_le_bytes(*x),
            i32::from_le_bytes(*y),
            input,
        )
    } else {
        (None, 0, 0, input)
    };
    let Some((raw, scene)) = input.split_first_chunk::<4>() else {
        return Vec::new();
    };
    let raw = u32::from_le_bytes(*raw);
    if raw > 1 {
        return Vec::new();
    }
    let format = if raw == 1 { "rgba" } else { "png" };
    RETAINED_SEQ.with(|base| {
        if partial && base.get() != expected_base {
            return Vec::new();
        }
        // The shared blitter negates negative origins. Reject the one i32 value
        // whose negation overflows before entering this abort-on-panic module.
        if x == i32::MIN || y == i32::MIN {
            return Vec::new();
        }
        base.set(None);
        let output = if partial {
            raster.rasterize_partial(scene, x, y, format, 80, KEY)
        } else {
            raster.rasterize_and_retain(scene, format, 80, false, KEY)
        };
        if !output.is_empty() && raster.retained_frame_key() == KEY {
            base.set(Some(seq));
        }
        output
    })
}

fn cropped_png(raster: &SceneRasterizer, input: &[u8]) -> Vec<u8> {
    const CROP_FIELD_BYTES: usize = 4;
    const CROP_PREFIX_BYTES: usize = 4 * CROP_FIELD_BYTES;
    const RASTER_DIMENSIONS_BYTES: usize = 2 * CROP_FIELD_BYTES;

    if input.len() < CROP_PREFIX_BYTES {
        return Vec::new();
    }
    let [left, top, width, height] = std::array::from_fn(|i| {
        let start = i * CROP_FIELD_BYTES;
        u32::from_le_bytes(
            input[start..start + CROP_FIELD_BYTES]
                .try_into()
                .expect("four-byte crop field"),
        )
    });
    let rgba = raster.rasterize(&input[CROP_PREFIX_BYTES..], "rgba", 0, false);
    if rgba.len() < RASTER_DIMENSIONS_BYTES {
        return Vec::new();
    }
    let raster_width = u32::from_le_bytes(
        rgba[..CROP_FIELD_BYTES]
            .try_into()
            .expect("four-byte raster width"),
    );
    let raster_height = u32::from_le_bytes(
        rgba[CROP_FIELD_BYTES..RASTER_DIMENSIONS_BYTES]
            .try_into()
            .expect("four-byte raster height"),
    );
    if width == 0
        || height == 0
        || left.checked_add(width).is_none_or(|end| end > raster_width)
        || top
            .checked_add(height)
            .is_none_or(|end| end > raster_height)
        || rgba.len()
            != RASTER_DIMENSIONS_BYTES + raster_width as usize * raster_height as usize * 4
    {
        return Vec::new();
    }
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for y in top..top + height {
        let start = ((y * raster_width + left) * 4) as usize + RASTER_DIMENSIONS_BYTES;
        pixels.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    paint::screenshot::encode_png(&pixels, width, height).unwrap_or_default()
}
