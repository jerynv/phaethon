//! Agent supervisor for the CLI backends: Claude Code, Codex and Gemini CLI.
//!
//! Phaethon never touches a CLI's credentials: it only locates the binary the
//! user installed and logged into, and spawns it. One child process per turn,
//! with its working directory set to the space folder, read-only tools, and
//! the session of the space's current conversation resumed. What differs per
//! CLI (arguments, its JSON events, how it says "not logged in") is in
//! `claude.rs`, `codex.rs` and `gemini.rs`; the rest is shared here.
//!
//! Each turn is recorded in the space's conversation (thread.rs) as Phaethon's
//! own loop records it: the user's message with its files, then the reply's
//! text (and a stopped record when the user stopped it), as plain text blocks,
//! so the conversation can be listed, searched, reopened, and carried on by
//! any backend.

pub mod claude;
pub mod codex;
pub mod gemini;

use std::collections::HashMap;
use std::ffi::OsString;
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
use crate::thread::{self, Record, WriteAction};
use crate::vault::Backend;
use crate::{agent_loop, attachments, memory, vault};

pub use claude::{ALLOWED_TOOLS, MISSING_CLI_MESSAGE, cli_args, find_claude};
pub(crate) use claude::{INHERITED_SESSION_VARS, NOT_LOGGED_IN_MESSAGE};

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

/// Which official CLI answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Cli {
    Claude,
    Codex,
    Gemini,
}

impl Cli {
    pub const ALL: [Cli; 3] = [Cli::Claude, Cli::Codex, Cli::Gemini];

    /// The CLI a backend runs; `None` for Phaethon's own loop.
    pub fn of(backend: Backend) -> Option<Cli> {
        match backend {
            Backend::Phaethon => None,
            Backend::ClaudeCli => Some(Cli::Claude),
            Backend::CodexCli => Some(Cli::Codex),
            Backend::GeminiCli => Some(Cli::Gemini),
        }
    }

    /// Short id, as in `codex:<model>` and `codex:<session>`.
    pub fn id(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Gemini => "gemini",
        }
    }

    /// Its name for people.
    pub fn name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
            Cli::Gemini => "Gemini CLI",
        }
    }

    pub fn find(self) -> Option<PathBuf> {
        match self {
            Cli::Claude => find_claude(),
            Cli::Codex => codex::find_codex(),
            Cli::Gemini => gemini::find_gemini(),
        }
    }

    pub fn missing_message(self) -> &'static str {
        match self {
            Cli::Claude => MISSING_CLI_MESSAGE,
            Cli::Codex => codex::MISSING_CLI_MESSAGE,
            Cli::Gemini => gemini::MISSING_CLI_MESSAGE,
        }
    }

    /// The command that signs the person in, for them to run themselves.
    /// With an isolated setup it names that setup's folder.
    pub fn login_command(self, config_dir: Option<&Path>) -> String {
        let (var, cmd) = match self {
            Cli::Claude => ("CLAUDE_CONFIG_DIR", "claude"),
            Cli::Codex => ("CODEX_HOME", "codex login"),
            Cli::Gemini => ("GEMINI_CLI_HOME", "gemini"),
        };
        match config_dir {
            Some(d) => format!("{var}=\"{}\" {cmd}", d.display()),
            None => cmd.into(),
        }
    }

    pub fn not_logged_in_message(self, config_dir: Option<&Path>) -> String {
        match (self, config_dir) {
            (Cli::Claude, None) => NOT_LOGGED_IN_MESSAGE.into(),
            _ => format!(
                "{} is not logged in. Run `{}` once in a terminal to sign in, then try again.",
                self.name(),
                self.login_command(config_dir)
            ),
        }
    }

    /// How its sessions are tagged in `.phaethon/session` (see vault.rs).
    fn session_tag(self) -> Option<&'static str> {
        match self {
            Cli::Claude => None,
            other => Some(other.id()),
        }
    }

    fn inherited_vars(self) -> &'static [&'static str] {
        match self {
            Cli::Claude => INHERITED_SESSION_VARS,
            Cli::Codex => codex::INHERITED_SESSION_VARS,
            Cli::Gemini => gemini::INHERITED_SESSION_VARS,
        }
    }

    /// The variable that points the CLI at its own setup folder.
    pub(crate) fn config_var(self) -> &'static str {
        match self {
            Cli::Claude => "CLAUDE_CONFIG_DIR",
            Cli::Codex => "CODEX_HOME",
            Cli::Gemini => "GEMINI_CLI_HOME",
        }
    }

    pub(crate) fn not_logged_in(self, s: &str) -> bool {
        match self {
            Cli::Claude => claude::not_logged_in(s),
            Cli::Codex => codex::not_logged_in(s),
            Cli::Gemini => gemini::not_logged_in(s),
        }
    }

    fn is_stale(self, s: &str) -> bool {
        match self {
            Cli::Claude => claude::is_stale(s),
            Cli::Codex => codex::is_stale(s),
            Cli::Gemini => gemini::is_stale(s),
        }
    }
}

