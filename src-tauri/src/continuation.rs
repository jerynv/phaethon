//! Continue a reply the user stopped, without asking the question again.
//!
//! Current models refuse a trailing assistant message (prefill), so the
//! stopped text stays where it is and one hidden user message asks the model
//! to carry on from it: `{"type": "phaethon_continue"}`, saved as a user
//! message of its own. The UI never shows it ([`thread::to_ui`] shows only
//! user messages with text or files), so the continuation joins the stopped
//! reply as one message after a reload. On the wire ([`Wire`]) the block
//! becomes [`INSTRUCTION`]; every request goes through `Wire`, so the history
//! stays the same from one call to the next and returned thinking stays valid.
//!
//! The turn itself is Phaethon's own loop (tools and approvals included). Once
//! it has produced anything, the stopped record on the earlier part is
//! removed: the reply is no longer stopped there (a stop during the
//! continuation records its own). If nothing came back, the hidden message is
//! taken out again and the reply stays as it was. Records are never sent to
//! the provider, so neither change alters what the model has seen.

use std::path::Path;

use serde_json::{Value, json};

use crate::agent::{AgentEvent, ErrorCode, Runs};
use crate::agent_loop::{self, Approvals, LoopRequest};
use crate::provider::{Delta, ModelRequest, ModelTurn, Provider, ProviderError};
use crate::thread::{self, Record};

pub const BLOCK_TYPE: &str = "phaethon_continue";

/// What the model reads in place of the hidden message.
pub const INSTRUCTION: &str = "[The user stopped your previous reply part-way and asked you to continue it. \
Carry on from exactly where it stopped. Your continuation is shown straight after the stopped text, as a new paragraph: \
if it stopped mid-sentence, begin by writing that whole sentence again; otherwise do not repeat anything already written. \
Do not mention the interruption.]";

/// Said when the reply to continue is not (or no longer) the stopped last reply.
pub const STALE: &str =
    "That reply can’t be continued: the conversation has changed since it was shown. Reload the conversation and try again.";

/// The hidden block that asks for a continuation.
pub fn block() -> Value {
    json!({"type": BLOCK_TYPE})
}

fn is_block(b: &Value) -> bool {
    b["type"] == BLOCK_TYPE
}

/// A user message that is only the hidden request.
fn is_request(m: &Value) -> bool {
    m["role"] == "user" && m["content"].as_array().is_some_and(|c| !c.is_empty() && c.iter().all(is_block))
}

/// The thread as the provider gets it: each hidden request as its instruction text.
pub fn to_wire(msgs: &[Value]) -> Vec<Value> {
    msgs.iter()
        .map(|m| match m["content"].as_array() {
            Some(blocks) if blocks.iter().any(is_block) => {
                let content: Vec<Value> = blocks
                    .iter()
                    .map(|b| if is_block(b) { json!({"type": "text", "text": INSTRUCTION}) } else { b.clone() })
                    .collect();
                json!({"role": m["role"], "content": content})
            }
            _ => m.clone(),
        })
        .collect()
}

/// A provider whose requests carry hidden continue requests as text. Every
/// provider Phaethon's loop uses is wrapped in this.
pub struct Wire<P>(pub P);

impl<P: Provider> Provider for Wire<P> {
    async fn turn(
        &self,
        req: ModelRequest<'_>,
        on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
    ) -> Result<ModelTurn, ProviderError> {
        let messages = to_wire(req.messages);
        self.0.turn(ModelRequest { system: req.system, messages: &messages, tools: req.tools }, on_delta).await
    }
}

/// Where the stopped record of the reply that starts at `from` is, when that
/// reply is the last one shown, was stopped and has text to carry on from.
pub fn stopped_reply(msgs: &[Value], from: usize) -> Result<usize, String> {
    let ui = thread::to_ui(msgs);
    let ok = ui.last().is_some_and(|m| {
        m.role == "assistant" && m.index == from && !m.text.trim().is_empty() && m.records.contains(&Record::Stopped)
    });
    if !ok {
        return Err(STALE.into());
    }
    (from..msgs.len())
        .rev()
        .find(|&i| has_stopped(&msgs[i]))
        .ok_or_else(|| STALE.into())
}

fn has_stopped(m: &Value) -> bool {
    m["content"].as_array().is_some_and(|c| c.iter().any(|b| Record::from_block(b) == Some(Record::Stopped)))
}

pub struct ContinueRequest<'a> {
    pub space_id: &'a str,
    pub space_dir: &'a Path,
    pub vault_root: &'a Path,
    /// The `index` (from `thread_load`) of the stopped reply.
    pub from: usize,
}

