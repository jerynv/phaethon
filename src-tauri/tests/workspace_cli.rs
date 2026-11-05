//! Real subprocesses and a persisted device-local binding, never real CLIs or
//! projects. A working folder changes execution, not managed conversation IO.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use phaethon_lib::agent::{self, AgentEvent, Cli, ErrorCode, Runs, TurnRequest};
use phaethon_lib::thread::{self, Record, ToolStatus};
use phaethon_lib::vault::{self, Vault};
use phaethon_lib::workspace;

fn fake(root: &Path, cli: Cli) -> PathBuf {
    let bin = root.join(format!("fake-{}", cli.id()));
    let response = match cli {
        Cli::Claude => r#"
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"r1\",\"name\":\"Read\",\"input\":{\"file_path\":\"$PWD/notes.md\"}}]}}"
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r1","content":"fixture read"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Fixture completed","session_id":"00000000-0000-4000-8000-000000000001"}'
"#,
        Cli::Codex => r#"
echo '{"type":"thread.started","thread_id":"00000000-0000-7000-8000-000000000001"}'
echo "{\"type\":\"item.started\",\"item\":{\"id\":\"r1\",\"type\":\"command_execution\",\"command\":\"cat $PWD/notes.md\",\"status\":\"in_progress\"}}"
echo '{"type":"item.completed","item":{"id":"r1","type":"command_execution","exit_code":0,"status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"reply","type":"agent_message","text":"Fixture completed"}}'
echo '{"type":"turn.completed"}'
"#,
        Cli::Gemini => r#"
echo '{"type":"init","session_id":"00000000-0000-4000-8000-000000000001"}'
echo "{\"type\":\"tool_use\",\"tool_id\":\"r1\",\"tool_name\":\"read_file\",\"parameters\":{\"file_path\":\"$PWD/notes.md\"}}"
echo '{"type":"tool_result","tool_id":"r1","status":"success","output":"fixture read"}'
echo '{"type":"message","role":"assistant","content":"Fixture completed","delta":true}'
echo '{"type":"result","status":"success"}'
"#,
    };
    fs::write(&bin, format!("#!/bin/sh\nd='{}'\nprintf '%s\\n' \"$@\" > \"$d/args\"\ncat > \"$d/stdin\"\npwd -P > \"$d/cwd\"\ncat notes.md > \"$d/read\"\n{response}", root.display())).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

fn send(root: &Path, space: &Path, cli: Cli, working_dir: Option<PathBuf>, full_access: bool) -> Vec<AgentEvent> {
    let mut events = vec![];
    tauri::async_runtime::block_on(agent::run_cli_turn(&Runs::default(), "school", cli, TurnRequest {
        space_dir: space, working_dir, prompt: "Read notes.md", attachments: vec![phaethon_lib::attachments::reference("attachments/day/handout.txt", "text/plain", "handout.txt")],
        replace_from: None, config_dir: Some(root.join("cli-home")), add_dirs: vec![], model: None, full_access,
    }, |event| events.push(event)));
    events
}

fn args(root: &Path) -> Vec<String> { fs::read_to_string(root.join("args")).unwrap().lines().map(str::to_string).collect() }
fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> { args.windows(2).find(|pair| pair[0] == flag).map(|pair| pair[1].as_str()) }

