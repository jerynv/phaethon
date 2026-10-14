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
pub mod openai;
pub mod plan;
pub mod provider;
pub mod providers;
pub mod search;
pub mod secrets;
pub mod space_model;
pub mod spaces;
pub mod study;
pub mod thread;
pub mod tools;
pub mod tutor_mode;
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

/// What tauri's freezePrototype does, for the app's own window only (see `run`).
const FREEZE_PROTOTYPE: &str = "Object.freeze(Object.prototype);";

/// Run `f` on a blocking worker. Every keychain call goes through here (or an async
/// command's own worker): macOS may stop to ask the person for keychain access, and a
/// synchronous command runs on the main thread, so the whole window would freeze
/// until they answered a dialog they might not even see.
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("That stopped unexpectedly: {e}"))?
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
/// `replace_from` (edit / regenerate) is the `index` of a user message from
/// `thread_load`: that message and everything after it are replaced by this
/// one, after the whole conversation as it was is copied into the space's
/// archive. With Claude Code the new version starts a fresh session, given
/// the conversation before that message as text. `keep_attachments` lists the saved
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
            // The space's own model (and its provider) if it has one, else the default; read
            // once per turn, so a change applies from the next message, never mid-reply.
            let provider = match providers::for_space(&state.vault, &space_dir) {
                Ok(p) => continuation::Wire(p),
                Err(e) => {
                    fail(ErrorCode::NoApiKey, e);
                    return Ok(());
                }
            };
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
        Backend::ClaudeCli | Backend::CodexCli | Backend::GeminiCli => {
            let cli = agent::Cli::of(settings.backend).expect("a CLI backend");
            let req = TurnRequest {
                space_dir: &space_dir,
                prompt: &prompt,
                attachments: refs,
                replace_from,
                config_dir: study::model::cli_config_dir(&state.vault, state.isolated_config_root.as_deref(), cli),
                // Granted folders of other spaces, and the courses this space sees in full.
                add_dirs: grants::cli_dirs(&state.vault, &space).into_iter().chain(lms::access::visible(&state.vault, &space).cli_dirs()).collect(),
                model: space_model::get_cli(&space_dir, cli.id()),
            };
            agent::run_cli_turn(&state.runs, &space, cli, req, emit).await;
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
/// switch. Both backends record theirs.
#[tauri::command]
fn thread_load(state: State<'_, AppState>, space: String) -> Result<Vec<thread::UiMessage>, String> {
    let dir = state.vault.space_dir(&space)?;
    thread::load(&dir)
        .map(|m| thread::to_ui(&m))
        .map_err(|e| format!("This space’s conversation couldn’t be read: {e}"))
}

/// Search the text of the saved conversations in `space`, or in every space
/// with `all_spaces`: the user's own view, never sent to the model.
#[tauri::command]
async fn conversations_search(
    state: State<'_, AppState>,
    space: String,
    query: String,
    all_spaces: bool,
) -> Result<search::Results, String> {
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
/// is kept in the space's archive with its CLI session, and Claude Code starts
/// a fresh session. Refused while a reply is running there.
#[tauri::command]
fn thread_new(state: State<'_, AppState>, space: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        thread::start_new(&dir).map_err(|e| format!("A new conversation couldn’t be started: {e}"))
    })
}

/// The conversations in `space`, the current one first.
#[tauri::command]
fn threads_list(state: State<'_, AppState>, space: String) -> Result<Vec<thread::ThreadSummary>, String> {
    let dir = state.vault.space_dir(&space)?;
    thread::list(&dir).map_err(|e| format!("This space’s conversations couldn’t be listed: {e}"))
}

/// Make the saved conversation `id` the current one in `space`; Claude Code
/// then resumes that conversation's own session. Refused while a reply is
/// running there.
#[tauri::command]
fn thread_open(state: State<'_, AppState>, space: String, id: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        thread::open(&dir, &id).map_err(|e| format!("That conversation couldn’t be opened: {e}"))
    })
}

