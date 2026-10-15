use super::*;

const FULL: &str = "11111111-1111-4111-8111-111111111111";
const TOOL_ONLY: &str = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE: &str = "33333333-3333-4333-8333-333333333333";
const KNOWN: &str = "44444444-4444-4444-8444-444444444444";
const WRAPPED: &str = "55555555-5555-4555-8555-555555555555";
const ALL: [&str; 5] = [FULL, TOOL_ONLY, ELSEWHERE, KNOWN, WRAPPED];

fn fixture(id: &str) -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-transcripts");
    fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap()
}

/// A vault with a School space, and a Claude Code folder whose transcripts for it are `ids`.
struct Setup {
    root: PathBuf,
    space: PathBuf,
    home: PathBuf,
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn setup(tag: &str, ids: &[&str]) -> Setup {
    let root = std::env::temp_dir().join(format!("phaethon-cli-import-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("vault/spaces/school")).unwrap();
    let space = root.join("vault/spaces/school").canonicalize().unwrap();
    let home = root.join("claude");
    let project = home.join("projects").join(project_dir_name(&space));
    fs::create_dir_all(&project).unwrap();
    for id in ids {
        let text = fixture(id).replace("@SPACE@", space.to_str().unwrap());
        fs::write(project.join(format!("{id}.jsonl")), text).unwrap();
    }
    Setup { root, space, home }
}

fn project(s: &Setup) -> PathBuf {
    s.home.join("projects").join(project_dir_name(&s.space))
}

fn texts(m: &Value) -> Vec<&str> {
    m["content"].as_array().unwrap().iter().filter(|b| b["type"] == "text").map(|b| b["text"].as_str().unwrap()).collect()
}

#[test]
fn the_folder_name_is_claude_codes() {
    assert_eq!(project_dir_name(Path::new("/Users/jeryn/Phaethon/default/spaces/school")), "-Users-jeryn-Phaethon-default-spaces-school");
    assert_eq!(project_dir_name(Path::new("/a b/c_d.e/ü")), "-a-b-c-d-e--");
}

#[test]
fn times_keep_their_milliseconds() {
    assert_eq!(time_ms(&json!("2026-10-10T00:05:56.945Z")), Some(1_791_590_756_945));
    assert_eq!(time_ms(&json!("2026-10-10T00:05:56Z")), Some(1_791_590_756_000));
    assert_eq!(time_ms(&json!("2026-10-10T00:05:56.9Z")), Some(1_791_590_756_900));
    assert_eq!(time_ms(&json!("yesterday")), None);
    assert_eq!(time_ms(&json!(12)), None);
}

#[test]
fn a_transcript_is_read_as_the_users_words_and_the_replies_text_in_order() {
    let s = setup("read", &[FULL]);
    let t = read(&project(&s).join(format!("{FULL}.jsonl")), &s.space).expect("a conversation");
    assert_eq!(t.session, FULL);
    // The summary whose leaf is in this transcript, not the one for another branch.
    assert_eq!(t.title.as_deref(), Some("C241 Test 1 date and scope"));
    let roles: Vec<&str> = t.messages.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "user", "assistant"]);
    assert_eq!(texts(&t.messages[0]), ["When is Test 1?"]);
    // The reply's parts around the tool call, once each (the line written twice is read once);
    // thinking, the tool call and its result are left out.
    assert_eq!(texts(&t.messages[1]), ["Let me check the syllabus.", "Test 1 is on **Thursday, Oct 15** at 10:00.\n\n- Bring a pencil"]);
    // The meta caveat, the slash command, the subagent's line and the image are not the user's words.
    assert_eq!(texts(&t.messages[2]), ["And what does it cover?  Sets, functions, “relations”?"]);
    // The synthetic API error is not a reply.
    assert_eq!(texts(&t.messages[3]), ["Sets, functions and relations — chapters 1–3."]);
    assert_eq!(t.messages[0]["at"], 1_791_590_756_945u64);
    assert_eq!(t.messages[1]["at"], 1_791_590_765_500u64, "a reply's time is when it finished");
    assert_eq!(t.messages[2]["at"], 1_791_590_880_000u64);
    assert_eq!(t.last_at, Some(1_791_590_889_000));
    let raw = serde_json::to_string(&t.messages).unwrap();
    for left_out in ["thinking", "tool_use", "tool_result", "syllabus.md", "subagent", "API Error", "/cost", "Caveat", "iVBOR"] {
        assert!(!raw.contains(left_out), "{left_out} was brought in");
    }
}

#[test]
fn sessions_with_nothing_the_user_wrote_or_from_another_folder_are_not_conversations() {
    let s = setup("skip", &[TOOL_ONLY, ELSEWHERE]);
    assert_eq!(read(&project(&s).join(format!("{TOOL_ONLY}.jsonl")), &s.space), None, "commands and tool results only");
    assert_eq!(read(&project(&s).join(format!("{ELSEWHERE}.jsonl")), &s.space), None, "a folder that shares the name");
    // Not a session's file, or not a transcript at all.
    fs::write(project(&s).join("notes.jsonl"), fixture(KNOWN).replace("@SPACE@", s.space.to_str().unwrap())).unwrap();
    assert_eq!(read(&project(&s).join("notes.jsonl"), &s.space), None);
    fs::write(project(&s).join(format!("{KNOWN}.txt")), "x").unwrap();
    assert!(!transcripts(&s.home, &s.space).iter().any(|p| p.extension().is_some_and(|x| x == "txt")));
    assert_eq!(import(&s.space, &s.home).unwrap(), Vec::<String>::new());
    assert!(!s.space.join(".phaethon/threads").exists() || fs::read_dir(s.space.join(".phaethon/threads")).unwrap().next().is_none());
}

#[test]
fn a_fresh_sessions_prompt_keeps_only_the_users_new_words() {
    let s = setup("wrapped", &[WRAPPED]);
    let t = read(&project(&s).join(format!("{WRAPPED}.jsonl")), &s.space).expect("a conversation in a folder inside the space");
    assert_eq!(texts(&t.messages[0]), ["Move the essay to Friday"]);
    assert_eq!(t.title, None, "a summary of another session's branch is not this one's title");
}

#[test]
fn unreadable_lines_are_skipped_never_the_file() {
    let s = setup("bytes", &[KNOWN]);
    let path = project(&s).join(format!("{KNOWN}.jsonl"));
    let mut raw = b"\xff\xfe not utf-8\n{\"type\":\n".to_vec();
    raw.extend(fs::read(&path).unwrap());
    raw.extend(b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":42}}\n{\"type\":\"assistant\"}\n");
    fs::write(&path, raw).unwrap();
    let t = read(&path, &s.space).unwrap();
    assert_eq!(t.messages.len(), 2);
    assert_eq!(texts(&t.messages[1]), ["Hi! What do you need?"]);
}

#[test]
fn import_brings_in_each_unknown_conversation_once_resumable_and_dated() {
    let s = setup("import", &ALL);
    // The current conversation's session is Claude Code's 4444; a past one's is Codex's.
    thread::save(&s.space, &[thread::user_text("hi"), json!({"role": "assistant", "content": [{"type": "text", "text": "Hi! What do you need?"}]})]).unwrap();
    crate::vault::write_session(&s.space, KNOWN).unwrap();
    let before = fs::read(s.space.join(".phaethon/thread.json")).unwrap();
    fs::create_dir_all(s.space.join(".phaethon/threads")).unwrap();
    fs::write(s.space.join(".phaethon/threads/1.session"), "codex:01a12cac-8974-7110-be05-b08f8161e7fa\n").unwrap();

    let titles = import(&s.space, &s.home).unwrap();
    assert_eq!(titles, ["Move the essay to Friday", "C241 Test 1 date and scope"], "oldest first");
    // Nothing about the current conversation changed.
    assert_eq!(fs::read(s.space.join(".phaethon/thread.json")).unwrap(), before);
    assert_eq!(crate::vault::read_session(&s.space).as_deref(), Some(KNOWN));

    let list = thread::list(&s.space).unwrap();
    assert_eq!(list.len(), 3);
    let full = list.iter().find(|t| t.title == "C241 Test 1 date and scope").expect("listed by Claude Code's title");
    assert_eq!((full.messages, full.current), (4, false));
    assert_eq!(full.updated, 1_791_590_889_000, "dated when it was last used");
    let wrapped = list.iter().find(|t| t.title == "Move the essay to Friday").expect("listed by its first words");
    assert!(full.updated > wrapped.updated && list[1].id == full.id, "in time order");

    // Shown as it was said; the record of where it came from is never shown or sent.
    let msgs = thread::load_id(&s.space, &full.id).unwrap();
    let ui = thread::to_ui(&msgs);
    assert_eq!(ui.len(), 4);
    assert_eq!(ui[1].text, "Let me check the syllabus.\n\nTest 1 is on **Thursday, Oct 15** at 10:00.\n\n- Bring a pencil");
    assert!(ui.iter().all(|m| m.records.is_empty()));
    assert!(!serde_json::to_string(&thread::for_provider(&msgs)).unwrap().contains(RECORD_KIND));
    assert_eq!(thread::key(&msgs).as_deref(), Some("1791590756945"));

    // Opening it resumes its own Claude Code session; the one it replaced keeps its own.
    thread::open(&s.space, &full.id).unwrap();
    assert_eq!(crate::vault::read_session(&s.space).as_deref(), Some(FULL));
    assert!(known_sessions(&s.space).contains(KNOWN));

    // Again: nothing new.
    assert_eq!(import(&s.space, &s.home).unwrap(), Vec::<String>::new());
    assert_eq!(thread::list(&s.space).unwrap().len(), 3);
}

const RECORD_KIND: &str = "phaethon_record";

#[test]
fn a_deleted_conversation_never_comes_back() {
    let s = setup("deleted", &[FULL, KNOWN]);
    // 4444 was had in Phaethon (its session is the current one's), then deleted.
    thread::save(&s.space, &[thread::user_text("hi")]).unwrap();
    crate::vault::write_session(&s.space, KNOWN).unwrap();
    thread::delete(&s.space, thread::CURRENT_ID).unwrap();
    assert_eq!(import(&s.space, &s.home).unwrap(), ["C241 Test 1 date and scope"]);
    // The one brought in, deleted too.
    let id = thread::list(&s.space).unwrap().into_iter().find(|t| !t.current).unwrap().id;
    thread::delete(&s.space, &id).unwrap();
    assert_eq!(import(&s.space, &s.home).unwrap(), Vec::<String>::new());
    assert_eq!(thread::list(&s.space).unwrap().len(), 1);
}

#[test]
fn a_launch_looks_once_per_space() {
    let s = setup("once", &[FULL]);
    assert_eq!(import_once(&s.space, &s.home).unwrap(), Some(vec!["C241 Test 1 date and scope".to_string()]));
    // A transcript that appears later is left to the menu.
    fs::write(project(&s).join(format!("{WRAPPED}.jsonl")), fixture(WRAPPED).replace("@SPACE@", s.space.to_str().unwrap())).unwrap();
    assert_eq!(import_once(&s.space, &s.home).unwrap(), None);
    assert_eq!(import(&s.space, &s.home).unwrap(), ["Move the essay to Friday"]);
    assert_eq!(thread::list(&s.space).unwrap().len(), 3);
}

#[test]
fn the_ledger_alone_is_enough_and_a_lost_ledger_still_never_duplicates() {
    let s = setup("ledger", &[FULL]);
    import(&s.space, &s.home).unwrap();
    // Without the ledger, the conversation's own session file and record still say it is known.
    fs::remove_file(s.space.join(".phaethon/cli-import.json")).unwrap();
    assert_eq!(import(&s.space, &s.home).unwrap(), Vec::<String>::new());
    for e in fs::read_dir(s.space.join(".phaethon/threads")).unwrap().flatten() {
        if e.path().extension().is_some_and(|x| x == "session") {
            fs::remove_file(e.path()).unwrap();
        }
    }
    assert_eq!(import(&s.space, &s.home).unwrap(), Vec::<String>::new(), "the record names the session too");
    assert_eq!(thread::list(&s.space).unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn links_are_never_followed() {
    let s = setup("links", &[]);
    let outside = s.root.join("outside.jsonl");
    fs::write(&outside, fixture(KNOWN).replace("@SPACE@", s.space.to_str().unwrap())).unwrap();
    std::os::unix::fs::symlink(&outside, project(&s).join(format!("{KNOWN}.jsonl"))).unwrap();
    assert!(transcripts(&s.home, &s.space).is_empty());
    assert!(!offered(&s.space, Some(&s.home), false));
    assert!(offered(&s.space, Some(&s.home), true), "offered whenever Claude Code answers");
}

#[test]
fn offered_when_claude_code_kept_transcripts_here() {
    let s = setup("offered", &[KNOWN]);
    assert!(offered(&s.space, Some(&s.home), false));
    assert!(!offered(&s.space, None, false));
}
