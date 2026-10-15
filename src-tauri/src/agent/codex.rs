//! OpenAI's Codex CLI (`codex exec`): its arguments and its `--json` events.
//!
//! Walls, checked against codex-cli 0.162 (`codex sandbox` and a local fake
//! model server; never the person's account):
//! - `--sandbox read-only` lets commands read the whole disk, so it isn't
//!   used. A permissions profile is instead: only the space, the courses and
//!   granted folders it may see, the system's own files (`:minimal`) and
//!   Codex's own install are readable; nothing is writable; no network.
//! - `--add-dir` would make a folder *writable*, so it is never passed.
//! - The person's config.toml (MCP servers, providers, hooks), rules, plugins,
//!   apps, skills, sub-agents, memories, web search and image viewing are off.
//! - The global `AGENTS.md` (and `AGENTS.override.md`) in `CODEX_HOME` always
//!   loads: codex-cli 0.162 adds it to every root session with no setting to
//!   stop it (`codex-home/src/instructions`, `thread_manager.rs`;
//!   `--ignore-user-config` and `project_doc_max_bytes=0` leave it in). So
//!   Codex always runs with a `CODEX_HOME` of its own for the vault (agent.rs),
//!   signed in to there with `codex login` (sign_in.rs); the person's own
//!   `~/.codex` (instructions, config, hooks, skills, sessions, login) is never
//!   used. Proven with the real binary in tests/cli_isolation.rs.
//!
//! A turn's prompt goes over stdin (`-`); a resumed one is
//! `codex exec [options] resume <id> -`, the options before `resume`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentEvent, Outcome, shown_path};

pub const MISSING_CLI_MESSAGE: &str =
    "Codex was not found. Install Codex, then sign in to it in Settings › Assistant.";

/// Variables Codex sets for the commands it runs; inherited, they would make
/// our child think it runs inside another Codex session or sandbox.
pub(crate) const INHERITED_SESSION_VARS: &[&str] = &["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"];

/// Features that reach beyond the space or load the person's own setup.
const DISABLED_FEATURES: &[&str] = &[
    "plugins",
    "apps",
    "multi_agent",
    "goals",
    "view_image",
    "memories",
    "hooks",
    "tool_suggest",
    "skill_search",
    "computer_use",
    "browser_use",
    "in_app_browser",
    "image_generation",
];

/// The permissions profile's name in `-c` overrides.
const PROFILE: &str = "phaethon";

pub fn find_codex() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("PHAETHON_CODEX_BIN") {
        // Debug builds only: lets tests point at a scripted fake CLI.
        return Some(PathBuf::from(p));
    }
    super::find_on_path("codex", &super::common_bin_dirs())
}

/// A TOML string for a `-c key=value` override. A JSON string is a valid TOML
/// basic string (`\"`, `\\`, `\n` and `\uXXXX` escapes alike).
pub(crate) fn toml_str(s: &str) -> String {
    serde_json::to_string(s).expect("a string serializes")
}

/// Options every Codex call shares: no person's setup, nothing written, no
/// network, never asks. `readable` are the only folders commands may read.
pub(crate) fn base_args(cwd: &Path, readable: &[PathBuf], model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push("--cd".into());
    args.push(cwd.to_string_lossy().into_owned());
    if let Some(m) = model {
        args.push("-m".into());
        args.push(m.into());
    }
    let mut roots = vec!["\":minimal\"=\"read\"".to_string()];
    roots.extend(readable.iter().map(|p| format!("{}=\"read\"", toml_str(&p.to_string_lossy()))));
    for c in [
        "approval_policy=\"never\"".to_string(),
        "web_search=\"disabled\"".to_string(),
        // No project AGENTS.md from the space or above it.
        "project_doc_max_bytes=0".to_string(),
        "skills.include_instructions=false".to_string(),
        "skills.bundled.enabled=false".to_string(),
        format!("default_permissions=\"{PROFILE}\""),
        format!("permissions.{PROFILE}.filesystem={{{}}}", roots.join(",")),
    ] {
        args.push("-c".into());
        args.push(c);
    }
    for f in DISABLED_FEATURES {
        args.push("--disable".into());
        args.push((*f).into());
    }
    args
}

