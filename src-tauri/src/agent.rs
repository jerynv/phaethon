//! Agent supervisor for the `claude` CLI backend.
//!
//! Phaethon never touches the CLI's credentials: it only locates the binary the
//! user installed and logged into, and spawns it. One child process per turn,
//! with its working directory set to the space folder and `--resume` pointing
//! at that space's saved session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::grants::AccessAnswer;
use crate::thread::{Record, WriteAction};
use crate::vault;

/// Tools the agent may use. Read-only for now: the agent can look at files in
/// its space but cannot change them, run commands, or reach the network. Write
/// tools come later, together with an in-app confirmation flow.
pub const ALLOWED_TOOLS: &str = "Read,Grep,Glob";

/// Shown when the binary cannot be found or started.
pub const MISSING_CLI_MESSAGE: &str = "Claude Code was not found. Install Claude Code, then run `claude` once in a terminal to log in.";

const NOT_LOGGED_IN_MESSAGE: &str =
    "Claude Code is not logged in. Run `claude` once in a terminal to log in, then try again.";

/// Variables a parent Claude Code session sets for its own children. If Phaethon
/// was launched from inside one, they would make our child think it is nested.
const INHERITED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
];

/// Events streamed to the UI for one turn. The stream always ends with `End`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// A chunk of assistant text to append.
    Text { delta: String },
    /// A human-readable description of a tool the agent is using.
    Tool { label: String },
    /// The turn failed; `message` is safe to show to the user.
    Error {
        code: ErrorCode,
        message: String,
        /// For rate limits and outages: how long the provider asked us to wait.
        #[serde(rename = "retryAfterSecs", skip_serializing_if = "Option::is_none")]
        retry_after_secs: Option<u64>,
    },
    /// Phaethon's own loop wants to change a file and waits for the user's
    /// answer (`agent_approve`). `detail` is the full new contents and
    /// `before` the full old contents when replacing; each is cut at
    /// [`crate::agent_loop::PREVIEW_CAP`] bytes, and then `truncated` is set.
    Approval {
        id: String,
        summary: String,
        detail: String,
        action: WriteAction,
        /// The file, relative to `space`.
        path: String,
        space: String,
        before: Option<String>,
        truncated: bool,
    },
    /// Something was saved into the conversation record (see thread.rs).
    Record { record: Record },
    /// The approval `id` was answered or abandoned; the card can close.
    ApprovalDone { id: String, allowed: bool },
    /// Phaethon's own loop asks to let this space read `path` in the other
    /// space `space` (read-only), and waits for `agent_access_answer`.
    AccessRequest {
        id: String,
        space: String,
        path: String,
        reason: String,
    },
    /// The access request `id` was answered (or abandoned, which counts as
    /// `deny`); the card can close.
    AccessRequestDone { id: String, answer: AccessAnswer },
    /// The turn was stopped by the user.
    Cancelled,
    /// Terminal event; `session_id` is what the space will resume next time.
    End {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
}

impl AgentEvent {
    /// An error with no wait time.
    pub fn error(code: ErrorCode, message: impl Into<String>) -> Self {
        AgentEvent::Error { code, message: message.into(), retry_after_secs: None }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    MissingCli,
    NotLoggedIn,
    Busy,
    InvalidSpace,
    Cli,
    /// Phaethon's own loop has no API key for the provider yet.
    NoApiKey,
    /// The provider rejected the API key.
    ApiKey,
    /// The provider failed in a way none of the codes below describes.
    Provider,
    /// The provider account is out of credit or has a billing problem.
    Billing,
    /// Too many requests; `retryAfterSecs` says how long to wait when known.
    RateLimit,
    /// The provider is overloaded or down; retrying later may work.
    Unavailable,
    /// The provider refused the request itself (unknown model, too large).
    BadRequest,
    Network,
    /// The model declined to answer.
    Declined,
    /// The space's conversation file could not be read or written.
    Storage,
    /// An attached file was refused (type, size) or could not be saved.
    Attachment,
}

/// Options for one turn.
pub struct TurnRequest<'a> {
    pub space_dir: &'a Path,
    pub prompt: &'a str,
    /// Set only when the vault opts into an isolated CLI config (see `VaultSettings`).
    pub config_dir: Option<PathBuf>,
    /// Folders of other spaces this space has an "always" grant for, as
    /// (label like "work/calendar", real path); see `grants::cli_dirs`. Passed
    /// as `--add-dir`, so the CLI's read-only tools may read them. Asking for
    /// access mid-conversation is not available on this backend.
    pub add_dirs: Vec<(String, PathBuf)>,
}

