pub mod agent;
pub mod agent_loop;
pub mod anthropic;
pub mod attachments;
pub mod grants;
pub mod open;
pub mod provider;
pub mod secrets;
pub mod spaces;
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
///
/// `replace_from` (edit / regenerate, Phaethon's own agent only) is the
/// `index` of a user message from `thread_load`: that message and everything
/// after it are replaced by this one, after the whole conversation as it was
/// is copied into the space's archive.
#[tauri::command]
async fn agent_send(
    state: State<'_, AppState>,
    space: String,
    prompt: String,
    attachments: Vec<attachments::Upload>,
    on_event: Channel<AgentEvent>,
    replace_from: Option<usize>,
) -> Result<(), ()> {
    let emit = |ev: AgentEvent| {
        // The webview may have reloaded or closed; the turn still finishes cleanly.
        let _ = on_event.send(ev);
    };
    let fail = |code, message: String| {
        emit(AgentEvent::error(code, message));
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
    if replace_from.is_some() && settings.backend != Backend::Phaethon {
        fail(ErrorCode::Cli, "Editing or regenerating a message works only with Phaethon’s own agent.".into());
        return Ok(());
    }
    // Saved before the agent runs, so they are in the space whatever the backend.
    let refs = match attachments::save(&space_dir, &attachments) {
        Ok(r) => r,
        Err(message) => {
            fail(ErrorCode::Attachment, message);
            return Ok(());
        }
    };
    match settings.backend {
        Backend::Phaethon => {
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
                attachments: refs,
                replace_from,
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
            let prompt = format!("{prompt}{}", attachments::cli_note(&refs));
            let req = TurnRequest {
                space_dir: &space_dir,
                prompt: &prompt,
                config_dir,
                add_dirs: grants::cli_dirs(&state.vault, &space),
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

/// The user's answer ("once", "always" or "deny") to a pending request from
/// the agent in `space` to read part of another space. False if that request
/// is no longer waiting.
#[tauri::command]
fn agent_access_answer(state: State<'_, AppState>, space: String, id: String, answer: grants::AccessAnswer) -> bool {
    state.approvals.answer_access(&space, &id, answer)
}

/// What `space` may read in other spaces (saved "always" grants), plus any
/// problems found in `<vault>/.phaethon/grants.json`. Read from the file on
/// every call, so edits and revocations apply without a restart.
#[tauri::command]
fn grants_list(state: State<'_, AppState>, space: String) -> Result<grants::GrantsView, String> {
    state.vault.space_dir(&space)?;
    Ok(grants::view(&state.vault, &space))
}

/// Put back a grant that was just revoked (Undo), with its original id and date.
#[tauri::command]
fn grant_restore(
    state: State<'_, AppState>,
    id: String,
    to: String,
    from: String,
    path: String,
    created: String,
) -> Result<(), String> {
    grants::restore(&state.vault, &id, &to, &from, &path, &created).map(|_| ())
}

/// Remove a saved grant. False if no grant has that id.
#[tauri::command]
fn grant_revoke(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    grants::revoke(&state.vault, &id)
}

/// The saved conversation in `space`, for showing after a restart or a space
/// switch. Empty for the CLI backend, which keeps its own history.
#[tauri::command]
fn thread_load(state: State<'_, AppState>, space: String) -> Result<Vec<thread::UiMessage>, String> {
    if state.vault.settings().backend != Backend::Phaethon {
        return Ok(vec![]);
    }
    let dir = state.vault.space_dir(&space)?;
    thread::load(&dir)
        .map(|m| thread::to_ui(&m))
        .map_err(|e| format!("This space’s conversation couldn’t be read: {e}"))
}

/// Every space in the vault (valid folders under `spaces/`), sorted by name,
/// with the name, description and colour from each one's space.json.
#[tauri::command]
fn spaces_list(state: State<'_, AppState>) -> Result<Vec<spaces::SpaceView>, String> {
    spaces::list(&state.vault)
}

/// Create a space. Its folder name is derived from `name`; the result says which.
#[tauri::command]
fn space_create(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    hue: Option<f64>,
) -> Result<spaces::SpaceView, String> {
    spaces::create(&state.vault, &name, description.as_deref(), hue)
}

/// Rename, describe or recolour a space. Its folder (the id) never changes.
#[tauri::command]
fn space_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    hue: Option<f64>,
) -> Result<spaces::SpaceView, String> {
    spaces::update(&state.vault, &id, name.as_deref(), description.as_deref(), hue)
}

/// Start a new conversation in `space`: the current one (if it has messages)
/// is kept in the space's archive, and the CLI's session is cleared so the CLI
/// starts fresh too. Refused while a reply is running there.
#[tauri::command]
fn thread_new(state: State<'_, AppState>, space: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        thread::start_new(&dir).map_err(|e| format!("A new conversation couldn’t be started: {e}"))?;
        vault::clear_session(&dir);
        Ok(())
    })
}

/// The conversations in `space`, the current one first. Empty for the CLI
/// backend, whose history the CLI keeps and Phaethon can't reopen.
#[tauri::command]
fn threads_list(state: State<'_, AppState>, space: String) -> Result<Vec<thread::ThreadSummary>, String> {
    let dir = state.vault.space_dir(&space)?;
    if state.vault.settings().backend != Backend::Phaethon {
        return Ok(vec![]);
    }
    thread::list(&dir).map_err(|e| format!("This space’s conversations couldn’t be listed: {e}"))
}

/// Make the saved conversation `id` the current one in `space` (Phaethon's own
/// agent only). Refused while a reply is running there.
#[tauri::command]
fn thread_open(state: State<'_, AppState>, space: String, id: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    if state.vault.settings().backend != Backend::Phaethon {
        return Err("Past conversations can be reopened only with Phaethon’s own agent.".into());
    }
    thread::while_idle(&state.runs, &space, || {
        thread::open(&dir, &id).map_err(|e| format!("That conversation couldn’t be opened: {e}"))
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    backend: Backend,
    /// Whether a key is stored. The key itself never leaves the Rust core.
    has_anthropic_key: bool,
    model: String,
    /// The saved appearance, or `{}` when none is saved or the file holds one
    /// that does not pass [`vault::validate_appearance`].
    appearance: serde_json::Value,
    /// Where this vault's folder is, shown in Settings so the user can find it.
    vault_path: String,
    /// Phaethon's version.
    version: &'static str,
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let s = state.vault.settings();
    Ok(SettingsView {
        backend: s.backend,
        has_anthropic_key: secrets::get(&state.vault.name(), "anthropic")?.is_some(),
        model: s.model.unwrap_or_else(|| anthropic::DEFAULT_MODEL.into()),
        appearance: s
            .appearance
            .filter(|a| vault::validate_appearance(a).is_ok())
            .unwrap_or_else(|| serde_json::json!({})),
        vault_path: state.vault.root().display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Save the user's appearance and accessibility choices to the vault, after
/// checking their shape. Replaces the whole appearance object; every other
/// setting in the file is kept.
#[tauri::command]
fn appearance_set(state: State<'_, AppState>, appearance: serde_json::Value) -> Result<(), String> {
    vault::validate_appearance(&appearance)?;
    state
        .vault
        .set_setting("appearance", appearance)
        .map_err(|e| format!("Could not save your appearance settings: {e}"))
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

/// Check an Anthropic key without saving it: its format, then one cheap
/// request with it. The key is never logged or returned.
#[tauri::command]
async fn api_key_check(key: String) -> anthropic::KeyCheck {
    anthropic::check_key(&key).await
}

/// The models the saved key can use, from Anthropic; a fixed list when there
/// is no key or the list can't be fetched.
#[tauri::command]
async fn models_list(state: State<'_, AppState>) -> Result<Vec<anthropic::ModelInfo>, String> {
    let key = secrets::get(&state.vault.name(), "anthropic").ok().flatten();
    Ok(anthropic::models_or_fallback(key.as_deref()).await)
}

/// Choose the model for Phaethon's own agent; `None` goes back to the default.
#[tauri::command]
fn settings_set_model(state: State<'_, AppState>, model: Option<String>) -> Result<(), String> {
    let value = match model.as_deref().map(str::trim) {
        None => serde_json::Value::Null,
        Some(m) if anthropic::is_valid_model_id(m) => m.into(),
        Some(_) => return Err("That isn’t a model Phaethon knows how to use.".into()),
    };
    state
        .vault
        .set_setting("model", value)
        .map_err(|e| format!("Could not save the setting: {e}"))
}

/// Open a file in `space` with its default app, or show it in Finder when
/// `reveal`. Only files inside the space itself; see open.rs.
#[tauri::command]
fn file_open(state: State<'_, AppState>, space: String, path: String, reveal: Option<bool>) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    open::open(&dir, &path, reveal.unwrap_or(false))
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
            agent_access_answer,
            grants_list,
            grant_revoke,
            grant_restore,
            thread_load,
            thread_new,
            threads_list,
            thread_open,
            settings_get,
            settings_set_backend,
            api_key_set,
            api_key_clear,
            api_key_check,
            models_list,
            settings_set_model,
            file_open,
            appearance_set,
            spaces_list,
            space_create,
            space_update
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
