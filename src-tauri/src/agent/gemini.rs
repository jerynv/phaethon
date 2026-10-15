//! Google's Gemini CLI (`gemini`, headless): its arguments and its
//! `stream-json` events.
//!
//! Walls, checked against gemini-cli 0.63 (with a local fake model server and
//! a throwaway home, never the person's account):
//! - A policy file from Phaethon denies every tool but reading, listing and
//!   searching files, so the model never even sees the others (shell, edits,
//!   web, memory, sub-agents, leaving plan mode). It is passed both as an
//!   admin policy and as a user one, so it holds even where an administrator's
//!   own policies switch extra admin policies off. `--approval-mode plan` on top.
//! - The read tools stay inside the workspace: the space and the folders given
//!   with `--include-directories`.
//! - No extensions (`-e none`), no MCP servers (an allow-list naming none).
//! - Headless runs need a trusted folder, so the space is trusted for the run
//!   (`GEMINI_CLI_TRUST_WORKSPACE`). A space with its own `.gemini` folder is
//!   refused: trusted, its settings and `.env` would load.
//! - The person's global GEMINI.md and their own settings.json (hooks
//!   included) can't be switched off from outside: GEMINI.md always loads
//!   from the home's `.gemini` (`context.fileName` only adds names), and a
//!   system settings file from Phaethon is ignored unless root owns it. So
//!   Gemini CLI always runs with a home of its own for the vault
//!   (`GEMINI_CLI_HOME`, agent.rs), where its settings, GEMINI.md, skills,
//!   agents, sessions and sign-in live; the person signs in to it there from
//!   Settings (sign_in.rs). Proven with the real binary in tests/cli_isolation.rs.
//! - It has no flag to add to its system prompt (`GEMINI_SYSTEM_MD` replaces
//!   it whole), so a tutor mode's instructions go before each message.
//!
//! The prompt goes over stdin; resuming is `--resume <session id>`.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentEvent, Outcome, place};

pub const MISSING_CLI_MESSAGE: &str =
    "Gemini CLI was not found. Install Gemini CLI, then sign in to it in Settings › Assistant.";

/// Variables Gemini CLI sets for what it runs, or that would change how it
/// starts: a parent session's marker, a replaced system prompt, another
/// settings or trust file, its own sandbox, an editor's connection.
pub(crate) const INHERITED_SESSION_VARS: &[&str] = &[
    "GEMINI_CLI",
    "GEMINI_SYSTEM_MD",
    "GEMINI_WRITE_SYSTEM_MD",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
    "GEMINI_SANDBOX",
    "SANDBOX",
    "SEATBELT_PROFILE",
    "GEMINI_CLI_IDE_SERVER_PORT",
    "GEMINI_CLI_IDE_WORKSPACE_PATH",
];

/// Only reading, listing and searching files; everything else is denied, so
/// the model is never offered it.
const READ_ONLY_POLICY: &str = "# Phaethon: Gemini CLI may only read and search the folders it is given.\n\
[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 900\n\n\
[[rule]]\ntoolName = [\"read_file\", \"list_directory\", \"glob\", \"grep_search\", \"read_many_files\"]\ndecision = \"allow\"\npriority = 950\n";

/// No tools at all (one-shot questions from Study and Clear).
const NO_TOOLS_POLICY: &str = "# Phaethon: no tools.\n[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 999\n";

/// An MCP allow-list that names no server Phaethon knows of, so none connect.
const NO_MCP: &str = "phaethon-none";

pub fn find_gemini() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("PHAETHON_GEMINI_BIN") {
        // Debug builds only: lets tests point at a scripted fake CLI.
        return Some(PathBuf::from(p));
    }
    super::find_on_path("gemini", &super::common_bin_dirs())
}

