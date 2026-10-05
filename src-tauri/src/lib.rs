pub mod agent;
pub mod vault;

use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

use agent::{AgentEvent, ErrorCode, Runs, TurnRequest};
use vault::Vault;

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
    let space_dir = match state.vault.space_dir(&space) {
        Ok(dir) => dir,
        Err(message) => {
            emit(AgentEvent::Error {
                code: ErrorCode::InvalidSpace,
                message,
            });
            emit(AgentEvent::End { session_id: None });
            return Ok(());
        }
    };
    let config_dir = state
        .vault
        .settings()
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
    Ok(())
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
                isolated_config_root,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dev_log, agent_send, agent_cancel])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Closing the window or quitting must never leave a `claude` child running.
        if let (RunEvent::Exit, Some(state)) = (&event, handle.try_state::<AppState>()) {
            state.runs.kill_all();
        }
    });
}
