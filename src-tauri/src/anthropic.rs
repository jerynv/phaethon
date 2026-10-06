//! Anthropic Messages API provider: raw HTTP with server-sent events (there is
//! no official Rust SDK). The key comes from the keychain via the Rust core and
//! never reaches the webview.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::provider::{Delta, ErrorKind, ModelRequest, ModelTurn, Provider, ProviderError};

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// Claude Opus 5.5 defaults to `medium`; set it explicitly so a model change
/// does not silently change depth.
pub const DEFAULT_EFFORT: &str = "medium";
const API_VERSION: &str = "2023-06-01";
/// `fallbacks: "default"`: if a safety classifier declines a request, the API
/// retries it on the model Anthropic recommends for that category.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 64_000;
/// Longest silence allowed between two chunks of a streaming reply.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
const RETRIES: u32 = 3;

pub struct Anthropic {
    http: reqwest::Client,
    key: String,
    model: String,
    effort: String,
    base_url: String,
}

impl Anthropic {
    pub fn new(key: String, model: Option<String>, effort: Option<String>) -> Self {
        #[allow(unused_mut)]
        let mut base_url = "https://api.anthropic.com".to_string();
        #[cfg(debug_assertions)]
        if let Ok(u) = std::env::var("PHAETHON_ANTHROPIC_BASE_URL") {
            // Debug builds only: lets tests point at a local fake server.
            base_url = u;
        }
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .build()
                .expect("http client builds"),
            key,
            model: model.unwrap_or_else(|| DEFAULT_MODEL.into()),
            effort: effort.unwrap_or_else(|| DEFAULT_EFFORT.into()),
            base_url,
        }
    }

    fn body(&self, req: &ModelRequest<'_>) -> Value {
        json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            // Caches the longest stable prefix (tools, system, history so far).
            "cache_control": {"type": "ephemeral"},
            "output_config": {"effort": self.effort},
            "fallbacks": "default",
            "system": [{"type": "text", "text": req.system}],
            "tools": req.tools,
            "messages": req.messages,
        })
    }
}

impl Provider for Anthropic {
    async fn turn(
        &self,
        req: ModelRequest<'_>,
        on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
    ) -> Result<ModelTurn, ProviderError> {
        let body = self.body(&req);
        let mut attempt = 0;
        let resp = loop {
            attempt += 1;
            let sent = self
                .http
                .post(format!("{}/v1/messages", self.base_url))
                .header("x-api-key", &self.key)
                .header("anthropic-version", API_VERSION)
                .header("anthropic-beta", FALLBACK_BETA)
                .json(&body)
                .send()
                .await;
            let resp = match sent {
                Ok(r) => r,
                Err(e) if attempt < RETRIES => {
                    let _ = e;
                    tokio::time::sleep(backoff(attempt, None)).await;
                    continue;
                }
                Err(e) => {
                    return Err(ProviderError {
                        kind: ErrorKind::Network,
                        message: format!("Could not reach Anthropic: {e}"),
                    });
                }
            };
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                break resp;
            }
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok());
            let text = resp.text().await.unwrap_or_default();
            let err = http_error(status, &text);
            let retryable = matches!(err.kind, ErrorKind::RateLimit | ErrorKind::Unavailable);
            if retryable && attempt < RETRIES {
                tokio::time::sleep(backoff(attempt, retry_after)).await;
                continue;
            }
            return Err(err);
        };

        let mut acc = Accumulator::default();
        // Bytes, not text: a multi-byte character can be split across chunks.
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        loop {
            let chunk = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
                Err(_) => {
                    return Err(ProviderError {
                        kind: ErrorKind::Network,
                        message: "Anthropic stopped responding in the middle of a reply.".into(),
                    });
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    return Err(ProviderError {
                        kind: ErrorKind::Network,
                        message: format!("The connection to Anthropic dropped: {e}"),
                    });
                }
                Ok(Some(Ok(bytes))) => bytes,
            };
            buf.extend_from_slice(&chunk);
            while let Some(event) = split_event(&mut buf) {
                acc.feed_event(&event, on_delta)?;
            }
        }
        acc.finish()
    }
}

fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    match retry_after {
        Some(s) => Duration::from_secs(s.min(30)),
        None => Duration::from_millis(1000 * 2u64.pow(attempt - 1)),
    }
}