/// Folders Codex itself must read to run its helpers inside the sandbox: the
/// one its command is in, and (for a link into an install, as Homebrew and
/// npm make) the install it points into.
pub(crate) fn own_dirs(bin: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = bin.parent().map(Path::to_path_buf).into_iter().collect();
    if let Ok(real) = bin.canonicalize()
        && real != bin
        && let Some(install) = real.parent().and_then(Path::parent)
    {
        dirs.push(install.to_path_buf());
    }
    dirs
}

/// One turn: the space, the folders it may see, read-only. The tutor mode's
/// instructions (if any) are Codex's developer instructions.
pub fn cli_args(space_dir: &Path, bin: &Path, add_dirs: &[PathBuf], model: Option<&str>, mode: Option<&str>, resume: Option<&str>) -> Vec<String> {
    let mut readable = vec![space_dir.to_path_buf()];
    readable.extend(add_dirs.iter().cloned());
    readable.extend(own_dirs(bin));
    turn_tail(base_args(space_dir, &readable, model), mode, resume)
}

/// One turn in a space with full access (full_access.rs): no sandbox, no
/// approvals, the network on, starting in the space. Still none of the
/// person's own Codex setup (config, rules, hooks, project instructions,
/// skills, plugins): Codex runs with the vault's home, as always.
pub fn cli_args_full(space_dir: &Path, model: Option<&str>, mode: Option<&str>, resume: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push("--cd".into());
    args.push(space_dir.to_string_lossy().into_owned());
    if let Some(m) = model {
        args.push("-m".into());
        args.push(m.into());
    }
    for c in ["project_doc_max_bytes=0", "skills.include_instructions=false", "skills.bundled.enabled=false"] {
        args.push("-c".into());
        args.push(c.into());
    }
    for f in DISABLED_FEATURES {
        args.push("--disable".into());
        args.push((*f).into());
    }
    turn_tail(args, mode, resume)
}

/// The tutor mode's instructions, then `resume <id>` and `-` (the prompt on stdin), after every option.
fn turn_tail(mut args: Vec<String>, mode: Option<&str>, resume: Option<&str>) -> Vec<String> {
    if let Some(m) = mode {
        args.push("-c".into());
        args.push(format!("developer_instructions={}", toml_str(m)));
    }
    if let Some(id) = resume {
        args.push("resume".into());
        args.push(id.into());
    }
    args.push("-".into());
    args
}

pub(super) fn not_logged_in(s: &str) -> bool {
    s.contains("401 Unauthorized") || s.contains("Not logged in") || s.contains("Missing bearer")
}

pub(super) fn is_stale(detail: &str) -> bool {
    detail.contains("no rollout found")
}

/// Turns `codex exec --json` lines into `AgentEvent`s. Codex reports each
/// message whole (`item.completed`), not as deltas.
pub(super) struct Parser {
    space_dir: PathBuf,
    pub(super) granted: Vec<(String, PathBuf)>,
    thread_id: Option<String>,
    emitted_text: bool,
    /// The last error event's words, for a run that ends without a result.
    last_error: String,
    result: Option<Outcome>,
}

impl Parser {
    pub(super) fn new(space_dir: &Path) -> Self {
        Self { space_dir: space_dir.to_path_buf(), granted: vec![], thread_id: None, emitted_text: false, last_error: String::new(), result: None }
    }

