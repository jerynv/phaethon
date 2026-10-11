pub mod agent;
pub mod agent_loop;
pub mod anthropic;
pub mod attachments;
pub mod continuation;
pub mod export;
pub mod grants;
pub mod lms;
pub mod memory;
pub mod open;
pub mod provider;
pub mod search;
pub mod secrets;
pub mod space_model;
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
    /// The last file Export wrote, for its Show in Finder. Kept here so the
    /// webview never names a path outside a space.
    last_export: std::sync::Mutex<Option<std::path::PathBuf>>,
}

/// Send one message to the agent in `space` and stream the reply over `on_event`.
/// All outcomes, including errors, arrive as events ending with `End`.
///
/// `replace_from` (edit / regenerate, Phaethon's own agent only) is the
/// `index` of a user message from `thread_load`: that message and everything
/// after it are replaced by this one, after the whole conversation as it was
/// is copied into the space's archive. `keep_attachments` lists the saved
/// paths of that message's files to carry over to the new one (only its own
/// files can be named); new `attachments` are added after them.
///
/// `continue_from` (Phaethon's own agent only) is the `index` of the last
/// reply, which the user stopped: the model carries on from where it stopped
/// instead of answering `prompt` (see continuation.rs).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // each one is a named IPC argument
async fn agent_send(
    state: State<'_, AppState>,
    space: String,
    prompt: String,
    attachments: Vec<attachments::Upload>,
    on_event: Channel<AgentEvent>,
    replace_from: Option<usize>,
    keep_attachments: Option<Vec<String>>,
    continue_from: Option<usize>,
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
    // Sending counts as using the space (the sidebar lists the most recent first); so does the reply ending.
    let _ = spaces::touch(&state.vault, &space);
    let settings = state.vault.settings();
    if replace_from.is_some() && settings.backend != Backend::Phaethon {
        fail(ErrorCode::Cli, "Editing or regenerating a message works only with Phaethon’s own agent.".into());
        return Ok(());
    }
    if continue_from.is_some() && settings.backend != Backend::Phaethon {
        fail(ErrorCode::Cli, "Continuing a stopped reply works only with Phaethon’s own agent.".into());
        return Ok(());
    }
    // Saved before the agent runs, so they are in the space whatever the backend.
    let new_refs = match attachments::save(&space_dir, &attachments) {
        Ok(r) => r,
        Err(message) => {
            fail(ErrorCode::Attachment, message);
            return Ok(());
        }
    };
    // An edit or regenerate keeps the replaced message's files the webview still shows.
    let mut refs = match (replace_from, &keep_attachments) {
        (Some(index), Some(keep)) if !keep.is_empty() => {
            thread::load(&space_dir).map(|msgs| thread::kept_attachments(&msgs, index, keep)).unwrap_or_default()
        }
        _ => vec![],
    };
    refs.extend(new_refs);
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
            // The space's own model if it has one, else the default; read once per
            // turn, so a change applies from the next message, never mid-reply.
            let model = space_model::resolve(&space_dir, settings.model);
            let provider = continuation::Wire(anthropic::Anthropic::new(key, model, settings.effort));
            if let Some(from) = continue_from {
                let req = continuation::ContinueRequest {
                    space_id: &space,
                    space_dir: &space_dir,
                    vault_root: state.vault.root(),
                    from,
                };
                continuation::run_turn(&state.runs, &state.approvals, &provider, req, emit).await;
                return Ok(());
            }
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
    let _ = spaces::touch(&state.vault, &space);
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

/// Put back a grant revoked in the last few minutes (Undo), exactly as it was.
/// Only an id: what comes back is what Rust removed, never what the webview says.
#[tauri::command]
fn grant_restore(state: State<'_, AppState>, id: String) -> Result<(), String> {
    grants::restore(&state.vault, &id).map(|_| ())
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

/// Search the text of the saved conversations in `space`, or in every space
/// with `all_spaces`: the user's own view, never sent to the model. Phaethon's
/// own agent only (Claude Code keeps its own history).
#[tauri::command]
async fn conversations_search(
    state: State<'_, AppState>,
    space: String,
    query: String,
    all_spaces: bool,
) -> Result<search::Results, String> {
    if state.vault.settings().backend != Backend::Phaethon {
        return Err(search::CLI.into());
    }
    let targets = if all_spaces {
        spaces::list(&state.vault)?
            .into_iter()
            .filter_map(|s| state.vault.space_dir(&s.id).ok().map(|d| (s.id, d)))
            .collect()
    } else {
        vec![(space.clone(), state.vault.space_dir(&space)?)]
    };
    tauri::async_runtime::spawn_blocking(move || search::search(&targets, &query))
        .await
        .map_err(|e| format!("The search stopped unexpectedly: {e}"))
}

/// Every space in the vault (valid folders under `spaces/`), the most recently
/// used first, with the name, description and colour from each one's space.json.
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

/// Mark `space` as used now (it was opened). The time is the core's own.
#[tauri::command]
fn space_touch(state: State<'_, AppState>, id: String) -> Result<(), String> {
    spaces::touch(&state.vault, &id)
}

/// Open a space's folder in the file manager. Only an id: the folder comes
/// from the vault, and anything that isn't a space is refused.
#[tauri::command]
fn space_show(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&id).map_err(|_| "That space isn’t in your Phaethon folder any more.".to_string())?;
    open::show_space(&dir)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDone {
    /// The file's name only; the full path stays in the core.
    file_name: String,
    files: usize,
}

/// Export a whole space as one .zip. The core asks where to save it in a
/// native save dialog (so the webview never names a path); `None` when the
/// person cancels it.
#[tauri::command]
async fn space_export(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<Option<ExportDone>, String> {
    use tauri_plugin_dialog::DialogExt;
    let space = spaces::get(&state.vault, &id)?;
    let dir = state.vault.space_dir(&id)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title(format!("Export {}", space.name))
        .set_file_name(export::suggested_name(&space.name, &id))
        .add_filter("Zip archive", &["zip"]);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let dest = picked
        .into_path()
        .map_err(|_| "Phaethon can’t save there. Choose a folder on this computer.".to_string())?;
    let done = tauri::async_runtime::spawn_blocking(move || export::export(&dir, &id, &dest))
        .await
        .map_err(|e| format!("The export stopped unexpectedly: {e}"))??;
    let file_name = done.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    *state.last_export.lock().unwrap_or_else(|p| p.into_inner()) = Some(done.file);
    Ok(Some(ExportDone { file_name, files: done.files }))
}

/// Show the last exported file in the file manager.
#[tauri::command]
fn export_show(state: State<'_, AppState>) -> Result<(), String> {
    let file = state.last_export.lock().unwrap_or_else(|p| p.into_inner()).clone();
    open::reveal_file(&file.ok_or("There’s no export to show yet.")?)
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

/// Delete the conversation `id` in `space` for good: a saved past one by its
/// archive id, or `"current"` to empty the current one (its file and the CLI's
/// session). Refused while a reply is running there; an id that isn't one is
/// refused, never turned into a path.
#[tauri::command]
fn thread_delete(state: State<'_, AppState>, space: String, id: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        thread::delete(&dir, &id).map_err(|e| format!("That conversation couldn’t be deleted: {e}"))?;
        if id == thread::CURRENT_ID {
            vault::clear_session(&dir);
        }
        Ok(())
    })
}

/// Clear the conversation `id` in `space` (Phaethon's own agent): the model
/// picks out its key details in one call, they are added to the space's
/// MEMORY.md, then the conversation is removed (for `"current"`, the CLI
/// session too). `notKept` (no key, Claude Code, offline, ...) changes nothing.
/// Refused while a reply is running there.
#[tauri::command]
async fn thread_clear(state: State<'_, AppState>, space: String, id: String) -> Result<memory::ClearOutcome, String> {
    let dir = state.vault.space_dir(&space)?;
    let settings = state.vault.settings();
    let provider = if settings.backend != Backend::Phaethon {
        Err("Claude Code is answering in this vault, and Phaethon can’t ask it to pick out details.".to_string())
    } else {
        match secrets::get(&state.vault.name(), "anthropic") {
            Ok(Some(key)) => Ok(anthropic::Anthropic::new(key, settings.model, settings.effort)),
            Ok(None) => Err("There’s no Anthropic key in Settings, so Phaethon can’t pick out details to keep.".to_string()),
            Err(e) => Err(e),
        }
    };
    if state.runs.claim(&space).is_none() {
        return Err(thread::BUSY.into());
    }
    let out = memory::clear(&dir, &id, provider.as_ref().map_err(Clone::clone)).await;
    state.runs.release(&space);
    if matches!(out, Ok(memory::ClearOutcome::Cleared { .. })) && id == thread::CURRENT_ID {
        vault::clear_session(&dir);
    }
    out
}

/// What deleting `id` with everything would remove: files only it uses, files
/// another conversation also uses (they stay), and details kept from it.
#[tauri::command]
fn thread_forget_preview(state: State<'_, AppState>, space: String, id: String) -> Result<memory::ForgetPreview, String> {
    let dir = state.vault.space_dir(&space)?;
    memory::forget_preview(&dir, &id).map_err(|e| format!("That conversation couldn’t be read: {e}"))
}

/// Delete the conversation `id` in `space` with everything it brought: its
/// messages, files attached only there, and the details kept from it. Refused
/// while a reply is running there.
#[tauri::command]
fn thread_forget(state: State<'_, AppState>, space: String, id: String) -> Result<memory::Forgotten, String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        let done = memory::forget(&dir, &id)?;
        if id == thread::CURRENT_ID {
            vault::clear_session(&dir);
        }
        Ok(done)
    })
}

