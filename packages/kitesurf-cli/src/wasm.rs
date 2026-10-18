// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Calls the scene-host Wasm ABI through Wasmtime.
//! Copies request and response bytes through guest memory.

use wasmtime::{Config, Engine, Instance, Memory, Module, OptLevel, Store, TypedFunc};

/// Owns one scene-host Wasm instance and the guest-memory handles used to call it.
pub struct Raster {
    store: Store<()>,
    memory: Memory,
    alloc: TypedFunc<u32, u32>,
    free: TypedFunc<(u32, u32), ()>,
    call: TypedFunc<(u32, u32, u32), u64>,
}

impl Raster {
    /// Compile and instantiate a scene-host module from its Wasm bytes.
    /// Returns an error if compilation, instantiation, or required-export lookup fails.
    pub fn new(bytes: &[u8]) -> Result<Self, Box<dyn std::error::Error>> {
        let engine = Engine::new(Config::new().cranelift_opt_level(OptLevel::Speed))?;
        let module = Module::from_binary(&engine, bytes)?;
        let mut store = Store::new(&engine, ());
        let instance = Instance::new(&mut store, &module, &[])?;
        Ok(Self {
            memory: instance
                .get_memory(&mut store, "memory")
                .ok_or("missing memory")?,
            alloc: instance.get_typed_func(&mut store, "ks_alloc")?,
            free: instance.get_typed_func(&mut store, "ks_free")?,
            call: instance.get_typed_func(&mut store, "ks_call")?,
            store,
        })
    }

    /// Run one scene-host operation; `input` must match the payload layout for `op`.
    /// Copies the result and frees guest buffers.
    /// Conversion, allocation, Wasmtime, and memory-access errors propagate.
    pub fn run(&mut self, op: u32, input: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        const PACKED_OUTPUT_LENGTH_SHIFT: u32 = 32;

        let input_len = u32::try_from(input.len())?;
        let input_ptr = self.alloc.call(&mut self.store, input_len)?;
        if input_len > 0 && input_ptr == 0 {
            return Err("guest allocation failed".into());
        }
        if let Err(error) = self
            .memory
            .write(&mut self.store, input_ptr as usize, input)
        {
            self.free.call(&mut self.store, (input_ptr, input_len))?;
            return Err(error.into());
        }
        let call_result = self.call.call(&mut self.store, (op, input_ptr, input_len));
        self.free.call(&mut self.store, (input_ptr, input_len))?;
        let packed_output = call_result?;
        // ks_call packs output length in the high word and the guest pointer in the low word.
        let output_ptr = packed_output as u32;
        let output_len = (packed_output >> PACKED_OUTPUT_LENGTH_SHIFT) as u32;
        let mut output = vec![0; output_len as usize];
        if output_len > 0 {
            let read = self
                .memory
                .read(&self.store, output_ptr as usize, &mut output);
            self.free.call(&mut self.store, (output_ptr, output_len))?;
            read?;
        }
        Ok(output)
    }
}

