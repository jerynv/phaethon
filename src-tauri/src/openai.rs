//! OpenAI's Chat Completions, as OpenAI, OpenRouter, Groq, Together, Mistral,
//! DeepSeek, xAI, Ollama, LM Studio and many servers of one's own speak it:
//! raw HTTP with server-sent events, like anthropic.rs.
//!
//! The thread stays in the Messages API shape (provider.rs); it is converted
//! here on the way out (tool_use → `tool_calls`, tool_result → `role: tool`,
//! images → data URLs, PDFs → their text) and the reply on the way back.
//! Reasoning a model streams is never shown or kept. The key, when there is
//! one, goes only to `base` (providers.rs decides it) and redirects are not
//! followed, so it can't be carried anywhere else.

use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::anthropic::{IDLE_TIMEOUT, KeyCheck, KeyProblem, MAX_RETRY_WAIT, ModelInfo, RETRIES, backoff, retry_after, split_event};
use crate::provider::{Delta, ErrorKind, ModelRequest, ModelTurn, Provider, ProviderError};
use crate::providers::{self, CUSTOM, Preset};
use crate::vision;

pub struct Config {
    pub provider: &'static Preset,
    /// Without a trailing `/`, e.g. `https://openrouter.ai/api/v1`.
    pub base: String,
    pub key: Option<String>,
    pub model: String,
    /// Settings' effort, passed on to models that take one.
    pub effort: Option<String>,
}

pub struct OpenAi {
    http: reqwest::Client,
    cfg: Config,
}

/// No redirects: a key must never follow one to another address.
fn client(connect: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(connect)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client builds")
}

fn connect_timeout(p: &Preset) -> Duration {
    Duration::from_secs(if p.local { 5 } else { 20 })
}

/// "OpenRouter", or "Your server" for one's own.
fn who(p: &Preset) -> &'static str {
    if p.id == CUSTOM { "Your server" } else { p.name }
}

/// "OpenRouter", or "your server", inside a sentence.
fn who_mid(p: &Preset) -> &'static str {
    if p.id == CUSTOM { "your server" } else { p.name }
}

/// `scheme://host:port` of `base`, for messages.
fn shown(base: &str) -> String {
    providers::origin(base).unwrap_or_else(|| base.to_string())
}

impl OpenAi {
    pub fn new(cfg: Config) -> Self {
        Self { http: client(connect_timeout(cfg.provider)), cfg }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let r = self.http.request(method, format!("{}{path}", self.cfg.base));
        match &self.cfg.key {
            Some(k) => r.bearer_auth(k),
            None => r,
        }
    }

    pub fn body(&self, req: &ModelRequest<'_>, pdfs: &HashMap<u64, String>, images: bool) -> Value {
        let mistral = self.cfg.provider.id == "mistral";
        let mut body = json!({
            "model": self.cfg.model,
            "stream": true,
            "messages": to_messages(req.system, req.messages, pdfs, images, mistral),
        });
        let tools = to_tools(req.tools);
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }
        if let Some(effort) = self.cfg.effort.as_deref().and_then(|e| effort_for(self.cfg.provider.id, e)) {
            if self.cfg.provider.id == "openrouter" {
                body["reasoning"] = json!({"effort": effort});
            } else if takes_reasoning_effort(&self.cfg.model) {
                body["reasoning_effort"] = effort.into();
            }
        }
        body
    }

    fn network_error(&self) -> ProviderError {
        let p = self.cfg.provider;
        let message = if p.local || providers::is_loopback(&self.cfg.base) {
            format!("Phaethon couldn’t reach {} at {}. Make sure it’s open and running, then try again.", who_mid(p), shown(&self.cfg.base))
        } else if p.id == CUSTOM {
            format!("Phaethon couldn’t reach your server at {}. Check the address in Settings and your internet connection, then try again.", shown(&self.cfg.base))
        } else {
            format!("Phaethon couldn’t reach {}. Check your internet connection, then try again.", p.name)
        };
        ProviderError::new(ErrorKind::Network, message)
    }
}

impl Provider for OpenAi {
    async fn turn(&self, req: ModelRequest<'_>, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<ModelTurn, ProviderError> {
        let pdfs = pdf_texts(req.messages).await;
        let mut images = has_images(req.messages);
        let p = self.cfg.provider;
        let mut attempt = 0;
        let resp = loop {
            attempt += 1;
            let body = self.body(&req, &pdfs, images);
            let sent = self.request(reqwest::Method::POST, "/chat/completions").json(&body).send().await;
            let resp = match sent {
                Ok(r) => r,
                // A server on this computer that isn't running says so at once; waiting won't help.
                Err(e) if attempt < RETRIES && !(p.local && e.is_connect()) => {
                    tokio::time::sleep(backoff(attempt, None)).await;
                    continue;
                }
                Err(_) => return Err(self.network_error()),
            };
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                break resp;
            }
            if resp.status().is_redirection() {
                return Err(ProviderError::new(
                    ErrorKind::BadRequest,
                    format!("{} sent Phaethon to another address, and Phaethon doesn’t follow that with your messages or key. Check the address in Settings.", who(p)),
                ));
            }
            let wait = retry_after(resp.headers());
            let text = resp.text().await.unwrap_or_default();
            // A model that can't see images: once more with a note in each image's place.
            if images && refuses_images(status, &text) {
                images = false;
                attempt -= 1;
                continue;
            }
            let err = http_error(p, &self.cfg.model, self.cfg.key.is_some(), status, &text, wait);
            let retryable = matches!(err.kind, ErrorKind::RateLimit | ErrorKind::Unavailable) && wait.is_none_or(|s| s <= MAX_RETRY_WAIT);
            if retryable && attempt < RETRIES {
                tokio::time::sleep(backoff(attempt, wait)).await;
                continue;
            }
            return Err(err);
        };

