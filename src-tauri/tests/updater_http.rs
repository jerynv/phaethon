//! Updates over real HTTP against a local fake release server, through the real
//! tauri-plugin-updater: a release signed with the bundled key is downloaded and
//! its bytes handed back; one signed with another key, one whose file was altered,
//! one whose signature names another version, and one whose signature names none
//! are refused before anything is installed. Keys are made per run, in memory,
//! and dropped with it. Nothing is ever installed (only `download` runs).
//!
//! The plugin only allows a plain-http feed in debug builds, which tests are; the
//! app itself never counts an http feed as set up (updater.rs `setup_of`).

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use minisign::KeyPair;
use phaethon_lib::updater;
use serde_json::json;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The plugin's `pubkey`: base64 of the minisign public key file.
fn pubkey_of(kp: &KeyPair) -> String {
    B64.encode(kp.pk.to_box().unwrap().into_string())
}

/// A `.sig` as tauri's bundler writes it (base64 of the minisign signature file), its
/// trusted comment naming `version` when given.
fn sign(kp: &KeyPair, data: &[u8], version: Option<&str>) -> String {
    let trusted = match version {
        Some(v) => format!("timestamp:1760000000\tfile:Phaethon.app.tar.gz\tversion:{v}"),
        None => "timestamp:1760000000\tfile:Phaethon.app.tar.gz".to_string(),
    };
    let sig = minisign::sign(Some(&kp.pk), &kp.sk, data, Some(&trusted), Some("signature from tauri secret key")).unwrap();
    B64.encode(sig.into_string())
}

/// Bind a server, let `fill` add the files that name its address, then serve them
/// all by path, as many requests as come.
async fn serve_with(files: &mut HashMap<String, Vec<u8>>, fill: impl FnOnce(&str, &mut HashMap<String, Vec<u8>>)) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    fill(&base, files);
    let files = Arc::new(std::mem::take(files));
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let files = files.clone();
            tokio::spawn(async move {
                let mut req = Vec::new();
                let mut buf = [0u8; 8192];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut buf).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    req.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&req);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = match files.get(&path) {
                    Some(b) => ("200 OK", b.clone()),
                    None => ("404 Not Found", b"not found".to_vec()),
                };
                let head = format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            });
        }
    });
    base
}

/// The feed for every platform this test could run on, each pointing at `file`.
fn feed(base: &str, version: &str, file: &str, signature: &str) -> Vec<u8> {
    let entry = json!({"url": format!("{base}/{file}"), "signature": signature});
    let platforms: serde_json::Map<String, serde_json::Value> = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "linux-aarch64", "windows-x86_64", "windows-aarch64"]
        .iter()
        .map(|p| (p.to_string(), entry.clone()))
        .collect();
    json!({"version": version, "notes": "- Faster start\n- Fixes", "pub_date": "2026-10-12T09:00:00Z", "platforms": platforms})
        .to_string()
        .into_bytes()
}

