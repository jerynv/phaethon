//! Course sites (Canvas, Brightspace, Moodle, Blackboard): sign in through a
//! window showing the school's own login page, list the person's courses, and
//! fetch what a chosen course holds so it can be written into a space as plain
//! files.
//!
//! The shape every site module fills in. Each one (`canvas.rs`,
//! `brightspace.rs`, `moodle.rs`, `blackboard.rs`) exposes the same four free
//! functions, dispatched here by [`Kind`]:
//!
//! - `login_url(base) -> Url`: the page the login window opens.
//! - `login_result(base, nav) -> Option<Credential>`: given where the login
//!   window just went and the cookies it holds for the site, the credential once
//!   the person is signed in (`None`: not yet).
//! - `courses(session) -> Result<Vec<Course>, LmsError>`
//! - `content(session, course_id) -> Result<CourseContent, LmsError>`
//!
//! Signing in is the person's own, in the school's own page; Phaethon keeps the
//! session it leaves (cookies, plus the CSRF token), never an API token.
//! Credentials stay in Rust and the keychain: never in the vault (it syncs),
//! never sent to the webview, and only ever sent to the site's own origin
//! ([`Session::get`]). Links out of a course are fetched without them
//! ([`Session::fetch_external`]).

use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

pub mod blackboard;
pub mod brightspace;
pub mod canvas;
pub mod moodle;
pub mod probe;

// Core (not site specific): turning a course into files, signing in, the space's record.
pub mod csrf;
pub mod html;
pub mod import;
pub mod login;
pub mod names;
pub mod service;
pub mod store;
pub mod access;
pub mod migrate;
pub mod textbooks;
pub mod text;
#[cfg(test)]
pub mod fake;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Canvas,
    Brightspace,
    Moodle,
    Blackboard,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Canvas => "Canvas",
            Kind::Brightspace => "Brightspace",
            Kind::Moodle => "Moodle",
            Kind::Blackboard => "Blackboard",
        }
    }
}

/// The first part of a Moodle address that names one of its pages, not the folder it's in.
const MOODLE_PAGES: &[&str] = &["my", "login", "course", "mod", "admin", "user", "auth", "lib", "pluginfile.php", "calendar", "grade", "message", "blocks", "theme", "local"];

/// A school's course site: `base` is its https origin (e.g. `https://iu.instructure.com`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Site {
    pub kind: Kind,
    pub base: Url,
}

impl Site {
    /// Only https origins: no path, query, credentials or fragment survive.
    pub fn new(kind: Kind, address: &str) -> Result<Site, LmsError> {
        let raw = address.trim();
        let raw = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
        let u = Url::parse(&raw).map_err(|_| LmsError::Other("That isn’t a web address.".into()))?;
        if u.scheme() != "https" || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() {
            return Err(LmsError::Other("Use the https address you see when you open your course site.".into()));
        }
        let mut base = Url::parse(&u.origin().ascii_serialization()).map_err(|e| LmsError::Other(e.to_string()))?;
        // Moodle is often installed under a folder (https://x.edu/moodle/), and its
        // module joins relative paths onto the base: keep the folder, cut at the first
        // part of the address that is a Moodle page rather than where it lives.
        if kind == Kind::Moodle {
            let mut dir = String::from("/");
            for seg in u.path_segments().into_iter().flatten().filter(|s| !s.is_empty()) {
                if MOODLE_PAGES.contains(&seg) || seg.ends_with(".php") {
                    break;
                }
                dir.push_str(seg);
                dir.push('/');
            }
            base.set_path(&dir);
        }
        Ok(Site { kind, base })
    }

    /// A site on a local test server (plain http allowed).
    #[cfg(test)]
    pub fn for_test(kind: Kind, base: &str) -> Site {
        Site { kind, base: Url::parse(base).expect("test base") }
    }

    /// True when `u` is on this site's origin (scheme, host and port all match).
    pub fn owns(&self, u: &Url) -> bool {
        u.origin() == self.base.origin()
    }
}

/// One cookie the login window holds for the site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cookie {
    pub name: String,
    pub value: String,
}

