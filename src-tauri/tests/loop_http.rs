//! steward's whole agent turn over real HTTP against a local fake Anthropic
//! server: model asks to write a file, the user allows it, the file is written
//! inside the space, the model answers, and the thread file holds it all.
//! No network, no keychain.

use std::sync::{Arc, Mutex};

use serde_json::json;
use steward_lib::agent::{AgentEvent, Runs};
use steward_lib::agent_loop::{self, Approvals, LoopRequest};
use steward_lib::anthropic::Anthropic;
use steward_lib::thread;
use tokio::net::TcpListener;

mod common;
use common::{reply, serve};

#[tokio::test(flavor = "multi_thread")]
async fn write_with_approval_over_http() {
    let vault = std::env::temp_dir().join(format!("steward-loop-http-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    let space = vault.join("spaces/school");
    std::fs::create_dir_all(&space).unwrap();
    std::fs::write(vault.join("MANUAL.md"), "Keep it short.").unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    // SAFETY: set before any request; this test binary has a single test.
    unsafe { std::env::set_var("STEWARD_ANTHROPIC_BASE_URL", format!("http://{}", listener.local_addr().unwrap())) };
    let bodies = Arc::new(Mutex::new(vec![]));
    let server = tokio::spawn(serve(
        listener,
        vec![
            reply(
                vec![
                    json!({"type": "text", "text": "I'll write the plan."}),
                    json!({"type": "tool_use", "id": "toolu_1", "name": "write_file", "input": {"path": "plans/week.md", "contents": "Mon: study C241\n"}}),
                ],
                "tool_use",
            ),
            reply(vec![json!({"type": "text", "text": "Saved plans/week.md."})], "end_turn"),
        ],
        bodies.clone(),
    ));

    let provider = Anthropic::new("sk-test".into(), None, None);
    let approvals = Approvals::default();
    let answerer = approvals.clone();
    let mut events = vec![];
    agent_loop::run_turn(
        &Runs::default(),
        &approvals,
        &provider,
        LoopRequest { space_id: "school", space_dir: &space, vault_root: &vault, prompt: "plan my week", attachments: vec![] },
        |e| {
            if let AgentEvent::Approval { id, .. } = &e {
                // The file must not exist until the user answers.
                assert!(!space.join("plans/week.md").exists());
                assert!(answerer.answer("school", id, true));
            }
            events.push(e);
        },
    )
    .await;
    server.await.unwrap();

    eprintln!("{events:#?}");
    assert_eq!(std::fs::read_to_string(space.join("plans/week.md")).unwrap(), "Mon: study C241\n");
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Text { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "I'll write the plan.\n\nSaved plans/week.md.");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Approval { summary, detail, .. }
        if summary == "Create a new file plans/week.md (1 line)." && detail == "Mon: study C241\n")));
    assert_eq!(events.last(), Some(&AgentEvent::End { session_id: None }));

    // What went over the wire: the manual in the system prompt, tools defined,
    // and on the second request the tool_use echoed with its result.
    let bodies = bodies.lock().unwrap();
    assert!(bodies[0]["system"][0]["text"].as_str().unwrap().contains("Keep it short."));
    assert_eq!(bodies[0]["tools"].as_array().unwrap().len(), 5);
    let second = bodies[1]["messages"].as_array().unwrap();
    assert_eq!(second[1]["content"][1]["input"]["path"], "plans/week.md");
    assert_eq!(second[2]["content"][0]["tool_use_id"], "toolu_1");
    assert!(second[2]["content"][0].get("is_error").is_none());

    let saved = thread::load(&space).unwrap();
    assert_eq!(saved.len(), 4);
    let ui = thread::to_ui(&saved);
    assert_eq!(ui[1].text, "I'll write the plan.\n\nSaved plans/week.md.");
    std::fs::remove_dir_all(&vault).unwrap();
}