/// Delete the conversation `id` in `space` for good, with its CLI session: a
/// saved past one by its archive id, or `"current"` to empty the current one.
/// Refused while a reply is running there; an id that isn't one is refused,
/// never turned into a path.
#[tauri::command]
fn thread_delete(state: State<'_, AppState>, space: String, id: String) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    thread::while_idle(&state.runs, &space, || {
        thread::delete(&dir, &id).map_err(|e| format!("That conversation couldn’t be deleted: {e}"))
    })
}

/// Clear the conversation `id` in `space`: the vault's model (Phaethon's
/// provider or Claude Code, as Study asks it) picks out its key details in
/// one call, they are added to the space's MEMORY.md, then the conversation
/// and its CLI session are removed. `notKept` (no model, offline, ...)
/// changes nothing. Refused while a reply is running there.
#[tauri::command]
async fn thread_clear(state: State<'_, AppState>, space: String, id: String) -> Result<memory::ClearOutcome, String> {
    let dir = state.vault.space_dir(&space)?;
    let (vault, at, root) = (state.vault.clone(), dir.clone(), state.isolated_config_root.clone());
    // Off the main thread: with Phaethon's own agent this reads the key from the keychain.
    let model = off_main(move || Ok(study::model::for_space(&vault, &at, root.as_deref()))).await?;
    if state.runs.claim(&space).is_none() {
        return Err(thread::BUSY.into());
    }
    let out = memory::clear(&dir, &id, model.as_ref().map_err(Clone::clone)).await;
    state.runs.release(&space);
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
    thread::while_idle(&state.runs, &space, || memory::forget(&dir, &id))
}

/// Whether Claude Code is installed (and where), so the UI can say how to
/// install it before switching to it. Never looks at the user's login.
#[tauri::command]
fn claude_cli_status() -> agent::CliStatus {
    agent::cli_status()
}

