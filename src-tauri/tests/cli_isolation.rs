//! The real Codex and Gemini CLI, run as Phaethon runs them, against a fake
//! model server on this computer: the person's global instructions file
//! (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`), skills, settings and hooks
//! never reach a space, because each CLI runs with the vault's own home. A
//! control run with the person's home shows the same setup would catch them.
//! Gemini CLI's own sign-in is also run as Settings runs it, up to the browser
//! (a fake `open` takes the address), and signed in it sends the model nothing.
//!
//! Throwaway homes that mimic the person's; never their real ones, never
//! their account, nothing leaves this computer. Needs the CLIs installed:
//! `cargo test --test cli_isolation -- --ignored --test-threads=1`.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use phaethon_lib::agent::sign_in::{self, SignInStatus};
use phaethon_lib::agent::{self, Cli, Runs, codex, gemini};

const MARKER: &str = "GLOBAL-MARKER-7731";
const SKILL_MARKER: &str = "PERSON-SKILL-5512";

/// A model server that logs each request (path and body) and answers "ok",
/// as OpenAI's Responses API (SSE) or Gemini's generateContent.
struct FakeModel {
    port: u16,
    log: Arc<Mutex<Vec<(String, String)>>>,
}

impl FakeModel {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(vec![]));
        let l = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let l = l.clone();
                std::thread::spawn(move || {
                    let mut r = BufReader::new(stream.try_clone().unwrap());
                    let mut first = String::new();
                    if r.read_line(&mut first).is_err() {
                        return;
                    }
                    let path = first.split(' ').nth(1).unwrap_or("").to_string();
                    let mut len = 0;
                    loop {
                        let mut h = String::new();
                        if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut body = vec![0; len];
                    let _ = r.read_exact(&mut body);
                    l.lock().unwrap().push((path.clone(), String::from_utf8_lossy(&body).into_owned()));
                    let (kind, out) = if path.contains("responses") {
                        let evs = [
                            r#"{"type":"response.created","response":{"id":"resp_1"}}"#,
                            r#"{"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"m1","content":[{"type":"output_text","text":"ok"}]}}"#,
                            r#"{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"input_tokens_details":null,"output_tokens":1,"output_tokens_details":null,"total_tokens":2}}}"#,
                        ];
                        let sse: String = evs
                            .iter()
                            .map(|e| format!("event: {}\ndata: {e}\n\n", serde_json::from_str::<serde_json::Value>(e).unwrap()["type"].as_str().unwrap()))
                            .collect();
                        ("text/event-stream", sse)
                    } else {
                        let chunk = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}"#;
                        if path.contains("stream") { ("text/event-stream", format!("data: {chunk}\n\n")) } else { ("application/json", chunk.to_string()) }
                    };
                    let mut s = stream;
                    let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}", out.len());
                });
            }
        });
        FakeModel { port, log }
    }
    fn take(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

/// A throwaway root: the person's home (`person`), the vault's homes for
/// the CLIs (`homes`), a space. Hooks write into `hooks/`.
fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("phaethon-cli-isolation-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for d in ["person", "homes", "space", "hooks"] {
        fs::create_dir_all(root.join(d)).unwrap();
    }
    fs::write(root.join("space/notes.md"), "Test 1 is on Thursday.").unwrap();
    root
}

