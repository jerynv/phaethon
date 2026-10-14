fn main() {
    // Declaring the app's own commands puts them under the capability ACL:
    // a command not granted in capabilities/*.json is rejected at the IPC layer.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "dev_log", "agent_send", "agent_cancel", "agent_approve", "agent_access_answer", "grants_list", "grant_revoke", "grant_restore",
            "thread_load", "thread_new", "threads_list", "thread_open", "thread_delete", "claude_cli_status", "agent_clis_status",
            "thread_clear", "thread_forget", "thread_forget_preview",
            "settings_get", "settings_set_backend", "api_key_set", "api_key_clear", "appearance_set",
            "spaces_list", "space_create", "space_update",
            "api_key_check", "models_list", "settings_set_model", "file_open",
            "space_model_get", "space_model_set", "space_models_list",
            "space_touch", "space_show", "space_export", "export_show",
            "conversations_search",
            "lms_schools", "lms_connect", "lms_connections", "lms_courses", "lms_import", "lms_disconnect",
            "lms_grades", "lms_grades_refresh", "course_access_get", "course_access_set",
            "study_sources", "study_overview", "study_deck", "study_deck_save", "study_session", "study_rate", "study_make_deck", "study_make_quiz",
            "study_quiz", "study_quiz_submit", "study_review_mistakes", "study_delete", "study_chat_plan", "study_chat_make", "study_chat_cancel",
            "space_tutor_mode_set", "space_tutor_modes_list",
            "plan_upcoming", "plan_exams_get", "plan_exams_set", "plan_save", "plan_state_get", "plan_state_set",
            "settings_set_provider", "settings_set_provider_model", "settings_set_provider_url", "provider_status",
            "latex_status", "latex_compile", "latex_pdf", "latex_save", "file_view", "file_bytes",
        ]),
    ))
    .expect("failed to run tauri-build");
}
