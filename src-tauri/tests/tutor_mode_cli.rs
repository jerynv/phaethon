//! With Claude Code answering, a space's tutor mode reaches the CLI through
//! `--append-system-prompt`, and normal mode adds nothing. Uses a fake CLI
//! that records its arguments; never the real one.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use phaethon_lib::agent::{self, AgentEvent, Runs, TurnRequest};
use phaethon_lib::tutor_mode::{self, Mode};
use phaethon_lib::vault::Vault;

#[test]
fn the_spaces_mode_is_appended_to_claude_codes_system_prompt() {
    let root = std::env::temp_dir().join(format!("phaethon-tutor-cli-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let vault = Vault::at(&root);
    vault.ensure_initialized().unwrap();
    let args_file = root.join("args.txt");
    let fake = root.join("claude");
    fs::write(
        &fake,
        format!(
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n--next--\\n' \"$a\"; done > '{}'\ncat > /dev/null\necho '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}}'\n",
            args_file.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    // Debug builds honour this override (see agent::find_claude).
    unsafe { std::env::set_var("PHAETHON_CLAUDE_BIN", &fake) };

    let turn = |space: &str| -> Vec<String> {
        let dir = vault.space_dir(space).unwrap();
        let mut events = vec![];
        tauri::async_runtime::block_on(agent::run_turn(
            &Runs::default(),
            space,
            TurnRequest { space_dir: &dir, prompt: "quiz me on graphs", attachments: vec![], replace_from: None, config_dir: None, add_dirs: vec![], model: None },
            |e| events.push(e),
        ));
        assert!(matches!(events.last(), Some(AgentEvent::End { .. })), "{events:?}");
        let text = fs::read_to_string(&args_file).unwrap();
        text.split("\n--next--\n").filter(|a| !a.is_empty()).map(str::to_string).collect()
    };

    let normal = turn("school");
    assert!(!normal.iter().any(|a| a == "--append-system-prompt"), "{normal:?}");

    tutor_mode::set(&vault, "school", Mode::Quiz).unwrap();
    let quiz = turn("school");
    let at = quiz.iter().position(|a| a == "--append-system-prompt").expect("mode passed");
    assert!(quiz[at + 1].starts_with("# Tutor mode: Quiz me") && quiz[at + 1].contains("one question per message"));
    assert!(!quiz.iter().any(|a| a.contains("quiz me on graphs")), "the prompt still goes over stdin");
    for flag in ["--restricted", "--safe-mode", "--disable-slash-commands", "--strict-mcp-config"] {
        assert!(quiz.iter().any(|a| a == flag), "missing {flag}");
    }

    let work = turn("work");
    assert!(!work.iter().any(|a| a == "--append-system-prompt"), "another space keeps its own (normal) mode");
    fs::remove_dir_all(&root).unwrap();
}
