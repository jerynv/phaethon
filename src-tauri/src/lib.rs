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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![dev_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
