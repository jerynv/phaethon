//! Bringing in conversations Claude Code had in a space before Phaethon kept
//! them. Until conversations with Claude Code were recorded in the space's
//! thread, only Claude Code kept them, in its own transcripts:
//! `<claude config>/projects/<the space's folder, every character but a
//! letter or digit made '-'>/<session>.jsonl`. Each transcript Phaethon
//! doesn't already know becomes a past conversation in the space's archive,
//! with its session beside it, so reopening it resumes the same session.
//!
//! Only those transcript files are read (the user's own chat, in the folder
//! Claude Code keeps for this space); nothing else in Claude Code's folder,
//! and never a credential. The format is Claude Code's own and undocumented,
//! so it is read defensively: the user's words and the text of each reply, in
//! order, with their times. Tool calls and results, thinking, and every line
//! of a kind not known here are left out, and a line that can't be read is
//! skipped, never the whole file.
//!
//! What was brought in, and every session Phaethon has let go of (a deleted
//! conversation's), is noted in `<space>/.phaethon/cli-import.json`, so a
//! conversation is never brought in twice or brought back after a delete.

use std::collections::HashSet;
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::thread::{self, Record};
use crate::tools::STATE_DIR;

/// The record's name for Claude Code.
pub const FROM_CLAUDE_CODE: &str = "claude-code";

/// A transcript larger than this is not read (a real one is a few hundred KB).
const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;

/// What Phaethon prefixes the user's message with when a fresh session starts
/// on a conversation that already has messages (agent.rs `cli_prompt`): the
/// user's own words follow this.
const NEW_MESSAGE_MARK: &str = "\n\nThe user's new message:\n\n";
const HISTORY_INTRO_START: &str = "This conversation began before this session";

/// Claude Code's folder: the vault's own when it isolates the CLI's setup,
/// else `CLAUDE_CONFIG_DIR` as the CLI inherits it, else `~/.claude`.
pub fn claude_home(isolated: Option<PathBuf>) -> Option<PathBuf> {
    isolated
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from))
        .or_else(|| crate::vault::home_dir().map(|h| h.join(".claude")))
}

/// Claude Code's name for a working folder's transcripts: the path with every
/// character that is not an ASCII letter or digit made `-`.
pub fn project_dir_name(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Claude Code cuts very long folder names and adds a hash; those are matched by their start.
const LONG_NAME: usize = 200;

/// The transcript files Claude Code kept for `space`, oldest name first.
/// Only regular `*.jsonl` files directly in the matching folders are listed;
/// links are never followed.
pub fn transcripts(home: &Path, space: &Path) -> Vec<PathBuf> {
    let projects = home.join("projects");
    let mut names: Vec<String> = vec![project_dir_name(space)];
    if let Ok(real) = space.canonicalize() {
        names.push(project_dir_name(&real));
    }
    names.dedup();
    let mut dirs: Vec<PathBuf> = vec![];
    for name in &names {
        if name.len() > LONG_NAME {
            let start = &name[..LONG_NAME];
            if let Ok(entries) = fs::read_dir(&projects) {
                dirs.extend(
                    entries
                        .flatten()
                        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(start)))
                        .map(|e| e.path()),
                );
            }
        } else {
            dirs.push(projects.join(name));
        }
    }
    let mut out: Vec<PathBuf> = vec![];
    for dir in dirs {
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let regular = fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_file() && m.len() <= MAX_TRANSCRIPT_BYTES);
            if regular && p.extension().is_some_and(|x| x == "jsonl") && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// One transcript, read.
#[derive(Debug, PartialEq)]
pub struct Transcript {
    pub session: String,
    /// The title Claude Code gave it, if it gave one.
    pub title: Option<String>,
    /// In the thread's shape: user and assistant messages with text blocks and times.
    pub messages: Vec<Value>,
    /// When it was last written to, in milliseconds since the epoch.
    pub last_at: Option<u64>,
}

/// Milliseconds since the epoch for a transcript's `timestamp`.
fn time_ms(v: &Value) -> Option<u64> {
    let s = v.as_str()?;
    let secs = crate::lms::store::parse_time(s)?;
    let ms = s
        .split_once('.')
        .map(|(_, f)| f.bytes().take_while(u8::is_ascii_digit).take(3).fold((0u64, 0), |(n, k), b| (n * 10 + u64::from(b - b'0'), k + 1)))
        .map_or(0, |(n, k)| n * 10u64.pow(3 - k));
    u64::try_from(secs).ok().map(|s| s * 1000 + ms)
}

