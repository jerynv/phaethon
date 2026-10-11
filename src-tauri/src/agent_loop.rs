//! Phaethon's own agent loop: a model provider plus Phaethon's space-scoped
//! tools. Nothing from the user's global agent setup is loaded; the model sees
//! only the system prompt built here, the vault's MANUAL.md and this space.
//!
//! One turn: append the user's message, then call the model, run any tools it
//! asks for (writes only after the user allows them), and repeat until it
//! answers. The thread file is saved after every step, so a crash or a cancel
//! loses at most the step in flight.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::agent::{AgentEvent, ErrorCode, Runs};
use crate::grants::{self, AccessAnswer, Grant};
use crate::provider::{Delta, ErrorKind, ModelRequest, Provider};
use crate::thread::{ReadTool, Record, WriteAction};
use crate::vault::Vault;
use crate::{attachments, memory, thread, tools};

/// Model calls allowed in one turn before Phaethon stops the agent.
const MAX_STEPS: usize = 30;
/// Bytes of a pending write's new and old contents sent to the approval card.
pub const PREVIEW_CAP: usize = 512 * 1024;

const BASE_PROMPT: &str = "You are Phaethon, a personal assistant working inside one space of the user's vault. \
The space is a folder of the user's own files. You see it through your tools; every path is relative to the space root. \
Look at files before answering questions about them rather than guessing. \
Writing a file always asks the user first. If they decline, accept that and do not retry the same write; ask what they would like instead. \
Write plainly and keep replies short. Your replies are often read aloud by screen readers, so use headings, lists and tables only when they genuinely help.";

/// Space id -> (request id, where the answer goes).
type Pending<T> = Arc<Mutex<HashMap<String, (String, oneshot::Sender<T>)>>>;

fn wait_on<T>(map: &Pending<T>, space: &str, id: &str) -> oneshot::Receiver<T> {
    let (tx, rx) = oneshot::channel();
    map.lock()
        .unwrap()
        .insert(space.to_string(), (id.to_string(), tx));
    rx
}

fn answer_on<T>(map: &Pending<T>, space: &str, id: &str, value: T) -> bool {
    let mut map = map.lock().unwrap();
    match map.get(space) {
        Some((pending, _)) if pending == id => {
            let (_, tx) = map.remove(space).expect("present");
            tx.send(value).is_ok()
        }
        _ => false,
    }
}

/// Questions waiting for the user, at most one per space (tools run one at a
/// time): write approvals, and requests to read another space.
#[derive(Default, Clone)]
pub struct Approvals {
    writes: Pending<bool>,
    access: Pending<AccessAnswer>,
}

impl Approvals {
    fn wait(&self, space: &str, id: &str) -> oneshot::Receiver<bool> {
        wait_on(&self.writes, space, id)
    }

    fn wait_access(&self, space: &str, id: &str) -> oneshot::Receiver<AccessAnswer> {
        wait_on(&self.access, space, id)
    }

    fn drop_pending(&self, space: &str) {
        self.writes.lock().unwrap().remove(space);
        self.access.lock().unwrap().remove(space);
    }

    /// The user's answer to approval `id` in `space`. False if nothing with
    /// that id is waiting (already answered, cancelled, or a stale card).
    pub fn answer(&self, space: &str, id: &str, allow: bool) -> bool {
        answer_on(&self.writes, space, id, allow)
    }

    /// The user's answer to access request `id` in `space`. False if nothing
    /// with that id is waiting.
    pub fn answer_access(&self, space: &str, id: &str, answer: AccessAnswer) -> bool {
        answer_on(&self.access, space, id, answer)
    }
}

pub struct LoopRequest<'a> {
    pub space_id: &'a str,
    pub space_dir: &'a Path,
    pub vault_root: &'a Path,
    pub prompt: &'a str,
    /// Reference blocks for files saved with this message (see attachments.rs).
    pub attachments: Vec<Value>,
    /// Edit or regenerate: the thread index of a user message that this one
    /// replaces, with everything after it (see [`thread::cut_at`]).
    pub replace_from: Option<usize>,
}

/// The system prompt: Phaethon's own instructions, the other spaces and this
/// space's grants, the vault's MANUAL.md, and this space's memory. Stable
/// across turns (spaces and grants are sorted) so the prompt cache keeps
/// working until they change.
pub fn system_prompt(vault_root: &Path, space_id: &str) -> String {
    let mut s = format!("{BASE_PROMPT}\n\nThis space is called \"{space_id}\".");
    let vault = Vault::at(vault_root);
    let others = grants::other_spaces(&vault, space_id);
    if !others.is_empty() {
        s.push_str(&format!(
            "\n\n# Other spaces\n\nThe user's other spaces are: {}. They are separate on purpose, and you cannot read them by default. \
If the user's request needs something from one of them, call request_access with the space, the narrowest folder or file that will do, and a short reason; the user decides. \
Once access is granted, read it with list_files, read_file or search_files using paths like \"@<space>/<path>\". Access is read-only: you can never write in another space.",
            others.join(", ")
        ));
        let granted = grants::for_space(&vault, space_id);
        if granted.is_empty() {
            s.push_str("\n\nThis space has no standing access to other spaces.");
        } else {
            let list: Vec<String> = granted.iter().map(|g| format!("- @{}/{}", g.from, g.path)).collect();
            s.push_str(&format!(
                "\n\nThis space may already read (the user can revoke this at any time):\n{}",
                list.join("\n")
            ));
        }
    }
    if let Ok(manual) = std::fs::read_to_string(vault_root.join("MANUAL.md"))
        && !manual.trim().is_empty()
    {
        s.push_str("\n\n# The user's manual\n\nThe user wrote this to tell you how they want you to work.\n\n");
        s.push_str(manual.trim());
    }
    // This space's memory only: another space's is never read here.
    if let Some(memory) = vault.space_dir(space_id).ok().and_then(|dir| memory::for_prompt(&dir)) {
        s.push_str("\n\n");
        s.push_str(&memory);
    }
    // This space's imported courses only (its own .phaethon/lms.json). The due
    // dates shown change only when one passes, so the prompt cache still holds.
    if let Some(courses) = vault.space_dir(space_id).ok().and_then(|dir| crate::lms::store::prompt_index(&dir, crate::lms::store::now_secs())) {
        s.push_str("\n\n");
        s.push_str(&courses);
    }
    s
}

/// Run one user turn. Always ends with exactly one `AgentEvent::End`.
pub async fn run_turn<P: Provider>(
    runs: &Runs,
    approvals: &Approvals,
    provider: &P,
    req: LoopRequest<'_>,
    mut emit: impl FnMut(AgentEvent) + Send,
) {
    let Some(cancel_rx) = runs.claim(req.space_id) else {
        emit(AgentEvent::error(
            ErrorCode::Busy,
            "This space is still answering the previous message. Stop it or wait for it to finish.",
        ));
        emit(AgentEvent::End { session_id: None });
        return;
    };
    drive(approvals, provider, &req, cancel_rx, &mut emit).await;
    approvals.drop_pending(req.space_id);
    runs.release(req.space_id);
    emit(AgentEvent::End { session_id: None });
}

