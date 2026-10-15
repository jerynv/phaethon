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
            model: None,
            full_access: false,
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

#[test]
fn missing_codex_or_gemini_names_that_cli() {
    use phaethon_lib::agent::Cli;
    for (cli, var) in [(Cli::Codex, "PHAETHON_CODEX_BIN"), (Cli::Gemini, "PHAETHON_GEMINI_BIN")] {
        unsafe { std::env::set_var(var, "/nonexistent/cli") };
        let dir = std::env::temp_dir().join(format!("phaethon-missing-{}-{}", cli.id(), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let send = |config_dir| {
            let mut events = vec![];
            tauri::async_runtime::block_on(agent::run_cli_turn(
                &Runs::default(),
                "school",
                cli,
                TurnRequest { space_dir: &dir, prompt: "hi", attachments: vec![], replace_from: None, config_dir, add_dirs: vec![], model: None, full_access: false },
                |e| events.push(e),
            ));
            events
        };
        let events = send(Some(dir.join("home")));
        assert_eq!(events, vec![AgentEvent::error(ErrorCode::MissingCli, cli.missing_message()), AgentEvent::End { session_id: None }]);
        assert!(cli.missing_message().starts_with(cli.name()) && cli.missing_message().contains("Settings › Assistant"));
        // Without a home of its own for the vault it never runs, not even to say it is missing.
        let events = send(None);
        assert!(
            matches!(&events[..], [AgentEvent::Error { code: ErrorCode::Cli, message, .. }, AgentEvent::End { .. }] if message.contains("own setup") && message.contains("nothing was sent")),
            "{events:?}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
