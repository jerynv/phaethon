//! Updates from the project's own GitHub Releases, through tauri-plugin-updater.
//!
//! Where updates come from is set in one place: `plugins.updater` in
//! tauri.conf.json. `endpoints` names the release feed, for GitHub
//! `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
//! (the `latest.json` tauri-action uploads beside each release), and `pubkey` is
//! the public half of the release signing key (`pnpm tauri signer generate`, the
//! contents of the .pub file, never a path). The repository, feed and key are
//! configured in the shipped build.
//!
//! What protects a person:
//! - Only `https` feeds count as set up (the plugin itself allows `http` in
//!   debug builds; this module never does).
//! - The plugin verifies each download's minisign signature against the
//!   bundled `pubkey` before anything is written, and with
//!   `requireSignedVersion` the signature must name the version the feed
//!   announced, so an altered feed can't pair a new number with an old build.
//! - The webview has no updater or process permission: it asks this module's
//!   own commands, which take no address, key or file from it.
//! - A development build checks but never installs over itself.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};
use url::Url;

/// How long one check or download may wait on the network before giving up.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
/// Wait after launch before the quiet check, so it never competes with startup.
const LAUNCH_DELAY: Duration = Duration::from_secs(20);
/// Release notes longer than this are cut (they are shown, never run).
const NOTES_MAX_CHARS: usize = 20_000;
/// The pause between "installed" and the restart, so it can be said first.
const RESTART_PAUSE: Duration = Duration::from_millis(1500);

/// Whether this build knows where its updates come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Setup {
    /// `source` is what to call the feed in words: `owner/repo` on GitHub, else its host.
    Ready { source: String },
    NotSetUp { reason: &'static str },
}

/// Read `plugins.updater` from tauri.conf.json. Set up only with a public key
/// that reads as a minisign key and at least one feed, every one of them `https`.
pub fn setup_of(conf: Option<&serde_json::Value>) -> Setup {
    let not = |reason| Setup::NotSetUp { reason };
    let Some(conf) = conf else {
        return not("This build has no update settings.");
    };
    let pubkey = conf.get("pubkey").and_then(|v| v.as_str()).unwrap_or("").trim();
    let endpoints: Vec<&str> = conf
        .get("endpoints")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if endpoints.is_empty() {
        return not("This build doesn’t name a place to get updates from.");
    }
    if pubkey.is_empty() {
        return not("This build has no key to check updates with.");
    }
    if !is_minisign_public_key(pubkey) {
        return not("This build’s key for checking updates can’t be read.");
    }
    let mut urls = vec![];
    for e in endpoints {
        match Url::parse(e) {
            Ok(u) if u.scheme() == "https" && u.host_str().is_some() && !e.contains("<") => urls.push(u),
            _ => return not("This build names a place to get updates from that isn’t a secure (https) address."),
        }
    }
    Setup::Ready { source: source_name(&urls[0]) }
}

/// The plugin's `pubkey` is base64 of a minisign public key file: a comment line, then the key.
fn is_minisign_public_key(pubkey: &str) -> bool {
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(pubkey) else {
        return false;
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    let mut lines = text.lines();
    let comment = lines.next().unwrap_or("");
    let key = lines.next().unwrap_or("").trim();
    comment.starts_with("untrusted comment:")
        && base64::engine::general_purpose::STANDARD
            .decode(key)
            .is_ok_and(|k| k.len() == 42 && k.starts_with(b"Ed"))
}

/// `owner/repo` for a GitHub release feed, else the feed's host.
fn source_name(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    if host == "github.com" {
        let parts: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
        if parts.len() >= 2 {
            return format!("{}/{}", parts[0], parts[1]);
        }
    }
    host.to_string()
}

/// Where the update flow stands, for Settings › About.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Status {
    /// No feed or key in this build: nothing is ever checked.
    NotSetUp { reason: String },
    /// Set up, not checked yet this launch.
    Idle,
    Checking,
    UpToDate { checked_at: u64 },
    Available { version: String, notes: Option<String>, date: Option<String> },
    /// `during`: "check" (asked for in Settings) or "launch" (the quiet check when Phaethon started).
    Error { message: String, during: &'static str },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub current_version: String,
    /// `owner/repo` (or a host) when set up.
    pub source: Option<String>,
    /// False in a development build: it checks but never installs over itself.
    pub can_install: bool,
    pub status: Status,
}

/// Progress of Install and restart, streamed to the webview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum InstallEvent {
    /// `total` when the server said how big the download is.
    Downloading { received: u64, total: Option<u64> },
    /// Downloaded and its signature checked; now replacing the app.
    Installing,
    /// Installed; Phaethon restarts in a moment.
    Restarting,
}