/// Is `name` a model id a CLI may be given with `-m`? One line of plain
/// characters that can't be read as a flag.
pub fn is_valid_cli_model(name: &str) -> bool {
    crate::providers::is_valid_compat_model(name) && name.len() <= 100
}

/// Options for one turn.
pub struct TurnRequest<'a> {
    pub space_dir: &'a Path,
    /// What the user wrote, saved in the conversation as written.
    pub prompt: &'a str,
    /// Reference blocks for files saved with this message (see attachments.rs).
    pub attachments: Vec<Value>,
    /// Edit or regenerate: the thread index of a user message that this one
    /// replaces, with everything after it (see [`thread::cut_at`]). The CLI
    /// can't forget part of a session, so the new version starts a fresh one,
    /// given the conversation before that message as text.
    pub replace_from: Option<usize>,
    /// Set only when the vault opts into an isolated CLI config (see `VaultSettings`).
    pub config_dir: Option<PathBuf>,
    /// Folders the CLI may read besides the space, as (label like
    /// "work/calendar", real path): other spaces' folders this space has an
    /// "always" grant for (`grants::cli_dirs`) and the courses it sees in full.
    /// Asking for access mid-conversation is not available on these backends.
    pub add_dirs: Vec<(String, PathBuf)>,
    /// The space's own model for this CLI (`-m`); its default when `None`.
    /// Claude Code always uses its own.
    pub model: Option<String>,
}

/// Whether a CLI is installed, for Settings and the setup card to check
/// before offering it. Only looks for the program: nothing about the user's
/// login is read (Anthropic's terms; see CLAUDE.md).
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
pub(crate) fn status_of(found: Option<PathBuf>) -> CliStatus {
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

/// The first executable `name` on `PATH`, then in `extra`.
pub(crate) fn find_on_path(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra.iter().cloned());
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| is_executable(p))
}