/// An app (version 0.1.0) whose bundled updater key is `pubkey`.
fn app_with_key(pubkey: &str) -> tauri::App<tauri::test::MockRuntime> {
    let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
    ctx.config_mut()
        .plugins
        .0
        .insert("updater".into(), json!({"pubkey": pubkey, "endpoints": [], "requireSignedVersion": true}));
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_release_signed_with_the_bundled_key_for_its_version_is_accepted() {
    let ours = KeyPair::generate_unencrypted_keypair().unwrap();
    let theirs = KeyPair::generate_unencrypted_keypair().unwrap();
    let artifact = b"pretend this is Phaethon.app.tar.gz".repeat(4000);
    let mut altered = artifact.clone();
    altered[100] ^= 1;

    let mut files = HashMap::new();
    files.insert("/good.tar.gz".to_string(), artifact.clone());
    files.insert("/altered.tar.gz".to_string(), altered);
    // The feeds name the server's own address, so they are made once it is bound.
    let base = serve_with(&mut files, |base, f| {
        f.insert("/good.json".into(), feed(base, "9.0.0", "good.tar.gz", &sign(&ours, &artifact, Some("9.0.0"))));
        f.insert("/other-key.json".into(), feed(base, "9.0.0", "good.tar.gz", &sign(&theirs, &artifact, Some("9.0.0"))));
        f.insert("/altered.json".into(), feed(base, "9.0.0", "altered.tar.gz", &sign(&ours, &artifact, Some("9.0.0"))));
        // An old, genuinely signed build announced as a newer version (a downgrade by an altered feed).
        f.insert("/wrong-version.json".into(), feed(base, "9.0.0", "good.tar.gz", &sign(&ours, &artifact, Some("0.0.9"))));
        f.insert("/no-version.json".into(), feed(base, "9.0.0", "good.tar.gz", &sign(&ours, &artifact, None)));
        f.insert("/same.json".into(), feed(base, "0.1.0", "good.tar.gz", &sign(&ours, &artifact, Some("0.1.0"))));
        f.insert("/garbage-sig.json".into(), feed(base, "9.0.0", "good.tar.gz", "bm90IGEgc2lnbmF0dXJl"));
    })
    .await;

    let app = app_with_key(&pubkey_of(&ours));
    let handle = app.app_handle().clone();
    let at = |path: &str| vec![Url::parse(&format!("{base}{path}")).unwrap()];

    // Signed with our key, for the version announced: found, with its notes, and its bytes come back.
    let update = updater::check(&handle, Some(at("/good.json"))).await.unwrap().expect("9.0.0 is newer than 0.1.0");
    assert_eq!(update.version, "9.0.0");
    assert_eq!(update.body.as_deref(), Some("- Faster start\n- Fixes"));
    let mut steps = vec![];
    let bytes = updater::download_verified(&update, |received, total| steps.push((received, total))).await.unwrap();
    assert_eq!(bytes, artifact);
    assert_eq!(steps.last(), Some(&(artifact.len() as u64, Some(artifact.len() as u64))), "progress ends at the whole file");
    assert!(steps.len() <= 101, "progress is said in steps, not per chunk: {}", steps.len());

    // Each of these is announced as an update but refused at download, with the signature words.
    for (path, why) in [
        ("/other-key.json", "signed with a key that isn't the bundled one"),
        ("/altered.json", "the file was altered after signing"),
        ("/wrong-version.json", "the signature names another version"),
        ("/no-version.json", "the signature names no version"),
        ("/garbage-sig.json", "the signature isn't a signature"),
    ] {
        let update = updater::check(&handle, Some(at(path))).await.unwrap().unwrap_or_else(|| panic!("{why}: announced"));
        let err = updater::download_verified(&update, |_, _| {}).await.expect_err(why);
        assert!(updater::words(&err).contains("signature check"), "{why}: {err} -> {}", updater::words(&err));
    }

    // The same version as this one: nothing to do.
    assert!(updater::check(&handle, Some(at("/same.json"))).await.unwrap().is_none());
    // No feed there: said in words, not a panic.
    let err = updater::check(&handle, Some(at("/missing.json"))).await.err().expect("404 is an error");
    assert!(!updater::words(&err).is_empty());
}

/// The published feed, read as an older Phaethon would: the shipped key and endpoint
/// find the latest release and its download passes the signature check for this
/// computer's build. Uses the network, so run on purpose:
/// `cargo test --test updater_http -- --ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn the_published_release_verifies_with_the_shipped_key() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
    ctx.config_mut().plugins.0.insert("updater".into(), conf["plugins"]["updater"].clone());
    ctx.package_info_mut().version = "0.0.1".parse().unwrap();
    let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(ctx).unwrap();

    let update = updater::check(app.app_handle(), None).await.unwrap().expect("a release newer than 0.0.1 is published");
    eprintln!("found {} at {}", update.version, update.download_url);
    let bytes = updater::download_verified(&update, |_, _| {}).await.unwrap();
    assert!(bytes.len() > 1_000_000, "{} bytes", bytes.len());
}