fn http_error(status: u16, body: &str) -> ProviderError {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_default();
    let (kind, message) = match status {
        401 => (ErrorKind::Auth, "Anthropic rejected the API key. Check it in Settings.".to_string()),
        403 => (ErrorKind::Auth, format!("This API key is not allowed to do that. {detail}")),
        402 => (ErrorKind::Billing, format!("Anthropic reported a billing problem on this account. {detail}")),
        429 => (ErrorKind::RateLimit, "Anthropic's rate limit was reached. Wait a minute, then try again.".to_string()),
        400 | 404 | 413 => (ErrorKind::BadRequest, format!("Anthropic refused the request: {detail}")),
        _ => (ErrorKind::Unavailable, format!("Anthropic is unavailable right now (status {status}). Try again shortly.")),
    };
    ProviderError { kind, message: message.trim().to_string() }
}

/// Take one complete SSE event (ended by a blank line) off the front of `buf`.
/// The separator is ASCII, so the event is always whole UTF-8.
fn split_event(buf: &mut Vec<u8>) -> Option<String> {
    let find = |pat: &[u8]| buf.windows(pat.len()).position(|w| w == pat).map(|i| (i, pat.len()));
    let (i, n) = match (find(b"\n\n"), find(b"\r\n\r\n")) {
        (Some(a), Some(b)) => if a.0 < b.0 { a } else { b },
        (a, b) => a.or(b)?,
    };
    let event = String::from_utf8_lossy(&buf[..i]).into_owned();
    buf.drain(..i + n);
    Some(event)
}

/// Builds the assistant message from stream events.
#[derive(Default)]
struct Accumulator {
    blocks: Vec<Value>,
    /// Raw `input_json_delta` text per block index (tool_use blocks only).
    json: Vec<Option<String>>,
    stop_reason: Option<String>,
    invalid: Vec<(String, String)>,
    stopped: bool,
}

