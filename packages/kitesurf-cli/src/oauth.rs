// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env::var,
    future::Future,
    io::{self, IsTerminal, Write},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const DEFAULT_CLIENT_ID: &str = "c9007ad1-f329-4bc0-93b5-931f78e8e64e";
const REDIRECT_URI: &str = "http://localhost:8976/oauth/callback";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const KEYRING_SERVICE: &str = "kitesurf-cli";
const KEYRING_USER: &str = "cloudflare-oauth";
const SCOPES: &str = "browser-rendering.write account-settings.read offline_access";

struct OAuth {
    client_id: String,
    client: reqwest::Client,
    authorize: Url,
    token: Url,
    revoke: Url,
    accounts: Url,
}

#[derive(Deserialize, Serialize)]
struct Credentials {
    account_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Debug)]
struct RejectedGrant;

impl std::fmt::Display for RejectedGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cloudflare rejected the OAuth grant; run 'kitesurf login' again")
    }
}

impl std::error::Error for RejectedGrant {}

#[derive(Deserialize)]
struct TokenErrorResponse {
    error: String,
}

#[derive(Deserialize)]
struct Account {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct AccountPage {
    success: bool,
    result: Option<Vec<Account>>,
    result_info: Option<PageInfo>,
}

#[derive(Deserialize)]
struct PageInfo {
    total_pages: Option<u64>,
}

impl OAuth {
    fn new() -> Result<Self> {
        let client_id = var("KITESURF_OAUTH_CLIENT_ID").ok();
        Self::with_client_id(client_id.as_deref())
    }

    fn with_client_id(client_id: Option<&str>) -> Result<Self> {
        let client_id = client_id.unwrap_or(DEFAULT_CLIENT_ID);
        if client_id.is_empty()
            || client_id
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control())
        {
            return Err("KITESURF_OAUTH_CLIENT_ID must be a non-empty client ID without whitespace or control characters".into());
        }
        Ok(Self {
            client_id: client_id.to_owned(),
            client: crate::tls::client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()?,
            authorize: Url::parse("https://dash.cloudflare.com/oauth2/auth")?,
            token: Url::parse("https://dash.cloudflare.com/oauth2/token")?,
            revoke: Url::parse("https://dash.cloudflare.com/oauth2/revoke")?,
            accounts: Url::parse("https://api.cloudflare.com/client/v4/accounts")?,
        })
    }

    fn keyring_user(&self) -> String {
        format!("{KEYRING_USER}:{}", self.client_id)
    }

    fn entry(&self) -> Result<keyring::Entry> {
        Ok(keyring::Entry::new(KEYRING_SERVICE, &self.keyring_user())?)
    }

    fn authorization_url(&self, state: &str, verifier: &str) -> Url {
        let mut url = self.authorize.clone();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            // Registered permissions are an allowlist, not the requested scopes' defaults.
            ("scope", SCOPES),
            ("state", state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        url
    }

    async fn exchange(&self, grant: &[(&str, &str)]) -> Result<TokenResponse> {
        let response = self
            .client
            .post(self.token.clone())
            .form(
                &[("client_id", self.client_id.as_str())]
                    .into_iter()
                    .chain(grant.iter().copied())
                    .collect::<Vec<_>>(),
            )
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            if matches!(
                status,
                reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
            ) && response
                .json::<TokenErrorResponse>()
                .await
                .is_ok_and(|body| body.error == "invalid_grant")
            {
                return Err(RejectedGrant.into());
            }
            return Err(format!("Cloudflare OAuth token exchange failed (HTTP {status})").into());
        }
        let tokens: TokenResponse = response
            .json()
            .await
            .map_err(|_| "Cloudflare returned an invalid OAuth token response")?;
        if !tokens.token_type.eq_ignore_ascii_case("bearer")
            || tokens.access_token.is_empty()
            || tokens.expires_in == 0
        {
            return Err("Cloudflare returned an unsupported OAuth token response".into());
        }
        crate::access::bearer(&tokens.access_token)?;
        Ok(tokens)
    }

