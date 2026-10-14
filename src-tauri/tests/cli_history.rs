//! Conversations with Claude Code are Phaethon's like any other: each turn is
//! recorded, the list, search, reopen, edit, delete and clear work, and each
//! conversation resumes its own CLI session. Uses a fake CLI that logs its
//! arguments and what it was asked; never the real one.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use phaethon_lib::agent::{self, AgentEvent, Runs, TurnRequest};
use phaethon_lib::thread::{self, Record};
use phaethon_lib::vault::{self, Vault};
use phaethon_lib::{attachments, memory, search, study};
use serde_json::Value;

const OLD: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/// The fake: run n logs `args-n` and `stdin-n`; it answers "Reply n." in a
/// session that is the one it resumed, or `00000000-0000-0000-0000-<n>`. A
/// resumed id listed in `stale` is unknown to it, as the real CLI says. A
/// message containing "slow" streams "Partial" and then hangs; a one-shot
/// call (Clear's) answers with one detail worth keeping.
fn fake_cli(root: &Path) -> PathBuf {
    let script = format!(
        r#"#!/bin/sh
d='{d}'
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
printf '%s\n' "$@" > "$d/args-$n"
cat > "$d/stdin-$n"
case " $* " in *" --no-session-persistence "*)
  echo '{{"type":"result","subtype":"success","is_error":false,"result":"- Test 1 for C241 is on Thursday."}}'; exit 0;;
esac
resume=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ] && grep -qx "$resume" "$d/stale" 2>/dev/null; then
  echo "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":\"No conversation found with session ID: $resume\"}}"
  exit 1
fi
sid=${{resume:-$(printf '00000000-0000-0000-0000-%012d' $n)}}
echo "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$sid\"}}"
if grep -q slow "$d/stdin-$n"; then
  echo '{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"Partial"}}}}}}'
  sleep 30
fi
echo "{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"Reply $n.\"}}}}}}"
echo "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Reply $n.\",\"session_id\":\"$sid\"}}"
"#,
        d = root.display()
    );
    let fake = root.join("claude");
    fs::write(&fake, script).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    fake
}

struct Fixture {
    root: PathBuf,
    vault: Vault,
    dir: PathBuf,
    runs: Runs,
}

impl Fixture {
    fn run(&self) -> usize {
        fs::read_to_string(self.root.join("count")).map_or(0, |s| s.trim().parse().unwrap())
    }
    fn args(&self, n: usize) -> Vec<String> {
        fs::read_to_string(self.root.join(format!("args-{n}"))).unwrap().lines().map(str::to_string).collect()
    }
    fn stdin(&self, n: usize) -> String {
        fs::read_to_string(self.root.join(format!("stdin-{n}"))).unwrap()
    }
    fn resumed(&self, n: usize) -> Option<String> {
        let a = self.args(n);
        a.iter().position(|x| x == "--resume").map(|i| a[i + 1].clone())
    }
    fn send(&self, prompt: &str, files: Vec<Value>, replace_from: Option<usize>) -> Vec<AgentEvent> {
        let mut events = vec![];
        tauri::async_runtime::block_on(agent::run_turn(
            &self.runs,
            "school",
            TurnRequest { space_dir: &self.dir, prompt, attachments: files, replace_from, config_dir: None, add_dirs: vec![] },
            |e| events.push(e),
        ));
        assert!(matches!(events.last(), Some(AgentEvent::End { .. })), "{events:?}");
        events
    }
    fn shown(&self) -> Vec<(String, String)> {
        thread::to_ui(&thread::load(&self.dir).unwrap()).into_iter().map(|m| (m.role.to_string(), m.text)).collect()
    }
}

fn says(role: &str, text: &str) -> (String, String) {
    (role.into(), text.into())
}

