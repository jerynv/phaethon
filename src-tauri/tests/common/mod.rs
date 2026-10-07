//! A local fake Anthropic server for loop tests: plays back scripted SSE
//! replies, one per connection, and records each request body.
//! Each test binary uses only some of these helpers.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
        .collect()
}

/// One streamed model reply made of `blocks` (text or tool_use).
pub fn reply(blocks: Vec<Value>, stop: &str) -> String {
    let mut ev = vec![json!({"type": "message_start", "message": {}})];
    for (i, b) in blocks.into_iter().enumerate() {
        match b["type"].as_str().unwrap() {
            "text" => {
                ev.push(json!({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}));
                ev.push(json!({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}}));
            }
            _ => {
                let input = b["input"].to_string();
                let mut start = b.clone();
                start["input"] = json!({});
                ev.push(json!({"type": "content_block_start", "index": i, "content_block": start}));
                ev.push(json!({"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": input}}));
            }
        }
        ev.push(json!({"type": "content_block_stop", "index": i}));
    }
    ev.push(json!({"type": "message_delta", "delta": {"stop_reason": stop}}));
    ev.push(json!({"type": "message_stop"}));
    sse(&ev)
}

/// One canned HTTP response: status line (e.g. "401 Unauthorized"), extra
/// header lines, and a body.
pub struct Canned {
    pub status: &'static str,
    pub headers: Vec<String>,
    pub body: String,
}

/// Serve `responses` in order, one per connection, and record each raw
/// request (head and body) as text. Handles requests without a body (GET).
pub async fn serve_canned(listener: TcpListener, responses: Vec<Canned>, requests: Arc<Mutex<Vec<String>>>) {
    for r in responses {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req).into_owned();
            if let Some(h) = text.find("\r\n\r\n") {
                let len: usize = text[..h]
                    .lines()
                    .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                if req.len() >= h + 4 + len || n == 0 {
                    break;
                }
            }
        }
        requests.lock().unwrap().push(String::from_utf8_lossy(&req).into_owned());
        let extra: String = r.headers.iter().map(|h| format!("{h}\r\n")).collect();
        sock.write_all(
            format!(
                "HTTP/1.1 {}\r\ncontent-type: application/json\r\nconnection: close\r\n{extra}content-length: {}\r\n\r\n{}",
                r.status,
                r.body.len(),
                r.body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    }
}

/// Serve the scripted replies in order, one per connection; record request bodies.
pub async fn serve(listener: TcpListener, replies: Vec<String>, bodies: Arc<Mutex<Vec<Value>>>) {
    for body in replies {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 65536];
        let json_body = loop {
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req).into_owned();
            if let Some(h) = text.find("\r\n\r\n") {
                let len: usize = text[..h]
                    .lines()
                    .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap();
                if req.len() >= h + 4 + len {
                    break serde_json::from_slice::<Value>(&req[h + 4..h + 4 + len]).unwrap();
                }
            }
        };
        bodies.lock().unwrap().push(json_body);
        sock.write_all(
            format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len())
                .as_bytes(),
        )
        .await
        .unwrap();
    }
}