    async fn accounts(&self, token: &str) -> Result<Vec<Account>> {
        let mut accounts = Vec::new();
        let mut page = 1;
        loop {
            let response = self
                .client
                .get(self.accounts.clone())
                .bearer_auth(token)
                .query(&[("page", page), ("per_page", 50)])
                .send()
                .await?;
            if !response.status().is_success() {
                return Err(format!("Could not discover Cloudflare accounts (HTTP {}); check the OAuth client's account-read permission", response.status()).into());
            }
            let result: AccountPage = response.json().await?;
            if !result.success {
                return Err("Cloudflare account discovery failed; check the OAuth client's account-read permission".into());
            }
            let batch = result
                .result
                .ok_or("Cloudflare account discovery returned no result")?;
            for account in &batch {
                validate_account_id(&account.id)?;
            }
            let count = batch.len();
            accounts.extend(batch);
            if let Some(total_pages) = result.result_info.and_then(|info| info.total_pages) {
                if page >= total_pages {
                    break;
                }
            } else if count < 50 {
                break;
            }
            page += 1;
        }
        Ok(accounts)
    }

    async fn revoke(&self, token: &str, hint: &str) -> Result<()> {
        let response = self
            .client
            .post(self.revoke.clone())
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("token", token),
                ("token_type_hint", hint),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(format!(
                "Cloudflare OAuth revocation failed (HTTP {})",
                response.status()
            )
            .into());
        }
        Ok(())
    }
}

fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn random_secret() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "could not generate OAuth login randomness")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn validate_account_id(account: &str) -> Result<()> {
    if account.len() != 32 || !account.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Cloudflare account ID must contain 32 hexadecimal characters".into());
    }
    Ok(())
}

fn load(entry: &keyring::Entry) -> Result<Option<Credentials>> {
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("Could not read the OS keyring: {error}").into()),
    };
    let credentials: Credentials = serde_json::from_str(&value)
        .map_err(|_| "Saved OAuth credentials are invalid; run 'kitesurf login' again")?;
    validate_account_id(&credentials.account_id)?;
    Ok(Some(credentials))
}

async fn load_or_login(
    entry: &keyring::Entry,
    login: impl Future<Output = Result<Credentials>>,
) -> Result<Credentials> {
    match load(entry)? {
        Some(credentials) => Ok(credentials),
        None => login.await,
    }
}

fn save(entry: &keyring::Entry, credentials: &Credentials) -> Result<()> {
    entry
        .set_password(&serde_json::to_string(credentials)?)
        .map_err(|error| format!("Could not save OAuth credentials in the OS keyring: {error}"))?;
    Ok(())
}

impl Credentials {
    fn update(&mut self, response: TokenResponse, now: u64) -> Result<()> {
        self.expires_at = now
            .checked_add(response.expires_in)
            .ok_or("invalid OAuth token expiry")?;
        self.access_token = response.access_token;
        if response.refresh_token.is_some() {
            self.refresh_token = response.refresh_token;
        }
        Ok(())
    }
}

async fn refresh(
    oauth: &OAuth,
    entry: &keyring::Entry,
    credentials: &mut Credentials,
    now: u64,
    login: impl Future<Output = Result<Credentials>>,
) -> Result<()> {
    if credentials.expires_at > now.saturating_add(60) {
        return Ok(());
    }
    let tokens = match credentials.refresh_token.as_deref() {
        Some(refresh_token) => match oauth.exchange(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)]).await {
            Ok(tokens) => Some(tokens),
            Err(error) if error.is::<RejectedGrant>() => None,
            Err(error) => return Err(format!("Could not refresh the saved Cloudflare login: {error}; try again. Saved credentials were kept.").into()),
        },
        None => None,
    };
    let Some(tokens) = tokens else {
        eprintln!("Saved Cloudflare login could not be refreshed; signing in again.");
        *credentials = login.await?;
        return Ok(());
    };
    credentials.update(tokens, now)?;
    save(entry, credentials)
}

pub async fn credentials() -> Result<(String, String)> {
    let oauth = OAuth::new()?;
    let entry = oauth.entry()?;
    let mut credentials = load_or_login(&entry, login_with(&oauth, &entry)).await?;
    refresh(
        &oauth,
        &entry,
        &mut credentials,
        now()?,
        login_with(&oauth, &entry),
    )
    .await?;
    Ok((credentials.account_id, credentials.access_token))
}

