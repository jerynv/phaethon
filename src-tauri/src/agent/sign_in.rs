//! Signing in to Codex or Gemini CLI for the vault's own home, through the
//! CLI's own sign-in: Phaethon starts it with that home, the CLI opens the
//! browser itself, and Phaethon learns how it went only from what the CLI
//! says. It never reads, copies or passes on what the CLI saves there.
//!
//! - Codex: `codex login` with `CODEX_HOME` set, then `codex login status`.
//! - Gemini CLI has no sign-in command: its own Google sign-in runs when it
//!   starts without one. Phaethon starts it headless in an empty folder with
//!   no tools and no message, with "Sign in with Google" chosen in the home's
//!   settings when nothing is chosen there yet; Gemini CLI asks "Do you want
//!   to continue?" before opening the browser, and Phaethon answers yes, as
//!   the person asked it to. Signed in, it stops at "No input provided"
//!   without sending anything to the model; otherwise it says why
//!   ("Error authenticating: …").

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::{Cli, Runs, Signal, codex_logged_in, command, gemini, signal_group, stderr_summary};

/// How long a sign-in may wait for the person in the browser. Gemini CLI
/// gives up by itself after 5 minutes.
const WAIT: Duration = Duration::from_secs(15 * 60);

/// What Gemini CLI asks before it opens the browser.
const CONSENT: &str = "Do you want to continue?";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignInStatus {
    SignedIn,
    NotSignedIn,
    Cancelled,
    /// A sign-in to this CLI is already waiting.
    Busy,
    Missing,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInOutcome {
    pub status: SignInStatus,
    /// Plain words for the person.
    pub message: String,
}

impl SignInOutcome {
    fn new(status: SignInStatus, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// The key a sign-in is kept under in [`Runs`] (so Stop and quitting reach
/// it). A space id never starts with a NUL.
pub fn run_key(cli: Cli) -> String {
    format!("\u{0}sign-in:{}", cli.id())
}

/// Stop a waiting sign-in. False if none was waiting.
pub fn cancel(runs: &Runs, cli: Cli) -> bool {
    runs.cancel(&run_key(cli))
}

/// Sign in to `cli` with `home` as its home, waiting for the person to
/// finish in the browser (or [`cancel`]).
pub async fn sign_in(runs: &Runs, cli: Cli, home: &Path) -> SignInOutcome {
    if !cli.own_home() {
        // Claude Code is never signed in to by Phaethon (Anthropic's terms).
        return SignInOutcome::new(SignInStatus::NotSignedIn, format!("Phaethon doesn’t sign in to {}.", cli.name()));
    }
    let Some(bin) = cli.find() else {
        return SignInOutcome::new(SignInStatus::Missing, cli.missing_message());
    };
    let key = run_key(cli);
    let Some(cancel_rx) = runs.claim(&key) else {
        return SignInOutcome::new(SignInStatus::Busy, format!("Phaethon is already waiting for you to sign in to {}.", cli.name()));
    };
    let out = match cli {
        Cli::Codex => codex(runs, &key, &bin, home, cancel_rx).await,
        _ => gemini(runs, &key, &bin, home, cancel_rx).await,
    };
    runs.release(&key);
    out
}

async fn codex(runs: &Runs, key: &str, bin: &Path, home: &Path, cancel_rx: tokio::sync::oneshot::Receiver<()>) -> SignInOutcome {
    let mut cmd = command(Cli::Codex, bin, &std::env::temp_dir(), Some(home));
    cmd.arg("login");
    let ended = run(runs, key, cmd, None, cancel_rx).await;
    let said = match ended {
        Ended::Cancelled => return SignInOutcome::new(SignInStatus::Cancelled, "Signing in to Codex was stopped."),
        Ended::Failed(e) => return SignInOutcome::new(SignInStatus::NotSignedIn, format!("Codex couldn’t start: {e}")),
        Ended::TimedOut => return SignInOutcome::new(SignInStatus::NotSignedIn, "Codex waited too long for you to sign in. Try again."),
        Ended::Exited(said) => said,
    };
    // Only Codex's own status says whether it worked.
    match codex_logged_in(bin, Some(home)).await {
        Some(true) => SignInOutcome::new(SignInStatus::SignedIn, "Signed in to Codex for this Phaethon folder."),
        _ => {
            let why = stderr_summary(&said);
            SignInOutcome::new(
                SignInStatus::NotSignedIn,
                if why.is_empty() { "Codex didn’t finish signing in. Try again.".to_string() } else { format!("Codex didn’t finish signing in: {why}") },
            )
        }
    }
}

/// Choose "Sign in with Google" in Gemini CLI's settings in `home` when no
/// way to sign in is chosen there yet. Only the settings file is touched.
pub fn prepare_gemini_home(home: &Path) -> std::io::Result<()> {
    let dir = home.join(".gemini");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("settings.json");
    let mut settings = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) if v.is_object() => v,
            // Gemini CLI reads it with comments allowed; one Phaethon can't read is left alone.
            _ => return Ok(()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(e),
    };
    if settings.pointer("/security/auth/selectedType").and_then(|v| v.as_str()).is_some() {
        return Ok(());
    }
    let obj = settings.as_object_mut().expect("an object");
    let security = obj.entry("security").or_insert_with(|| serde_json::json!({}));
    if !security.is_object() {
        *security = serde_json::json!({});
    }
    let auth = security.as_object_mut().expect("an object").entry("auth").or_insert_with(|| serde_json::json!({}));
    if !auth.is_object() {
        *auth = serde_json::json!({});
    }
    auth.as_object_mut().expect("an object").insert("selectedType".into(), "oauth-personal".into());
    let tmp = dir.join(format!("settings.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&settings).expect("serializes"))?;
    std::fs::rename(&tmp, &file)
}

async fn gemini(runs: &Runs, key: &str, bin: &Path, home: &Path, cancel_rx: tokio::sync::oneshot::Receiver<()>) -> SignInOutcome {
    let prepared = prepare_gemini_home(home).and_then(|_| {
        let cwd = home.join("sign-in");
        std::fs::create_dir_all(&cwd)?;
        Ok((cwd, gemini::policy_file(true)?))
    });
    let (cwd, policy) = match prepared {
        Ok(p) => p,
        Err(e) => return SignInOutcome::new(SignInStatus::NotSignedIn, format!("Phaethon couldn’t prepare Gemini CLI’s folder: {e}")),
    };
    let mut cmd = command(Cli::Gemini, bin, &cwd, Some(home));
    cmd.args(gemini::base_args(&policy, "text", None));
    // Headless runs need a trusted folder: this empty one.
    cmd.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
    let said = match run(runs, key, cmd, Some(CONSENT), cancel_rx).await {
        Ended::Cancelled => return SignInOutcome::new(SignInStatus::Cancelled, "Signing in to Gemini CLI was stopped."),
        Ended::Failed(e) => return SignInOutcome::new(SignInStatus::NotSignedIn, format!("Gemini CLI couldn’t start: {e}")),
        Ended::TimedOut => return SignInOutcome::new(SignInStatus::NotSignedIn, "Gemini CLI waited too long for you to sign in. Try again."),
        Ended::Exited(said) => said,
    };
    gemini_outcome(&said)
}

/// What Gemini CLI's words at the end of a sign-in mean.
pub(crate) fn gemini_outcome(said: &str) -> SignInOutcome {
    if said.contains("IneligibleTierError") {
        return SignInOutcome::new(SignInStatus::NotSignedIn, gemini::INELIGIBLE_MESSAGE);
    }
    if let Some(line) = said.lines().find(|l| l.contains("Error authenticating")) {
        let why = line.trim().trim_start_matches("Error authenticating:").trim();
        let why = why.split_once("Error: ").map_or(why, |(_, w)| w);
        return SignInOutcome::new(SignInStatus::NotSignedIn, format!("Gemini CLI didn’t finish signing in: {why}"));
    }
    if said.contains("No input provided") {
        return SignInOutcome::new(SignInStatus::SignedIn, "Signed in to Gemini CLI for this Phaethon folder.");
    }
    let why = stderr_summary(said);
    SignInOutcome::new(
        SignInStatus::NotSignedIn,
        if why.is_empty() { "Gemini CLI didn’t finish signing in. Try again.".to_string() } else { format!("Gemini CLI didn’t finish signing in: {why}") },
    )
}

enum Ended {
    /// Its stdout and stderr, together (the last 64 KB).
    Exited(String),
    Cancelled,
    TimedOut,
    Failed(std::io::Error),
}

/// Run a sign-in to its end, cancel or [`WAIT`]. When `consent` shows up in
/// its output, answer yes once; stdin stays open (and empty) otherwise.
async fn run(runs: &Runs, key: &str, mut cmd: Command, consent: Option<&str>, mut cancel_rx: tokio::sync::oneshot::Receiver<()>) -> Ended {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Ended::Failed(e),
    };
    let pid = child.id();
    runs.set_pid(key, pid);
    let mut stdin = child.stdin.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    for mut pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|p| Box::new(p) as _)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut said = String::new();
    let mut answered = false;
    let deadline = tokio::time::sleep(WAIT);
    tokio::pin!(deadline);
    let end = loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(c) => {
                    said.push_str(&String::from_utf8_lossy(&c));
                    if said.len() > 64 * 1024 {
                        let cut = said.len() - 48 * 1024;
                        let cut = (cut..said.len()).find(|&i| said.is_char_boundary(i)).unwrap_or(said.len());
                        said.drain(..cut);
                    }
                    if let (Some(ask), false, Some(input)) = (consent, answered, stdin.as_mut())
                        && said.contains(ask)
                    {
                        answered = true;
                        let _ = input.write_all(b"y\n").await;
                        let _ = input.flush().await;
                    }
                }
                // Both pipes closed: it is ending.
                None => {
                    let _ = child.wait().await;
                    break None;
                }
            },
            _ = &mut cancel_rx => break Some(true),
            _ = &mut deadline => break Some(false),
        }
    };
    drop(stdin);
    runs.set_pid(key, None);
    match end {
        None => Ended::Exited(said),
        Some(cancelled) => {
            if let Some(pid) = pid {
                signal_group(pid, Signal::Term);
            }
            if tokio::time::timeout(Duration::from_millis(1500), child.wait()).await.is_err() {
                if let Some(pid) = pid {
                    signal_group(pid, Signal::Kill);
                }
                let _ = child.kill().await;
            }
            if cancelled { Ended::Cancelled } else { Ended::TimedOut }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_says_how_its_sign_in_went() {
        let out = gemini_outcome("Opening authentication page in your browser. Do you want to continue? [Y/n]: y\nNo input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.\n");
        assert_eq!(out.status, SignInStatus::SignedIn);
        // What gemini-cli 0.63 says when the person says no (and then, still, "No input provided").
        let out = gemini_outcome("Do you want to continue? [Y/n]: n\nError authenticating: FatalCancellationError: Authentication cancelled by user.\n    at initOauthClient (file:///x.js:1:1)\nNo input provided via stdin.\n");
        assert_eq!(out, SignInOutcome::new(SignInStatus::NotSignedIn, "Gemini CLI didn’t finish signing in: Authentication cancelled by user."));
        let out = gemini_outcome("Error authenticating: IneligibleTierError: This client is no longer supported.\nNo input provided via stdin.\n");
        assert_eq!(out.message, gemini::INELIGIBLE_MESSAGE);
        assert_eq!(gemini_outcome("").status, SignInStatus::NotSignedIn);
    }

    #[test]
    fn the_gemini_home_chooses_google_sign_in_only_when_nothing_is_chosen() {
        let home = std::env::temp_dir().join(format!("phaethon-gemini-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let file = home.join(".gemini/settings.json");
        let read = || serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&file).unwrap()).unwrap();
        prepare_gemini_home(&home).unwrap();
        assert_eq!(read(), serde_json::json!({"security": {"auth": {"selectedType": "oauth-personal"}}}));
        // An API key chosen there stays, as does everything else.
        std::fs::write(&file, r#"{"security":{"auth":{"selectedType":"gemini-api-key"}},"ui":{"theme":"x"}}"#).unwrap();
        prepare_gemini_home(&home).unwrap();
        assert_eq!(read()["security"]["auth"]["selectedType"], "gemini-api-key");
        std::fs::write(&file, r#"{"ui":{"theme":"x"},"security":{"folderTrust":{"enabled":true}}}"#).unwrap();
        prepare_gemini_home(&home).unwrap();
        assert_eq!(read(), serde_json::json!({"ui": {"theme": "x"}, "security": {"folderTrust": {"enabled": true}, "auth": {"selectedType": "oauth-personal"}}}));
        // A file Phaethon can't read as JSON (Gemini CLI allows comments) is left alone.
        std::fs::write(&file, "{ // mine\n}").unwrap();
        prepare_gemini_home(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ // mine\n}");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_sign_in_is_kept_apart_from_every_space() {
        assert!(run_key(Cli::Codex).starts_with('\u{0}') && run_key(Cli::Codex) != run_key(Cli::Gemini));
    }
}
