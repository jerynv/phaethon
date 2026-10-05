fn main() {
    // Declaring the app's own commands puts them under the capability ACL:
    // a command not granted in capabilities/*.json is rejected at the IPC layer.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "dev_log", "agent_send", "agent_cancel", "agent_approve", "thread_load", "settings_get", "settings_set_backend", "api_key_set", "api_key_clear",
        ]),
    ))
    .expect("failed to run tauri-build");
}
