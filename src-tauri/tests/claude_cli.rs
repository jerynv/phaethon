//! End-to-end checks against the real `claude` CLI and the user's own login.
//! Ignored by default (they cost real requests); run with:
//!   cargo test --test claude_cli -- --ignored --test-threads=1 --nocapture
//! They use a vault in the temp folder, never the user's own.

use std::time::{Duration, Instant};

use phaethon_lib::agent::{self, AgentEvent, Runs, TurnRequest};
use phaethon_lib::thread;
use phaethon_lib::vault::{self, Vault};

fn test_vault() -> Vault {
    Vault::at(std::env::temp_dir().join("phaethon-real-cli"))
}

fn turn(runs: &Runs, space: &str, prompt: &str) -> (String, Vec<AgentEvent>) {
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let dir = vault.space_dir(space).unwrap();
    let mut events = vec![];
    tauri::async_runtime::block_on(agent::run_turn(
        runs,
        space,
        TurnRequest {
            space_dir: &dir,
            prompt,
            attachments: vec![],
            replace_from: None,
            config_dir: None,
            add_dirs: vec![],
        },
        |e| {
            eprintln!("event: {e:?}");
            events.push(e)
        },
    ));
    let text = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Text { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    (text, events)
}

#[test]
#[ignore = "uses the real claude CLI and login"]
fn pong_then_resume_in_school() {
    let runs = Runs::default();
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let dir = vault.space_dir("school").unwrap();
    vault::clear_session(&dir);

    let (text, events) = turn(&runs, "school", "Reply with exactly: pong");
    assert!(
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::Text { .. }))
            .count()
            >= 1
    );
    assert_eq!(text.trim().to_lowercase(), "pong", "events: {events:?}");
    let saved = vault::read_session(&dir).expect("session id persisted");
    assert!(
        matches!(events.last(), Some(AgentEvent::End { session_id: Some(id) }) if *id == saved)
    );
    eprintln!("session after turn 1: {saved}");

    // Second turn resumes the saved session, so it can see the first exchange.
    let (text, events) = turn(
        &runs,
        "school",
        "What single word did you reply with in your previous message? Answer with only that word.",
    );
    eprintln!("session after turn 2: {:?}", vault::read_session(&dir));
    assert!(text.to_lowercase().contains("pong"), "events: {events:?}");
}

#[test]
#[ignore = "uses the real claude CLI and login"]
fn cancel_kills_the_child_and_its_group() {
    let runs = Runs::default();
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let dir = vault.space_dir("work").unwrap();
    let canceller = runs.clone();
    let watcher = std::thread::spawn(move || {
        // Wait until the child is up, give it a moment, then cancel.
        let start = Instant::now();
        let pid = loop {
            if let Some(pid) = canceller.running_pid("work") {
                break pid;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "child never started"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        std::thread::sleep(Duration::from_secs(3));
        eprintln!("cancelling pid {pid}");
        assert!(canceller.cancel("work"));
        pid
    });
    let mut events = vec![];
    tauri::async_runtime::block_on(agent::run_turn(
        &runs,
        "work",
        TurnRequest {
            space_dir: &dir,
            prompt: "Count from 1 to 300, one number per line, nothing else.",
            attachments: vec![],
            replace_from: None,
            config_dir: None,
            add_dirs: vec![],
        },
        |e| events.push(e),
    ));
    let pid = watcher.join().unwrap();
    let deltas = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Text { .. }))
        .count();
    eprintln!(
        "text deltas before cancel: {deltas}; last events: {:?}",
        &events[events.len().saturating_sub(3)..]
    );
    assert!(
        events.contains(&AgentEvent::Cancelled),
        "events: {events:?}"
    );
    assert!(matches!(events.last(), Some(AgentEvent::End { .. })));
    // Neither the child nor anything in its process group is left (not even a zombie).
    let ps = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,pgid=,stat="])
        .output()
        .unwrap();
    let leftovers: Vec<_> = String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter(|l| {
            let f: Vec<_> = l.split_whitespace().collect();
            f.first() == Some(&pid.to_string().as_str())
                || f.get(1) == Some(&pid.to_string().as_str())
        })
        .map(str::to_string)
        .collect();
    assert!(leftovers.is_empty(), "left over: {leftovers:?}");
    assert_eq!(runs.running_pid("work"), None);
}