/// What signing in produced: the site's session, exactly as the person's own
/// sign-in left it (whatever SSO, Duo or consent pages the school puts in the
/// way), plus the site's CSRF token where it has one. No API tokens: many
/// schools turn those off or make them hard to get. Serialized only into the
/// keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub cookies: Vec<Cookie>,
    /// Canvas: the `_csrf_token` cookie, decoded. Moodle: the page's `sesskey`.
    /// Brightspace and Blackboard: their XSRF token, when a request needs one.
    pub csrf: Option<String>,
}

/// Where the login window is now, as `login_result` sees it.
pub struct LoginNav<'a> {
    pub url: &'a Url,
    pub cookies: &'a [Cookie],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    /// The site's own id, as text.
    pub id: String,
    pub name: String,
    pub code: Option<String>,
    pub term: Option<String>,
    /// Running now (current term or no end date passed), as far as the site says.
    pub current: bool,
}

/// An HTML body from the site, as the site gave it. The importer turns it into
/// Markdown and resolves its links.
pub type Html = String;

#[derive(Debug, Clone, Default)]
pub struct CourseContent {
    pub syllabus: Option<Html>,
    pub modules: Vec<Module>,
    pub pages: Vec<Page>,
    pub assignments: Vec<Assignment>,
    pub announcements: Vec<Announcement>,
    pub files: Vec<RemoteFile>,
    /// External links the course lists (module links, weblinks), not ones inside HTML.
    pub links: Vec<Link>,
    /// Parts that couldn't be read (a tab turned off, no permission), in plain words.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Module {
    pub name: String,
    /// Titles in the module's order; each names a page, assignment, file or link above.
    pub items: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Page {
    pub title: String,
    pub html: Html,
    /// The page's address on the site, so links to it from other content resolve.
    pub url: Option<Url>,
}

#[derive(Debug, Clone)]
pub struct Assignment {
    pub title: String,
    /// RFC 3339.
    pub due: Option<String>,
    pub points: Option<f64>,
    pub html: Html,
    pub url: Option<Url>,
}

#[derive(Debug, Clone)]
pub struct Announcement {
    pub title: String,
    /// RFC 3339.
    pub posted: Option<String>,
    pub html: Html,
}

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub name: String,
    /// Folder path on the site ("Lectures/Week 1"), if it has folders.
    pub folder: Option<String>,
    /// Download address on the site (fetched with the credential, so it must be on the site's origin
    /// or a redirect from it).
    pub url: Url,
    pub size: Option<u64>,
    pub mime: Option<String>,
    /// Other addresses that mean this same file (a file's preview page, its id-based link), so a
    /// link in the syllabus to any of them resolves to the downloaded copy.
    pub aliases: Vec<Url>,
}

#[derive(Debug, Clone)]
pub struct Link {
    pub title: String,
    pub url: Url,
}

// ---- Grades (each site module's `grades(session, course_id)`) ----

/// The person's own grades in one course, as far as the site shows them to
/// them. Grades the teacher hasn't released are simply absent (no score), not
/// errors. A grade book the site refuses to show is an empty one with a `note`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseGrades {
    /// The grade so far (only what's been graded counts).
    #[serde(default)]
    pub current: GradeSummary,
    /// The grade with ungraded work counted as zero, where the site gives it.
    #[serde(default, rename = "final", skip_serializing_if = "Option::is_none")]
    pub final_grade: Option<GradeSummary>,
    /// Assignment groups (categories); `weight` is set only when the course weights them.
    #[serde(default)]
    pub groups: Vec<GradeGroup>,
    #[serde(default)]
    pub items: Vec<GradeItem>,
    /// Why there's nothing to show, in plain words (the course hides its grade book).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeSummary {
    /// 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub possible: Option<f64>,
}

