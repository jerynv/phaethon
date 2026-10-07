//! A space's conversation, stored as a plain JSON file in the space:
//! `<space>/.phaethon/thread.json`, a list of messages in the Messages API shape
//! (`{"role": ..., "content": [blocks]}`).
//!
//! The history is append-only: blocks the model returned (thinking blocks
//! included) are saved and sent back exactly as received, because editing
//! earlier turns invalidates them.
//!
//! A space can have many conversations. `thread.json` is always the current
//! one; the others are kept whole in `<space>/.phaethon/threads/<id>.json`
//! (see [`start_new`] and [`open`]).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

use crate::agent::Runs;
use crate::attachments::is_attachment_ref;
use crate::tools::STATE_DIR;

fn file(space: &Path) -> PathBuf {
    space.join(STATE_DIR).join("thread.json")
}

/// The saved messages, or none if there is no thread yet. A file that is not a
/// list of messages is an error, never silently replaced: it is the user's data.
pub fn load(space: &Path) -> io::Result<Vec<Value>> {
    let raw = match fs::read_to_string(file(space)) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| io::Error::other(format!("thread.json is not valid JSON: {e}")))?;
    match v {
        Value::Array(msgs) if msgs.iter().all(is_message) => Ok(msgs),
        _ => Err(io::Error::other("thread.json is not a list of messages")),
    }
}

fn is_message(m: &Value) -> bool {
    matches!(m["role"].as_str(), Some("user" | "assistant")) && m["content"].is_array()
}

/// Write the whole thread. Goes through a temporary file and a rename, so a
/// crash mid-write never leaves half a file.
pub fn save(space: &Path, msgs: &[Value]) -> io::Result<()> {
    let path = file(space);
    fs::create_dir_all(path.parent().expect("thread file has a parent"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(msgs)?)?;
    fs::rename(&tmp, &path)
}

pub fn user_text(text: &str) -> Value {
    user_message(text, &[])
}

/// A user message: attachments first (the model reads them before the
/// question), then the text.
pub fn user_message(text: &str, attachments: &[Value]) -> Value {
    let mut content: Vec<Value> = attachments.to_vec();
    if !text.trim().is_empty() || content.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    json!({"role": "user", "content": content})
}

/// One message as the UI shows it after a reload.
#[derive(Debug, Serialize, PartialEq)]
pub struct UiMessage {
    pub role: &'static str,
    pub text: String,
    /// Files the user attached, as saved in the space.
    pub attachments: Vec<UiAttachment>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiAttachment {
    pub name: String,
    pub path: String,
    pub media_type: String,
}

/// The thread as the UI shows it: user text, and each assistant reply as one
/// message even when it spans several model turns around tool calls. Tool
/// results and thinking are not shown.
pub fn to_ui(msgs: &[Value]) -> Vec<UiMessage> {
    let mut out: Vec<UiMessage> = vec![];
    for m in msgs {
        let texts: Vec<&str> = m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !t.trim().is_empty())
            .collect();
        let files: Vec<UiAttachment> = m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| is_attachment_ref(b))
            .map(|b| UiAttachment {
                name: b["name"].as_str().unwrap_or("").into(),
                path: b["path"].as_str().unwrap_or("").into(),
                media_type: b["media_type"].as_str().unwrap_or("").into(),
            })
            .collect();
        match m["role"].as_str() {
            Some("user") if !texts.is_empty() || !files.is_empty() => out.push(UiMessage {
                role: "user",
                text: texts.join("\n\n"),
                attachments: files,
            }),
            Some("assistant") if !texts.is_empty() => {
                let joined = texts.join("\n\n");
                match out.last_mut() {
                    Some(last) if last.role == "assistant" => {
                        last.text.push_str("\n\n");
                        last.text.push_str(&joined);
                    }
                    _ => out.push(UiMessage {
                        role: "assistant",
                        text: joined,
                        attachments: vec![],
                    }),
                }
            }
            _ => {}
        }
    }
    out
}

// ---- Conversations ------------------------------------------------------
//
// Starting a new conversation, or reopening an old one, moves the current
// file (if it has messages) to `threads/<id>.json` by rename: nothing is
// rewritten or deleted, so no conversation is ever lost. The id is the archive
// time in milliseconds since the epoch (13 digits, so it sorts), with `-<n>`
// added in the rare case two are archived in the same millisecond.

/// The id `list` gives the current conversation.
pub const CURRENT_ID: &str = "current";

/// Said when a reply is running in the space: switching conversations then
/// would pull the file out from under it.
pub const BUSY: &str =
    "Phaethon is still replying in this space. Stop the reply or wait for it to finish, then try again.";