/// Find the `claude` binary: `PATH` first, then `~/.local/bin` (the installer's
/// default, and not on `PATH` when a macOS app is launched from Finder).
pub fn find_claude() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("PHAETHON_CLAUDE_BIN") {
        // Debug builds only: lets tests point at a scripted fake CLI.
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = vault::home_dir() {
        dirs.push(home.join(".local").join("bin"));
    }
    dirs.into_iter()
        .map(|d| d.join(exe))
        .find(|p| is_executable(p))
}

/// Whether Claude Code is installed, for Settings and the setup card to check
/// before offering it. Only looks for the program: nothing about the user's
/// login is read or reported (Anthropic's terms; see CLAUDE.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

pub fn cli_status() -> CliStatus {
    status_of(find_claude())
}

/// A found path counts only if it is an executable file (the debug-build
/// override may name one that isn't there).
fn status_of(found: Option<PathBuf>) -> CliStatus {
    match found.filter(|p| is_executable(p)) {
        Some(p) => CliStatus { installed: true, path: Some(p.to_string_lossy().into_owned()) },
        None => CliStatus { installed: false, path: None },
    }
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// The CLI arguments for one turn. The prompt goes over stdin, never argv, so
/// it cannot be read as a flag and does not show up in `ps`.
pub fn cli_args(resume: Option<&str>, add_dirs: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Only these tools exist for the model at all...
        "--tools",
        ALLOWED_TOOLS,
        // ...they run without asking...
        "--allowedTools",
        ALLOWED_TOOLS,
        // ...and anything else that would need permission is denied, not prompted.
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        // File tools confined to the working directory (the space); user, project
        // and local settings (including hooks) are ignored.
        "--restricted",
        // No MCP servers from the user's own configuration.
        "--strict-mcp-config",
        "--no-chrome",
        // No CLAUDE.md auto-discovery (the user's global one leaked into every
        // space without this), plugins, hooks or custom agents. Login still works.
        "--safe-mode",
        // No skills or slash commands, built-in ones included.
        "--disable-slash-commands",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Granted folders of other spaces. The tools stay read-only, and
    // `--restricted` confines them to the working directory plus these.
    // `--add-dir` is variadic, so each one is followed by another flag or the
    // end of argv, never a stray positional.
    for dir in add_dirs {
        args.push("--add-dir".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    if let Some(id) = resume {
        args.push("--resume".into());
        args.push(id.into());
    }
    args
}

/// Running turns, keyed by space id. At most one turn per space.
#[derive(Default, Clone)]
pub struct Runs {
    inner: Arc<Mutex<HashMap<String, RunHandle>>>,
}

struct RunHandle {
    pid: Option<u32>,
    cancel: Option<oneshot::Sender<()>>,
}

impl Runs {
    pub(crate) fn claim(&self, space: &str) -> Option<oneshot::Receiver<()>> {
        let mut map = self.inner.lock().unwrap();
        if map.contains_key(space) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        map.insert(
            space.to_string(),
            RunHandle {
                pid: None,
                cancel: Some(tx),
            },
        );
        Some(rx)
    }

    fn set_pid(&self, space: &str, pid: Option<u32>) {
        if let Some(h) = self.inner.lock().unwrap().get_mut(space) {
            h.pid = pid;
        }
    }

    pub(crate) fn release(&self, space: &str) {
        self.inner.lock().unwrap().remove(space);
    }

    /// PID of the CLI child running in `space` (it also leads its process group).
    pub fn running_pid(&self, space: &str) -> Option<u32> {
        self.inner.lock().unwrap().get(space).and_then(|h| h.pid)
    }

    /// Ask the turn in `space` to stop. Returns false if nothing was running.
    pub fn cancel(&self, space: &str) -> bool {
        let tx = self
            .inner
            .lock()
            .unwrap()
            .get_mut(space)
            .and_then(|h| h.cancel.take());
        tx.map(|tx| tx.send(()).is_ok()).unwrap_or(false)
    }

    /// Synchronously kill every running child (and its process group). Used on
    /// app exit, where there is no time to wait for a graceful shutdown.
    pub fn kill_all(&self) {
        for h in self.inner.lock().unwrap().values() {
            if let Some(pid) = h.pid {
                signal_group(pid, Signal::Kill);
            }
        }
    }
}

/// Run one turn in `space_id`, streaming events to `emit`. Always finishes with
/// exactly one `AgentEvent::End`, whatever happens.
pub async fn run_turn(
    runs: &Runs,
    space_id: &str,
    req: TurnRequest<'_>,
    mut emit: impl FnMut(AgentEvent),
) {
    let Some(cancel_rx) = runs.claim(space_id) else {
        emit(AgentEvent::error(
            ErrorCode::Busy,
            "This space is still answering the previous message. Stop it or wait for it to finish.",
        ));
        emit(AgentEvent::End { session_id: None });
        return;
    };
    let session_id = drive(runs, space_id, req, cancel_rx, &mut emit).await;
    runs.release(space_id);
    emit(AgentEvent::End { session_id });
}

async fn drive(
    runs: &Runs,
    space_id: &str,
    req: TurnRequest<'_>,
    mut cancel_rx: oneshot::Receiver<()>,
    emit: &mut impl FnMut(AgentEvent),
) -> Option<String> {
    let fail = |emit: &mut dyn FnMut(AgentEvent), code, message: String| {
        emit(AgentEvent::error(code, message));
    };

    let Some(bin) = find_claude() else {
        fail(emit, ErrorCode::MissingCli, MISSING_CLI_MESSAGE.into());
        return None;
    };
    let resume = vault::read_session(req.space_dir);

    let mut cmd = Command::new(&bin);
    let dirs: Vec<PathBuf> = req.add_dirs.iter().map(|(_, p)| p.clone()).collect();
    cmd.args(cli_args(resume.as_deref(), &dirs))
        .current_dir(req.space_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for var in INHERITED_SESSION_VARS {
        cmd.env_remove(var);
    }
    if let Some(dir) = &req.config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    // Own process group, so cancel also reaches anything the CLI spawned (ripgrep etc.).
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fail(emit, ErrorCode::MissingCli, MISSING_CLI_MESSAGE.into());
            return None;
        }
        Err(e) => {
            fail(
                emit,
                ErrorCode::Cli,
                format!("Could not start Claude Code: {e}"),
            );
            return None;
        }
    };
    let pid = child.id();
    runs.set_pid(space_id, pid);

    if let Some(mut stdin) = child.stdin.take() {
        // A write error here means the CLI already exited; its exit status says why.
        let _ = stdin.write_all(req.prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    // Keep the last part of stderr for error messages; never forward it raw.
    let stderr_task = child.stderr.take().map(|mut err| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut err).take(64 * 1024).read_to_end(&mut buf).await;
            // Drain the rest so the child never blocks on a full pipe.
            let _ = tokio::io::copy(&mut err, &mut tokio::io::sink()).await;
            String::from_utf8_lossy(&buf).into_owned()
        })
    });

    let mut parser = StreamParser::new(req.space_dir);
    parser.granted = req.add_dirs.clone();
    let mut lines = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    for ev in parser.feed(&line) {
                        emit(ev);
                    }
                }
                _ => break,
            },
            _ = &mut cancel_rx => {
                cancelled = true;
                break;
            }
        }
    }

    if cancelled {
        if let Some(pid) = pid {
            signal_group(pid, Signal::Term);
        }
        if tokio::time::timeout(Duration::from_millis(1500), child.wait())
            .await
            .is_err()
        {
            if let Some(pid) = pid {
                signal_group(pid, Signal::Kill);
            }
            let _ = child.kill().await;
        }
    }
    // Always reap the child so it never lingers as a zombie.
    let status = child.wait().await.ok();
    runs.set_pid(space_id, None);
    let stderr = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => String::new(),
    };

    if cancelled {
        emit(AgentEvent::Cancelled);
        // The CLI may not have saved the turn; keep the previous session.
        return resume;
    }

    let outcome = parser.finish();
    let not_logged_in = |s: &str| s.contains("Not logged in") || s.contains("/login");
    match outcome {
        Outcome::Success { session_id } => {
            if let Some(Err(e)) = session_id
                .as_deref()
                .map(|id| vault::write_session(req.space_dir, id))
            {
                fail(
                    emit,
                    ErrorCode::Cli,
                    format!("Reply received, but the conversation could not be saved: {e}"),
                );
            }
            session_id
        }
        Outcome::Failed { message } if not_logged_in(&message) || not_logged_in(&stderr) => {
            fail(emit, ErrorCode::NotLoggedIn, NOT_LOGGED_IN_MESSAGE.into());
            None
        }
        Outcome::Failed { message } | Outcome::Incomplete { message } => {
            let detail = [message.trim(), last_line(&stderr)]
                .into_iter()
                .find(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| match status.and_then(|s| s.code()) {
                    Some(code) => format!("Claude Code exited with status {code}."),
                    None => "Claude Code stopped unexpectedly.".into(),
                });
            if resume.is_some() && detail.contains("No conversation found") {
                // The saved session is gone (deleted or from another machine): start fresh next time.
                vault::clear_session(req.space_dir);
                fail(emit, ErrorCode::Cli, "The previous conversation for this space could not be found. Send your message again to start a new one.".into());
            } else if not_logged_in(&detail) {
                fail(emit, ErrorCode::NotLoggedIn, NOT_LOGGED_IN_MESSAGE.into());
            } else {
                fail(emit, ErrorCode::Cli, detail);
            }
            None
        }
    }
}

