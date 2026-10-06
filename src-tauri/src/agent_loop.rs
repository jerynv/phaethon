//! steward's own agent loop: a model provider plus steward's space-scoped
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
use crate::vault::Vault;
use crate::{attachments, thread, tools};

/// Model calls allowed in one turn before steward stops the agent.
const MAX_STEPS: usize = 30;
/// Characters of a pending write shown in the approval card.
const PREVIEW_CHARS: usize = 4000;

const BASE_PROMPT: &str = "You are steward, a personal assistant working inside one space of the user's vault. \
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
}

/// The system prompt: steward's own instructions, the other spaces and this
/// space's grants, plus the vault's MANUAL.md. Stable across turns (spaces and
/// grants are sorted) so the prompt cache keeps working until they change.
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
        emit(AgentEvent::Error {
            code: ErrorCode::Busy,
            message: "This space is still answering the previous message. Stop it or wait for it to finish.".into(),
        });
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
        emit(AgentEvent::Error { code, message })
    };
    let mut msgs = match thread::load(req.space_dir) {
        Ok(m) => m,
        Err(e) => {
            return fail(emit, ErrorCode::Storage, format!("This space's conversation file could not be read, so nothing was sent: {e}"));
        }
    };
    msgs.push(thread::user_message(req.prompt, &req.attachments));
    if let Err(e) = thread::save(req.space_dir, &msgs) {
        return fail(emit, ErrorCode::Storage, format!("The conversation could not be saved, so nothing was sent: {e}"));
    }
    let system = system_prompt(req.vault_root, req.space_id);
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
        let wire = attachments::expand(req.space_dir, &msgs);
        let result = {
            let mut on_delta = |d: Delta<'_>| match d {
                Delta::TextStart if emitted_text => emit(AgentEvent::Text { delta: "\n\n".into() }),
                Delta::TextStart => {}
                Delta::Text(t) => {
                    emitted_text = true;
                    emit(AgentEvent::Text { delta: t.to_string() });
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
            None => return emit(AgentEvent::Cancelled),
            Some(Err(e)) => return fail(emit, error_code(e.kind), e.message),
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
        msgs.push(json!({"role": "assistant", "content": turn.content}));
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
                            // Shown only once the read is allowed and done, so the
                            // conversation never claims a read that was refused.
                            let label = tools::label(&call);
                            let r = run_tool(ctx(&once), call).await;
                            if r.is_ok() {
                                emit(AgentEvent::Tool { label });
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
                                        Err("Not asked: the user stopped the reply.".into())
                                    } else {
                                        match answer {
                                            AccessAnswer::Deny => Err(format!(
                                                "The user declined access to {shown}. Do not ask for it again unless they bring it up; work without it or ask them what they would like."
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
                        tools::Access::Write => {
                            emit(AgentEvent::Tool { label: format!("Waiting for you to allow: {}", tools::label(&call)) });
                            let (summary, detail) = describe_write(req.space_dir, &call);
                            let answer = approvals.wait(req.space_id, &id);
                            emit(AgentEvent::Approval { id: id.clone(), summary, detail });
                            let allowed = tokio::select! {
                                a = answer => a.unwrap_or(false),
                                _ = &mut cancel_rx => { cancelled = true; false }
                            };
                            approvals.drop_pending(req.space_id);
                            emit(AgentEvent::ApprovalDone { id: id.clone(), allowed: allowed && !cancelled });
                            if cancelled {
                                Err("Not run: the user stopped the reply.".into())
                            } else if allowed {
                                emit(AgentEvent::Tool { label: tools::label(&call) });
                                run_tool(ctx(&once), call).await
                            } else {
                                Err("The user declined this write. Nothing was changed.".into())
                            }
                        }
                    },
                }
            };
            results.push(match outcome {
                Ok(text) => json!({"type": "tool_result", "tool_use_id": id, "content": text}),
                Err(text) => json!({"type": "tool_result", "tool_use_id": id, "content": text, "is_error": true}),
            });
        }
        msgs.push(json!({"role": "user", "content": results}));
        if let Err(e) = thread::save(req.space_dir, &msgs) {
            return fail(emit, ErrorCode::Storage, format!("The conversation could not be saved: {e}"));
        }
        if cancelled {
            return emit(AgentEvent::Cancelled);
        }
    }
    fail(emit, ErrorCode::Provider, format!("steward stopped the agent after {MAX_STEPS} steps. Send another message to let it continue."));
}

async fn run_tool(ctx: tools::Ctx, call: tools::Call) -> Result<String, String> {
    tokio::task::spawn_blocking(move || tools::run_in(&ctx, &call))
        .await
        .unwrap_or_else(|e| Err(format!("the tool crashed: {e}")))
}

/// Plain-language summary and preview for the approval card.
fn describe_write(space: &Path, call: &tools::Call) -> (String, String) {
    let tools::Call::Write { path, contents } = call else {
        return (tools::label(call), String::new());
    };
    let exists = tools::resolve(space, path, false).map(|p| p.is_file()).unwrap_or(false);
    let what = if exists { "Replace the file" } else { "Create a new file" };
    let lines = contents.lines().count();
    let summary = format!("{what} {path} ({lines} line{}).", if lines == 1 { "" } else { "s" });
    (summary, truncate(contents, PREVIEW_CHARS))
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
        ErrorKind::Billing | ErrorKind::RateLimit | ErrorKind::Unavailable | ErrorKind::BadRequest => ErrorCode::Provider,
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
        let dir = std::env::temp_dir().join(format!("steward-loop-{name}-{}", std::process::id()));
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
            LoopRequest { space_id: "school", space_dir: &space, vault_root: dir, prompt, attachments: vec![] },
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

        let p = Scripted::new(vec![Err(ProviderError { kind: ErrorKind::Auth, message: "bad key".into() })]);
        let events = run(&dir, &p, &Approvals::default(), "hi again", |_| {});
        assert!(events.contains(&AgentEvent::Error { code: ErrorCode::ApiKey, message: "bad key".into() }));
        assert_eq!(events.last(), Some(&AgentEvent::End { session_id: None }));
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
        dir.join(".steward/grants.json")
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
            turn(json!([bad("school", "a.md"), bad("nope", "x"), bad("work", "../school"), bad("work", "/etc"), bad("work", ".steward"), bad("work", "missing"), bad("work", "")]), "tool_use"),
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
            LoopRequest { space_id: "school", space_dir: &dir.join("spaces/school"), vault_root: &dir, prompt: "go", attachments: vec![] },
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
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