const TITLE_CHARS: usize = 60;

fn archive_dir(space: &Path) -> PathBuf {
    space.join(STATE_DIR).join("threads")
}

/// An archive id as this module makes them: digits, optionally `-` and more
/// digits. Anything else (`..`, slashes, a name with an extension) is refused
/// before it is joined to a path.
pub fn is_valid_id(id: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit());
    let mut parts = id.splitn(2, '-');
    parts.next().is_some_and(digits) && parts.next().is_none_or(digits)
}

fn archived(space: &Path, id: &str) -> PathBuf {
    archive_dir(space).join(format!("{id}.json"))
}

fn is_regular_file(path: &Path) -> bool {
    // symlink_metadata: a link is never followed, so nothing outside the space is read or moved.
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// One conversation in the space's list.
#[derive(Debug, Serialize, PartialEq)]
pub struct ThreadSummary {
    /// `"current"` for the current conversation, else its archive id.
    pub id: String,
    /// The first thing the user said, shortened; "New conversation" if nothing yet.
    pub title: String,
    /// When the file was last written, in milliseconds since the epoch.
    pub updated: u64,
    /// Messages as the UI shows them (user messages plus whole replies).
    pub messages: usize,
    pub current: bool,
}

fn title_of(msgs: &[UiMessage]) -> String {
    let first = msgs.iter().find(|m| m.role == "user");
    let text = first
        .map(|m| m.text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty())
        .or_else(|| first.and_then(|m| m.attachments.first()).map(|a| a.name.clone()));
    match text {
        None => "New conversation".into(),
        Some(t) if t.chars().count() > TITLE_CHARS => {
            let cut: String = t.chars().take(TITLE_CHARS - 1).collect();
            format!("{}…", cut.trim_end())
        }
        Some(t) => t,
    }
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn read_messages(path: &Path) -> io::Result<Vec<Value>> {
    let v: Value = serde_json::from_str(&fs::read_to_string(path)?).map_err(io::Error::other)?;
    match v {
        Value::Array(msgs) if msgs.iter().all(is_message) => Ok(msgs),
        _ => Err(io::Error::other("not a list of messages")),
    }
}

fn summary(path: &Path, id: String, current: bool) -> ThreadSummary {
    let (title, messages) = match read_messages(path) {
        Ok(msgs) => {
            let ui = to_ui(&msgs);
            (title_of(&ui), ui.len())
        }
        // Listed anyway: the file is the user's, and opening it shows why it can't be read.
        Err(_) => ("A conversation that couldn’t be read".into(), 0),
    };
    ThreadSummary { id, title, updated: mtime_ms(path), messages, current }
}

/// Every conversation in the space: the current one first, then the archived
/// ones, most recently written first. Anything in `threads/` that is not a
/// regular `<id>.json` file is ignored.
pub fn list(space: &Path) -> io::Result<Vec<ThreadSummary>> {
    let cur = file(space);
    let mut out = vec![if cur.exists() {
        summary(&cur, CURRENT_ID.into(), true)
    } else {
        ThreadSummary {
            id: CURRENT_ID.into(),
            title: "New conversation".into(),
            updated: now_ms(),
            messages: 0,
            current: true,
        }
    }];
    let entries = match fs::read_dir(archive_dir(space)) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    let mut rest = vec![];
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
            continue;
        };
        if is_valid_id(id) && is_regular_file(&entry.path()) {
            rest.push(summary(&entry.path(), id.to_string(), false));
        }
    }
    rest.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.id.cmp(&a.id)));
    out.extend(rest);
    Ok(out)
}

/// Whether the current conversation has anything worth keeping. A file that
/// can't be read counts: it is moved aside, never deleted.
fn current_has_content(space: &Path) -> bool {
    match fs::read_to_string(file(space)) {
        Err(e) => e.kind() != io::ErrorKind::NotFound,
        Ok(raw) => !matches!(serde_json::from_str::<Value>(&raw), Ok(Value::Array(a)) if a.is_empty()),
    }
}

/// Move the current conversation into the archive, if it has messages, and
/// return the id it was given. An empty current file (`[]`) is removed.
fn archive_current(space: &Path) -> io::Result<Option<String>> {
    let cur = file(space);
    if !current_has_content(space) {
        return match fs::remove_file(&cur) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(None),
        };
    }
    fs::create_dir_all(archive_dir(space))?;
    let base = now_ms();
    let id = (0..1000)
        .map(|n| if n == 0 { base.to_string() } else { format!("{base}-{n}") })
        .find(|id| fs::symlink_metadata(archived(space, id)).is_err())
        .ok_or_else(|| io::Error::other("no free name in the conversation archive"))?;
    fs::rename(&cur, archived(space, &id))?;
    Ok(Some(id))
}