fn last_line(s: &str) -> &str {
    s.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

fn signal_group(pid: u32, sig: Signal) {
    #[cfg(unix)]
    {
        let sig = match sig {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // The child leads its own group (process_group(0)), so pgid == pid.
        // SAFETY: killpg only sends a signal; a stale pgid just returns ESRCH.
        unsafe {
            libc::killpg(pid as libc::pid_t, sig);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, sig); // Windows: kill_on_drop / Child::kill handle the direct child.
    }
}

/// How the CLI's `stream-json` output ended.
#[derive(Debug, PartialEq)]
enum Outcome {
    Success {
        session_id: Option<String>,
    },
    Failed {
        message: String,
    },
    /// Output ended without a `result` line.
    Incomplete {
        message: String,
    },
}

/// Turns `stream-json` lines into `AgentEvent`s. Unknown lines are ignored, so
/// new CLI event types do not break the app.
struct StreamParser {
    space_dir: PathBuf,
    /// Granted folders of other spaces, so reads there are labelled with the space.
    granted: Vec<(String, PathBuf)>,
    session_id: Option<String>,
    emitted_text: bool,
    result: Option<Outcome>,
}

impl StreamParser {
    fn new(space_dir: &Path) -> Self {
        Self {
            space_dir: space_dir.to_path_buf(),
            granted: vec![],
            session_id: None,
            emitted_text: false,
            result: None,
        }
    }

    fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        if let Some(id) = v.get("session_id").and_then(Value::as_str) {
            self.session_id = Some(id.to_string());
        }
        match v.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.stream_event(&v["event"]),
            Some("assistant") => v["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| AgentEvent::Tool {
                    label: tool_label(b, &self.space_dir, &self.granted),
                })
                .collect(),
            Some("result") => {
                let text = v
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                    || v.get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s != "success");
                let mut out = vec![];
                if is_error {
                    let message = if text.is_empty() {
                        let sub = v.get("subtype").and_then(Value::as_str).unwrap_or("error");
                        format!("Claude Code stopped: {sub}.")
                    } else {
                        text
                    };
                    self.result = Some(Outcome::Failed { message });
                } else {
                    // Fallback if no partial messages arrived: show the final text.
                    if !self.emitted_text && !text.is_empty() {
                        self.emitted_text = true;
                        out.push(AgentEvent::Text { delta: text });
                    }
                    self.result = Some(Outcome::Success {
                        session_id: self.session_id.clone(),
                    });
                }
                out
            }
            _ => vec![],
        }
    }

    fn stream_event(&mut self, ev: &Value) -> Vec<AgentEvent> {
        match ev.get("type").and_then(Value::as_str) {
            // Separate text blocks (e.g. before and after a tool call) with a blank line.
            Some("content_block_start")
                if ev["content_block"]["type"] == "text" && self.emitted_text =>
            {
                vec![AgentEvent::Text {
                    delta: "\n\n".into(),
                }]
            }
            Some("content_block_delta") if ev["delta"]["type"] == "text_delta" => {
                match ev["delta"]["text"].as_str() {
                    Some(t) if !t.is_empty() => {
                        self.emitted_text = true;
                        vec![AgentEvent::Text {
                            delta: t.to_string(),
                        }]
                    }
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }

    fn finish(self) -> Outcome {
        self.result.unwrap_or(Outcome::Incomplete {
            message: String::new(),
        })
    }
}

/// "Reading file notes.md" etc. Paths are shown relative to the space; a read
/// in a granted folder of another space names that space ("Reading
/// work/calendar/oct.md").
fn tool_label(block: &Value, space_dir: &Path, granted: &[(String, PathBuf)]) -> String {
    let input = &block["input"];
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let rel = |p: &str| {
        let path = Path::new(p);
        path.strip_prefix(space_dir)
            .map(|r| r.display().to_string())
            .unwrap_or_else(|_| p.to_string())
    };
    let other = |p: &str| {
        granted.iter().find_map(|(label, dir)| {
            Path::new(p).strip_prefix(dir).ok().map(|r| {
                if r.as_os_str().is_empty() { label.clone() } else { format!("{label}/{}", r.display()) }
            })
        })
    };
    match block["name"].as_str().unwrap_or("") {
        "Read" => match other(s("file_path")) {
            Some(o) => format!("Reading {o}"),
            None => format!("Reading file {}", rel(s("file_path"))),
        },
        "Grep" => format!("Searching files for \u{201c}{}\u{201d}", s("pattern")),
        "Glob" => format!("Finding files matching {}", s("pattern")),
        "" => "Using a tool".into(),
        other => format!("Using tool {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(lines: &[&str]) -> (Vec<AgentEvent>, Outcome) {
        let mut p = StreamParser::new(Path::new("/vault/spaces/school"));
        let evs = lines.iter().flat_map(|l| p.feed(l)).collect();
        (evs, p.finish())
    }

    #[test]
    fn cli_status_reports_only_an_executable_and_its_path() {
        let dir = std::env::temp_dir().join(format!("phaethon-cli-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Not executable yet: not installed.
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(status_of(Some(bin.clone())), CliStatus { installed: false, path: None });
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = status_of(Some(bin.clone()));
        assert_eq!(found, CliStatus { installed: true, path: Some(bin.to_string_lossy().into_owned()) });
        assert_eq!(serde_json::to_value(&found).unwrap(), serde_json::json!({"installed": true, "path": bin.to_string_lossy()}));
        // Missing, or a folder: not installed, and no path key at all.
        assert_eq!(serde_json::to_value(status_of(None)).unwrap(), serde_json::json!({"installed": false}));
        assert!(!status_of(Some(dir.join("nope"))).installed);
        assert!(!status_of(Some(dir.clone())).installed);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn streams_text_and_session() {
        let (evs, out) = feed_all(&[
            r#"{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"po"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ng"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"11111111-2222-3333-4444-555555555555"}"#,
        ]);
        assert_eq!(
            evs,
            vec![
                AgentEvent::Text { delta: "po".into() },
                AgentEvent::Text { delta: "ng".into() }
            ]
        );
        assert_eq!(
            out,
            Outcome::Success {
                session_id: Some("11111111-2222-3333-4444-555555555555".into())
            }
        );
    }

    #[test]
    fn tool_use_and_second_text_block() {
        let (evs, _) = feed_all(&[
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me look."}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/vault/spaces/school/notes.md"}}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}"#,
        ]);
        assert_eq!(
            evs,
            vec![
                AgentEvent::Text {
                    delta: "Let me look.".into()
                },
                AgentEvent::Tool {
                    label: "Reading file notes.md".into()
                },
                AgentEvent::Text {
                    delta: "\n\n".into()
                },
                AgentEvent::Text {
                    delta: "Done.".into()
                },
            ]
        );
    }

    #[test]
    fn granted_folders_become_add_dirs_and_labels() {
        let dirs = [PathBuf::from("/vault/spaces/work/calendar"), PathBuf::from("/vault/spaces/home/bills")];
        let args = cli_args(Some("11111111-2222-3333-4444-555555555555"), &dirs);
        let pairs: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "--add-dir")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(pairs, ["/vault/spaces/work/calendar", "/vault/spaces/home/bills"]);
        // Still read-only and restricted with grants.
        assert!(args.windows(2).any(|w| w[0] == "--tools" && w[1] == ALLOWED_TOOLS));
        assert!(args.iter().any(|a| a == "--restricted"));
        // Each --add-dir value is followed by a flag, so the variadic option
        // never swallows anything else.
        for (i, a) in args.iter().enumerate() {
            if a == "--add-dir" {
                assert!(args.get(i + 2).is_none_or(|n| n.starts_with("--")));
            }
        }

        let mut p = StreamParser::new(Path::new("/vault/spaces/school"));
        p.granted = vec![("work/calendar".into(), dirs[0].clone())];
        let evs = p.feed(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/vault/spaces/work/calendar/oct.md"}}]}}"#);
        assert_eq!(evs, vec![AgentEvent::Tool { label: "Reading work/calendar/oct.md".into() }]);
    }

    #[test]
    fn result_without_partials_falls_back_to_final_text() {
        let (evs, _) =
            feed_all(&[r#"{"type":"result","subtype":"success","is_error":false,"result":"hi"}"#]);
        assert_eq!(evs, vec![AgentEvent::Text { delta: "hi".into() }]);
    }

    #[test]
    fn error_result_and_garbage() {
        let (evs, out) = feed_all(&[
            "not json",
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
        ]);
        assert!(evs.is_empty());
        assert_eq!(
            out,
            Outcome::Failed {
                message: "Not logged in · Please run /login".into()
            }
        );
        assert_eq!(
            feed_all(&[]).1,
            Outcome::Incomplete {
                message: String::new()
            }
        );
    }

    #[test]
    fn args_never_bypass_permissions() {
        let args = cli_args(Some("11111111-2222-3333-4444-555555555555"), &[]);
        assert!(!args.iter().any(|a| a == "--add-dir"), "nothing crosses by default");
        assert!(
            !args
                .iter()
                .any(|a| a.contains("dangerously") || a == "bypassPermissions")
        );
        assert!(args.windows(2).any(|w| w[0] == "--resume"));
        // The user's own CLI setup must not load inside a space.
        for flag in ["--restricted", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        // --bare would refuse OAuth and break the user's own CLI login.
        assert!(!args.iter().any(|a| a == "--bare"));
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--permission-mode" && w[1] == "dontAsk")
        );
    }
}
