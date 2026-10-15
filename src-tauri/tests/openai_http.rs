//! The OpenAI-compatible provider over real HTTP against a local fake server:
//! streaming, tool calls split across packets, a whole agent turn with a tool,
//! errors in plain words, keys that go only where they belong, a local server
//! with no key, and model lists. No network, no keychain.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use phaethon_lib::agent::{AgentEvent, Runs};
use phaethon_lib::agent_loop::{self, Approvals, LoopRequest};
use phaethon_lib::openai::{self, Config, OpenAi};
use phaethon_lib::provider::{Delta, ErrorKind, ModelRequest, Provider};
use phaethon_lib::providers::{self, AnyProvider};
use phaethon_lib::vault::VaultSettings;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One canned response: status line, extra headers, and the body in pieces
/// written one by one with a pause between (so the client reads them apart).
struct Reply {
    status: &'static str,
    headers: Vec<String>,
    pieces: Vec<Vec<u8>>,
}

fn stream(chunks: &[Value]) -> Reply {
    let mut pieces: Vec<Vec<u8>> = chunks.iter().map(|c| format!("data: {c}\n\n").into_bytes()).collect();
    pieces.push(b"data: [DONE]\n\n".to_vec());
    Reply { status: "200 OK", headers: vec!["content-type: text/event-stream".into()], pieces }
}

fn plain(status: &'static str, headers: &[&str], body: &str) -> Reply {
    let mut h: Vec<String> = headers.iter().map(|s| s.to_string()).collect();
    if !h.iter().any(|x| x.starts_with("content-type")) {
        h.push("content-type: application/json".into());
    }
    Reply { status, headers: h, pieces: vec![body.as_bytes().to_vec()] }
}

fn delta(d: Value) -> Value {
    json!({"choices": [{"index": 0, "delta": d, "finish_reason": null}]})
}

fn finish(r: &str) -> Value {
    json!({"choices": [{"index": 0, "delta": {}, "finish_reason": r}]})
}

/// A request as the server saw it.
#[derive(Debug, Clone)]
struct Seen {
    head: String,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    }
    fn path(&self) -> String {
        self.head.split_whitespace().nth(1).unwrap_or("").to_string()
    }
}

/// Serve `replies` in order, one per connection, recording every request.
async fn serve(listener: TcpListener, replies: Vec<Reply>, seen: Arc<Mutex<Vec<Seen>>>) {
    for r in replies {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 65536];
        let (head, body) = loop {
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req).into_owned();
            if let Some(h) = text.find("\r\n\r\n") {
                let len: usize = text[..h]
                    .lines()
                    .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                if req.len() >= h + 4 + len || n == 0 {
                    break (text[..h].to_string(), serde_json::from_slice::<Value>(&req[h + 4..h + 4 + len]).unwrap_or(Value::Null));
                }
            }
        };
        seen.lock().unwrap().push(Seen { head, body });
        let extra: String = r.headers.iter().map(|h| format!("{h}\r\n")).collect();
        sock.write_all(format!("HTTP/1.1 {}\r\nconnection: close\r\n{extra}\r\n", r.status).as_bytes()).await.unwrap();
        for p in r.pieces {
            sock.write_all(&p).await.unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        let _ = sock.shutdown().await;
    }
}

async fn server(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<Seen>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let task = tokio::spawn(serve(listener, replies, seen.clone()));
    (base, seen, task)
}

/// A listener that must never be contacted; true if something connected.
async fn untouched() -> (String, tokio::task::JoinHandle<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { tokio::time::timeout(Duration::from_millis(600), listener.accept()).await.is_ok() });
    (base, task)
}

fn provider(id: &str, base: &str, key: Option<&str>, model: &str) -> OpenAi {
    OpenAi::new(Config { provider: providers::preset(id).unwrap(), base: base.into(), key: key.map(Into::into), model: model.into(), effort: None })
}

