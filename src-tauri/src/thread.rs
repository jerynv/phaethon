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
//!
//! With Claude Code answering, each conversation also has the CLI session it
//! resumes: the current one's in `<space>/.phaethon/session`, a past one's
//! beside it in the archive as `threads/<id>.session`. It moves with its
//! conversation, so reopening one resumes its own session.
//!
//! The thread also holds the conversation's record: what the user allowed or
//! refused, what was read in other spaces, and replies the user stopped. Each
//! is a `{"type": "phaethon_record", "kind": ...}` block appended to the
//! assistant message whose turn produced it, so receipts survive a reload.
//! Record blocks are Phaethon's own and are removed from every request
//! ([`for_provider`]); the model never sees them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::Runs;
use crate::attachments::is_attachment_ref;
use crate::grants::{self, AccessAnswer};
use crate::tools::STATE_DIR;
use crate::vault::session_file;

// ---- The conversation record ----------------------------------------------

pub const RECORD_TYPE: &str = "phaethon_record";

/// Whether a write made a new file or replaced one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteAction {
    Create,
    Replace,
}

/// The read tool behind a [`Record::Read`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadTool {
    Read,
    List,
    Search,
}

/// One entry in the conversation record, as saved and as sent to the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Record {
    /// The user's answer to a write.
    Approval { path: String, action: WriteAction, allowed: bool },
    /// The user's answer to a request to read part of another space.
    Access { space: String, path: String, answer: AccessAnswer },
    /// The agent read, listed or searched in another space.
    Read {
        space: String,
        path: String,
        tool: ReadTool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    /// The user stopped the reply.
    Stopped,
    /// A refusal of access carried over from the part of the conversation an
    /// edit or regenerate replaced (see [`cut_at`]), so the model can't get
    /// past a Deny by asking again in the new version. Counts for [`denied`];
    /// never shown (its receipt is in the archived version where it was given).
    DeniedEarlier { space: String, path: String },
}

impl Record {
    /// The block saved in the thread.
    pub fn to_block(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("records serialize");
        v["type"] = RECORD_TYPE.into();
        v
    }

    /// A saved block back as a record. `None` for anything else, including a
    /// record block someone edited into a shape this version doesn't know.
    pub fn from_block(b: &Value) -> Option<Record> {
        if !is_record(b) {
            return None;
        }
        let mut v = b.clone();
        v.as_object_mut()?.remove("type");
        serde_json::from_value(v).ok()
    }
}

pub fn is_record(b: &Value) -> bool {
    b["type"] == RECORD_TYPE
}

/// Every record in the thread, in order.
pub fn records(msgs: &[Value]) -> impl Iterator<Item = Record> + '_ {
    msgs.iter()
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .filter_map(Record::from_block)
}

/// Whether the user refused access to `path` in `space` (or a folder holding
/// it) earlier in this conversation. Read from the saved record, so it holds
/// across restarts until a new conversation starts.
pub fn denied(msgs: &[Value], space: &str, path: &str) -> bool {
    records(msgs).any(|r| refusal(&r).is_some_and(|(s, p)| s == space && grants::covers(p, Path::new(path))))
}

/// The space and path a record refuses access to, if it is a refusal.
fn refusal(r: &Record) -> Option<(&str, &str)> {
    match r {
        Record::Access { space, path, answer: AccessAnswer::Deny } | Record::DeniedEarlier { space, path } => {
            Some((space, path))
        }
        _ => None,
    }
}

/// Whether the UI shows this record on its reply.
fn is_shown(r: &Record) -> bool {
    !matches!(r, Record::DeniedEarlier { .. })
}

/// The thread as the provider gets it: only each message's role and content
/// (its saved time is Phaethon's own), record blocks removed, and a message
/// left with nothing in it (a reply stopped before any text) dropped.
pub fn for_provider(msgs: &[Value]) -> Vec<Value> {
    msgs.iter()
        .filter_map(|m| {
            let blocks = m["content"].as_array()?;
            let kept: Vec<Value> = blocks.iter().filter(|b| !is_record(b)).cloned().collect();
            (!kept.is_empty()).then(|| json!({"role": m["role"], "content": kept}))
        })
        .collect()
}