        let mut acc = Accumulator::new(p);
        let streamed = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|t| !t.starts_with("application/json"));
        if !streamed {
            // A server that ignored "stream": the whole reply at once.
            let text = resp.text().await.map_err(|_| self.network_error())?;
            acc.feed_whole(&text, on_delta)?;
            return acc.finish(on_delta);
        }
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        loop {
            let chunk = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
                Err(_) => {
                    return Err(ProviderError::new(ErrorKind::Network, format!("{} stopped responding in the middle of the reply. Try again.", who(p))));
                }
                Ok(None) => break,
                Ok(Some(Err(_))) => {
                    return Err(ProviderError::new(
                        ErrorKind::Network,
                        format!("The connection to {} dropped in the middle of the reply. Try again.", who_mid(p)),
                    ));
                }
                Ok(Some(Ok(bytes))) => bytes,
            };
            buf.extend_from_slice(&chunk);
            while let Some(event) = split_event(&mut buf) {
                acc.feed_event(&event, on_delta)?;
            }
        }
        // The last event may come without the blank line after it.
        if !buf.is_empty() {
            let rest = String::from_utf8_lossy(&buf).into_owned();
            acc.feed_event(&rest, on_delta)?;
        }
        acc.finish(on_delta)
    }
}

// ---- To the wire ---------------------------------------------------------------

/// Phaethon's tool definitions as function tools.
fn to_tools(tools: &Value) -> Vec<Value> {
    tools
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|t| t["input_schema"].is_object() && t["name"].is_string())
                .map(|t| json!({"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}))
                .collect()
        })
        .unwrap_or_default()
}