#[cfg(test)]
pub(crate) fn test_scene(w: u32, h: u32, color: [u8; 4]) -> Vec<u8> {
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let mut scene = b"KSC0".to_vec();
    scene.extend_from_slice(&(manifest["wireVersion"].as_u64().unwrap() as u32).to_le_bytes());
    for value in [w, h, 0, 0, 1, 0, 0, h] {
        scene.extend_from_slice(&value.to_le_bytes());
    }
    // One solid rectangle: fill, non-zero, identity, no brush transform, solid paint.
    scene.extend_from_slice(&[4, 0, 0, 0, 0]);
    scene.extend_from_slice(&color);
    scene.push(0); // Q3 path coordinates.
    for (tag, x, y) in [(0, 0, 0), (1, w, 0), (1, w, h), (1, 0, h)] {
        scene.push(tag);
        scene.extend_from_slice(&i16::try_from(x * 8).unwrap().to_le_bytes());
        scene.extend_from_slice(&i16::try_from(y * 8).unwrap().to_le_bytes());
    }
    scene.extend_from_slice(&[4, 255]); // Close, end path.
    scene
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retained_call(raster: &mut Raster, op: u32, fields: &[u32], scene: &[u8]) -> Vec<u8> {
        let mut input = Vec::new();
        for field in fields {
            input.extend_from_slice(&field.to_le_bytes());
        }
        input.extend_from_slice(scene);
        raster.run(op, &input).unwrap()
    }

    fn pixel(raw: &[u8], x: usize, y: usize) -> &[u8] {
        let width = u32::from_le_bytes(raw[..4].try_into().unwrap()) as usize;
        &raw[8 + (y * width + x) * 4..8 + (y * width + x + 1) * 4]
    }

    #[test]
    fn retained_frame_replaces_pixels_and_clamps_patch_edges() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let blue = test_scene(8, 6, [0, 0, 255, 255]);
        let red = test_scene(4, 3, [255, 0, 0, 255]);
        let clear = test_scene(2, 2, [0, 0, 0, 0]);
        let base = retained_call(&mut raster, 15, &[1, 1], &blue);
        assert_eq!(pixel(&base, 0, 0), [0, 0, 255, 255]);
        let patched = retained_call(&mut raster, 16, &[2, 1, (-1i32) as u32, 2, 1], &red);
        assert_eq!(&patched[..8], &base[..8]);
        assert_eq!(pixel(&patched, 0, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&patched, 2, 4), [255, 0, 0, 255]);
        assert_eq!(pixel(&patched, 3, 2), [0, 0, 255, 255]);
        let patched = retained_call(&mut raster, 16, &[3, 2, 1, 2, 1], &clear);
        assert_eq!(pixel(&patched, 1, 2), [0, 0, 0, 0]);
        assert_eq!(pixel(&patched, 0, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&patched, 7, 5), [0, 0, 255, 255]);
    }

    #[test]
    fn retained_frame_requires_its_exact_base_and_recovers_after_failure() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let blue = test_scene(8, 6, [0, 0, 255, 255]);
        let red = test_scene(2, 2, [255, 0, 0, 255]);
        assert!(retained_call(&mut raster, 16, &[2, 1, 0, 0, 1], &red).is_empty());
        assert!(!retained_call(&mut raster, 15, &[1, 1], &blue).is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 0, 0, 0, 1], &red).is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 1, 0, 0, 1], b"invalid scene").is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 1, 0, 0, 1], &red).is_empty());
        let recovered = retained_call(&mut raster, 15, &[10, 0], &blue);
        assert!(recovered.starts_with(b"\x89PNG\r\n\x1a\n"));
        let patched = retained_call(&mut raster, 16, &[11, 10, 7, 5, 1], &red);
        assert_eq!(pixel(&patched, 7, 5), [255, 0, 0, 255]);
        assert_eq!(pixel(&patched, 6, 5), [0, 0, 255, 255]);
    }

    #[test]
    fn retained_frame_rejects_truncated_headers_without_losing_its_base() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let blue = test_scene(8, 6, [0, 0, 255, 255]);
        let red = test_scene(2, 2, [255, 0, 0, 255]);
        assert!(!retained_call(&mut raster, 15, &[1, 1], &blue).is_empty());
        for (op, fields) in [(15, vec![2u32, 1]), (16, vec![2, 1, 0, 0, 1])] {
            let header: Vec<u8> = fields.into_iter().flat_map(u32::to_le_bytes).collect();
            for len in 0..header.len() {
                assert!(
                    raster.run(op, &header[..len]).unwrap().is_empty(),
                    "op {op}, {len} bytes"
                );
            }
        }
        assert!(retained_call(&mut raster, 15, &[2, 2], &blue).is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 1, 0, 0, 2], &red).is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 1, i32::MIN as u32, 0, 1], &red).is_empty());
        assert!(retained_call(&mut raster, 16, &[2, 1, 0, i32::MIN as u32, 1], &red).is_empty());
        let patched = retained_call(&mut raster, 16, &[2, 1, 1, 2, 1], &red);
        assert_eq!(pixel(&patched, 1, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&patched, 0, 0), [0, 0, 255, 255]);
    }

    #[test]
    fn downloaded_module_runs_without_js_imports() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        );
        let bytes = std::fs::read(path).expect("run pnpm run build first");
        let mut raster = Raster::new(&bytes).unwrap();
        assert_eq!(raster.run(2, &[]).unwrap(), [0, 0, 0, 0]);

        let mut batch = vec![1, 0, 0, 0, 2];
        batch.extend_from_slice(&42u64.to_le_bytes());
        batch.extend_from_slice(&17u32.to_le_bytes());
        batch.extend_from_slice(&16u32.to_le_bytes());
        batch.extend_from_slice(&16u32.to_le_bytes());
        batch.push(3);
        batch.extend_from_slice(&16u32.to_le_bytes());
        batch.extend_from_slice(&16u32.to_le_bytes());
        raster.run(1, &batch).unwrap();
        assert_eq!(raster.run(8, &[]).unwrap(), br#"["42"]"#);
        raster.run(9, b"42").unwrap();
        assert_eq!(raster.run(8, &[]).unwrap(), b"[]");
    }

    #[test]
    fn cropped_partial_returns_only_the_requested_png_rectangle() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../engine/public/rbi/");
        let bytes = std::fs::read(format!("{dir}scene_host.wasm")).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(format!("{dir}scene_host.json")).unwrap())
                .unwrap();
        let mut scene = b"KSC0".to_vec();
        scene.extend_from_slice(&(manifest["wireVersion"].as_u64().unwrap() as u32).to_le_bytes());
        for value in [4u32, 4, 0, 0, 0, 0, 0, 4] {
            scene.extend_from_slice(&value.to_le_bytes());
        }
        let mut raster = Raster::new(&bytes).unwrap();
        let full = raster.run(10, &scene).unwrap();
        assert_eq!(&full[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&full[16..24], &[0, 0, 0, 4, 0, 0, 0, 4]);
        let raw = raster.run(14, &scene).unwrap();
        assert_eq!(&raw[..8], &[4, 0, 0, 0, 4, 0, 0, 0]);
        assert_eq!(raw.len(), 8 + 4 * 4 * 4);

        let mut cropped = Vec::new();
        for value in [1u32, 1, 2, 2] {
            cropped.extend_from_slice(&value.to_le_bytes());
        }
        cropped.extend_from_slice(&scene);
        let png = raster.run(11, &cropped).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[16..24], &[0, 0, 0, 2, 0, 0, 0, 2]);

        let decode = |bytes: &[u8]| {
            let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
                .read_info()
                .unwrap();
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut pixels).unwrap();
            pixels.truncate(info.buffer_size());
            pixels
        };
        let full_pixels = decode(&full);
        assert_eq!(&raw[8..], full_pixels);
        let cropped_pixels = decode(&png);
        for row in 0..2 {
            let start = ((row + 1) * 4 + 1) * 4;
            assert_eq!(
                &cropped_pixels[row * 8..row * 8 + 8],
                &full_pixels[start..start + 8]
            );
        }
    }
}