/// Where installers put command-line tools, none of which is on `PATH` when a
/// macOS app is opened from Finder.
pub(crate) fn common_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![];
    if let Some(home) = vault::home_dir() {
        for d in [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"] {
            dirs.push(home.join(d));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs
}

/// `PATH` for a CLI's child: the usual one, then the CLI's own folder and the
/// installers' folders, so a CLI written in JavaScript finds `node`.
fn child_path(bin: &Path) -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in bin.parent().map(Path::to_path_buf).into_iter().chain(common_bin_dirs()) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// The command for a run of `cli` at `bin`: its own process group, piped
/// stdio, the inherited variables that would confuse it removed, and its
/// isolated setup folder when the vault has one.
pub fn command(cli: Cli, bin: &Path, cwd: &Path, config_dir: Option<&Path>) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for var in cli.inherited_vars() {
        cmd.env_remove(var);
    }
    if cli != Cli::Claude {
        cmd.env("PATH", child_path(bin));
    }
    if let Some(dir) = config_dir {
        if cli != Cli::Claude {
            // Codex refuses a CODEX_HOME that isn't there.
            let _ = std::fs::create_dir_all(dir);
        }
        cmd.env(cli.config_var(), dir);
    }
    // Own process group, so cancel also reaches anything the CLI spawned (ripgrep etc.).
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
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

/// Run one Claude Code turn in `space_id` (see [`run_cli_turn`]).
pub async fn run_turn(runs: &Runs, space_id: &str, req: TurnRequest<'_>, emit: impl FnMut(AgentEvent)) {
    run_cli_turn(runs, space_id, Cli::Claude, req, emit).await
}

/// Run one turn of `cli` in `space_id`, streaming events to `emit`. Always
/// finishes with exactly one `AgentEvent::End`, whatever happens.
pub async fn run_cli_turn(runs: &Runs, space_id: &str, cli: Cli, req: TurnRequest<'_>, mut emit: impl FnMut(AgentEvent)) {
    let Some(cancel_rx) = runs.claim(space_id) else {
        emit(AgentEvent::error(
            ErrorCode::Busy,
            "This space is still answering the previous message. Stop it or wait for it to finish.",
        ));
        emit(AgentEvent::End { session_id: None });
        return;
    };
    let session_id = turn(runs, space_id, cli, &req, cancel_rx, &mut emit).await;
    runs.release(space_id);
    emit(AgentEvent::End { session_id });
}

/// Said to a fresh session before a conversation it never saw.
const HISTORY_INTRO: &str = "This conversation began before this session, so you haven't seen it. \
Here it is so far, as plain text (\"Phaethon\" is you). Carry on from it.";

/// What the CLI is asked: the user's message, and before it the conversation
/// so far when the session starts fresh on one that already has messages (had
/// with Phaethon's own agent or another CLI, edited, or its session is gone).
fn cli_prompt(ask: &str, msgs: &[Value], fresh: bool) -> String {
    if !fresh || thread::to_ui(msgs).is_empty() {
        return ask.to_string();
    }
    format!("{HISTORY_INTRO}\n\n<conversation>\n{}</conversation>\n\nThe user's new message:\n\n{ask}", memory::transcript(msgs))
}

/// One turn: run the CLI (once more, afresh, if the session it was to resume
/// is gone), then record the turn in the conversation. Returns the session
/// the conversation resumes next.
async fn turn(
    runs: &Runs,
    space_id: &str,
    cli: Cli,
    req: &TurnRequest<'_>,
    mut cancel_rx: oneshot::Receiver<()>,
    emit: &mut impl FnMut(AgentEvent),
) -> Option<String> {
    let storage = |emit: &mut dyn FnMut(AgentEvent), message: String| emit(AgentEvent::error(ErrorCode::Storage, message));
    if cli == Cli::Gemini && gemini::has_own_settings(req.space_dir) {
        emit(AgentEvent::error(ErrorCode::Cli, gemini::OWN_SETTINGS_MESSAGE));
        return None;
    }
    let mut msgs = match thread::load(req.space_dir) {
        Ok(m) => m,
        Err(e) => {
            storage(emit, format!("This space’s conversation file couldn’t be read, so nothing was sent: {e}"));
            return None;
        }
    };
    if let Some(index) = req.replace_from {
        if let Err(e) = thread::cut_at(req.space_dir, &mut msgs, index) {
            storage(emit, e);
            return None;
        }
        if let Err(e) = thread::save(req.space_dir, &msgs) {
            storage(emit, format!("The conversation could not be saved, so nothing was sent: {e}"));
            return None;
        }
    }
    let user = thread::stamped(thread::user_message(req.prompt, &req.attachments));
    let ask = format!("{}{}", req.prompt, attachments::cli_note(&req.attachments));
    let mut resume = vault::read_cli_session(req.space_dir, cli.session_tag());
    let mut text = String::new();
    let (stopped, session_id) = loop {
        let prompt = cli_prompt(&ask, &msgs, resume.is_none());
        match drive(runs, space_id, cli, req, resume.as_deref(), &prompt, &mut cancel_rx, emit, &mut text).await {
            // The session is gone (deleted, or made on another machine or in another folder):
            // start afresh, with the conversation so far.
            Attempt::StaleSession => {
                vault::clear_session(req.space_dir);
                resume = None;
            }
            Attempt::Done { session_id } => break (false, session_id),
            Attempt::Stopped => break (true, resume),
            Attempt::Failed => break (false, None),
            Attempt::NotStarted => return None,
        }
    };
    // Recorded as Phaethon's own loop does: the question, then what came back
    // (a failed or stopped reply keeps what streamed).
    msgs.push(user);
    msgs.extend(agent_loop::partial_reply(&[text], stopped).map(thread::stamped));
    if let Err(e) = thread::save(req.space_dir, &msgs) {
        storage(emit, format!("The reply couldn’t be saved in this space’s conversation: {e}"));
    }
    if stopped {
        emit(AgentEvent::Record { record: Record::Stopped });
        emit(AgentEvent::Cancelled);
    }
    session_id
}

/// How one run of the CLI ended. Errors are already emitted.
#[derive(Debug, PartialEq)]
enum Attempt {
    /// The CLI wasn't found or couldn't start.
    NotStarted,
    Done { session_id: Option<String> },
    Failed,
    Stopped,
    /// The session to resume is unknown to the CLI, and nothing was said yet.
    StaleSession,
}

/// One CLI's event stream, whichever CLI it is.
enum Parser {
    Claude(claude::StreamParser),
    Codex(codex::Parser),
    Gemini(gemini::Parser),
}

impl Parser {
    fn new(cli: Cli, space_dir: &Path, granted: Vec<(String, PathBuf)>) -> Self {
        match cli {
            Cli::Claude => {
                let mut p = claude::StreamParser::new(space_dir);
                p.granted = granted;
                Parser::Claude(p)
            }
            Cli::Codex => {
                let mut p = codex::Parser::new(space_dir);
                p.granted = granted;
                Parser::Codex(p)
            }
            Cli::Gemini => {
                let mut p = gemini::Parser::new(space_dir);
                p.granted = granted;
                Parser::Gemini(p)
            }
        }
    }

    fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
        match self {
            Parser::Claude(p) => p.feed(line),
            Parser::Codex(p) => p.feed(line),
            Parser::Gemini(p) => p.feed(line),
        }
    }

    fn finish(self) -> Outcome {
        match self {
            Parser::Claude(p) => p.finish(),
            Parser::Codex(p) => p.finish(),
            Parser::Gemini(p) => p.finish(),
        }
    }
}