impl GradeSummary {
    pub fn is_empty(&self) -> bool {
        self.percent.is_none() && self.letter.is_none() && self.points.is_none()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeGroup {
    pub name: String,
    /// Share of the course grade, 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeItem {
    pub title: String,
    /// The name of its group in `CourseGrades::groups`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub possible: Option<f64>,
    /// 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// The grade as the site shows it when that isn't just the score ("A-", "complete").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grade: Option<String>,
    /// RFC 3339.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default)]
    pub submitted: bool,
    #[serde(default)]
    pub graded: bool,
    #[serde(default)]
    pub late: bool,
    #[serde(default)]
    pub missing: bool,
    #[serde(default)]
    pub excused: bool,
    /// The teacher's comments, as plain text.
    #[serde(default)]
    pub comments: Vec<String>,
}

/// `score / possible` as 0–100, when both are there and `possible` isn't zero.
pub fn percent_of(score: Option<f64>, possible: Option<f64>) -> Option<f64> {
    match (score, possible) {
        (Some(s), Some(p)) if p > 0.0 => Some((s / p * 10_000.0).round() / 100.0),
        _ => None,
    }
}

/// The note on a grade book the site refused to show.
pub const GRADES_HIDDEN: &str = "Your course site doesn’t show you grades for this course.";

/// A refused grade book (403, or no grade book at all) as an empty one with a note;
/// an ended session or an unreachable site stays an error.
pub fn grades_refused(e: LmsError) -> Result<CourseGrades, LmsError> {
    match e {
        LmsError::Forbidden(_) | LmsError::NotFound(_) | LmsError::Unsupported(_) => Ok(CourseGrades { note: Some(GRADES_HIDDEN.into()), ..Default::default() }),
        e => Err(e),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LmsError {
    /// The credential no longer works: sign in again.
    SignedOut,
    /// The site refused (the course hides this, or the person can't see it).
    Forbidden(String),
    NotFound(String),
    /// Couldn't reach the site.
    Network(String),
    /// The site doesn't offer what's needed.
    Unsupported(String),
    Other(String),
}

impl std::fmt::Display for LmsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LmsError::SignedOut => f.write_str("You’ve been signed out of your course site. Sign in again."),
            LmsError::Forbidden(s) | LmsError::NotFound(s) | LmsError::Unsupported(s) | LmsError::Other(s) => f.write_str(s),
            LmsError::Network(s) => write!(f, "Couldn’t reach your course site: {s}"),
        }
    }
}

/// A signed-in site: the only way site modules talk to the network.
pub struct Session {
    pub site: Site,
    credential: Credential,
    http: reqwest::Client,
}

/// Largest single download (a file from the site or a linked textbook).
pub const MAX_DOWNLOAD: u64 = 300 * 1024 * 1024;

impl Session {
    pub fn new(site: Site, credential: Credential) -> Session {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("Phaethon/", env!("CARGO_PKG_VERSION")))
            // Redirects are followed by hand so the credential never leaves the site.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Session { site, credential, http }
    }

    pub fn credential(&self) -> &Credential {
        &self.credential
    }

    fn cookie_header(&self) -> String {
        self.credential.cookies.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; ")
    }

