//! With Claude Code answering, a space's tutor mode reaches the CLI through
//! `--append-system-prompt` (after how to offer a quiz from the chat), and
//! normal mode adds no mode; a space's own model for it goes as `--model`,
//! and its model menu lists the aliases its help gives. Uses a fake CLI
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
            "#!/bin/sh\nif [ \"$1\" = --help ]; then cat <<'EOF'\n  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name\nEOF\nexit 0; fi\nfor a in \"$@\"; do printf '%s\\n--next--\\n' \"$a\"; done > '{}'\ncat > /dev/null\necho '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}}'\n",
            args_file.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    // Debug builds honour this override (see agent::find_claude).
    unsafe { std::env::set_var("PHAETHON_CLAUDE_BIN", &fake) };

    let turn_with = |space: &str, model: Option<&str>| -> Vec<String> {
        let dir = vault.space_dir(space).unwrap();
        let mut events = vec![];
        tauri::async_runtime::block_on(agent::run_turn(
            &Runs::default(),
            space,
            TurnRequest { space_dir: &dir, prompt: "quiz me on graphs", attachments: vec![], replace_from: None, config_dir: None, add_dirs: vec![], model: model.map(str::to_string), full_access: false },
            |e| events.push(e),
        ));
        assert!(matches!(events.last(), Some(AgentEvent::End { .. })), "{events:?}");
        let text = fs::read_to_string(&args_file).unwrap();
        text.split("\n--next--\n").filter(|a| !a.is_empty()).map(str::to_string).collect()
    };
    let turn = |space: &str| turn_with(space, None);

    // Normal mode: only how to offer a quiz from the chat, no tutor mode.
    let normal = turn("school");
    let at = normal.iter().position(|a| a == "--append-system-prompt").expect("the study block passed");
    assert!(normal[at + 1].starts_with("# A quiz or flashcards from the chat") && !normal[at + 1].contains("# Tutor mode"), "{normal:?}");

    tutor_mode::set(&vault, "school", Mode::Quiz).unwrap();
    let quiz = turn("school");
    let at = quiz.iter().position(|a| a == "--append-system-prompt").expect("mode passed");
    assert!(quiz[at + 1].contains("\n\n# Tutor mode: Quiz me") && quiz[at + 1].contains("one question per message"), "the mode comes last");
    assert_eq!(quiz.iter().filter(|a| *a == "--append-system-prompt").count(), 1);
    assert!(!quiz.iter().any(|a| a.contains("quiz me on graphs")), "the prompt still goes over stdin");
    for flag in ["--restricted", "--safe-mode", "--disable-slash-commands", "--strict-mcp-config"] {
        assert!(quiz.iter().any(|a| a == flag), "missing {flag}");
    }

    let work = turn("work");
    assert!(!work.iter().any(|a| a.contains("# Tutor mode")), "another space keeps its own (normal) mode");
    assert!(!work.iter().any(|a| a == "--model"), "Claude Code's own model unless the space names one");

    // A space's own model for Claude Code.
    let opus = turn_with("work", Some("opus"));
    assert!(opus.windows(2).any(|w| w == ["--model", "opus"]), "{opus:?}");
    // A name that could be read as a flag never reaches it.
    assert!(!turn_with("work", Some("--dangerously-skip-permissions")).iter().any(|a| a == "--model" || a.contains("dangerously")));

    // Its model menu: the aliases its help gives, said to be no more than that.
    let listed = tauri::async_runtime::block_on(agent::models::list(agent::Cli::Claude, None));
    assert_eq!(listed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["fable", "opus", "sonnet"]);
    assert!(listed.note.unwrap().starts_with("Claude Code can’t list its models"));
    fs::remove_dir_all(&root).unwrap();
}