/// The app's update state: what About shows, and the update found (only Rust ever holds it).
pub struct Updates {
    setup: Setup,
    status: Mutex<Status>,
    found: Mutex<Option<Update>>,
    /// One check or install at a time.
    busy: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn new(setup: Setup) -> Self {
        let status = match &setup {
            Setup::Ready { .. } => Status::Idle,
            Setup::NotSetUp { reason } => Status::NotSetUp { reason: (*reason).to_string() },
        };
        Self { setup, status: Mutex::new(status), found: Mutex::new(None), busy: Default::default() }
    }

    fn view(&self, current_version: String) -> UpdateView {
        UpdateView {
            current_version,
            source: match &self.setup {
                Setup::Ready { source } => Some(source.clone()),
                Setup::NotSetUp { .. } => None,
            },
            can_install: !cfg!(debug_assertions),
            status: self.status.lock().unwrap().clone(),
        }
    }

    fn set(&self, status: Status) {
        *self.status.lock().unwrap() = status;
    }
}

/// Register the plugin's state and this module's, and start the quiet launch check.
/// Called from `run`'s setup.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let setup = setup_of(app.config().plugins.0.get("updater"));
    let ready = matches!(setup, Setup::Ready { .. });
    app.manage(Updates::new(setup));
    if ready {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LAUNCH_DELAY).await;
            let _ = run_check(&app, "launch").await;
        });
    }
}

/// Ask the feed once. A failure is kept as an error status, in words.
async fn run_check<R: Runtime>(app: &AppHandle<R>, during: &'static str) -> Result<(), String> {
    let updates = app.state::<Updates>();
    if !matches!(updates.setup, Setup::Ready { .. }) {
        return Ok(());
    }
    let Ok(_one) = updates.busy.try_lock() else {
        return Ok(()); // a check or install is already running; its outcome will show
    };
    updates.set(Status::Checking);
    match check(app, None).await {
        Ok(Some(update)) => {
            updates.set(available(&update));
            *updates.found.lock().unwrap() = Some(update);
        }
        Ok(None) => {
            *updates.found.lock().unwrap() = None;
            updates.set(Status::UpToDate { checked_at: now_ms() });
        }
        Err(e) => {
            let message = words(&e);
            updates.set(Status::Error { message: message.clone(), during });
            return Err(message);
        }
    }
    Ok(())
}

/// Ask the feed (or `endpoints` instead, for tests) whether there's a newer signed release.
/// Nothing is downloaded yet.
pub async fn check<R: Runtime>(app: &AppHandle<R>, endpoints: Option<Vec<Url>>) -> Result<Option<Update>, Error> {
    let mut builder = app.updater_builder().timeout(NETWORK_TIMEOUT);
    if let Some(endpoints) = endpoints {
        builder = builder.endpoints(endpoints)?;
    }
    builder.build()?.check().await
}