/// Each agent CLI: installed or not, signed in when the CLI itself can say
/// (Codex's own `codex login status`; never by reading its files), how to
/// sign in, and whether Phaethon can answer through it.
#[tauri::command]
async fn agent_clis_status(state: State<'_, AppState>) -> Result<Vec<agent::CliInfo>, ()> {
    let (vault, root) = (state.vault.clone(), state.isolated_config_root.clone());
    Ok(agent::clis_info(|cli| study::model::cli_config_dir(&vault, root.as_deref(), cli)).await)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    backend: Backend,
    /// Whether a key is stored. The key itself never leaves the Rust core.
    has_anthropic_key: bool,
    /// The Anthropic model chosen in Settings.
    model: String,
    /// The provider chosen for Phaethon's own agent (providers.rs).
    provider: &'static str,
    /// The default model as a reference (`provider:model`, plain for Anthropic);
    /// absent while the chosen provider has no model picked.
    default_model: Option<String>,
    /// Whether the chosen provider can answer (a key where one is needed).
    provider_ready: bool,
    /// Every provider, with whether a key is saved, never the key.
    providers: Vec<providers::ProviderView>,
    /// The saved appearance, or `{}` when none is saved or the file holds one
    /// that does not pass [`vault::validate_appearance`].
    appearance: serde_json::Value,
    /// Where this vault's folder is, shown in Settings so the user can find it.
    vault_path: String,
    /// Phaethon's version.
    version: &'static str,
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let s = state.vault.settings();
    let vault_name = state.vault.name();
    // One worker for every provider's keychain entry (a missing one never asks the person anything).
    let keys = off_main(move || {
        let mut saved = std::collections::BTreeSet::new();
        for id in providers::keyed_ids() {
            if secrets::get(&vault_name, id)?.is_some() {
                saved.insert(id);
            }
        }
        Ok(saved)
    })
    .await?;
    let views = providers::views(&s, |id| keys.contains(id));
    let chosen = providers::chosen(&s);
    Ok(SettingsView {
        backend: s.backend,
        has_anthropic_key: keys.contains(providers::ANTHROPIC),
        model: providers::chosen_model(&s, providers::preset(providers::ANTHROPIC).expect("anthropic")).unwrap_or_default(),
        provider: chosen.id,
        default_model: providers::default_ref(&s).map(|r| r.saved()),
        provider_ready: views.iter().any(|v| v.id == chosen.id && v.ready) && providers::default_ref(&s).is_some(),
        providers: views,
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
/// A key that plainly belongs to another provider is refused; the key for a
/// server of one's own is saved with that server's origin and goes nowhere else.
#[tauri::command]
async fn api_key_set(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    let vault_name = state.vault.name();
    let p = providers::preset(&provider).filter(|p| p.key != providers::KeyNeed::None).ok_or("That provider doesn’t take a key.")?;
    let settings = state.vault.settings();
    let value = if p.id == providers::ANTHROPIC {
        key
    } else {
        let base = providers::base_url(&settings, p)?;
        if let Some(problem) = providers::key_problem(p, &base, &key) {
            return Err(problem);
        }
        if p.id == providers::CUSTOM { providers::bind_custom_key(&base, &key)? } else { key }
    };
    off_main(move || secrets::set(&vault_name, p.id, &value)).await
}

#[tauri::command]
async fn api_key_clear(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let vault_name = state.vault.name();
    off_main(move || secrets::clear(&vault_name, &provider)).await
}

/// Check a key without saving it: its format, then one cheap request with it,
/// to `provider` (Anthropic when absent) and nowhere else. The key is never
/// logged or returned.
#[tauri::command]
async fn api_key_check(state: State<'_, AppState>, key: String, provider: Option<String>) -> Result<anthropic::KeyCheck, String> {
    let p = providers::preset(provider.as_deref().unwrap_or(providers::ANTHROPIC)).ok_or("That isn’t a provider Phaethon knows.")?;
    if p.id == providers::ANTHROPIC {
        return Ok(anthropic::check_key(&key).await);
    }
    let base = providers::base_url(&state.vault.settings(), p)?;
    Ok(openai::check_key(p, &base, &key).await)
}

/// The models `provider` offers (Anthropic when absent: the saved key's list,
/// or a fixed one when there is no key or it can't be fetched). For the
/// others, `Err` says in words why there is no list.
#[tauri::command]
async fn models_list(state: State<'_, AppState>, provider: Option<String>) -> Result<Vec<anthropic::ModelInfo>, String> {
    let p = providers::preset(provider.as_deref().unwrap_or(providers::ANTHROPIC)).ok_or("That isn’t a provider Phaethon knows.")?;
    let vault_name = state.vault.name();
    if p.id == providers::ANTHROPIC {
        let key = off_main(move || secrets::get(&vault_name, providers::ANTHROPIC)).await.ok().flatten();
        return Ok(anthropic::models_or_fallback(key.as_deref()).await);
    }
    let base = providers::base_url(&state.vault.settings(), p)?;
    let b = base.clone();
    // Whatever key may go there; none is fine (OpenRouter and local servers list without one).
    let key = off_main(move || Ok(providers::key_for(p, &b, |id| secrets::get(&vault_name, id)).ok().flatten())).await?;
    openai::list_models(p, &base, key.as_deref()).await
}

/// Whether a server on this computer (or one's own) answers, in words, with its models.
#[tauri::command]
async fn provider_status(state: State<'_, AppState>, provider: String) -> Result<openai::ServerStatus, String> {
    let p = providers::preset(&provider).filter(|p| p.editable_base).ok_or("Only a server on this computer or your own can be checked.")?;
    let base = providers::base_url(&state.vault.settings(), p)?;
    let vault_name = state.vault.name();
    let b = base.clone();
    let key = off_main(move || Ok(providers::key_for(p, &b, |id| secrets::get(&vault_name, id)).ok().flatten())).await?;
    Ok(openai::status(p, &base, key.as_deref()).await)
}

/// Choose the provider for Phaethon's own agent.
#[tauri::command]
fn settings_set_provider(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let p = providers::preset(&provider).ok_or("That isn’t a provider Phaethon knows.")?;
    state
        .vault
        .set_setting("provider", p.id.into())
        .map_err(|e| format!("Could not save the setting: {e}"))
}

/// Change one entry of a provider-keyed map in settings.json, keeping the rest.
fn set_provider_entry(state: &AppState, setting: &str, current: Option<serde_json::Value>, provider: &str, value: Option<String>) -> Result<(), String> {
    let mut map = current.and_then(|v| v.as_object().cloned()).unwrap_or_default();
    match value {
        Some(v) => map.insert(provider.to_string(), v.into()),
        None => map.remove(provider),
    };
    state
        .vault
        .set_setting(setting, serde_json::Value::Object(map))
        .map_err(|e| format!("Could not save the setting: {e}"))
}

/// Choose the model `provider` answers with by default (not Anthropic: see
/// `settings_set_model`); `None` clears it.
#[tauri::command]
fn settings_set_provider_model(state: State<'_, AppState>, provider: String, model: Option<String>) -> Result<(), String> {
    let p = providers::preset(&provider).filter(|p| p.id != providers::ANTHROPIC).ok_or("That isn’t a provider Phaethon knows.")?;
    let model = match model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(m) if providers::is_valid_compat_model(m) => Some(m.to_string()),
        Some(_) => return Err("That isn’t a model name Phaethon can use. It’s one word, like gpt-5 or llama3.2:3b.".into()),
    };
    set_provider_entry(&state, "providerModels", state.vault.settings().provider_models, p.id, model)
}

/// The address of a server on this computer or one's own; `None` goes back to
/// the usual one. The services' own addresses can't be changed.
#[tauri::command]
fn settings_set_provider_url(state: State<'_, AppState>, provider: String, url: Option<String>) -> Result<(), String> {
    let p = providers::preset(&provider).filter(|p| p.editable_base).ok_or("That provider’s address can’t be changed.")?;
    let url = match url.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(u) => Some(providers::check_base(u)?),
    };
    set_provider_entry(&state, "providerUrls", state.vault.settings().provider_urls, p.id, url)
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
    let dir = state.vault.space_dir(&space)?;
    Ok(match cli_with_models(&state.vault) {
        Some(cli) => space_model::get_cli(&dir, cli.id()).map(|m| format!("{}:{m}", cli.id())),
        None => space_model::get(&dir),
    })
}

/// The CLI whose per-space models are in use: Codex or Gemini CLI when one
/// answers (Claude Code picks its own); `None` for Phaethon's own agent.
fn cli_with_models(vault: &Vault) -> Option<agent::Cli> {
    agent::Cli::of(vault.settings().backend).filter(|c| *c != agent::Cli::Claude)
}

/// Choose the model that answers in `space`: Phaethon's own agent's (a model
/// reference), or with `codex:` / `gemini:` that CLI's; `None` goes back to
/// the default of whichever answers now. Applies from the next message there.
#[tauri::command]
fn space_model_set(state: State<'_, AppState>, space: String, model: Option<String>) -> Result<(), String> {
    if let Some((cli, m)) = model.as_deref().and_then(space_model::split_cli_ref) {
        return space_model::set_cli(&state.vault, &space, cli, Some(m));
    }
    match (&model, cli_with_models(&state.vault)) {
        (None, Some(cli)) => space_model::set_cli(&state.vault, &space, cli.id(), None),
        _ => space_model::set(&state.vault, &space, model.as_deref()),
    }
}

/// Every space that has its own model, by space id: for the CLI that answers
/// now if it takes one (as `cli:model`), else Phaethon's own agent's.
#[tauri::command]
fn space_models_list(state: State<'_, AppState>) -> Result<std::collections::BTreeMap<String, String>, String> {
    match cli_with_models(&state.vault) {
        Some(cli) => space_model::list_cli(&state.vault, cli.id()),
        None => space_model::list(&state.vault),
    }
}

// ---- Tutor modes and the study planner (tutor_mode.rs, plan.rs) -------------

/// Choose how the agent tutors in `space` (`normal`, `quiz`, `explain`,
/// `socratic`, `cram`). Applies from the next message in that space.
#[tauri::command]
fn space_tutor_mode_set(state: State<'_, AppState>, space: String, mode: String) -> Result<(), String> {
    let mode = tutor_mode::Mode::parse(&mode).ok_or("That isn’t a tutor mode Phaethon knows.")?;
    tutor_mode::set(&state.vault, &space, mode)
}

/// Every space with a tutor mode other than normal, by space id.
#[tauri::command]
fn space_tutor_modes_list(state: State<'_, AppState>) -> Result<std::collections::BTreeMap<String, tutor_mode::Mode>, String> {
    tutor_mode::list(&state.vault)
}

/// The space's imported courses and what's due from now on in them.
#[tauri::command]
fn plan_upcoming(state: State<'_, AppState>, space: String) -> Result<plan::UpcomingView, String> {
    state.vault.space_dir(&space)?;
    plan::upcoming(&lms::access::visible(&state.vault, &space), lms::store::now_secs())
}

/// The exams added in `space` (`study/exams.json`).
#[tauri::command]
fn plan_exams_get(state: State<'_, AppState>, space: String) -> Result<Vec<plan::Exam>, String> {
    plan::exams_get(&state.vault.space_dir(&space)?)
}

/// Replace the exams in `space`; returns them as saved.
#[tauri::command]
fn plan_exams_set(state: State<'_, AppState>, space: String, exams: Vec<plan::Exam>) -> Result<Vec<plan::Exam>, String> {
    plan::exams_set(&state.vault.space_dir(&space)?, exams)
}

/// Write the study schedule to `study/plan.md` in `space`; returns that path.
#[tauri::command]
fn plan_save(state: State<'_, AppState>, space: String, markdown: String) -> Result<String, String> {
    plan::save_plan(&state.vault.space_dir(&space)?, &markdown)
}

/// The planner's settings and check-offs in `space`.
#[tauri::command]
fn plan_state_get(state: State<'_, AppState>, space: String) -> Result<plan::PlanState, String> {
    Ok(plan::state_get(&state.vault.space_dir(&space)?))
}

#[tauri::command]
fn plan_state_set(state: State<'_, AppState>, space: String, plan_state: plan::PlanState) -> Result<plan::PlanState, String> {
    plan::state_set(&state.vault.space_dir(&space)?, plan_state)
}

/// Open a file in `space` with its default app, or show it in Finder when
/// `reveal`. Only files inside the space itself; see open.rs.
#[tauri::command]
fn file_open(state: State<'_, AppState>, space: String, path: String, reveal: Option<bool>) -> Result<(), String> {
    let dir = state.vault.space_dir(&space)?;
    open::open(&dir, &lms::access::visible(&state.vault, &space), &path, reveal.unwrap_or(false))
}

// ---- Course sites (lms/) ----------------------------------------------------
//
// Course sites belong to the vault: their connections, sessions and imported
// courses are shared by every space, and course-access.json says which space
// sees which courses, and which parts of them (lms/access.rs).

/// Canvas schools whose name matches `query` (Canvas's public search); `[]` for the other kinds.
#[tauri::command]
async fn lms_schools(kind: lms::Kind, query: String) -> Result<Vec<lms::service::School>, String> {
    lms::service::schools(kind, &query).await
}

/// Open the sign-in window on the school's own page and wait until the person
/// is signed in; the session goes to the keychain, never to the webview.
/// `Err("cancelled")` when the window is closed. `school_name` (optional, from
/// the school search) titles the window and is kept with the connection.
#[tauri::command]
async fn lms_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    kind: lms::Kind,
    address: String,
    school_name: Option<String>,
) -> Result<lms::service::ConnectionView, String> {
    let site = lms::Site::new(kind, &address).map_err(|e| e.to_string())?;
    let school = school_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| site.base.host_str().unwrap_or("your school").to_string());
    let store_id = lms::login::data_store_id(&state.vault.name());
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lms-login")
        .join(store_id.iter().map(|b| format!("{b:02x}")).collect::<String>());
    // A made-up or mistyped address says so, instead of opening a blank window.
    lms::probe::check(&site).await?;
    let credential = lms::login::sign_in(&app, &site, &format!("Sign in to {school}"), store_id, data_dir).await?;
    let vault = state.vault.clone();
    off_main(move || {
        let view = lms::service::save_sign_in(&vault, &site, &credential)?;
        let Some(name) = school_name else { return Ok(view) };
        lms::service::set_school_name(vault.root(), &view.id, &name)?;
        lms::service::connections(&vault)?.into_iter().find(|c| c.id == view.id).ok_or_else(|| "The connection wasn’t saved.".into())
    })
    .await
}