async fn drive<P: Provider>(
    approvals: &Approvals,
    provider: &P,
    req: &LoopRequest<'_>,
    mut cancel_rx: oneshot::Receiver<()>,
    emit: &mut (impl FnMut(AgentEvent) + Send),
) {
    let fail = |emit: &mut (dyn FnMut(AgentEvent) + Send), code, message: String| {
        emit(AgentEvent::error(code, message))
    };
    let mut msgs = match thread::load(req.space_dir) {
        Ok(m) => m,
        Err(e) => {
            return fail(emit, ErrorCode::Storage, format!("This space’s conversation file couldn’t be read, so nothing was sent: {e}"));
        }
    };
    if let Some(index) = req.replace_from
        && let Err(e) = thread::cut_at(req.space_dir, &mut msgs, index)
    {
        return fail(emit, ErrorCode::Storage, e);
    }
    msgs.push(thread::stamped(thread::user_message(req.prompt, &req.attachments)));
    if let Err(e) = thread::save(req.space_dir, &msgs) {
        return fail(emit, ErrorCode::Storage, format!("The conversation could not be saved, so nothing was sent: {e}"));
    }
    let tool_defs = tools::definitions();
    let mut emitted_text = false;
    let vault = Vault::at(req.vault_root);
    // "once" grants: this turn only, never written to disk.
    let mut once: Vec<Grant> = vec![];
    // Re-read before each tool call, so a grant revoked mid-turn stops at once.
    let ctx = |once: &[Grant]| tools::Ctx {
        space: req.space_dir.to_path_buf(),
        space_id: req.space_id.to_string(),
        vault: vault.clone(),
        grants: grants::for_space(&vault, req.space_id).into_iter().chain(once.iter().cloned()).collect(),
    };

    for _ in 0..MAX_STEPS {
        // Built for every model call, so a grant removed mid-reply is no longer
        // listed (reads of it are refused anyway, by `ctx`). The text only
        // changes when spaces, grants or MANUAL.md do, so the cache still holds.
        let system = system_prompt(req.vault_root, req.space_id);
        let wire = attachments::expand(req.space_dir, &thread::for_provider(&msgs));
        // The text of this model call as it streams, one entry per text block,
        // so a stopped or failed reply keeps what the user already saw.
        let mut partial: Vec<String> = vec![];
        let result = {
            let mut on_delta = |d: Delta<'_>| match d {
                Delta::TextStart => {
                    if emitted_text {
                        emit(AgentEvent::Text { delta: "\n\n".into() });
                    }
                    partial.push(String::new());
                }
                Delta::Text(t) => {
                    emitted_text = true;
                    emit(AgentEvent::Text { delta: t.to_string() });
                    match partial.last_mut() {
                        Some(p) => p.push_str(t),
                        None => partial.push(t.to_string()),
                    }
                }
            };
            let call = provider.turn(
                ModelRequest { system: &system, messages: &wire, tools: &tool_defs },
                &mut on_delta,
            );
            tokio::select! {
                r = call => Some(r),
                _ = &mut cancel_rx => None,
            }
        };
        let turn = match result {
            None => {
                msgs.extend(partial_reply(&partial, true).map(thread::stamped));
                emit(AgentEvent::Record { record: Record::Stopped });
                if let Err(e) = thread::save(req.space_dir, &msgs) {
                    fail(emit, ErrorCode::Storage, format!("The stopped reply could not be saved: {e}"));
                }
                return emit(AgentEvent::Cancelled);
            }
            Some(Err(e)) => {
                // Keep what streamed before the failure; the next message carries on from it.
                if let Some(m) = partial_reply(&partial, false) {
                    msgs.push(thread::stamped(m));
                    let _ = thread::save(req.space_dir, &msgs);
                }
                return emit(AgentEvent::Error { code: error_code(e.kind), message: e.message, retry_after_secs: e.retry_after });
            }
            Some(Ok(t)) => t,
        };
        if turn.stop_reason == "refusal" {
            // A decline can cut a reply off mid-way: discard it rather than save half an answer.
            return fail(emit, ErrorCode::Declined, "Claude declined to answer this. Try rephrasing your message.".into());
        }
        let uses: Vec<Value> = turn
            .content
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .cloned()
            .collect();
        msgs.push(thread::stamped(json!({"role": "assistant", "content": turn.content})));
        // Records from this step's tool calls are appended to this message.
        let reply = msgs.len() - 1;
        if let Err(e) = thread::save(req.space_dir, &msgs) {
            return fail(emit, ErrorCode::Storage, format!("The reply could not be saved: {e}"));
        }
        if uses.is_empty() {
            match turn.stop_reason.as_str() {
                "pause_turn" => continue,
                "max_tokens" => fail(emit, ErrorCode::Provider, "The reply reached its length limit and was cut off.".into()),
                _ => {}
            }
            return;
        }

        // Every tool_use gets exactly one tool_result, whatever happens, or the
        // next request would be rejected.
        let invalid: HashMap<String, String> = turn.invalid_inputs.into_iter().collect();
        let mut results: Vec<Value> = vec![];
        let mut cancelled = false;
        for u in &uses {
            let id = u["id"].as_str().unwrap_or("").to_string();
            let name = u["name"].as_str().unwrap_or("");
            let outcome: Result<String, String> = if cancelled {
                Err("Not run: the user stopped the reply.".into())
            } else if turn.stop_reason == "max_tokens" {
                Err("Not run: the reply was cut off before this call was complete. Try again with less content.".into())
            } else if let Some(raw) = invalid.get(&id) {
                Err(format!("Not run: the input was not valid JSON: {}", truncate(raw, 500)))
            } else {
                match tools::parse_call(name, &u["input"]) {
                    Err(e) => Err(format!("Not run: {e}.")),
                    Ok(call) => match tools::access(name) {
                        tools::Access::Read if tools::is_cross(&call) => {
                            // Shown and recorded only once the read is allowed and done, so
                            // the conversation never claims a read that was refused.
                            let label = tools::label(&call);
                            let read = read_record(&call, req.space_id);
                            let r = run_tool(ctx(&once), call).await;
                            if r.is_ok() {
                                emit(AgentEvent::Tool { label });
                                if let Some(rec) = read {
                                    record(&mut msgs, reply, rec, emit);
                                }
                            }
                            r
                        }
                        tools::Access::Read => {
                            emit(AgentEvent::Tool { label: tools::label(&call) });
                            run_tool(ctx(&once), call).await
                        }
                        tools::Access::Ask => {
                            let tools::Call::RequestAccess { space, path, reason } = &call else {
                                unreachable!("request_access parses to RequestAccess")
                            };
                            let space = space.trim_start_matches('@');
                            match grants::check_request(&vault, req.space_id, space, path) {
                                Err(e) => Err(format!("Not asked: {e}.")),
                                Ok(path) if ctx(&once).grants.iter().any(|g| g.from == space && grants::covers(&g.path, Path::new(&path))) => {
                                    Ok(format!("This space can already read @{space}/{path}. Read it with paths starting \"@{space}/{path}\"."))
                                }
                                Ok(path) if thread::denied(&msgs, space, &path) => Err(format!(
                                    "Not asked: the user already declined access to @{space}/{path} (or a folder holding it) in this conversation. \
Do not ask for it again in this conversation. Work without it, or tell the user plainly what you would need and why."
                                )),
                                Ok(path) => {
                                    emit(AgentEvent::Tool { label: format!("Waiting for you to answer: {}", tools::label(&call)) });
                                    let answer = approvals.wait_access(req.space_id, &id);
                                    emit(AgentEvent::AccessRequest {
                                        id: id.clone(),
                                        space: space.to_string(),
                                        path: path.clone(),
                                        reason: reason.clone(),
                                    });
                                    let answer = tokio::select! {
                                        a = answer => a.unwrap_or(AccessAnswer::Deny),
                                        _ = &mut cancel_rx => { cancelled = true; AccessAnswer::Deny }
                                    };
                                    approvals.drop_pending(req.space_id);
                                    emit(AgentEvent::AccessRequestDone { id: id.clone(), answer });
                                    let shown = format!("@{space}/{path}");
                                    if cancelled {
                                        // Stopping is not an answer: nothing is recorded, so it may be asked again.
                                        Err("Not asked: the user stopped the reply.".into())
                                    } else {
                                        record(&mut msgs, reply, Record::Access { space: space.to_string(), path: path.clone(), answer }, emit);
                                        match answer {
                                            AccessAnswer::Deny => Err(format!(
                                                "The user declined access to {shown}. Phaethon will refuse any further request for it in this conversation, so do not ask again; work without it or ask them what they would like."
                                            )),
                                            AccessAnswer::Once => {
                                                once.push(grants::once(req.space_id, space, &path));
                                                Ok(format!("The user allowed reading {shown} for this reply only. Read it with paths starting \"{shown}\"."))
                                            }
                                            AccessAnswer::Always => match grants::add_always(&vault, req.space_id, space, &path) {
                                                Ok(_) => Ok(format!("The user allowed reading {shown} from now on. Read it with paths starting \"{shown}\".")),
                                                Err(e) => {
                                                    once.push(grants::once(req.space_id, space, &path));
                                                    Ok(format!("The user allowed reading {shown}, but the permission could not be saved ({e}), so it lasts for this reply only. Read it with paths starting \"{shown}\"."))
                                                }
                                            },
                                        }
                                    }
                                }
                            }
                        }
                        tools::Access::Write => match describe_write(req.space_dir, &call) {
                            Err(e) => Err(format!("Not run: {e}.")),
                            Ok(w) => {
                                emit(AgentEvent::Tool { label: format!("Waiting for you to allow: {}", tools::label(&call)) });
                                let answer = approvals.wait(req.space_id, &id);
                                let (path, action) = (w.path.clone(), w.action);
                                emit(AgentEvent::Approval {
                                    id: id.clone(),
                                    summary: w.summary,
                                    detail: w.detail,
                                    action: w.action,
                                    path: w.path,
                                    space: req.space_id.to_string(),
                                    before: w.before,
                                    truncated: w.truncated,
                                });
                                let allowed = tokio::select! {
                                    a = answer => a.unwrap_or(false),
                                    _ = &mut cancel_rx => { cancelled = true; false }
                                };
                                approvals.drop_pending(req.space_id);
                                emit(AgentEvent::ApprovalDone { id: id.clone(), allowed: allowed && !cancelled });
                                if cancelled {
                                    Err("Not run: the user stopped the reply.".into())
                                } else {
                                    record(&mut msgs, reply, Record::Approval { path, action, allowed }, emit);
                                    if allowed {
                                        emit(AgentEvent::Tool { label: tools::label(&call) });
                                        run_tool(ctx(&once), call).await
                                    } else {
                                        Err("The user declined this write. Nothing was changed.".into())
                                    }
                                }
                            }
                        },
                    },
                }
            };
            results.push(match outcome {
                Ok(text) => json!({"type": "tool_result", "tool_use_id": id, "content": text}),
                Err(text) => json!({"type": "tool_result", "tool_use_id": id, "content": text, "is_error": true}),
            });
        }
        if cancelled {
            record(&mut msgs, reply, Record::Stopped, emit);
        }
        msgs.push(thread::stamped(json!({"role": "user", "content": results})));
        if let Err(e) = thread::save(req.space_dir, &msgs) {
            return fail(emit, ErrorCode::Storage, format!("The conversation could not be saved: {e}"));
        }
        if cancelled {
            return emit(AgentEvent::Cancelled);
        }
    }
    fail(emit, ErrorCode::Provider, format!("Phaethon stopped the agent after {MAX_STEPS} steps. Send another message to let it continue."));
}