#[test]
fn persisted_workspace_drives_cli_execution_without_moving_metadata() {
    // One test owns all debug overrides in this process; every file is a fixture.
    for cli in Cli::ALL {
        let root = std::env::temp_dir().join(format!("phaethon-workspace-cli-{}-{}", cli.id(), std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let vault = Vault::at(root.join("Managed vault"));
        vault.ensure_initialized().unwrap();
        let space = vault.space_dir("school").unwrap();
        let project = root.join("Real project with spaces");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("notes.md"), "project notes").unwrap();
        fs::write(space.join("notes.md"), "managed notes").unwrap();
        let modified = fs::metadata(project.join("notes.md")).unwrap().modified().unwrap();
        let bindings = root.join("app-data/workspaces.json");
        workspace::bind(Some(&bindings), vault.root(), "school", &project).unwrap();
        let resolved = workspace::resolve(Some(&bindings), vault.root(), "school", &space).unwrap();
        assert_eq!(workspace::resolve(Some(&bindings), vault.root(), "school", &space).unwrap(), resolved, "reloaded binding resolves the same project");
        let bin = fake(&root, cli);
        unsafe { std::env::set_var(format!("PHAETHON_{}_BIN", cli.id().to_uppercase()), &bin); }
        let events = send(&root, &space, cli, Some(resolved), false);
        assert!(!events.iter().any(|event| matches!(event, AgentEvent::Error { .. })), "{cli:?}: {events:?}");
        assert_eq!(fs::read_to_string(root.join("cwd")).unwrap().trim(), project.to_str().unwrap());
        assert_eq!(fs::read_to_string(root.join("read")).unwrap(), "project notes");
        let arguments = args(&root);
        match cli {
            Cli::Claude => assert_eq!(after(&arguments, "--add-dir"), space.to_str()),
            Cli::Codex => {
                assert_eq!(after(&arguments, "--cd"), project.to_str());
                let profile = arguments.iter().find(|arg| arg.starts_with("permissions.") && arg.contains("filesystem=")).unwrap();
                for allowed in [&project, &space] { assert!(profile.contains(&format!("{}=\"read\"", serde_json::to_string(&allowed.to_string_lossy()).unwrap())), "{profile}"); }
                assert!(!profile.contains("=\"write\""));
                assert!(!arguments.iter().any(|arg| arg == "--add-dir" || arg == "--dangerously-bypass-approvals-and-sandbox"));
            }
            Cli::Gemini => assert_eq!(after(&arguments, "--include-directories"), space.to_str()),
        }
        let prompt = format!("{}\n{}", arguments.join("\n"), fs::read_to_string(root.join("stdin")).unwrap());
        assert!(prompt.contains("Project working folder:") && prompt.contains(project.to_str().unwrap()));
        assert!(prompt.contains("Phaethon space context:") && prompt.contains(space.to_str().unwrap()));
        assert!(prompt.contains(space.join("attachments/day/handout.txt").to_str().unwrap()), "attachments remain absolute managed references");
        let saved = thread::load(&space).unwrap();
        assert_eq!(thread::to_ui(&saved).len(), 2);
        assert!(thread::records(&saved).any(|record| matches!(record, Record::Tool { status: ToolStatus::Success, .. })));
        if cli != Cli::Codex { assert!(thread::records(&saved).any(|record| matches!(record, Record::Tool { target: Some(target), .. } if target == "notes.md")), "labels use the actual project root"); }
        assert!(!project.join(".phaethon").exists());
        assert!(!project.join("attachments").exists());
        assert_eq!(fs::metadata(project.join("notes.md")).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read_to_string(project.join("notes.md")).unwrap(), "project notes");

        // Full access retains its existing flags while using the selected cwd.
        assert!(!send(&root, &space, cli, Some(project.clone()), true).iter().any(|event| matches!(event, AgentEvent::Error { .. })));
        assert_eq!(fs::read_to_string(root.join("cwd")).unwrap().trim(), project.to_str().unwrap());
        if cli == Cli::Codex { assert!(args(&root).iter().any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox")); }

        // Clearing a binding restores ordinary managed execution and history.
        workspace::clear(Some(&bindings), vault.root(), "school", &space).unwrap();
        vault::clear_session(&space); // The real binding IPC also clears session.
        assert_eq!(workspace::resolve(Some(&bindings), vault.root(), "school", &space).unwrap(), space.canonicalize().unwrap());
        assert!(!send(&root, &space, cli, None, false).iter().any(|event| matches!(event, AgentEvent::Error { .. })));
        assert_eq!(fs::read_to_string(root.join("cwd")).unwrap().trim(), space.to_str().unwrap());
        assert_eq!(fs::read_to_string(root.join("read")).unwrap(), "managed notes");
        assert_eq!(thread::to_ui(&thread::load(&space).unwrap()).len(), 6);

        // A disappeared/replaced bound root is refused, never silently switched.
        workspace::bind(Some(&bindings), vault.root(), "school", &project).unwrap();
        fs::rename(&project, root.join("original-project")).unwrap();
        assert!(workspace::resolve(Some(&bindings), vault.root(), "school", &space).is_err());
        fs::remove_file(root.join("cwd")).unwrap();
        let events = send(&root, &space, cli, Some(project.clone()), false);
        assert!(matches!(events.as_slice(), [AgentEvent::Error { code: ErrorCode::Cli, message, .. }, AgentEvent::End { .. }] if message.contains("workspace folder")));
        assert!(!root.join("cwd").exists(), "no CLI was launched for a missing workspace");
        fs::create_dir(&project).unwrap();
        assert!(workspace::resolve(Some(&bindings), vault.root(), "school", &space).is_err(), "a different directory at the same path needs another native choice");
        assert_eq!(thread::to_ui(&thread::load(&space).unwrap()).len(), 6);
        fs::remove_dir_all(&root).unwrap();
    }
}