/// Start a new, empty conversation, keeping the current one in the archive.
pub fn start_new(space: &Path) -> io::Result<()> {
    archive_current(space).map(|_| ())
}

/// Make the archived conversation `id` current, archiving the current one
/// first. `"current"` changes nothing.
pub fn open(space: &Path, id: &str) -> io::Result<()> {
    if id == CURRENT_ID {
        return Ok(());
    }
    if !is_valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a conversation id"));
    }
    let chosen = archived(space, id);
    if !is_regular_file(&chosen) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "that conversation is no longer there"));
    }
    let moved = archive_current(space)?;
    if let Err(e) = fs::rename(&chosen, file(space)) {
        // Put the current one back, so a failed open leaves everything where it was.
        if let Some(back) = moved {
            let _ = fs::rename(archived(space, &back), file(space));
        }
        return Err(e);
    }
    Ok(())
}

/// Run `f` with the space marked busy, so no reply can start while the files
/// move. Refused with [`BUSY`] if a reply is already running there.
pub fn while_idle<T>(runs: &Runs, space_id: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    struct Release<'a>(&'a Runs, &'a str);
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            self.0.release(self.1);
        }
    }
    if runs.claim(space_id).is_none() {
        return Err(BUSY.into());
    }
    let _release = Release(runs, space_id);
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_space(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-threads-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chat(q: &str, a: &str) -> Vec<Value> {
        vec![user_text(q), json!({"role": "assistant", "content": [{"type": "text", "text": a}]})]
    }

    fn archive_files(space: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(archive_dir(space))
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn new_archives_a_conversation_with_messages_and_starts_empty() {
        let dir = temp_space("new");
        // Nothing yet: a new conversation is a no-op and archives nothing.
        start_new(&dir).unwrap();
        assert!(archive_files(&dir).is_empty());
        let first = chat("When is Test 1?", "Thursday.");
        save(&dir, &first).unwrap();
        start_new(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        let files = archive_files(&dir);
        assert_eq!(files.len(), 1);
        let id = files[0].strip_suffix(".json").unwrap();
        assert!(is_valid_id(id), "{id}");
        assert_eq!(read_messages(&archived(&dir, id)).unwrap(), first);
        // An empty current conversation is not archived again.
        save(&dir, &[]).unwrap();
        start_new(&dir).unwrap();
        assert_eq!(archive_files(&dir).len(), 1);
        assert!(!file(&dir).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_puts_current_first_then_newest_and_titles_them() {
        let dir = temp_space("list");
        assert_eq!(
            list(&dir).unwrap(),
            vec![ThreadSummary {
                id: "current".into(),
                title: "New conversation".into(),
                updated: list(&dir).unwrap()[0].updated,
                messages: 0,
                current: true,
            }]
        );
        let long = "Plan my week around Test 1 and the problem set, and leave Friday evening free please";
        save(&dir, &chat(long, "Here is a plan.")).unwrap();
        start_new(&dir).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        save(&dir, &chat("  What is   due\nthis week? ", "Problem set 4.")).unwrap();
        start_new(&dir).unwrap();
        save(&dir, &chat("Third", "Yes.")).unwrap();
        let l = list(&dir).unwrap();
        assert_eq!(l.len(), 3);
        assert!(l[0].current && l[0].id == "current" && l[0].title == "Third" && l[0].messages == 2);
        assert_eq!(l[1].title, "What is due this week?");
        assert!(!l[1].current);
        assert!(l[2].title.ends_with('…') && l[2].title.chars().count() <= TITLE_CHARS, "{}", l[2].title);
        assert!(l[1].updated >= l[2].updated);
        // Stray files in the archive are not listed.
        fs::write(archive_dir(&dir).join("notes.txt"), "x").unwrap();
        fs::write(archive_dir(&dir).join("..json"), "[]").unwrap();
        fs::write(archive_dir(&dir).join("12.json.tmp"), "[]").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 3);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_round_trips_without_losing_anything() {
        let dir = temp_space("open");
        let a = chat("first", "one");
        let b = chat("second", "two");
        save(&dir, &a).unwrap();
        start_new(&dir).unwrap();
        save(&dir, &b).unwrap();
        let a_id = list(&dir).unwrap()[1].id.clone();
        open(&dir, &a_id).unwrap();
        assert_eq!(load(&dir).unwrap(), a);
        // b went to the archive, and a's old archive file is gone (it is current now).
        let l = list(&dir).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[1].title, "second");
        assert!(!archived(&dir, &a_id).exists());
        // And back again.
        open(&dir, &l[1].id).unwrap();
        assert_eq!(load(&dir).unwrap(), b);
        assert_eq!(list(&dir).unwrap()[1].title, "first");
        // Opening "current" changes nothing; a missing id is an error and changes nothing.
        open(&dir, "current").unwrap();
        assert!(open(&dir, "1234567890123").is_err());
        assert_eq!(load(&dir).unwrap(), b);
        assert_eq!(archive_files(&dir).len(), 1);
        // From an empty current conversation, opening one archives nothing extra.
        start_new(&dir).unwrap();
        let ids: Vec<String> = list(&dir).unwrap()[1..].iter().map(|t| t.id.clone()).collect();
        open(&dir, &ids[0]).unwrap();
        assert_eq!(archive_files(&dir).len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_current_is_moved_aside_not_deleted() {
        let dir = temp_space("corrupt");
        fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        fs::write(file(&dir), "{ half a file").unwrap();
        assert!(load(&dir).is_err());
        assert_eq!(list(&dir).unwrap()[0].title, "A conversation that couldn’t be read");
        start_new(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        let files = archive_files(&dir);
        assert_eq!(files.len(), 1);
        assert_eq!(fs::read_to_string(archive_dir(&dir).join(&files[0])).unwrap(), "{ half a file");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_with_path_tricks_are_refused() {
        for bad in ["", "..", "../thread", "../../etc/passwd", "1/2", "1\\2", "12.json", "-1", "1-", "1-2-3", "a1", " 1", "1 ", "current/..", "１２"] {
            assert!(!is_valid_id(bad), "{bad:?} should be refused");
        }
        for good in ["1760000000000", "1760000000000-2"] {
            assert!(is_valid_id(good));
        }
        let dir = temp_space("escape");
        save(&dir, &chat("keep me", "kept")).unwrap();
        // A file the user (or anyone) put outside the archive is not reachable.
        fs::write(dir.join("secret.json"), serde_json::to_vec(&chat("secret", "s")).unwrap()).unwrap();
        for bad in ["../../secret", "../secret", "..", "/etc/passwd"] {
            assert_eq!(open(&dir, bad).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{bad}");
        }
        assert_eq!(load(&dir).unwrap(), chat("keep me", "kept"));
        // A symlink in the archive is neither listed nor opened.
        #[cfg(unix)]
        {
            fs::create_dir_all(archive_dir(&dir)).unwrap();
            std::os::unix::fs::symlink(dir.join("secret.json"), archived(&dir, "1700000000000")).unwrap();
            assert_eq!(list(&dir).unwrap().len(), 1);
            assert_eq!(open(&dir, "1700000000000").unwrap_err().kind(), io::ErrorKind::NotFound);
            assert_eq!(load(&dir).unwrap(), chat("keep me", "kept"));
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn busy_space_refuses_and_idle_space_is_released() {
        let runs = Runs::default();
        let _turn = runs.claim("school").unwrap();
        assert_eq!(while_idle(&runs, "school", || Ok(1)), Err(BUSY.to_string()));
        // Another space is not affected, and is free again afterwards (even after an error).
        assert_eq!(while_idle(&runs, "work", || Ok(2)), Ok(2));
        assert_eq!(while_idle::<()>(&runs, "work", || Err("no".into())), Err("no".to_string()));
        assert!(runs.claim("work").is_some());
        runs.release("school");
        assert_eq!(while_idle(&runs, "school", || Ok(3)), Ok(3));
    }

    #[test]
    fn round_trip_and_ui_view() {
        let dir = std::env::temp_dir().join(format!("phaethon-thread-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        let msgs = vec![
            user_text("what's in notes?"),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "t1", "name": "list_files", "input": {}}
            ]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.md"}]}),
            json!({"role": "assistant", "content": [{"type": "text", "text": "There is a.md."}]}),
        ];
        save(&dir, &msgs).unwrap();
        assert_eq!(load(&dir).unwrap(), msgs);
        assert_eq!(
            to_ui(&msgs),
            vec![
                UiMessage { role: "user", text: "what's in notes?".into(), attachments: vec![] },
                UiMessage { role: "assistant", text: "Let me look.\n\nThere is a.md.".into(), attachments: vec![] },
            ]
        );
        fs::write(file(&dir), "{\"not\": \"a list\"}").unwrap();
        assert!(load(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