/// The policy file, written fresh to this user's temporary folder (atomically,
/// so two spaces starting at once never read half of one).
pub fn policy_file(no_tools: bool) -> io::Result<PathBuf> {
    let (name, text) = if no_tools { ("no-tools", NO_TOOLS_POLICY) } else { ("read-only", READ_ONLY_POLICY) };
    let dir = std::env::temp_dir().join("phaethon-gemini");
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let file = dir.join(format!("{name}.toml"));
    let tmp = dir.join(format!("{name}.{}.{:?}.tmp", std::process::id(), std::thread::current().id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &file)?;
    Ok(file)
}

/// Options every Gemini CLI call shares. `policy` is from [`policy_file`].
pub(crate) fn base_args(policy: &Path, json: &str, model: Option<&str>) -> Vec<String> {
    let policy = policy.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "--output-format".into(),
        json.into(),
        "--approval-mode".into(),
        "plan".into(),
        "--extensions".into(),
        "none".into(),
        "--allowed-mcp-server-names".into(),
        NO_MCP.into(),
        "--admin-policy".into(),
        policy.clone(),
        "--policy".into(),
        policy,
    ];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.into());
    }
    args
}

/// One turn's arguments. Folders whose path has a comma are left out: the
/// flag splits its value on commas, so such a path would name other folders.
pub fn cli_args(policy: &Path, add_dirs: &[PathBuf], model: Option<&str>, resume: Option<&str>) -> Vec<String> {
    let mut args = base_args(policy, "stream-json", model);
    for dir in add_dirs.iter().map(|d| d.to_string_lossy()).filter(|d| !d.contains(',')) {
        args.push("--include-directories".into());
        args.push(dir.into_owned());
    }
    if let Some(id) = resume {
        args.push("--resume".into());
        args.push(id.into());
    }
    args
}

/// What Gemini CLI is asked: the tutor mode's instructions first (it has no
/// way to add them to its system prompt), then the message. A message starting
/// with `/` would be read as one of its commands, so it gets a leading space.
pub fn prompt(mode: Option<&str>, message: &str) -> String {
    let message = if message.starts_with('/') { format!(" {message}") } else { message.to_string() };
    match mode {
        Some(m) => format!("<phaethon_tutor_mode>\n{m}\n</phaethon_tutor_mode>\n\n{message}"),
        None => message,
    }
}

/// Whether the space has its own Gemini CLI settings folder (see the module notes).
pub fn has_own_settings(space_dir: &Path) -> bool {
    space_dir.join(".gemini").symlink_metadata().is_ok()
}

pub const OWN_SETTINGS_MESSAGE: &str = "This space has its own Gemini CLI settings folder (.gemini), which could let Gemini CLI change files or reach beyond the space. Move or delete that folder to use Gemini CLI here, or choose another assistant in Settings.";

/// Said when Google refuses the account Gemini CLI signed in with (seen with
/// a personal Google account on the free plan, October 2026).
pub const INELIGIBLE_MESSAGE: &str = "Gemini CLI is signed in, but Google no longer lets it answer with this account: the free plan for individuals now points to Google’s Antigravity instead. A Gemini API key set up in Gemini CLI itself, or a Google Cloud or paid plan, still works. Or choose another assistant in Settings.";

pub(super) fn not_logged_in(s: &str) -> bool {
    s.contains("FatalAuthenticationError") || s.contains("Please set an Auth method") || s.contains("must specify the GEMINI_API_KEY")
}

pub(super) fn is_stale(detail: &str) -> bool {
    detail.contains("Error resuming session")
}

/// Turns `--output-format stream-json` lines into `AgentEvent`s.
pub(super) struct Parser {
    space_dir: PathBuf,
    pub(super) granted: Vec<(String, PathBuf)>,
    session_id: Option<String>,
    emitted_text: bool,
    /// A tool ran since the last text: the next text starts a new paragraph.
    after_tool: bool,
    last_error: String,
    result: Option<Outcome>,
}

impl Parser {
    pub(super) fn new(space_dir: &Path) -> Self {
        Self { space_dir: space_dir.to_path_buf(), granted: vec![], session_id: None, emitted_text: false, after_tool: false, last_error: String::new(), result: None }
    }

