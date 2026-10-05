//! steward's own agent loop: a model provider plus steward's space-scoped
//! tools. Nothing from the user's global agent setup is loaded; the model sees
//! only the system prompt built here, the vault's MANUAL.md and this space.
//!
//! One turn: append the user's message, then call the model, run any tools it
//! asks for (writes only after the user allows them), and repeat until it
//! answers. The thread file is saved after every step, so a crash or a cancel
//! loses at most the step in flight.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::agent::{AgentEvent, ErrorCode, Runs};
use crate::provider::{Delta, ErrorKind, ModelRequest, Provider};
use crate::{thread, tools};

/// Model calls allowed in one turn before steward stops the agent.
const MAX_STEPS: usize = 30;
/// Characters of a pending write shown in the approval card.
const PREVIEW_CHARS: usize = 4000;

const BASE_PROMPT: &str = "You are steward, a personal assistant working inside one space of the user's vault. \
The space is a folder of the user's own files. You can see only this space, through your tools; every path is relative to the space root. \
Look at files before answering questions about them rather than guessing. \
Writing a file always asks the user first. If they decline, accept that and do not retry the same write; ask what they would like instead. \
Write plainly and keep replies short. Your replies are often read aloud by screen readers, so use headings, lists and tables only when they genuinely help.";

/// Space id -> (approval id, where the answer goes).
type Pending = HashMap<String, (String, oneshot::Sender<bool>)>;

/// Pending write approvals, one per space at most (tools run one at a time).
#[derive(Default, Clone)]
pub struct Approvals {
    inner: Arc<Mutex<Pending>>,
}

impl Approvals {
    fn wait(&self, space: &str, id: &str) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .lock()
            .unwrap()
            .insert(space.to_string(), (id.to_string(), tx));
        rx
    }

    fn drop_pending(&self, space: &str) {
        self.inner.lock().unwrap().remove(space);
    }

    /// The user's answer to approval `id` in `space`. False if nothing with
    /// that id is waiting (already answered, cancelled, or a stale card).
    pub fn answer(&self, space: &str, id: &str, allow: bool) -> bool {
        let mut map = self.inner.lock().unwrap();
        match map.get(space) {
            Some((pending, _)) if pending == id => {
                let (_, tx) = map.remove(space).expect("present");
                tx.send(allow).is_ok()
            }
            _ => false,
        }
    }
}

pub struct LoopRequest<'a> {
    pub space_id: &'a str,
    pub space_dir: &'a Path,
    pub vault_root: &'a Path,
    pub prompt: &'a str,
}

/// The system prompt: steward's own instructions plus the vault's MANUAL.md.
/// Stable across turns so the prompt cache keeps working.
pub fn system_prompt(vault_root: &Path, space_id: &str) -> String {
    let mut s = format!("{BASE_PROMPT}\n\nThis space is called \"{space_id}\".");
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
    msgs.push(thread::user_text(req.prompt));
    if let Err(e) = thread::save(req.space_dir, &msgs) {
        return fail(emit, ErrorCode::Storage, format!("The conversation could not be saved, so nothing was sent: {e}"));
    }
    let system = system_prompt(req.vault_root, req.space_id);
    let tool_defs = tools::definitions();
    let mut emitted_text = false;

    for _ in 0..MAX_STEPS {
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
                ModelRequest { system: &system, messages: &msgs, tools: &tool_defs },
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
                        tools::Access::Read => {
                            emit(AgentEvent::Tool { label: tools::label(&call) });
                            run_tool(req.space_dir, call).await
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
                                run_tool(req.space_dir, call).await
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

async fn run_tool(space: &Path, call: tools::Call) -> Result<String, String> {
    let space: PathBuf = space.to_path_buf();
    tokio::task::spawn_blocking(move || tools::run(&space, &call))
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
    use std::sync::Mutex as StdMutex;

    /// Plays back scripted turns and records every request it was sent.
    struct Scripted {
        turns: StdMutex<Vec<Result<ModelTurn, ProviderError>>>,
        seen: StdMutex<Vec<Vec<Value>>>,
    }

    impl Scripted {
        fn new(turns: Vec<Result<ModelTurn, ProviderError>>) -> Self {
            Self { turns: StdMutex::new(turns.into_iter().rev().collect()), seen: StdMutex::new(vec![]) }
        }
    }

    impl Provider for Scripted {
        async fn turn(
            &self,
            req: ModelRequest<'_>,
            on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
        ) -> Result<ModelTurn, ProviderError> {
            self.seen.lock().unwrap().push(req.messages.to_vec());
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
            LoopRequest { space_id: "school", space_dir: &space, vault_root: dir, prompt },
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
}