/// Download `update` and check its signature against the bundled key. The bytes come
/// back only when the signature verifies; nothing is written anywhere.
pub async fn download_verified(update: &Update, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Vec<u8>, Error> {
    let mut received = 0u64;
    let mut said = 0u64;
    update
        .download(
            |chunk, total| {
                received += chunk as u64;
                // About a hundred steps at most, so the channel isn't flooded.
                let step = total.map(|t| (t / 100).max(1)).unwrap_or(256 * 1024);
                if received - said >= step || total == Some(received) {
                    said = received;
                    progress(received, total);
                }
            },
            || {},
        )
        .await
}

fn available(update: &Update) -> Status {
    Status::Available {
        version: update.version.clone(),
        notes: clean_notes(update.body.as_deref()),
        // As YYYY-MM-DD.
        date: update.date.map(|d| d.date().to_string()),
    }
}

/// Release notes as plain text: trimmed, empty as none, and cut when very long.
pub fn clean_notes(notes: Option<&str>) -> Option<String> {
    let notes = notes?.trim();
    if notes.is_empty() {
        return None;
    }
    if notes.chars().count() <= NOTES_MAX_CHARS {
        return Some(notes.to_string());
    }
    let cut: String = notes.chars().take(NOTES_MAX_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What went wrong, said to a person. Signature failures are said plainly: nothing was installed.
pub fn words(e: &Error) -> String {
    match e {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "The update didn’t pass Phaethon’s signature check, so it wasn’t installed and nothing was changed. \
             It may have been altered on the way. Try again later, or download Phaethon from its releases page yourself."
                .into()
        }
        Error::Reqwest(_) | Error::Network(_) => {
            "Phaethon couldn’t reach the place updates come from. Check your internet connection, then try again.".into()
        }
        Error::ReleaseNotFound | Error::Serialization(_) | Error::Semver(_) => {
            "Phaethon couldn’t find a release it can read there. No release may have been published yet.".into()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) | Error::UnsupportedOs | Error::UnsupportedArch => {
            "The newest release has no build for this computer yet.".into()
        }
        Error::InsecureTransportProtocol => "Phaethon only takes updates over a secure (https) connection.".into(),
        Error::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            "Phaethon doesn’t have permission to replace itself where it’s installed. \
             Move it to your Applications folder, or download the new version and install it yourself."
                .into()
        }
        Error::PreviousAppNotRestored(path) => format!(
            "The update couldn’t be installed, and the previous Phaethon was left at {}. Move it back to Applications to use it.",
            path.display()
        ),
        _ => format!("The update couldn’t be installed: {e}. Nothing was changed; you can try again."),
    }
}

/// What About shows: this version, where updates come from, and the last outcome.
#[tauri::command]
pub fn update_state(app: AppHandle, updates: State<'_, Updates>) -> UpdateView {
    updates.view(app.package_info().version.to_string())
}

/// Check now (Settings › About › Check for updates).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateView, String> {
    let _ = run_check(&app, "check").await;
    let updates = app.state::<Updates>();
    Ok(updates.view(app.package_info().version.to_string()))
}