/// `m` with the time it was saved (`"at"`, milliseconds since the epoch).
/// Messages saved before this existed have none, and still load.
pub fn stamped(mut m: Value) -> Value {
    m["at"] = now_ms().into();
    m
}

/// A conversation's lasting identity: when its first message was saved. It
/// survives the renames that archiving and reopening do, and an earlier
/// version kept by an edit or regenerate shares it. `None` for conversations
/// saved before messages had times.
pub fn key(msgs: &[Value]) -> Option<String> {
    msgs.first().and_then(|m| m["at"].as_u64()).map(|t| t.to_string())
}

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
    /// Where this message's first entry is in thread.json (for edit and
    /// regenerate: see [`cut_at`]).
    pub index: usize,
    /// The record for this reply, in order (empty for user messages).
    pub records: Vec<Record>,
    /// When it was sent (yours) or finished (a reply), in milliseconds since
    /// the epoch. Absent for messages saved before times were kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiAttachment {
    pub name: String,
    pub path: String,
    pub media_type: String,
}

/// The thread as the UI shows it: user text, and each assistant reply as one
/// message even when it spans several model turns around tool calls, with its
/// record. Tool results and thinking are not shown.
pub fn to_ui(msgs: &[Value]) -> Vec<UiMessage> {
    let mut out: Vec<UiMessage> = vec![];
    // Where the reply being built began: its first assistant entry, even one
    // with nothing to show (a tool call alone).
    let mut reply_start: Option<usize> = None;
    for (index, m) in msgs.iter().enumerate() {
        if m["role"] == "assistant" && reply_start.is_none() {
            reply_start = Some(index);
        }
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
        let records: Vec<Record> = m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Record::from_block)
            .filter(is_shown)
            .collect();
        let at = m["at"].as_u64();
        match m["role"].as_str() {
            Some("user") if !texts.is_empty() || !files.is_empty() => {
                reply_start = None;
                out.push(UiMessage {
                    role: "user",
                    text: texts.join("\n\n"),
                    attachments: files,
                    index,
                    records: vec![],
                    at,
                })
            }
            Some("assistant") if !texts.is_empty() || !records.is_empty() => {
                let joined = texts.join("\n\n");
                match out.last_mut() {
                    Some(last) if last.role == "assistant" => {
                        if !last.text.is_empty() && !joined.is_empty() {
                            last.text.push_str("\n\n");
                        }
                        last.text.push_str(&joined);
                        last.records.extend(records);
                        // A reply finishes with its last part.
                        last.at = at.or(last.at);
                    }
                    _ => out.push(UiMessage {
                        role: "assistant",
                        text: joined,
                        attachments: vec![],
                        index: reply_start.unwrap_or(index),
                        records,
                        at,
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

/// The CLI session kept with the archived conversation `id`.
fn archived_session(space: &Path, id: &str) -> PathBuf {
    archive_dir(space).join(format!("{id}.session"))
}

/// Move the current CLI session (if any) to the archived conversation `id`.
fn session_to_archive(space: &Path, id: &str) -> io::Result<()> {
    let cur = session_file(space);
    if !is_regular_file(&cur) {
        return Ok(());
    }
    fs::rename(cur, archived_session(space, id))
}

/// Make the archived conversation `id`'s CLI session the current one, or
/// leave none when it has none (it was had with Phaethon's own agent).
fn session_from_archive(space: &Path, id: &str) -> io::Result<()> {
    let kept = archived_session(space, id);
    if is_regular_file(&kept) {
        fs::rename(kept, session_file(space))
    } else {
        remove_if_there(&session_file(space))
    }
}

fn remove_if_there(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
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
/// return the id it was given; its CLI session goes with it. An empty current
/// file (`[]`) is removed, and a session left without a conversation stays for
/// the caller to replace or remove.
fn archive_current(space: &Path) -> io::Result<Option<String>> {
    let cur = file(space);
    if !current_has_content(space) {
        return remove_if_there(&cur).map(|_| None);
    }
    let id = free_id(space)?;
    fs::rename(&cur, archived(space, &id))?;
    // Losing the session only means the CLI starts afresh; the messages are kept either way.
    let _ = session_to_archive(space, &id);
    Ok(Some(id))
}

/// A new archive id with no file under it yet (the archive folder is created).
fn free_id(space: &Path) -> io::Result<String> {
    fs::create_dir_all(archive_dir(space))?;
    let base = now_ms();
    (0..1000)
        .map(|n| if n == 0 { base.to_string() } else { format!("{base}-{n}") })
        .find(|id| fs::symlink_metadata(archived(space, id)).is_err())
        .ok_or_else(|| io::Error::other("no free name in the conversation archive"))
}

/// Whether `index` is where a message the user wrote starts: a user message
/// with content, not one carrying tool results.
pub fn is_user_boundary(msgs: &[Value], index: usize) -> bool {
    msgs.get(index).is_some_and(|m| {
        m["role"] == "user"
            && m["content"].as_array().is_some_and(|c| {
                !c.is_empty() && !c.iter().any(|b| b["type"] == "tool_result")
            })
    })
}

/// The saved files on the user message at `index` whose paths are in `keep`,
/// in their original order: what an edit or regenerate carries over. Only
/// files already on that message can be kept, so a caller cannot name any
/// other file in the space.
pub fn kept_attachments(msgs: &[Value], index: usize, keep: &[String]) -> Vec<Value> {
    if !is_user_boundary(msgs, index) {
        return vec![];
    }
    msgs[index]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "phaethon_attachment" && b["path"].as_str().is_some_and(|p| keep.iter().any(|k| k == p)))
        .cloned()
        .collect()
}

/// Said when an edit points at a message that isn't (or is no longer) there.
pub const STALE_EDIT: &str =
    "That message can’t be changed: the conversation has changed since it was shown. Reload the conversation and try again.";

/// Edit or regenerate: drop the user message at `index` and everything after
/// it, so a new message can take its place. The conversation as it was is
/// first saved whole into the archive (a copy, under a new id), so nothing
/// is lost; the CLI session, if any, goes with that copy. The caller saves
/// the shortened thread.
///
/// Refusals of access in the dropped part still hold: they are added at the
/// end as one record-only assistant message ([`Record::DeniedEarlier`]),
/// which the model never sees ([`for_provider`]) and the UI doesn't show.
pub fn cut_at(space: &Path, msgs: &mut Vec<Value>, index: usize) -> Result<(), String> {
    if !is_user_boundary(msgs, index) {
        return Err(STALE_EDIT.into());
    }
    let keep = || -> io::Result<String> {
        let id = free_id(space)?;
        let path = archived(space, &id);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&*msgs)?)?;
        fs::rename(&tmp, &path)?;
        Ok(id)
    };
    let id = keep().map_err(|e| format!("The earlier version of this conversation couldn’t be kept, so nothing was changed: {e}"))?;
    // The CLI session holds the whole earlier version, so it stays with that; the new version starts a fresh one.
    let _ = session_to_archive(space, &id);
    let dropped = msgs.split_off(index);
    let mut carried: Vec<Value> = vec![];
    for r in records(&dropped) {
        let Some((space, path)) = refusal(&r) else { continue };
        let block = Record::DeniedEarlier { space: space.into(), path: path.into() }.to_block();
        if !denied(msgs, space, path) && !carried.contains(&block) {
            carried.push(block);
        }
    }
    if !carried.is_empty() {
        msgs.push(json!({"role": "assistant", "content": carried}));
    }
    Ok(())
}

/// Start a new, empty conversation, keeping the current one in the archive.
/// The CLI starts a fresh session too.
pub fn start_new(space: &Path) -> io::Result<()> {
    archive_current(space)?;
    remove_if_there(&session_file(space))
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
            let _ = session_from_archive(space, &back);
        }
        return Err(e);
    }
    // Claude Code resumes this conversation's own session from now on.
    session_from_archive(space, id)
}

/// Delete a conversation for good, with its CLI session. `"current"` empties
/// the current one (its file is removed); any other id must be an archive id
/// ([`is_valid_id`]) naming a regular file in the archive, and is never
/// turned into a path otherwise. Files the user
/// attached stay in the space: they are the user's files and other versions
/// of the conversation may still show them.
pub fn delete(space: &Path, id: &str) -> io::Result<()> {
    if id == CURRENT_ID {
        let _ = fs::remove_file(file(space).with_extension("json.tmp"));
        remove_if_there(&file(space))?;
        return remove_if_there(&session_file(space));
    }
    if !is_valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a conversation id"));
    }
    let chosen = archived(space, id);
    if !is_regular_file(&chosen) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "that conversation is no longer there"));
    }
    fs::remove_file(chosen)?;
    remove_if_there(&archived_session(space, id))
}