    /// POST a JSON body to a path on the site with the session and the CSRF token
    /// (sent as `csrf_header`, e.g. `X-CSRF-Token`; Moodle puts its sesskey in the
    /// path instead and passes `None`). For read-only calls that a site only offers
    /// as POST (Moodle's AJAX service); never used to change anything on the site.
    pub async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path_and_query: &str,
        body: &serde_json::Value,
        csrf_header: Option<&str>,
    ) -> Result<T, LmsError> {
        let url = self.site.base.join(path_and_query).map_err(|e| LmsError::Other(e.to_string()))?;
        if !self.site.owns(&url) {
            return Err(LmsError::Other("Refused to send your sign-in to another site.".into()));
        }
        let mut req = self.http.post(url).header(reqwest::header::COOKIE, self.cookie_header()).json(body);
        if let (Some(h), Some(t)) = (csrf_header, self.credential.csrf.as_deref()) {
            req = req.header(h, t);
        }
        let res = req.send().await.map_err(|e| LmsError::Network(e.to_string()))?;
        match res.status().as_u16() {
            200..=299 => {}
            300..=399 | 401 => return Err(LmsError::SignedOut),
            403 => return Err(LmsError::Forbidden("Your course site didn’t allow this.".into())),
            404 => return Err(LmsError::NotFound("Your course site couldn’t find this.".into())),
            s => return Err(LmsError::Other(format!("Your course site answered with an error ({s})."))),
        }
        res.json::<T>().await.map_err(|e| LmsError::Other(format!("Your course site sent something unexpected: {e}")))
    }

    /// GET `url` with the credential. Refuses any address off the site's origin; follows up
    /// to 5 redirects, dropping the credential the moment one leaves the origin (a file
    /// served from a storage host). 401 → SignedOut, 403 → Forbidden, 404 → NotFound.
    pub async fn get(&self, url: &Url) -> Result<reqwest::Response, LmsError> {
        if !self.site.owns(url) {
            return Err(LmsError::Other(format!("Refused to send your sign-in to {}", url.host_str().unwrap_or("another site"))));
        }
        let mut at = url.clone();
        for _ in 0..6 {
            let mut req = self.http.get(at.clone());
            if self.site.owns(&at) {
                req = req.header(reqwest::header::COOKIE, self.cookie_header());
            }
            let res = req.send().await.map_err(|e| LmsError::Network(e.to_string()))?;
            let status = res.status();
            if status.is_redirection() {
                let Some(next) = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).and_then(|l| at.join(l).ok()) else {
                    return Err(LmsError::Other("The site sent a redirect without an address.".into()));
                };
                // (lms core, tests only: a plain-http loopback server stands in for an https storage host.)
                let test_loopback = cfg!(test) && next.host_str().is_some_and(|h| h == "127.0.0.1" || h == "localhost");
                if next.scheme() != "https" && !self.site.owns(&next) && !test_loopback {
                    return Err(LmsError::Other("The site redirected to an insecure address.".into()));
                }
                at = next;
                continue;
            }
            return match status.as_u16() {
                200..=299 => Ok(res),
                401 => Err(LmsError::SignedOut),
                403 => Err(LmsError::Forbidden("Your course site didn’t allow this.".into())),
                404 => Err(LmsError::NotFound("Your course site couldn’t find this.".into())),
                s => Err(LmsError::Other(format!("Your course site answered with an error ({s})."))),
            };
        }
        Err(LmsError::Other("Too many redirects.".into()))
    }

    /// GET a path on the site and parse JSON.
    pub async fn get_json<T: serde::de::DeserializeOwned>(&self, path_and_query: &str) -> Result<T, LmsError> {
        let url = self.site.base.join(path_and_query).map_err(|e| LmsError::Other(e.to_string()))?;
        let res = self.get(&url).await?;
        // A sign-in page instead of JSON means the session ended.
        let html = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("text/html"));
        if html {
            return Err(LmsError::SignedOut);
        }
        res.json::<T>().await.map_err(|e| LmsError::Other(format!("Your course site sent something unexpected: {e}")))
    }

    /// GET a link out of the course (a publisher's PDF, an open textbook) without any
    /// credential. https and http only, and only to the public internet: a link (or a
    /// redirect) to this computer or its local network is refused, so course content
    /// can't make Phaethon read a router page or a local service.
    pub async fn fetch_external(&self, url: &Url) -> Result<reqwest::Response, LmsError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("Phaethon/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        let mut at = url.clone();
        for _ in 0..6 {
            if !matches!(at.scheme(), "https" | "http") {
                return Err(LmsError::Other("Not a web link.".into()));
            }
            if !cfg!(test) && !reaches_only_public(&at).await {
                return Err(LmsError::Other("Not downloaded: the link points at this computer or its local network.".into()));
            }
            let res = client.get(at.clone()).send().await.map_err(|e| LmsError::Network(e.to_string()))?;
            if res.status().is_redirection() {
                let Some(next) = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).and_then(|l| at.join(l).ok()) else {
                    return Err(LmsError::Other("The link redirected without an address.".into()));
                };
                at = next;
                continue;
            }
            if !res.status().is_success() {
                return Err(LmsError::Other(format!("The link answered with an error ({}).", res.status().as_u16())));
            }
            return Ok(res);
        }
        Err(LmsError::Other("The link redirected too many times.".into()))
    }
}

