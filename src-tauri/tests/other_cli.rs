//! Codex and Gemini CLI as backends, with the guarantees Claude Code has: the
//! arguments keep them read-only and walled, their JSON events stream, Stop
//! kills them, "not logged in" says how to sign in, each conversation keeps
//! its own session (resumed when reopened, started afresh with the
//! conversation as text when lost), turns are recorded, the tutor mode and the
//! space's model reach them, Clear asks them one tool-less question, each
//! always runs with the vault's own home for it (never the person's), and
//! Settings' sign-in runs the CLI's own sign-in there.
//! Uses fake CLIs that log their arguments and stdin; never the real ones
//! (tests/cli_isolation.rs runs the real ones against a fake model server).
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use phaethon_lib::agent::sign_in::{self, SignInStatus};
use phaethon_lib::agent::{self, AgentEvent, Cli, ErrorCode, Runs, TurnRequest};
use phaethon_lib::thread::{self, Record};
use phaethon_lib::tutor_mode::{self, Mode};
use phaethon_lib::vault::{self, Vault};
use phaethon_lib::{memory, space_model, study};

/// A fake `codex exec --json`: run n logs `args-n` and `stdin-n`. A one-shot
/// (`--ephemeral`) answers one detail; a resumed id listed in `stale` is
/// unknown; "logout" in the message fails as with no login; "slow" sends
/// "Partial" and hangs; otherwise it reads a file and answers "Reply n." in
/// the thread it resumed or `00000000-0000-7000-8000-<n>`. `login` signs in
/// to its CODEX_HOME (slowly, or failing, when told to); `login status` says
/// whether that home is signed in.
const CODEX: &str = r#"
if [ "$1" = debug ] && [ "$2" = models ]; then
  printf '%s' "$CODEX_HOME" > "$d/models-home"
  echo '{"models":[{"slug":"gpt-6-astra","display_name":"GPT-6-Astra","description":"Frontier.","visibility":"list","priority":2},{"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","priority":1},{"slug":"codex-auto-review","display_name":"Review","visibility":"hide","priority":3}]}'
  exit 0
fi
if [ "$1" = login ]; then
  if [ "$2" = status ]; then
    if [ -f "$CODEX_HOME/signed-in" ]; then echo "Logged in using ChatGPT"; exit 0; fi
    echo "Not logged in"; exit 1
  fi
  printf '%s' "$CODEX_HOME" > "$d/login-home"
  echo "Starting local login server on http://localhost:1455."
  [ -f "$d/login-slow" ] && sleep 30
  if [ -f "$d/login-fails" ]; then echo "Error logging in: Login was not completed" >&2; exit 1; fi
  touch "$CODEX_HOME/signed-in"; echo "Successfully logged in"; exit 0
fi
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
printf '%s\n' "$@" > "$d/args-$n"
printf '%s' "${CODEX_HOME:-unset}" > "$d/home-$n"
cat > "$d/stdin-$n"
case " $* " in *" --ephemeral "*)
  echo '{"type":"thread.started","thread_id":"00000000-0000-7000-8000-ffffffffffff"}'
  echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"- Test 1 for C241 is on Thursday."}}'
  echo '{"type":"turn.completed","usage":{}}'; exit 0;;
esac
resume=""; prev=""
for a in "$@"; do [ "$prev" = "resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ] && grep -qx "$resume" "$d/stale" 2>/dev/null; then
  echo "Error: thread/resume: thread/resume failed: no rollout found for thread id $resume (code -32600)" >&2; exit 1
fi
tid=${resume:-$(printf '00000000-0000-7000-8000-%012d' $n)}
echo "{\"type\":\"thread.started\",\"thread_id\":\"$tid\"}"
echo '{"type":"turn.started"}'
if grep -q logout "$d/stdin-$n"; then
  echo '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}'
  echo '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}'; exit 1
fi
if grep -q slow "$d/stdin-$n"; then
  echo '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Partial"}}'
  sleep 30
fi
echo "{\"type\":\"item.started\",\"item\":{\"id\":\"c\",\"type\":\"command_execution\",\"command\":\"/bin/zsh -lc 'cat $PWD/notes.md'\",\"status\":\"in_progress\"}}"
echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"m\",\"type\":\"agent_message\",\"text\":\"Reply $n.\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
"#;

/// A fake `gemini --output-format stream-json`, as above; a one-shot is
/// `--output-format json`. Sessions are `00000000-0000-4000-8000-<n>`.
/// `--output-format text` is Settings' sign-in: it asks before "opening the
/// browser" as Gemini CLI does, waits for the answer on stdin, and ends at
/// "No input provided" (signed in) or says why not.
const GEMINI: &str = r#"
case " $* " in *" text "*)
  printf '%s' "$GEMINI_CLI_HOME" > "$d/signin-home"; printf '%s' "$PWD" > "$d/signin-cwd"
  printf '\nOpening authentication page in your browser. Do you want to continue? [Y/n]: '
  read answer
  [ -f "$d/signin-slow" ] && sleep 30
  if [ "$answer" = y ]; then
    [ -f "$d/signin-ineligible" ] && echo "Error authenticating: IneligibleTierError: This client is no longer supported." >&2
    echo "No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option." >&2; exit 42
  fi
  echo "Error authenticating: FatalCancellationError: Authentication cancelled by user." >&2; exit 42;;
