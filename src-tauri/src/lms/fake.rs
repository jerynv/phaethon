//! Tests only: a small fake course site on 127.0.0.1 that answers each request
//! through a route function and logs what it was sent (method, path and query,
//! Cookie header), for the grade readers' tests.

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Reply {
    pub status: u16,
    pub ctype: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

pub fn json(body: impl Into<String>) -> Reply {
    Reply { status: 200, ctype: "application/json; charset=utf-8", headers: vec![], body: body.into() }
}

pub fn html(body: impl Into<String>) -> Reply {
    Reply { status: 200, ctype: "text/html; charset=utf-8", headers: vec![], body: body.into() }
}

pub fn status(code: u16) -> Reply {
    Reply { status: code, ctype: "application/json", headers: vec![], body: r#"{"errors":[{"message":"no"}]}"#.into() }
}

pub fn redirect(to: &str) -> Reply {
    Reply { status: 302, ctype: "text/html", headers: vec![("location", to.into())], body: String::new() }
}

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub cookie: Option<String>,
}

pub type Log = Arc<Mutex<Vec<Seen>>>;
pub type Route = Arc<dyn Fn(&str) -> Reply + Send + Sync>;

/// Serve `route(path_and_query)` until the test ends. Returns the base address and the log.
pub async fn serve(route: Route) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log: Log = Arc::default();
    let seen = log.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (route, seen) = (route.clone(), seen.clone());
            tokio::spawn(async move {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    req.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&req).into_owned();
                let mut first = head.split_whitespace();
                let method = first.next().unwrap_or("").to_string();
                let target = first.next().unwrap_or("/").to_string();
                let cookie = head.lines().find_map(|l| l.to_ascii_lowercase().starts_with("cookie:").then(|| l[7..].trim().to_string()));
                seen.lock().unwrap().push(Seen { method, target: target.clone(), cookie });
                let r = route(&target);
                let extra: String = r.headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
                let out = format!(
                    "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{}",
                    r.status,
                    r.ctype,
                    r.body.len(),
                    r.body
                );
                let _ = sock.write_all(out.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (base, log)
}

/// Every request was a GET carrying `cookie`, and none sent an API token.
pub fn assert_read_only_with_session(log: &Log, cookie: &str) {
    let seen = log.lock().unwrap();
    assert!(!seen.is_empty());
    for s in seen.iter() {
        assert_eq!(s.method, "GET", "read-only: {s:?}");
        assert!(s.cookie.as_deref().is_some_and(|c| c.contains(cookie)), "the person's session: {s:?}");
    }
}
