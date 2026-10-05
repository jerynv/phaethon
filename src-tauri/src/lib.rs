pub mod agent;
pub mod agent_loop;
pub mod anthropic;
pub mod provider;
pub mod secrets;
pub mod thread;
pub mod tools;
pub mod vault;

use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

use agent::{AgentEvent, ErrorCode, Runs, TurnRequest};
use agent_loop::{Approvals, LoopRequest};
use vault::{Backend, Vault};

/// Debug builds only: lets the webview report CSP violations and startup to the
/// terminal running `tauri dev`, since the WebView console is otherwise invisible
/// there. A no-op in release builds.
#[tauri::command]
fn dev_log(message: String) {
    if cfg!(debug_assertions) {
        // Bound the size so a runaway frontend cannot flood the terminal.
        let message: String = message.chars().take(2000).collect();
        eprintln!("[webview] {message}");
    }
}

struct AppState {
    vault: Vault,
    runs: Runs,
    approvals: Approvals,
    /// Where per-vault CLI config dirs live when a vault opts in. Outside the
    /// vault on purpose: the CLI may keep credentials there, and vaults sync.
    isolated_config_root: Option<std::path::PathBuf>,
}

/// Send one message to the agent in `space` and stream the reply over `on_event`.
/// All outcomes, including errors, arrive as events ending with `End`.
#[tauri::command]
async fn agent_send(
    state: State<'_, AppState>,
    space: String,
    prompt: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), ()> {
    let emit = |ev: AgentEvent| {
        // The webview may have reloaded or closed; the turn still finishes cleanly.
        let _ = on_event.send(ev);
    };
    let fail = |code, message: String| {
        emit(AgentEvent::Error { code, message });
        emit(AgentEvent::End { session_id: None });
    };
    let space_dir = match state.vault.space_dir(&space) {
        Ok(dir) => dir,
        Err(message) => {
            fail(ErrorCode::InvalidSpace, message);
            return Ok(());
        }
    };
    let settings = state.vault.settings();
    match settings.backend {
        Backend::Steward => {
            let key = match secrets::get(&state.vault.name(), "anthropic") {
                Ok(Some(k)) => k,
                Ok(None) => {
                    fail(ErrorCode::NoApiKey, "Add your Anthropic API key in Settings to start.".into());
                    return Ok(());
                }
                Err(e) => {
                    fail(ErrorCode::NoApiKey, e);
                    return Ok(());
                }
            };
            let provider = anthropic::Anthropic::new(key, settings.model, settings.effort);
            let req = LoopRequest {
                space_id: &space,
                space_dir: &space_dir,
                vault_root: state.vault.root(),
                prompt: &prompt,
            };
            agent_loop::run_turn(&state.runs, &state.approvals, &provider, req, emit).await;
        }
        Backend::ClaudeCli => {
            let config_dir = settings
                .isolate_claude_config
                .then(|| {
                    state
                        .isolated_config_root
                        .as_ref()
                        .map(|r| r.join(state.vault.name()))
                })
                .flatten();
            let req = TurnRequest {
                space_dir: &space_dir,
                prompt: &prompt,
                config_dir,
            };
            agent::run_turn(&state.runs, &space, req, emit).await;
        }
    }
    Ok(())
}

/// The user's answer to a pending write in `space`. False if that request is
/// no longer waiting.
#[tauri::command]
fn agent_approve(state: State<'_, AppState>, space: String, id: String, allow: bool) -> bool {
    state.approvals.answer(&space, &id, allow)
}

/// The saved conversation in `space`, for showing after a restart or a space
/// switch. Empty for the CLI backend, which keeps its own history.
#[tauri::command]
fn thread_load(state: State<'_, AppState>, space: String) -> Result<Vec<thread::UiMessage>, String> {
    if state.vault.settings().backend != Backend::Steward {
        return Ok(vec![]);
    }
    let dir = state.vault.space_dir(&space)?;
    thread::load(&dir)
        .map(|m| thread::to_ui(&m))
        .map_err(|e| format!("This space's conversation could not be read: {e}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    backend: Backend,
    /// Whether a key is stored. The key itself never leaves the Rust core.
    has_anthropic_key: bool,
    model: String,
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let s = state.vault.settings();
    Ok(SettingsView {
        backend: s.backend,
        has_anthropic_key: secrets::get(&state.vault.name(), "anthropic")?.is_some(),
        model: s.model.unwrap_or_else(|| anthropic::DEFAULT_MODEL.into()),
    })
}

#[tauri::command]
fn settings_set_backend(state: State<'_, AppState>, backend: Backend) -> Result<(), String> {
    state
        .vault
        .set_setting("backend", serde_json::to_value(backend).expect("serializes"))
        .map_err(|e| format!("Could not save the setting: {e}"))
}

/// Store a provider key in the keychain. Write-only: no command reads it back.
#[tauri::command]
fn api_key_set(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    secrets::set(&state.vault.name(), &provider, &key)
}

#[tauri::command]
fn api_key_clear(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    secrets::clear(&state.vault.name(), &provider)
}

/// Stop the turn running in `space`, if any. The stream then ends with `Cancelled`.
#[tauri::command]
fn agent_cancel(state: State<'_, AppState>, space: String) -> bool {
    state.runs.cancel(&space)
}

/// Ctrl+C in a terminal, `kill`, or logout: the CLI children run in their own
/// process groups, so they would outlive us. Kill them, then exit normally.
#[cfg(unix)]
fn kill_children_on_signal(handle: tauri::AppHandle, runs: Runs) {
    use tokio::signal::unix::{SignalKind, signal};
    tauri::async_runtime::spawn(async move {
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hup.recv() => {}
        }
        runs.kill_all();
        handle.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let vault = Vault::default_location()?;
            vault.ensure_initialized()?;
            let isolated_config_root = app
                .path()
                .app_data_dir()
                .ok()
                .map(|d| d.join("claude-config"));
            let runs = Runs::default();
            #[cfg(unix)]
            kill_children_on_signal(app.handle().clone(), runs.clone());
            app.manage(AppState {
                vault,
                runs,
                approvals: Approvals::default(),
                isolated_config_root,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dev_log,
            agent_send,
            agent_cancel,
            agent_approve,
            thread_load,
            settings_get,
            settings_set_backend,
            api_key_set,
            api_key_clear
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Closing the window or quitting must never leave a `claude` child running.
        if let (RunEvent::Exit, Some(state)) = (&event, handle.try_state::<AppState>()) {
            state.runs.kill_all();
        }
    });
}