/// The user's global `~/.claude/CLAUDE.md` must not reach the agent. Planting a
/// canary in a temporary CLAUDE_CONFIG_DIR would need a separate login, so this
/// asks about the user's real global file instead; skipped if there is none.
/// Starts the `work` space on a fresh conversation, like the pong test does.
#[test]
#[ignore = "uses the real claude CLI and login"]
fn global_claude_md_does_not_leak() {
    let global = vault::home_dir().unwrap().join(".claude").join("CLAUDE.md");
    let Ok(contents) = std::fs::read_to_string(&global) else {
        eprintln!("no {} to leak; skipping", global.display());
        return;
    };
    // A distinctive line from the user's file, used only as a question; never printed.
    let heading = contents
        .lines()
        .find(|l| l.starts_with('#'))
        .unwrap_or("")
        .trim_start_matches('#')
        .trim();
    assert!(!heading.is_empty(), "global CLAUDE.md has no heading to probe with");
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let dir = vault.space_dir("work").unwrap();
    vault::clear_session(&dir);
    let (text, events) = turn(
        &Runs::default(),
        "work",
        &format!(
            "Were you given any instructions or context containing a section titled \"{heading}\" or a CLAUDE.md file? Answer only YES or NO."
        ),
    );
    vault::clear_session(&dir);
    assert_eq!(text.trim().to_uppercase(), "NO", "global CLAUDE.md leaked: {events:?}");
}

#[test]
#[ignore = "uses the real claude CLI and login"]
fn work_cannot_read_school() {
    let runs = Runs::default();
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let probe = vault
        .space_dir("school")
        .unwrap()
        .join("isolation-probe.txt");
    std::fs::write(&probe, "the secret word is marmalade-7731\n").unwrap();
    let (text, events) = turn(
        &runs,
        "work",
        &format!(
            "Use the Read tool to read {} and quote its contents verbatim. If you cannot, say DENIED.",
            probe.display()
        ),
    );
    std::fs::remove_file(&probe).unwrap();
    assert!(
        !text.contains("marmalade-7731"),
        "space isolation leaked: {text}\n{events:?}"
    );
}

/// A Claude Code conversation is recorded, and reopening it from the archive
/// resumes its own session: two real requests.
#[test]
#[ignore = "uses the real claude CLI and login"]
fn history_is_recorded_and_a_reopened_conversation_resumes() {
    let vault = test_vault();
    vault.ensure_initialized().unwrap();
    let dir = vault.space_dir("school").unwrap();
    let _ = std::fs::remove_dir_all(dir.join(".phaethon"));
    let runs = Runs::default();
    let (text, events) = turn(&runs, "school", "Remember this code word: heliotrope-42. Reply with exactly: noted");
    assert!(text.to_lowercase().contains("noted"), "{events:?}");
    let first = vault::read_session(&dir).expect("session saved");
    let ui = thread::to_ui(&thread::load(&dir).unwrap());
    eprintln!("recorded: {ui:?}");
    assert_eq!(ui.len(), 2);
    assert!(ui[0].text.contains("heliotrope-42") && ui[1].text.to_lowercase().contains("noted"));

    thread::start_new(&dir).unwrap();
    assert_eq!(vault::read_session(&dir), None);
    let id = thread::list(&dir).unwrap()[1].id.clone();
    thread::open(&dir, &id).unwrap();
    assert_eq!(vault::read_session(&dir).as_deref(), Some(first.as_str()));
    let (text, events) = turn(&runs, "school", "What was the code word? Reply with only the word.");
    eprintln!("session after the second turn: {:?}", vault::read_session(&dir));
    assert!(text.contains("heliotrope-42"), "{events:?}");
    let ui = thread::to_ui(&thread::load(&dir).unwrap());
    eprintln!("recorded: {ui:?}");
    assert_eq!(ui.len(), 4);
}