impl Accumulator {
    fn feed_event(
        &mut self,
        event: &str,
        on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
    ) -> Result<(), ProviderError> {
        let data: String = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.strip_prefix(' ').unwrap_or(d))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(());
        }
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            return Ok(());
        };
        let index = v["index"].as_u64().map(|i| i as usize);
        match v["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let i = index.unwrap_or(self.blocks.len());
                let block = v["content_block"].clone();
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                    self.json.push(None);
                }
                if block["type"] == "tool_use" {
                    self.json[i] = Some(String::new());
                }
                if block["type"] == "text" {
                    on_delta(Delta::TextStart);
                    if let Some(t) = block["text"].as_str().filter(|t| !t.is_empty()) {
                        on_delta(Delta::Text(t));
                    }
                }
                self.blocks[i] = block;
            }
            "content_block_delta" => {
                let Some(block) = index.and_then(|i| self.blocks.get_mut(i)) else {
                    return Ok(());
                };
                let d = &v["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = d["text"].as_str().unwrap_or("");
                        append(block, "text", t);
                        if !t.is_empty() {
                            on_delta(Delta::Text(t));
                        }
                    }
                    "thinking_delta" => append(block, "thinking", d["thinking"].as_str().unwrap_or("")),
                    "signature_delta" => block["signature"] = d["signature"].clone(),
                    "input_json_delta" => {
                        if let Some(Some(s)) = index.and_then(|i| self.json.get_mut(i)) {
                            s.push_str(d["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    "citations_delta" => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(a) = block["citations"].as_array_mut() {
                            a.push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let Some(i) = index else { return Ok(()) };
                if let (Some(block), Some(Some(raw))) = (self.blocks.get_mut(i), self.json.get(i)) {
                    if raw.trim().is_empty() {
                        block["input"] = json!({});
                    } else {
                        match serde_json::from_str::<Value>(raw) {
                            Ok(input) => block["input"] = input,
                            Err(_) => {
                                // Keep the block well-formed for the history; the loop answers it with an error.
                                block["input"] = json!({});
                                let id = block["id"].as_str().unwrap_or("").to_string();
                                self.invalid.push((id, raw.clone()));
                            }
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(r.to_string());
                }
            }
            "message_stop" => self.stopped = true,
            "error" => {
                let kind = match v["error"]["type"].as_str() {
                    Some("overloaded_error" | "api_error") => ErrorKind::Unavailable,
                    Some("rate_limit_error") => ErrorKind::RateLimit,
                    _ => ErrorKind::BadRequest,
                };
                let msg = v["error"]["message"].as_str().unwrap_or("unknown error");
                return Err(ProviderError {
                    kind,
                    message: format!("Anthropic stopped the reply: {msg}"),
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Result<ModelTurn, ProviderError> {
        if !self.stopped || self.stop_reason.is_none() {
            return Err(ProviderError {
                kind: ErrorKind::Network,
                message: "The reply from Anthropic ended early. Try again.".into(),
            });
        }
        Ok(ModelTurn {
            content: echo_safe(self.blocks.into_iter().filter(|b| !b.is_null()).collect()),
            stop_reason: self.stop_reason.unwrap_or_default(),
            invalid_inputs: self.invalid,
        })
    }
}

fn append(block: &mut Value, key: &str, s: &str) {
    let cur = block[key].as_str().unwrap_or("").to_string();
    block[key] = Value::String(cur + s);
}

/// After a mid-reply fallback, only text blocks from before the last `fallback`
/// marker may be sent back; thinking and tool_use blocks there belong to the
/// declined attempt.
fn echo_safe(blocks: Vec<Value>) -> Vec<Value> {
    let Some(last) = blocks.iter().rposition(|b| b["type"] == "fallback") else {
        return blocks;
    };
    blocks
        .into_iter()
        .enumerate()
        .filter(|(i, b)| *i >= last || b["type"] == "text")
        .map(|(_, b)| b)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_sse(raw: &str) -> (Result<ModelTurn, ProviderError>, Vec<String>) {
        let mut acc = Accumulator::default();
        let mut seen = vec![];
        let mut buf = raw.as_bytes().to_vec();
        let mut on = |d: Delta<'_>| match d {
            Delta::TextStart => seen.push("<start>".to_string()),
            Delta::Text(t) => seen.push(t.to_string()),
        };
        while let Some(ev) = split_event(&mut buf) {
            if let Err(e) = acc.feed_event(&ev, &mut on) {
                return (Err(e), seen);
            }
        }
        (acc.finish(), seen)
    }

    fn sse(events: &[Value]) -> String {
        events
            .iter()
            .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
            .collect()
    }

    #[test]
    fn text_thinking_and_tool_use() {
        let raw = sse(&[
            json!({"type": "message_start", "message": {"model": "claude-opus-5-5"}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "abc"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me "}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "look."}}),
            json!({"type": "content_block_stop", "index": 1}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "t1", "name": "read_file", "input": {}}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"path\": \"a"}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": ".md\"}"}}),
            json!({"type": "content_block_stop", "index": 2}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            json!({"type": "message_stop"}),
        ]);
        let (turn, seen) = run_sse(&raw);
        let turn = turn.unwrap();
        assert_eq!(seen, vec!["<start>", "Let me ", "look."]);
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(
            turn.content,
            vec![
                json!({"type": "thinking", "thinking": "", "signature": "abc"}),
                json!({"type": "text", "text": "Let me look."}),
                json!({"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "a.md"}}),
            ]
        );
        assert!(turn.invalid_inputs.is_empty());
    }

    #[test]
    fn bad_tool_json_crlf_and_truncation() {
        let raw = sse(&[
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t9", "name": "write_file", "input": {}}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"path\": \"a.md\", \"contents\": \"cut"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}),
            json!({"type": "message_stop"}),
        ])
        .replace('\n', "\r\n");
        let turn = run_sse(&raw).0.unwrap();
        assert_eq!(turn.stop_reason, "max_tokens");
        assert_eq!(turn.content[0]["input"], json!({}));
        assert_eq!(turn.invalid_inputs[0].0, "t9");

        // A stream that ends without message_stop is an error, not a short reply.
        let cut = sse(&[json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "Hi"}})]);
        assert!(matches!(run_sse(&cut).0, Err(ProviderError { kind: ErrorKind::Network, .. })));
    }

    #[test]
    fn stream_error_event() {
        let raw = sse(&[json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})]);
        assert!(matches!(run_sse(&raw).0, Err(ProviderError { kind: ErrorKind::Unavailable, .. })));
    }

    #[test]
    fn fallback_keeps_only_text_before_the_marker() {
        let blocks = vec![
            json!({"type": "thinking", "thinking": "", "signature": "x"}),
            json!({"type": "text", "text": "partial"}),
            json!({"type": "tool_use", "id": "t", "name": "list_files", "input": {}}),
            json!({"type": "fallback", "from": {"model": "a"}, "to": {"model": "b"}}),
            json!({"type": "thinking", "thinking": "", "signature": "y"}),
            json!({"type": "text", "text": "rest"}),
        ];
        let kept: Vec<_> = echo_safe(blocks).iter().map(|b| b["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(kept, vec!["text", "fallback", "thinking", "text"]);
    }

    #[test]
    fn http_errors_map_to_plain_messages() {
        let e = http_error(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#);
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(!e.message.contains("x-api-key"));
        assert_eq!(http_error(529, "").kind, ErrorKind::Unavailable);
        assert_eq!(http_error(429, "").kind, ErrorKind::RateLimit);
        assert!(http_error(404, r#"{"error":{"message":"model: nope"}}"#).message.contains("model: nope"));
    }
}
