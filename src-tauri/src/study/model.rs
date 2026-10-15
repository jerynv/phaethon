//! One way to ask a model a single question, for everything in Study that
//! needs one (making cards and quizzes, grading short answers, reviewing
//! mistakes). It goes through whatever the vault uses:
//!
//! - Phaethon's own provider (providers.rs: the space's model, else the
//!   vault's) when Phaethon's agent is chosen and that provider can answer
//!   (a key saved where one is needed); the key stays in Rust.
//! - Otherwise the official Claude Code CLI the person installed and logged
//!   into, as a one-shot print call with no tools at all, no session saved,
//!   and none of their own setup loaded. Phaethon never reads or passes its
//!   credentials (CLAUDE.md: the subscription rule).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::agent;
use crate::providers::AnyProvider;
use crate::provider::{Delta, ModelRequest, Provider};
use crate::vault::{Backend, Vault};

pub const NO_MODEL: &str = "No model is set up: add an API key in Settings, or switch to Claude Code.";
/// Longest a single model call may take.
const CLI_TIMEOUT: Duration = Duration::from_secs(600);
/// Most of the CLI's output kept.
const CLI_OUTPUT_MAX: u64 = 8 * 1024 * 1024;

/// A page's picture handed to a model with a question (handwriting, a scan, a diagram).
#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    /// What it is, as the model is told: "courses/C241/files/notes.pdf, page 3".
    pub label: String,
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    /// The file, base64.
    pub data: String,
}

/// Ask once, get text back. `Err` is a message for the person.
pub trait Model: Send + Sync {
    fn complete(&self, system: &str, user: &str) -> impl Future<Output = Result<String, String>> + Send;

    /// Whether [`Model::complete_seeing`] really shows it pictures.
    fn shows_pictures(&self) -> bool {
        false
    }

    /// Ask with `pictures` alongside the question, each introduced by its
    /// label, in order. A model that can't be shown pictures is asked without.
    fn complete_seeing(&self, system: &str, user: &str, pictures: &[Picture]) -> impl Future<Output = Result<String, String>> + Send {
        let _ = pictures;
        self.complete(system, user)
    }
}

/// Phaethon's own provider, asked with no tools; and whether its model takes pictures.
pub struct ProviderModel<P: Provider>(pub P, pub bool);

impl<P: Provider> ProviderModel<P> {
    async fn ask(&self, system: &str, content: Vec<Value>) -> Result<String, String> {
        let messages = [json!({"role": "user", "content": content})];
        let no_tools = json!([]);
        let mut ignore = |_: Delta<'_>| {};
        let turn = self.0.turn(ModelRequest { system, messages: &messages, tools: &no_tools }, &mut ignore).await.map_err(|e| e.message)?;
        if turn.stop_reason == "refusal" {
            return Err("The model declined to do this with this material.".into());
        }
        let text: String = turn.content.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
        if turn.stop_reason == "max_tokens" && text.trim().is_empty() {
            return Err("The answer was cut off before it began. Try fewer cards or questions.".into());
        }
        Ok(text)
    }
}

/// A message's content: each picture after a line naming it, then the question.
pub fn picture_blocks(user: &str, pictures: &[Picture]) -> Vec<Value> {
    let mut content = vec![];
    for p in pictures {
        content.push(json!({"type": "text", "text": format!("Picture: {}", p.label)}));
        content.push(json!({"type": "image", "source": {"type": "base64", "media_type": p.mime, "data": p.data}}));
    }
    content.push(json!({"type": "text", "text": user}));
    content
}

impl<P: Provider> Model for ProviderModel<P> {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        self.ask(system, vec![json!({"type": "text", "text": user})]).await
    }

    fn shows_pictures(&self) -> bool {
        self.1
    }

    async fn complete_seeing(&self, system: &str, user: &str, pictures: &[Picture]) -> Result<String, String> {
        if !self.1 || pictures.is_empty() {
            return self.complete(system, user).await;
        }
        self.ask(system, picture_blocks(user, pictures)).await
    }
}

/// The Claude Code CLI, one call per question.
pub struct CliModel {
    pub bin: PathBuf,
    /// Working directory: the space (no tool can read it anyway).
    pub cwd: PathBuf,
    /// Set only when the vault opts into an isolated CLI config.
    pub config_dir: Option<PathBuf>,
}