/// Continue the stopped reply. Always ends with exactly one `AgentEvent::End`.
/// `provider` should be a [`Wire`].
pub async fn run_turn<P: Provider>(
    runs: &Runs,
    approvals: &Approvals,
    provider: &P,
    req: ContinueRequest<'_>,
    mut emit: impl FnMut(AgentEvent) + Send,
) {
    let checked = thread::load(req.space_dir)
        .map_err(|e| format!("This space’s conversation file couldn’t be read, so nothing was sent: {e}"))
        .and_then(|msgs| stopped_reply(&msgs, req.from).map(|at| (msgs.len(), at)));
    let (start, stopped_at) = match checked {
        Ok(v) => v,
        Err(message) => {
            emit(AgentEvent::error(ErrorCode::Storage, message));
            return emit(AgentEvent::End { session_id: None });
        }
    };
    let turn = LoopRequest {
        space_id: req.space_id,
        space_dir: req.space_dir,
        vault_root: req.vault_root,
        prompt: "",
        attachments: vec![block()],
        replace_from: None,
    };
    // The loop's End is held back until the thread is tidied, so the UI reads it afterwards.
    agent_loop::run_turn(runs, approvals, provider, turn, |ev| {
        if !matches!(ev, AgentEvent::End { .. }) {
            emit(ev)
        }
    })
    .await;
    // Busy means another turn already started on top: it then owns the thread.
    let _ = thread::while_idle(runs, req.space_id, || settle(req.space_dir, start, stopped_at).map_err(|e| e.to_string()));
    emit(AgentEvent::End { session_id: None });
}