fn ran_hooks(root: &Path) -> Vec<String> {
    fs::read_dir(root.join("hooks")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()
}

fn run(mut cmd: tokio::process::Command, stdin: &str) -> std::process::Output {
    use tokio::io::AsyncWriteExt;
    tauri::async_runtime::block_on(async {
        let mut child = cmd.spawn().expect("the CLI starts");
        let mut input = child.stdin.take().unwrap();
        input.write_all(stdin.as_bytes()).await.unwrap();
        drop(input);
        tokio::time::timeout(Duration::from_secs(120), child.wait_with_output()).await.expect("the CLI finished").unwrap()
    })
}

#[test]
#[ignore = "runs the real codex against a fake model server"]
fn codex_never_loads_the_persons_instructions_skills_or_hooks() {
    let bin = codex::find_codex().expect("codex is installed");
    let root = root("codex");
    let person = root.join("person");
    // The person's own Codex setup: a global AGENTS.md, a skill, a hook in config.toml and in hooks.json.
    let theirs = person.join(".codex");
    fs::create_dir_all(theirs.join("skills/theirs")).unwrap();
    fs::write(theirs.join("AGENTS.md"), format!("{MARKER} always say pineapple")).unwrap();
    fs::write(theirs.join("skills/theirs/SKILL.md"), format!("---\nname: theirs\ndescription: {SKILL_MARKER}\n---\n{SKILL_MARKER}")).unwrap();
    fs::create_dir_all(person.join(".agents/skills/theirs")).unwrap();
    fs::write(person.join(".agents/skills/theirs/SKILL.md"), format!("---\nname: agents-theirs\ndescription: {SKILL_MARKER}\n---\n{SKILL_MARKER}")).unwrap();
    let hook = |name: &str| format!("touch {}", root.join("hooks").join(name).display());
    fs::write(
        theirs.join("config.toml"),
        format!("[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = \"{}\"\n", hook("config-toml")),
    )
    .unwrap();
    fs::write(
        theirs.join("hooks.json"),
        serde_json::json!({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": hook("hooks-json")}]}], "UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook("hooks-json")}]}]}}).to_string(),
    )
    .unwrap();

    let server = FakeModel::start();
    let space = root.join("space");
    let turn = |home: &Path| {
        let mut cmd = agent::command(Cli::Codex, &bin, &space, Some(home));
        cmd.env("HOME", &person);
        let mut args = codex::cli_args(&space, &bin, &[], None, None, None);
        // The person's config.toml is never read, so the fake server is given as overrides.
        let provider = format!("model_providers.fake={{name=\"fake\",base_url=\"http://127.0.0.1:{}/v1\",wire_api=\"responses\"}}", server.port);
        args.splice(1..1, ["-c".to_string(), "model_provider=\"fake\"".into(), "-c".into(), provider]);
        cmd.args(args);
        let out = run(cmd, "hello");
        let said = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(said.contains("\"turn.completed\""), "the turn ran: {said}\n{}", String::from_utf8_lossy(&out.stderr));
        let sent = server.take();
        assert!(sent.iter().any(|(p, _)| p.contains("responses")), "{sent:?}");
        sent.into_iter().map(|(_, b)| b).collect::<String>()
    };

    // Control: with the person's own home, their AGENTS.md reaches the model.
    let sent = turn(&theirs);
    assert!(sent.contains(MARKER), "the control run sees the global AGENTS.md");
    // Skills are kept out by Phaethon's arguments whatever the home (`skills.include_instructions=false`).
    assert!(!sent.contains(SKILL_MARKER));

    // As Phaethon runs it: the vault's own home. Nothing of theirs is sent, no hook of theirs runs.
    let home = root.join("homes/default-codex");
    let sent = turn(&home);
    assert!(sent.contains("hello"), "the message itself was sent");
    assert!(!sent.contains(MARKER), "the person's AGENTS.md never reaches the model");
    assert!(!sent.contains(SKILL_MARKER), "nor their skills");
    assert_eq!(ran_hooks(&root), Vec::<String>::new(), "no hook of theirs ran");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