/// The vault's course sites. Reads only lms.json (a signed-in hint, never the keychain).
#[tauri::command]
async fn lms_connections(state: State<'_, AppState>) -> Result<Vec<lms::service::ConnectionView>, String> {
    let vault = state.vault.clone();
    off_main(move || lms::service::connections(&vault)).await
}

/// The person's courses on a connected site. `Err("signedOut")` when the session ended.
#[tauri::command]
async fn lms_courses(state: State<'_, AppState>, connection: String) -> Result<Vec<lms::service::CourseView>, String> {
    lms::service::courses(&state.vault, &connection).await
}

/// Import (or update) courses into `<vault>/courses/`, streaming progress; always
/// ends with `done`. `spaces` may see every part of each course imported for the
/// first time; courses imported before keep who can see them.
#[tauri::command]
async fn lms_import(
    state: State<'_, AppState>,
    connection: String,
    course_ids: Vec<String>,
    spaces: Vec<String>,
    on_event: Channel<lms::service::ImportEvent>,
) -> Result<(), String> {
    let emit = |e: lms::service::ImportEvent| {
        let _ = on_event.send(e);
    };
    lms::service::import(&state.vault, &connection, &course_ids, &spaces, &emit).await;
    Ok(())
}

/// Sign out of a course site: its session leaves the keychain; the connection,
/// its imported courses and who can see them stay.
#[tauri::command]
async fn lms_disconnect(state: State<'_, AppState>, connection: String) -> Result<(), String> {
    let vault = state.vault.clone();
    off_main(move || lms::service::disconnect(&vault, &connection)).await
}