/// True when every address `url`'s host resolves to is on the public internet.
async fn reaches_only_public(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let port = url.port_or_known_default().unwrap_or(443);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            let addrs: Vec<_> = addrs.collect();
            !addrs.is_empty() && addrs.iter().all(|a| is_public(a.ip()))
        }
        Err(_) => false,
    }
}

/// Not loopback, private, link-local, shared (CGNAT), unspecified, multicast or
/// documentation space, for IPv4, IPv6 and IPv4 inside IPv6.
fn is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v.segments()[0];
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

pub fn login_url(site: &Site) -> Url {
    match site.kind {
        Kind::Canvas => canvas::login_url(&site.base),
        Kind::Brightspace => brightspace::login_url(&site.base),
        Kind::Moodle => moodle::login_url(&site.base),
        Kind::Blackboard => blackboard::login_url(&site.base),
    }
}

pub fn login_result(site: &Site, nav: &LoginNav) -> Option<Credential> {
    match site.kind {
        Kind::Canvas => canvas::login_result(&site.base, nav),
        Kind::Brightspace => brightspace::login_result(&site.base, nav),
        Kind::Moodle => moodle::login_result(&site.base, nav),
        Kind::Blackboard => blackboard::login_result(&site.base, nav),
    }
}

pub async fn courses(s: &Session) -> Result<Vec<Course>, LmsError> {
    match s.site.kind {
        Kind::Canvas => canvas::courses(s).await,
        Kind::Brightspace => brightspace::courses(s).await,
        Kind::Moodle => moodle::courses(s).await,
        Kind::Blackboard => blackboard::courses(s).await,
    }
}

pub async fn content(s: &Session, course_id: &str) -> Result<CourseContent, LmsError> {
    match s.site.kind {
        Kind::Canvas => canvas::content(s, course_id).await,
        Kind::Brightspace => brightspace::content(s, course_id).await,
        Kind::Moodle => moodle::content(s, course_id).await,
        Kind::Blackboard => blackboard::content(s, course_id).await,
    }
}

/// The person's grades in one course (read-only, with their own session).
pub async fn grades(s: &Session, course_id: &str) -> Result<CourseGrades, LmsError> {
    match s.site.kind {
        Kind::Canvas => canvas::grades(s, course_id).await,
        Kind::Brightspace => brightspace::grades(s, course_id).await,
        Kind::Moodle => moodle::grades(s, course_id).await,
        Kind::Blackboard => blackboard::grades(s, course_id).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_its_https_origin_and_moodle_keeps_its_folder() {
        let c = Site::new(Kind::Canvas, "iu.instructure.com/courses/12?x=1#y").unwrap();
        assert_eq!(c.base.as_str(), "https://iu.instructure.com/");
        assert!(Site::new(Kind::Canvas, "http://iu.instructure.com").is_err());
        assert!(Site::new(Kind::Canvas, "https://me:pw@iu.instructure.com").is_err());
        for (typed, base) in [
            ("https://x.edu/moodle/my/", "https://x.edu/moodle/"),
            ("x.edu/moodle/login/index.php", "https://x.edu/moodle/"),
            ("https://x.edu/campus/moodle/course/view.php?id=3", "https://x.edu/campus/moodle/"),
            ("https://moodle.x.edu/my/courses.php", "https://moodle.x.edu/"),
            ("https://moodle.x.edu", "https://moodle.x.edu/"),
            ("https://x.edu/moodle", "https://x.edu/moodle/"),
        ] {
            assert_eq!(Site::new(Kind::Moodle, typed).unwrap().base.as_str(), base, "{typed}");
        }
        let m = Site::new(Kind::Moodle, "https://x.edu/moodle/").unwrap();
        assert_eq!(m.base.join("lib/ajax/service.php").unwrap().as_str(), "https://x.edu/moodle/lib/ajax/service.php");
        assert!(m.owns(&Url::parse("https://x.edu/other").unwrap()));
    }

    #[test]
    fn links_out_reach_only_the_public_internet() {
        for local in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1"] {
            assert!(!is_public(local.parse().unwrap()), "{local}");
        }
        for public in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }
}