/// The saved messages of conversation `id`: `"current"`, or an archive id
/// naming a regular file in the archive (never turned into a path otherwise).
pub fn load_id(space: &Path, id: &str) -> io::Result<Vec<Value>> {
    if id == CURRENT_ID {
        return load(space);
    }
    if !is_valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a conversation id"));
    }
    let chosen = archived(space, id);
    if !is_regular_file(&chosen) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "that conversation is no longer there"));
    }
    read_messages(&chosen)
}

/// The saved paths of the files attached in `msgs`, each once, in order.
pub fn attachment_paths(msgs: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for b in msgs.iter().filter_map(|m| m["content"].as_array()).flatten().filter(|b| is_attachment_ref(b)) {
        if let Some(p) = b["path"].as_str()
            && !out.iter().any(|o| o == p)
        {
            out.push(p.to_string());
        }
    }
    out
}

/// What deleting conversation `id` with everything it brought would remove.
#[derive(Debug, PartialEq)]
pub struct ForgetPlan {
    /// Attached files no other conversation in the space mentions.
    pub only_here: Vec<String>,
    /// Attached files another conversation (an earlier version, say) still uses; they stay.
    pub shared: usize,
    /// The conversation's [`key`], which tags what was kept from it in memory.
    pub key: Option<String>,
}