/// The arguments for a one-shot call: print mode, one JSON result, no tools
/// at all, nothing of the person's own setup, no session kept. The question
/// goes over stdin, never argv.
pub fn cli_args(system: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        // No tools exist for the model: it can only answer.
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--restricted",
        "--strict-mcp-config",
        "--no-chrome",
        "--safe-mode",
        "--disable-slash-commands",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("--system-prompt".into());
    args.push(system.into());
    args
}

/// The answer text from the CLI's `--output-format json` output: one result
/// object (or, from some versions, an array of events ending with it).
/// Anything else that isn't empty is taken as plain text.
pub fn parse_cli_output(stdout: &str) -> Result<String, String> {
    let trimmed = stdout.trim();
    let result = match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Array(events)) => events.into_iter().rev().find(|e| e["type"] == "result"),
        Ok(v @ Value::Object(_)) => Some(v),
        _ => trimmed.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|e| e["type"] == "result"),
    };
    let Some(r) = result else {
        return if trimmed.is_empty() { Err("Claude Code didn’t answer.".into()) } else { Ok(trimmed.to_string()) };
    };
    let text = r["result"].as_str().unwrap_or("").to_string();
    let failed = r["is_error"].as_bool().unwrap_or(false) || r["subtype"].as_str().is_some_and(|s| s != "success");
    if failed {
        if text.contains("Not logged in") || text.contains("/login") {
            return Err(agent::NOT_LOGGED_IN_MESSAGE.into());
        }
        let sub = r["subtype"].as_str().unwrap_or("error");
        return Err(if text.is_empty() { format!("Claude Code stopped: {sub}.") } else { format!("Claude Code said: {text}") });
    }
    Ok(text)
}

/// Run `cmd` with `input` on stdin; its stdout, stderr and exit status. `Err`
/// is a message for the person (not found, couldn't start, too slow).
async fn run_once(cli: agent::Cli, mut cmd: tokio::process::Command, input: &str) -> Result<(String, String, Option<std::process::ExitStatus>), String> {
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(cli.missing_message().into()),
        Err(e) => return Err(format!("Could not start {}: {e}", cli.name())),
    };
    let mut stdin = child.stdin.take();
    let mut out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let input = input.to_string();
    let run = async move {
        let feed = async move {
            if let Some(s) = stdin.as_mut() {
                // A write error means the CLI already exited; its output says why.
                let _ = s.write_all(input.as_bytes()).await;
                let _ = s.shutdown().await;
            }
            drop(stdin);
        };
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let read_out = async {
            let _ = (&mut out).take(CLI_OUTPUT_MAX).read_to_end(&mut o).await;
            let _ = tokio::io::copy(&mut out, &mut tokio::io::sink()).await;
        };
        let read_err = async {
            let _ = (&mut err).take(64 * 1024).read_to_end(&mut e).await;
            let _ = tokio::io::copy(&mut err, &mut tokio::io::sink()).await;
        };
        tokio::join!(feed, read_out, read_err);
        (o, e)
    };
    let Ok((stdout, stderr)) = tokio::time::timeout(CLI_TIMEOUT, run).await else {
        let _ = child.kill().await;
        return Err(format!("{} took too long to answer, so it was stopped. Try fewer cards or questions.", cli.name()));
    };
    let status = child.wait().await.ok();
    Ok((String::from_utf8_lossy(&stdout).into_owned(), String::from_utf8_lossy(&stderr).into_owned(), status))
}

/// [`cli_args`] for a question with pictures: the message goes over stdin as
/// one stream-json user message (the pictures as image blocks), and the
/// answer comes back as stream-json events ending with the result.
pub fn cli_args_seeing(system: &str) -> Vec<String> {
    let mut args = cli_args(system);
    if let Some(i) = args.iter().position(|a| a == "--output-format") {
        args[i + 1] = "stream-json".into();
    }
    args.splice(1..1, ["--input-format".to_string(), "stream-json".to_string(), "--verbose".to_string()]);
    args
}

/// The stdin line for [`cli_args_seeing`].
pub fn cli_message(user: &str, pictures: &[Picture]) -> String {
    json!({"type": "user", "message": {"role": "user", "content": picture_blocks(user, pictures)}}).to_string() + "\n"
}