esac
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
printf '%s\n' "$@" > "$d/args-$n"
printf '%s' "${GEMINI_CLI_HOME:-unset}" > "$d/home-$n"
cat > "$d/stdin-$n"
printf '%s' "${GEMINI_CLI_TRUST_WORKSPACE:-unset} ${GEMINI_SYSTEM_MD:-unset}" > "$d/env-$n"
case " $* " in *" json "*)
  echo '{"session_id":"00000000-0000-4000-8000-ffffffffffff","response":"- Test 1 for C241 is on Thursday.","stats":{}}'; exit 0;;
esac
resume=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ] && grep -qx "$resume" "$d/stale" 2>/dev/null; then
  echo "Error resuming session: Invalid session identifier \"$resume\"." >&2; exit 42
fi
sid=${resume:-$(printf '00000000-0000-4000-8000-%012d' $n)}
if grep -q ineligible "$d/stdin-$n"; then
  printf 'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.\n    at x (file:///y.js:1:1)\n' >&2; exit 1
fi
if grep -q logout "$d/stdin-$n"; then
  echo '{"type":"result","status":"error","error":{"type":"FatalAuthenticationError","message":"Failed to sign in."},"stats":{}}'; exit 41
fi
echo "{\"type\":\"init\",\"session_id\":\"$sid\",\"model\":\"auto\"}"
if grep -q slow "$d/stdin-$n"; then
  echo '{"type":"message","role":"assistant","content":"Partial","delta":true}'
  sleep 30
fi
echo "{\"type\":\"tool_use\",\"tool_name\":\"read_file\",\"tool_id\":\"t\",\"parameters\":{\"file_path\":\"$PWD/notes.md\"}}"
echo "{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Reply $n.\",\"delta\":true}"
echo '{"type":"result","status":"success","stats":{}}'
"#;

