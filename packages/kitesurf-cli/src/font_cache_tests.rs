// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use super::*;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "kitesurf-font-cache-{}",
            u128::from_le_bytes(random)
        ));
        fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }

    fn cache(&self, url: Url) -> FontCache {
        FontCache {
            source: FontSource::new(url, crate::tls::client_builder().build().unwrap()).unwrap(),
            directory: self.0.join("fonts"),
        }
    }

    fn file(&self, extension: &str) -> PathBuf {
        fs::read_dir(self.0.join("fonts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some(extension))
            .unwrap()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn response(status: &str, etag: Option<&str>, bytes: &[u8]) -> Vec<u8> {
    let mut reply = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        bytes.len()
    );
    if let Some(etag) = etag {
        reply.push_str(&format!("ETag: {etag}\r\n"));
    }
    reply.push_str("\r\n");
    let mut reply = reply.into_bytes();
    reply.extend_from_slice(bytes);
    reply
}

async fn server(responses: Vec<Vec<u8>>) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/rbi/fonts/font.ttf",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            requests.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
            stream.write_all(&response).await.unwrap();
        }
        requests
    });
    (url, task)
}

#[tokio::test]
async fn fonts_persist_and_revalidate_across_cache_instances() {
    let (url, task) = server(vec![
        response("200 OK", Some("\"v1\""), b"font-v1"),
        response("304 Not Modified", None, b""),
    ])
    .await;
    let directory = Directory::new();
    let mut diagnostics = Diagnostics::new(false);
    assert_eq!(
        directory
            .cache(url.clone())
            .fetch(url.clone(), &mut diagnostics)
            .await
            .unwrap(),
        b"font-v1"
    );
    assert_eq!(fs::read(directory.file("font")).unwrap(), b"font-v1");
    assert_eq!(
        directory
            .cache(url.clone())
            .fetch(url, &mut diagnostics)
            .await
            .unwrap(),
        b"font-v1"
    );
    let requests = task.await.unwrap();
    assert!(!requests[0].contains("if-none-match:"));
    assert!(requests[1].contains("if-none-match: \"v1\"\r\n"));
    for request in requests {
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cf-access-token:"));
    }
}

#[tokio::test]
async fn changed_etags_replace_cached_fonts_and_validators() {
    let (url, task) = server(vec![
        response("200 OK", Some("\"v1\""), b"font-v1"),
        response("200 OK", Some("\"v2\""), b"font-v2"),
        response("304 Not Modified", None, b""),
    ])
    .await;
    let directory = Directory::new();
    for expected in [b"font-v1", b"font-v2", b"font-v2"] {
        assert_eq!(
            directory
                .cache(url.clone())
                .fetch(url.clone(), &mut Diagnostics::new(false))
                .await
                .unwrap(),
            expected
        );
    }
    assert_eq!(fs::read(directory.file("font")).unwrap(), b"font-v2");
    assert_eq!(fs::read_dir(directory.0.join("fonts")).unwrap().count(), 2);
    let requests = task.await.unwrap();
    assert!(requests[1].contains("if-none-match: \"v1\"\r\n"));
    assert!(requests[2].contains("if-none-match: \"v2\"\r\n"));
}