impl CliModel {
    async fn ask(&self, args: Vec<String>, input: &str) -> Result<String, String> {
        let mut cmd = agent::command(agent::Cli::Claude, &self.bin, &self.cwd, self.config_dir.as_deref());
        cmd.args(args);
        let (stdout, stderr, status) = run_once(agent::Cli::Claude, cmd, input).await?;
        match parse_cli_output(&stdout) {
            Ok(text) => Ok(text),
            Err(_) if stderr.contains("Not logged in") || stderr.contains("/login") => Err(agent::NOT_LOGGED_IN_MESSAGE.into()),
            Err(e) if stdout.trim().is_empty() => {
                let last = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty());
                Err(match (last, status.and_then(|s| s.code())) {
                    (Some(l), _) => format!("Claude Code stopped: {l}"),
                    (None, Some(code)) if code != 0 => format!("Claude Code exited with status {code}."),
                    _ => e,
                })
            }
            Err(e) => Err(e),
        }
    }
}

impl Model for CliModel {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        self.ask(cli_args(system), user).await
    }

    fn shows_pictures(&self) -> bool {
        true
    }

    async fn complete_seeing(&self, system: &str, user: &str, pictures: &[Picture]) -> Result<String, String> {
        if pictures.is_empty() {
            return self.complete(system, user).await;
        }
        self.ask(cli_args_seeing(system), &cli_message(user, pictures)).await
    }
}

/// Codex or Gemini CLI, one call per question: no tools that run anything, no
/// files to read, nothing of the person's own setup that can be switched off,
/// and (Codex) no session kept. Gemini CLI keeps every run in its own history;
/// it has no way not to.
pub struct OtherCliModel {
    pub cli: agent::Cli,
    pub bin: PathBuf,
    pub cwd: PathBuf,
    pub config_dir: Option<PathBuf>,
    /// The space's own model for this CLI; its default when `None`.
    pub model: Option<String>,
}

impl OtherCliModel {
    /// The arguments for one question and what goes on stdin.
    pub fn invocation(&self, system: &str, user: &str) -> Result<(Vec<String>, String), String> {
        let model = self.model.as_deref().filter(|m| agent::is_valid_cli_model(m));
        Ok(match self.cli {
            agent::Cli::Codex => {
                // Nothing readable but what Codex itself needs, and no shell at all.
                let mut a = agent::codex::base_args(&self.cwd, &agent::codex::own_dirs(&self.bin), model);
                a.splice(1..1, ["--ephemeral".to_string()]);
                for f in ["shell_tool", "unified_exec"] {
                    a.push("--disable".into());
                    a.push(f.into());
                }
                a.push("-c".into());
                a.push(format!("developer_instructions={}", agent::codex::toml_str(system)));
                a.push("-".into());
                (a, user.to_string())
            }
            agent::Cli::Gemini => {
                let policy = agent::gemini::policy_file(true).map_err(|e| format!("Phaethon couldn’t prepare Gemini CLI’s rules: {e}"))?;
                // No system prompt flag: the instructions come first in the message.
                (agent::gemini::base_args(&policy, "json", model), format!("<instructions>\n{system}\n</instructions>\n\n{}", agent::gemini::prompt(None, user)))
            }
            agent::Cli::Claude => return Err("Claude Code is asked through CliModel.".into()),
        })
    }
}

/// The answer text from `codex exec --json` (its messages) or `gemini
/// --output-format json` (`response`); `Err` says what went wrong.
pub fn parse_other_output(cli: agent::Cli, stdout: &str) -> Result<String, String> {
    let name = cli.name();
    match cli {
        agent::Cli::Codex => {
            let mut text = vec![];
            for v in stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
                match v["type"].as_str() {
                    Some("item.completed") if v["item"]["type"] == "agent_message" => text.push(v["item"]["text"].as_str().unwrap_or("").to_string()),
                    Some("turn.failed") => return Err(format!("{name} said: {}", v["error"]["message"].as_str().unwrap_or("it stopped"))),
                    _ => {}
                }
            }
            let text = text.join("\n\n");
            if text.trim().is_empty() { Err(format!("{name} didn’t answer.")) } else { Ok(text) }
        }
        _ => {
            let v = stdout.lines().rev().chain([stdout]).find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(|v| v.get("response").is_some() || v.get("error").is_some()));
            let Some(v) = v else { return Err(format!("{name} didn’t answer.")) };
            if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
                return Err(format!("{name} said: {}", e["message"].as_str().unwrap_or("it stopped")));
            }
            Ok(v["response"].as_str().unwrap_or("").to_string())
        }
    }
}