    pub(super) fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                self.thread_id = Some(s(&v, "thread_id")).filter(|t| !t.is_empty());
                vec![]
            }
            Some("item.started") => self.tool(&v["item"]).into_iter().collect(),
            Some("item.completed") if v["item"]["type"] == "agent_message" => {
                let text = s(&v["item"], "text");
                if text.is_empty() {
                    return vec![];
                }
                let delta = if self.emitted_text { format!("\n\n{text}") } else { text };
                self.emitted_text = true;
                vec![AgentEvent::Text { delta }]
            }
            // Not shown: "Reconnecting... 2/5" and the like say what Codex tries; turn.failed says the end.
            Some("error") => {
                self.last_error = s(&v, "message");
                vec![]
            }
            Some("turn.completed") => {
                self.result = Some(Outcome::Success { session_id: self.thread_id.clone() });
                vec![]
            }
            Some("turn.failed") => {
                let message = s(&v["error"], "message");
                self.result = Some(Outcome::Failed { message: if message.is_empty() { "Codex stopped.".into() } else { message } });
                vec![]
            }
            _ => vec![],
        }
    }

    /// What Codex is doing, for the item that just started.
    fn tool(&self, item: &Value) -> Option<AgentEvent> {
        let s = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or("");
        let label = match s("type") {
            "command_execution" => command_label(s("command"), &self.space_dir, &self.granted),
            "web_search" => format!("Searching the web for \u{201c}{}\u{201d}", s("query")),
            "mcp_tool_call" => format!("Using tool {}", s("tool")),
            "file_change" => "Changing files".into(),
            _ => return None,
        };
        Some(AgentEvent::Tool { label })
    }

    pub(super) fn finish(self) -> Outcome {
        self.result.unwrap_or(Outcome::Incomplete { message: self.last_error })
    }
}