/// The arguments and stdin for one run of `cli`, or why it can't run.
fn invocation(cli: Cli, bin: &Path, req: &TurnRequest<'_>, resume: Option<&str>, prompt: &str) -> Result<(Vec<String>, String), String> {
    let dirs: Vec<PathBuf> = req.add_dirs.iter().map(|(_, p)| p.clone()).collect();
    let model = req.model.as_deref().filter(|m| is_valid_cli_model(m));
    let mode = crate::tutor_mode::prompt_section(req.space_dir);
    // What each course teaches and its exams cover, and how to cite them, before the tutor mode.
    let mode = match (crate::study::scope::prompt_for(req.space_dir), mode) {
        (Some(s), Some(m)) => Some(format!("{s}\n\n{m}")),
        (s, m) => s.or(m),
    };
    let mode = crate::rich_output::with_instructions(mode); // what the chat can show, before the tutor mode
    // How to offer a quiz or flashcards from the chat, before the tutor mode (which shapes every answer).
    let mode = Some(crate::study::chat::with_prompt(mode.as_deref()));
    Ok(match cli {
        Cli::Claude => {
            let mut args = cli_args(resume, &dirs);
            // The study block, what the chat can show and the tutor mode, appended to Claude Code's own system prompt.
            args.extend(mode.iter().flat_map(|m| ["--append-system-prompt".to_string(), m.clone()]));
            (args, prompt.to_string())
        }
        Cli::Codex => (codex::cli_args(req.space_dir, bin, &dirs, model, mode.as_deref(), resume), prompt.to_string()),
        Cli::Gemini => {
            let policy = gemini::policy_file(false).map_err(|e| format!("Phaethon couldn’t prepare Gemini CLI’s read-only rules: {e}"))?;
            (gemini::cli_args(&policy, &dirs, model, resume), gemini::prompt(mode.as_deref(), prompt))
        }
    })
}

