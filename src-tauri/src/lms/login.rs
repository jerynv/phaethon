//! The sign-in window: the school's own login page in a separate window, so
//! SSO, Duo and consent pages all just work. Phaethon watches where it goes
//! and reads the site's cookies after each page; the site module says when
//! the person is signed in, and the window closes.
//!
//! The window has no capabilities (capabilities/default.json names "main"
//! only), so the pages in it can't call the app. It keeps its own website data
//! store per vault and space (macOS 14+; a data folder elsewhere), apart from
//! the app's window, so the school's sign-in is remembered next time in this
//! space and never shared with another.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

use super::{Cookie, Credential, LoginNav, Site};

pub const LABEL: &str = "lms-login";
/// The person has this long to sign in before the window gives up.
const LIMIT: Duration = Duration::from_secs(30 * 60);

static OPEN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

/// The cookies a browser would send to `site`: the domain is the site's host
/// or a parent of it, and secure ones only over https. One per name, the most
/// specific domain winning.
pub fn site_cookies<'a>(site: &Site, all: impl IntoIterator<Item = (&'a str, &'a str, Option<&'a str>, bool)>) -> Vec<Cookie> {
    let host = site.base.host_str().unwrap_or("").to_ascii_lowercase();
    let https = site.base.scheme() == "https";
    let mut picked: Vec<(usize, Cookie)> = vec![];
    for (name, value, domain, secure) in all {
        let Some(domain) = domain else { continue };
        let d = domain.trim_start_matches('.').to_ascii_lowercase();
        let applies = !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")));
        if !applies || (secure && !https) {
            continue;
        }
        match picked.iter_mut().find(|(_, c)| c.name == name) {
            Some((len, c)) if d.len() > *len => {
                *len = d.len();
                c.value = value.to_string();
            }
            Some(_) => {}
            None => picked.push((d.len(), Cookie { name: name.to_string(), value: value.to_string() })),
        }
    }
    picked.into_iter().map(|(_, c)| c).collect()
}

/// Where the sign-in window may go: web pages, and the in-page documents sign-in
/// pages build their frames from (about:, blob:, data:). Never files, app links or
/// the app itself. Refusing a frame's about:srcdoc or blob: leaves SSO pages blank.
pub fn allowed_navigation(u: &Url) -> bool {
    matches!(u.scheme(), "https" | "http" | "about" | "blob" | "data")
}

/// Where the window is, for the dev log: no query or fragment (they can carry tokens).
fn where_(u: &Url) -> String {
    format!("{}://{}{}", u.scheme(), u.host_str().unwrap_or(""), u.path())
}

/// The sign-in window's website data store for a vault and space: 16 stable bytes.
pub fn data_store_id(vault: &str, space: &str) -> [u8; 16] {
    let key = format!("phaethon-lms-login\0{vault}\0{space}");
    let fnv = |seed: u64| key.bytes().fold(seed, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01B3));
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&fnv(0xcbf2_9ce4_8422_2325).to_be_bytes());
    id[8..].copy_from_slice(&fnv(0x6c62_272e_07bb_0142).to_be_bytes());
    // A version 4 / variant 1 UUID, as WebKit expects one.
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

struct OpenGuard;

impl Drop for OpenGuard {
    fn drop(&mut self) {
        OPEN.store(false, Ordering::SeqCst);
    }
}

enum Msg {
    Check,
    Closed,
    /// A page asked for a new window (window.open, target=_blank): opened here instead.
    Open(Url),
}

