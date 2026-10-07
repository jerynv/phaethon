fn main() {
    // Declaring the app's own commands puts them under the capability ACL:
    // a command not granted in capabilities/*.json is rejected at the IPC layer.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "dev_log", "agent_send", "agent_cancel", "agent_approve", "agent_access_answer", "grants_list", "grant_revoke",
            "thread_load", "thread_new", "threads_list", "thread_open",
            "settings_get", "settings_set_backend", "api_key_set", "api_key_clear", "appearance_set",
            "spaces_list", "space_create", "space_update",
            "api_key_check", "models_list", "settings_set_model", "file_open",
        ]),
    ))
    .expect("failed to run tauri-build");
}