#[allow(clippy::too_many_arguments)] // one run's inputs, each needed
async fn drive(
    runs: &Runs,
    space_id: &str,
    cli: Cli,
    req: &TurnRequest<'_>,
    resume: Option<&str>,
    prompt: &str,
    cancel_rx: &mut oneshot::Receiver<()>,
    emit: &mut impl FnMut(AgentEvent),
    text: &mut String,
) -> Attempt {
    let fail = |emit: &mut dyn FnMut(AgentEvent), code, message: String| {
        emit(AgentEvent::error(code, message));
    };

    let Some(bin) = cli.find() else {
        fail(emit, ErrorCode::MissingCli, cli.missing_message().into());
        return Attempt::NotStarted;
    };
    let (args, stdin_text) = match invocation(cli, &bin, req, resume, prompt) {
        Ok(i) => i,
        Err(message) => {
            fail(emit, ErrorCode::Cli, message);
            return Attempt::NotStarted;
        }
    };
    let mut cmd = command(cli, &bin, req.space_dir, req.config_dir.as_deref());
    cmd.args(args);
    if cli == Cli::Gemini {
        // Headless runs need a trusted folder; see gemini.rs for what keeps the space walled.
        cmd.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fail(emit, ErrorCode::MissingCli, cli.missing_message().into());
            return Attempt::NotStarted;
        }
        Err(e) => {
            fail(emit, ErrorCode::Cli, format!("Could not start {}: {e}", cli.name()));
            return Attempt::NotStarted;
        }
    };
    let pid = child.id();
    runs.set_pid(space_id, pid);

    if let Some(mut stdin) = child.stdin.take() {
        // A write error here means the CLI already exited; its exit status says why.
        let _ = stdin.write_all(stdin_text.as_bytes()).await;
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

    let mut parser = Parser::new(cli, req.space_dir, req.add_dirs.clone());
    let mut lines = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    for ev in parser.feed(&line) {
                        if let AgentEvent::Text { delta } = &ev {
                            text.push_str(delta);
                        }
                        emit(ev);
                    }
                }
                _ => break,
            },
            _ = &mut *cancel_rx => {
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
        // The CLI may not have saved the turn; the caller keeps the previous session.
        return Attempt::Stopped;
    }

    let outcome = parser.finish();
    let logged_out = || fail_not_logged_in(cli, req.config_dir.as_deref());
    match outcome {
        Outcome::Success { session_id } => {
            if let Some(Err(e)) = session_id
                .as_deref()
                .map(|id| vault::write_cli_session(req.space_dir, cli.session_tag(), id))
            {
                fail(
                    emit,
                    ErrorCode::Cli,
                    format!("Reply received, but the conversation could not be saved: {e}"),
                );
            }
            Attempt::Done { session_id }
        }
        Outcome::Failed { message } if cli.not_logged_in(&message) || cli.not_logged_in(&stderr) => {
            emit(logged_out());
            Attempt::Failed
        }
        Outcome::Failed { message } | Outcome::Incomplete { message } => {
            let said = if cli == Cli::Claude { last_line(&stderr) } else { stderr_summary(&stderr) };
            let detail = [message.trim(), said]
                .into_iter()
                .find(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| match status.and_then(|s| s.code()) {
                    Some(code) => format!("{} exited with status {code}.", cli.name()),
                    None => format!("{} stopped unexpectedly.", cli.name()),
                });
            if resume.is_some() && (cli.is_stale(&detail) || cli.is_stale(&stderr)) {
                if text.is_empty() {
                    return Attempt::StaleSession;
                }
                // Gone after it had begun answering (unlikely): start afresh next time.
                vault::clear_session(req.space_dir);
                fail(emit, ErrorCode::Cli, format!("{} lost this conversation’s earlier session. Send your message again to carry on in a new one.", cli.name()));
            } else if cli.not_logged_in(&detail) || cli.not_logged_in(&stderr) {
                emit(logged_out());
            } else if cli == Cli::Gemini && detail.contains("IneligibleTierError") {
                fail(emit, ErrorCode::Cli, gemini::INELIGIBLE_MESSAGE.into());
            } else {
                fail(emit, ErrorCode::Cli, detail);
            }
            Attempt::Failed
        }
    }
}

