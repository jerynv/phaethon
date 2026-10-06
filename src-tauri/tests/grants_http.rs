//! A cross-space turn over real HTTP against a local fake Anthropic server: the
//! model asks to read the work calendar from the school space, the user
//! answers "always", the model reads it with an `@work/` path, and the grant is
//! saved in the vault. No network, no keychain.

use std::sync::{Arc, Mutex};

use serde_json::json;
use steward_lib::agent::{AgentEvent, Runs};
use steward_lib::agent_loop::{self, Approvals, LoopRequest};
use steward_lib::anthropic::Anthropic;
use steward_lib::grants::{self, AccessAnswer};
use steward_lib::vault::Vault;
use tokio::net::TcpListener;

mod common;
use common::{reply, serve};

#[tokio::test(flavor = "multi_thread")]
async fn ask_then_read_another_space_over_http() {
    let vault = std::env::temp_dir().join(format!("steward-grants-http-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    let school = vault.join("spaces/school");
    std::fs::create_dir_all(&school).unwrap();
    std::fs::create_dir_all(vault.join("spaces/work/calendar")).unwrap();
    std::fs::write(vault.join("spaces/work/calendar/oct.md"), "Oct 14: shift 9-5\n").unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    // SAFETY: set before any request; this test binary has a single test.
    unsafe { std::env::set_var("STEWARD_ANTHROPIC_BASE_URL", format!("http://{}", listener.local_addr().unwrap())) };
    let bodies = Arc::new(Mutex::new(vec![]));
    let server = tokio::spawn(serve(
        listener,
        vec![
            reply(
                vec![json!({"type": "tool_use", "id": "toolu_1", "name": "request_access", "input": {"space": "work", "path": "calendar", "reason": "To fit study time around your shifts."}})],
                "tool_use",
            ),
            reply(
                vec![json!({"type": "tool_use", "id": "toolu_2", "name": "read_file", "input": {"path": "@work/calendar/oct.md"}})],
                "tool_use",
            ),
            reply(vec![json!({"type": "text", "text": "You work Oct 14, so study on the 13th."})], "end_turn"),
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
        LoopRequest { space_id: "school", space_dir: &school, vault_root: &vault, prompt: "plan my study week", attachments: vec![] },
        |e| {
            if let AgentEvent::AccessRequest { id, space, path, .. } = &e {
                assert_eq!((space.as_str(), path.as_str()), ("work", "calendar"));
                assert!(answerer.answer_access("school", id, AccessAnswer::Always));
            }
            events.push(e);
        },
    )
    .await;
    server.await.unwrap();

    eprintln!("{events:#?}");
    assert!(events.contains(&AgentEvent::AccessRequestDone { id: "toolu_1".into(), answer: AccessAnswer::Always }));
    assert!(events.contains(&AgentEvent::Tool { label: "Reading work/calendar/oct.md".into() }));
    assert_eq!(events.last(), Some(&AgentEvent::End { session_id: None }));

    let bodies = bodies.lock().unwrap();
    let tools: Vec<&str> = bodies[0]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(tools, ["list_files", "read_file", "search_files", "write_file", "request_access"]);
    let system = bodies[0]["system"][0]["text"].as_str().unwrap();
    assert!(system.contains("other spaces are: work."), "{system}");
    let granted = &bodies[1]["messages"].as_array().unwrap()[2]["content"][0];
    assert_eq!(granted["tool_use_id"], "toolu_1");
    assert!(granted.get("is_error").is_none());
    let read = &bodies[2]["messages"].as_array().unwrap()[4]["content"][0];
    assert_eq!(read["tool_use_id"], "toolu_2");
    assert_eq!(read["content"], "Oct 14: shift 9-5\n");

    let saved = grants::for_space(&Vault::at(&vault), "school");
    assert_eq!(saved.len(), 1);
    assert_eq!((saved[0].from.as_str(), saved[0].path.as_str()), ("work", "calendar"));
    std::fs::remove_dir_all(&vault).unwrap();
}
