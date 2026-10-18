// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Fetches built-in fonts from the engine origin and caches verified font bytes locally.

use crate::{cache_directory, Diagnostics, PlaybackResult, Result};
use reqwest::{
    header::{ETAG, IF_NONE_MATCH},
    Client, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_FONT_BYTES: usize = 16 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 16 * 1024;

/// An HTTP client and origin for built-in font requests.
/// Configure the client to reject redirects to other origins.
pub struct FontSource {
    origin: Url,
    client: Client,
}

impl FontSource {
    /// Create a font source for the server URL and HTTP client.
    /// Returns an error unless `origin` uses HTTP(S) and includes a host.
    pub fn new(origin: Url, client: Client) -> PlaybackResult<Self> {
        if !matches!(origin.scheme(), "http" | "https") || origin.host_str().is_none() {
            return Err("font source must use an HTTP(S) URL with a host".into());
        }
        Ok(Self { origin, client })
    }
}

pub(crate) struct FontCache {
    source: FontSource,
    directory: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct Metadata {
    etag: Option<String>,
    sha256: String,
    bytes: usize,
}

struct Entry {
    metadata: Metadata,
    bytes: Vec<u8>,
}

impl FontCache {
    pub(crate) fn new(source: FontSource) -> Result<Self> {
        Ok(Self {
            source,
            directory: cache_directory()?.join("fonts"),
        })
    }

    pub(crate) async fn get(&self, path: &str, diagnostics: &mut Diagnostics) -> Result<Vec<u8>> {
        self.fetch(font_url(&self.source.origin, path)?, diagnostics)
            .await
    }

    async fn fetch(&self, url: Url, diagnostics: &mut Diagnostics) -> Result<Vec<u8>> {
        if url.origin() != self.source.origin.origin() {
            return Err("font request left its configured origin".into());
        }
        let key = format!("{:x}", Sha256::digest(url.as_str().as_bytes()));
        let cached = self.load(&key);
        let etag = cached
            .as_ref()
            .and_then(|entry| entry.metadata.etag.as_deref());
        let mut request = self.source.client.get(url.clone());
        if let Some(etag) = etag {
            diagnostics.log(format!("revalidating cached font from {url}"));
            request = request.header(IF_NONE_MATCH, etag);
        } else {
            diagnostics.log(format!("downloading font from {url}"));
        }
        let response = request.send().await?;
        if response.status() == StatusCode::NOT_MODIFIED {
            let entry = cached
                .filter(|entry| entry.metadata.etag.is_some())
                .ok_or("font server returned HTTP 304 without a verified cached font")?;
            diagnostics.log(format!(
                "reused {} cached font bytes for {url} (HTTP 304)",
                entry.bytes.len()
            ));
            return Ok(entry.bytes);
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(format!(
                "Built-in font not found at {url} (HTTP 404). The font server must publish it under /rbi/fonts/."
            )
            .into());
        }
        let response = response.error_for_status()?;
        if response.status() != StatusCode::OK {
            return Err(format!("unexpected font download status: {}", response.status()).into());
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = font_bytes(response, MAX_FONT_BYTES).await?;
        let metadata = Metadata {
            etag,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len(),
        };
        if let Err(error) = self.save(&key, &metadata, &bytes) {
            diagnostics.log(format!("could not cache font from {url}: {error}"));
        } else {
            diagnostics.log(format!("cached {} font bytes from {url}", bytes.len()));
        }
        Ok(bytes)
    }

    fn load(&self, key: &str) -> Option<Entry> {
        let json = read_bounded(
            &self.directory.join(format!("{key}.json")),
            MAX_METADATA_BYTES,
        )?;
        let metadata: Metadata = serde_json::from_slice(&json).ok()?;
        if metadata.bytes > MAX_FONT_BYTES {
            return None;
        }
        if let Some(etag) = &metadata.etag {
            reqwest::header::HeaderValue::from_str(etag).ok()?;
        }
        let bytes = read_bounded(&self.directory.join(format!("{key}.font")), metadata.bytes)?;
        if bytes.len() != metadata.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != metadata.sha256
        {
            return None;
        }
        Some(Entry { metadata, bytes })
    }

    fn save(&self, key: &str, metadata: &Metadata, bytes: &[u8]) -> Result<()> {
        let json = serde_json::to_vec(metadata)?;
        if json.len() > MAX_METADATA_BYTES {
            return Err("font cache metadata is too large".into());
        }
        fs::create_dir_all(&self.directory)?;
        write_atomic(&self.directory.join(format!("{key}.font")), bytes)?;
        write_atomic(&self.directory.join(format!("{key}.json")), &json)?;
        Ok(())
    }
}

fn font_url(origin: &Url, path: &str) -> Result<Url> {
    let font_prefix = origin.join("rbi/fonts/")?;
    let url = origin.join(&format!("rbi{path}"))?;
    if !path.starts_with("/fonts/")
        || path.contains("..")
        || path.contains('\\')
        || !url.path().starts_with(font_prefix.path())
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin() != origin.origin()
    {
        return Err("invalid built-in font asset path".into());
    }
    Ok(url)
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

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "could not create a temporary font cache name")?;
    let temporary = path.with_extension(format!("{}.tmp", u128::from_le_bytes(random)));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

async fn font_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("font download exceeds {limit} bytes").into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > limit - bytes.len() {
            return Err(format!("font download exceeds {limit} bytes").into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "font_cache_tests.rs"]
mod tests;
