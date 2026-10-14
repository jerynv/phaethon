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
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const RETRIES: u32 = 3;
/// Longest `retry-after` (seconds) Phaethon waits out itself before retrying.
pub(crate) const MAX_RETRY_WAIT: u64 = 30;

pub struct Anthropic {
    http: reqwest::Client,
    key: String,
    model: String,
    effort: String,
    base_url: String,
}

/// Where requests go: Anthropic, or in debug builds a local fake server named
/// by `PHAETHON_ANTHROPIC_BASE_URL` (tests only).
pub fn base_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("PHAETHON_ANTHROPIC_BASE_URL") {
        return u;
    }
    "https://api.anthropic.com".to_string()
}

pub(crate) fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .expect("http client builds")
}

impl Anthropic {
    pub fn new(key: String, model: Option<String>, effort: Option<String>) -> Self {
        Self {
            http: client(),
            key,
            model: model.unwrap_or_else(|| DEFAULT_MODEL.into()),
            effort: effort.unwrap_or_else(|| DEFAULT_EFFORT.into()),
            base_url: base_url(),
        }
    }

    fn body(&self, req: &ModelRequest<'_>) -> Value {
        let mut body = json!({
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
        });
        // A call without tools (picking out details to keep) sends none at all.
        if req.tools.as_array().is_some_and(|t| t.is_empty()) {
            body.as_object_mut().expect("an object").remove("tools");
        }
        body
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
                Err(_) => {
                    return Err(ProviderError::new(
                        ErrorKind::Network,
                        "Phaethon couldn’t reach Anthropic. Check your internet connection, then try again.",
                    ));
                }
            };
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                break resp;
            }
            let retry_after = retry_after(resp.headers());
            let text = resp.text().await.unwrap_or_default();
            let err = http_error(status, &text, retry_after);
            // A long requested wait is the user's to see (with its countdown), not ours to sit through.
            let retryable = matches!(err.kind, ErrorKind::RateLimit | ErrorKind::Unavailable)
                && retry_after.is_none_or(|s| s <= MAX_RETRY_WAIT);
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
                    return Err(ProviderError::new(
                        ErrorKind::Network,
                        "Anthropic stopped responding in the middle of the reply. Try again.",
                    ));
                }
                Ok(None) => break,
                Ok(Some(Err(_))) => {
                    return Err(ProviderError::new(
                        ErrorKind::Network,
                        "The connection to Anthropic dropped in the middle of the reply. Check your internet connection, then try again.",
                    ));
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

pub(crate) fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    match retry_after {
        Some(s) => Duration::from_secs(s.min(MAX_RETRY_WAIT)),
        None => Duration::from_millis(1000 * 2u64.pow(attempt - 1)),
    }
}

/// `retry-after` in whole seconds, when the server sent one we can read
/// (HTTP dates are rare from Anthropic and are ignored).
pub(crate) fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(|s| s.ceil() as u64)
}

const BILLING_MESSAGE: &str = "Your Anthropic account is out of credit or has a billing problem. Add credit at console.anthropic.com, then try again.";

/// Whether an error body says the account has no credit. Anthropic reports
/// that as a 400 as well as with `billing_error`.
fn is_billing(body: &Value) -> bool {
    body["error"]["type"] == "billing_error"
        || body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.to_lowercase().contains("credit balance"))
}

fn rate_limit_message(retry_after: Option<u64>) -> String {
    let lead = "Anthropic is limiting how fast this key can send messages.";
    match retry_after {
        Some(0 | 1) => format!("{lead} Try again in a moment."),
        Some(s) if s < 120 => format!("{lead} Try again in {s} seconds."),
        Some(s) => format!("{lead} Try again in {} minutes.", s.div_ceil(60)),
        None => format!("{lead} Wait a minute, then try again."),
    }
}

/// Map a failed HTTP response to a plain-language error. The key is never
/// part of the message.
fn http_error(status: u16, body: &str, retry_after: Option<u64>) -> ProviderError {
    let parsed = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let detail = parsed["error"]["message"].as_str().unwrap_or("");
    let (kind, message) = match status {
        _ if status == 402 || is_billing(&parsed) => (ErrorKind::Billing, BILLING_MESSAGE.to_string()),
        401 => (ErrorKind::Auth, "Anthropic didn’t accept your API key. Check it in Settings.".to_string()),
        403 => (
            ErrorKind::Auth,
            "Your API key isn’t allowed to do this. Check its permissions at console.anthropic.com.".to_string(),
        ),
        429 => (ErrorKind::RateLimit, rate_limit_message(retry_after)),
        400 | 404 | 413 | 422 => (ErrorKind::BadRequest, format!("Anthropic couldn’t accept this request. {detail}")),
        _ => (
            ErrorKind::Unavailable,
            "Anthropic is overloaded or having problems right now. Try again in a few minutes.".to_string(),
        ),
    };
    let retry_after = retry_after.filter(|_| matches!(kind, ErrorKind::RateLimit | ErrorKind::Unavailable));
    ProviderError { kind, message: message.trim().to_string(), retry_after }
}