    pub(super) fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v.get("type").and_then(Value::as_str) {
            Some("init") => {
                self.session_id = Some(s(&v, "session_id")).filter(|t| !t.is_empty());
                vec![]
            }
            Some("message") if v["role"] == "assistant" => {
                let text = s(&v, "content");
                if text.is_empty() {
                    return vec![];
                }
                let delta = if self.after_tool && self.emitted_text { format!("\n\n{text}") } else { text };
                self.emitted_text = true;
                self.after_tool = false;
                vec![AgentEvent::Text { delta }]
            }
            Some("tool_use") => {
                self.after_tool = true;
                vec![AgentEvent::Tool { label: tool_label(&s(&v, "tool_name"), &v["parameters"], &self.space_dir, &self.granted) }]
            }
            Some("error") => {
                self.last_error = s(&v, "message");
                vec![]
            }
            Some("result") => {
                if v["status"] == "success" {
                    self.result = Some(Outcome::Success { session_id: self.session_id.clone() });
                } else {
                    let (kind, message) = (s(&v["error"], "type"), s(&v["error"], "message"));
                    let message = match (kind.is_empty(), message.is_empty()) {
                        (_, true) if !self.last_error.is_empty() => self.last_error.clone(),
                        (_, true) => "Gemini CLI stopped.".into(),
                        // The kind says whether it is the sign-in (FatalAuthenticationError).
                        (false, false) if kind.contains("Authentication") => format!("{kind}: {message}"),
                        _ => message,
                    };
                    self.result = Some(Outcome::Failed { message });
                }
                vec![]
            }
            _ => vec![],
        }
    }

    pub(super) fn finish(self) -> Outcome {
        self.result.unwrap_or(Outcome::Incomplete { message: self.last_error })
    }
}