/// Download the update found by the last check, verify it, install it and restart.
/// The webview names no address or file: only the update Rust found can be installed.
#[tauri::command]
pub async fn update_install(app: AppHandle, on_event: Channel<InstallEvent>) -> Result<(), String> {
    let updates = app.state::<Updates>();
    if cfg!(debug_assertions) {
        return Err("This is a development build of Phaethon, so it doesn’t install updates over itself.".into());
    }
    let Ok(_one) = updates.busy.try_lock() else {
        return Err("Phaethon is already checking for or installing an update.".into());
    };
    let Some(update) = updates.found.lock().unwrap().clone() else {
        return Err("There’s no update to install. Check for updates first.".into());
    };
    // A failed install keeps the update on offer (About shows it again, to try again); the
    // failure itself goes back to the button that asked.
    let fail = |e: &Error| words(e);
    let bytes = download_verified(&update, |received, total| {
        let _ = on_event.send(InstallEvent::Downloading { received, total });
    })
    .await
    .map_err(|e| fail(&e))?;
    let _ = on_event.send(InstallEvent::Installing);
    // Replacing the app is blocking file work (and on Windows starts the installer and exits).
    let install = {
        let update = update.clone();
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
    };
    match install.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(fail(&e)),
        Err(e) => return Err(format!("The update couldn’t be installed: it stopped unexpectedly ({e}). You can try again.")),
    }
    let _ = on_event.send(InstallEvent::Restarting);
    tokio::time::sleep(RESTART_PAUSE).await;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    /// Shaped as a minisign public key file (`Ed`, an 8-byte key id, a 32-byte key); not a real key.
    fn sample_pubkey() -> String {
        let key = base64::engine::general_purpose::STANDARD.encode([b"Ed".as_slice(), &[7u8; 40]].concat());
        base64::engine::general_purpose::STANDARD.encode(format!("untrusted comment: minisign public key 0707\n{key}\n"))
    }

    const FEED: &str = "https://github.com/someone/phaethon/releases/latest/download/latest.json";

    #[test]
    fn set_up_only_with_a_key_and_https_feeds() {
        let key = sample_pubkey();
        assert_eq!(setup_of(Some(&json!({"pubkey": key, "endpoints": [FEED]}))), Setup::Ready { source: "someone/phaethon".into() });
        assert_eq!(
            setup_of(Some(&json!({"pubkey": key, "endpoints": ["https://updates.example.org/{{target}}/{{current_version}}"]}))),
            Setup::Ready { source: "updates.example.org".into() }
        );
        for (conf, why) in [
            (json!({"pubkey": "", "endpoints": []}), "nothing set"),
            (json!({"pubkey": key, "endpoints": []}), "no feed"),
            (json!({"pubkey": "", "endpoints": [FEED]}), "no key"),
            (json!({"pubkey": "not a key", "endpoints": [FEED]}), "key isn't base64"),
            (json!({"pubkey": base64::engine::general_purpose::STANDARD.encode("hello\nworld"), "endpoints": [FEED]}), "not a minisign key"),
            (json!({"pubkey": key, "endpoints": ["http://github.com/a/b/releases/latest/download/latest.json"]}), "http"),
            (json!({"pubkey": key, "endpoints": [FEED, "http://127.0.0.1:9/latest.json"]}), "one http among https"),
            (json!({"pubkey": key, "endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"]}), "placeholder"),
            (json!({"pubkey": key, "endpoints": ["latest.json"]}), "not an address"),
        ] {
            assert!(matches!(setup_of(Some(&conf)), Setup::NotSetUp { .. }), "{why}");
        }
        assert!(matches!(setup_of(None), Setup::NotSetUp { .. }));
    }

    /// The shipped config has a readable key and feed, and each signature must
    /// name the version the feed announces. The webview gets no updater or
    /// process permission; it uses this module's commands.
    #[test]
    fn shipped_config_is_ready_and_strict() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        // The plugin reads the same section at startup and fails the launch if it can't.
        let plugin: tauri_plugin_updater::Config = serde_json::from_value(updater.clone()).expect("the plugin reads plugins.updater");
        assert!(plugin.require_signed_version && !plugin.allow_downgrades && !plugin.dangerous_insecure_transport_protocol);
        assert_eq!(updater["requireSignedVersion"], true);
        assert_ne!(updater["allowDowngrades"], true);
        assert_ne!(updater["dangerousInsecureTransportProtocol"], true);
        assert_ne!(updater["dangerousAcceptInvalidCerts"], true);
        assert_ne!(updater["dangerousAcceptInvalidHostnames"], true);
        assert!(matches!(setup_of(Some(updater)), Setup::Ready { .. }), "the shipped feed and key must be ready");
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for p in caps["permissions"].as_array().unwrap() {
            let p = p.as_str().unwrap_or("");
            assert!(!p.starts_with("updater:") && !p.starts_with("process:"), "{p}");
        }
        for cmd in ["allow-update-state", "allow-update-check", "allow-update-install"] {
            assert!(caps["permissions"].as_array().unwrap().iter().any(|p| p == cmd), "{cmd}");
        }
    }

    #[test]
    fn notes_are_trimmed_and_cut() {
        assert_eq!(clean_notes(None), None);
        assert_eq!(clean_notes(Some("  \n ")), None);
        assert_eq!(clean_notes(Some("\n- Faster\n")), Some("- Faster".into()));
        let long = "é".repeat(NOTES_MAX_CHARS + 5);
        let cut = clean_notes(Some(&long)).unwrap();
        assert_eq!(cut.chars().count(), NOTES_MAX_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn errors_are_said_in_words() {
        let sig = words(&Error::MissingSignedVersion);
        assert!(sig.contains("signature check") && sig.contains("wasn’t installed"));
        assert_eq!(words(&Error::SignedVersionMismatch { signed: "1.0.0".into(), announced: "9.0.0".into() }), sig);
        assert!(words(&Error::Network("x".into())).contains("internet connection"));
        assert!(words(&Error::TargetsNotFound(vec!["darwin-aarch64".into()])).contains("no build for this computer"));
        assert!(words(&Error::ReleaseNotFound).contains("No release"));
        assert!(words(&Error::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied))).contains("permission"));
    }

    #[test]
    fn status_reads_as_the_webview_expects() {
        let v = serde_json::to_value(Status::Available { version: "0.2.0".into(), notes: None, date: Some("2026-10-12".into()) }).unwrap();
        assert_eq!(v, json!({"state": "available", "version": "0.2.0", "notes": null, "date": "2026-10-12"}));
        let v = serde_json::to_value(Status::UpToDate { checked_at: 5 }).unwrap();
        assert_eq!(v, json!({"state": "upToDate", "checkedAt": 5}));
        let v = serde_json::to_value(InstallEvent::Downloading { received: 1, total: Some(2) }).unwrap();
        assert_eq!(v, json!({"kind": "downloading", "received": 1, "total": 2}));
        let u = Updates::new(Setup::NotSetUp { reason: "x" });
        assert_eq!(u.view("0.1.0".into()).status, Status::NotSetUp { reason: "x".into() });
        assert!(u.view("0.1.0".into()).source.is_none());
    }
}