#[test]
fn claude_code_conversations_are_recorded_listed_reopened_and_resumed() {
    let root = std::env::temp_dir().join(format!("phaethon-cli-history-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let vault = Vault::at(root.join("vault"));
    vault.ensure_initialized().unwrap();
    vault.set_setting("backend", "claude-cli".into()).unwrap();
    // Debug builds honour this override (see agent::find_claude).
    unsafe { std::env::set_var("PHAETHON_CLAUDE_BIN", fake_cli(&root)) };
    let dir = vault.space_dir("school").unwrap();
    let f = Fixture { root: root.clone(), vault, dir: dir.clone(), runs: Runs::default() };

    // A space from before conversations kept their sessions: its one session
    // becomes the current conversation's, and is resumed.
    vault::write_session(&dir, OLD).unwrap();
    let events = f.send("When is Test 1?", vec![], None);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:?}");
    assert_eq!(f.resumed(1).as_deref(), Some(OLD));
    assert_eq!(f.stdin(1), "When is Test 1?", "a resumed session gets only the new message");
    assert_eq!(f.shown(), vec![says("user", "When is Test 1?"), says("assistant", "Reply 1.")]);
    let saved = thread::load(&dir).unwrap();
    assert!(saved.iter().all(|m| m["at"].as_u64().is_some()), "times as Phaethon's own loop keeps them");

    // Files: saved with the message, named to the CLI.
    let up = attachments::Upload { name: "notes.md".into(), media_type: "text/markdown".into(), data: "aGk=".into() };
    let refs = attachments::save(&dir, &[up]).unwrap();
    f.send("Summarise this", refs.clone(), None);
    assert!(f.stdin(2).starts_with("Summarise this") && f.stdin(2).contains(refs[0]["path"].as_str().unwrap()));
    let ui = thread::to_ui(&thread::load(&dir).unwrap());
    assert_eq!((ui[2].text.as_str(), ui[2].attachments.len()), ("Summarise this", 1));
    // Valid for Phaethon's own loop too: text and saved files only.
    for m in thread::for_provider(&thread::load(&dir).unwrap()) {
        for b in m["content"].as_array().unwrap() {
            assert!(b["type"] == "text" || b["type"] == "phaethon_attachment", "{b}");
        }
    }

    // A new conversation starts a fresh session; the old one keeps its own.
    thread::start_new(&dir).unwrap();
    f.send("New topic", vec![], None);
    assert_eq!(f.resumed(3), None);
    assert_eq!(f.stdin(3), "New topic");
    let list = thread::list(&dir).unwrap();
    assert_eq!(list.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["New topic", "When is Test 1?"]);
    assert_eq!(list[1].messages, 4);

    // Reopening the first resumes its session, and the turn goes on after its messages.
    thread::open(&dir, &list[1].id).unwrap();
    f.send("And Test 2?", vec![], None);
    assert_eq!(f.resumed(4).as_deref(), Some(OLD));
    assert_eq!(f.shown().len(), 6);
    assert_eq!(f.shown()[4], says("user", "And Test 2?"));
    // The other one resumes its own.
    let other = thread::list(&dir).unwrap()[1].id.clone();
    thread::open(&dir, &other).unwrap();
    f.send("More on that", vec![], None);
    assert_eq!(f.resumed(5).as_deref(), Some("00000000-0000-0000-0000-000000000003"));
    let first = thread::list(&dir).unwrap()[1].id.clone();
    thread::open(&dir, &first).unwrap();

    // Search finds Claude Code conversations, current and past.
    let found = search::search(&[("school".into(), dir.clone())], "test 2");
    assert_eq!(found.conversations.len(), 1);
    assert!(found.conversations[0].current);
    let found = search::search(&[("school".into(), dir.clone())], "more on that");
    assert_eq!((found.conversations.len(), found.conversations[0].current), (1, false));

    // The session is gone on the CLI's side: the turn runs again afresh with the
    // conversation so far as text, with no error, and is recorded once.
    fs::write(root.join("stale"), format!("{OLD}\n")).unwrap();
    let events = f.send("Still there?", vec![], None);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:?}");
    assert_eq!((f.resumed(6).as_deref(), f.resumed(7)), (Some(OLD), None));
    let asked = f.stdin(7);
    assert!(asked.contains("User: When is Test 1?") && asked.contains("Phaethon: Reply 4.") && asked.ends_with("Still there?"), "{asked}");
    assert_eq!(vault::read_session(&dir).as_deref(), Some("00000000-0000-0000-0000-000000000007"));
    assert_eq!(f.shown()[6..], [says("user", "Still there?"), says("assistant", "Reply 7.")]);

    // Edit (or regenerate): the earlier version is kept with its session, and the
    // new one starts a fresh session given what came before the edited message.
    let index = thread::to_ui(&thread::load(&dir).unwrap())[6].index;
    f.send("Are you still there?", vec![], Some(index));
    assert_eq!(f.resumed(8), None);
    let asked = f.stdin(8);
    assert!(asked.contains("User: And Test 2?") && !asked.contains("Still there?\n") && asked.ends_with("Are you still there?"), "{asked}");
    assert_eq!(f.shown()[6..], [says("user", "Are you still there?"), says("assistant", "Reply 8.")]);
    let kept = thread::list(&dir).unwrap().into_iter().find(|t| !t.current && t.messages == 8).expect("the earlier version");
    let kept_session = dir.join(".phaethon/threads").join(format!("{}.session", kept.id));
    assert_eq!(fs::read_to_string(&kept_session).unwrap().trim(), "00000000-0000-0000-0000-000000000007");

    // Delete takes the conversation's session with it.
    thread::delete(&dir, &kept.id).unwrap();
    assert!(!kept_session.exists());

    // Stop keeps what streamed, with the stopped record, and the session from before.
    let before = vault::read_session(&dir);
    let canceller = f.runs.clone();
    let watcher = std::thread::spawn(move || {
        let start = Instant::now();
        while canceller.running_pid("school").is_none() {
            assert!(start.elapsed() < Duration::from_secs(20), "the fake never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(400));
        assert!(canceller.cancel("school"));
    });
    let events = f.send("Go slow", vec![], None);
    watcher.join().unwrap();
    let tail: Vec<&AgentEvent> = events.iter().rev().take(3).collect();
    assert_eq!(tail, [&AgentEvent::End { session_id: before.clone() }, &AgentEvent::Cancelled, &AgentEvent::Record { record: Record::Stopped }]);
    let ui = thread::to_ui(&thread::load(&dir).unwrap());
    let last = ui.last().unwrap();
    assert_eq!((last.text.as_str(), last.records.clone()), ("Partial", vec![Record::Stopped]));
    assert_eq!(vault::read_session(&dir), before);

    // Clear asks Claude Code (one call, no tools, nothing kept) for the details, then removes it all.
    let model = study::model::for_space(&f.vault, &dir, None).unwrap();
    let out = tauri::async_runtime::block_on(memory::clear(&dir, "current", Ok(&model))).unwrap();
    assert_eq!(out, memory::ClearOutcome::Cleared { kept: vec!["Test 1 for C241 is on Thursday.".into()] });
    let n = f.run();
    assert!(f.args(n).iter().any(|a| a == "--no-session-persistence") && f.stdin(n).contains("User: When is Test 1?"));
    assert!(thread::load(&dir).unwrap().is_empty());
    assert_eq!(vault::read_session(&dir), None);
    assert!(fs::read_to_string(dir.join("MEMORY.md")).unwrap().contains("Test 1 for C241 is on Thursday."));

    fs::remove_dir_all(&root).unwrap();
}