/// After the turn: drop the earlier stopped record once something followed
/// the request, or the request itself when nothing did.
fn settle(dir: &Path, start: usize, stopped_at: usize) -> std::io::Result<()> {
    let mut msgs = thread::load(dir)?;
    if !msgs.get(start).is_some_and(is_request) {
        return Ok(());
    }
    if msgs.len() == start + 1 {
        msgs.pop();
    } else if let Some(content) = msgs.get_mut(stopped_at).and_then(|m| m["content"].as_array_mut())
        && let Some(i) = content.iter().rposition(|b| Record::from_block(b) == Some(Record::Stopped))
    {
        content.remove(i);
    }
    thread::save(dir, &msgs)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use super::*;
    use crate::provider::ErrorKind;

    struct Scripted {
        turns: Mutex<Vec<Result<ModelTurn, ProviderError>>>,
        seen: Mutex<Vec<Vec<Value>>>,
    }

    impl Scripted {
        fn new(turns: Vec<Result<ModelTurn, ProviderError>>) -> Self {
            Self { turns: Mutex::new(turns.into_iter().rev().collect()), seen: Mutex::new(vec![]) }
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

    fn text(t: &str) -> Result<ModelTurn, ProviderError> {
        Ok(ModelTurn {
            content: vec![json!({"type": "thinking", "thinking": "", "signature": "sig"}), json!({"type": "text", "text": t})],
            stop_reason: "end_turn".into(),
            invalid_inputs: vec![],
        })
    }

    fn setup(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-continue-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("spaces/school")).unwrap();
        dir
    }

    /// A question and a reply stopped part-way, as the loop saves it.
    fn stopped_thread() -> Vec<Value> {
        vec![
            thread::user_text("What is the capital of France?"),
            json!({"role": "assistant", "content": [{"type": "text", "text": "The capital of Fr"}, Record::Stopped.to_block()]}),
        ]
    }

    fn wire(turns: Vec<Result<ModelTurn, ProviderError>>) -> Wire<Scripted> {
        Wire(Scripted::new(turns))
    }

    fn cont(dir: &Path, p: &Wire<Scripted>, from: usize) -> Vec<AgentEvent> {
        let mut events = vec![];
        tauri::async_runtime::block_on(run_turn(
            &Runs::default(),
            &Approvals::default(),
            p,
            ContinueRequest { space_id: "school", space_dir: &dir.join("spaces/school"), vault_root: dir, from },
            |e| events.push(e),
        ));
        events
    }

    #[test]
    fn continue_sends_the_partial_reply_then_a_hidden_request_and_joins_the_answer() {
        let dir = setup("shape");
        let space = dir.join("spaces/school");
        thread::save(&space, &stopped_thread()).unwrap();
        let p = wire(vec![text("The capital of France is Paris.")]);
        let events = cont(&dir, &p, 1);
        assert_eq!(
            events,
            vec![AgentEvent::Text { delta: "The capital of France is Paris.".into() }, AgentEvent::End { session_id: None }]
        );

        // The request: the question once, the stopped text as the last assistant turn (no
        // record, no prefill), then the instruction as a user turn. Nothing else.
        let seen = p.0.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0],
            vec![
                thread::user_text("What is the capital of France?"),
                json!({"role": "assistant", "content": [{"type": "text", "text": "The capital of Fr"}]}),
                json!({"role": "user", "content": [{"type": "text", "text": INSTRUCTION}]}),
            ]
        );
        assert_eq!(seen[0].iter().filter(|m| m["role"] == "user").count(), 2);
        assert!(!serde_json::to_string(&seen[0]).unwrap().contains(BLOCK_TYPE));

        // Saved: the hidden request stays (so the history sent next time is the same), the
        // earlier stop is gone, and the UI shows one reply.
        let saved = thread::load(&space).unwrap();
        assert_eq!(saved.len(), 4);
        assert!(is_request(&saved[2]));
        assert!(!has_stopped(&saved[1]));
        let ui = thread::to_ui(&saved);
        assert_eq!(ui.len(), 2);
        assert_eq!((ui[1].index, ui[1].text.as_str()), (1, "The capital of Fr\n\nThe capital of France is Paris."));
        assert!(ui[1].records.is_empty());

        // The next ordinary message sends the same history (thinking blocks stay valid),
        // with the hidden request as text again.
        let p2 = wire(vec![text("Yes.")]);
        tauri::async_runtime::block_on(agent_loop::run_turn(
            &Runs::default(),
            &Approvals::default(),
            &p2,
            LoopRequest { space_id: "school", space_dir: &space, vault_root: &dir, prompt: "Sure?", attachments: vec![], replace_from: None },
            |_| {},
        ));
        let next = &p2.0.seen.lock().unwrap()[0];
        assert_eq!(next[..4], to_wire(&thread::for_provider(&saved))[..]);
        assert_eq!(next[2]["content"][0]["text"], INSTRUCTION);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_stopped_last_reply_can_be_continued() {
        let dir = setup("stale");
        let space = dir.join("spaces/school");
        thread::save(&space, &stopped_thread()).unwrap();
        let p = wire(vec![]);
        for from in [0, 2, 9] {
            let events = cont(&dir, &p, from);
            assert_eq!(events, vec![AgentEvent::error(ErrorCode::Storage, STALE), AgentEvent::End { session_id: None }]);
        }
        // A finished reply, or a stopped one with no text yet, is not continued either.
        let finished = vec![thread::user_text("q"), json!({"role": "assistant", "content": [{"type": "text", "text": "Done."}]})];
        assert_eq!(stopped_reply(&finished, 1), Err(STALE.into()));
        let empty = vec![thread::user_text("q"), json!({"role": "assistant", "content": [Record::Stopped.to_block()]})];
        assert_eq!(stopped_reply(&empty, 1), Err(STALE.into()));
        // Stopped while a write waited: the record is on the reply, tool results follow it.
        let mid_tool = vec![
            thread::user_text("q"),
            json!({"role": "assistant", "content": [{"type": "text", "text": "Writing it."}, {"type": "tool_use", "id": "t", "name": "write_file", "input": {}}, Record::Stopped.to_block()]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "Not run", "is_error": true}]}),
        ];
        assert_eq!(stopped_reply(&mid_tool, 1), Ok(1));
        assert!(p.0.seen.lock().unwrap().is_empty());
        assert_eq!(thread::load(&space).unwrap(), stopped_thread());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_continue_leaves_the_reply_as_it_was() {
        let dir = setup("fail");
        let space = dir.join("spaces/school");
        thread::save(&space, &stopped_thread()).unwrap();
        let p = wire(vec![Err(ProviderError::new(ErrorKind::Network, "offline"))]);
        let events = cont(&dir, &p, 1);
        assert!(matches!(events[0], AgentEvent::Error { code: ErrorCode::Network, .. }), "{events:?}");
        assert_eq!(events.last(), Some(&AgentEvent::End { session_id: None }));
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::End { .. })).count(), 1);
        assert_eq!(thread::load(&space).unwrap(), stopped_thread());
        // So it can be continued again.
        let p = wire(vec![text("ance is Paris.")]);
        cont(&dir, &p, 1);
        assert_eq!(thread::to_ui(&thread::load(&space).unwrap())[1].text, "The capital of Fr\n\nance is Paris.");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_continuation_stopped_again_can_be_continued_again() {
        let dir = setup("again");
        let space = dir.join("spaces/school");
        let mut msgs = stopped_thread();
        // As the loop saves a second stop: the continuation's text with its own stopped record.
        msgs.push(json!({"role": "user", "content": [block()]}));
        msgs.push(json!({"role": "assistant", "content": [{"type": "text", "text": "The capital of France is"}, Record::Stopped.to_block()]}));
        // The first stop's record was removed when the continuation began producing.
        msgs[1]["content"].as_array_mut().unwrap().pop();
        thread::save(&space, &msgs).unwrap();
        let ui = thread::to_ui(&msgs);
        assert_eq!((ui.len(), ui[1].index, ui[1].records.clone()), (2, 1, vec![Record::Stopped]));
        assert_eq!(stopped_reply(&msgs, 1), Ok(3));
        let p = wire(vec![text("The capital of France is Paris.")]);
        cont(&dir, &p, 1);
        let saved = thread::load(&space).unwrap();
        assert_eq!(saved.len(), 6);
        assert!(thread::records(&saved).next().is_none());
        let sent = &p.0.seen.lock().unwrap()[0];
        assert_eq!(sent.len(), 5);
        assert_eq!(sent[2]["content"][0]["text"], INSTRUCTION);
        assert_eq!(sent[4]["content"][0]["text"], INSTRUCTION);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
