// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::TcpListener;

struct Cache(PathBuf);

impl Cache {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        Self(std::env::temp_dir().join(format!(
            "kitesurf-scene-host-{}",
            STANDARD.encode(random).replace(['/', '+', '='], "_")
        )))
    }
}

impl Drop for Cache {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn manifest(bytes: &[u8]) -> Value {
    json!({"abi":4,"wireVersion":16,"wasm":"scene_host.wasm", "retainedFrames":true,
        "sha256":format!("{:x}", Sha256::digest(bytes)), "bytes":bytes.len()})
}

async fn server(
    bytes: Vec<u8>,
    info: Value,
    expected_calls: usize,
    alter: fn(&mut Value),
) -> (CdpSocket, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/devtools/browser", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut requests = Vec::new();
        for index in 0..expected_calls {
            let text = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let request: Value = serde_json::from_str(text.to_text().unwrap()).unwrap();
            assert!(request["sessionId"].is_null());
            let mut result = match request["method"].as_str().unwrap() {
                "Kitesurf.getSceneHostManifest" => info.clone(),
                "Kitesurf.readSceneHost" => {
                    let offset = request["params"]["offset"].as_u64().unwrap() as usize;
                    let length = request["params"]["length"].as_u64().unwrap() as usize;
                    assert!(length <= CHUNK_BYTES && length > 0);
                    assert_eq!(request["params"]["sha256"], info["sha256"]);
                    json!({"sha256":info["sha256"], "offset":offset,"totalBytes":bytes.len(),
                        "dataB64":STANDARD.encode(&bytes[offset..offset+length])})
                }
                method => panic!("unexpected method {method}"),
            };
            if index == 0 {
                ws.send(Message::Text(
                    json!({"method":"Target.targetCreated","params":{"targetInfo":{"targetId":"queued"}}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            } else {
                alter(&mut result);
            }
            ws.send(Message::Text(
                json!({"id":request["id"],"result":result})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            requests.push(request);
        }
        requests
    });
    let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    (ws, task)
}

#[tokio::test]
async fn scene_host_uses_bounded_cdp_chunks_and_verifies_cached_bytes() {
    let bytes: Vec<u8> = (0..4 * 1024 * 1024 + 73)
        .map(|index| (index % 251) as u8)
        .collect();
    let info = manifest(&bytes);
    let cache = Cache::new();
    let mut diagnostics = Diagnostics::new(false);
    let (mut ws, task) = server(bytes.clone(), info.clone(), 3, |_| {}).await;
    let mut queued = VecDeque::new();
    let mut next_id = 0;
    let (manifest, received) = artifact_in(
        &mut ws,
        &mut next_id,
        &mut queued,
        &cache.0,
        &mut diagnostics,
    )
    .await
    .unwrap();
    assert_eq!(received, bytes);
    assert_eq!(
        std::fs::read(cache.0.join(format!("{}.wasm", manifest.sha256))).unwrap(),
        bytes
    );
    assert_eq!(queued.len(), 1);
    let requests = task.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1]["params"]["length"], CHUNK_BYTES);
    assert_eq!(requests[2]["params"]["offset"], CHUNK_BYTES);
    assert_eq!(requests[2]["params"]["length"], 73);

    let (mut ws, task) = server(bytes.clone(), info.clone(), 1, |_| {}).await;
    let mut next_id = 0;
    let (_, received) = artifact_in(
        &mut ws,
        &mut next_id,
        &mut VecDeque::new(),
        &cache.0,
        &mut diagnostics,
    )
    .await
    .unwrap();
    assert_eq!(received, bytes);
    assert_eq!(task.await.unwrap().len(), 1);

    std::fs::write(
        cache
            .0
            .join(format!("{}.wasm", info["sha256"].as_str().unwrap())),
        b"corrupt",
    )
    .unwrap();
    let (mut ws, task) = server(bytes.clone(), info, 3, |_| {}).await;
    let mut next_id = 0;
    let (_, received) = artifact_in(
        &mut ws,
        &mut next_id,
        &mut VecDeque::new(),
        &cache.0,
        &mut diagnostics,
    )
    .await
    .unwrap();
    assert_eq!(received, bytes);
    task.await.unwrap();
}

#[tokio::test]
async fn scene_host_rejects_bad_chunks_without_caching_them() {
    let mutations: [fn(&mut Value); 6] = [
        |chunk| chunk["offset"] = json!(1),
        |chunk| chunk["totalBytes"] = json!(999),
        |chunk| chunk["sha256"] = json!("0".repeat(64)),
        |chunk| chunk["dataB64"] = json!(STANDARD.encode(b"shor")),
        |chunk| chunk["dataB64"] = json!(STANDARD.encode(b"oversized")),
        |chunk| chunk["dataB64"] = json!(STANDARD.encode(b"wrong")),
    ];
    for alter in mutations {
        let bytes = b"valid".to_vec();
        let info = manifest(&bytes);
        let cache = Cache::new();
        let (mut ws, task) = server(bytes, info, 2, alter).await;
        let mut next_id = 0;
        assert!(artifact_in(
            &mut ws,
            &mut next_id,
            &mut VecDeque::new(),
            &cache.0,
            &mut Diagnostics::new(false),
        )
        .await
        .is_err());
        assert!(!cache.0.exists());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn scene_host_rejects_invalid_manifests_before_requesting_wasm() {
    for field in ["abi", "bytes", "sha256", "wasm"] {
        let bytes = b"valid".to_vec();
        let mut info = manifest(&bytes);
        info[field] = match field {
            "abi" => json!(99),
            "bytes" => json!(MAX_HOST_BYTES + 1),
            "sha256" => json!("../bad"),
            _ => json!("../other.wasm"),
        };
        let (mut ws, task) = server(bytes, info, 1, |_| {}).await;
        let mut next_id = 0;
        assert!(artifact_in(
            &mut ws,
            &mut next_id,
            &mut VecDeque::new(),
            &Cache::new().0,
            &mut Diagnostics::new(false),
        )
        .await
        .is_err());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn unsupported_scene_host_command_reports_an_engine_upgrade() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/devtools/browser", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let request: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        ws.send(Message::Text(
            json!({"id":request["id"],"error":{"code":-32601,"message":"Method not found"}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    });
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut next_id = 0;
    let error = artifact_in(
        &mut ws,
        &mut next_id,
        &mut VecDeque::new(),
        &Cache::new().0,
        &mut Diagnostics::new(false),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("Upgrade the connected engine"));
    task.await.unwrap();
}

#[test]
fn retained_frame_capability_defaults_off_for_older_manifests() {
    let mut info = manifest(b"valid");
    info.as_object_mut().unwrap().remove("retainedFrames");
    assert!(
        !serde_json::from_value::<Manifest>(info.clone())
            .unwrap()
            .retained_frames
    );
    info["retainedFrames"] = json!(true);
    assert!(
        serde_json::from_value::<Manifest>(info)
            .unwrap()
            .retained_frames
    );
}