/// The grades `space` may see, from disk (no network).
#[tauri::command]
fn lms_grades(state: State<'_, AppState>, space: String) -> Result<Vec<lms::store::GradeRec>, String> {
    state.vault.space_dir(&space)?;
    lms::service::grades(&state.vault, &lms::access::visible(&state.vault, &space))
}

/// Read only the grades again for a connection's courses whose grades `space`
/// may see, streaming progress; always ends with `done`.
#[tauri::command]
async fn lms_grades_refresh(state: State<'_, AppState>, space: String, connection: String, on_event: Channel<lms::service::GradesEvent>) -> Result<(), String> {
    let emit = |e: lms::service::GradesEvent| {
        let _ = on_event.send(e);
    };
    match state.vault.space_dir(&space) {
        Ok(_) => lms::service::grades_refresh(&state.vault, &lms::access::visible(&state.vault, &space), &connection, &emit).await,
        Err(message) => {
            emit(lms::service::GradesEvent::Error { message });
            emit(lms::service::GradesEvent::Done);
        }
    }
    Ok(())
}

/// Which courses each space may see, and which parts: every space and every
/// imported course, with the access of `space` only when one is named.
#[tauri::command]
fn course_access_get(state: State<'_, AppState>, space: Option<String>) -> Result<lms::access::AccessView, String> {
    lms::access::view(&state.vault, space.as_deref())
}