fn fake(root: &Path, name: &str, body: &str) -> PathBuf {
    fs::create_dir_all(root).unwrap();
    let bin = root.join(name);
    fs::write(&bin, format!("#!/bin/sh\nd='{}'\n{body}", root.display())).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

struct Fixture {
    root: PathBuf,
    vault: Vault,
    dir: PathBuf,
    runs: Runs,
    cli: Cli,
    /// Where Phaethon keeps the CLIs' own homes (the app's data folder).
    homes: PathBuf,
}

impl Fixture {
    fn new(cli: Cli, tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("phaethon-other-cli-{}-{tag}-{}", cli.id(), std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let vault = Vault::at(root.join("vault"));
        vault.ensure_initialized().unwrap();
        vault.set_setting("backend", format!("{}-cli", cli.id()).into()).unwrap();
        let dir = vault.space_dir("school").unwrap();
        fs::write(dir.join("notes.md"), "Test 1 is on Thursday.").unwrap();
        let homes = root.join("cli-homes");
        Fixture { root, vault, dir, runs: Runs::default(), cli, homes }
    }
    /// The vault's own home for the CLI, as Phaethon chooses it.
    fn home(&self) -> PathBuf {
        study::model::cli_config_dir(&self.vault, Some(&self.homes), self.cli).expect("Codex and Gemini CLI always have one")
    }
    fn run(&self) -> usize {
        fs::read_to_string(self.root.join("count")).map_or(0, |s| s.trim().parse().unwrap())
    }
    fn args(&self, n: usize) -> Vec<String> {
        fs::read_to_string(self.root.join(format!("args-{n}"))).unwrap().lines().map(str::to_string).collect()
    }
    fn stdin(&self, n: usize) -> String {
        fs::read_to_string(self.root.join(format!("stdin-{n}"))).unwrap()
    }
    fn after(&self, n: usize, flag: &str) -> Option<String> {
        let a = self.args(n);
        a.iter().position(|x| x == flag).map(|i| a[i + 1].clone())
    }
    fn resumed(&self, n: usize) -> Option<String> {
        self.after(n, if self.cli == Cli::Codex { "resume" } else { "--resume" })
    }
    fn send_with(&self, prompt: &str, add_dirs: Vec<(String, PathBuf)>) -> Vec<AgentEvent> {
        let mut events = vec![];
        tauri::async_runtime::block_on(agent::run_cli_turn(
            &self.runs,
            "school",
            self.cli,
            TurnRequest {
                space_dir: &self.dir,
                prompt,
                attachments: vec![],
                replace_from: None,
                config_dir: Some(self.home()),
                add_dirs,
                model: space_model::get_cli(&self.dir, self.cli.id()),
                full_access: false,
            },
            |e| events.push(e),
        ));
        assert!(matches!(events.last(), Some(AgentEvent::End { .. })), "{events:?}");
        events
    }
    fn send(&self, prompt: &str) -> Vec<AgentEvent> {
        self.send_with(prompt, vec![])
    }
    fn shown(&self) -> Vec<(String, String)> {
        thread::to_ui(&thread::load(&self.dir).unwrap()).into_iter().map(|m| (m.role.to_string(), m.text)).collect()
    }
}

fn says(role: &str, text: &str) -> (String, String) {
    (role.into(), text.into())
}

fn no_errors(events: &[AgentEvent]) {
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:?}");
}

/// Everything a CLI backend must do, for `cli` with its fake at `bin_var`.
fn conversations_work_with(cli: Cli, bin_var: &str, script: &str) {
    let f = Fixture::new(cli, "turns");
    // Debug builds honour this override (see agent::codex::find_codex, agent::gemini::find_gemini).
    unsafe { std::env::set_var(bin_var, fake(&f.root, cli.id(), script)) };
    let tag = Some(cli.id());

    // A first turn: streamed, a tool receipt, recorded, its session saved under the CLI's tag.
    let events = f.send("When is Test 1?");
    no_errors(&events);
    // Always the vault's own home for this CLI, though the vault never asked to keep Claude Code's apart.
    assert!(!f.vault.settings().isolate_claude_config);
    assert_eq!(study::model::cli_config_dir(&f.vault, Some(&f.homes), Cli::Claude), None);
    assert_eq!(f.home(), f.homes.join(format!("{}-{}", f.vault.name(), cli.id())));
    assert_eq!(fs::read_to_string(f.root.join("home-1")).unwrap(), f.home().to_str().unwrap());
    let texts: Vec<&AgentEvent> = events.iter().filter(|e| matches!(e, AgentEvent::Text { .. } | AgentEvent::Tool { .. })).collect();
    let label = if cli == Cli::Codex { "Running cat notes.md" } else { "Reading file notes.md" };
    assert_eq!(texts, [&AgentEvent::Tool { label: label.into() }, &AgentEvent::Text { delta: "Reply 1.".into() }]);
    // Gemini CLI has no system prompt: Phaethon's instructions (how to offer a quiz from the chat) go before each message.
    let message = |n: usize| f.stdin(n).rsplit("</phaethon_tutor_mode>\n\n").next().unwrap_or_default().to_string();
    assert_eq!(message(1), "When is Test 1?", "the message goes over stdin, never argv");
    assert!(!f.args(1).iter().any(|a| a.contains("When is Test 1?")));
    assert_eq!(f.resumed(1), None);
    assert_eq!(f.shown(), vec![says("user", "When is Test 1?"), says("assistant", "Reply 1.")]);
    let s1 = vault::read_cli_session(&f.dir, tag).expect("session saved");
    assert_eq!(vault::read_session(&f.dir), None, "Claude Code would never resume it");
    assert!(fs::read_to_string(f.dir.join(".phaethon/session")).unwrap().starts_with(&format!("{}:", cli.id())));

    // The next turn resumes it and gets only the new message.
    f.send("And Test 2?");
    assert_eq!(f.resumed(2).as_deref(), Some(s1.as_str()));
    assert_eq!(message(2), "And Test 2?");

    // Read-only and walled, whatever else is passed.
    let course = f.root.join("courses/C241");
    fs::create_dir_all(&course).unwrap();
    tutor_mode::set(&f.vault, "school", Mode::Quiz).unwrap();
    space_model::set_cli(&f.vault, "school", cli.id(), Some("model-x")).unwrap();
    f.send_with("Quiz me", vec![("courses/C241".into(), course.clone())]);
    let a = f.args(3);
    let has = |w: &[&str]| a.windows(w.len()).any(|x| x == w);
    assert!(!a.iter().any(|x| x.contains("dangerously") || x == "--yolo" || x == "-y" || x == "--add-dir" || x == "--sandbox" || x == "--skip-trust"), "{a:?}");
    match cli {
        Cli::Codex => {
            assert!(has(&["-m", "model-x"]) && has(&["--cd", f.dir.to_str().unwrap()]));
            assert!(has(&["--ignore-user-config"]) && has(&["--ignore-rules"]) && has(&["-c", "approval_policy=\"never\""]));
            let profile = a.iter().find(|x| x.starts_with("permissions.phaethon.filesystem=")).unwrap();
            assert!(profile.contains(&format!("\"{}\"=\"read\"", course.display())) && !profile.contains("write"), "{profile}");
            let dev = a.iter().find(|x| x.starts_with("developer_instructions=")).expect("the mode is Codex's developer instructions");
            assert!(dev.contains("A quiz or flashcards from the chat") && dev.contains("Tutor mode: Quiz me"));
            assert_eq!(f.stdin(3), "Quiz me");
        }
        Cli::Gemini => {
            assert!(has(&["--model", "model-x"]) && has(&["--approval-mode", "plan"]) && has(&["--extensions", "none"]));
            assert!(has(&["--include-directories", course.to_str().unwrap()]));
            let policy = f.after(3, "--admin-policy").unwrap();
            assert_eq!(f.after(3, "--policy").as_deref(), Some(policy.as_str()));
            assert!(fs::read_to_string(&policy).unwrap().contains("toolName = \"*\"\ndecision = \"deny\""));
            assert!(
                f.stdin(3).starts_with("<phaethon_tutor_mode>\n# A quiz or flashcards from the chat") && f.stdin(3).contains("\n\n# Tutor mode: Quiz me") && f.stdin(3).ends_with("\n\nQuiz me"),
                "{}",
                f.stdin(3)
            );
            assert_eq!(fs::read_to_string(f.root.join("env-3")).unwrap(), "true unset", "trusted for the run; no replaced system prompt");
        }
        Cli::Claude => unreachable!(),
    }
    assert_eq!(f.shown()[4], says("user", "Quiz me"), "the conversation keeps what was written, not the mode");
    tutor_mode::set(&f.vault, "school", Mode::Normal).unwrap();
    space_model::set_cli(&f.vault, "school", cli.id(), None).unwrap();

    // A new conversation starts afresh; reopening the first resumes its own session.
    thread::start_new(&f.dir).unwrap();
    f.send("New topic");
    assert_eq!(f.resumed(4), None);
    assert!(!f.args(4).iter().any(|x| x == "-m" || x == "--model"), "the CLI's own default model");
    let list = thread::list(&f.dir).unwrap();
    assert_eq!(list.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["New topic", "When is Test 1?"]);
    thread::open(&f.dir, &list[1].id).unwrap();
    f.send("Back again");
    assert_eq!(f.resumed(5).as_deref(), Some(s1.as_str()));

    // The session is gone on the CLI's side: once more afresh, given the conversation, recorded once.
    fs::write(f.root.join("stale"), format!("{s1}\n")).unwrap();
    let events = f.send("Still there?");
    no_errors(&events);
    assert_eq!((f.resumed(6).as_deref(), f.resumed(7)), (Some(s1.as_str()), None));
    let asked = f.stdin(7);
    assert!(asked.contains("User: When is Test 1?") && asked.contains("Phaethon: Reply 5.") && asked.ends_with("Still there?"), "{asked}");
    assert_eq!(f.shown().iter().filter(|m| m.1 == "Still there?").count(), 1);

    // A conversation Claude Code had: its session isn't this CLI's, so it starts afresh with the text.
    thread::start_new(&f.dir).unwrap();
    f.send("Hello");
    vault::write_session(&f.dir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap();
    f.send("Hello again");
    let n = f.run();
    assert_eq!(f.resumed(n), None);
    assert!(f.stdin(n).contains("User: Hello") && f.stdin(n).ends_with("Hello again"));

    // Not logged in: said in plain words with the CLI's own sign-in command; the question is kept.
    let events = f.send("logout please");
    let err = events.iter().find_map(|e| match e {
        AgentEvent::Error { code, message, .. } => Some((*code, message.clone())),
        _ => None,
    });
    assert_eq!(err, Some((ErrorCode::NotLoggedIn, cli.not_logged_in_message(None))));
    assert_eq!(f.shown().last().unwrap(), &says("user", "logout please"));
    if cli == Cli::Gemini {
        // Signed in, but Google refuses the account (what the real CLI said here, Oct 2026).
        let events = f.send("ineligible");
        assert!(events.contains(&AgentEvent::error(ErrorCode::Cli, agent::gemini::INELIGIBLE_MESSAGE)), "{events:?}");
    }

    // Stop keeps what streamed, with the stopped record, and kills the process group.
    let canceller = f.runs.clone();
    let watcher = std::thread::spawn(move || {
        let start = Instant::now();
        while canceller.running_pid("school").is_none() {
            assert!(start.elapsed() < Duration::from_secs(20), "the fake never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(400));
        let pid = canceller.running_pid("school").unwrap();
        assert!(canceller.cancel("school"));
        pid
    });
    let started = Instant::now();
    let events = f.send("Go slow");
    let pid = watcher.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(10), "stopped, not waited out");
    let tail: Vec<&AgentEvent> = events.iter().rev().take(2).collect();
    assert_eq!(tail[1], &AgentEvent::Cancelled);
    let ui = thread::to_ui(&thread::load(&f.dir).unwrap());
    assert_eq!((ui.last().unwrap().text.as_str(), ui.last().unwrap().records.clone()), ("Partial", vec![Record::Stopped]));
    // SAFETY: signal 0 only checks whether the group still exists.
    assert_ne!(unsafe { libc_killpg(pid) }, 0, "the CLI's process group is gone");

    // Clear asks the CLI one question with no tools, then removes the conversation.
    let model = study::model::for_space(&f.vault, &f.dir, Some(&f.homes)).unwrap();
    let out = tauri::async_runtime::block_on(memory::clear(&f.dir, "current", Ok(&model))).unwrap();
    assert_eq!(out, memory::ClearOutcome::Cleared { kept: vec!["Test 1 for C241 is on Thursday.".into()] });
    let n = f.run();
    assert_eq!(fs::read_to_string(f.root.join(format!("home-{n}"))).unwrap(), f.home().to_str().unwrap(), "one-shot questions too");
    let a = f.args(n);
    match cli {
        Cli::Codex => {
            assert!(a.iter().any(|x| x == "--ephemeral"));
            assert!(a.windows(2).any(|w| w == ["--disable", "shell_tool"]) && a.windows(2).any(|w| w == ["--disable", "unified_exec"]));
            assert!(a.iter().any(|x| x.starts_with("developer_instructions=")));
            assert!(!a.iter().any(|x| x.contains(f.dir.join("notes.md").to_str().unwrap())));
        }
        _ => {
            assert!(a.windows(2).any(|w| w == ["--output-format", "json"]));
            let policy = f.after(n, "--admin-policy").unwrap();
            assert!(fs::read_to_string(policy).unwrap().contains("# Phaethon: no tools."));
            assert!(f.stdin(n).starts_with("<instructions>\n"));
        }
    }
    assert!(f.stdin(n).contains("User: Hello"));
    assert!(thread::load(&f.dir).unwrap().is_empty());
    assert_eq!(vault::read_cli_session(&f.dir, tag), None);

    signing_in_works(&f);
    if cli == Cli::Codex {
        // Its model menu: what `codex debug models` lists in Codex's own picker, run with the vault's home.
        let listed = tauri::async_runtime::block_on(agent::models::list(cli, Some(&f.home())));
        assert_eq!(listed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-6-astra"]);
        assert_eq!(listed.note, None);
        assert_eq!(fs::read_to_string(f.root.join("models-home")).unwrap(), f.home().to_str().unwrap());
    }
    fs::remove_dir_all(&f.root).unwrap();
}

/// Settings' sign-in: the CLI's own, in the vault's home, said in words; Stop ends it.
fn signing_in_works(f: &Fixture) {
    let cli = f.cli;
    let sign_in = || tauri::async_runtime::block_on(sign_in::sign_in(&f.runs, cli, &f.home()));
    let (slow, fails) = match cli {
        Cli::Codex => ("login-slow", "login-fails"),
        _ => ("signin-slow", "signin-ineligible"),
    };
    // It fails: said in words, from the CLI's own.
    fs::write(f.root.join(fails), "").unwrap();
    let out = sign_in();
    assert_eq!(out.status, SignInStatus::NotSignedIn, "{out:?}");
    match cli {
        Cli::Codex => assert_eq!(out.message, "Codex didn’t finish signing in: Error logging in: Login was not completed"),
        _ => assert_eq!(out.message, agent::gemini::INELIGIBLE_MESSAGE),
    }
    fs::remove_file(f.root.join(fails)).unwrap();

    let out = sign_in();
    assert_eq!(out.status, SignInStatus::SignedIn, "{out:?}");
    assert_eq!(out.message, format!("Signed in to {} for this Phaethon folder.", cli.name()));
    match cli {
        Cli::Codex => {
            assert_eq!(fs::read_to_string(f.root.join("login-home")).unwrap(), f.home().to_str().unwrap());
            // Settings asks Codex itself, with the vault's home.
            let info = tauri::async_runtime::block_on(agent::clis_info(|c| study::model::cli_config_dir(&f.vault, Some(&f.homes), c)));
            let codex = info.iter().find(|c| c.id == "codex").unwrap();
            assert_eq!((codex.logged_in, codex.own_home), (Some(true), true));
            assert!(!info.iter().find(|c| c.id == "claude").unwrap().own_home);
        }
        _ => {
            assert_eq!(fs::read_to_string(f.root.join("signin-home")).unwrap(), f.home().to_str().unwrap());
            // An empty folder of its own in that home, never the space.
            assert_eq!(fs::read_to_string(f.root.join("signin-cwd")).unwrap(), f.home().join("sign-in").canonicalize().unwrap().to_str().unwrap());
            let settings = fs::read_to_string(f.home().join(".gemini/settings.json")).unwrap();
            assert!(settings.contains("\"selectedType\": \"oauth-personal\""), "{settings}");
        }
    }

    // Stop while it waits for the browser.
    fs::write(f.root.join(slow), "").unwrap();
    let canceller = f.runs.clone();
    let watcher = std::thread::spawn(move || {
        let start = Instant::now();
        while canceller.running_pid(&sign_in::run_key(cli)).is_none() {
            assert!(start.elapsed() < Duration::from_secs(20), "the sign-in never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(400));
        assert!(sign_in::cancel(&canceller, cli));
    });
    let started = Instant::now();
    let out = sign_in();
    watcher.join().unwrap();
    assert_eq!(out.status, SignInStatus::Cancelled, "{out:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "stopped, not waited out");
    assert!(!sign_in::cancel(&f.runs, cli), "nothing left waiting");
    fs::remove_file(f.root.join(slow)).unwrap();
}

/// `killpg(pid, 0)`: 0 while the process group exists.
unsafe fn libc_killpg(pid: u32) -> i32 {
    unsafe extern "C" {
        fn killpg(pgrp: i32, sig: i32) -> i32;
    }
    unsafe { killpg(pid as i32, 0) }
}

#[test]
fn codex_conversations_are_read_only_recorded_resumed_and_stoppable() {
    conversations_work_with(Cli::Codex, "PHAETHON_CODEX_BIN", CODEX);
}

#[test]
fn gemini_conversations_are_read_only_recorded_resumed_and_stoppable() {
    conversations_work_with(Cli::Gemini, "PHAETHON_GEMINI_BIN", GEMINI);
}

#[test]
fn gemini_refuses_a_space_with_its_own_settings_folder() {
    // Its own fixture folder, so it never meets the other Gemini test's.
    let mut f = Fixture::new(Cli::Gemini, "refuse");
    f.dir = f.vault.space_dir("work").unwrap();
    fs::create_dir_all(f.dir.join(".gemini")).unwrap();
    let events = f.send("hi");
    assert!(matches!(&events[0], AgentEvent::Error { code: ErrorCode::Cli, message, .. } if message.contains(".gemini")), "{events:?}");
    assert!(thread::load(&f.dir).unwrap().is_empty(), "nothing sent, nothing recorded");
}
