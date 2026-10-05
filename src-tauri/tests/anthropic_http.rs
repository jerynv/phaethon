//! The Anthropic provider over real HTTP, against a local fake server: checks
//! the request steward sends and that a reply streamed in awkward chunks
//! (one splits a multi-byte character) comes back intact. No network.

use serde_json::{Value, json};
use steward_lib::anthropic::Anthropic;
use steward_lib::provider::{Delta, ErrorKind, ModelRequest, Provider};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Accept one connection, return the raw request, and reply with `status` and
/// `body` split into the given chunks.
async fn serve_once(listener: TcpListener, status: &'static str, chunks: Vec<Vec<u8>>) -> String {
    let (mut sock, _) = listener.accept().await.unwrap();
    let mut req = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = sock.read(&mut buf).await.unwrap();
        req.extend_from_slice(&buf[..n]);
        let text = String::from_utf8_lossy(&req);
        if let Some(h) = text.find("\r\n\r\n") {
            let len: usize = text[..h]
                .lines()
                .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            if req.len() >= h + 4 + len {
                break;
            }
        }
    }
    let total: usize = chunks.iter().map(Vec::len).sum();
    sock.write_all(format!("HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\nconnection: close\r\ncontent-length: {total}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    for c in chunks {
        sock.write_all(&c).await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    String::from_utf8_lossy(&req).into_owned()
}

fn sse(events: &[Value]) -> Vec<u8> {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
        .collect::<String>()
        .into_bytes()
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_over_http() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // SAFETY: set once, before any thread reads it; this test binary has one test using it.
    unsafe { std::env::set_var("STEWARD_ANTHROPIC_BASE_URL", format!("http://{addr}")) };

    let body = sse(&[
        json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Café ☕ ready"}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
        json!({"type": "message_stop"}),
    ]);
    // Split inside the 3-byte "☕" and in the middle of an event.
    let cut = body.windows(3).position(|w| w == "☕".as_bytes()).unwrap() + 1;
    let chunks = vec![body[..7].to_vec(), body[7..cut].to_vec(), body[cut..].to_vec()];
    let server = tokio::spawn(serve_once(listener, "200 OK", chunks));

    let provider = Anthropic::new("sk-test-key".into(), None, None);
    let msgs = vec![json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})];
    let tools = json!([]);
    let mut text = String::new();
    let turn = provider
        .turn(
            ModelRequest { system: "sys", messages: &msgs, tools: &tools },
            &mut |d: Delta<'_>| {
                if let Delta::Text(t) = d {
                    text.push_str(t)
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(text, "Café ☕ ready");
    assert_eq!(turn.content, vec![json!({"type": "text", "text": "Café ☕ ready"})]);

    let req = server.await.unwrap();
    let lower = req.to_lowercase();
    assert!(req.starts_with("POST /v1/messages "), "{req}");
    assert!(lower.contains("x-api-key: sk-test-key"));
    assert!(lower.contains("anthropic-version: 2023-06-01"));
    assert!(lower.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    let sent: Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
    assert_eq!(sent["model"], "claude-opus-5-5");
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["fallbacks"], "default");
    assert_eq!(sent["output_config"]["effort"], "medium");
    assert!(sent.get("thinking").is_none(), "Opus 5.5 rejects disabled thinking; leave it unset");

    // A rejected key maps to Auth with a message that does not echo the key.
    let listener = TcpListener::bind(addr).await.unwrap();
    let err_body = br#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.to_vec();
    let server = tokio::spawn(serve_once(listener, "401 Unauthorized", vec![err_body]));
    let err = provider
        .turn(ModelRequest { system: "sys", messages: &msgs, tools: &tools }, &mut |_| {})
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(err.kind, ErrorKind::Auth);
    assert!(!err.message.contains("sk-test"));
}
