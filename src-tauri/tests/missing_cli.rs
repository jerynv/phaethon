//! The "Claude Code not installed" path, without touching the real CLI.

use phaethon_lib::agent::{self, AgentEvent, ErrorCode, Runs, TurnRequest};

#[test]
fn missing_binary_reports_install_hint() {
    // Debug builds honour this override; point it at nothing.
    unsafe { std::env::set_var("PHAETHON_CLAUDE_BIN", "/nonexistent/claude") };
    // Settings' check says so too, rather than trusting a path that isn't there.
    assert_eq!(agent::cli_status(), agent::CliStatus { installed: false, path: None });
    let dir = std::env::temp_dir();
    let mut events = vec![];
    tauri::async_runtime::block_on(agent::run_turn(
        &Runs::default(),
        "school",
        TurnRequest {
            space_dir: &dir,
            prompt: "hi",
            attachments: vec![],
            replace_from: None,
            config_dir: None,
            add_dirs: vec![],
        },
        |e| events.push(e),
    ));
    assert_eq!(
        events,
        vec![
            AgentEvent::error(ErrorCode::MissingCli, agent::MISSING_CLI_MESSAGE),
            AgentEvent::End { session_id: None },
        ]
    );
}