/// Mistral takes only nine letters and digits as a tool call's id; any other
/// id becomes one, the same each time, so a call and its result still match.
fn wire_id(id: &str, mistral: bool) -> String {
    if !mistral || (id.len() == 9 && id.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return id.to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut h = DefaultHasher::new();
    id.hash(&mut h);
    let mut n = h.finish();
    (0..9)
        .map(|_| {
            let c = DIGITS[(n % 62) as usize] as char;
            n /= 62;
            c
        })
        .collect()
}

fn hash_of(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn has_images(messages: &[Value]) -> bool {
    messages.iter().any(|m| m["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "image")))
}

fn image_note() -> String {
    "[An image was attached here, but this model can’t see images.]".into()
}

/// One block of a user message as text, or as an image when `images`.
enum Part {
    Text(String),
    Image(String),
}

fn document_text(title: &str, text: &str) -> String {
    format!("<document name=\"{}\">\n{}\n</document>", title.replace('"', "'"), text.trim_end())
}

fn user_part(b: &Value, pdfs: &HashMap<u64, String>, images: bool) -> Option<Part> {
    let title = b["title"].as_str().unwrap_or("attachment");
    match b["type"].as_str()? {
        "text" => Some(Part::Text(b["text"].as_str()?.to_string())),
        "image" => {
            let (Some(mt), Some(data)) = (b["source"]["media_type"].as_str(), b["source"]["data"].as_str()) else {
                return Some(Part::Text(image_note()));
            };
            Some(if images { Part::Image(format!("data:{mt};base64,{data}")) } else { Part::Text(image_note()) })
        }
        "document" => match b["source"]["type"].as_str() {
            Some("text") => Some(Part::Text(document_text(title, b["source"]["data"].as_str().unwrap_or("")))),
            Some("base64") => Some(Part::Text(
                b["source"]["data"]
                    .as_str()
                    .and_then(|d| pdfs.get(&hash_of(d)).cloned())
                    .unwrap_or_else(|| format!("[The attached PDF {title} couldn’t be read as text.]")),
            )),
            _ => None,
        },
        _ => None,
    }
}

/// A tool result's content as text (Phaethon's tools answer in text).
fn result_text(b: &Value) -> String {
    let text = match &b["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|p| if p["type"] == "text" { p["text"].as_str().unwrap_or("").to_string() } else { image_note() })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if b["is_error"] == true { format!("Error: {text}") } else { text }
}

/// The thread (Messages API shape) as Chat Completions messages.
pub fn to_messages(system: &str, messages: &[Value], pdfs: &HashMap<u64, String>, images: bool, mistral: bool) -> Vec<Value> {
    let mut out = vec![json!({"role": "system", "content": system})];
    for m in messages {
        let blocks: Vec<Value> = match &m["content"] {
            Value::String(s) => vec![json!({"type": "text", "text": s})],
            Value::Array(a) => a.clone(),
            _ => continue,
        };
        if m["role"] == "assistant" {
            let text: String = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n\n");
            let calls: Vec<Value> = blocks
                .iter()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| {
                    json!({"id": wire_id(b["id"].as_str().unwrap_or(""), mistral), "type": "function",
                           "function": {"name": b["name"], "arguments": b["input"].to_string()}})
                })
                .collect();
            let mut msg = json!({"role": "assistant", "content": text});
            if !calls.is_empty() {
                if text.is_empty() {
                    msg["content"] = Value::Null;
                }
                msg["tool_calls"] = Value::Array(calls);
            }
            out.push(msg);
            continue;
        }
        // Results first: each answers a call in the message just before.
        for b in blocks.iter().filter(|b| b["type"] == "tool_result") {
            out.push(json!({"role": "tool", "tool_call_id": wire_id(b["tool_use_id"].as_str().unwrap_or(""), mistral), "content": result_text(b)}));
        }
        let parts: Vec<Part> = blocks.iter().filter_map(|b| user_part(b, pdfs, images)).collect();
        if parts.is_empty() {
            continue;
        }
        // Plain text as one string: some servers (DeepSeek, older local ones) take nothing else.
        let content = if parts.iter().all(|p| matches!(p, Part::Text(_))) {
            Value::String(parts.iter().map(|p| if let Part::Text(t) = p { t.as_str() } else { "" }).collect::<Vec<_>>().join("\n\n"))
        } else {
            Value::Array(
                parts
                    .into_iter()
                    .map(|p| match p {
                        Part::Text(t) => json!({"type": "text", "text": t}),
                        Part::Image(url) => json!({"type": "image_url", "image_url": {"url": url}}),
                    })
                    .collect(),
            )
        };
        out.push(json!({"role": "user", "content": content}));
    }
    out
}

/// Settings' effort as Chat Completions takes it, if it has a counterpart.
fn effort_for(provider: &str, effort: &str) -> Option<&'static str> {
    match effort {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" => Some("high"),
        "minimal" if provider == "openai" => Some("minimal"),
        _ => None,
    }
}

/// Models known to take `reasoning_effort` (others refuse a request with it).
fn takes_reasoning_effort(model: &str) -> bool {
    let m = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    ["o1", "o3", "o4", "gpt-5", "grok-3-mini"].iter().any(|p| m.starts_with(p)) || m.contains("gpt-oss")
}

/// Whether a refused request was refused for its images.
fn refuses_images(status: u16, body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    matches!(status, 400 | 404 | 415 | 422 | 500)
        && ["image", "vision", "multimodal", "multi-modal", "content must be a string", "expected a string"].iter().any(|w| b.contains(w))
}

// ---- PDFs as text ---------------------------------------------------------------

/// Text of PDFs already read, by a hash of their data: every model call in a
/// turn sends the whole thread again, and reading (or recognising) a PDF is slow.
static PDF_CACHE: Mutex<VecDeque<(u64, String)>> = Mutex::new(VecDeque::new());
const PDF_CACHE_MAX: usize = 16;

/// The text of every PDF in `messages`, as the block that replaces it.
async fn pdf_texts(messages: &[Value]) -> HashMap<u64, String> {
    let mut out = HashMap::new();
    let docs: Vec<(&str, String)> = messages
        .iter()
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .filter(|b| b["type"] == "document" && b["source"]["type"] == "base64")
        .filter_map(|b| Some((b["source"]["data"].as_str()?, b["title"].as_str().unwrap_or("attachment").to_string())))
        .collect();
    for (data, title) in docs {
        let h = hash_of(data);
        if out.contains_key(&h) {
            continue;
        }
        let cached = PDF_CACHE.lock().ok().and_then(|c| c.iter().find(|(k, _)| *k == h).map(|(_, t)| t.clone()));
        let text = match cached {
            Some(t) => t,
            None => {
                let bytes = B64.decode(data).unwrap_or_default();
                let read = tokio::task::spawn_blocking(move || read_pdf(&bytes)).await.unwrap_or_else(|_| Err("reading it stopped".into()));
                let t = match read {
                    Ok(t) if t.trim().is_empty() => format!("[The attached PDF {title} has no text Phaethon could read.]"),
                    Ok(t) => document_text(&title, &t),
                    Err(e) => format!("[The attached PDF {title} couldn’t be read as text: {e}.]"),
                };
                if let Ok(mut c) = PDF_CACHE.lock() {
                    if c.len() >= PDF_CACHE_MAX {
                        c.pop_front();
                    }
                    c.push_back((h, t.clone()));
                }
                t
            }
        };
        out.insert(h, text);
    }
    out
}


/// A PDF's text the way course files are read (lms/text.rs): in a child
/// process, with scanned pages recognised where the computer can.
fn read_pdf(bytes: &[u8]) -> Result<String, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!("phaethon-attached-{}-{}.pdf", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let text = crate::lms::text::extract(&path);
    let _ = std::fs::remove_file(&path);
    text
}

// ---- From the wire -------------------------------------------------------------

/// Hides a `<think>…</think>` block at the start of the reply, which some
/// local models write into the text itself.
enum Think {
    Undecided(String),
    Inside(String),
    Pass,
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

impl Think {
    /// What of `s` should be shown.
    fn push(&mut self, s: &str) -> String {
        match self {
            Think::Pass => s.to_string(),
            Think::Undecided(buf) => {
                buf.push_str(s);
                let t = buf.trim_start();
                if let Some(rest) = t.strip_prefix(OPEN) {
                    let rest = rest.to_string();
                    *self = Think::Inside(String::new());
                    self.push(&rest)
                } else if OPEN.starts_with(t) {
                    String::new()
                } else {
                    let out = std::mem::take(buf);
                    *self = Think::Pass;
                    out
                }
            }
            Think::Inside(buf) => {
                buf.push_str(s);
                if let Some(i) = buf.find(CLOSE) {
                    let rest = buf[i + CLOSE.len()..].trim_start().to_string();
                    *self = Think::Pass;
                    rest
                } else {
                    // Only the tail can still hold the start of `</think>`.
                    let keep = buf.char_indices().rev().nth(CLOSE.len()).map_or(0, |(i, _)| i);
                    buf.drain(..keep);
                    String::new()
                }
            }
        }
    }

    /// Text held back that turned out not to be a thinking block.
    fn flush(&mut self) -> String {
        match std::mem::replace(self, Think::Pass) {
            Think::Undecided(buf) => buf,
            _ => String::new(),
        }
    }
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
    args_object: Option<Value>,
}

struct Accumulator {
    provider: &'static Preset,
    text: String,
    think: Think,
    started: bool,
    calls: Vec<Call>,
    refusal: String,
    finish: Option<String>,
    done: bool,
    /// Whether anything readable came at all.
    read_any: bool,
}

impl Accumulator {
    fn new(provider: &'static Preset) -> Self {
        Self {
            provider,
            text: String::new(),
            think: Think::Undecided(String::new()),
            started: false,
            calls: vec![],
            refusal: String::new(),
            finish: None,
            done: false,
            read_any: false,
        }
    }

    fn show(&mut self, t: &str, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) {
        if t.is_empty() {
            return;
        }
        if !self.started {
            self.started = true;
            on_delta(Delta::TextStart);
        }
        self.text.push_str(t);
        on_delta(Delta::Text(t));
    }

    fn feed_event(&mut self, event: &str, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<(), ProviderError> {
        let data: String = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| d.strip_prefix(' ').unwrap_or(d))
            .collect::<Vec<_>>()
            .join("\n");
        if data.trim() == "[DONE]" {
            self.done = true;
            self.read_any = true;
            return Ok(());
        }
        match serde_json::from_str::<Value>(&data) {
            Ok(v) => self.feed_chunk(&v, false, on_delta),
            Err(_) => Ok(()),
        }
    }

    /// A reply that came whole (`stream` ignored).
    fn feed_whole(&mut self, body: &str, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<(), ProviderError> {
        let Ok(v) = serde_json::from_str::<Value>(body) else { return Ok(()) };
        self.feed_chunk(&v, true, on_delta)?;
        self.done = self.read_any;
        Ok(())
    }

    fn feed_chunk(&mut self, v: &Value, whole: bool, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<(), ProviderError> {
        if v["error"].is_object() || v["error"].is_string() {
            return Err(stream_error(self.provider, v));
        }
        let Some(choice) = v["choices"].as_array().and_then(|c| c.first()) else {
            // Usage alone, or a keep-alive.
            self.read_any |= v["usage"].is_object() || v["object"].is_string();
            return Ok(());
        };
        self.read_any = true;
        let d = if whole { &choice["message"] } else { &choice["delta"] };
        if let Some(t) = d["content"].as_str() {
            let shown = self.think.push(t);
            self.show(&shown, on_delta);
        }
        if let Some(r) = d["refusal"].as_str() {
            self.refusal.push_str(r);
        }
        if let Some(calls) = d["tool_calls"].as_array() {
            for (pos, c) in calls.iter().enumerate() {
                let i = match c["index"].as_u64() {
                    Some(i) => i as usize,
                    // No index (a whole reply, or a server that leaves it out): a new id is a new call.
                    None => match c["id"].as_str().filter(|id| !id.is_empty()) {
                        Some(id) => self.calls.iter().position(|k| k.id == id).unwrap_or(self.calls.len()),
                        None if whole => pos,
                        None => self.calls.len().saturating_sub(1),
                    },
                };
                while self.calls.len() <= i {
                    self.calls.push(Call::default());
                }
                let call = &mut self.calls[i];
                if let Some(id) = c["id"].as_str().filter(|id| !id.is_empty())
                    && call.id.is_empty()
                {
                    call.id = id.to_string();
                }
                if let Some(n) = c["function"]["name"].as_str()
                    && call.name.is_empty()
                {
                    call.name = n.to_string();
                }
                match &c["function"]["arguments"] {
                    Value::String(a) => call.args.push_str(a),
                    o @ Value::Object(_) => call.args_object = Some(o.clone()),
                    _ => {}
                }
            }
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            self.finish = Some(f.to_string());
        }
        Ok(())
    }

    fn finish(mut self, on_delta: &mut (dyn FnMut(Delta<'_>) + Send)) -> Result<ModelTurn, ProviderError> {
        let who = who(self.provider);
        if !self.read_any {
            return Err(ProviderError::new(ErrorKind::Unavailable, format!("{who} sent a reply Phaethon couldn’t read. Try again, or choose another model.")));
        }
        if !self.done && self.finish.is_none() {
            return Err(ProviderError::new(ErrorKind::Network, format!("The reply from {} ended early. Try again.", who_mid(self.provider))));
        }
        let rest = self.think.flush();
        self.show(&rest, on_delta);
        let mut content = vec![];
        if !self.text.is_empty() {
            content.push(json!({"type": "text", "text": self.text}));
        }
        let mut invalid = vec![];
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        for (i, c) in self.calls.into_iter().enumerate() {
            if c.name.is_empty() {
                continue;
            }
            // Ids are kept in the thread and may go to another provider later: plain characters only.
            let mut id: String = c.id.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-').take(64).collect();
            if id.is_empty() {
                id = format!("call_{stamp:x}_{i}");
            }
            let input = match c.args_object {
                Some(o) => o,
                None if c.args.trim().is_empty() => json!({}),
                None => match serde_json::from_str::<Value>(&c.args) {
                    Ok(v @ Value::Object(_)) => v,
                    _ => {
                        invalid.push((id.clone(), c.args.clone()));
                        json!({})
                    }
                },
            };
            content.push(json!({"type": "tool_use", "id": id, "name": c.name, "input": input}));
        }
        let has_calls = content.iter().any(|b| b["type"] == "tool_use");
        let stop = match self.finish.as_deref() {
            Some("length") => "max_tokens",
            Some("content_filter") => "refusal",
            _ if has_calls => "tool_use",
            _ if !self.refusal.is_empty() && self.text.is_empty() => "refusal",
            _ => "end_turn",
        };
        Ok(ModelTurn { content, stop_reason: stop.to_string(), invalid_inputs: invalid })
    }
}

fn error_detail(v: &Value) -> String {
    let d = v["error"]["message"]
        .as_str()
        .or_else(|| v["error"].as_str())
        .or_else(|| v["message"].as_str())
        .or_else(|| v["detail"].as_str())
        .unwrap_or("");
    d.chars().take(300).collect::<String>().trim().to_string()
}

fn error_code(v: &Value) -> String {
    match (&v["error"]["code"], &v["error"]["type"]) {
        (Value::String(s), _) | (_, Value::String(s)) => s.clone(),
        (Value::Number(n), _) => n.to_string(),
        _ => String::new(),
    }
}

fn billing_message(p: &Preset) -> String {
    format!("Your {} account is out of credit or has a billing problem. Add credit with {}, then try again.", p.name, p.name)
}

fn rate_limit_message(p: &Preset, retry_after: Option<u64>) -> String {
    let lead = format!("{} is limiting how fast this key can send messages.", who(p));
    match retry_after {
        Some(0 | 1) => format!("{lead} Try again in a moment."),
        Some(s) if s < 120 => format!("{lead} Try again in {s} seconds."),
        Some(s) => format!("{lead} Try again in {} minutes.", s.div_ceil(60)),
        None => format!("{lead} Wait a minute, then try again."),
    }
}

/// An error sent inside the stream (OpenRouter does, mid-reply).
fn stream_error(p: &Preset, v: &Value) -> ProviderError {
    let detail = error_detail(v);
    match error_code(v).as_str() {
        "429" | "rate_limit_exceeded" => ProviderError::new(ErrorKind::RateLimit, rate_limit_message(p, None)),
        "402" | "insufficient_quota" => ProviderError::new(ErrorKind::Billing, billing_message(p)),
        _ => ProviderError::new(ErrorKind::Unavailable, format!("{} stopped the reply: {}", who(p), if detail.is_empty() { "no reason given" } else { &detail })),
    }
}

/// A failed HTTP response in plain words. The key is never part of it.
fn http_error(p: &Preset, model: &str, has_key: bool, status: u16, body: &str, retry_after: Option<u64>) -> ProviderError {
    let parsed = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let detail = error_detail(&parsed);
    let code = error_code(&parsed);
    let who = who(p);
    let (kind, message) = match status {
        _ if status == 402 || code == "insufficient_quota" => (ErrorKind::Billing, billing_message(p)),
        401 if !has_key => (ErrorKind::Auth, format!("{who} asked for an API key. Add one in Settings › Assistant.")),
        401 => (ErrorKind::Auth, format!("{who} didn’t accept your API key. Check it in Settings.")),
        403 => (ErrorKind::Auth, format!("{who} refused this request. {detail}")),
        404 => {
            let hint = if p.id == "ollama" { format!(" To download it, run ollama pull {model} in a terminal.") } else { " Choose another in Settings, or check its name.".to_string() };
            (ErrorKind::BadRequest, format!("{who} couldn’t find the model {model}.{hint} {detail}"))
        }
        429 => (ErrorKind::RateLimit, rate_limit_message(p, retry_after)),
        400 | 413 | 422 => (ErrorKind::BadRequest, format!("{who} couldn’t accept this request. {detail}")),
        _ => (ErrorKind::Unavailable, format!("{who} is overloaded or having problems right now. Try again in a few minutes.")),
    };
    let retry_after = retry_after.filter(|_| matches!(kind, ErrorKind::RateLimit | ErrorKind::Unavailable));
    ProviderError { kind, message: message.trim().to_string(), retry_after }
}

// ---- Key check, model list, is it running --------------------------------------

/// Check a key for `p` at `base` without saving it: its shape (and that it
/// isn't another provider's), then one cheap call that needs it.
pub async fn check_key(p: &'static Preset, base: &str, key: &str) -> KeyCheck {
    let key = key.trim();
    if let Some(problem) = providers::key_problem(p, base, key) {
        return KeyCheck::problem(KeyProblem::Format, &problem);
    }
    let sent = client(connect_timeout(p))
        .get(format!("{base}{}", p.check_path))
        .bearer_auth(key)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let Ok(resp) = sent else {
        return KeyCheck::problem(KeyProblem::Network, &format!("Phaethon couldn’t reach {} to check the key. Check your internet connection, then try again.", who_mid(p)));
    };
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    match status {
        200..=299 => KeyCheck::works(),
        _ if status == 402 || error_code(&body) == "insufficient_quota" => KeyCheck::problem(KeyProblem::Billing, &billing_message(p)),
        401 | 403 => KeyCheck::problem(
            KeyProblem::Rejected,
            &format!("{} didn’t accept this key. It may have been deleted, or part of it is missing. Copy it again and paste it here.", who(p)),
        ),
        429 => KeyCheck::works(),
        _ => KeyCheck::problem(KeyProblem::Network, &format!("{} couldn’t check the key right now. Try again in a few minutes.", who(p))),
    }
}

/// OpenAI lists every model it has, speech and pictures too: only chat models are offered.
fn is_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    !["embedding", "tts", "whisper", "dall-e", "moderation", "davinci", "babbage", "transcribe", "realtime", "audio", "image", "search", "sora", "computer-use"]
        .iter()
        .any(|w| id.contains(w))
}

/// The models `p` at `base` offers. `Err` is a message for the person.
pub async fn list_models(p: &'static Preset, base: &str, key: Option<&str>) -> Result<Vec<ModelInfo>, String> {
    let timeout = Duration::from_secs(if p.local { 4 } else { 20 });
    let mut req = client(connect_timeout(p)).get(format!("{base}/models")).timeout(timeout);
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|_| not_running(p, base))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(if key.is_some() {
            format!("{} didn’t accept your API key, so its models can’t be listed. Check the key above.", who(p))
        } else {
            format!("{} asked for an API key before it lists its models.", who(p))
        });
    }
    let unreadable = || format!("Phaethon couldn’t get the list of models from {} just now. You can still type a model’s name.", who_mid(p));
    if !resp.status().is_success() {
        return Err(unreadable());
    }
    let body: Value = resp.json().await.map_err(|_| unreadable())?;
    let list = body["data"].as_array().or_else(|| body.as_array()).ok_or_else(unreadable)?;
    let mut models: Vec<ModelInfo> = list
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str().filter(|id| providers::is_valid_compat_model(id))?;
            if p.id == "openai" && !is_chat_model(id) {
                return None;
            }
            let name = m["name"].as_str().or_else(|| m["display_name"].as_str()).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(id);
            Some(ModelInfo { id: id.into(), name: name.chars().take(100).collect(), sees: vision::from_metadata(m) })
        })
        .take(5000)
        .collect();
    if p.id == "openai" {
        models.sort_by(|a, b| a.id.cmp(&b.id));
    }
    if p.id == "ollama" && !models.is_empty() {
        let sight = ollama_sight(p, base, key, &models).await;
        for m in &mut models {
            m.sees = m.sees.or_else(|| sight.get(&m.id).copied());
        }
    }
    // Whether each model reads pictures, where the list said, for Study (vision.rs).
    vision::remember(p.id, base, models.iter().filter_map(|m| Some((m.id.clone(), m.sees?))));
    Ok(models)
}

/// Which of `models` read pictures, from Ollama's own API (its OpenAI-style
/// list doesn't say): `capabilities` in `/api/tags` (newer Ollama), else
/// `/api/show` one model at a time, for a few seconds at most.
async fn ollama_sight(p: &'static Preset, base: &str, key: Option<&str>, models: &[ModelInfo]) -> HashMap<String, vision::Sees> {
    let trimmed = base.trim_end_matches('/');
    let native = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    let c = client(connect_timeout(p));
    let auth = |r: reqwest::RequestBuilder| match key {
        Some(k) => r.bearer_auth(k),
        None => r,
    };
    let mut out = HashMap::new();
    if let Ok(resp) = auth(c.get(format!("{native}/api/tags"))).timeout(Duration::from_secs(4)).send().await
        && resp.status().is_success()
        && let Ok(v) = resp.json::<Value>().await
    {
        for m in v["models"].as_array().into_iter().flatten() {
            if let (Some(name), Some(s)) = (m["model"].as_str().or_else(|| m["name"].as_str()), vision::from_metadata(m)) {
                out.insert(name.to_string(), s);
            }
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let unsaid: Vec<&ModelInfo> = models.iter().filter(|m| !out.contains_key(&m.id)).take(64).collect();
    for m in unsaid {
        if std::time::Instant::now() > deadline {
            break;
        }
        let Ok(resp) = auth(c.post(format!("{native}/api/show"))).json(&json!({ "model": m.id })).timeout(Duration::from_secs(3)).send().await else { break };
        if resp.status().is_success()
            && let Ok(v) = resp.json::<Value>().await
            && let Some(s) = vision::from_metadata(&v)
        {
            out.insert(m.id.clone(), s);
        }
    }
    out
}

fn not_running(p: &Preset, base: &str) -> String {
    if p.local || providers::is_loopback(base) {
        format!("{} isn’t running at {}. Open it, then check again.", who(p), shown(base))
    } else {
        format!("Phaethon couldn’t reach {} at {}. Check the address and your internet connection.", who_mid(p), shown(base))
    }
}

/// Whether a server answers at `base`, in words, with its models.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub models: Vec<ModelInfo>,
    pub message: String,
}

pub async fn status(p: &'static Preset, base: &str, key: Option<&str>) -> ServerStatus {
    match list_models(p, base, key).await {
        Ok(models) => {
            let message = match (p.id, models.len()) {
                ("ollama", 0) => "Ollama is running, but has no models yet. Download one with ollama pull llama3.2 in a terminal, then check again.".to_string(),
                (_, 0) => format!("{} is running, but has no models loaded yet. Load one, then check again.", who(p)),
                (_, 1) => format!("{} is running, with 1 model.", who(p)),
                (_, n) => format!("{} is running, with {n} models.", who(p)),
            };
            ServerStatus { running: true, models, message }
        }
        Err(message) => ServerStatus { running: false, models: vec![], message },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str) -> &'static Preset {
        providers::preset(id).unwrap()
    }

    fn run(raw: &str, p: &'static Preset) -> (Result<ModelTurn, ProviderError>, Vec<String>) {
        let mut acc = Accumulator::new(p);
        let mut seen = vec![];
        let mut on = |d: Delta<'_>| match d {
            Delta::TextStart => seen.push("<start>".to_string()),
            Delta::Text(t) => seen.push(t.to_string()),
        };
        let mut buf = raw.as_bytes().to_vec();
        while let Some(ev) = split_event(&mut buf) {
            if let Err(e) = acc.feed_event(&ev, &mut on) {
                return (Err(e), seen);
            }
        }
        (acc.finish(&mut on), seen)
    }

    fn sse(chunks: &[Value]) -> String {
        let mut s: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
        s.push_str("data: [DONE]\n\n");
        s
    }

    fn delta(d: Value) -> Value {
        json!({"choices": [{"index": 0, "delta": d, "finish_reason": null}]})
    }

    fn finish(r: &str) -> Value {
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": r}]})
    }

    #[test]
    fn text_and_a_tool_call_with_split_arguments() {
        let raw = sse(&[
            delta(json!({"role": "assistant", "content": ""})),
            delta(json!({"content": "Let me "})),
            delta(json!({"content": "look."})),
            delta(json!({"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": ""}}]})),
            delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"pa"}}]})),
            delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "th\": \"a.md\"}"}}]})),
            delta(json!({"tool_calls": [{"index": 1, "id": "call_2", "function": {"name": "list_files", "arguments": "{}"}}]})),
            finish("tool_calls"),
            json!({"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
        ]);
        let (turn, seen) = run(&raw, preset("openai"));
        let turn = turn.unwrap();
        assert_eq!(seen, vec!["<start>", "Let me ", "look."]);
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(
            turn.content,
            vec![
                json!({"type": "text", "text": "Let me look."}),
                json!({"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a.md"}}),
                json!({"type": "tool_use", "id": "call_2", "name": "list_files", "input": {}}),
            ]
        );
        assert!(turn.invalid_inputs.is_empty());
    }

    #[test]
    fn finish_reasons_map_and_bad_arguments_are_reported() {
        let raw = sse(&[
            delta(json!({"tool_calls": [{"index": 0, "id": "c/9!", "function": {"name": "write_file", "arguments": "{\"path\": \"a.md\", \"contents\": \"cut"}}]})),
            finish("length"),
        ]);
        let turn = run(&raw, preset("groq")).0.unwrap();
        assert_eq!(turn.stop_reason, "max_tokens");
        assert_eq!(turn.content[0]["id"], "c9", "ids keep plain characters only");
        assert_eq!(turn.invalid_inputs[0].0, "c9");
        let t = run(&sse(&[delta(json!({"content": "no"})), finish("content_filter")]), preset("openai")).0.unwrap();
        assert_eq!(t.stop_reason, "refusal");
        let t = run(&sse(&[delta(json!({"refusal": "I can't help with that."})), finish("stop")]), preset("openai")).0.unwrap();
        assert_eq!(t.stop_reason, "refusal");
        let t = run(&sse(&[delta(json!({"content": "Hi"})), finish("stop")]), preset("openai")).0.unwrap();
        assert_eq!((t.stop_reason.as_str(), t.content.len()), ("end_turn", 1));
        // Some local servers end a tool call with "stop".
        let t = run(&sse(&[delta(json!({"tool_calls": [{"index": 0, "function": {"name": "list_files", "arguments": {"path": ""}}}]})), finish("stop")]), preset("ollama")).0.unwrap();
        assert_eq!(t.stop_reason, "tool_use");
        assert_eq!(t.content[0]["input"], json!({"path": ""}));
        assert!(t.content[0]["id"].as_str().unwrap().starts_with("call_"), "an id is made when the server sends none");
    }

    #[test]
    fn a_cut_stream_garbage_and_stream_errors_are_errors() {
        let cut = format!("data: {}\n\n", delta(json!({"content": "Hi"})));
        assert!(matches!(run(&cut, preset("openai")).0, Err(ProviderError { kind: ErrorKind::Network, .. })));
        let (r, _) = run("<html>Bad gateway</html>\n\n", preset("openai"));
        let e = r.unwrap_err();
        assert!(e.kind == ErrorKind::Unavailable && e.message.contains("couldn’t read"), "{}", e.message);
        let raw = format!("data: {}\n\n", json!({"error": {"message": "Provider returned error", "code": 502}}));
        let e = run(&raw, preset("openrouter")).0.unwrap_err();
        assert!(e.kind == ErrorKind::Unavailable && e.message.contains("Provider returned error"), "{}", e.message);
        let raw = format!("data: {}\n\n", json!({"error": {"message": "slow down", "code": 429}}));
        assert_eq!(run(&raw, preset("openrouter")).0.unwrap_err().kind, ErrorKind::RateLimit);
        // OpenRouter's keep-alive comments are skipped.
        let raw = format!(": OPENROUTER PROCESSING\n\n{}", sse(&[delta(json!({"content": "ok"})), finish("stop")]));
        assert_eq!(run(&raw, preset("openrouter")).0.unwrap().content[0]["text"], "ok");
    }

    #[test]
    fn thinking_written_into_the_text_is_never_shown_or_kept() {
        let raw = sse(&[
            delta(json!({"content": "<thi"})),
            delta(json!({"content": "nk>Let me think about é"})),
            delta(json!({"content": " this.</th"})),
            delta(json!({"content": "ink>\n\nThe answer"})),
            delta(json!({"content": " is 4.", "reasoning_content": "hidden"})),
            finish("stop"),
        ]);
        let (turn, seen) = run(&raw, preset("ollama"));
        assert_eq!(seen, vec!["<start>", "The answer", " is 4."]);
        assert_eq!(turn.unwrap().content, vec![json!({"type": "text", "text": "The answer is 4."})]);
        // Text that only starts like the tag is shown in full.
        let (turn, _) = run(&sse(&[delta(json!({"content": "<"})), delta(json!({"content": "b>bold"})), finish("stop")]), preset("ollama"));
        assert_eq!(turn.unwrap().content[0]["text"], "<b>bold");
        let (turn, _) = run(&sse(&[delta(json!({"content": "<th"})), finish("stop")]), preset("ollama"));
        assert_eq!(turn.unwrap().content[0]["text"], "<th");
    }

    #[test]
    fn a_whole_reply_without_streaming_is_read_too() {
        let body = json!({"choices": [{"message": {"content": "Hello", "tool_calls": [{"id": "x1", "function": {"name": "list_files", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]});
        let mut acc = Accumulator::new(preset("custom"));
        let mut seen = 0;
        let mut on = |_: Delta<'_>| seen += 1;
        acc.feed_whole(&body.to_string(), &mut on).unwrap();
        let t = acc.finish(&mut on).unwrap();
        assert_eq!(t.stop_reason, "tool_use");
        assert_eq!(t.content.len(), 2);
    }

    #[test]
    fn the_thread_converts_to_chat_messages() {
        let msgs = vec![
            json!({"role": "user", "content": [
                {"type": "text", "text": "What is in these?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBO"}},
                {"type": "document", "title": "notes.docx", "source": {"type": "text", "media_type": "text/plain", "data": "Chapter 1"}},
                {"type": "document", "title": "a.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBE"}},
            ]}),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "secret", "signature": "s"},
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "toolu_01", "name": "read_file", "input": {"path": "a.md"}},
            ]}),
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01", "content": "file text"},
                {"type": "text", "text": "And?"},
            ]}),
            json!({"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_02", "name": "list_files", "input": {}}]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_02", "content": "no such folder", "is_error": true}]}),
        ];
        let pdfs = HashMap::from([(hash_of("JVBE"), "<document name=\"a.pdf\">\nPDF text\n</document>".to_string())]);
        let out = to_messages("sys", &msgs, &pdfs, true, false);
        assert_eq!(out[0], json!({"role": "system", "content": "sys"}));
        let parts = out[1]["content"].as_array().unwrap();
        assert_eq!(parts[0], json!({"type": "text", "text": "What is in these?"}));
        assert_eq!(parts[1], json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBO"}}));
        assert_eq!(parts[2]["text"], "<document name=\"notes.docx\">\nChapter 1\n</document>");
        assert!(parts[3]["text"].as_str().unwrap().contains("PDF text"));
        assert_eq!(out[2]["content"], "Let me look.");
        assert!(!out[2].to_string().contains("secret"), "thinking is never sent");
        assert_eq!(out[2]["tool_calls"][0], json!({"id": "toolu_01", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"a.md\"}"}}));
        assert_eq!(out[3], json!({"role": "tool", "tool_call_id": "toolu_01", "content": "file text"}));
        assert_eq!(out[4], json!({"role": "user", "content": "And?"}), "plain text goes as one string");
        assert_eq!(out[5]["content"], Value::Null);
        assert_eq!(out[6], json!({"role": "tool", "tool_call_id": "toolu_02", "content": "Error: no such folder"}));
        assert_eq!(out.len(), 7);

        // A model without vision: each image is a note, and the message is plain text again.
        let out = to_messages("sys", &msgs[..1], &pdfs, false, false);
        assert!(out[1]["content"].as_str().unwrap().contains("can’t see images"));

        // Mistral's ids: nine letters and digits, the same for a call and its result.
        let out = to_messages("sys", &msgs, &pdfs, true, true);
        let id = out[2]["tool_calls"][0]["id"].as_str().unwrap();
        assert!(id.len() == 9 && id.bytes().all(|b| b.is_ascii_alphanumeric()), "{id}");
        assert_eq!(out[3]["tool_call_id"], id);
        assert_eq!(wire_id("abcDEF123", true), "abcDEF123");
    }

    #[test]
    fn tools_and_effort_go_in_the_body() {
        let o = OpenAi::new(Config { provider: preset("openai"), base: "http://x".into(), key: None, model: "gpt-5".into(), effort: Some("max".into()) });
        let msgs = [json!({"role": "user", "content": "hi"})];
        let tools = crate::tools::definitions();
        let b = o.body(&ModelRequest { system: "s", messages: &msgs, tools: &tools }, &HashMap::new(), true);
        assert_eq!(b["reasoning_effort"], "high");
        assert_eq!(b["tools"][0]["type"], "function");
        assert_eq!(b["tools"][0]["function"]["name"], "list_files");
        assert!(b["tools"][0]["function"]["parameters"]["properties"].is_object());
        assert!(!b.to_string().contains("eager_input_streaming"));
        let none = json!([]);
        let b = o.body(&ModelRequest { system: "s", messages: &msgs, tools: &none }, &HashMap::new(), true);
        assert!(b.get("tools").is_none());
        let o = OpenAi::new(Config { provider: preset("groq"), base: "http://x".into(), key: None, model: "llama-3.3-70b".into(), effort: Some("low".into()) });
        assert!(o.body(&ModelRequest { system: "s", messages: &msgs, tools: &none }, &HashMap::new(), true).get("reasoning_effort").is_none());
        let o = OpenAi::new(Config { provider: preset("openrouter"), base: "http://x".into(), key: None, model: "x/y".into(), effort: Some("medium".into()) });
        assert_eq!(o.body(&ModelRequest { system: "s", messages: &msgs, tools: &none }, &HashMap::new(), true)["reasoning"]["effort"], "medium");
    }

    #[test]
    fn http_errors_in_plain_words() {
        let or = preset("openrouter");
        let e = http_error(or, "m", true, 401, r#"{"error":{"message":"No auth credentials found","code":401}}"#, None);
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(e.message.starts_with("OpenRouter didn’t accept your API key"));
        assert_eq!(http_error(or, "m", true, 402, "{}", None).kind, ErrorKind::Billing);
        assert_eq!(http_error(preset("openai"), "m", true, 429, r#"{"error":{"code":"insufficient_quota","message":"x"}}"#, None).kind, ErrorKind::Billing);
        let e = http_error(or, "m", true, 429, "", Some(42));
        assert!(e.kind == ErrorKind::RateLimit && e.retry_after == Some(42) && e.message.contains("42 seconds"), "{}", e.message);
        let e = http_error(or, "m", true, 503, "<html>", Some(5));
        assert!(e.kind == ErrorKind::Unavailable && e.retry_after == Some(5));
        let e = http_error(preset("ollama"), "llama9", false, 404, r#"{"error":{"message":"model \"llama9\" not found, try pulling it first"}}"#, None);
        assert!(e.kind == ErrorKind::BadRequest && e.message.contains("ollama pull llama9"), "{}", e.message);
        let e = http_error(preset("custom"), "m", false, 401, "", None);
        assert!(e.message.starts_with("Your server asked for an API key"), "{}", e.message);
        assert!(refuses_images(400, r#"{"error":{"message":"This model does not support image input"}}"#));
        assert!(!refuses_images(400, r#"{"error":{"message":"bad"}}"#));
        assert!(!refuses_images(401, "image"));
    }

    #[test]
    fn a_pdf_is_sent_as_its_text() {
        let pdf = B64.encode(crate::lms::text::test_pdf("Week 3: recursion and stacks"));
        let msgs = vec![json!({"role": "user", "content": [{"type": "document", "title": "w3.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf}}]})];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let texts = rt.block_on(pdf_texts(&msgs));
        let out = to_messages("s", &msgs, &texts, true, false);
        let text = out[1]["content"].as_str().unwrap();
        assert!(text.starts_with("<document name=\"w3.pdf\">") && text.contains("recursion and stacks"), "{text}");
        let bad = vec![json!({"role": "user", "content": [{"type": "document", "title": "x.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": B64.encode(b"not a pdf")}}]})];
        let texts = rt.block_on(pdf_texts(&bad));
        assert!(to_messages("s", &bad, &texts, true, false)[1]["content"].as_str().unwrap().contains("couldn’t be read as text"));
    }

    #[test]
    fn openai_lists_only_chat_models() {
        assert!(is_chat_model("gpt-5") && is_chat_model("o3-mini"));
        assert!(!is_chat_model("text-embedding-3-small") && !is_chat_model("tts-1") && !is_chat_model("gpt-image-1"));
        assert!(takes_reasoning_effort("o3-mini") && takes_reasoning_effort("openai/gpt-5") && takes_reasoning_effort("gpt-oss-120b"));
        assert!(!takes_reasoning_effort("gpt-4o") && !takes_reasoning_effort("llama3.2"));
    }
}
