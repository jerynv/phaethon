//! Agent supervisor for the `claude` CLI backend.
//!
//! steward never touches the CLI's credentials: it only locates the binary the
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

use crate::vault;

/// Tools the agent may use. Read-only for now: the agent can look at files in
/// its space but cannot change them, run commands, or reach the network. Write
/// tools come later, together with an in-app confirmation flow.
pub const ALLOWED_TOOLS: &str = "Read,Grep,Glob";

/// Shown when the binary cannot be found or started.
pub const MISSING_CLI_MESSAGE: &str = "Claude Code was not found. Install Claude Code, then run `claude` once in a terminal to log in.";

const NOT_LOGGED_IN_MESSAGE: &str =
    "Claude Code is not logged in. Run `claude` once in a terminal to log in, then try again.";

/// Variables a parent Claude Code session sets for its own children. If steward
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
    Error { code: ErrorCode, message: String },
    /// steward's own loop wants to change a file and waits for the user's
    /// answer (`agent_approve`). `detail` previews the new contents.
    Approval {
        id: String,
        summary: String,
        detail: String,
    },
    /// The approval `id` was answered or abandoned; the card can close.
    ApprovalDone { id: String, allowed: bool },
    /// The turn was stopped by the user.
    Cancelled,
    /// Terminal event; `session_id` is what the space will resume next time.
    End {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    MissingCli,
    NotLoggedIn,
    Busy,
    InvalidSpace,
    Cli,
    /// steward's own loop has no API key for the provider yet.
    NoApiKey,
    /// The provider rejected the API key.
    ApiKey,
    /// The provider failed (rate limit, overload, billing, refused request).
    Provider,
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
}

/// Find the `claude` binary: `PATH` first, then `~/.local/bin` (the installer's
/// default, and not on `PATH` when a macOS app is launched from Finder).
pub fn find_claude() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("STEWARD_CLAUDE_BIN") {
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
pub fn cli_args(resume: Option<&str>) -> Vec<String> {
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
        emit(AgentEvent::Error {
            code: ErrorCode::Busy,
            message: "This space is still answering the previous message. Stop it or wait for it to finish.".into(),
        });
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
        emit(AgentEvent::Error { code, message });
    };

    let Some(bin) = find_claude() else {
        fail(emit, ErrorCode::MissingCli, MISSING_CLI_MESSAGE.into());
        return None;
    };
    let resume = vault::read_session(req.space_dir);

    let mut cmd = Command::new(&bin);
    cmd.args(cli_args(resume.as_deref()))
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
    session_id: Option<String>,
    emitted_text: bool,
    result: Option<Outcome>,
}

impl StreamParser {
    fn new(space_dir: &Path) -> Self {
        Self {
            space_dir: space_dir.to_path_buf(),
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
                    label: tool_label(b, &self.space_dir),
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

/// "Reading file notes.md" etc. Paths are shown relative to the space.
fn tool_label(block: &Value, space_dir: &Path) -> String {
    let input = &block["input"];
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let rel = |p: &str| {
        let path = Path::new(p);
        path.strip_prefix(space_dir)
            .map(|r| r.display().to_string())
            .unwrap_or_else(|_| p.to_string())
    };
    match block["name"].as_str().unwrap_or("") {
        "Read" => format!("Reading file {}", rel(s("file_path"))),
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
        let args = cli_args(Some("11111111-2222-3333-4444-555555555555"));
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
