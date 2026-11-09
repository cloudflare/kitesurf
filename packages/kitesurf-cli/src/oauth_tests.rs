// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use super::*;
use std::cell::Cell;
use std::collections::HashMap;
use crate::tls::client_builder;

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

fn mock_entry() -> keyring::Entry {
    keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
}

fn saved_credentials() -> Credentials {
    Credentials {
        account_id: ACCOUNT.into(),
        access_token: "old-access".into(),
        refresh_token: Some("old-refresh".into()),
        expires_at: 100,
    }
}

async fn mock_oauth(
    responses: Vec<(&'static str, String)>,
) -> (OAuth, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let oauth = OAuth {
        authorize: base.join("authorize").unwrap(),
        token: base.join("token").unwrap(),
        revoke: base.join("revoke").unwrap(),
        accounts: base.join("accounts").unwrap(),
        ..OAuth::with_client_id(None).unwrap()
    };
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(stream.read_u8().await.unwrap());
            }
            let header = String::from_utf8(bytes.clone()).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut body_bytes = vec![0; length];
            stream.read_exact(&mut body_bytes).await.unwrap();
            bytes.extend(body_bytes);
            requests.push(String::from_utf8(bytes).unwrap());
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (oauth, server)
}

fn form(request: &str) -> HashMap<String, String> {
    Url::parse(&format!(
        "https://example.com/?{}",
        request.split_once("\r\n\r\n").unwrap().1
    ))
    .unwrap()
    .query_pairs()
    .into_owned()
    .collect()
}

#[test]
fn authorization_requests_product_scopes_and_pkce_without_a_secret() {
    let oauth = OAuth::with_client_id(None).unwrap();
    // RFC 7636's known verifier/challenge pair catches encoding and hashing mistakes.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let url = oauth.authorization_url("random-state", verifier);
    assert_eq!(
        url.origin().ascii_serialization(),
        "https://dash.cloudflare.com"
    );
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], "c9007ad1-f329-4bc0-93b5-931f78e8e64e");
    assert_eq!(params["redirect_uri"], REDIRECT_URI);
    assert_eq!(params["state"], "random-state");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["code_challenge"],
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let scopes: std::collections::HashSet<_> = params["scope"].split_whitespace().collect();
    assert_eq!(
        scopes,
        [
            "browser-rendering.write",
            "account-settings.read",
            "offline_access"
        ]
        .into_iter()
        .collect()
    );
    assert!(!params.contains_key("client_secret"));
    assert!(!url.as_str().contains(verifier));
    let first = random_secret().unwrap();
    assert_eq!(first.len(), 43);
    assert_ne!(first, random_secret().unwrap());
}

#[test]
fn oauth_clients_have_distinct_keyring_entries_and_reject_empty_overrides() {
    let official = OAuth::with_client_id(None).unwrap();
    let staging = OAuth::with_client_id(Some("staging-client")).unwrap();
    assert_eq!(official.client_id, "c9007ad1-f329-4bc0-93b5-931f78e8e64e");
    assert_eq!(staging.client_id, "staging-client");
    assert_ne!(official.keyring_user(), staging.keyring_user());
    assert_eq!(staging.keyring_user(), "cloudflare-oauth:staging-client");
    for invalid in [
        "",
        " ",
        "staging\nclient",
        " staging-client",
        "staging\0client",
    ] {
        let error = OAuth::with_client_id(Some(invalid))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("KITESURF_OAUTH_CLIENT_ID"));
    }
}