/// Codex's arguments with `images` attached (`--image=<file>` each, before the prompt from stdin).
pub fn with_images(mut args: Vec<String>, images: &[PathBuf]) -> Vec<String> {
    let at = if args.last().is_some_and(|a| a == "-") { args.len() - 1 } else { args.len() };
    let flags: Vec<String> = images.iter().map(|p| format!("--image={}", p.display())).collect();
    args.splice(at..at, flags);
    args
}

impl Model for OtherCliModel {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        let (args, input) = self.invocation(system, user)?;
        self.run(args, input).await
    }

    fn shows_pictures(&self) -> bool {
        self.cli == agent::Cli::Codex
    }

    async fn complete_seeing(&self, system: &str, user: &str, pictures: &[Picture]) -> Result<String, String> {
        if pictures.is_empty() || self.cli != agent::Cli::Codex {
            return self.complete(system, user).await;
        }
        use base64::Engine;
        // The pictures as files for the length of the call, in a folder of its own.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join("phaethon-codex-pictures").join(format!("{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("Phaethon couldn’t prepare the pictures for Codex: {e}"))?;
        let mut files = vec![];
        for (i, p) in pictures.iter().enumerate() {
            let ext = if p.mime == "image/jpeg" { "jpg" } else { "png" };
            let file = dir.join(format!("picture-{}.{ext}", i + 1));
            let bytes = base64::engine::general_purpose::STANDARD.decode(&p.data).map_err(|_| "A picture couldn’t be prepared for Codex.".to_string())?;
            std::fs::write(&file, bytes).map_err(|e| format!("Phaethon couldn’t prepare the pictures for Codex: {e}"))?;
            files.push(file);
        }
        let labels: Vec<String> = pictures.iter().enumerate().map(|(i, p)| format!("Picture {}: {}", i + 1, p.label)).collect();
        let user = format!("{}\n\n{user}", labels.join("\n"));
        let result = match self.invocation(system, &user) {
            Ok((args, input)) => self.run(with_images(args, &files), input).await,
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_dir_all(&dir);
        result
    }
}

impl OtherCliModel {
    async fn run(&self, args: Vec<String>, input: String) -> Result<String, String> {
        // Gemini CLI describes its folder to the model; an empty one says nothing about the space.
        let cwd = if self.cli == agent::Cli::Gemini {
            let empty = std::env::temp_dir().join("phaethon-gemini").join("one-shot");
            std::fs::create_dir_all(&empty).map_err(|e| format!("Phaethon couldn’t prepare a folder for Gemini CLI: {e}"))?;
            empty
        } else {
            self.cwd.clone()
        };
        let mut cmd = agent::command(self.cli, &self.bin, &cwd, self.config_dir.as_deref());
        cmd.args(args);
        if self.cli == agent::Cli::Gemini {
            cmd.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
        }
        let (stdout, stderr, status) = run_once(self.cli, cmd, &input).await?;
        let logged_out = || self.cli.not_logged_in_message(self.config_dir.as_deref());
        match parse_other_output(self.cli, &stdout) {
            Ok(text) => Ok(text),
            Err(e) if self.cli.not_logged_in(&e) || self.cli.not_logged_in(&stderr) => Err(logged_out()),
            Err(e) if stdout.trim().is_empty() => {
                let said = agent::stderr_summary(&stderr);
                Err(match (said.is_empty(), status.and_then(|s| s.code())) {
                    (false, _) => format!("{} stopped: {said}", self.cli.name()),
                    (true, Some(code)) if code != 0 => format!("{} exited with status {code}.", self.cli.name()),
                    _ => e,
                })
            }
            Err(e) => Err(e),
        }
    }
}