fn tool_label(name: &str, input: &Value, space_dir: &Path, granted: &[(String, PathBuf)]) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let path = [s("file_path"), s("absolute_path"), s("dir_path"), s("path")].into_iter().find(|p| !p.is_empty()).unwrap_or("");
    match name {
        "read_file" => place("Reading", path, space_dir, granted),
        "read_many_files" => "Reading files".into(),
        "list_directory" => format!("Listing {}", super::shown_path(path, space_dir, granted).0),
        "grep_search" => format!("Searching files for \u{201c}{}\u{201d}", s("pattern")),
        "glob" => format!("Finding files matching {}", s("pattern")),
        "" => "Using a tool".into(),
        other => format!("Using tool {other}"),
    }
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

    /// Shapes from gemini-cli 0.63 `--output-format stream-json`.
    #[test]
    fn a_turn_streams_text_tools_and_the_session() {
        let (evs, out) = feed_all(&[
            r#"{"type":"init","timestamp":"2026-10-11T08:30:55.594Z","session_id":"72fe4cc9-dcc1-4ea2-8509-2354f70dc649","model":"auto"}"#,
            r#"{"type":"message","timestamp":"2026-10-11T08:30:55.595Z","role":"user","content":"reply with ok\n"}"#,
            r#"{"type":"message","timestamp":"2026-10-11T08:30:55.608Z","role":"assistant","content":"Let me ","delta":true}"#,
            r#"{"type":"message","timestamp":"2026-10-11T08:30:55.608Z","role":"assistant","content":"look.","delta":true}"#,
            r#"{"type":"tool_use","timestamp":"x","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"/vault/spaces/school/notes.md"}}"#,
            r#"{"type":"tool_result","timestamp":"x","tool_id":"t1","status":"success","output":""}"#,
            r#"{"type":"tool_use","timestamp":"x","tool_name":"grep_search","tool_id":"t2","parameters":{"pattern":"graph"}}"#,
            r#"{"type":"message","timestamp":"x","role":"assistant","content":"ok","delta":true}"#,
            r#"{"type":"result","timestamp":"2026-10-11T08:30:55.624Z","status":"success","stats":{"total_tokens":11}}"#,
        ]);
        assert_eq!(
            evs,
            vec![
                AgentEvent::Text { delta: "Let me ".into() },
                AgentEvent::Text { delta: "look.".into() },
                AgentEvent::Tool { label: "Reading file notes.md".into() },
                AgentEvent::Tool { label: "Searching files for \u{201c}graph\u{201d}".into() },
                AgentEvent::Text { delta: "\n\nok".into() },
            ]
        );
        assert_eq!(out, Outcome::Success { session_id: Some("72fe4cc9-dcc1-4ea2-8509-2354f70dc649".into()) });
    }

    #[test]
    fn errors_say_what_happened_and_whether_it_is_the_sign_in() {
        let (_, out) = feed_all(&[r#"{"type":"result","status":"error","error":{"type":"FatalAuthenticationError","message":"Failed to sign in."},"stats":{}}"#]);
        let Outcome::Failed { message } = out else { panic!() };
        assert!(not_logged_in(&message), "{message}");
        let (_, out) = feed_all(&[
            r#"{"type":"error","severity":"error","message":"Model stream ended with an empty response."}"#,
            r#"{"type":"result","status":"error","stats":{}}"#,
        ]);
        assert_eq!(out, Outcome::Failed { message: "Model stream ended with an empty response.".into() });
        assert_eq!(feed_all(&["not json"]).1, Outcome::Incomplete { message: String::new() });
        assert!(is_stale("Error resuming session: Invalid session identifier \"1111\"."));
    }

    #[test]
    fn args_are_read_only_and_folders_are_included_one_by_one() {
        let policy = Path::new("/tmp/p.toml");
        let dirs = [PathBuf::from("/vault/courses/C241"), PathBuf::from("/vault/spaces/work/a,b")];
        let a = cli_args(policy, &dirs, Some("gemini-2.5-pro"), Some("72fe4cc9-dcc1-4ea2-8509-2354f70dc649"));
        let has = |w: &[&str]| a.windows(w.len()).any(|x| x == w);
        assert!(has(&["--output-format", "stream-json"]) && has(&["--approval-mode", "plan"]) && has(&["--extensions", "none"]));
        assert!(has(&["--admin-policy", "/tmp/p.toml"]) && has(&["--policy", "/tmp/p.toml"]));
        assert!(has(&["--allowed-mcp-server-names", NO_MCP]) && has(&["--model", "gemini-2.5-pro"]));
        assert!(has(&["--include-directories", "/vault/courses/C241"]));
        assert!(!a.iter().any(|x| x.contains("a,b")), "a path with a comma would name two folders");
        assert!(has(&["--resume", "72fe4cc9-dcc1-4ea2-8509-2354f70dc649"]));
        assert!(!a.iter().any(|x| x == "--yolo" || x == "-y" || x == "--skip-trust" || x == "yolo" || x == "auto_edit" || x == "-p" || x == "--prompt"));
        assert!(READ_ONLY_POLICY.contains("toolName = \"*\"\ndecision = \"deny\""));
        for writer in ["write_file", "replace", "run_shell_command", "web_fetch", "exit_plan_mode"] {
            assert!(!READ_ONLY_POLICY.contains(writer), "{writer} is never allowed");
        }
    }

    #[test]
    fn the_mode_goes_before_the_message_and_a_slash_is_not_a_command() {
        assert_eq!(prompt(None, "hi"), "hi");
        assert_eq!(prompt(None, "/quit now"), " /quit now");
        let p = prompt(Some("# Tutor mode: Quiz me"), "graphs");
        assert!(p.starts_with("<phaethon_tutor_mode>\n# Tutor mode: Quiz me\n</phaethon_tutor_mode>") && p.ends_with("\n\ngraphs"));
    }

    #[test]
    fn the_policy_file_is_written_and_readable() {
        let f = policy_file(false).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), READ_ONLY_POLICY);
        assert_eq!(std::fs::read_to_string(policy_file(true).unwrap()).unwrap(), NO_TOOLS_POLICY);
    }
}