#[tokio::test]
async fn overridden_client_id_reaches_authorization_exchange_refresh_and_logout() {
    let response = r#"{"access_token":"access","token_type":"Bearer","expires_in":3600,"refresh_token":"refresh"}"#;
    let (mut oauth, server) = mock_oauth(vec![
        ("200 OK", response.into()),
        ("200 OK", response.into()),
        ("200 OK", "{}".into()),
        ("200 OK", "{}".into()),
    ])
    .await;
    oauth.client_id = OAuth::with_client_id(Some("staging-client"))
        .unwrap()
        .client_id;
    let url = oauth.authorization_url("state", "verifier");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], "staging-client");

    let tokens = oauth
        .exchange(&[("grant_type", "authorization_code"), ("code", "code")])
        .await
        .unwrap();
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    credentials.update(tokens, 100).unwrap();
    save(&entry, &credentials).unwrap();
    refresh(&oauth, &entry, &mut credentials, 3700, async {
        panic!("successful refresh must not launch a browser login");
    })
    .await
    .unwrap();
    logout_saved(&oauth, &entry).await.unwrap();

    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 4);
    for request in &requests {
        assert_eq!(form(request)["client_id"], "staging-client");
        assert!(!request.contains(DEFAULT_CLIENT_ID));
    }
    assert_eq!(form(&requests[0])["grant_type"], "authorization_code");
    assert_eq!(form(&requests[1])["grant_type"], "refresh_token");
    assert_eq!(form(&requests[2])["token_type_hint"], "refresh_token");
    assert_eq!(form(&requests[3])["token_type_hint"], "access_token");
}

#[test]
fn callback_rejects_wrong_state_path_and_ambiguous_parameters() {
    for target in [
        "/oauth/callback?code=secret",
        "/oauth/callback?code=secret&state=wrong",
        "/favicon.ico?code=secret&state=expected",
        "/oauth/callback?state=expected",
        "/oauth/callback?code=&state=expected",
        "/oauth/callback?code=secret&state=expected&state=wrong",
        "/oauth/callback?code=secret&code=other&state=expected",
        "https://example.com/oauth/callback?code=secret&state=expected",
        "/\\example.com/oauth/callback?code=secret&state=expected",
    ] {
        assert!(
            callback_code(target, "expected").unwrap().is_none(),
            "{target}"
        );
    }
    assert!(callback_code(
        "/oauth/callback?error=access_denied&state=expected",
        "expected"
    )
    .is_err());
    let error = callback_code(
        "/oauth/callback?error=invalid_scope&error_description=secret&state=expected",
        "expected",
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("invalid_scope"));
    assert!(error.contains("account-settings.read"));
    assert!(error.contains("refresh_token"));
    assert!(!error.contains("secret"));
    assert_eq!(
        callback_code(
            "/oauth/callback?code=valid%2Bcode&state=expected",
            "expected"
        )
        .unwrap()
        .as_deref(),
        Some("valid+code")
    );
}

#[tokio::test]
async fn callback_listener_ignores_unrelated_requests_then_delivers_code() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let browser = async {
        let client = client_builder().build().unwrap();
        let invalid = client
            .get(format!("{origin}/oauth/callback?code=wrong&state=wrong"))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400);
        let valid = client
            .get(format!("{origin}/oauth/callback?code=valid&state=expected"))
            .send()
            .await
            .unwrap();
        assert_eq!(valid.status(), 200);
        assert_eq!(valid.headers()["cache-control"], "no-store");
        assert!(!valid.text().await.unwrap().contains("valid"));
    };
    let (code, _) = tokio::join!(callback(&listener, None, "expected"), browser);
    assert_eq!(code.unwrap(), "valid");
}

#[tokio::test]
async fn callback_accepts_ipv6_localhost_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ipv6 = TcpListener::bind("[::1]:0").await.unwrap();
    let url = format!(
        "http://{}/oauth/callback?code=valid&state=expected",
        ipv6.local_addr().unwrap()
    );
    let browser = async {
        assert_eq!(
            client_builder()
                .build()
                .unwrap()
                .get(url)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    };
    let (code, _) = tokio::join!(callback(&listener, Some(&ipv6), "expected"), browser);
    assert_eq!(code.unwrap(), "valid");
}

