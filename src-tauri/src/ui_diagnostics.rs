//! Opt-in snapshot of our own webview, without screen-recording permission.
//! The destination comes only from the launching process, never web content.

#[cfg(target_os = "macos")]
pub fn snapshot(window: tauri::WebviewWindow) {
    use block2::RcBlock;
    use objc2::{class, msg_send, runtime::{AnyObject, Bool}};
    use objc2_foundation::NSString;

    let Some(path) = std::env::var_os("PHAETHON_SNAPSHOT_PATH") else { return };
    let path = path.to_string_lossy().into_owned();
    let _ = window.with_webview(move |webview| unsafe {
        let view: &AnyObject = &*webview.inner().cast();
        let done = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            if image.is_null() || !error.is_null() {
                eprintln!("[webview] native snapshot unavailable");
                return;
            }
            // WKWebView supplies an NSImage; encode its bitmap as a PNG.
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            let bitmap: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let png: *mut AnyObject = msg_send![bitmap, representationUsingType: 4usize, properties: properties];
            let written: Bool = msg_send![png, writeToFile: &*NSString::from_str(&path), atomically: true];
            eprintln!("[webview] native snapshot written: {}", written.as_bool());
        });
        let _: () = msg_send![view, takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(), completionHandler: &*done];
    });
}

#[cfg(not(target_os = "macos"))]
pub fn snapshot(_: tauri::WebviewWindow) {}