/// Let `space` see `parts` of `course` (`[]`: nothing). Only imported courses.
#[tauri::command]
fn course_access_set(state: State<'_, AppState>, space: String, course: String, parts: Vec<lms::access::Part>) -> Result<(), String> {
    if !lms::access::all_courses(&state.vault)?.iter().any(|c| c.key == course) {
        return Err("That course isn’t imported.".into());
    }
    lms::access::set(&state.vault, &space, &course, &parts)
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
    // Started as the PDF reader for a course import (see lms/text.rs): read, print, exit.
    if let Some(code) = lms::text::child_main() {
        std::process::exit(code);
    }
    let app = tauri::Builder::default()
        // Used from Rust only (Export's save dialog); no capability lets the webview call it.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let vault = Vault::default_location()?;
            vault.ensure_initialized()?;
            // Course sites moved from spaces to the vault: move any a space still has (once;
            // see lms/migrate.rs). Off the main thread, since moving a sign-in reads the
            // keychain, and macOS may stop to ask for access.
            let to_move = vault.clone();
            std::thread::spawn(move || {
                let moved = lms::migrate::run(&to_move, &lms::migrate::Keychain(to_move.name()));
                for line in moved.moved.iter().chain(&moved.notes) {
                    eprintln!("course sites: {line}");
                }
            });
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
            // The app's window, from tauri.conf.json, with Object.prototype frozen before
            // any of its scripts run. Done here rather than with freezePrototype, which
            // Tauri puts in every window: a course site's sign-in window too, where it
            // breaks pages that add to their own objects (Duo's prompt drew nothing).
            let main = app.config().app.windows.first().cloned().ok_or("no window in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main)?
                .initialization_script(FREEZE_PROTOTYPE)
                .build()?;
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
            agent_clis_status,
            settings_get,
            settings_set_backend,
            api_key_set,
            api_key_clear,
            api_key_check,
            models_list,
            settings_set_model,
            settings_set_provider,
            settings_set_provider_model,
            settings_set_provider_url,
            provider_status,
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
            conversations_search,
            lms_schools,
            lms_connect,
            lms_connections,
            lms_courses,
            lms_import,
            lms_disconnect,
            lms_grades,
            lms_grades_refresh,
            course_access_get,
            course_access_set,
            study::commands::study_sources,
            study::commands::study_overview,
            study::commands::study_deck,
            study::commands::study_deck_save,
            study::commands::study_session,
            study::commands::study_rate,
            study::commands::study_make_deck,
            study::commands::study_make_quiz,
            study::commands::study_quiz,
            study::commands::study_quiz_submit,
            study::commands::study_review_mistakes,
            study::commands::study_delete,
            space_tutor_mode_set,
            space_tutor_modes_list,
            plan_upcoming,
            plan_exams_get,
            plan_exams_set,
            plan_save,
            plan_state_get,
            plan_state_set
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

#[cfg(test)]
mod window_tests {
    /// The prototype freeze is the app window's alone: tauri's switch for it stays off (it
    /// would reach the sign-in window), and the window is built in `run` with it.
    #[test]
    fn only_the_app_window_freezes_its_prototype() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["security"]["freezePrototype"], false);
        // Each platform's file replaces the window list, so each must say it too.
        for (name, text) in [
            ("tauri.conf.json", include_str!("../tauri.conf.json")),
            ("tauri.macos.conf.json", include_str!("../tauri.macos.conf.json")),
            ("tauri.windows.conf.json", include_str!("../tauri.windows.conf.json")),
            ("tauri.linux.conf.json", include_str!("../tauri.linux.conf.json")),
        ] {
            let c: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(c["app"]["windows"][0]["create"], false, "{name}: the app builds its window itself");
        }
        let src = include_str!("lib.rs");
        assert!(src.contains(".initialization_script(FREEZE_PROTOTYPE)"));
        assert!(!include_str!("lms/login.rs").contains("FREEZE_PROTOTYPE"));
    }
}

#[cfg(test)]
mod keychain_tests {
    /// A command that can reach the keychain is async: macOS may stop to ask for
    /// keychain access, and a synchronous command would freeze the window on the
    /// main thread meanwhile (it did: lms_connections, after a rebuild).
    #[test]
    fn keychain_commands_never_run_on_the_main_thread() {
        let src = include_str!("lib.rs");
        let reaches = ["secrets::", "lms::service::connections", "lms::service::disconnect", "lms::service::courses", "lms::service::session"];
        for chunk in src.split("#[tauri::command]").skip(1) {
            let sig = chunk.lines().find(|l| l.contains("fn ")).unwrap_or("");
            let body_end = chunk.find("\n}\n").unwrap_or(chunk.len());
            let body = &chunk[..body_end];
            if reaches.iter().any(|r| body.contains(r)) {
                assert!(sig.trim_start().starts_with("async fn") || sig.contains("pub(crate) async fn"), "{sig} reaches the keychain but isn't async");
            }
        }
    }
}