#[tokio::test]
async fn code_exchange_sends_verifier_without_client_secret() {
    let (oauth, server) = mock_oauth(vec![("200 OK", r#"{"access_token":"access","token_type":"Bearer","expires_in":3600,"refresh_token":"refresh"}"#.into())]).await;
    let tokens = oauth
        .exchange(&[
            ("grant_type", "authorization_code"),
            ("code", "code+value"),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", "verifier"),
        ])
        .await
        .unwrap();
    assert_eq!(tokens.access_token, "access");
    let requests = server.await.unwrap();
    let params = form(&requests[0]);
    assert_eq!(params["client_id"], DEFAULT_CLIENT_ID);
    assert_eq!(params["code"], "code+value");
    assert_eq!(params["code_verifier"], "verifier");
    assert_eq!(params["redirect_uri"], REDIRECT_URI);
    assert!(!params.contains_key("client_secret"));
    assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn refresh_rotates_and_persists_tokens_before_returning_credentials() {
    let (oauth, server) = mock_oauth(vec![
        ("200 OK", r#"{"access_token":"new-access","token_type":"Bearer","expires_in":3600,"refresh_token":"new-refresh"}"#.into()),
        ("200 OK", r#"{"access_token":"next-access","token_type":"Bearer","expires_in":3600}"#.into()),
    ]).await;
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    refresh(&oauth, &entry, &mut credentials, 100, async {
        panic!("successful refresh must not launch a browser login");
    })
    .await
    .unwrap();
    let saved = load(&entry).unwrap().unwrap();
    assert_eq!(saved.access_token, "new-access");
    assert_eq!(saved.refresh_token.as_deref(), Some("new-refresh"));
    assert_eq!(saved.expires_at, 3700);
    refresh(&oauth, &entry, &mut credentials, 200, async {
        panic!("unexpired credentials must not launch a browser login");
    })
    .await
    .unwrap();
    assert_eq!(credentials.access_token, "new-access");
    refresh(&oauth, &entry, &mut credentials, 3650, async {
        panic!("successful refresh must not launch a browser login");
    })
    .await
    .unwrap();
    assert_eq!(
        load(&entry).unwrap().unwrap().refresh_token.as_deref(),
        Some("new-refresh")
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(form(&requests[0])["refresh_token"], "old-refresh");
    assert_eq!(form(&requests[1])["refresh_token"], "new-refresh");
    assert_eq!(form(&requests[1])["grant_type"], "refresh_token");
}

#[tokio::test]
async fn transient_refresh_failures_preserve_credentials_without_login() {
    for (status, body) in [
        ("503 Service Unavailable", "old-refresh is secret"),
        ("429 Too Many Requests", "old-refresh is secret"),
        ("400 Bad Request", r#"{"error":"invalid_client"}"#),
        ("200 OK", "not JSON"),
    ] {
        let (oauth, server) = mock_oauth(vec![(status, body.into())]).await;
        let entry = mock_entry();
        let mut credentials = saved_credentials();
        save(&entry, &credentials).unwrap();
        let error = refresh(&oauth, &entry, &mut credentials, 100, async {
            panic!("temporary refresh failures must not launch a browser login");
        })
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("try again"), "{error}");
        assert!(!error.contains("old-refresh"));
        assert_eq!(credentials.access_token, "old-access");
        assert_eq!(
            load(&entry).unwrap().unwrap().refresh_token.as_deref(),
            Some("old-refresh")
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn refresh_connection_failure_preserves_credentials_without_login() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut oauth = OAuth::with_client_id(None).unwrap();
    oauth.token = Url::parse(&format!("http://{}/token", listener.local_addr().unwrap())).unwrap();
    drop(listener);
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    let error = refresh(&oauth, &entry, &mut credentials, 100, async {
        panic!("connection failures must not launch a browser login");
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("try again"), "{error}");
    assert_eq!(load(&entry).unwrap().unwrap().access_token, "old-access");
}

#[tokio::test]
async fn refresh_timeout_preserves_credentials_without_login() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut oauth = OAuth::with_client_id(None).unwrap();
    oauth.token = Url::parse(&format!("http://{}/token", listener.local_addr().unwrap())).unwrap();
    oauth.client = client_builder()
        .timeout(Duration::from_millis(20))
        .build()
        .unwrap();
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    let error = refresh(&oauth, &entry, &mut credentials, 100, async {
        panic!("timeouts must not launch a browser login");
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("try again"), "{error}");
    assert_eq!(load(&entry).unwrap().unwrap().access_token, "old-access");
}

#[tokio::test]
async fn failed_refresh_starts_login_and_replaces_saved_credentials() {
    let (oauth, server) = mock_oauth(vec![(
        "400 Bad Request",
        r#"{"error":"invalid_grant","error_description":"old-refresh is secret"}"#.into(),
    )])
    .await;
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    let login_count = Cell::new(0);
    refresh(&oauth, &entry, &mut credentials, 100, async {
        login_count.set(login_count.get() + 1);
        let credentials = Credentials {
            account_id: "abcdef0123456789abcdef0123456789".into(),
            access_token: "login-access".into(),
            refresh_token: Some("login-refresh".into()),
            expires_at: 3700,
        };
        save(&entry, &credentials)?;
        Ok(credentials)
    })
    .await
    .unwrap();
    assert_eq!(login_count.get(), 1);
    assert_eq!(credentials.account_id, "abcdef0123456789abcdef0123456789");
    assert_eq!(credentials.access_token, "login-access");
    let saved = load(&entry).unwrap().unwrap();
    assert_eq!(saved.account_id, credentials.account_id);
    assert_eq!(saved.access_token, "login-access");
    assert_eq!(saved.refresh_token.as_deref(), Some("login-refresh"));
    assert_eq!(saved.expires_at, 3700);
    server.await.unwrap();
}

#[tokio::test]
async fn expired_login_without_refresh_token_starts_login_without_network() {
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    credentials.refresh_token = None;
    save(&entry, &credentials).unwrap();
    refresh(
        &OAuth::with_client_id(None).unwrap(),
        &entry,
        &mut credentials,
        100,
        async {
            let credentials = Credentials {
                access_token: "login-access".into(),
                ..saved_credentials()
            };
            save(&entry, &credentials)?;
            Ok(credentials)
        },
    )
    .await
    .unwrap();
    assert_eq!(credentials.access_token, "login-access");
    assert_eq!(load(&entry).unwrap().unwrap().access_token, "login-access");
}

#[tokio::test]
async fn failed_refresh_preserves_login_failure_without_exposing_server_body() {
    let (oauth, server) = mock_oauth(vec![(
        "400 Bad Request",
        r#"{"error":"invalid_grant","error_description":"old-refresh is secret"}"#.into(),
    )])
    .await;
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    let error = refresh(&oauth, &entry, &mut credentials, 100, async {
        Err("Cloudflare authorization was denied".into())
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("authorization was denied"));
    assert!(!error.contains("old-refresh"));
    assert_eq!(load(&entry).unwrap().unwrap().access_token, "old-access");
    assert_eq!(credentials.access_token, "old-access");
    server.await.unwrap();
}

#[tokio::test]
async fn refreshed_credentials_with_keyring_failure_do_not_restart_login() {
    let (oauth, server) = mock_oauth(vec![(
        "200 OK",
        r#"{"access_token":"new-access","token_type":"Bearer","expires_in":3600}"#.into(),
    )])
    .await;
    let entry = mock_entry();
    let mut credentials = saved_credentials();
    save(&entry, &credentials).unwrap();
    let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
    mock.set_error(keyring::Error::Invalid(
        "test".into(),
        "keyring failure".into(),
    ));
    let error = refresh(&oauth, &entry, &mut credentials, 100, async {
        panic!("a keyring failure must not launch a browser login");
    })
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("Could not save OAuth credentials"));
    server.await.unwrap();
}

#[tokio::test]
async fn missing_credentials_start_login_and_saved_credentials_skip_it() {
    let entry = mock_entry();
    let login_count = Cell::new(0);
    let credentials = load_or_login(&entry, async {
        login_count.set(login_count.get() + 1);
        let credentials = saved_credentials();
        save(&entry, &credentials)?;
        Ok(credentials)
    })
    .await
    .unwrap();
    assert_eq!(login_count.get(), 1);
    assert_eq!(credentials.account_id, ACCOUNT);
    assert_eq!(credentials.access_token, "old-access");

    let credentials = load_or_login(&entry, async {
        panic!("saved credentials must not launch a browser login");
    })
    .await
    .unwrap();
    assert_eq!(credentials.account_id, ACCOUNT);
    assert_eq!(login_count.get(), 1);
}

#[tokio::test]
async fn automatic_login_preserves_login_and_keyring_failures() {
    let entry = mock_entry();
    let error = load_or_login(&entry, async {
        Err("Cloudflare authorization was denied".into())
    })
    .await
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("authorization was denied"));
    assert!(load(&entry).unwrap().is_none());

    entry.set_password("invalid saved credentials").unwrap();
    let error = load_or_login(&entry, async {
        panic!("corrupt saved credentials must not be mistaken for a missing login");
    })
    .await
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("Saved OAuth credentials are invalid"));

    let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
    mock.set_error(keyring::Error::Invalid(
        "test".into(),
        "keyring failure".into(),
    ));
    let error = load_or_login(&entry, async {
        panic!("a keyring failure must not launch a browser login");
    })
    .await
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("Could not read the OS keyring"));
}

#[tokio::test]
async fn unsupported_tokens_and_account_permissions_fail_without_exposing_bodies() {
    for body in [
        r#"{"access_token":"secret","token_type":"MAC","expires_in":3600}"#,
        r#"{"access_token":"","token_type":"Bearer","expires_in":3600}"#,
        r#"{"access_token":"secret","token_type":"Bearer","expires_in":0}"#,
        r#"{"access_token":"secret","token_type":"Bearer","expires_in":"secret"}"#,
    ] {
        let (oauth, server) = mock_oauth(vec![("200 OK", body.into())]).await;
        let error = oauth
            .exchange(&[("grant_type", "authorization_code")])
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("secret"));
        server.await.unwrap();
    }
    let (oauth, server) = mock_oauth(vec![(
        "403 Forbidden",
        r#"{"secret":"access-token"}"#.into(),
    )])
    .await;
    let error = oauth
        .accounts("access-token")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("account-read"));
    assert!(!error.contains("access-token"));
    server.await.unwrap();
}

#[tokio::test]
async fn account_discovery_paginates_and_requires_an_authorized_selection() {
    let other = "abcdef0123456789abcdef0123456789";
    let (oauth, server) = mock_oauth(vec![
        ("200 OK", format!(r#"{{"success":true,"result":[{{"id":"{ACCOUNT}","name":"First"}}],"result_info":{{"total_pages":2}}}}"#)),
        ("200 OK", format!(r#"{{"success":true,"result":[{{"id":"{other}","name":"Second"}}],"result_info":{{"total_pages":2}}}}"#)),
    ]).await;
    let accounts = oauth.accounts("access").await.unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(
        select_account(&accounts, Some(other)).unwrap().name,
        "Second"
    );
    assert!(select_account(&accounts[..1], Some(other)).is_err());
    assert_eq!(select_account(&accounts[..1], None).unwrap().id, ACCOUNT);
    assert!(select_account(&[], None).is_err());
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("GET /accounts?page=1&per_page=50 "));
    assert!(requests[1].starts_with("GET /accounts?page=2&per_page=50 "));
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("authorization: bearer access\r\n"));
}

#[tokio::test]
async fn logout_removes_local_credentials_even_when_revocation_fails() {
    let (oauth, server) = mock_oauth(vec![
        ("500 Internal Server Error", "{}".into()),
        ("200 OK", "{}".into()),
    ])
    .await;
    let entry = mock_entry();
    save(&entry, &saved_credentials()).unwrap();
    let error = logout_saved(&oauth, &entry).await.unwrap_err().to_string();
    assert!(error.contains("Local login removed"));
    assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    let requests = server.await.unwrap();
    assert_eq!(form(&requests[0])["token"], "old-refresh");
    assert_eq!(form(&requests[1])["token"], "old-access");
    assert_eq!(form(&requests[0])["token_type_hint"], "refresh_token");
}