/// Open the sign-in window for `site` and wait until the site module sees the
/// person signed in (the credential, CSRF token filled in where it can be), or
/// the window is closed (`Err("cancelled")`). One window at a time.
pub async fn sign_in(app: &AppHandle, site: &Site, title: &str, store_id: [u8; 16], data_dir: PathBuf) -> Result<Credential, String> {
    if OPEN.swap(true, Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.set_focus();
        }
        return Err("A sign-in window is already open. Finish signing in there, or close it.".into());
    }
    let _guard = OpenGuard;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Msg>();
    let on_load = tx.clone();
    let on_new = tx.clone();
    // Where the window is, from its own load events. Never asked of the webview:
    // wry panics (taking the app down) when asked mid-navigation.
    let at: std::sync::Arc<std::sync::Mutex<Option<Url>>> = Default::default();
    let at_load = at.clone();
    let start = super::login_url(site);
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(start))
        .title(title)
        .inner_size(960.0, 780.0)
        .min_inner_size(480.0, 480.0)
        .center()
        .focused(true)
        .on_navigation(|u| {
            let ok = allowed_navigation(u);
            if cfg!(debug_assertions) && !ok {
                eprintln!("[lms-login] refused {}", where_(u));
            }
            ok
        })
        .on_new_window(move |u, _| {
            let _ = on_new.send(Msg::Open(u));
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |_, payload| {
            let finished = payload.event() == tauri::webview::PageLoadEvent::Finished;
            if cfg!(debug_assertions) {
                eprintln!("[lms-login] {} {}", if finished { "loaded" } else { "loading" }, where_(payload.url()));
            }
            if let Ok(mut a) = at_load.lock() {
                *a = Some(payload.url().clone());
            }
            if finished {
                let _ = on_load.send(Msg::Check);
            }
        });
    #[cfg(target_os = "macos")]
    let builder = {
        let _ = &data_dir;
        // WKWebView's own user agent names no browser, and Duo and some school sign-in
        // pages refuse or quietly stall in a browser they don't recognise: say Safari,
        // which is the engine this window is.
        builder.data_store_identifier(store_id).user_agent(SAFARI_UA)
    };
    #[cfg(not(target_os = "macos"))]
    let builder = {
        let _ = store_id;
        builder.data_directory(data_dir)
    };
    let window = builder.build().map_err(|e| format!("The sign-in window couldn’t open: {e}"))?;
    {
        let tx = tx.clone();
        window.on_window_event(move |e| {
            if matches!(e, WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }) {
                let _ = tx.send(Msg::Closed);
            }
        });
    }
    let started = std::time::Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(1500));
    let outcome = loop {
        let msg = tokio::select! {
            biased;
            m = rx.recv() => m.unwrap_or(Msg::Closed),
            _ = tick.tick() => Msg::Check,
        };
        match msg {
            Msg::Closed => break Err("cancelled".to_string()),
            Msg::Open(u) => {
                if matches!(u.scheme(), "https" | "http") {
                    let _ = window.navigate(u);
                }
                continue;
            }
            Msg::Check => {}
        }
        if app.get_webview_window(LABEL).is_none() {
            break Err("cancelled".to_string());
        }
        if started.elapsed() > LIMIT {
            break Err("cancelled".to_string());
        }
        let w = window.clone();
        // Reading cookies waits on the window's own thread: never block this one.
        let Some(here) = at.lock().ok().and_then(|a| a.clone()) else { continue };
        let read = tauri::async_runtime::spawn_blocking(move || w.cookies().unwrap_or_default()).await;
        let Ok(jar) = read else { continue };
        let at = here;
        let all = jar.iter().map(|c| (c.name(), c.value(), c.domain(), c.secure().unwrap_or(false)));
        let cookies = site_cookies(site, all);
        if let Some(credential) = super::login_result(site, &LoginNav { url: &at, cookies: &cookies }) {
            break Ok(credential);
        }
    };
    let _ = window.destroy();
    let credential = outcome?;
    Ok(super::csrf::fill(site, credential).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Kind;

    #[test]
    fn only_the_sites_cookies_are_kept() {
        let site = Site::new(Kind::Canvas, "canvas.iu.edu").unwrap();
        let jar = vec![
            ("canvas_session", "s1", Some("canvas.iu.edu"), true),
            ("_csrf_token", "t", Some(".canvas.iu.edu"), true),
            ("sso", "parent", Some(".iu.edu"), true),
            ("sso", "child", Some("canvas.iu.edu"), true),
            ("tracker", "x", Some(".google.com"), false),
            ("evil", "x", Some("notcanvas.iu.edu"), false),
            ("lookalike", "x", Some("u.edu"), false),
            ("hostless", "x", None, false),
        ];
        let got = site_cookies(&site, jar);
        let pairs: Vec<(&str, &str)> = got.iter().map(|c| (c.name.as_str(), c.value.as_str())).collect();
        assert_eq!(pairs, vec![("canvas_session", "s1"), ("_csrf_token", "t"), ("sso", "child")]);
        // Secure cookies never go to a plain-http site.
        let local = Site::for_test(Kind::Canvas, "http://127.0.0.1:9");
        assert!(site_cookies(&local, vec![("s", "1", Some("127.0.0.1"), true)]).is_empty());
    }

    #[test]
    fn the_window_goes_to_web_pages_only() {
        for ok in ["https://idp.iu.edu/login", "http://old.example.edu/", "about:blank", "about:srcdoc", "blob:https://idp.iu.edu/1f2e", "data:text/html,x"] {
            assert!(allowed_navigation(&Url::parse(ok).unwrap()), "{ok}");
        }
        for no in ["file:///etc/passwd", "tauri://localhost/", "ipc://localhost/x", "zoommtg://x", "javascript:alert(1)"] {
            assert!(!allowed_navigation(&Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn each_space_has_its_own_sign_in_store() {
        let a = data_store_id("default", "school");
        assert_eq!(a, data_store_id("default", "school"));
        assert_ne!(a, data_store_id("default", "work"));
        assert_ne!(a, data_store_id("other", "school"));
        assert_eq!(a[6] >> 4, 4);
    }

    #[test]
    fn the_sign_in_window_has_no_capabilities() {
        // Every capability file: none may name the sign-in window, a wildcard, or remote pages.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let text = std::fs::read_to_string(entry.path()).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            let windows: Vec<&str> = v["windows"].as_array().map(|a| a.iter().filter_map(|w| w.as_str()).collect()).unwrap_or_default();
            assert!(!windows.iter().any(|w| *w == LABEL || w.contains('*')), "{windows:?}");
            assert!(v.get("webviews").is_none() && v.get("remote").is_none(), "{text}");
            checked += 1;
        }
        assert!(checked > 0);
    }
}