/// Work out what goes with conversation `id`. Other conversations are
/// searched as raw text, so one that can't be read still keeps any file it
/// names. A conversation that can't be read itself brings no files.
pub fn plan_forget(space: &Path, id: &str) -> io::Result<ForgetPlan> {
    let msgs = match load_id(space, id) {
        Ok(m) => m,
        Err(e) if matches!(e.kind(), io::ErrorKind::InvalidInput | io::ErrorKind::NotFound) => return Err(e),
        Err(_) => vec![],
    };
    let mut others: Vec<String> = vec![];
    if id != CURRENT_ID && let Ok(raw) = fs::read_to_string(file(space)) {
        others.push(raw);
    }
    if let Ok(entries) = fs::read_dir(archive_dir(space)) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(other) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
            if other != id && is_valid_id(other) && is_regular_file(&entry.path())
                && let Ok(raw) = fs::read_to_string(entry.path())
            {
                others.push(raw);
            }
        }
    }
    let (mut only_here, mut shared) = (vec![], 0);
    for path in attachment_paths(&msgs) {
        let quoted = serde_json::to_string(&path).expect("a string serializes");
        if others.iter().any(|raw| raw.contains(&quoted)) {
            shared += 1;
        } else {
            only_here.push(path);
        }
    }
    Ok(ForgetPlan { only_here, shared, key: key(&msgs) })
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