#[tokio::test]
async fn damaged_or_missing_cache_entries_trigger_unconditional_downloads() {
    for damage in ["body", "missing", "metadata", "etag", "oversized"] {
        let (url, task) = server(vec![
            response("200 OK", Some("\"v1\""), b"font-v1"),
            response("200 OK", Some("\"v2\""), b"font-v2"),
        ])
        .await;
        let directory = Directory::new();
        directory
            .cache(url.clone())
            .fetch(url.clone(), &mut Diagnostics::new(false))
            .await
            .unwrap();
        match damage {
            "body" => fs::write(directory.file("font"), b"broken!").unwrap(),
            "missing" => fs::remove_file(directory.file("font")).unwrap(),
            "metadata" => fs::write(directory.file("json"), b"invalid metadata").unwrap(),
            "etag" => {
                let file = directory.file("json");
                let mut info: Metadata = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
                info.etag = Some("bad\nheader".into());
                fs::write(file, serde_json::to_vec(&info).unwrap()).unwrap();
            }
            "oversized" => File::create(directory.file("font"))
                .unwrap()
                .set_len((MAX_FONT_BYTES + 1) as u64)
                .unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(
            directory
                .cache(url.clone())
                .fetch(url, &mut Diagnostics::new(false))
                .await
                .unwrap(),
            b"font-v2"
        );
        assert!(
            !task.await.unwrap()[1].contains("if-none-match:"),
            "{damage}"
        );
    }
}

#[tokio::test]
async fn missing_etags_require_full_downloads() {
    let (url, task) = server(vec![
        response("200 OK", None, b"first"),
        response("200 OK", None, b"new"),
    ])
    .await;
    let directory = Directory::new();
    directory
        .cache(url.clone())
        .fetch(url.clone(), &mut Diagnostics::new(false))
        .await
        .unwrap();
    assert_eq!(
        directory
            .cache(url.clone())
            .fetch(url, &mut Diagnostics::new(false))
            .await
            .unwrap(),
        b"new"
    );
    assert!(task
        .await
        .unwrap()
        .iter()
        .all(|request| !request.contains("if-none-match:")));
}

#[tokio::test]
async fn cache_write_failure_does_not_break_font_loading() {
    let (url, task) = server(vec![response("200 OK", Some("\"v1\""), b"font-v1")]).await;
    let directory = Directory::new();
    fs::write(directory.0.join("fonts"), b"not a directory").unwrap();
    assert_eq!(
        directory
            .cache(url.clone())
            .fetch(url, &mut Diagnostics::new(false))
            .await
            .unwrap(),
        b"font-v1"
    );
    task.await.unwrap();
}

#[tokio::test]
async fn errors_do_not_replace_cached_fonts_and_unexpected_304_is_rejected() {
    let (url, task) = server(vec![
        response("200 OK", Some("\"v1\""), b"font-v1"),
        response("503 Service Unavailable", None, b"error"),
        response("304 Not Modified", None, b""),
    ])
    .await;
    let directory = Directory::new();
    directory
        .cache(url.clone())
        .fetch(url.clone(), &mut Diagnostics::new(false))
        .await
        .unwrap();
    assert!(directory
        .cache(url.clone())
        .fetch(url.clone(), &mut Diagnostics::new(false))
        .await
        .is_err());
    assert_eq!(
        directory
            .cache(url.clone())
            .fetch(url, &mut Diagnostics::new(false))
            .await
            .unwrap(),
        b"font-v1"
    );
    task.await.unwrap();

    let (url, task) = server(vec![response("304 Not Modified", None, b"")]).await;
    let error = Directory::new()
        .cache(url.clone())
        .fetch(url, &mut Diagnostics::new(false))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("without a verified cached font"));
    task.await.unwrap();
}

#[tokio::test]
async fn missing_font_error_identifies_the_font_server_route() {
    let (url, task) = server(vec![response("404 Not Found", None, b"")]).await;
    let error = Directory::new()
        .cache(url.clone())
        .fetch(url.clone(), &mut Diagnostics::new(false))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains(url.as_str()), "{error}");
    assert!(error.contains("font server must publish it under /rbi/fonts/"));
    task.await.unwrap();
}

#[tokio::test]
async fn font_download_rejects_oversized_declared_and_streamed_bodies() {
    for body in [
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n12345",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n12345\r\n0\r\n\r\n",
    ] {
        let (url, task) = server(vec![body.as_bytes().to_vec()]).await;
        let response = crate::tls::client_builder()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert!(font_bytes(response, 4)
            .await
            .unwrap_err()
            .to_string()
            .contains("exceeds 4 bytes"));
        task.await.unwrap();
    }
}

#[test]
fn font_urls_are_confined_to_builtin_font_assets() {
    let origin = Url::parse("https://kitesurf.dev/").unwrap();
    assert_eq!(
        font_url(&origin, "/fonts/NotoSans.ttf").unwrap().as_str(),
        "https://kitesurf.dev/rbi/fonts/NotoSans.ttf"
    );
    let prefixed_origin = Url::parse("https://host/ks/").unwrap();
    assert_eq!(
        font_url(&prefixed_origin, "/fonts/NotoSans.ttf")
            .unwrap()
            .as_str(),
        "https://host/ks/rbi/fonts/NotoSans.ttf"
    );
    for path in [
        "/fonts/../scene_host.wasm",
        "/fonts/%2e%2e/scene_host.wasm",
        "/fonts/font?token=secret",
        "/fonts/font#fragment",
        "https://example.com/font",
        "/fonts/\\evil",
    ] {
        assert!(font_url(&origin, path).is_err(), "{path}");
    }
}
