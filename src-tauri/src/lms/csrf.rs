//! Finding a site's CSRF token, for site modules and for the sign-in flow.
//!
//! Some sites put it in a cookie (Canvas `_csrf_token`, URL-encoded; an
//! `XSRF-TOKEN` cookie), others only in the page (Moodle's `sesskey` in
//! `M.cfg`, a `<meta name="csrf-token">`). After sign-in, [`fill`] tries the
//! cookies and then the site's start page when the site module didn't set one.

use super::{Cookie, Credential, Session, Site};

/// Percent-decoding (and `+` as a space, as form encoding has it).
pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let hex = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit)).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A cookie's value by name (the last one wins, as a browser sends the most specific last).
pub fn cookie<'a>(cookies: &'a [Cookie], name: &str) -> Option<&'a str> {
    cookies.iter().rev().find(|c| c.name == name).map(|c| c.value.as_str())
}

/// Only something that can safely go in a header: printable ASCII, not too long.
fn plausible(t: &str) -> Option<String> {
    let t = t.trim();
    (!t.is_empty() && t.len() <= 1024 && t.bytes().all(|c| (0x21..0x7f).contains(&c))).then(|| t.to_string())
}

/// Canvas's `_csrf_token` cookie, decoded; or an `XSRF-TOKEN` / `csrftoken` cookie.
pub fn from_cookies(cookies: &[Cookie]) -> Option<String> {
    ["_csrf_token", "XSRF-TOKEN", "csrftoken"].iter().find_map(|n| cookie(cookies, n)).and_then(|v| plausible(&url_decode(v)))
}

/// Moodle's sesskey from a page: `"sesskey":"…"` in `M.cfg`, or a form field named sesskey.
pub fn moodle_sesskey(html: &str) -> Option<String> {
    if let Some(i) = html.find("\"sesskey\":\"") {
        let rest = &html[i + 11..];
        return rest.find('"').and_then(|e| plausible(&rest[..e]));
    }
    let i = html.find("name=\"sesskey\"")?;
    let tag_start = html[..i].rfind('<')?;
    let tag_end = i + html[i..].find('>')?;
    attr_value(&html[tag_start..tag_end], "value")
}

/// `<meta name="csrf-token" content="…">` (also `_csrf`, `csrf_token`, `xsrf-token`).
pub fn meta_token(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta") {
        let start = from + i;
        let end = start + lower[start..].find('>')?;
        let tag = &html[start..end];
        let name = attr_value(tag, "name").unwrap_or_default().to_ascii_lowercase();
        if matches!(name.as_str(), "csrf-token" | "_csrf" | "csrf_token" | "xsrf-token") {
            return attr_value(tag, "content");
        }
        from = end;
    }
    None
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let (q, body) = match rest.chars().next()? {
            q @ ('"' | '\'') => (q, &rest[1..]),
            _ => (' ', rest),
        };
        let end = body.find(q).unwrap_or(body.len());
        return plausible(&super::html::decode_entities(&body[..end]));
    }
    None
}

/// GET a page on the site with the session and read a token from it with `find`
/// (e.g. [`moodle_sesskey`] or [`meta_token`]).
pub async fn from_page(session: &Session, path: &str, find: fn(&str) -> Option<String>) -> Result<Option<String>, super::LmsError> {
    let url = session.site.base.join(path).map_err(|e| super::LmsError::Other(e.to_string()))?;
    let res = session.get(&url).await?;
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| super::LmsError::Network(e.to_string()))?;
        body.extend_from_slice(&chunk);
        if body.len() > 4 * 1024 * 1024 {
            break;
        }
    }
    Ok(find(&String::from_utf8_lossy(&body)))
}

/// The credential with its CSRF token filled in where the site module left
/// none: from the cookies, else from the site's start page. Never fails: a
/// site that needs no token just has none.
pub async fn fill(site: &Site, mut credential: Credential) -> Credential {
    if credential.csrf.is_some() {
        return credential;
    }
    if let Some(t) = from_cookies(&credential.cookies) {
        credential.csrf = Some(t);
        return credential;
    }
    let session = Session::new(site.clone(), credential.clone());
    let find: fn(&str) -> Option<String> = |html| moodle_sesskey(html).or_else(|| meta_token(html));
    if let Ok(Some(t)) = from_page(&session, "/", find).await {
        credential.csrf = Some(t);
    }
    credential
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_from_cookies_and_pages() {
        let c = |n: &str, v: &str| Cookie { name: n.into(), value: v.into() };
        assert_eq!(from_cookies(&[c("a", "1"), c("_csrf_token", "ab%2Bc%3D%3D")]).as_deref(), Some("ab+c=="));
        assert_eq!(from_cookies(&[c("XSRF-TOKEN", "x1")]).as_deref(), Some("x1"));
        assert_eq!(from_cookies(&[c("_csrf_token", "bad\r\nX: y")]), None);
        assert_eq!(moodle_sesskey(r#"M.cfg = {"wwwroot":"https://m","sesskey":"AbC123","x":1};"#).as_deref(), Some("AbC123"));
        assert_eq!(moodle_sesskey(r#"<input type="hidden" name="sesskey" value="Zz9">"#).as_deref(), Some("Zz9"));
        assert_eq!(meta_token(r#"<head><meta charset="utf-8"><META name="csrf-token" content="t&amp;k"></head>"#).as_deref(), Some("t&k"));
        assert_eq!(meta_token("<meta name=description content=x>"), None);
        assert_eq!(url_decode("a%20b%zz%4"), "a b%zz%4");
    }
}
