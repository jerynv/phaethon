//! Claude Code (`claude`): its arguments and its `stream-json` output.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentEvent, Outcome, place};

/// Tools the agent may use. Read-only for now: the agent can look at files in
/// its space but cannot change them, run commands, or reach the network. Write
/// tools come later, together with an in-app confirmation flow.
pub const ALLOWED_TOOLS: &str = "Read,Grep,Glob";

/// Shown when the binary cannot be found or started.
pub const MISSING_CLI_MESSAGE: &str = "Claude Code was not found. Install Claude Code, then run `claude` once in a terminal to log in.";

pub(crate) const NOT_LOGGED_IN_MESSAGE: &str =
    "Claude Code is not logged in. Run `claude` once in a terminal to log in, then try again.";

/// Variables a parent Claude Code session sets for its own children. If Phaethon
/// was launched from inside one, they would make our child think it is nested.
pub(crate) const INHERITED_SESSION_VARS: &[&str] = &[
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

/// Find the `claude` binary: `PATH` first, then `~/.local/bin` (the installer's
/// default, and not on `PATH` when a macOS app is launched from Finder).
pub fn find_claude() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("PHAETHON_CLAUDE_BIN") {
        // Debug builds only: lets tests point at a scripted fake CLI.
        return Some(PathBuf::from(p));
    }
    let home = crate::vault::home_dir().map(|h| vec![h.join(".local").join("bin")]).unwrap_or_default();
    super::find_on_path("claude", &home)
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

pub(super) fn not_logged_in(s: &str) -> bool {
    s.contains("Not logged in") || s.contains("/login")
}

pub(super) fn is_stale(detail: &str) -> bool {
    detail.contains("No conversation found")
}

/// Turns `stream-json` lines into `AgentEvent`s. Unknown lines are ignored, so
/// new CLI event types do not break the app.
pub(super) struct StreamParser {
    space_dir: PathBuf,
    /// Granted folders of other spaces, so reads there are labelled with the space.
    pub(super) granted: Vec<(String, PathBuf)>,
    session_id: Option<String>,
    emitted_text: bool,
    result: Option<Outcome>,
}

impl StreamParser {
    pub(super) fn new(space_dir: &Path) -> Self {
        Self {
            space_dir: space_dir.to_path_buf(),
            granted: vec![],
            session_id: None,
            emitted_text: false,
            result: None,
        }
    }

    pub(super) fn feed(&mut self, line: &str) -> Vec<AgentEvent> {
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

    pub(super) fn finish(self) -> Outcome {
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
    match block["name"].as_str().unwrap_or("") {
        "Read" => place("Reading", s("file_path"), space_dir, granted),
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
