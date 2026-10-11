//! Before the sign-in window opens: is there a course site of this kind at this
//! address? A made-up or mistyped address would otherwise open a blank window
//! with nothing to say what's wrong. Each check is one public, signed-out
//! request every site of that kind answers in its own recognisable way.

use std::time::Duration;

use super::{Kind, Site};

/// What a signed-out request to the kind's check address came back with.
pub struct Answer<'a> {
    pub status: u16,
    pub content_type: &'a str,
    /// Every Set-Cookie header, and every header name, lower-cased.
    pub cookies: &'a [String],
    pub headers: &'a [String],
    pub body: &'a str,
}

/// The signed-out address that tells the kind apart (relative to the site's base).
pub fn check_path(kind: Kind) -> &'static str {
    match kind {
        // 401 {"status":"unauthenticated"} from Canvas's API.
        Kind::Canvas => "api/v1/users/self",
        // The public list of API versions every Brightspace serves.
        Kind::Brightspace => "d2l/api/versions/",
        // Moodle's login page: it sets a MoodleSession cookie even when it hands
        // over to the school's SSO.
        Kind::Moodle => "login/index.php",
        // Learn's public version endpoint.
        Kind::Blackboard => "learn/api/public/v1/system/version",
    }
}

/// True when the answer is what a site of `kind` says.
pub fn looks_like(kind: Kind, a: &Answer) -> bool {
    let body = a.body.to_ascii_lowercase();
    let cookie = |name: &str| a.cookies.iter().any(|c| c.to_ascii_lowercase().starts_with(name));
    let header = |name: &str| a.headers.iter().any(|h| h == name);
    let json = a.content_type.contains("json");
    match kind {
        Kind::Canvas => {
            header("x-canvas-meta")
                || cookie("_normandy_session")
                || cookie("canvas_session")
                || (a.status == 401 && body.contains("unauthenticated"))
        }
        Kind::Brightspace => (json && body.contains("productcode") && body.contains("latestversion")) || cookie("d2lsessionval"),
        Kind::Moodle => cookie("moodlesession") || body.contains("m.cfg") || body.contains("moodle"),
        Kind::Blackboard => (json && body.contains("\"learn\"")) || cookie("bbrouter") || (cookie("jsessionid") && body.contains("blackboard")),
    }
}

/// Ok when `site` answers like a site of its kind; otherwise why, in plain words.
pub async fn check(site: &Site) -> Result<(), String> {
    let host = site.base.host_str().unwrap_or("that address").to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Phaethon/", env!("CARGO_PKG_VERSION")))
        // The kind's own answer, not wherever its SSO sends a signed-out visitor.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let url = site.base.join(check_path(site.kind)).map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{host} didn’t answer. Check the address, or try again in a moment.")
        } else {
            format!("Couldn’t reach {host}. Check the address: it’s the one in your browser’s address bar when you open {}.", site.kind.name())
        }
    })?;
    let status = res.status().as_u16();
    let content_type = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let cookies: Vec<String> =
        res.headers().get_all(reqwest::header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).map(str::to_string).collect();
    let headers: Vec<String> = res.headers().keys().map(|k| k.as_str().to_ascii_lowercase()).collect();
    // Enough of the page to recognise it.
    let bytes = res.bytes().await.unwrap_or_default();
    let body = String::from_utf8_lossy(&bytes[..bytes.len().min(256 * 1024)]).to_string();
    let a = Answer { status, content_type: &content_type, cookies: &cookies, headers: &headers, body: &body };
    if looks_like(site.kind, &a) {
        Ok(())
    } else if status >= 500 {
        Err(format!("{host} is having trouble right now (it answered with an error). Try again later."))
    } else {
        Err(format!(
            "{host} doesn’t look like a {} site. Check the address, and which course site your school uses.",
            site.kind.name()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer<'a>(status: u16, ct: &'a str, cookies: &'a [String], headers: &'a [String], body: &'a str) -> Answer<'a> {
        Answer { status, content_type: ct, cookies, headers, body }
    }

    #[test]
    fn each_kind_is_told_apart_by_its_own_answer() {
        let none: Vec<String> = vec![];
        let canvas = answer(401, "application/json", &none, &none, r#"{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}"#);
        assert!(looks_like(Kind::Canvas, &canvas));
        assert!(!looks_like(Kind::Moodle, &canvas) && !looks_like(Kind::Brightspace, &canvas) && !looks_like(Kind::Blackboard, &canvas));

        let d2l = answer(200, "application/json; charset=utf-8", &none, &none, r#"[{"ProductCode":"lp","LatestVersion":"1.47","SupportedVersions":["1.0"]}]"#);
        assert!(looks_like(Kind::Brightspace, &d2l) && !looks_like(Kind::Canvas, &d2l));

        let moodle_cookie = vec!["MoodleSession=abc; path=/; secure".to_string()];
        let moodle = answer(303, "text/html", &moodle_cookie, &none, "");
        assert!(looks_like(Kind::Moodle, &moodle) && !looks_like(Kind::Canvas, &moodle));

        let bb = answer(200, "application/json", &none, &none, r#"{"learn":{"major":3900,"minor":110}}"#);
        assert!(looks_like(Kind::Blackboard, &bb) && !looks_like(Kind::Brightspace, &bb));
    }

    #[test]
    fn an_ordinary_web_page_is_no_course_site() {
        let none: Vec<String> = vec![];
        let page = answer(404, "text/html", &none, &none, "<html><title>Not found</title><p>Example University</p></html>");
        for k in [Kind::Canvas, Kind::Brightspace, Kind::Moodle, Kind::Blackboard] {
            assert!(!looks_like(k, &page), "{k:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_made_up_address_says_so_plainly() {
        let site = Site::new(Kind::Moodle, "moodle.this-school-does-not-exist-9f2c.invalid").unwrap();
        let e = check(&site).await.unwrap_err();
        assert!(e.starts_with("Couldn’t reach moodle.this-school-does-not-exist-9f2c.invalid. Check the address"), "{e}");
    }

    /// Real schools, signed out (run by hand: `cargo test real_sites -- --ignored --nocapture`).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_sites() {
        for (k, a) in [
            (Kind::Canvas, "iu.instructure.com"),
            (Kind::Canvas, "canvas.instructure.com"),
            (Kind::Moodle, "sandbox.moodledemo.net"),
            (Kind::Moodle, "moodle.org"),
            (Kind::Brightspace, "learn.uwaterloo.ca"),
            (Kind::Brightspace, "purdue.brightspace.com"),
            (Kind::Blackboard, "blackboard.gwu.edu"),
            (Kind::Blackboard, "learn.uq.edu.au"),
            (Kind::Moodle, "iu.instructure.com"),
            (Kind::Canvas, "example.com"),
        ] {
            let r = check(&Site::new(k, a).unwrap()).await;
            eprintln!("{k:?} {a}: {r:?}");
        }
    }
}