// ---- Key check and model list -------------------------------------------

/// What a key check found. `problem` is absent when the key works.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct KeyCheck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<KeyProblem>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyProblem {
    Format,
    Rejected,
    Network,
    Billing,
}

impl KeyCheck {
    pub(crate) fn works() -> Self {
        Self { ok: true, problem: None, message: "This key works.".into() }
    }

    pub(crate) fn problem(problem: KeyProblem, message: &str) -> Self {
        Self { ok: false, problem: Some(problem), message: message.into() }
    }
}

/// Whether `key` looks like an Anthropic API key: `sk-ant-` then letters,
/// digits, `-` and `_`. Checked before anything is sent anywhere.
pub fn key_format_ok(key: &str) -> bool {
    key.starts_with("sk-ant-")
        && (20..=400).contains(&key.len())
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Check a key without saving it: its format, then one cheap real request
/// (listing one model). The key is never logged or put in the result.
pub async fn check_key(key: &str) -> KeyCheck {
    check_key_at(&base_url(), key).await
}

pub async fn check_key_at(base: &str, key: &str) -> KeyCheck {
    let key = key.trim();
    if !key_format_ok(key) {
        return KeyCheck::problem(
            KeyProblem::Format,
            "That doesn’t look like an Anthropic API key. Keys start with sk-ant- and are about 100 characters long; copy the whole key from console.anthropic.com.",
        );
    }
    let sent = client()
        .get(format!("{base}/v1/models?limit=1"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let Ok(resp) = sent else {
        return KeyCheck::problem(
            KeyProblem::Network,
            "Phaethon couldn’t reach Anthropic to check the key. Check your internet connection, then try again.",
        );
    };
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => KeyCheck::works(),
        _ if status == 402 || is_billing(&body) => KeyCheck::problem(KeyProblem::Billing, BILLING_MESSAGE),
        401 | 403 => KeyCheck::problem(
            KeyProblem::Rejected,
            "Anthropic didn’t accept this key. It may have been deleted, or part of it is missing. Copy it again from console.anthropic.com.",
        ),
        // Rate limits apply only to keys Anthropic recognised.
        429 => KeyCheck::works(),
        _ => KeyCheck::problem(KeyProblem::Network, "Anthropic couldn’t check the key right now. Try again in a few minutes."),
    }
}

/// One model the user can pick.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

/// Shown when the provider's list can't be fetched (no key, offline).
pub fn fallback_models() -> Vec<ModelInfo> {
    [
        ("claude-opus-5-5", "Claude Opus 5.5"),
        ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
        ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ]
    .into_iter()
    .map(|(id, name)| ModelInfo { id: id.into(), name: name.into() })
    .collect()
}

/// A model id as Anthropic writes them: `claude-` then lowercase letters,
/// digits, `-` and `.`. Checked before it is saved in the (synced, editable)
/// settings file or sent anywhere.
pub fn is_valid_model_id(id: &str) -> bool {
    id.len() > "claude-".len()
        && id.len() <= 80
        && id.starts_with("claude-")
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// The models this key can use, from the provider. `None` on any failure.
pub async fn list_models_at(base: &str, key: &str) -> Option<Vec<ModelInfo>> {
    let resp = client()
        .get(format!("{base}/v1/models?limit=100"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let models: Vec<ModelInfo> = body["data"]
        .as_array()?
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str().filter(|id| is_valid_model_id(id))?;
            let name = m["display_name"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(id);
            Some(ModelInfo { id: id.into(), name: name.chars().take(80).collect() })
        })
        .collect();
    (!models.is_empty()).then_some(models)
}

/// The provider's list when `key` works, else the fixed fallback list.
pub async fn models_or_fallback(key: Option<&str>) -> Vec<ModelInfo> {
    match key {
        Some(k) => list_models_at(&base_url(), k).await.unwrap_or_else(fallback_models),
        None => fallback_models(),
    }
}

/// Take one complete SSE event (ended by a blank line) off the front of `buf`.
/// The separator is ASCII, so the event is always whole UTF-8.
pub(crate) fn split_event(buf: &mut Vec<u8>) -> Option<String> {
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
                let msg = v["error"]["message"].as_str().unwrap_or("unknown error");
                let err = match v["error"]["type"].as_str() {
                    Some("overloaded_error" | "api_error") => ProviderError::new(
                        ErrorKind::Unavailable,
                        "Anthropic is overloaded or having problems, and stopped the reply. Try again in a few minutes.",
                    ),
                    Some("rate_limit_error") => ProviderError::new(ErrorKind::RateLimit, rate_limit_message(None)),
                    _ if is_billing(&v) => ProviderError::new(ErrorKind::Billing, BILLING_MESSAGE),
                    _ => ProviderError::new(ErrorKind::BadRequest, format!("Anthropic stopped the reply: {msg}")),
                };
                return Err(err);
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Result<ModelTurn, ProviderError> {
        if !self.stopped || self.stop_reason.is_none() {
            return Err(ProviderError::new(ErrorKind::Network, "The reply from Anthropic ended early. Try again."));
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

    #[test]
    fn a_call_without_tools_sends_no_tools_field() {
        let a = Anthropic::new("k".into(), None, None);
        let msgs = [json!({"role": "user", "content": "hi"})];
        let none = json!([]);
        let some = json!([{"name": "read_file"}]);
        assert!(a.body(&ModelRequest { system: "s", messages: &msgs, tools: &none }).get("tools").is_none());
        assert_eq!(a.body(&ModelRequest { system: "s", messages: &msgs, tools: &some })["tools"], some);
    }

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
        let e = http_error(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, None);
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(!e.message.contains("x-api-key"));
        assert_eq!(http_error(529, "", None).kind, ErrorKind::Unavailable);
        assert_eq!(http_error(500, "", Some(9)).retry_after, Some(9));
        assert!(http_error(404, r#"{"error":{"message":"model: nope"}}"#, None).message.contains("model: nope"));
        assert_eq!(http_error(404, "", Some(5)).retry_after, None, "a wait means nothing for a refused request");
    }

    #[test]
    fn billing_rate_limit_and_retry_after() {
        // Out of credit: 402, billing_error, or a 400 that says so.
        for (status, body) in [
            (402, ""),
            (400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}"#),
            (403, r#"{"type":"error","error":{"type":"billing_error","message":"x"}}"#),
        ] {
            let e = http_error(status, body, None);
            assert_eq!(e.kind, ErrorKind::Billing, "{status} {body}");
            assert!(e.message.contains("credit"));
        }
        let e = http_error(429, "", Some(42));
        assert_eq!((e.kind, e.retry_after), (ErrorKind::RateLimit, Some(42)));
        assert!(e.message.contains("42 seconds"), "{}", e.message);
        assert!(http_error(429, "", Some(600)).message.contains("10 minutes"));
        assert!(http_error(429, "", None).message.contains("Wait a minute"));
        assert_eq!(http_error(400, r#"{"error":{"message":"bad"}}"#, None).kind, ErrorKind::BadRequest);

        let mut h = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after(&h), None);
        h.insert("retry-after", "17".parse().unwrap());
        assert_eq!(retry_after(&h), Some(17));
        h.insert("retry-after", "1.2".parse().unwrap());
        assert_eq!(retry_after(&h), Some(2));
        h.insert("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap());
        assert_eq!(retry_after(&h), None);

        // Billing inside the stream, too.
        let raw = sse(&[json!({"type": "error", "error": {"type": "billing_error", "message": "no credit"}})]);
        assert!(matches!(run_sse(&raw).0, Err(ProviderError { kind: ErrorKind::Billing, .. })));
    }

    #[test]
    fn key_format_and_model_ids() {
        assert!(key_format_ok(&format!("sk-ant-api03-{}", "a".repeat(80))));
        for bad in ["", "sk-ant-", "sk-proj-abcdefghijklmnopqrstuvwxyz", "sk-ant-abc def ghi jkl mno pqr", "sk-ant-abc\nxyzxyzxyzxyzxyz"] {
            assert!(!key_format_ok(bad), "{bad:?}");
        }
        assert!(is_valid_model_id("claude-opus-5-5") && is_valid_model_id("claude-3.7-sonnet"));
        let long = format!("claude-{}", "a".repeat(80));
        for bad in ["", "claude-", "gpt-5", "claude-Opus", "claude-x/../y", "claude-a b", long.as_str()] {
            assert!(!is_valid_model_id(bad), "{bad:?}");
        }
        assert_eq!(fallback_models().len(), 3);
        assert!(fallback_models().iter().all(|m| is_valid_model_id(&m.id)));
    }
}
