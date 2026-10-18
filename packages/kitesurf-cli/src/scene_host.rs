// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Downloads, verifies, and caches the scene-host Wasm artifact through the engine's CDP API.

use crate::{cache_directory, cdp_call, CdpSocket, Diagnostics, Message, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, fs::File, io::Read, path::Path};

const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_HOST_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) abi: u32,
    #[serde(rename = "wireVersion")]
    pub(crate) wire_version: u32,
    wasm: String,
    sha256: String,
    bytes: usize,
    /// Ops 15/16 (retain, composite) exist, so graphics mode can request partial scenes and
    /// send the composited viewport as an ordinary Kitty image. ANSI mode and older hosts get
    /// full frames.
    #[serde(default, rename = "retainedFrames")]
    pub(crate) retained_frames: bool,
}

#[derive(Deserialize)]
struct Chunk {
    sha256: String,
    offset: usize,
    #[serde(rename = "totalBytes")]
    total_bytes: usize,
    #[serde(rename = "dataB64")]
    data_b64: String,
}

impl Manifest {
    fn validate(&self) -> Result<()> {
        if !matches!(self.abi, 3 | 4)
            || self.wasm != "scene_host.wasm"
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.bytes == 0
            || self.bytes > MAX_HOST_BYTES
        {
            return Err("unsupported or invalid scene-host manifest".into());
        }
        Ok(())
    }

    fn matches(&self, bytes: &[u8]) -> bool {
        bytes.len() == self.bytes && format!("{:x}", Sha256::digest(bytes)) == self.sha256
    }
}

pub(crate) async fn artifact(
    ws: &mut CdpSocket,
    next_id: &mut u64,
    queued: &mut VecDeque<Message>,
    diagnostics: &mut Diagnostics,
) -> Result<(Manifest, Vec<u8>)> {
    let cache = cache_directory()?;
    artifact_in(ws, next_id, queued, &cache, diagnostics).await
}

async fn artifact_in(
    ws: &mut CdpSocket,
    next_id: &mut u64,
    queued: &mut VecDeque<Message>,
    cache: &Path,
    diagnostics: &mut Diagnostics,
) -> Result<(Manifest, Vec<u8>)> {
    diagnostics.log("requesting scene-host manifest over CDP");
    let reply = cdp_call(
        ws,
        next_id,
        "Kitesurf.getSceneHostManifest",
        serde_json::json!({}),
        None,
        queued,
    )
    .await
    .map_err(|error| {
        format!(
            "Could not fetch the scene-host manifest over CDP. Upgrade the connected engine if it does not support Kitesurf.getSceneHostManifest: {error}"
        )
    })?;
    let manifest: Manifest = serde_json::from_value(reply)?;
    manifest.validate()?;
    diagnostics.log(format!(
        "manifest: ABI {}, wire version {}, Wasm {} bytes",
        manifest.abi, manifest.wire_version, manifest.bytes
    ));
    let file = cache.join(format!("{}.wasm", manifest.sha256));
    let cached = read_bounded(&file, MAX_HOST_BYTES).unwrap_or_default();
    if manifest.matches(&cached) {
        diagnostics.log(format!("verified cached Wasm at {}", file.display()));
        return Ok((manifest, cached));
    }

    diagnostics.log("Wasm cache miss; downloading scene host over CDP");
    let mut bytes = Vec::with_capacity(manifest.bytes);
    while bytes.len() < manifest.bytes {
        let offset = bytes.len();
        let length = CHUNK_BYTES.min(manifest.bytes - offset);
        let reply = cdp_call(
            ws,
            next_id,
            "Kitesurf.readSceneHost",
            serde_json::json!({
                "sha256": manifest.sha256,
                "offset": offset,
                "length": length,
            }),
            None,
            queued,
        )
        .await?;
        let chunk: Chunk = serde_json::from_value(reply)?;
        if chunk.sha256 != manifest.sha256
            || chunk.offset != offset
            || chunk.total_bytes != manifest.bytes
            || chunk.data_b64.len() > length.div_ceil(3) * 4
        {
            return Err(
                "scene-host chunk identity, offset, or size does not match the manifest".into(),
            );
        }
        let decoded = STANDARD.decode(&chunk.data_b64)?;
        if decoded.len() != length {
            return Err("scene-host returned a short or oversized chunk".into());
        }
        bytes.extend_from_slice(&decoded);
    }
    if !manifest.matches(&bytes) {
        return Err("downloaded Wasm does not match the CDP scene-host manifest".into());
    }
    std::fs::create_dir_all(cache)?;
    std::fs::write(&file, &bytes)?;
    diagnostics.log(format!(
        "verified {} Wasm bytes and cached at {}",
        bytes.len(),
        file.display()
    ));
    Ok((manifest, bytes))
}

fn read_bounded(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

#[cfg(test)]
#[path = "scene_host_tests.rs"]
mod tests;
