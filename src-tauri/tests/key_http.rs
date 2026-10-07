//! The key check, the model list and rate-limit handling over real HTTP,
//! against a local fake Anthropic server. No network, no keychain.

use std::sync::{Arc, Mutex};

use phaethon_lib::anthropic::{self, Anthropic, KeyProblem};
use phaethon_lib::provider::{ErrorKind, ModelRequest, Provider};
use serde_json::json;
use tokio::net::TcpListener;

mod common;
use common::{Canned, serve_canned};

fn canned(status: &'static str, body: serde_json::Value) -> Canned {
    Canned { status, headers: vec![], body: body.to_string() }
}

fn error_body(kind: &str, message: &str) -> serde_json::Value {
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

#[tokio::test(flavor = "multi_thread")]
async fn key_check_models_and_rate_limits_over_http() {
    let key = format!("sk-ant-api03-{}", "k".repeat(90));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base = format!("http://{addr}");
    let requests = Arc::new(Mutex::new(vec![]));
    let server = tokio::spawn(serve_canned(
        listener,
        vec![
            canned("200 OK", json!({"data": [{"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"}]})),
            canned("401 Unauthorized", error_body("authentication_error", "invalid x-api-key")),
            canned("402 Payment Required", error_body("billing_error", "no credit")),
            canned("400 Bad Request", error_body("invalid_request_error", "Your credit balance is too low to access the Anthropic API.")),
            canned("403 Forbidden", error_body("permission_error", "nope")),
            canned("429 Too Many Requests", error_body("rate_limit_error", "slow down")),
            canned("503 Service Unavailable", error_body("api_error", "down")),
            // Model list: a real list (with an id that isn't a model name, which is dropped), then a failure.
            canned(
                "200 OK",
                json!({"data": [
                    {"type": "model", "id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5"},
                    {"type": "model", "id": "claude-haiku-5-5", "display_name": ""},
                    {"type": "model", "id": "../../etc", "display_name": "bad"}
                ]}),
            ),
            canned("401 Unauthorized", error_body("authentication_error", "invalid x-api-key")),
        ],
        requests.clone(),
    ));

    let check = |k: String| {
        let base = base.clone();
        async move { anthropic::check_key_at(&base, &k).await }
    };
    let ok = check(format!("  {key}\n")).await;
    assert!(ok.ok && ok.problem.is_none(), "{ok:?}");
    let expected = [
        (false, Some(KeyProblem::Rejected)),
        (false, Some(KeyProblem::Billing)),
        (false, Some(KeyProblem::Billing)),
        (false, Some(KeyProblem::Rejected)),
        (true, None),
        (false, Some(KeyProblem::Network)),
    ];
    for (i, (want_ok, want_problem)) in expected.into_iter().enumerate() {
        let r = check(key.clone()).await;
        assert_eq!((r.ok, r.problem), (want_ok, want_problem), "response {}: {r:?}", i + 2);
        let shown = serde_json::to_string(&r).unwrap();
        assert!(!shown.contains("sk-ant") && !shown.contains("x-api-key"), "{shown}");
        assert!(!r.message.is_empty());
    }
    // A key in the wrong shape never leaves the machine.
    let before = requests.lock().unwrap().len();
    for bad in ["", "sk-proj-123", "sk-ant-short", "sk-ant-has spaces in it ok"] {
        let r = check(bad.into()).await;
        assert_eq!((r.ok, r.problem), (false, Some(KeyProblem::Format)), "{bad:?}");
        assert_eq!(serde_json::to_value(&r).unwrap()["problem"], "format");
    }
    assert_eq!(requests.lock().unwrap().len(), before);

    let listed = anthropic::list_models_at(&base, &key).await.unwrap();
    assert_eq!(
        listed.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect::<Vec<_>>(),
        vec![("claude-sonnet-5-5", "Claude Sonnet 5.5"), ("claude-haiku-5-5", "claude-haiku-5-5")]
    );
    assert!(anthropic::list_models_at(&base, &key).await.is_none());
    assert_eq!(anthropic::models_or_fallback(None).await, anthropic::fallback_models());
    server.await.unwrap();

    // What was sent: a GET for the model list with the trimmed key and the API version.
    let reqs = requests.lock().unwrap().clone();
    assert!(reqs[0].starts_with("GET /v1/models?limit=1 "), "{}", reqs[0]);
    let lower = reqs[0].to_lowercase();
    assert!(lower.contains(&format!("x-api-key: {key}\r\n")) && lower.contains("anthropic-version: 2023-06-01"));
    assert!(reqs[7].starts_with("GET /v1/models?limit=100 "));

    // Nothing listening: a network problem, said plainly.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let r = anthropic::check_key_at(&dead, &key).await;
    assert_eq!((r.ok, r.problem), (false, Some(KeyProblem::Network)));
    assert!(anthropic::list_models_at(&dead, &key).await.is_none());

    // A long rate-limit wait is reported at once with its wait time, not sat through.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    // SAFETY: set before the provider below is built; no other test in this binary reads it.
    unsafe { std::env::set_var("PHAETHON_ANTHROPIC_BASE_URL", format!("http://{}", listener.local_addr().unwrap())) };
    let requests = Arc::new(Mutex::new(vec![]));
    let server = tokio::spawn(serve_canned(
        listener,
        vec![
            Canned { status: "429 Too Many Requests", headers: vec!["retry-after: 120".into()], body: error_body("rate_limit_error", "slow").to_string() },
            canned("402 Payment Required", error_body("billing_error", "no credit")),
        ],
        requests.clone(),
    ));
    let provider = Anthropic::new(key.clone(), None, None);
    let msgs = vec![json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})];
    let tools = json!([]);
    let started = std::time::Instant::now();
    let err = provider.turn(ModelRequest { system: "s", messages: &msgs, tools: &tools }, &mut |_| {}).await.unwrap_err();
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "no retry for a 2-minute wait");
    assert_eq!((err.kind, err.retry_after), (ErrorKind::RateLimit, Some(120)));
    assert!(err.message.contains("2 minutes"), "{}", err.message);
    let err = provider.turn(ModelRequest { system: "s", messages: &msgs, tools: &tools }, &mut |_| {}).await.unwrap_err();
    assert_eq!((err.kind, err.retry_after), (ErrorKind::Billing, None));
    assert!(!err.message.contains("sk-ant"));
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
}