/// Whichever model the vault uses.
pub enum AnyModel {
    Api(ProviderModel<AnyProvider>),
    Cli(CliModel),
    OtherCli(OtherCliModel),
}

impl Model for AnyModel {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        match self {
            AnyModel::Api(m) => m.complete(system, user).await,
            AnyModel::Cli(m) => m.complete(system, user).await,
            AnyModel::OtherCli(m) => m.complete(system, user).await,
        }
    }

    fn shows_pictures(&self) -> bool {
        match self {
            AnyModel::Api(m) => m.shows_pictures(),
            AnyModel::Cli(m) => m.shows_pictures(),
            AnyModel::OtherCli(m) => m.shows_pictures(),
        }
    }

    async fn complete_seeing(&self, system: &str, user: &str, pictures: &[Picture]) -> Result<String, String> {
        match self {
            AnyModel::Api(m) => m.complete_seeing(system, user, pictures).await,
            AnyModel::Cli(m) => m.complete_seeing(system, user, pictures).await,
            AnyModel::OtherCli(m) => m.complete_seeing(system, user, pictures).await,
        }
    }
}

/// The setup folder `cli` uses in `vault`, under `root`: always for Codex and
/// Gemini CLI (see [`agent::Cli::own_home`]), for Claude Code when the vault
/// keeps its setup apart (`isolateClaudeConfig`); `None` otherwise.
pub fn cli_config_dir(vault: &Vault, root: Option<&Path>, cli: agent::Cli) -> Option<PathBuf> {
    if !cli.own_home() && !vault.settings().isolate_claude_config {
        return None;
    }
    let root = root?;
    Some(match cli {
        // Claude Code's predates the others and keeps its place.
        agent::Cli::Claude => root.join(vault.name()),
        other => root.join(format!("{}-{}", vault.name(), other.id())),
    })
}

/// The model for `space_dir`: the vault's CLI when it uses one; Phaethon's
/// provider when it uses Phaethon's own agent and that provider can answer;
/// else Claude Code if it is installed; else why the provider can't answer.
pub fn for_space(vault: &Vault, space_dir: &Path, isolated_config_root: Option<&Path>) -> Result<AnyModel, String> {
    let settings = vault.settings();
    let cli = |_: &crate::vault::VaultSettings| {
        agent::find_claude().map(|bin| CliModel {
            bin,
            cwd: space_dir.to_path_buf(),
            config_dir: cli_config_dir(vault, isolated_config_root, agent::Cli::Claude),
        })
    };
    if settings.backend == Backend::ClaudeCli {
        return cli(&settings).map(AnyModel::Cli).ok_or_else(|| agent::MISSING_CLI_MESSAGE.to_string());
    }
    if let Some(other) = agent::Cli::of(settings.backend) {
        let bin = other.find().ok_or_else(|| other.missing_message().to_string())?;
        return Ok(AnyModel::OtherCli(OtherCliModel {
            cli: other,
            bin,
            cwd: space_dir.to_path_buf(),
            config_dir: cli_config_dir(vault, isolated_config_root, other),
            model: crate::space_model::get_cli(space_dir, other.id()),
        }));
    }
    match crate::providers::for_space(vault, space_dir) {
        Ok(p) => Ok(AnyModel::Api(ProviderModel(p, crate::vision::for_space(vault, space_dir).shown))),
        Err(why) => cli(&settings).map(AnyModel::Cli).ok_or(why),
    }
}

// ---- JSON answers ----------------------------------------------------------------

