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
        let base = Url::parse(&u.origin().ascii_serialization()).map_err(|e| LmsError::Other(e.to_string()))?;
        Ok(Site { kind, base })
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

/// What signing in produced. Serialized only into the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Credential {
    /// The site's session cookies (Canvas, Brightspace, Blackboard).
    Cookies { cookies: Vec<Cookie> },
    /// A web service token (Moodle's mobile-app launch flow).
    Token { token: String },
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LmsError {
    /// The credential no longer works: sign in again.
    SignedOut,
    /// The site refused (the course hides this, or the person can't see it).
    Forbidden(String),
    NotFound(String),
    /// Couldn't reach the site.
    Network(String),
    /// The site doesn't offer what's needed (e.g. Moodle with mobile services turned off).
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
                req = match &self.credential {
                    Credential::Cookies { cookies } => {
                        let header = cookies.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; ");
                        req.header(reqwest::header::COOKIE, header)
                    }
                    // Moodle's token travels as a query parameter its module adds itself.
                    Credential::Token { .. } => req,
                };
            }
            let res = req.send().await.map_err(|e| LmsError::Network(e.to_string()))?;
            let status = res.status();
            if status.is_redirection() {
                let Some(next) = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).and_then(|l| at.join(l).ok()) else {
                    return Err(LmsError::Other("The site sent a redirect without an address.".into()));
                };
                if next.scheme() != "https" {
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
    /// credential. https and http only.
    pub async fn fetch_external(&self, url: &Url) -> Result<reqwest::Response, LmsError> {
        if !matches!(url.scheme(), "https" | "http") {
            return Err(LmsError::Other("Not a web link.".into()));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("Phaethon/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("http client");
        let res = client.get(url.clone()).send().await.map_err(|e| LmsError::Network(e.to_string()))?;
        if !res.status().is_success() {
            return Err(LmsError::Other(format!("The link answered with an error ({}).", res.status().as_u16())));
        }
        Ok(res)
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