#[ignore = "runs the real gemini against a fake model server and a fake browser"]
fn gemini_never_loads_the_persons_instructions_settings_or_hooks_and_signs_in_there() {
    let real = gemini::find_gemini().expect("gemini is installed");
    let root = root("gemini");
    let person = root.join("person");
    // The person's own Gemini CLI setup: GEMINI.md, a skill, settings with hooks (and an API key chosen).
    let theirs = person.join(".gemini");
    fs::create_dir_all(theirs.join("skills/theirs")).unwrap();
    fs::write(theirs.join("GEMINI.md"), format!("{MARKER} always say pineapple")).unwrap();
    fs::write(theirs.join("skills/theirs/SKILL.md"), format!("---\nname: theirs\ndescription: {SKILL_MARKER}\n---\n{SKILL_MARKER}")).unwrap();
    let hook = |name: &str| serde_json::json!([{"hooks": [{"type": "command", "command": format!("touch {}", root.join("hooks").join(name).display())}]}]);
    let api_key = serde_json::json!({"security": {"auth": {"selectedType": "gemini-api-key"}}});
    let mut settings = api_key.clone();
    settings["hooks"] = serde_json::json!({"SessionStart": hook("session-start"), "BeforeAgent": hook("before-agent")});
    fs::write(theirs.join("settings.json"), settings.to_string()).unwrap();

    let server = FakeModel::start();
    // Gemini CLI as the person runs it, with an API key and the fake server, and a fake `open`
    // that takes the sign-in address instead of opening a browser.
    let fakebin = root.join("fakebin");
    fs::create_dir_all(&fakebin).unwrap();
    let opened = root.join("opened");
    let script = |path: &Path, body: String| {
        fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    };
    script(&fakebin.join("open"), format!("printf '%s\\n' \"$@\" >> '{}'\n", opened.display()));
    let wrapper = root.join("gemini");
    script(
        &wrapper,
        format!(
            "export HOME='{}' GEMINI_API_KEY=fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:{} PATH='{}':\"$PATH\"\nexec '{}' \"$@\"\n",
            person.display(),
            server.port,
            fakebin.display(),
            real.display()
        ),
    );
    // Debug builds run this instead of the gemini on PATH (only this test sets it).
    unsafe { std::env::set_var("PHAETHON_GEMINI_BIN", &wrapper) };

    let space = root.join("space");
    let policy = gemini::policy_file(false).unwrap();
    let turn = |home: &Path| {
        let mut cmd = agent::command(Cli::Gemini, &wrapper, &space, Some(home));
        cmd.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
        cmd.args(gemini::cli_args(&policy, &[], None, None));
        let out = run(cmd, &gemini::prompt(None, "hello"));
        let said = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(said.contains("\"status\":\"success\""), "the turn ran: {said}\n{}", String::from_utf8_lossy(&out.stderr));
        server.take().into_iter().map(|(_, b)| b).collect::<String>()
    };

    // Control: with the person's own home, their GEMINI.md reaches the model and their hooks run.
    let sent = turn(&person);
    assert!(sent.contains(MARKER), "the control run sees the global GEMINI.md");
    assert!(sent.contains(SKILL_MARKER), "and their skills");
    assert!(!ran_hooks(&root).is_empty(), "the control run runs their hooks");
    fs::remove_dir_all(root.join("hooks")).unwrap();
    fs::create_dir_all(root.join("hooks")).unwrap();

    // As Phaethon runs it: the vault's own home, signed in there (an API key chosen in it).
    let home = root.join("homes/default-gemini");
    fs::create_dir_all(home.join(".gemini")).unwrap();
    fs::write(home.join(".gemini/settings.json"), api_key.to_string()).unwrap();
    let sent = turn(&home);
    assert!(sent.contains("hello"), "the message itself was sent");
    assert!(!sent.contains(MARKER), "the person's GEMINI.md never reaches the model");
    assert!(!sent.contains(SKILL_MARKER), "nor their skills");
    assert_eq!(ran_hooks(&root), Vec::<String>::new(), "no hook of theirs ran");

    // Settings' sign-in, already signed in there: it says so and sends the model nothing.
    let runs = Runs::default();
    let out = tauri::async_runtime::block_on(sign_in::sign_in(&runs, Cli::Gemini, &home));
    assert_eq!(out.status, SignInStatus::SignedIn, "{out:?}");
    let sent = server.take();
    assert!(!sent.iter().any(|(p, _)| p.contains("generateContent")), "no model turn: {sent:?}");

    // A home not signed in: Gemini CLI's own Google sign-in, which asks first, then opens the browser.
    let fresh = root.join("homes/fresh-gemini");
    let canceller = runs.clone();
    let seen = opened.clone();
    let watcher = std::thread::spawn(move || {
        let start = Instant::now();
        while !seen.exists() {
            assert!(start.elapsed() < Duration::from_secs(60), "the browser never opened");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(sign_in::cancel(&canceller, Cli::Gemini));
    });
    let out = tauri::async_runtime::block_on(sign_in::sign_in(&runs, Cli::Gemini, &fresh));
    watcher.join().unwrap();
    assert_eq!(out.status, SignInStatus::Cancelled, "{out:?}");
    let url = fs::read_to_string(&opened).unwrap();
    assert!(url.starts_with("https://accounts.google.com/") && url.contains("redirect_uri=http%3A%2F%2F127.0.0.1"), "{url}");
    let chosen: serde_json::Value = serde_json::from_str(&fs::read_to_string(fresh.join(".gemini/settings.json")).unwrap()).unwrap();
    assert_eq!(chosen["security"]["auth"]["selectedType"], "oauth-personal");
    assert!(server.take().is_empty(), "nothing was sent to the model");
    fs::remove_dir_all(&root).unwrap();
}
