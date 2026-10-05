//! The "Claude Code not installed" path, without touching the real CLI.

use steward_lib::agent::{self, AgentEvent, ErrorCode, Runs, TurnRequest};

#[test]
fn missing_binary_reports_install_hint() {
    // Debug builds honour this override; point it at nothing.
    unsafe { std::env::set_var("STEWARD_CLAUDE_BIN", "/nonexistent/claude") };
    let dir = std::env::temp_dir();
    let mut events = vec![];
    tauri::async_runtime::block_on(agent::run_turn(
        &Runs::default(),
        "school",
        TurnRequest {
            space_dir: &dir,
            prompt: "hi",
            config_dir: None,
        },
        |e| events.push(e),
    ));
    assert_eq!(
        events,
        vec![
            AgentEvent::Error {
                code: ErrorCode::MissingCli,
                message: agent::MISSING_CLI_MESSAGE.into()
            },
            AgentEvent::End { session_id: None },
        ]
    );
}