/// Save `rec` into the reply at `msgs[at]` and tell the UI.
fn record(msgs: &mut [Value], at: usize, rec: Record, emit: &mut (dyn FnMut(AgentEvent) + Send)) {
    if let Some(content) = msgs.get_mut(at).and_then(|m| m["content"].as_array_mut()) {
        content.push(rec.to_block());
    }
    emit(AgentEvent::Record { record: rec });
}

/// The reply as far as it streamed, as an assistant message: its text, plus
/// the stopped record when the user stopped it. `None` when there is nothing
/// to keep. Text only (no thinking or half-made tool calls), so it is always
/// valid to send back.
fn partial_reply(partial: &[String], stopped: bool) -> Option<Value> {
    let mut content: Vec<Value> = partial
        .iter()
        .map(|t| t.trim_end())
        .filter(|t| !t.trim().is_empty())
        .map(|t| json!({"type": "text", "text": t}))
        .collect();
    if stopped {
        content.push(Record::Stopped.to_block());
    }
    (!content.is_empty()).then(|| json!({"role": "assistant", "content": content}))
}

/// The record for a read tool call into another space (not this one).
fn read_record(call: &tools::Call, own: &str) -> Option<Record> {
    let (path, tool, query) = match call {
        tools::Call::List { path } => (path, ReadTool::List, None),
        tools::Call::Read { path } => (path, ReadTool::Read, None),
        tools::Call::Search { query, path } => (path, ReadTool::Search, Some(query.clone())),
        _ => return None,
    };
    let tools::Target::Other { space, rel } = tools::target(path) else { return None };
    if space == own {
        return None;
    }
    let rel = tools::clean_rel(rel).ok()?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    Some(Record::Read { space: space.to_string(), path: parts.join("/"), tool, query })
}

async fn run_tool(ctx: tools::Ctx, call: tools::Call) -> Result<String, String> {
    tokio::task::spawn_blocking(move || tools::run_in(&ctx, &call))
        .await
        .unwrap_or_else(|e| Err(format!("the tool crashed: {e}")))
}

/// What the approval card shows for a pending write.
struct WritePreview {
    summary: String,
    /// The full new contents (capped at [`PREVIEW_CAP`]).
    detail: String,
    action: WriteAction,
    /// The file, relative to the space, `/`-separated.
    path: String,
    /// The full old contents when replacing (capped at [`PREVIEW_CAP`]).
    before: Option<String>,
    truncated: bool,
}

/// Describe a write for the approval card. `Err` (a message for the model)
/// when the write could never succeed, so the user is not asked for nothing.
fn describe_write(space: &Path, call: &tools::Call) -> Result<WritePreview, String> {
    let tools::Call::Write { path, contents } = call else {
        return Err("only write_file needs approval".into());
    };
    if matches!(tools::target(path), tools::Target::Other { .. }) {
        return Err("write_file can only write in this space; other spaces can never be written".into());
    }
    if path.trim().is_empty() {
        return Err("path must name a file".into());
    }
    let full = tools::resolve(space, path, false)?;
    if full.is_dir() {
        return Err(format!("\"{path}\" is a folder"));
    }
    let shown: Vec<String> = tools::clean_rel(path)?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let shown = shown.join("/");
    let before = full.is_file().then(|| read_capped(&full));
    let action = if before.is_some() { WriteAction::Replace } else { WriteAction::Create };
    let lines = contents.lines().count();
    let s = if lines == 1 { "" } else { "s" };
    let summary = match &before {
        Some(_) => format!("Replace the file {shown} with new contents ({lines} line{s})."),
        None => format!("Create a new file {shown} ({lines} line{s})."),
    };
    let (detail, cut_new) = cap(contents.clone());
    let (before, cut_old) = match before {
        Some((text, cut)) => (Some(text), cut),
        None => (None, false),
    };
    Ok(WritePreview { summary, detail, action, path: shown, before, truncated: cut_new || cut_old })
}

/// A file's text for the approval card, read no further than the cap.
fn read_capped(file: &Path) -> (String, bool) {
    use std::io::Read;
    let mut bytes = vec![];
    let read = std::fs::File::open(file).and_then(|f| f.take(PREVIEW_CAP as u64 + 1).read_to_end(&mut bytes));
    if read.is_err() {
        return (String::new(), false);
    }
    let (text, cut) = cap(String::from_utf8_lossy(&bytes).into_owned());
    (text, cut || bytes.len() > PREVIEW_CAP)
}

/// `s` cut to at most [`PREVIEW_CAP`] bytes on a character boundary, and
/// whether anything was cut.
fn cap(mut s: String) -> (String, bool) {
    if s.len() <= PREVIEW_CAP {
        return (s, false);
    }
    let mut i = PREVIEW_CAP;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    s.truncate(i);
    (s, true)
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}… ({} more characters)", &s[..i], s[i..].chars().count()),
        None => s.to_string(),
    }
}

