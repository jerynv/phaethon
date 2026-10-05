/** True when running inside the Tauri webview (IPC available), false in a plain browser. */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Inside Tauri: forward a line to the terminal that launched the app. The Rust
 * command only prints in debug builds, so release builds drop it. Used for CSP
 * violation reports and startup checks. Never throws.
 */
export async function devLog(message: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("dev_log", { message });
  } catch {
    // Logging must never break the app.
  }
}