async fn ask(p: &impl Provider, text: &str) -> (Result<phaethon_lib::provider::ModelTurn, phaethon_lib::provider::ProviderError>, String) {
    let msgs = [json!({"role": "user", "content": [{"type": "text", "text": text}]})];
    let tools = json!([]);
    let mut streamed = String::new();
    let mut on = |d: Delta<'_>| {
        if let Delta::Text(t) = d {
            streamed.push_str(t)
        }
    };
    let r = p.turn(ModelRequest { system: "Be brief.", messages: &msgs, tools: &tools }, &mut on).await;
    (r, streamed)
}

#[tokio::test(flavor = "multi_thread")]
async fn streaming_text_with_the_key_only_in_its_header() {
    let (base, seen, task) = server(vec![stream(&[
        delta(json!({"role": "assistant", "content": ""})),
        delta(json!({"content": "Hello"})),
        delta(json!({"content": ", Jeryn — café."})),
        finish("stop"),
        json!({"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 4}}),
    ])])
    .await;
    let p = provider("openrouter", &base, Some("sk-or-v1-test-key"), "openai/gpt-5");
    let (turn, streamed) = ask(&p, "hi").await;
    task.await.unwrap();
    let turn = turn.unwrap();
    assert_eq!(streamed, "Hello, Jeryn — café.");
    assert_eq!(turn.content, vec![json!({"type": "text", "text": "Hello, Jeryn — café."})]);
    assert_eq!(turn.stop_reason, "end_turn");
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(s.path(), "/v1/chat/completions");
    assert_eq!(s.header("authorization").as_deref(), Some("Bearer sk-or-v1-test-key"));
    assert_eq!(s.body["model"], "openai/gpt-5");
    assert_eq!(s.body["stream"], true);
    assert_eq!(s.body["messages"], json!([{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}]));
    assert!(!s.body.to_string().contains("sk-or-v1"), "the key is only in the header");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_split_across_packets() {
    let chunk = |v: Value| format!("data: {v}\n\n").into_bytes();
    let all = [
        chunk(delta(json!({"tool_calls": [{"index": 0, "id": "call_a1", "type": "function", "function": {"name": "read_file", "arguments": ""}}]}))),
        chunk(delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"path\": \"no"}}]}))),
        chunk(delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "tes/é.md\"}"}}]}))),
        chunk(finish("tool_calls")),
        b"data: [DONE]\n\n".to_vec(),
    ]
    .concat();
    // Cut mid-event and mid-character: the parts arrive in separate reads.
    let at = all.windows(2).position(|w| w == "é".as_bytes()).unwrap() + 1;
    let pieces = vec![all[..17].to_vec(), all[17..at].to_vec(), all[at..].to_vec()];
    let (base, _seen, task) = server(vec![Reply { status: "200 OK", headers: vec!["content-type: text/event-stream".into()], pieces }]).await;
    let (turn, streamed) = ask(&provider("openai", &base, Some("sk-test-123456"), "gpt-5"), "read my notes").await;
    task.await.unwrap();
    let turn = turn.unwrap();
    assert!(streamed.is_empty());
    assert_eq!(turn.stop_reason, "tool_use");
    assert_eq!(turn.content, vec![json!({"type": "tool_use", "id": "call_a1", "name": "read_file", "input": {"path": "notes/é.md"}})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_whole_turn_with_a_tool_through_the_agent_loop() {
    let vault = std::env::temp_dir().join(format!("phaethon-openai-loop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    let space = vault.join("spaces/school");
    std::fs::create_dir_all(space.join("notes")).unwrap();
    std::fs::write(space.join("notes/week6.md"), "Redo recursion 3.1 to 3.6.").unwrap();

    let (base, seen, task) = server(vec![
        stream(&[
            delta(json!({"content": "Let me check."})),
            delta(json!({"tool_calls": [{"index": 0, "id": "call_r1", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":"}}]})),
            delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": " \"notes/week6.md\"}"}}]})),
            finish("tool_calls"),
        ]),
        stream(&[delta(json!({"content": "You planned to redo recursion."})), finish("stop")]),
    ])
    .await;
    let p = provider("groq", &base, Some("gsk_test_key_1"), "llama-3.3-70b-versatile");
    let mut events = vec![];
    agent_loop::run_turn(
        &Runs::default(),
        &Approvals::default(),
        &p,
        LoopRequest { space_id: "school", space_dir: &space, vault_root: &vault, prompt: "What did I plan?", attachments: vec![], replace_from: None },
        |e| events.push(e),
    )
    .await;
    task.await.unwrap();

    let text: String = events.iter().filter_map(|e| if let AgentEvent::Text { delta } = e { Some(delta.as_str()) } else { None }).collect();
    assert_eq!(text, "Let me check.\n\nYou planned to redo recursion.", "{events:#?}");
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:#?}");
    let seen = seen.lock().unwrap().clone();
    // The tool definitions went as function tools, and the result came back as a tool message.
    assert_eq!(seen[0].body["tools"][1]["function"]["name"], "read_file");
    let second = seen[1].body["messages"].as_array().unwrap().clone();
    let call = second.iter().find(|m| m["role"] == "assistant").unwrap();
    assert_eq!(call["tool_calls"][0]["id"], "call_r1");
    assert_eq!(call["tool_calls"][0]["function"]["arguments"], "{\"path\":\"notes/week6.md\"}");
    let result = second.iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(result["tool_call_id"], "call_r1");
    assert!(result["content"].as_str().unwrap().contains("Redo recursion 3.1 to 3.6."), "{result}");
    // The saved thread keeps the Messages API shape, whatever the provider.
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(space.join(".phaethon/thread.json")).unwrap()).unwrap();
    let saved = saved.as_array().unwrap();
    assert_eq!(saved[1]["content"][1]["type"], "tool_use");
    assert_eq!(saved[1]["content"][1]["input"], json!({"path": "notes/week6.md"}));
    assert_eq!(saved[2]["content"][0]["type"], "tool_result");
    assert_eq!(saved[3]["content"][0]["text"], "You planned to redo recursion.");
    std::fs::remove_dir_all(&vault).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_in_plain_words() {
    let (base, seen, task) = server(vec![
        plain("401 Unauthorized", &[], r#"{"error":{"message":"Incorrect API key provided: sk-bad***","code":"invalid_api_key"}}"#),
        plain("429 Too Many Requests", &["retry-after: 600"], r#"{"error":{"message":"Rate limit reached"}}"#),
        plain("500 Internal Server Error", &[], "oops"),
        plain("502 Bad Gateway", &[], "oops"),
        plain("503 Service Unavailable", &[], "oops"),
        plain("200 OK", &["content-type: text/html"], "<html>not an api</html>"),
    ])
    .await;
    let p = provider("openai", &base, Some("sk-bad-key-12345"), "gpt-5");
    let e = ask(&p, "hi").await.0.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Auth);
    assert_eq!(e.message, "OpenAI didn’t accept your API key. Check it in Settings.");
    let e = ask(&p, "hi").await.0.unwrap_err();
    assert_eq!((e.kind, e.retry_after), (ErrorKind::RateLimit, Some(600)), "a long wait is the person's to see, not retried");
    assert!(e.message.contains("10 minutes"), "{}", e.message);
    // Server errors are tried three times, then said plainly.
    let e = ask(&p, "hi").await.0.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Unavailable);
    assert_eq!(e.message, "OpenAI is overloaded or having problems right now. Try again in a few minutes.");
    let e = ask(&p, "hi").await.0.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Unavailable);
    assert!(e.message.contains("couldn’t read"), "{}", e.message);
    task.await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_model_that_cant_see_images_gets_a_note_instead() {
    let (base, seen, task) = server(vec![
        plain("400 Bad Request", &[], r#"{"error":{"message":"This model does not support image input."}}"#),
        stream(&[delta(json!({"content": "I can’t see it."})), finish("stop")]),
    ])
    .await;
    let p = provider("deepseek", &base, Some("sk-deepseek-123456"), "deepseek-chat");
    let msgs = [json!({"role": "user", "content": [{"type": "text", "text": "What is this?"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}]})];
    let tools = json!([]);
    let turn = p.turn(ModelRequest { system: "s", messages: &msgs, tools: &tools }, &mut |_| {}).await.unwrap();
    task.await.unwrap();
    assert_eq!(turn.content[0]["text"], "I can’t see it.");
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].body["messages"][1]["content"][1]["image_url"]["url"], "data:image/png;base64,iVBORw0KGgo=");
    assert!(seen[1].body["messages"][1]["content"].as_str().unwrap().contains("can’t see images"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_never_reaches_another_host() {
    // A redirect is not followed: the other host never hears from Phaethon.
    let (other, contacted) = untouched().await;
    let (base, _seen, task) = server(vec![plain("307 Temporary Redirect", &[&format!("location: {other}/chat/completions")], "")]).await;
    let e = ask(&provider("openai", &base, Some("sk-secret-123456"), "gpt-5"), "hi").await.0.unwrap_err();
    task.await.unwrap();
    assert_eq!(e.kind, ErrorKind::BadRequest);
    assert!(e.message.contains("another address"), "{}", e.message);
    assert!(!contacted.await.unwrap(), "the redirect target was contacted");

    // A key saved for one server isn't sent when the address changes to another.
    let (moved_to, contacted) = untouched().await;
    let saved = providers::bind_custom_key("http://127.0.0.1:9/v1", "own-secret-key").unwrap();
    let settings: VaultSettings = serde_json::from_value(json!({"provider": "custom", "providerModels": {"custom": "m"}, "providerUrls": {"custom": moved_to}})).unwrap();
    let r = providers::default_ref(&settings).unwrap();
    let built = providers::build(&settings, &r, |_| Ok(Some(saved.clone())));
    let err = match built {
        Err(e) => e,
        Ok(_) => panic!("a provider was built with a key bound elsewhere"),
    };
    assert!(err.contains("Save the key again"), "{err}");
    assert!(!contacted.await.unwrap());

    // A preset's address can't be moved by the settings file.
    let settings: VaultSettings = serde_json::from_value(json!({"providerUrls": {"openai": "http://127.0.0.1:9/v1"}})).unwrap();
    assert_eq!(providers::base_url(&settings, providers::preset("openai").unwrap()).unwrap(), "https://api.openai.com/v1");

    // Another provider's key is refused before any request is made.
    let (check_at, contacted) = untouched().await;
    let c = openai::check_key(providers::preset("openai").unwrap(), &check_at, "sk-ant-api03-not-for-openai").await;
    assert!(!c.ok && c.message.contains("Anthropic"), "{}", c.message);
    assert!(!contacted.await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_server_gets_no_key() {
    let (base, seen, task) = server(vec![stream(&[delta(json!({"content": "Hi from llama"})), finish("stop")])]).await;
    let settings: VaultSettings = serde_json::from_value(json!({"provider": "ollama", "providerModels": {"ollama": "llama3.2:3b"}, "providerUrls": {"ollama": base}})).unwrap();
    let r = providers::default_ref(&settings).unwrap();
    let Ok(p @ AnyProvider::OpenAi(_)) = providers::build(&settings, &r, |_| panic!("the keychain is never read for a local server")) else {
        panic!("no provider")
    };
    let (turn, _) = ask(&p, "hi").await;
    task.await.unwrap();
    assert_eq!(turn.unwrap().content[0]["text"], "Hi from llama");
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(s.header("authorization"), None);
    assert_eq!(s.body["model"], "llama3.2:3b");

    // Not running: said plainly, at once.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a = l.local_addr().unwrap();
        drop(l);
        format!("http://{a}/v1")
    };
    let p = provider("ollama", &closed, None, "llama3.2");
    let started = std::time::Instant::now();
    let e = ask(&p, "hi").await.0.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Network);
    assert!(e.message.contains("Ollama") && e.message.contains("open and running"), "{}", e.message);
    assert!(started.elapsed() < Duration::from_secs(3), "no retries for a server that isn't there");
    let st = openai::status(providers::preset("ollama").unwrap(), &closed, None).await;
    assert!(!st.running && st.message.starts_with("Ollama isn’t running at http://127.0.0.1:"), "{}", st.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn model_lists_and_key_checks() {
    let (base, seen, task) = server(vec![
        plain("200 OK", &[], r#"{"object":"list","data":[{"id":"gpt-5"},{"id":"text-embedding-3-small"},{"id":"gpt-4.1-mini"},{"id":"bad id"}]}"#),
        plain("200 OK", &[], r#"[{"id":"meta-llama/Llama-3.3-70B-Instruct-Turbo","display_name":"Llama 3.3 70B"}]"#),
        plain("200 OK", &[], r#"{"data":[{"id":"anthropic/claude-sonnet-5","name":"Anthropic: Claude Sonnet 5"}]}"#),
        plain("200 OK", &[], r#"{"object":"list","data":[]}"#),
        plain("200 OK", &[], r#"{"data":{"label":"sk-or-v1-abc...","usage":0}}"#),
        plain("401 Unauthorized", &[], r#"{"error":{"message":"No auth credentials found","code":401}}"#),
    ])
    .await;
    let pr = |id| providers::preset(id).unwrap();
    let m = openai::list_models(pr("openai"), &base, Some("sk-test-123456")).await.unwrap();
    assert_eq!(m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-4.1-mini", "gpt-5"], "chat models only, in order");
    let m = openai::list_models(pr("together"), &base, Some("tgp_v1_123456")).await.unwrap();
    assert_eq!((m[0].id.as_str(), m[0].name.as_str()), ("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B"));
    let m = openai::list_models(pr("openrouter"), &base, None).await.unwrap();
    assert_eq!(m[0].name, "Anthropic: Claude Sonnet 5");
    let st = openai::status(pr("ollama"), &base, None).await;
    assert!(st.running && st.message.contains("ollama pull"), "{}", st.message);
    let ok = openai::check_key(pr("openrouter"), &base, "sk-or-v1-good-key").await;
    assert!(ok.ok, "{}", ok.message);
    let bad = openai::check_key(pr("openrouter"), &base, "sk-or-v1-deleted-key").await;
    assert!(!bad.ok && bad.message.starts_with("OpenRouter didn’t accept this key"), "{}", bad.message);
    task.await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].path(), "/v1/models");
    assert_eq!(seen[2].header("authorization"), None, "OpenRouter's list needs no key");
    assert_eq!(seen[4].path(), "/v1/key", "OpenRouter's key is checked where a key is needed");
    assert_eq!(seen[4].header("authorization").as_deref(), Some("Bearer sk-or-v1-good-key"));
}

/// A space whose model is `provider`'s `model` at `base`, in a vault of its own.
fn space_with(provider: &str, base: &str, model: &str) -> (phaethon_lib::vault::Vault, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("phaethon-sight-{provider}-{}-{}", std::process::id(), base.len()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".phaethon")).unwrap();
    let settings = json!({"provider": provider, "providerModels": {provider: model}, "providerUrls": {provider: base}});
    std::fs::write(root.join(".phaethon/settings.json"), settings.to_string()).unwrap();
    let space = root.join("spaces/school");
    std::fs::create_dir_all(&space).unwrap();
    (phaethon_lib::vault::Vault::at(&root), space)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_providers_list_says_which_models_read_pictures() {
    use phaethon_lib::vision::{self, Sees};
    // OpenRouter's list, as it publishes it: architecture.input_modalities.
    let (base, _seen, task) = server(vec![plain(
        "200 OK",
        &[],
        &json!({"data": [
            {"id": "acme/sees-all", "name": "Acme: Sees", "architecture": {"modality": "text+image->text", "input_modalities": ["text", "image"], "output_modalities": ["text"]}},
            {"id": "google/gemini-text-edition", "name": "Gemini text", "architecture": {"modality": "text->text", "input_modalities": ["text"], "output_modalities": ["text"]}},
            {"id": "acme/says-nothing", "name": "Quiet"}
        ]})
        .to_string(),
    )])
    .await;
    let m = openai::list_models(providers::preset("openrouter").unwrap(), &base, None).await.unwrap();
    task.await.unwrap();
    assert_eq!(m.iter().map(|m| m.sees).collect::<Vec<_>>(), [Some(Sees::Yes), Some(Sees::No), None]);
    assert_eq!(serde_json::to_value(&m[0]).unwrap()["sees"], "yes");
    assert!(serde_json::to_value(&m[2]).unwrap().get("sees").is_none());
    assert_eq!(vision::sees("openrouter", &base, "acme/sees-all"), Sees::Yes, "by the list, though its name says nothing");
    assert_eq!(vision::sees("openrouter", &base, "google/gemini-text-edition"), Sees::No, "by the list, though its name says gemini");
    assert_eq!(vision::sees("openrouter", &base, "acme/says-nothing"), Sees::Unknown, "the list said nothing: by name");

    // Ollama: its OpenAI-style list says nothing, an older /api/tags neither, so /api/show is asked per model.
    let (base, seen, task) = server(vec![
        plain("200 OK", &[], r#"{"object":"list","data":[{"id":"llava:13b"},{"id":"my-notes-model:latest"},{"id":"qwen3:8b"}]}"#),
        plain("200 OK", &[], r#"{"models":[{"name":"llava:13b","model":"llava:13b"},{"name":"my-notes-model:latest","model":"my-notes-model:latest"},{"name":"qwen3:8b","model":"qwen3:8b"}]}"#),
        plain("200 OK", &[], r#"{"details":{"family":"llama"},"model_info":{"general.architecture":"llama"},"capabilities":["completion"]}"#),
        plain("200 OK", &[], r#"{"details":{"family":"gemma3"},"model_info":{"general.architecture":"gemma3"},"capabilities":["completion","vision"]}"#),
        plain("404 Not Found", &[], r#"{"error":"model 'qwen3:8b' not found"}"#),
    ])
    .await;
    let m = openai::list_models(providers::preset("ollama").unwrap(), &base, None).await.unwrap();
    task.await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.iter().map(|s| s.path()).collect::<Vec<_>>(), ["/v1/models", "/api/tags", "/api/show", "/api/show", "/api/show"]);
    assert_eq!(seen[2].body["model"], "llava:13b");
    assert_eq!(seen[3].body["model"], "my-notes-model:latest");
    assert_eq!(m.iter().map(|m| m.sees).collect::<Vec<_>>(), [Some(Sees::No), Some(Sees::Yes), None]);
    assert_eq!(vision::sees("ollama", &base, "llava:13b"), Sees::No, "what Ollama says over the name");
    assert_eq!(vision::sees("ollama", &base, "my-notes-model:latest"), Sees::Yes);

    // Study's decision and its alert follow the list.
    let (vault, space) = space_with("ollama", &base, "my-notes-model:latest");
    let sight = vision::for_space(&vault, &space);
    assert_eq!((sight.sees, sight.shown), (Sees::Yes, true));
    assert_eq!(vision::alert(5, "this course", &sight), None);
    let (vault, space) = space_with("ollama", &base, "llava:13b");
    let sight = vision::for_space(&vault, &space);
    assert_eq!((sight.sees, sight.shown), (Sees::No, false));
    assert_eq!(vision::alert(5, "this course", &sight).unwrap().kind, "cantSee");
    std::fs::remove_dir_all(vault.root()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_ollama_says_in_its_tags_and_show_isnt_asked() {
    use phaethon_lib::vision::{self, Sees};
    let (base, seen, task) = server(vec![
        plain("200 OK", &[], r#"{"object":"list","data":[{"id":"gemma3:4b"},{"id":"flux-image:latest"}]}"#),
        plain("200 OK", &[], r#"{"models":[{"name":"gemma3:4b","model":"gemma3:4b","capabilities":["completion","vision"]},{"name":"flux-image:latest","model":"flux-image:latest","capabilities":["image"]}]}"#),
    ])
    .await;
    let m = openai::list_models(providers::preset("ollama").unwrap(), &base, None).await.unwrap();
    task.await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 2, "no /api/show");
    assert_eq!(m.iter().map(|m| m.sees).collect::<Vec<_>>(), [Some(Sees::Yes), Some(Sees::No)], "\"image\" makes pictures, it doesn't read them");
    assert_eq!(vision::sees("ollama", &base, "flux-image:latest"), Sees::No);
}
