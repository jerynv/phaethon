//! One way to ask a model a single question, for everything in Study that
//! needs one (making cards and quizzes, grading short answers, reviewing
//! mistakes). It goes through whatever the vault uses:
//!
//! - Phaethon's own provider (anthropic.rs) when Phaethon's agent is chosen
//!   and an API key is saved; the key stays in Rust.
//! - Otherwise the official Claude Code CLI the person installed and logged
//!   into, as a one-shot print call with no tools at all, no session saved,
//!   and none of their own setup loaded. Phaethon never reads or passes its
//!   credentials (CLAUDE.md: the subscription rule).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::agent;
use crate::anthropic::Anthropic;
use crate::provider::{Delta, ModelRequest, Provider};
use crate::vault::{Backend, Vault};

pub const NO_MODEL: &str = "No model is set up: add an API key in Settings, or switch to Claude Code.";
/// Longest a single model call may take.
const CLI_TIMEOUT: Duration = Duration::from_secs(600);
/// Most of the CLI's output kept.
const CLI_OUTPUT_MAX: u64 = 8 * 1024 * 1024;

/// Ask once, get text back. `Err` is a message for the person.
pub trait Model: Send + Sync {
    fn complete(&self, system: &str, user: &str) -> impl Future<Output = Result<String, String>> + Send;
}

/// Phaethon's own provider, asked with no tools.
pub struct ProviderModel<P: Provider>(pub P);

impl<P: Provider> Model for ProviderModel<P> {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        let messages = [json!({"role": "user", "content": [{"type": "text", "text": user}]})];
        let no_tools = json!([]);
        let mut ignore = |_: Delta<'_>| {};
        let turn = self.0.turn(ModelRequest { system, messages: &messages, tools: &no_tools }, &mut ignore).await.map_err(|e| e.message)?;
        if turn.stop_reason == "refusal" {
            return Err("Claude declined to do this with this material.".into());
        }
        let text: String = turn.content.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
        if turn.stop_reason == "max_tokens" && text.trim().is_empty() {
            return Err("The answer was cut off before it began. Try fewer cards or questions.".into());
        }
        Ok(text)
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

impl Model for CliModel {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.args(cli_args(system))
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for var in agent::INHERITED_SESSION_VARS {
            cmd.env_remove(var);
        }
        if let Some(dir) = &self.config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(agent::MISSING_CLI_MESSAGE.into()),
            Err(e) => return Err(format!("Could not start Claude Code: {e}")),
        };
        let mut stdin = child.stdin.take();
        let mut out = child.stdout.take().expect("stdout is piped");
        let mut err = child.stderr.take().expect("stderr is piped");
        let user = user.to_string();
        let run = async move {
            let feed = async move {
                if let Some(s) = stdin.as_mut() {
                    // A write error means the CLI already exited; its output says why.
                    let _ = s.write_all(user.as_bytes()).await;
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
            return Err("Claude Code took too long to answer, so it was stopped. Try fewer cards or questions.".into());
        };
        let status = child.wait().await.ok();
        let stdout = String::from_utf8_lossy(&stdout);
        let stderr = String::from_utf8_lossy(&stderr);
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

/// Whichever model the vault uses.
pub enum AnyModel {
    Api(ProviderModel<Anthropic>),
    Cli(CliModel),
}

impl Model for AnyModel {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        match self {
            AnyModel::Api(m) => m.complete(system, user).await,
            AnyModel::Cli(m) => m.complete(system, user).await,
        }
    }
}

/// The model for `space_dir`: Claude Code when the vault uses it; Phaethon's
/// provider when it uses Phaethon's own agent and a key is saved; else Claude
/// Code if it is installed; else [`NO_MODEL`].
pub fn for_space(vault: &Vault, space_dir: &Path, isolated_config_root: Option<&Path>) -> Result<AnyModel, String> {
    let settings = vault.settings();
    let cli = |settings: &crate::vault::VaultSettings| {
        agent::find_claude().map(|bin| CliModel {
            bin,
            cwd: space_dir.to_path_buf(),
            config_dir: settings.isolate_claude_config.then(|| isolated_config_root.map(|r| r.join(vault.name()))).flatten(),
        })
    };
    if settings.backend == Backend::ClaudeCli {
        return cli(&settings).map(AnyModel::Cli).ok_or_else(|| agent::MISSING_CLI_MESSAGE.to_string());
    }
    match crate::secrets::get(&vault.name(), "anthropic") {
        Ok(Some(key)) => {
            let model = crate::space_model::resolve(space_dir, settings.model.clone());
            Ok(AnyModel::Api(ProviderModel(Anthropic::new(key, model, settings.effort.clone()))))
        }
        _ => cli(&settings).map(AnyModel::Cli).ok_or_else(|| NO_MODEL.to_string()),
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
    let reply = model.complete(system, user).await?;
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
    let reply = model.complete(system, &retry).await?;
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
        let p = ProviderModel(FakeProvider(Ok(("{\"ok\":1}", "end_turn")), Mutex::default()));
        assert_eq!(block_on(p.complete("sys", "hello")).unwrap(), "{\"ok\":1}");
        let asked = p.0.1.lock().unwrap().clone().unwrap();
        assert_eq!(asked["system"], "sys");
        assert_eq!(asked["tools"], json!([]));
        assert_eq!(asked["messages"][0]["content"][0]["text"], "hello");
        let refused = ProviderModel(FakeProvider(Ok(("", "refusal")), Mutex::default()));
        assert!(block_on(refused.complete("s", "u")).unwrap_err().contains("declined"));
        let down = ProviderModel(FakeProvider(Err(ErrorKind::Network), Mutex::default()));
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