/// "Running cat notes.md": the command without the shell Codex wraps it in
/// (`/bin/zsh -lc '…'`), paths in the space shown relative to it.
fn command_label(command: &str, space_dir: &Path, granted: &[(String, PathBuf)]) -> String {
    let inner = command
        .split_once(" -lc ")
        .or_else(|| command.split_once(" -c "))
        .map(|(_, c)| c.trim().trim_matches(|ch| ch == '\'' || ch == '"'))
        .unwrap_or(command);
    let shown: Vec<String> = inner
        .split(' ')
        .map(|w| if w.starts_with('/') { shown_path(w, space_dir, granted).0 } else { w.to_string() })
        .collect();
    let shown = shown.join(" ");
    let shown: String = shown.chars().take(120).collect();
    format!("Running {shown}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPACE: &str = "/vault/spaces/school";

    fn feed_all(lines: &[&str]) -> (Vec<AgentEvent>, Outcome) {
        let mut p = Parser::new(Path::new(SPACE));
        let evs = lines.iter().flat_map(|l| p.feed(l)).collect();
        (evs, p.finish())
    }

    /// Captured from codex-cli 0.162 `exec --json` (ids kept, text shortened).
    #[test]
    fn a_turn_streams_messages_tools_and_the_thread() {
        let (evs, out) = feed_all(&[
            r#"{"type":"thread.started","thread_id":"01a12a0f-1b21-7df3-be2d-95a5eb36b479"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found."}}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Let me look."}}"#,
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat /vault/spaces/school/notes.md'","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat /vault/spaces/school/notes.md'","aggregated_output":"hi","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"ok"}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}"#,
        ]);
        assert_eq!(
            evs,
            vec![
                AgentEvent::Text { delta: "Let me look.".into() },
                AgentEvent::Tool { label: "Running cat notes.md".into() },
                AgentEvent::Text { delta: "\n\nok".into() },
            ]
        );
        assert_eq!(out, Outcome::Success { session_id: Some("01a12a0f-1b21-7df3-be2d-95a5eb36b479".into()) });
    }

    /// Captured from codex-cli 0.162 with no login: retries, then turn.failed.
    #[test]
    fn a_failed_turn_and_not_logged_in() {
        let (evs, out) = feed_all(&[
            r#"{"type":"thread.started","thread_id":"01a12a12-7464-7d02-a381-c0703acdb308"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}"#,
            r#"{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}"#,
        ]);
        assert!(evs.is_empty());
        let Outcome::Failed { message } = out else { panic!("{out:?}") };
        assert!(not_logged_in(&message));
        // Output that ends without a result keeps the last error's words.
        let (_, out) = feed_all(&[r#"{"type":"error","message":"stream disconnected"}"#]);
        assert_eq!(out, Outcome::Incomplete { message: "stream disconnected".into() });
        assert!(is_stale("Error: thread/resume: thread/resume failed: no rollout found for thread id 01a1 (code -32600)"));
    }

    #[test]
    fn args_are_read_only_walled_and_never_writable() {
        let bin = Path::new("/opt/homebrew/bin/codex");
        let courses = [PathBuf::from("/vault/courses/C241")];
        let a = cli_args(Path::new(SPACE), bin, &courses, Some("gpt-5.5"), Some("# Tutor mode: \"Quiz\"\nAsk one question."), Some("01a12a0f-1b21-7df3-be2d-95a5eb36b479"));
        let has = |w: &[&str]| a.windows(w.len()).any(|x| x == w);
        assert!(has(&["--cd", SPACE]) && has(&["-m", "gpt-5.5"]));
        for flag in ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"] {
            assert!(a.iter().any(|x| x == flag), "missing {flag}");
        }
        assert!(has(&["-c", "approval_policy=\"never\""]) && has(&["-c", "web_search=\"disabled\""]));
        let fs = a.iter().find(|x| x.starts_with("permissions.phaethon.filesystem=")).expect("profile");
        assert!(fs.contains("\":minimal\"=\"read\"") && fs.contains("\"/vault/spaces/school\"=\"read\"") && fs.contains("\"/vault/courses/C241\"=\"read\""), "{fs}");
        assert!(!fs.contains("write"), "nothing is writable: {fs}");
        // Never a sandbox mode (it can't be combined with the profile, and read-only reads the whole disk),
        // never --add-dir (writable), never anything dangerous.
        assert!(!a.iter().any(|x| x == "--add-dir" || x == "-s" || x == "--sandbox" || x.contains("dangerously") || x == "--search" || x.starts_with("sandbox_mode")));
        for f in DISABLED_FEATURES {
            assert!(has(&["--disable", f]), "{f} stays on");
        }
        let dev = a.iter().find(|x| x.starts_with("developer_instructions=")).unwrap();
        assert_eq!(dev, "developer_instructions=\"# Tutor mode: \\\"Quiz\\\"\\nAsk one question.\"");
        // `resume <id> -` comes last, after every option.
        assert_eq!(a[a.len() - 3..], ["resume", "01a12a0f-1b21-7df3-be2d-95a5eb36b479", "-"]);
        let fresh = cli_args(Path::new(SPACE), bin, &[], None, None, None);
        assert_eq!(fresh.last().map(String::as_str), Some("-"));
        assert!(!fresh.iter().any(|x| x == "resume" || x == "-m" || x.starts_with("developer_instructions")));
    }

    #[test]
    fn full_access_has_no_walls_but_none_of_the_persons_setup() {
        let a = cli_args_full(Path::new(SPACE), Some("gpt-5.5"), Some("Be brief."), Some("01a1"));
        let has = |w: &[&str]| a.windows(w.len()).any(|x| x == w);
        assert!(has(&["--cd", SPACE]) && has(&["-m", "gpt-5.5"]) && a.iter().any(|x| x == "--dangerously-bypass-approvals-and-sandbox"));
        for flag in ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"] {
            assert!(a.iter().any(|x| x == flag), "missing {flag}");
        }
        assert!(has(&["-c", "project_doc_max_bytes=0"]) && has(&["-c", "skills.include_instructions=false"]));
        for f in DISABLED_FEATURES {
            assert!(has(&["--disable", f]), "{f} stays off");
        }
        // No profile or sandbox mode to fight the bypass, and the network isn't switched off.
        assert!(!a.iter().any(|x| x.starts_with("permissions.") || x.starts_with("default_permissions") || x == "--sandbox" || x.contains("web_search") || x.contains("approval_policy")));
        assert_eq!(a[a.len() - 3..], ["resume", "01a1", "-"]);
        assert!(a.iter().any(|x| x == "developer_instructions=\"Be brief.\""));
    }

    #[test]
    fn a_path_in_the_profile_cannot_break_out_of_its_string() {
        let a = base_args(Path::new(SPACE), &[PathBuf::from("/x/a\"=\"write\",\"/\"=\"write")], None);
        let fs = a.iter().find(|x| x.starts_with("permissions.")).unwrap();
        assert!(fs.contains(r#""/x/a\"=\"write\",\"/\"=\"write"="read""#), "{fs}");
    }
}