/// The first JSON object or array in a model's reply: inside a ```json fence,
/// or the first balanced `{...}` / `[...]`, strings and escapes respected.
pub fn extract_json(reply: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(reply.trim()) {
        return Some(v);
    }
    let fenced = reply.split("```").skip(1).step_by(2).map(|b| b.trim_start_matches(|c: char| c.is_ascii_alphabetic()).trim());
    for block in fenced {
        if let Ok(v) = serde_json::from_str::<Value>(block) {
            return Some(v);
        }
    }
    let bytes = reply.as_bytes();
    for (start, &b) in bytes.iter().enumerate() {
        if b != b'{' && b != b'[' {
            continue;
        }
        let (mut depth, mut in_str, mut esc) = (0i32, false, false);
        for (i, &c) in bytes.iter().enumerate().skip(start) {
            if in_str {
                match (esc, c) {
                    (true, _) => esc = false,
                    (false, b'\\') => esc = true,
                    (false, b'"') => in_str = false,
                    _ => {}
                }
                continue;
            }
            match c {
                b'"' => in_str = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(v) = serde_json::from_str::<Value>(&reply[start..=i]) {
                            return Some(v);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Ask for JSON and check it with `validate`. One retry, telling the model what
/// was wrong; a second bad answer is an error (and nothing gets written).
pub async fn ask_json<M: Model, T>(model: &M, system: &str, user: &str, validate: impl Fn(&Value) -> Result<T, String>) -> Result<T, String> {
    ask_json_seeing(model, system, user, &[], validate).await
}

/// [`ask_json`] with pictures alongside the question (and its retry).
pub async fn ask_json_seeing<M: Model, T>(model: &M, system: &str, user: &str, pictures: &[Picture], validate: impl Fn(&Value) -> Result<T, String>) -> Result<T, String> {
    let ask = |u: String| async move { if pictures.is_empty() { model.complete(system, &u).await } else { model.complete_seeing(system, &u, pictures).await } };
    let reply = ask(user.to_string()).await?;
    let first = match extract_json(&reply) {
        Some(v) => validate(&v),
        None => Err("the reply had no JSON in it".into()),
    };
    let problem = match first {
        Ok(t) => return Ok(t),
        Err(p) => p,
    };
    let shown: String = reply.chars().take(4_000).collect();
    let retry = format!(
        "{user}\n\n<previous_reply>\n{shown}\n</previous_reply>\n\nThat reply couldn't be used: {problem}. Answer again with only the corrected JSON, in the same format."
    );
    let reply = ask(retry).await?;
    match extract_json(&reply) {
        Some(v) => validate(&v),
        None => Err("the reply had no JSON in it".into()),
    }
    .map_err(|p| format!("The model’s answer couldn’t be used ({p}), so nothing was saved. Try again."))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::provider::{ErrorKind, ModelTurn, ProviderError};
    use std::sync::Mutex;

    /// Answers each call with the next scripted reply, and keeps what it was asked.
    pub struct Scripted {
        pub replies: Mutex<Vec<Result<String, String>>>,
        pub asked: Mutex<Vec<(String, String)>>,
    }

    impl Scripted {
        pub fn new(replies: &[&str]) -> Self {
            Self { replies: Mutex::new(replies.iter().rev().map(|r| Ok(r.to_string())).collect()), asked: Mutex::default() }
        }
        pub fn failing(message: &str) -> Self {
            Self { replies: Mutex::new(vec![Err(message.to_string())]), asked: Mutex::default() }
        }
        pub fn calls(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    impl Model for Scripted {
        async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
            self.asked.lock().unwrap().push((system.into(), user.into()));
            self.replies.lock().unwrap().pop().unwrap_or_else(|| Err("no more scripted replies".into()))
        }
    }

    struct FakeProvider(Result<(&'static str, &'static str), ErrorKind>, Mutex<Option<Value>>);

    impl Provider for FakeProvider {
        async fn turn(&self, req: ModelRequest<'_>, _: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<ModelTurn, ProviderError> {
            *self.1.lock().unwrap() = Some(json!({"system": req.system, "messages": req.messages, "tools": req.tools}));
            match self.0 {
                Ok((text, stop)) => Ok(ModelTurn { content: vec![json!({"type": "text", "text": text})], stop_reason: stop.into(), invalid_inputs: vec![] }),
                Err(kind) => Err(ProviderError::new(kind, "Phaethon couldn’t reach Anthropic.")),
            }
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn the_provider_is_asked_once_with_no_tools() {
        let p = ProviderModel(FakeProvider(Ok(("{\"ok\":1}", "end_turn")), Mutex::default()), true);
        assert_eq!(block_on(p.complete("sys", "hello")).unwrap(), "{\"ok\":1}");
        let asked = p.0.1.lock().unwrap().clone().unwrap();
        assert_eq!(asked["system"], "sys");
        assert_eq!(asked["tools"], json!([]));
        assert_eq!(asked["messages"][0]["content"][0]["text"], "hello");
        // With pictures: each named, then shown, then the question.
        let pic = Picture { label: "courses/C/files/n.pdf, page 2".into(), mime: "image/png".into(), data: "iVBO".into() };
        block_on(p.complete_seeing("sys", "read it", std::slice::from_ref(&pic))).unwrap();
        let asked = p.0.1.lock().unwrap().clone().unwrap();
        assert_eq!(asked["messages"][0]["content"][0]["text"], "Picture: courses/C/files/n.pdf, page 2");
        assert_eq!(asked["messages"][0]["content"][1], json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBO"}}));
        assert_eq!(asked["messages"][0]["content"][2]["text"], "read it");
        // A model that can't see pictures is asked without them.
        let blind = ProviderModel(FakeProvider(Ok(("ok", "end_turn")), Mutex::default()), false);
        assert!(!blind.shows_pictures());
        block_on(blind.complete_seeing("sys", "read it", &[pic])).unwrap();
        assert_eq!(blind.0.1.lock().unwrap().clone().unwrap()["messages"][0]["content"], json!([{"type": "text", "text": "read it"}]));
        let refused = ProviderModel(FakeProvider(Ok(("", "refusal")), Mutex::default()), false);
        assert!(block_on(refused.complete("s", "u")).unwrap_err().contains("declined"));
        let down = ProviderModel(FakeProvider(Err(ErrorKind::Network), Mutex::default()), false);
        assert_eq!(block_on(down.complete("s", "u")).unwrap_err(), "Phaethon couldn’t reach Anthropic.");
    }

    #[test]
    fn json_is_found_in_fences_prose_and_strings_with_brackets() {
        assert_eq!(extract_json("{\"a\":1}").unwrap(), json!({"a": 1}));
        assert_eq!(extract_json("Here you go:\n```json\n{\"a\": [1]}\n```\nEnjoy").unwrap(), json!({"a": [1]}));
        assert_eq!(extract_json("Sure! {\"q\": \"is {x} a set? \\\"}\\\"\"} done").unwrap(), json!({"q": "is {x} a set? \"}\""}));
        assert_eq!(extract_json("[1, 2] and {\"b\":2}").unwrap(), json!([1, 2]));
        assert_eq!(extract_json("{broken {\"c\":3}").unwrap(), json!({"c": 3}));
        assert!(extract_json("no json here").is_none());
    }

    #[test]
    fn a_bad_answer_is_retried_once_with_the_problem() {
        let check = |v: &Value| v["n"].as_u64().ok_or_else(|| "\"n\" must be a number".to_string());
        let m = Scripted::new(&["{\"n\": \"two\"}", "{\"n\": 2}"]);
        assert_eq!(block_on(ask_json(&m, "s", "make n", check)).unwrap(), 2);
        let asked = m.asked.lock().unwrap();
        assert!(asked[1].1.contains("\"n\" must be a number") && asked[1].1.contains("{\"n\": \"two\"}"), "{}", asked[1].1);
        drop(asked);
        let m = Scripted::new(&["nope", "still {\"n\": null}"]);
        let err = block_on(ask_json(&m, "s", "u", check)).unwrap_err();
        assert!(err.contains("nothing was saved") && err.contains("must be a number"), "{err}");
        assert_eq!(m.calls(), 2, "never more than one retry");
        let m = Scripted::failing(NO_MODEL);
        assert_eq!(block_on(ask_json(&m, "s", "u", check)).unwrap_err(), NO_MODEL);
    }

    #[test]
    fn cli_output_is_parsed_robustly() {
        assert_eq!(parse_cli_output(r#"{"type":"result","subtype":"success","is_error":false,"result":"hi"}"#).unwrap(), "hi");
        assert_eq!(parse_cli_output(r#"[{"type":"system"},{"type":"result","subtype":"success","result":"yo"}]"#).unwrap(), "yo");
        assert_eq!(parse_cli_output("{\"type\":\"system\"}\n{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"z\"}\n").unwrap(), "z");
        assert_eq!(parse_cli_output("plain text answer").unwrap(), "plain text answer");
        assert_eq!(parse_cli_output(r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#).unwrap_err(), agent::NOT_LOGGED_IN_MESSAGE);
        assert!(parse_cli_output(r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#).unwrap_err().contains("error_max_turns"));
        assert!(parse_cli_output("  ").is_err());
    }

    #[test]
    fn cli_args_allow_no_tools_and_none_of_the_users_setup() {
        let a = cli_args("SYS");
        assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        for flag in ["-p", "--restricted", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"] {
            assert!(a.iter().any(|x| x == flag), "missing {flag}");
        }
        assert!(a.windows(2).any(|w| w[0] == "--output-format" && w[1] == "json"));
        assert!(a.windows(2).any(|w| w[0] == "--system-prompt" && w[1] == "SYS"));
        assert!(!a.iter().any(|x| x.contains("dangerously") || x == "bypassPermissions" || x == "--bare" || x == "--resume"));
        // With pictures: the same walls, the message as stream-json on stdin.
        let s = cli_args_seeing("SYS");
        assert!(s.windows(2).any(|w| w[0] == "--input-format" && w[1] == "stream-json"));
        assert!(s.windows(2).any(|w| w[0] == "--output-format" && w[1] == "stream-json"));
        assert!(s.iter().any(|x| x == "--verbose") && s.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        for flag in ["--restricted", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"] {
            assert!(s.iter().any(|x| x == flag), "missing {flag}");
        }
        let line = cli_message("read it", &[Picture { label: "p. 1".into(), mime: "image/jpeg".into(), data: "/9j/".into() }]);
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][1]["source"]["media_type"], "image/jpeg");
        assert_eq!(v["message"]["content"][2]["text"], "read it");
        // Codex: each picture a file, before the prompt read from stdin.
        let a = with_images(vec!["exec".into(), "--json".into(), "-".into()], &[PathBuf::from("/t/picture-1.png")]);
        assert_eq!(a, ["exec", "--json", "--image=/t/picture-1.png", "-"]);
    }

    #[cfg(unix)]
    fn fake_cli(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_cli_gets_the_question_on_stdin_and_its_answer_is_read() {
        let dir = std::env::temp_dir().join(format!("phaethon-study-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Saves its arguments and stdin, then answers like `claude -p --output-format json`.
        let bin = fake_cli(
            &dir,
            r#"for a in "$@"; do printf '%s\n' "$a"; done > "$(dirname "$0")/args"
cat > "$(dirname "$0")/stdin"
printf '%s' "${CLAUDECODE:-unset}" > "$(dirname "$0")/env"
printf '{"type":"result","subtype":"success","is_error":false,"result":"```json\\n{\\"cards\\": []}\\n```"}'"#,
        );
        unsafe { std::env::set_var("CLAUDECODE", "1") };
        let m = CliModel { bin, cwd: dir.clone(), config_dir: None };
        let reply = block_on(m.complete("You make flashcards.", "Material: sets")).unwrap();
        assert_eq!(extract_json(&reply).unwrap(), json!({"cards": []}));
        assert_eq!(std::fs::read_to_string(dir.join("stdin")).unwrap(), "Material: sets");
        let args = std::fs::read_to_string(dir.join("args")).unwrap();
        assert!(args.contains("--tools\n\n") && args.contains("--system-prompt\nYou make flashcards.\n"), "{args}");
        assert!(!args.contains("Material"), "the question never goes in argv");
        assert_eq!(std::fs::read_to_string(dir.join("env")).unwrap(), "unset", "a parent session's variables are removed");

        let logged_out = fake_cli(&dir.join("out"), r#"cat >/dev/null; echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'"#);
        let m = CliModel { bin: logged_out, cwd: dir.clone(), config_dir: None };
        assert_eq!(block_on(m.complete("s", "u")).unwrap_err(), agent::NOT_LOGGED_IN_MESSAGE);
        let crashed = fake_cli(&dir.join("crash"), "cat >/dev/null; echo 'boom: something broke' >&2; exit 3");
        let m = CliModel { bin: crashed, cwd: dir.clone(), config_dir: None };
        assert_eq!(block_on(m.complete("s", "u")).unwrap_err(), "Claude Code stopped: boom: something broke");
        let m = CliModel { bin: dir.join("missing"), cwd: dir.clone(), config_dir: None };
        assert_eq!(block_on(m.complete("s", "u")).unwrap_err(), agent::MISSING_CLI_MESSAGE);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