fn error_code(kind: ErrorKind) -> ErrorCode {
    match kind {
        ErrorKind::Auth => ErrorCode::ApiKey,
        ErrorKind::Billing => ErrorCode::Billing,
        ErrorKind::RateLimit => ErrorCode::RateLimit,
        ErrorKind::Unavailable => ErrorCode::Unavailable,
        ErrorKind::BadRequest => ErrorCode::BadRequest,
        ErrorKind::Network => ErrorCode::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ModelTurn, ProviderError};
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

    /// Plays back scripted turns and records every request it was sent.
    struct Scripted {
        turns: StdMutex<Vec<Result<ModelTurn, ProviderError>>>,
        seen: StdMutex<Vec<Vec<Value>>>,
        systems: StdMutex<Vec<String>>,
    }

    impl Scripted {
        fn new(turns: Vec<Result<ModelTurn, ProviderError>>) -> Self {
            Self {
                turns: StdMutex::new(turns.into_iter().rev().collect()),
                seen: StdMutex::new(vec![]),
                systems: StdMutex::new(vec![]),
            }
        }
    }

    impl Provider for Scripted {
        async fn turn(
            &self,
            req: ModelRequest<'_>,
            on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
        ) -> Result<ModelTurn, ProviderError> {
            self.seen.lock().unwrap().push(req.messages.to_vec());
            self.systems.lock().unwrap().push(req.system.to_string());
            let t = self.turns.lock().unwrap().pop().expect("a scripted turn");
            if let Ok(t) = &t {
                for b in t.content.iter().filter(|b| b["type"] == "text") {
                    on_delta(Delta::TextStart);
                    on_delta(Delta::Text(b["text"].as_str().unwrap()));
                }
            }
            t
        }
    }

    fn turn(content: Value, stop: &str) -> Result<ModelTurn, ProviderError> {
        Ok(ModelTurn { content: content.as_array().unwrap().clone(), stop_reason: stop.into(), invalid_inputs: vec![] })
    }

    fn setup(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-loop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("spaces/school")).unwrap();
        std::fs::write(dir.join("spaces/school/a.md"), "exam on friday").unwrap();
        std::fs::write(dir.join("MANUAL.md"), "Call me J.").unwrap();
        dir
    }

    fn run(
        dir: &Path,
        provider: &Scripted,
        approvals: &Approvals,
        prompt: &str,
        on_event: impl FnMut(&AgentEvent) + Send,
    ) -> Vec<AgentEvent> {
        let runs = Runs::default();
        let space = dir.join("spaces/school");
        let mut events = vec![];
        let mut on_event = on_event;
        tauri::async_runtime::block_on(run_turn(
            &runs,
            approvals,
            provider,
            LoopRequest { space_id: "school", space_dir: &space, vault_root: dir, prompt, attachments: vec![], replace_from: None },
            |e| {
                on_event(&e);
                events.push(e)
            },
        ));
        events
    }

    #[test]
    fn reads_a_file_then_answers_and_saves_the_thread() {
        let dir = setup("read");
        let p = Scripted::new(vec![
            turn(json!([{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "a.md"}}]), "tool_use"),
            turn(json!([{"type": "text", "text": "Your exam is on Friday."}]), "end_turn"),
        ]);
        let events = run(&dir, &p, &Approvals::default(), "when is my exam?", |_| {});
        assert_eq!(
            events,
            vec![
                AgentEvent::Tool { label: "Reading file a.md".into() },
                AgentEvent::Text { delta: "Your exam is on Friday.".into() },
                AgentEvent::End { session_id: None },
            ]
        );
        // The second request carried the tool result, and the thinking block unchanged.
        let seen = p.seen.lock().unwrap();
        assert_eq!(seen[1][1]["content"][0], json!({"type": "thinking", "thinking": "", "signature": "s"}));
        assert_eq!(seen[1][2]["content"][0]["content"], "exam on friday");
        let saved = thread::load(&dir.join("spaces/school")).unwrap();
        assert_eq!(saved.len(), 4);
        assert_eq!(thread::to_ui(&saved).len(), 2);
        assert!(system_prompt(&dir, "school").contains("Call me J."));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_only_after_approval() {
        let dir = setup("write");
        let write = |id: &str| json!([{"type": "tool_use", "id": id, "name": "write_file", "input": {"path": "plan.md", "contents": "study"}}]);
        for allow in [false, true] {
            let p = Scripted::new(vec![
                turn(write(if allow { "w2" } else { "w1" }), "tool_use"),
                turn(json!([{"type": "text", "text": "ok"}]), "end_turn"),
            ]);
            let approvals = Approvals::default();
            let answerer = approvals.clone();
            let events = run(&dir, &p, &approvals, "make a plan", move |e| {
                if let AgentEvent::Approval { id, .. } = e {
                    // A wrong id is ignored; the right one is answered.
                    assert!(!answerer.answer("school", "nope", true));
                    assert!(answerer.answer("school", id, allow));
                }
            });
            assert!(events.iter().any(|e| matches!(e, AgentEvent::Approval { summary, .. } if summary.contains("plan.md"))));
            assert!(events.contains(&AgentEvent::ApprovalDone { id: if allow { "w2" } else { "w1" }.into(), allowed: allow }));
            let exists = dir.join("spaces/school/plan.md").exists();
            assert_eq!(exists, allow, "file written only when allowed");
            let result = p.seen.lock().unwrap()[1].last().unwrap()["content"][0].clone();
            assert_eq!(result["is_error"].as_bool().unwrap_or(false), !allow);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refusal_is_discarded_and_errors_are_reported() {
        let dir = setup("refusal");
        let p = Scripted::new(vec![turn(json!([{"type": "text", "text": "partial"}]), "refusal")]);
        let events = run(&dir, &p, &Approvals::default(), "hi", |_| {});
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { code: ErrorCode::Declined, .. })));
        let saved = thread::load(&dir.join("spaces/school")).unwrap();
        assert_eq!(saved.len(), 1, "only the user message is kept");

        let p = Scripted::new(vec![Err(ProviderError::new(ErrorKind::Auth, "bad key"))]);
        let events = run(&dir, &p, &Approvals::default(), "hi again", |_| {});
        assert!(events.contains(&AgentEvent::error(ErrorCode::ApiKey, "bad key")));
        assert_eq!(events.last(), Some(&AgentEvent::End { session_id: None }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Streams `text` (if any), then never finishes: the turn ends only by
    /// cancel, or with `fail` right after the text when it is set.
    struct Stall {
        text: &'static str,
        fail: StdMutex<Option<ProviderError>>,
        /// Press Stop on this the moment the call starts.
        stop: Option<Runs>,
        seen: StdMutex<Vec<Vec<Value>>>,
    }

    impl Stall {
        fn new(text: &'static str) -> Self {
            Self { text, fail: StdMutex::new(None), stop: None, seen: StdMutex::new(vec![]) }
        }
    }

    impl Provider for Stall {
        async fn turn(
            &self,
            req: ModelRequest<'_>,
            on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
        ) -> Result<ModelTurn, ProviderError> {
            self.seen.lock().unwrap().push(req.messages.to_vec());
            if let Some(runs) = &self.stop {
                runs.cancel("school");
            }
            if !self.text.is_empty() {
                on_delta(Delta::TextStart);
                on_delta(Delta::Text(self.text));
            }
            if let Some(e) = self.fail.lock().unwrap().take() {
                return Err(e);
            }
            std::future::pending().await
        }
    }

    /// Run a turn on `provider`, pressing Stop when `stop_on` says so.
    fn run_stoppable<P: Provider>(dir: &Path, provider: &P, approvals: &Approvals, stop_on: impl Fn(&AgentEvent) -> bool + Send + Sync) -> Vec<AgentEvent> {
        let runs = Runs::default();
        let canceller = runs.clone();
        let mut events = vec![];
        tauri::async_runtime::block_on(run_turn(
            &runs,
            approvals,
            provider,
            LoopRequest { space_id: "school", space_dir: &dir.join("spaces/school"), vault_root: dir, prompt: "go", attachments: vec![], replace_from: None },
            |e| {
                if stop_on(&e) {
                    assert!(canceller.cancel("school"));
                }
                events.push(e)
            },
        ));
        events
    }

    fn records_in(dir: &Path) -> Vec<Record> {
        thread::records(&thread::load(&dir.join("spaces/school")).unwrap()).collect()
    }

    #[test]
    fn a_stopped_reply_keeps_what_streamed() {
        let dir = setup("stop");
        let events = run_stoppable(&dir, &Stall::new("Half an ans"), &Approvals::default(), |e| matches!(e, AgentEvent::Text { .. }));
        let tail: Vec<&AgentEvent> = events.iter().rev().take(3).collect();
        assert_eq!(
            tail,
            vec![&AgentEvent::End { session_id: None }, &AgentEvent::Cancelled, &AgentEvent::Record { record: Record::Stopped }]
        );
        let space = dir.join("spaces/school");
        let saved = thread::load(&space).unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[1]["content"][0], json!({"type": "text", "text": "Half an ans"}));
        let ui = thread::to_ui(&saved);
        assert_eq!((ui[1].text.as_str(), ui[1].index, ui[1].records.clone()), ("Half an ans", 1, vec![Record::Stopped]));

        // The next request carries the kept text, without the record.
        let p = Scripted::new(vec![done()]);
        run(&dir, &p, &Approvals::default(), "go on", |_| {});
        let sent = p.seen.lock().unwrap()[0].clone();
        assert_eq!(sent[1], json!({"role": "assistant", "content": [{"type": "text", "text": "Half an ans"}]}));
        assert_eq!(sent.len(), 3);

        // Stopped before any text: the reply is only the stopped record, and
        // the request after it leaves that message out entirely.
        let runs = Runs::default();
        let stall = Stall { stop: Some(runs.clone()), ..Stall::new("") };
        let mut events = vec![];
        tauri::async_runtime::block_on(run_turn(
            &runs,
            &Approvals::default(),
            &stall,
            LoopRequest { space_id: "school", space_dir: &space, vault_root: &dir, prompt: "again", attachments: vec![], replace_from: None },
            |e| events.push(e),
        ));
        assert!(events.contains(&AgentEvent::Record { record: Record::Stopped }) && events.contains(&AgentEvent::Cancelled));
        let saved = thread::load(&space).unwrap();
        let last = saved.last().unwrap();
        assert_eq!(last["content"].as_array().unwrap().len(), 1);
        assert_eq!(thread::Record::from_block(&last["content"][0]), Some(Record::Stopped));
        let ui = thread::to_ui(&saved);
        assert_eq!((ui.last().unwrap().text.as_str(), ui.last().unwrap().records.clone()), ("", vec![Record::Stopped]));
        let wire = thread::for_provider(&saved);
        assert_eq!(wire.len(), saved.len() - 1);
        assert!(!serde_json::to_string(&wire).unwrap().contains("phaethon_record"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn provider_errors_keep_partial_text_and_carry_the_wait() {
        let dir = setup("err");
        let stall = Stall::new("Working on");
        *stall.fail.lock().unwrap() = Some(ProviderError {
            kind: ErrorKind::RateLimit,
            message: "Wait 42 seconds.".into(),
            retry_after: Some(42),
        });
        let events = run_stoppable(&dir, &stall, &Approvals::default(), |_| false);
        let err = events.iter().find(|e| matches!(e, AgentEvent::Error { .. })).unwrap().clone();
        assert_eq!(err, AgentEvent::Error { code: ErrorCode::RateLimit, message: "Wait 42 seconds.".into(), retry_after_secs: Some(42) });
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v, json!({"kind": "error", "code": "rateLimit", "message": "Wait 42 seconds.", "retryAfterSecs": 42}));
        assert!(serde_json::to_value(AgentEvent::error(ErrorCode::Billing, "x")).unwrap().get("retryAfterSecs").is_none());
        let saved = thread::load(&dir.join("spaces/school")).unwrap();
        assert_eq!(thread::to_ui(&saved)[1].text, "Working on");
        assert!(records_in(&dir).is_empty(), "an error is not a stop");
        for (kind, code) in [
            (ErrorKind::Billing, "billing"),
            (ErrorKind::Unavailable, "unavailable"),
            (ErrorKind::BadRequest, "badRequest"),
            (ErrorKind::Auth, "apiKey"),
            (ErrorKind::Network, "network"),
        ] {
            assert_eq!(serde_json::to_value(error_code(kind)).unwrap(), code);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn write_call(id: &str, path: &str, contents: &str) -> Result<ModelTurn, ProviderError> {
        turn(json!([{"type": "tool_use", "id": id, "name": "write_file", "input": {"path": path, "contents": contents}}]), "tool_use")
    }

    #[test]
    fn approvals_say_create_or_replace_with_full_contents_and_are_recorded() {
        let dir = setup("approval");
        let approvals = Approvals::default();
        let seen: Arc<StdMutex<Vec<AgentEvent>>> = Arc::default();
        let answer = |allow: bool| {
            let (answerer, seen) = (approvals.clone(), seen.clone());
            move |e: &AgentEvent| {
                if let AgentEvent::Approval { id, .. } = e {
                    seen.lock().unwrap().push(e.clone());
                    assert!(answerer.answer("school", id, allow));
                }
            }
        };
        // Create: no old contents.
        let p = Scripted::new(vec![write_call("w1", "./plans/week.md", "Mon\nTue\n"), done()]);
        let events = run(&dir, &p, &approvals, "plan", answer(true));
        let AgentEvent::Approval { summary, detail, action, path, space, before, truncated, .. } = seen.lock().unwrap()[0].clone() else { panic!() };
        assert_eq!((action, path.as_str(), space.as_str(), before, truncated), (WriteAction::Create, "plans/week.md", "school", None, false));
        assert_eq!(detail, "Mon\nTue\n");
        assert_eq!(summary, "Create a new file plans/week.md (2 lines).");
        let rec = Record::Approval { path: "plans/week.md".into(), action: WriteAction::Create, allowed: true };
        assert!(events.contains(&AgentEvent::Record { record: rec.clone() }));
        // The receipt comes after the card closes.
        let done_at = events.iter().position(|e| matches!(e, AgentEvent::ApprovalDone { .. })).unwrap();
        let rec_at = events.iter().position(|e| matches!(e, AgentEvent::Record { .. })).unwrap();
        assert!(rec_at > done_at);

        // Replace, declined: the old contents come along in full, and nothing changes.
        let big = "x".repeat(600 * 1024);
        let p = Scripted::new(vec![write_call("w2", "a.md", &big), done()]);
        run(&dir, &p, &approvals, "rewrite a", answer(false));
        let AgentEvent::Approval { summary, detail, action, before, truncated, .. } = seen.lock().unwrap()[1].clone() else { panic!() };
        assert_eq!(action, WriteAction::Replace);
        assert!(summary.starts_with("Replace the file a.md"), "{summary}");
        assert_eq!(before.as_deref(), Some("exam on friday"));
        assert!(truncated && detail.len() == PREVIEW_CAP);
        assert_eq!(std::fs::read_to_string(dir.join("spaces/school/a.md")).unwrap(), "exam on friday");

        // Both receipts are in the saved record, on their replies, and never sent to the model.
        assert_eq!(records_in(&dir), vec![rec, Record::Approval { path: "a.md".into(), action: WriteAction::Replace, allowed: false }]);
        let ui = thread::to_ui(&thread::load(&dir.join("spaces/school")).unwrap());
        assert_eq!(ui.iter().map(|m| m.records.len()).collect::<Vec<_>>(), vec![0, 1, 0, 1]);
        for request in p.seen.lock().unwrap().iter() {
            assert!(!serde_json::to_string(request).unwrap().contains("phaethon_record"));
        }

        // A write that could never happen is refused without asking.
        let p = Scripted::new(vec![write_call("w3", "@work/x.md", "x"), write_call("w4", "../x.md", "x"), write_call("w5", ".phaethon/thread.json", "[]"), done()]);
        let events = run(&dir, &p, &approvals, "sneaky", |_| {});
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Approval { .. })), "{events:?}");
        assert_eq!(last_result(&p, 1)["is_error"], true);
        assert_eq!(last_result(&p, 3)["is_error"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cap_cuts_on_a_character_boundary() {
        let s = format!("{}é", "a".repeat(PREVIEW_CAP - 1));
        let (cut, truncated) = cap(s);
        assert!(truncated && cut.len() == PREVIEW_CAP - 1);
        assert_eq!(cap("short".into()), ("short".to_string(), false));
    }

    fn run_from(dir: &Path, provider: &Scripted, prompt: &str, replace_from: Option<usize>) -> Vec<AgentEvent> {
        let mut events = vec![];
        tauri::async_runtime::block_on(run_turn(
            &Runs::default(),
            &Approvals::default(),
            provider,
            LoopRequest { space_id: "school", space_dir: &dir.join("spaces/school"), vault_root: dir, prompt, attachments: vec![], replace_from },
            |e| events.push(e),
        ));
        events
    }

    fn says(text: &str) -> Result<ModelTurn, ProviderError> {
        turn(json!([{"type": "text", "text": text}]), "end_turn")
    }

    #[test]
    fn replace_from_archives_then_cuts_at_a_user_message() {
        let dir = setup("edit");
        let space = dir.join("spaces/school");
        run_from(&dir, &Scripted::new(vec![says("one")]), "first", None);
        let p = Scripted::new(vec![turn(json!([{"type": "tool_use", "id": "t1", "name": "list_files", "input": {}}]), "tool_use"), says("two")]);
        run_from(&dir, &p, "second", None);
        let before = thread::load(&space).unwrap();
        let ui = thread::to_ui(&before);
        assert_eq!(ui.iter().map(|m| (m.role, m.index)).collect::<Vec<_>>(), vec![("user", 0), ("assistant", 1), ("user", 2), ("assistant", 3)]);

        // Not a user message (a reply, a tool result, out of range): refused, nothing sent or changed.
        for bad in [1, 4, 99] {
            let p = Scripted::new(vec![]);
            let events = run_from(&dir, &p, "nope", Some(bad));
            assert!(events.contains(&AgentEvent::error(ErrorCode::Storage, thread::STALE_EDIT)), "{bad}: {events:?}");
            assert!(p.seen.lock().unwrap().is_empty());
            assert_eq!(thread::load(&space).unwrap(), before);
        }
        assert_eq!(thread::list(&space).unwrap().len(), 1, "nothing archived for a refused edit");

        // Edit the second message: the old version is archived whole, then replaced.
        let p = Scripted::new(vec![says("three")]);
        run_from(&dir, &p, "second, edited", Some(2));
        let after = thread::load(&space).unwrap();
        assert_eq!(after.len(), 4);
        assert_eq!(after[..2], before[..2]);
        assert_eq!(thread::to_ui(&after)[2].text, "second, edited");
        assert_eq!(p.seen.lock().unwrap()[0].len(), 3, "the model sees the conversation up to the edit");
        let listed = thread::list(&space).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1].messages, 4);
        thread::open(&space, &listed[1].id).unwrap();
        assert_eq!(thread::load(&space).unwrap(), before, "the archived copy is the whole earlier version");

        // Regenerate the first message: same prompt, from index 0.
        let p = Scripted::new(vec![says("uno")]);
        run_from(&dir, &p, "first", Some(0));
        assert_eq!(thread::to_ui(&thread::load(&space).unwrap()).len(), 2);

        // Refused while a reply runs in the space.
        let runs = Runs::default();
        let _running = runs.claim("school").unwrap();
        let mut events = vec![];
        let now = thread::load(&space).unwrap();
        tauri::async_runtime::block_on(run_turn(
            &runs,
            &Approvals::default(),
            &Scripted::new(vec![]),
            LoopRequest { space_id: "school", space_dir: &space, vault_root: &dir, prompt: "x", attachments: vec![], replace_from: Some(0) },
            |e| events.push(e),
        ));
        assert!(matches!(events[0], AgentEvent::Error { code: ErrorCode::Busy, .. }));
        assert_eq!(thread::load(&space).unwrap(), now);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bad_input_and_escape_attempts_become_error_results() {
        let dir = setup("bad");
        let p = Scripted::new(vec![
            Ok(ModelTurn {
                content: vec![
                    json!({"type": "tool_use", "id": "a", "name": "read_file", "input": {"path": "../../etc/passwd"}}),
                    json!({"type": "tool_use", "id": "b", "name": "bash", "input": {"cmd": "ls"}}),
                    json!({"type": "tool_use", "id": "c", "name": "read_file", "input": {}}),
                ],
                stop_reason: "tool_use".into(),
                invalid_inputs: vec![("c".into(), "{\"path\": \"a".into())],
            }),
            turn(json!([{"type": "text", "text": "sorry"}]), "end_turn"),
        ]);
        run(&dir, &p, &Approvals::default(), "go", |_| {});
        let seen = p.seen.lock().unwrap();
        let results = seen[1].last().unwrap()["content"].as_array().unwrap().clone();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r["is_error"] == true), "{results:?}");
        assert!(results[0]["content"].as_str().unwrap().contains("inside this space"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `setup` plus a work space with calendar/oct.md.
    fn setup_cross(name: &str) -> PathBuf {
        let dir = setup(name);
        std::fs::create_dir_all(dir.join("spaces/work/calendar")).unwrap();
        std::fs::write(dir.join("spaces/work/calendar/oct.md"), "Oct 14: shift 9-5").unwrap();
        dir
    }

    fn read_oct(id: &str) -> Result<ModelTurn, ProviderError> {
        turn(json!([{"type": "tool_use", "id": id, "name": "read_file", "input": {"path": "@work/calendar/oct.md"}}]), "tool_use")
    }

    fn ask(id: &str) -> Result<ModelTurn, ProviderError> {
        turn(
            json!([{"type": "tool_use", "id": id, "name": "request_access", "input": {"space": "work", "path": "calendar/", "reason": "To plan study time around your shifts."}}]),
            "tool_use",
        )
    }

    fn done() -> Result<ModelTurn, ProviderError> {
        turn(json!([{"type": "text", "text": "ok"}]), "end_turn")
    }

    /// The tool_result sent back for the last tool call of request `n`.
    fn last_result(p: &Scripted, n: usize) -> Value {
        p.seen.lock().unwrap()[n].last().unwrap()["content"][0].clone()
    }

    fn grants_file(dir: &Path) -> PathBuf {
        dir.join(".phaethon/grants.json")
    }

    #[test]
    fn reading_another_space_without_a_grant_is_refused() {
        let dir = setup_cross("nogrant");
        let p = Scripted::new(vec![read_oct("r1"), done()]);
        let events = run(&dir, &p, &Approvals::default(), "when do I work?", |_| {});
        let r = last_result(&p, 1);
        assert_eq!(r["is_error"], true);
        assert!(r["content"].as_str().unwrap().contains("ask for access with request_access first"), "{r}");
        assert!(!r["content"].as_str().unwrap().contains("shift"));
        // A refused read is never labelled as a read.
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Tool { label } if label.starts_with("Reading"))), "{events:?}");
        // The prompt names the other space and says access needs a grant.
        let system = &p.systems.lock().unwrap()[0];
        assert!(system.contains("other spaces are: work.") && system.contains("request_access"), "{system}");
        assert!(system.contains("no standing access"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn access_once_lasts_for_the_turn_and_is_never_saved() {
        let dir = setup_cross("once");
        let p = Scripted::new(vec![ask("a1"), read_oct("r1"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        let events = run(&dir, &p, &approvals, "plan my week", move |e| {
            if let AgentEvent::AccessRequest { id, space, path, reason } = e {
                assert_eq!((space.as_str(), path.as_str()), ("work", "calendar"));
                assert!(reason.contains("shifts"));
                // A write answer cannot answer an access request.
                assert!(!answerer.answer("school", id, true));
                assert!(answerer.answer_access("school", id, AccessAnswer::Once));
            }
        });
        assert!(events.contains(&AgentEvent::AccessRequestDone { id: "a1".into(), answer: AccessAnswer::Once }));
        assert!(events.contains(&AgentEvent::Tool { label: "Reading work/calendar/oct.md".into() }), "{events:?}");
        assert_eq!(last_result(&p, 1)["is_error"].as_bool(), None);
        let read = last_result(&p, 2);
        assert_eq!(read["content"], "Oct 14: shift 9-5");
        assert!(read.get("is_error").is_none());
        assert!(!grants_file(&dir).exists(), "a once grant is never written");

        // The next turn has no access again.
        let p = Scripted::new(vec![read_oct("r2"), done()]);
        run(&dir, &p, &Approvals::default(), "and next week?", |_| {});
        assert_eq!(last_result(&p, 1)["is_error"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn access_always_is_saved_and_used_next_turn() {
        let dir = setup_cross("always");
        let p = Scripted::new(vec![ask("a1"), read_oct("r1"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        run(&dir, &p, &approvals, "plan my week", move |e| {
            if let AgentEvent::AccessRequest { id, .. } = e {
                assert!(answerer.answer_access("school", id, AccessAnswer::Always));
            }
        });
        assert_eq!(last_result(&p, 2)["content"], "Oct 14: shift 9-5");
        let saved = grants::for_space(&Vault::at(&dir), "school");
        assert_eq!(saved.len(), 1);
        assert_eq!((saved[0].from.as_str(), saved[0].path.as_str(), saved[0].scope), ("work", "calendar", grants::Scope::Always));
        assert!(std::fs::read_to_string(grants_file(&dir)).unwrap().contains("\"to\": \"school\""));

        // Next turn: no question asked, the read works, and the prompt lists the grant.
        let p = Scripted::new(vec![read_oct("r2"), done()]);
        let events = run(&dir, &p, &Approvals::default(), "and next week?", |e| {
            assert!(!matches!(e, AgentEvent::AccessRequest { .. }));
        });
        assert_eq!(last_result(&p, 1)["content"], "Oct 14: shift 9-5");
        assert!(events.contains(&AgentEvent::Tool { label: "Reading work/calendar/oct.md".into() }));
        assert!(p.systems.lock().unwrap()[0].contains("- @work/calendar"));
        // Asking again for something already covered does not bother the user.
        let p = Scripted::new(vec![ask("a2"), done()]);
        run(&dir, &p, &Approvals::default(), "again", |e| assert!(!matches!(e, AgentEvent::AccessRequest { .. })));
        assert!(last_result(&p, 1)["content"].as_str().unwrap().contains("already read"));

        // Revoked: refused again, without a restart.
        assert!(grants::revoke(&Vault::at(&dir), &saved[0].id).unwrap());
        let p = Scripted::new(vec![read_oct("r3"), done()]);
        run(&dir, &p, &Approvals::default(), "and now?", |_| {});
        assert_eq!(last_result(&p, 1)["is_error"], true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_grant_removed_mid_reply_leaves_the_prompt_at_the_next_model_call() {
        let dir = setup_cross("revokemid");
        let vault = Vault::at(&dir);
        let g = grants::add_always(&vault, "school", "work", "calendar").unwrap();
        let p = Scripted::new(vec![read_oct("r1"), read_oct("r2"), done()]);
        let mut revoked = false;
        run(&dir, &p, &Approvals::default(), "when do I work?", |e| {
            // The user removes the grant while the reply is still running.
            if matches!(e, AgentEvent::Tool { .. }) && !revoked {
                assert!(grants::revoke(&Vault::at(&dir), &g.id).unwrap());
                revoked = true;
            }
        });
        let systems = p.systems.lock().unwrap().clone();
        assert_eq!(systems.len(), 3);
        assert!(systems[0].contains("- @work/calendar"), "{}", systems[0]);
        for s in &systems[1..] {
            assert!(!s.contains("@work/calendar") && s.contains("no standing access"), "{s}");
        }
        assert_eq!(last_result(&p, 1)["content"], "Oct 14: shift 9-5");
        assert_eq!(last_result(&p, 2)["is_error"], true, "the read after removing is refused");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn access_denied_or_invalid_is_an_error_and_saves_nothing() {
        let dir = setup_cross("deny");
        let p = Scripted::new(vec![ask("a1"), read_oct("r1"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        let events = run(&dir, &p, &approvals, "plan my week", move |e| {
            if let AgentEvent::AccessRequest { id, .. } = e {
                assert!(answerer.answer_access("school", id, AccessAnswer::Deny));
            }
        });
        assert!(events.contains(&AgentEvent::AccessRequestDone { id: "a1".into(), answer: AccessAnswer::Deny }));
        let denied = last_result(&p, 1);
        assert_eq!(denied["is_error"], true);
        assert!(denied["content"].as_str().unwrap().contains("declined"));
        assert_eq!(last_result(&p, 2)["is_error"], true, "the read after a deny is refused");
        assert!(!grants_file(&dir).exists());

        // Invalid requests are refused without asking the user.
        let bad = |space: &str, path: &str| {
            json!({"type": "tool_use", "id": format!("b-{space}-{}", path.len()), "name": "request_access", "input": {"space": space, "path": path, "reason": "r"}})
        };
        let p = Scripted::new(vec![
            turn(json!([bad("school", "a.md"), bad("nope", "x"), bad("work", "../school"), bad("work", "/etc"), bad("work", ".phaethon"), bad("work", "missing"), bad("work", "")]), "tool_use"),
            done(),
        ]);
        let events = run(&dir, &p, &Approvals::default(), "go", |_| {});
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::AccessRequest { .. })));
        let results = p.seen.lock().unwrap()[1].last().unwrap()["content"].as_array().unwrap().clone();
        assert_eq!(results.len(), 7);
        assert!(results.iter().all(|r| r["is_error"] == true), "{results:?}");
        assert!(!grants_file(&dir).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_while_asking_counts_as_deny() {
        let dir = setup_cross("cancel");
        let p = Scripted::new(vec![ask("a1")]);
        let approvals = Approvals::default();
        let runs = Runs::default();
        let canceller = runs.clone();
        let mut events = vec![];
        tauri::async_runtime::block_on(run_turn(
            &runs,
            &approvals,
            &p,
            LoopRequest { space_id: "school", space_dir: &dir.join("spaces/school"), vault_root: &dir, prompt: "go", attachments: vec![], replace_from: None },
            |e| {
                if matches!(e, AgentEvent::AccessRequest { .. }) {
                    assert!(canceller.cancel("school"));
                }
                events.push(e)
            },
        ));
        assert!(events.contains(&AgentEvent::AccessRequestDone { id: "a1".into(), answer: AccessAnswer::Deny }));
        assert!(events.contains(&AgentEvent::Cancelled));
        assert!(!approvals.answer_access("school", "a1", AccessAnswer::Always), "nothing left waiting");
        assert!(!grants_file(&dir).exists());
        // Stopping is not a refusal: only the stop is recorded, so it can be asked again.
        assert_eq!(records_in(&dir), vec![Record::Stopped]);
        assert!(events.contains(&AgentEvent::Record { record: Record::Stopped }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn ask_for(id: &str, path: &str) -> Result<ModelTurn, ProviderError> {
        turn(
            json!([{"type": "tool_use", "id": id, "name": "request_access", "input": {"space": "work", "path": path, "reason": "r"}}]),
            "tool_use",
        )
    }

    #[test]
    fn a_denied_path_is_refused_without_asking_for_the_rest_of_the_conversation() {
        let dir = setup_cross("denied");
        std::fs::create_dir_all(dir.join("spaces/work/notes")).unwrap();
        let p = Scripted::new(vec![ask("a1"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        let events = run(&dir, &p, &approvals, "plan my week", move |e| {
            if let AgentEvent::AccessRequest { id, .. } = e {
                assert!(answerer.answer_access("school", id, AccessAnswer::Deny));
            }
        });
        let rec = Record::Access { space: "work".into(), path: "calendar".into(), answer: AccessAnswer::Deny };
        assert!(events.contains(&AgentEvent::Record { record: rec.clone() }));
        assert_eq!(records_in(&dir), vec![rec]);

        // A "restart": fresh state, everything read back from disk. The same
        // path and a narrower one are refused without a question; the model is told plainly.
        let p = Scripted::new(vec![ask_for("a2", "calendar"), ask_for("a3", "calendar/oct.md"), done()]);
        let events = run(&dir, &p, &Approvals::default(), "try again", |e| {
            assert!(!matches!(e, AgentEvent::AccessRequest { .. }), "asked again: {e:?}");
        });
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Record { .. })));
        for n in [1, 2] {
            let r = last_result(&p, n);
            assert_eq!(r["is_error"], true);
            assert!(r["content"].as_str().unwrap().contains("already declined"), "{r}");
        }

        // A different folder is still asked about.
        let p = Scripted::new(vec![ask_for("a4", "notes"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        let events = run(&dir, &p, &approvals, "notes?", move |e| {
            if let AgentEvent::AccessRequest { id, .. } = e {
                assert!(answerer.answer_access("school", id, AccessAnswer::Once));
            }
        });
        assert!(events.iter().any(|e| matches!(e, AgentEvent::AccessRequest { path, .. } if path == "notes")));

        // A new conversation starts with a clean slate.
        thread::start_new(&dir.join("spaces/school")).unwrap();
        let p = Scripted::new(vec![ask("a5"), done()]);
        let approvals = Approvals::default();
        let answerer = approvals.clone();
        let events = run(&dir, &p, &approvals, "plan my week", move |e| {
            if let AgentEvent::AccessRequest { id, .. } = e {
                assert!(answerer.answer_access("school", id, AccessAnswer::Deny));
            }
        });
        assert!(events.iter().any(|e| matches!(e, AgentEvent::AccessRequest { .. })));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_deny_holds_after_regenerate_and_edit() {
        let dir = setup_cross("denyregen");
        let space = dir.join("spaces/school");
        // Answers any question with Once (so a wrongly asked one shows up rather than hanging).
        let send = |script: Vec<Result<ModelTurn, ProviderError>>, prompt: &str, replace_from: Option<usize>, answer: AccessAnswer| {
            let p = Scripted::new(script);
            let approvals = Approvals::default();
            let answerer = approvals.clone();
            let mut events = vec![];
            tauri::async_runtime::block_on(run_turn(
                &Runs::default(),
                &approvals,
                &p,
                LoopRequest { space_id: "school", space_dir: &space, vault_root: &dir, prompt, attachments: vec![], replace_from },
                |e| {
                    if let AgentEvent::AccessRequest { id, .. } = &e {
                        assert!(answerer.answer_access("school", id, answer));
                    }
                    events.push(e)
                },
            ));
            (p, events)
        };
        let asked = |events: &[AgentEvent]| events.iter().any(|e| matches!(e, AgentEvent::AccessRequest { .. }));

        let (_, events) = send(vec![ask("a1"), done()], "plan my week", None, AccessAnswer::Deny);
        assert!(asked(&events));

        // Regenerate the reply (same message, from index 0): the model asks
        // again, and is told it was declined without the user being asked.
        let (p, events) = send(vec![ask("a2"), read_oct("r2"), done()], "plan my week", Some(0), AccessAnswer::Once);
        assert!(!asked(&events), "{events:?}");
        assert!(last_result(&p, 1)["content"].as_str().unwrap().contains("already declined"));
        assert_eq!(last_result(&p, 2)["is_error"], true);
        assert!(!serde_json::to_string(&p.seen.lock().unwrap()[0]).unwrap().contains("phaethon_record"));
        // The UI shows the new version only: the old receipt is in the archived copy.
        let ui = thread::to_ui(&thread::load(&space).unwrap());
        assert_eq!(ui.iter().map(|m| m.role).collect::<Vec<_>>(), ["user", "assistant"]);
        assert!(ui[1].records.is_empty(), "{:?}", ui[1].records);

        // Edit the message: still declined.
        let index = ui[0].index;
        let (p, events) = send(vec![ask("a3"), done()], "plan my week, edited", Some(index), AccessAnswer::Once);
        assert!(!asked(&events));
        assert!(last_result(&p, 1)["content"].as_str().unwrap().contains("already declined"));

        // A new conversation is a clean slate.
        thread::start_new(&space).unwrap();
        let (_, events) = send(vec![ask("a4"), read_oct("r4"), done()], "plan my week", None, AccessAnswer::Once);
        assert!(asked(&events));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_in_other_spaces_are_recorded() {
        let dir = setup_cross("readrec");
        grants::add_always(&Vault::at(&dir), "school", "work", "calendar").unwrap();
        let p = Scripted::new(vec![
            turn(
                json!([
                    {"type": "tool_use", "id": "r1", "name": "read_file", "input": {"path": "@work/calendar/./oct.md"}},
                    {"type": "tool_use", "id": "r2", "name": "search_files", "input": {"query": "shift", "path": "@work/calendar"}},
                    {"type": "tool_use", "id": "r3", "name": "list_files", "input": {"path": "@work/calendar/"}},
                    {"type": "tool_use", "id": "r4", "name": "read_file", "input": {"path": "@work/secret.md"}},
                    {"type": "tool_use", "id": "r5", "name": "read_file", "input": {"path": "@school/a.md"}},
                    {"type": "tool_use", "id": "r6", "name": "read_file", "input": {"path": "a.md"}}
                ]),
                "tool_use",
            ),
            done(),
        ]);
        let events = run(&dir, &p, &Approvals::default(), "when do I work?", |_| {});
        let read = |path: &str, tool, query: Option<&str>| Record::Read { space: "work".into(), path: path.into(), tool, query: query.map(String::from) };
        let expected = vec![
            read("calendar/oct.md", ReadTool::Read, None),
            read("calendar", ReadTool::Search, Some("shift")),
            read("calendar", ReadTool::List, None),
        ];
        let live: Vec<Record> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Record { record } => Some(record.clone()),
                _ => None,
            })
            .collect();
        // Refused reads (no grant) and reads in this space are not recorded.
        assert_eq!(live, expected);
        assert_eq!(records_in(&dir), expected);
        let json = serde_json::to_value(&expected[1]).unwrap();
        assert_eq!(json, json!({"kind": "read", "space": "work", "path": "calendar", "tool": "search", "query": "shift"}));
        assert!(serde_json::to_value(&expected[0]).unwrap().get("query").is_none());
        assert!(!serde_json::to_string(&p.seen.lock().unwrap()[1]).unwrap().contains("phaethon_record"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_prompt_carries_this_spaces_memory_only_and_messages_keep_their_time() {
        let dir = std::env::temp_dir().join(format!("phaethon-loop-memory-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for s in ["school", "work"] {
            std::fs::create_dir_all(dir.join("spaces").join(s)).unwrap();
        }
        memory::append(&dir.join("spaces/school"), &["M301 exam is Oct 21.".into()], "1").unwrap();
        memory::append(&dir.join("spaces/work"), &["Shift on Tuesdays.".into()], "2").unwrap();
        let school = system_prompt(&dir, "school");
        assert!(school.contains("- M301 exam is Oct 21.") && school.contains("What the user chose to keep"), "{school}");
        assert!(!school.contains("Tuesdays"), "another space's memory never reaches this prompt");
        let work = system_prompt(&dir, "work");
        assert!(work.contains("Shift on Tuesdays.") && !work.contains("M301"));

        let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let p = Scripted::new(vec![tool_then_text_a(), done()]);
        run(&dir, &p, &Approvals::default(), "what's in here?", |_| {});
        assert!(p.systems.lock().unwrap().iter().all(|s| s.contains("M301 exam is Oct 21.")));
        // Saved with their times; never sent with them.
        let saved = thread::load(&dir.join("spaces/school")).unwrap();
        assert_eq!(saved.len(), 4);
        assert!(saved.iter().all(|m| m["at"].as_u64().is_some_and(|t| t >= before)), "{saved:?}");
        assert!(p.seen.lock().unwrap().iter().flatten().all(|m| m.get("at").is_none()));
        let ui = thread::to_ui(&saved);
        assert_eq!(ui.len(), 2);
        assert_eq!(ui[0].at, saved[0]["at"].as_u64());
        assert_eq!(ui[1].at, saved[3]["at"].as_u64(), "a reply's time is when it finished");
        assert_eq!(serde_json::to_value(&ui[0]).unwrap()["at"], saved[0]["at"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_prompt_indexes_this_spaces_courses_only() {
        let dir = std::env::temp_dir().join(format!("phaethon-loop-courses-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for s in ["school", "work"] {
            std::fs::create_dir_all(dir.join("spaces").join(s)).unwrap();
        }
        let mut st = crate::lms::store::Store::default();
        let mut conn = crate::lms::store::Conn {
            id: "canvas-x".into(),
            kind: crate::lms::Kind::Canvas,
            address: "https://x".into(),
            school_name: None,
            last_sync: None,
            courses: Default::default(),
        };
        let course = crate::lms::store::CourseState { name: "Calculus II".into(), folder: "Calculus II".into(), ..Default::default() };
        conn.courses.insert("1".into(), course);
        st.connections.push(conn);
        crate::lms::store::save(&dir.join("spaces/school"), &st).unwrap();
        let school = system_prompt(&dir, "school");
        assert!(school.contains("# Courses") && school.contains("- Calculus II: courses/Calculus II/"), "{school}");
        let work = system_prompt(&dir, "work");
        assert!(!work.contains("Calculus") && !work.contains("# Courses"), "another space's courses never reach this prompt");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn tool_then_text_a() -> Result<ModelTurn, ProviderError> {
        turn(json!([{"type": "text", "text": "Looking."}, {"type": "tool_use", "id": "t1", "name": "list_files", "input": {}}]), "tool_use")
    }
}
