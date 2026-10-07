//! The model provider interface Phaethon's own agent loop runs on.
//!
//! Messages use the Messages API shape (`{"role", "content": [blocks]}`) as the
//! common format. A provider for another API converts to and from it.

use std::future::Future;

use serde_json::Value;

pub struct ModelRequest<'a> {
    pub system: &'a str,
    pub messages: &'a [Value],
    pub tools: &'a Value,
}

/// What a provider reports while a reply streams in.
pub enum Delta<'a> {
    /// A new text block begins (the UI separates blocks with a blank line).
    TextStart,
    Text(&'a str),
}

#[derive(Debug)]
pub struct ModelTurn {
    /// The assistant content blocks, exactly as they should be saved and sent back.
    pub content: Vec<Value>,
    pub stop_reason: String,
    /// Tool calls whose streamed input was not valid JSON, by tool_use id,
    /// with the raw text. They are answered with an error, never run.
    pub invalid_inputs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ErrorKind {
    /// No key, or the key was rejected.
    Auth,
    /// Out of credit or a billing problem on the account.
    Billing,
    RateLimit,
    /// The service is overloaded or failing; retrying later may work.
    Unavailable,
    /// The request itself was refused (a bug in Phaethon, or an unknown model).
    BadRequest,
    /// Could not reach the service at all.
    Network,
}

#[derive(Debug)]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
    /// Seconds the provider asked us to wait before trying again (rate limits
    /// and overloads), when it said.
    pub retry_after: Option<u64>,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), retry_after: None }
    }
}

pub trait Provider: Send + Sync {
    /// One model turn: stream text through `on_delta`, return the full content.
    fn turn(
        &self,
        req: ModelRequest<'_>,
        on_delta: &mut (dyn FnMut(Delta<'_>) + Send),
    ) -> impl Future<Output = Result<ModelTurn, ProviderError>> + Send;
}