/// Read one conversation without moving anything (for search): `"current"`,
/// or an archive id naming a regular file in the archive.
pub fn load_conversation(space: &Path, id: &str) -> io::Result<Vec<Value>> {
    if id == CURRENT_ID {
        return load(space);
    }
    if !is_valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a conversation id"));
    }
    let path = archived(space, id);
    if !is_regular_file(&path) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "that conversation is no longer there"));
    }
    read_messages(&path)
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
                UiMessage { role: "user", text: "what's in notes?".into(), attachments: vec![], index: 0, records: vec![], at: None },
                UiMessage { role: "assistant", text: "Let me look.\n\nThere is a.md.".into(), attachments: vec![], index: 1, records: vec![], at: None },
            ]
        );
        fs::write(file(&dir), "{\"not\": \"a list\"}").unwrap();
        assert!(load(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn times_round_trip_old_files_load_and_the_provider_never_sees_them() {
        let dir = temp_space("times");
        // A file saved before times existed.
        fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        fs::write(file(&dir), r#"[{"role":"user","content":[{"type":"text","text":"old"}]},{"role":"assistant","content":[{"type":"text","text":"reply"}]}]"#).unwrap();
        let old = load(&dir).unwrap();
        assert!(to_ui(&old).iter().all(|m| m.at.is_none()));
        assert_eq!(key(&old), None);
        assert!(serde_json::to_value(&to_ui(&old)[0]).unwrap().get("at").is_none(), "no time, no field");
        // New messages carry one, kept through a save and a load; the UI gets it.
        let mut msgs = old.clone();
        msgs.push(stamped(user_text("new")));
        save(&dir, &msgs).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!(back, msgs);
        let at = back[2]["at"].as_u64().unwrap();
        assert!(at > 1_700_000_000_000);
        assert_eq!(to_ui(&back)[2].at, Some(at));
        assert_eq!(key(&[stamped(user_text("x"))]).map(|k| k.len()), Some(13));
        // Only role and content go to the provider.
        assert_eq!(for_provider(&back)[2], json!({"role": "user", "content": [{"type": "text", "text": "new"}]}));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plan_forget_keeps_files_other_conversations_name() {
        let dir = temp_space("plan");
        let f = |p: &str| crate::attachments::reference(p, "text/plain", "x.md");
        let mut a = vec![user_message("a", &[f("attachments/d/one.md"), f("attachments/d/two.md")])];
        a[0]["at"] = 5.into();
        save(&dir, &a).unwrap();
        start_new(&dir).unwrap();
        save(&dir, &[user_message("b", &[f("attachments/d/two.md")])]).unwrap();
        let a_id = list(&dir).unwrap()[1].id.clone();
        let plan = plan_forget(&dir, &a_id).unwrap();
        assert_eq!(plan, ForgetPlan { only_here: vec!["attachments/d/one.md".into()], shared: 1, key: Some("5".into()) });
        // An unreadable conversation still keeps any file it names (and only those).
        fs::write(file(&dir), "{ broken \"attachments/d/one.md\"").unwrap();
        assert_eq!(plan_forget(&dir, &a_id).unwrap().only_here, vec!["attachments/d/two.md".to_string()]);
        assert_eq!(plan_forget(&dir, CURRENT_ID).unwrap(), ForgetPlan { only_here: vec![], shared: 0, key: None });
        assert_eq!(plan_forget(&dir, "../x").unwrap_err().kind(), io::ErrorKind::InvalidInput);
        fs::remove_dir_all(&dir).unwrap();
    }

    fn approval(allowed: bool) -> Record {
        Record::Approval { path: "plan.md".into(), action: WriteAction::Create, allowed }
    }

    #[test]
    fn records_have_the_contract_shape() {
        let cases = [
            (approval(true), json!({"kind": "approval", "path": "plan.md", "action": "create", "allowed": true})),
            (
                Record::Access { space: "work".into(), path: "calendar".into(), answer: AccessAnswer::Always },
                json!({"kind": "access", "space": "work", "path": "calendar", "answer": "always"}),
            ),
            (
                Record::Read { space: "work".into(), path: "calendar/oct.md".into(), tool: ReadTool::Read, query: None },
                json!({"kind": "read", "space": "work", "path": "calendar/oct.md", "tool": "read"}),
            ),
            (Record::Stopped, json!({"kind": "stopped"})),
        ];
        for (rec, ui) in cases {
            assert_eq!(serde_json::to_value(&rec).unwrap(), ui);
            let block = rec.to_block();
            assert_eq!(block["type"], RECORD_TYPE);
            assert_eq!(Record::from_block(&block), Some(rec));
        }
        // Hand-edited or unknown record blocks are skipped, never an error.
        assert_eq!(Record::from_block(&json!({"type": RECORD_TYPE, "kind": "teleport"})), None);
        assert_eq!(Record::from_block(&json!({"type": "text", "text": "hi"})), None);
    }

    #[test]
    fn records_show_on_their_reply_and_never_reach_the_provider() {
        let msgs = vec![
            user_text("plan my week"),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "tool_use", "id": "t1", "name": "write_file", "input": {"path": "plan.md", "contents": "x"}},
                approval(false).to_block(),
            ]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "declined", "is_error": true}]}),
            json!({"role": "assistant", "content": [{"type": "text", "text": "Okay, I won't."}]}),
            user_text("stop it"),
            json!({"role": "assistant", "content": [Record::Stopped.to_block()]}),
            user_text("hello"),
        ];
        let ui = to_ui(&msgs);
        assert_eq!(ui.len(), 5);
        assert_eq!((ui[1].index, ui[1].text.as_str(), ui[1].records.clone()), (1, "Okay, I won't.", vec![approval(false)]));
        assert_eq!((ui[3].index, ui[3].text.as_str(), ui[3].records.clone()), (5, "", vec![Record::Stopped]));
        assert_eq!((ui[4].role, ui[4].index), ("user", 6));
        let json = serde_json::to_value(&ui[1]).unwrap();
        assert_eq!(json["records"][0]["kind"], "approval");
        assert_eq!(json["index"], 1);

        let wire = for_provider(&msgs);
        assert!(!serde_json::to_string(&wire).unwrap().contains(RECORD_TYPE));
        // The reply with the tool call keeps every other block exactly; the stopped-only reply is gone.
        assert_eq!(wire.len(), 6);
        assert_eq!(wire[1]["content"].as_array().unwrap().len(), 2);
        assert_eq!(wire[1]["content"][0], msgs[1]["content"][0]);
        assert_eq!(wire[4], msgs[4]);
        assert_eq!(wire[5], msgs[6]);
        // A thread without records is passed through unchanged.
        assert_eq!(for_provider(&msgs[3..5]), msgs[3..5].to_vec());
        assert_eq!(records(&msgs).count(), 2);
    }

    #[test]
    fn denial_covers_the_path_and_everything_inside_it() {
        let deny = |space: &str, path: &str| {
            json!({"role": "assistant", "content": [Record::Access { space: space.into(), path: path.into(), answer: AccessAnswer::Deny }.to_block()]})
        };
        let msgs = vec![user_text("hi"), deny("work", "calendar"), json!({"role": "assistant", "content": [Record::Access { space: "work".into(), path: "notes".into(), answer: AccessAnswer::Once }.to_block()]})];
        assert!(denied(&msgs, "work", "calendar"));
        assert!(denied(&msgs, "work", "calendar/oct.md"));
        assert!(!denied(&msgs, "work", "calendar-old"));
        assert!(!denied(&msgs, "home", "calendar"));
        assert!(!denied(&msgs, "work", "notes"), "only a deny counts");
        assert!(!denied(&[deny("work", "calendar/oct.md")], "work", "calendar"), "a broader path is asked about");
    }

    #[test]
    fn cut_at_keeps_a_copy_and_only_cuts_at_user_messages() {
        let dir = temp_space("cut");
        let mut msgs = chat("first", "one");
        msgs.push(json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}));
        msgs.extend(chat("second", "two"));
        save(&dir, &msgs).unwrap();
        let original = msgs.clone();
        for bad in [1, 2, 3 + 2, 99] {
            assert_eq!(cut_at(&dir, &mut msgs, bad), Err(STALE_EDIT.to_string()), "{bad}");
        }
        assert_eq!(msgs, original);
        assert!(archive_files(&dir).is_empty());
        cut_at(&dir, &mut msgs, 3).unwrap();
        assert_eq!(msgs, original[..3].to_vec());
        let files = archive_files(&dir);
        assert_eq!(files.len(), 1);
        assert_eq!(read_messages(&archive_dir(&dir).join(&files[0])).unwrap(), original);
        // The current file is not touched by the cut itself; the caller saves.
        assert_eq!(load(&dir).unwrap(), original);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_deny_outlives_the_cut_that_drops_it() {
        let dir = temp_space("cutdeny");
        let rec = |space: &str, path: &str, answer| json!({"role": "assistant", "content": [
            {"type": "text", "text": "I can't, then."},
            Record::Access { space: space.into(), path: path.into(), answer }.to_block(),
        ]});
        // Turn 1 refused work/notes; turn 2 refused work/calendar twice and
        // home/diary once, and allowed work/tasks once.
        let mut msgs = vec![
            user_text("first"),
            rec("work", "notes", AccessAnswer::Deny),
            user_text("second"),
            rec("work", "calendar", AccessAnswer::Deny),
            user_text("again"),
            rec("work", "calendar", AccessAnswer::Deny),
            rec("home", "diary", AccessAnswer::Deny),
            rec("work", "tasks", AccessAnswer::Once),
        ];
        let before_ui = to_ui(&msgs[..2]);
        cut_at(&dir, &mut msgs, 2).unwrap();
        // The kept part is untouched; one record-only message carries the
        // dropped refusals, each once, and not the one already in the kept part.
        assert_eq!(msgs.len(), 3);
        let carried: Vec<Record> = msgs[2]["content"].as_array().unwrap().iter().filter_map(Record::from_block).collect();
        assert_eq!(
            carried,
            vec![
                Record::DeniedEarlier { space: "work".into(), path: "calendar".into() },
                Record::DeniedEarlier { space: "home".into(), path: "diary".into() },
            ]
        );
        assert!(denied(&msgs, "work", "calendar/oct.md") && denied(&msgs, "home", "diary") && denied(&msgs, "work", "notes"));
        assert!(!denied(&msgs, "work", "tasks"), "only refusals carry over");

        // The new message goes on after it: the model never sees the carried
        // message, the UI shows the same as before plus the new message.
        msgs.push(user_text("second, reworded"));
        let wire = for_provider(&msgs);
        assert_eq!(wire, vec![msgs[0].clone(), for_provider(&msgs[1..2])[0].clone(), msgs[3].clone()]);
        let ui = to_ui(&msgs);
        assert_eq!(&ui[..2], &before_ui[..]);
        assert_eq!((ui.len(), ui[2].role, ui[2].index), (3, "user", 3));
        assert!(is_user_boundary(&msgs, 3));

        // A second regenerate keeps them (they are before the cut now), with no duplicates.
        msgs.push(json!({"role": "assistant", "content": [{"type": "text", "text": "ok"}]}));
        cut_at(&dir, &mut msgs, 3).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(records(&msgs).filter(|r| matches!(r, Record::DeniedEarlier { .. })).count(), 2);
        // Editing the very first message keeps them all, before any user message.
        msgs.push(user_text("x"));
        cut_at(&dir, &mut msgs, 0).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(records(&msgs).count(), 3);
        assert!(for_provider(&msgs).is_empty() && to_ui(&msgs).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_removes_one_conversation_and_refuses_bad_ids() {
        let dir = temp_space("delete");
        save(&dir, &chat("old", "one")).unwrap();
        start_new(&dir).unwrap();
        save(&dir, &chat("keep", "two")).unwrap();
        start_new(&dir).unwrap();
        save(&dir, &chat("now", "three")).unwrap();
        let l = list(&dir).unwrap();
        let (keep_id, old_id) = (l[1].id.clone(), l[2].id.clone());
        assert_eq!(l[2].title, "old");

        delete(&dir, &old_id).unwrap();
        let l = list(&dir).unwrap();
        assert_eq!(l.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["now", "keep"]);
        assert!(!archived(&dir, &old_id).exists());
        // Gone means gone: a second delete or an open says so.
        assert_eq!(delete(&dir, &old_id).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(open(&dir, &old_id).unwrap_err().kind(), io::ErrorKind::NotFound);

        // Bad ids never become paths: a file next to the archive survives.
        fs::write(dir.join("secret.json"), "[]").unwrap();
        fs::write(dir.join(STATE_DIR).join("grants.json"), "{}").unwrap();
        for bad in ["", "..", "../thread", "../../secret", "/etc/passwd", "1/2", "12.json", "Current", "current/..", "thread"] {
            assert_eq!(delete(&dir, bad).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{bad:?}");
        }
        assert!(dir.join("secret.json").exists() && dir.join(STATE_DIR).join("grants.json").exists() && file(&dir).exists());
        #[cfg(unix)]
        {
            // A link in the archive is not followed, and what it points at survives.
            std::os::unix::fs::symlink(dir.join("secret.json"), archived(&dir, "1700000000000")).unwrap();
            assert_eq!(delete(&dir, "1700000000000").unwrap_err().kind(), io::ErrorKind::NotFound);
            assert!(dir.join("secret.json").exists());
        }

        // "current" empties the current conversation; the archive is untouched.
        delete(&dir, CURRENT_ID).unwrap();
        assert!(!file(&dir).exists());
        assert!(load(&dir).unwrap().is_empty());
        assert!(archived(&dir, &keep_id).exists());
        // Already empty: still fine.
        delete(&dir, CURRENT_ID).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    const S1: &str = "11111111-1111-1111-1111-111111111111";
    const S2: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn each_conversation_keeps_its_own_cli_session() {
        let dir = temp_space("sessions");
        let session = || crate::vault::read_session(&dir);
        // A space that had one CLI session before conversations kept theirs: it is the current one's.
        crate::vault::write_session(&dir, S1).unwrap();
        save(&dir, &chat("first", "one")).unwrap();
        start_new(&dir).unwrap();
        assert_eq!(session(), None, "a new conversation starts a fresh session");
        let first = list(&dir).unwrap()[1].id.clone();
        assert_eq!(fs::read_to_string(archived_session(&dir, &first)).unwrap().trim(), S1);
        crate::vault::write_session(&dir, S2).unwrap();
        save(&dir, &chat("second", "two")).unwrap();
        // Opening the first resumes its session; the second keeps its own in the archive.
        open(&dir, &first).unwrap();
        assert_eq!(session().as_deref(), Some(S1));
        let second = list(&dir).unwrap()[1].id.clone();
        assert_eq!(fs::read_to_string(archived_session(&dir, &second)).unwrap().trim(), S2);
        assert!(!archived_session(&dir, &first).exists());
        // Session files are never listed as conversations.
        assert_eq!(list(&dir).unwrap().len(), 2);
        open(&dir, &second).unwrap();
        assert_eq!(session().as_deref(), Some(S2));
        // A conversation without a session (Phaethon's own agent) opens with none.
        let first = list(&dir).unwrap().iter().find(|t| t.title == "first").unwrap().id.clone();
        fs::remove_file(archived_session(&dir, &first)).unwrap();
        open(&dir, &first).unwrap();
        assert_eq!(session(), None);
        // Deleting a past conversation deletes its session; deleting the current one, the current session.
        let second = list(&dir).unwrap()[1].id.clone();
        assert!(archived_session(&dir, &second).exists());
        delete(&dir, &second).unwrap();
        assert!(!archived_session(&dir, &second).exists());
        crate::vault::write_session(&dir, S1).unwrap();
        delete(&dir, CURRENT_ID).unwrap();
        assert_eq!(session(), None);
        // An edit keeps the session with the earlier version, and the new version starts afresh.
        let mut msgs = chat("q", "a");
        save(&dir, &msgs).unwrap();
        crate::vault::write_session(&dir, S2).unwrap();
        cut_at(&dir, &mut msgs, 0).unwrap();
        assert_eq!(session(), None);
        let copy = list(&dir).unwrap()[1].id.clone();
        assert_eq!(fs::read_to_string(archived_session(&dir, &copy)).unwrap().trim(), S2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn kept_attachments_come_only_from_the_replaced_message() {
        let file = |p: &str| crate::attachments::reference(p, "image/png", "photo.png");
        let msgs = vec![
            user_message("first", &[file("attachments/2026-10-10/a.png"), file("attachments/2026-10-10/b.png")]),
            json!({"role": "assistant", "content": [{"type": "text", "text": "ok"}]}),
            user_message("second", &[file("attachments/2026-10-10/c.png")]),
        ];
        let paths = |v: Vec<Value>| v.iter().map(|b| b["path"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let keep = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(paths(kept_attachments(&msgs, 0, &keep(&["attachments/2026-10-10/b.png", "attachments/2026-10-10/a.png"]))), keep(&["attachments/2026-10-10/a.png", "attachments/2026-10-10/b.png"]));
        assert_eq!(paths(kept_attachments(&msgs, 0, &keep(&["attachments/2026-10-10/b.png"]))), keep(&["attachments/2026-10-10/b.png"]));
        // Another message's file, a made-up path, a reply, out of range: nothing.
        assert!(kept_attachments(&msgs, 0, &keep(&["attachments/2026-10-10/c.png", "../../secret.txt"])).is_empty());
        assert!(kept_attachments(&msgs, 1, &keep(&["attachments/2026-10-10/a.png"])).is_empty());
        assert!(kept_attachments(&msgs, 9, &keep(&["attachments/2026-10-10/a.png"])).is_empty());
    }
}