pub async fn login() -> Result<()> {
    login_credentials().await.map(|_| ())
}

pub async fn login_credentials() -> Result<(String, String)> {
    let oauth = OAuth::new()?;
    let credentials = login_with(&oauth, &oauth.entry()?).await?;
    Ok((credentials.account_id, credentials.access_token))
}

async fn login_with(oauth: &OAuth, entry: &keyring::Entry) -> Result<Credentials> {
    let requested_account = var("CLOUDFLARE_ACCOUNT_ID").ok();
    if let Some(account) = &requested_account {
        validate_account_id(account)?;
    }
    let listener = TcpListener::bind(("127.0.0.1", 8976))
        .await
        .map_err(|error| {
            format!("Could not listen for OAuth callback on localhost:8976: {error}")
        })?;
    // Browsers may resolve the registered localhost redirect to either loopback family.
    let ipv6 = match TcpListener::bind(("::1", 8976)).await {
        Ok(listener) => Some(listener),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
            ) =>
        {
            None
        }
        Err(error) => {
            return Err(
                format!("Could not listen for OAuth callback on [::1]:8976: {error}").into(),
            )
        }
    };
    let verifier = random_secret()?;
    let state = random_secret()?;
    let url = oauth.authorization_url(&state, &verifier);
    println!("Open this URL to authorize Kitesurf:\n{url}");
    open_browser(url.as_str());
    let code = tokio::time::timeout(LOGIN_TIMEOUT, callback(&listener, ipv6.as_ref(), &state))
        .await
        .map_err(|_| {
            "Cloudflare login timed out after five minutes; run 'kitesurf login' again"
        })??;
    eprintln!("Cloudflare authorization received; exchanging the code.");
    let tokens = oauth
        .exchange(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", &verifier),
        ])
        .await?;
    eprintln!("Discovering authorized Cloudflare accounts.");
    let accounts = oauth.accounts(&tokens.access_token).await?;
    let account = select_account(&accounts, requested_account.as_deref())?;
    let mut credentials = Credentials {
        account_id: account.id.clone(),
        access_token: String::new(),
        refresh_token: None,
        expires_at: 0,
    };
    credentials.update(tokens, now()?)?;
    save(entry, &credentials)?;
    println!(
        "Logged in to Cloudflare account {} ({}).",
        account.name.escape_default(),
        account.id
    );
    if credentials.refresh_token.is_none() {
        eprintln!(
            "Cloudflare did not issue a refresh token; login will be needed again after expiry."
        );
    }
    Ok(credentials)
}

fn select_account<'a>(accounts: &'a [Account], requested: Option<&str>) -> Result<&'a Account> {
    if let Some(id) = requested {
        validate_account_id(id)?;
        return accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| "CLOUDFLARE_ACCOUNT_ID was not authorized by this login".into());
    }
    match accounts {
        [] => Err("No Cloudflare accounts were authorized for Kitesurf".into()),
        [account] => Ok(account),
        _ => {
            if !io::stdin().is_terminal() {
                return Err("Multiple Cloudflare accounts are available; set CLOUDFLARE_ACCOUNT_ID and run 'kitesurf login' again".into());
            }
            for (index, account) in accounts.iter().enumerate() {
                println!(
                    "  {}. {} ({})",
                    index + 1,
                    account.name.escape_default(),
                    account.id
                );
            }
            print!("Select an account [1-{}]: ", accounts.len());
            io::stdout().flush()?;
            let mut line = String::new();
            io::stdin().read_line(&mut line)?;
            let index = line
                .trim()
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1));
            index
                .and_then(|index| accounts.get(index))
                .ok_or_else(|| "Invalid account selection".into())
        }
    }
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "windows")]
    let command = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let command = "xdg-open";
    match std::process::Command::new(command).arg(url).spawn() {
        Ok(mut child) => {
            // Some browser launchers wait for the browser to exit. Keep serving the callback.
            std::thread::spawn(move || {
                if child.wait().map_or(true, |status| !status.success()) {
                    eprintln!(
                        "Could not open a browser automatically; open the URL above manually."
                    );
                }
            });
        }
        Err(_) => eprintln!("Could not open a browser automatically; open the URL above manually."),
    }
}

