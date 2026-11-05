//! System-owned dictation. The OS owns audio permissions and recognition.

#[cfg(target_os = "macos")]
pub fn start() -> Result<(), String> {
    use objc2::{class, msg_send, sel, runtime::{AnyObject, Bool}};
    // Match muda's StartDictation action, on the main thread with the editor focused.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let action = sel!(startDictation:);
        let target: *mut AnyObject = msg_send![app, targetForAction: action];
        if target.is_null() {
            return Err("Enable Dictation in System Settings → Keyboard, then focus your message and try again.".into());
        }
        let started: Bool = msg_send![app, sendAction: action, to: target, from: std::ptr::null::<AnyObject>()];
        if started.as_bool() { Ok(()) } else { Err("Dictation could not start. Check System Settings → Keyboard → Dictation.".into()) }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start() -> Result<(), String> {
    Err("Use your operating system's dictation shortcut in the message field.".into())
}