fn fail_not_logged_in(cli: Cli, config_dir: Option<&Path>) -> AgentEvent {
    AgentEvent::error(ErrorCode::NotLoggedIn, cli.not_logged_in_message(config_dir))
}

fn last_line(s: &str) -> &str {
    s.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

/// The line of a CLI's stderr that says what went wrong: the last one naming
/// an error, else the last line at all. Stack frames (`at …`) never are.
pub(crate) fn stderr_summary(s: &str) -> &str {
    let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("at ")).collect();
    lines
        .iter()
        .rev()
        .find(|l| l.contains("Error") || l.contains("error"))
        .or(lines.last())
        .copied()
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

/// How a CLI's output ended.
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    Success {
        session_id: Option<String>,
    },
    Failed {
        message: String,
    },
    /// Output ended without a result.
    Incomplete {
        message: String,
    },
}

/// `p` as shown in a tool's label: relative to the space, or named by the
/// granted folder of another space it is in ("work/calendar/oct.md"), and
/// whether it is in one.
pub(crate) fn shown_path(p: &str, space_dir: &Path, granted: &[(String, PathBuf)]) -> (String, bool) {
    let path = Path::new(p);
    if let Some(o) = granted.iter().find_map(|(label, dir)| {
        path.strip_prefix(dir).ok().map(|r| if r.as_os_str().is_empty() { label.clone() } else { format!("{label}/{}", r.display()) })
    }) {
        return (o, true);
    }
    let rel = path.strip_prefix(space_dir).map(|r| r.display().to_string()).unwrap_or_else(|_| p.to_string());
    (if rel.is_empty() { ".".into() } else { rel }, false)
}

/// "Reading file notes.md", or "Reading work/calendar/oct.md" in another space's granted folder.
pub(crate) fn place(verb: &str, p: &str, space_dir: &Path, granted: &[(String, PathBuf)]) -> String {
    match shown_path(p, space_dir, granted) {
        (o, true) => format!("{verb} {o}"),
        (rel, false) => format!("{verb} file {rel}"),
    }
}

/// What each CLI is, here: whether it's installed, whether it's signed in
/// (when the CLI can say so without Phaethon reading its files), and how to
/// install it or sign in. OpenCode is only looked for.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    /// `claude`, `codex`, `gemini` or `opencode`.
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
    /// `None` when the CLI has no way to say without being asked a question.
    pub logged_in: Option<bool>,
    /// The command that signs in, for the person to run in a terminal.
    pub login_command: String,
    /// Whether Phaethon can answer through it.
    pub supported: bool,
}

/// [`CliInfo`] for every CLI. Codex says whether it is signed in through its
/// own `codex login status`, which Phaethon runs and reads the words of;
/// Phaethon itself never opens a CLI's credential files. Claude Code's
/// sign-in is never asked (Anthropic's terms), and Gemini CLI has no way to
/// say short of a real question.
pub async fn clis_info(config_dir: impl Fn(Cli) -> Option<PathBuf>) -> Vec<CliInfo> {
    let mut out = vec![];
    for cli in Cli::ALL {
        let bin = cli.find().filter(|p| is_executable(p));
        let dir = config_dir(cli);
        let logged_in = match (cli, &bin) {
            (Cli::Codex, Some(bin)) => codex_logged_in(bin, dir.as_deref()).await,
            _ => None,
        };
        out.push(CliInfo {
            id: cli.id(),
            name: cli.name(),
            installed: bin.is_some(),
            logged_in,
            login_command: cli.login_command(dir.as_deref()),
            supported: true,
        });
    }
    let opencode = find_on_path("opencode", &[common_bin_dirs(), vault::home_dir().map(|h| vec![h.join(".opencode/bin")]).unwrap_or_default()].concat());
    out.push(CliInfo { id: "opencode", name: "OpenCode", installed: opencode.is_some(), logged_in: None, login_command: "opencode auth login".into(), supported: false });
    out
}