fn callback_code(target: &str, state: &str) -> Result<Option<String>> {
    if !target.starts_with('/') || target.starts_with("//") {
        return Ok(None);
    }
    // A target that does not join onto the redirect URI is an unrelated
    // request; it must not end the login.
    let Ok(url) = Url::parse(REDIRECT_URI)?.join(target) else {
        return Ok(None);
    };
    if url.origin() != Url::parse(REDIRECT_URI)?.origin() || url.path() != "/oauth/callback" {
        return Ok(None);
    }
    let values = |key: &str| {
        url.query_pairs()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>()
    };
    if values("state") != [state] {
        return Ok(None);
    }
    let errors = values("error");
    if !errors.is_empty() {
        let message = match errors.first().map(String::as_str) {
            Some("invalid_scope") => "Cloudflare rejected the OAuth scopes (invalid_scope). Allow browser-rendering.write and account-settings.read in the Kitesurf OAuth client registration, and enable the refresh_token grant to allow offline_access.",
            Some("unauthorized_client") => "Cloudflare rejected the OAuth client (unauthorized_client). Check Authorization Code, PKCE, and token authentication method none in the client registration.",
            Some("access_denied") => "Cloudflare authorization was denied (access_denied). Check consent and the account's OAuth access policy.",
            Some("invalid_request") => "Cloudflare rejected the OAuth request (invalid_request). Check the registered redirect URI and client configuration.",
            _ => "Cloudflare authorization was denied or failed",
        };
        return Err(message.into());
    }
    let codes = values("code");
    if codes.len() != 1 || codes[0].is_empty() {
        return Ok(None);
    }
    Ok(codes.into_iter().next())
}

async fn callback(
    listener: &TcpListener,
    ipv6: Option<&TcpListener>,
    state: &str,
) -> Result<String> {
    loop {
        let (mut stream, _) = tokio::select! {
            connection = listener.accept() => connection?,
            connection = async { ipv6.expect("IPv6 listener is present").accept().await }, if ipv6.is_some() => connection?,
        };
        let request = tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            while bytes.len() < 8192 {
                let byte = stream.read_u8().await?;
                bytes.push(byte);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, io::Error>(bytes)
        })
        .await;
        let Ok(Ok(bytes)) = request else {
            continue;
        };
        if !bytes.ends_with(b"\r\n\r\n") {
            continue;
        }
        let request = String::from_utf8_lossy(&bytes);
        let mut parts = request.lines().next().unwrap_or("").split_whitespace();
        let result = if parts.next() == Some("GET") {
            callback_code(parts.next().unwrap_or(""), state)
        } else {
            Ok(None)
        };
        let (status, message) = match &result {
            Ok(Some(_)) => (
                "200 OK",
                "Cloudflare authorization received. Return to your terminal to finish login.",
            ),
            Ok(None) => ("400 Bad Request", "Invalid login callback."),
            Err(_) => (
                "400 Bad Request",
                "Cloudflare authorization failed. Return to your terminal.",
            ),
        };
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{message}", message.len());
        // A browser closing its callback tab must not discard a valid authorization code.
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            stream.write_all(response.as_bytes()),
        )
        .await;
        if let Some(code) = result? {
            return Ok(code);
        }
    }
}

pub async fn logout() -> Result<()> {
    let oauth = OAuth::new()?;
    logout_saved(&oauth, &oauth.entry()?).await
}

async fn logout_saved(oauth: &OAuth, entry: &keyring::Entry) -> Result<()> {
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            println!("No saved Cloudflare login.");
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    let revoke = async {
        let credentials: Credentials =
            serde_json::from_str(&value).map_err(|_| "Saved OAuth credentials are invalid")?;
        // Attempt both revocations even if one fails. Always remove the local credentials.
        let refresh = if let Some(token) = &credentials.refresh_token {
            oauth.revoke(token, "refresh_token").await
        } else {
            Ok(())
        };
        let access = oauth
            .revoke(&credentials.access_token, "access_token")
            .await;
        refresh.and(access)
    }
    .await;
    entry.delete_credential()?;
    println!("Removed saved Cloudflare login from the OS keyring.");
    revoke.map_err(|_| "Local login removed, but Cloudflare revocation failed; revoke Kitesurf in the dashboard's OAuth authorizations".into())
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