/// Whether Claude Code is installed (and where), so the UI can say how to
/// install it before switching to it. Never looks at the user's login.
#[tauri::command]
fn claude_cli_status() -> agent::CliStatus {
    agent::cli_status()
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

/// The model `space` has chosen for itself, or `None` when it uses the default.
#[tauri::command]
fn space_model_get(state: State<'_, AppState>, space: String) -> Result<Option<String>, String> {
    Ok(space_model::get(&state.vault.space_dir(&space)?))
}

/// Choose the model Phaethon's own agent answers with in `space`; `None` goes
/// back to the default. Applies from the next message in that space.
#[tauri::command]
fn space_model_set(state: State<'_, AppState>, space: String, model: Option<String>) -> Result<(), String> {
    space_model::set(&state.vault, &space, model.as_deref())
}

/// Every space that has its own model, by space id.
#[tauri::command]
fn space_models_list(state: State<'_, AppState>) -> Result<std::collections::BTreeMap<String, String>, String> {
    space_model::list(&state.vault)
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
        // Used from Rust only (Export's save dialog); no capability lets the webview call it.
        .plugin(tauri_plugin_dialog::init())
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
                last_export: Default::default(),
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
            thread_delete,
            thread_clear,
            thread_forget,
            thread_forget_preview,
            claude_cli_status,
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
            space_update,
            space_model_get,
            space_model_set,
            space_models_list,
            space_touch,
            space_show,
            space_export,
            export_show,
            conversations_search
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