/// `codex login status`: "Logged in using …" or "Not logged in"; anything
/// else (or no answer within a few seconds) is unknown.
async fn codex_logged_in(bin: &Path, config_dir: Option<&Path>) -> Option<bool> {
    let mut cmd = command(Cli::Codex, bin, &std::env::temp_dir(), config_dir);
    cmd.args(["login", "status"]).stdin(Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    parse_codex_login(&said)
}

pub(crate) fn parse_codex_login(said: &str) -> Option<bool> {
    if said.contains("Not logged in") {
        Some(false)
    } else if said.contains("Logged in") {
        Some(true)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn each_cli_says_how_to_sign_in_in_its_own_words() {
        assert_eq!(Cli::Claude.not_logged_in_message(None), NOT_LOGGED_IN_MESSAGE);
        assert!(Cli::Codex.not_logged_in_message(None).contains("Run `codex login`"));
        assert!(Cli::Gemini.not_logged_in_message(None).starts_with("Gemini CLI is not logged in. Run `gemini`"));
        let iso = Cli::Codex.not_logged_in_message(Some(Path::new("/x/default-codex")));
        assert!(iso.contains("CODEX_HOME=\"/x/default-codex\" codex login"), "{iso}");
        assert_eq!(Cli::of(Backend::Phaethon), None);
        assert_eq!(Cli::of(Backend::GeminiCli), Some(Cli::Gemini));
        assert_eq!(parse_codex_login("Logged in using ChatGPT\n"), Some(true));
        assert_eq!(parse_codex_login("Not logged in\n"), Some(false));
        assert_eq!(parse_codex_login("Error loading configuration"), None);
    }

    #[test]
    fn models_for_a_cli_are_plain_and_never_flags() {
        for ok in ["gpt-5.5", "gemini-2.5-pro", "o3", "gpt-5-codex"] {
            assert!(is_valid_cli_model(ok), "{ok}");
        }
        for bad in ["", "-m", "--yolo", "a b", "x;rm", "../x", &"a".repeat(101)] {
            assert!(!is_valid_cli_model(bad), "{bad}");
        }
    }

    #[test]
    fn stderr_summary_finds_the_error_not_the_stack() {
        let gemini = "Error authenticating: IneligibleTierError: This client is no longer supported.\n    at throwIneligible (file:///x.js:1:1)\n  ineligibleTiers: [\n  ]\n}\nAn unexpected critical error occurred:IneligibleTierError: This client is no longer supported.\n    at _doSetupUser (file:///x.js:2:2)\n";
        assert_eq!(stderr_summary(gemini), "An unexpected critical error occurred:IneligibleTierError: This client is no longer supported.");
        assert_eq!(stderr_summary("boom\n\n"), "boom");
        assert_eq!(stderr_summary(""), "");
    }

    #[test]
    fn paths_in_labels_are_the_spaces_own_or_name_the_other_space() {
        let space = Path::new("/vault/spaces/school");
        let granted = vec![("work/calendar".to_string(), PathBuf::from("/vault/spaces/work/calendar"))];
        assert_eq!(place("Reading", "/vault/spaces/school/a/b.md", space, &granted), "Reading file a/b.md");
        assert_eq!(place("Reading", "/vault/spaces/work/calendar/oct.md", space, &granted), "Reading work/calendar/oct.md");
        assert_eq!(shown_path("/vault/spaces/school", space, &granted).0, ".");
    }
}