/// Whether a user line's text is something Claude Code wrote, not the user:
/// a slash command and its output, a reminder, an interruption note.
fn is_cli_text(t: &str) -> bool {
    let t = t.trim_start();
    [
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<bash-input>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<system-reminder>",
        "<user-prompt-submit-hook>",
        "[Request interrupted by user",
        "Caveat: The messages below were generated by the user while running local commands",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

/// The user's own words in a prompt Phaethon sent: a fresh session given the
/// conversation so far carries the new message after it.
fn own_words(t: &str) -> &str {
    if t.starts_with(HISTORY_INTRO_START)
        && let Some((_, after)) = t.rsplit_once(NEW_MESSAGE_MARK)
    {
        return after;
    }
    t
}

/// The text of a message's content: a string, or its text blocks in order.
fn content_texts(content: &Value) -> Vec<String> {
    match content {
        Value::String(s) => vec![s.clone()],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .map(str::to_string)
            .collect(),
        _ => vec![],
    }
}

/// Whether `cwd` is the space's folder or one inside it.
fn in_space(cwd: &str, space: &Path) -> bool {
    let cwd = Path::new(cwd);
    let real = space.canonicalize().ok();
    cwd.starts_with(space) || real.is_some_and(|r| cwd.starts_with(&r) || cwd.canonicalize().is_ok_and(|c| c.starts_with(&r)))
}

/// Read one transcript as a conversation in `space`. `None` when it isn't
/// one to bring in: not a session's file, from another folder that happens to
/// share its name, or with nothing the user wrote.
pub fn read(path: &Path, space: &Path) -> Option<Transcript> {
    let session = path.file_stem()?.to_str()?.to_string();
    if !is_uuid(&session) {
        return None;
    }
    let mut reader = BufReader::new(fs::File::open(path).ok()?);
    let mut seen: HashSet<String> = HashSet::new();
    let mut uuids: HashSet<String> = HashSet::new();
    // Claude Code's titles: a summary names the branch ending at its leaf, which may be another session's.
    let mut summaries: Vec<(Option<String>, String)> = vec![];
    let mut custom_title: Option<String> = None;
    let mut cwd_checked = false;
    let mut messages: Vec<Value> = vec![];
    let mut last_at: Option<u64> = None;
    let mut buf: Vec<u8> = vec![];
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let Ok(line) = std::str::from_utf8(&buf) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if !v.is_object() {
            continue;
        }
        if let Some(id) = v["uuid"].as_str() {
            if !seen.insert(id.to_string()) {
                continue; // the same line written twice
            }
            uuids.insert(id.to_string());
        }
        if v["sessionId"].as_str().is_some_and(|s| s != session) && matches!(v["type"].as_str(), Some("user" | "assistant")) {
            continue; // a line of another session's
        }
        if !cwd_checked && let Some(cwd) = v["cwd"].as_str() {
            if !in_space(cwd, space) {
                return None;
            }
            cwd_checked = true;
        }
        let at = time_ms(&v["timestamp"]);
        if at.is_some() {
            last_at = last_at.max(at);
        }
        match v["type"].as_str() {
            Some("summary") => {
                if let Some(s) = v["summary"].as_str() {
                    summaries.push((v["leafUuid"].as_str().map(str::to_string), s.to_string()));
                }
            }
            Some("custom-title") => {
                if let Some(s) = v["customTitle"].as_str() {
                    custom_title = Some(s.to_string());
                }
            }
            Some(role @ ("user" | "assistant")) => {
                let skipped = ["isSidechain", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isApiErrorMessage"]
                    .iter()
                    .any(|k| v[*k] == true)
                    || v["message"]["model"] == "<synthetic>";
                if skipped || v["message"]["role"].as_str().is_some_and(|r| r != role) {
                    continue;
                }
                let texts: Vec<String> = content_texts(&v["message"]["content"])
                    .into_iter()
                    .filter(|t| !(role == "user" && is_cli_text(t)))
                    .map(|t| if role == "user" { own_words(&t).to_string() } else { t })
                    .filter(|t| !t.trim().is_empty())
                    .collect();
                if texts.is_empty() {
                    continue;
                }
                let blocks: Vec<Value> = texts.iter().map(|t| json!({"type": "text", "text": t})).collect();
                match messages.last_mut() {
                    // One user message per turn, and one reply: a reply's parts around tool calls are joined.
                    Some(last) if last["role"] == role => {
                        last["content"].as_array_mut().expect("built with content").extend(blocks);
                        if role == "assistant" && let Some(t) = at {
                            last["at"] = t.into(); // a reply finishes with its last part
                        }
                    }
                    _ => {
                        let mut m = json!({"role": role, "content": blocks});
                        if let Some(t) = at {
                            m["at"] = t.into();
                        }
                        messages.push(m);
                    }
                }
            }
            _ => {}
        }
    }
    if !messages.iter().any(|m| m["role"] == "user") {
        return None;
    }
    let summary = summaries
        .iter()
        .rev()
        .find(|(leaf, _)| leaf.as_ref().is_none_or(|l| uuids.contains(l)))
        .map(|(_, s)| s.clone());
    let title = custom_title.or(summary).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    Some(Transcript { session, title, messages, last_at })
}

/// The transcript as the thread keeps it: its messages, with the record of
/// where it came from on its first reply (or on its own at the end if it has
/// none). The record is never shown and never sent to a model.
pub fn to_thread(t: &Transcript) -> Vec<Value> {
    let mut msgs = t.messages.clone();
    let record = Record::Imported { from: FROM_CLAUDE_CODE.into(), session: t.session.clone(), title: t.title.clone() }.to_block();
    match msgs.iter_mut().find(|m| m["role"] == "assistant") {
        Some(reply) => reply["content"].as_array_mut().expect("built with content").push(record),
        None => msgs.push(json!({"role": "assistant", "content": [record]})),
    }
    msgs
}

// ---- What the space knows ----------------------------------------------

/// `<space>/.phaethon/cli-import.json`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Ledger {
    /// The search ran once on its own (at a launch).
    checked: bool,
    /// Sessions brought in, and sessions of conversations deleted since.
    sessions: Vec<String>,
}

fn ledger_file(space: &Path) -> PathBuf {
    space.join(STATE_DIR).join("cli-import.json")
}

fn load_ledger(space: &Path) -> Ledger {
    fs::read_to_string(ledger_file(space)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_ledger(space: &Path, l: &Ledger) -> io::Result<()> {
    let path = ledger_file(space);
    fs::create_dir_all(path.parent().expect("ledger has a parent"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(l)?)?;
    fs::rename(tmp, path)
}

/// Note a session Phaethon let go of (a conversation deleted), so it is never
/// brought back. A session of another CLI (`codex:<id>`) or anything that
/// isn't a session id is ignored.
pub fn remember(space: &Path, session: &str) {
    if !is_uuid(session) {
        return;
    }
    let mut l = load_ledger(space);
    if !l.sessions.iter().any(|s| s == session) {
        l.sessions.push(session.to_string());
        let _ = save_ledger(space, &l);
    }
}

/// A saved session line as its bare id: `codex:<id>` and the like are another CLI's.
fn session_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    is_uuid(s).then(|| s.to_string())
}

/// Every Claude Code session the space already has: the current
/// conversation's, each past one's, those brought in or let go of, and those
/// named in a conversation's own record.
pub fn known_sessions(space: &Path) -> HashSet<String> {
    let state = space.join(STATE_DIR);
    let mut known: HashSet<String> = load_ledger(space).sessions.into_iter().collect();
    let read_id = |p: &Path| fs::symlink_metadata(p).is_ok_and(|m| m.is_file()).then(|| fs::read_to_string(p).ok()).flatten();
    if let Some(s) = read_id(&state.join("session")).as_deref().and_then(session_id) {
        known.insert(s);
    }
    if let Ok(entries) = fs::read_dir(state.join("threads")) {
        for e in entries.flatten() {
            let p = e.path();
            match p.extension().and_then(|x| x.to_str()) {
                Some("session") => {
                    if let Some(s) = read_id(&p).as_deref().and_then(session_id) {
                        known.insert(s);
                    }
                }
                Some("json") => {
                    if let Some(raw) = read_id(&p)
                        && let Ok(Value::Array(msgs)) = serde_json::from_str::<Value>(&raw)
                    {
                        known.extend(imported_sessions(&msgs));
                    }
                }
                _ => {}
            }
        }
    }
    if let Ok(msgs) = thread::load(space) {
        known.extend(imported_sessions(&msgs));
    }
    known
}

fn imported_sessions(msgs: &[Value]) -> Vec<String> {
    thread::records(msgs)
        .filter_map(|r| match r {
            Record::Imported { session, .. } => Some(session),
            _ => None,
        })
        .collect()
}

/// Whether the Conversations menu offers to look: the vault answers with
/// Claude Code, or Claude Code kept transcripts for this space.
pub fn offered(space: &Path, home: Option<&Path>, claude_answers: bool) -> bool {
    claude_answers || home.is_some_and(|h| !transcripts(h, space).is_empty())
}

/// Bring in every Claude Code conversation for `space` the space doesn't
/// already know, oldest first. Returns their titles as the list shows them.
pub fn import(space: &Path, home: &Path) -> io::Result<Vec<String>> {
    let known = known_sessions(space);
    let mut found: Vec<Transcript> = transcripts(home, space)
        .iter()
        .filter(|p| p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| !known.contains(s)))
        .filter_map(|p| read(p, space))
        .collect();
    found.sort_by_key(|t| t.messages.first().and_then(|m| m["at"].as_u64()).unwrap_or(0));
    let mut titles = vec![];
    for t in &found {
        let msgs = to_thread(t);
        thread::add_archived(space, &msgs, Some(&t.session), t.last_at)?;
        // Noted after it is written: if this fails, the session file beside it still says it is known.
        let mut l = load_ledger(space);
        l.sessions.push(t.session.clone());
        save_ledger(space, &l)?;
        titles.push(t.title.as_deref().map_or_else(|| first_words(&msgs), thread::short_title));
    }
    Ok(titles)
}

fn first_words(msgs: &[Value]) -> String {
    let ui = thread::to_ui(msgs);
    ui.iter().find(|m| m.role == "user").map_or_else(|| "A conversation".into(), |m| thread::short_title(&m.text))
}

/// The search a launch runs: once per space, ever. Later launches leave it
/// to the menu, so nothing the user has since deleted comes back.
pub fn import_once(space: &Path, home: &Path) -> io::Result<Option<Vec<String>>> {
    if load_ledger(space).checked {
        return Ok(None);
    }
    let titles = import(space, home)?;
    let mut l = load_ledger(space);
    l.checked = true;
    save_ledger(space, &l)?;
    Ok(Some(titles))
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests;
