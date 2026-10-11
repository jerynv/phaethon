//! Blackboard Learn (Original and Ultra), through the person's own session.
//!
//! Learn's Ultra pages call the public REST API (`/learn/api/public/...`) from
//! the browser with nothing but the session cookies, so Phaethon does the same:
//! no REST application key, no OAuth token. Both course views use the same API.
//!
//! Which endpoints give the useful data, how paging, attachments, embedded
//! `/bbcswebdav/` files and "current" courses work, follows blackboard-mcp
//! (https://github.com/alanwtom/blackboard-mcp), MIT licence,
//! Copyright (c) 2026 alanwtom. Ported to Rust and reworked here.
//!
//! Every call is a GET. Learn checks its XSRF token (the `xsrf:` field inside
//! the `BbRouter` cookie, sent by Ultra as `X-Blackboard-XSRF`) only on calls
//! that change something, so it is kept in `Credential::csrf` but never needed.

use super::{
    Announcement, Assignment, Course, CourseContent, Credential, LmsError, Link, LoginNav, Module, Page, RemoteFile, Session,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use url::Url;

const API: &str = "/learn/api/public";
/// Stop following `paging.nextPage` after this many pages of one listing.
const MAX_PAGES: usize = 50;
/// Folders nested deeper than this aren't opened.
const MAX_DEPTH: usize = 8;
/// Content items read from one course, at most.
const MAX_ITEMS: usize = 3000;

/// Paths on the site that mean the person is still signing in (or was signed out).
const LOGIN_PATHS: &[&str] = &[
    "/webapps/login",
    "/webapps/bb-auth-provider",
    "/webapps/bb-sso",
    "/auth-saml",
    "/auth-oidc",
    "/login",
    "/ultra/session-expired",
    "/ultra/logout",
];

pub fn login_url(base: &Url) -> Url {
    // Learn sends a visitor without a session to its login page or the school's SSO.
    base.join("/").unwrap_or_else(|_| base.clone())
}

pub fn login_result(base: &Url, nav: &LoginNav) -> Option<Credential> {
    if nav.url.origin() != base.origin() {
        return None;
    }
    let path = nav.url.path().to_ascii_lowercase();
    // The root only redirects onwards; the login pages and SSO hand-offs aren't signed in yet.
    if path == "/" || LOGIN_PATHS.iter().any(|p| path.starts_with(p)) {
        return None;
    }
    let router = nav.cookies.iter().find(|c| c.name == "BbRouter" && !c.value.trim().is_empty())?;
    Some(Credential { cookies: nav.cookies.to_vec(), csrf: router_field(&router.value, "xsrf") })
}

/// A field of the `BbRouter` cookie (`expires:…,id:…,user:…,xsrf:…`), which may arrive quoted or percent-encoded.
fn router_field(value: &str, key: &str) -> Option<String> {
    let v = percent_decode(value.trim().trim_matches('"'));
    v.split(',').find_map(|kv| kv.split_once(':').filter(|(k, _)| k.trim() == key).map(|(_, x)| x.trim().to_string())).filter(|x| !x.is_empty())
}

pub async fn courses(s: &Session) -> Result<Vec<Course>, LmsError> {
    let me = whoami(s).await?;
    let memberships = paged(s, &format!("{API}/v1/users/{}/courses?expand=course&limit=100", enc(&me))).await?;
    let now = now_rfc3339();
    let mut terms: HashMap<String, Option<Value>> = HashMap::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in memberships {
        let course = match m.get("course") {
            Some(c) if c.is_object() => c.clone(),
            _ => {
                let Some(cid) = text(&m, "courseId") else { continue };
                match s.get_json::<Value>(&format!("{API}/v3/courses/{}", enc(&cid))).await {
                    Ok(c) => c,
                    Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
                    Err(_) => continue,
                }
            }
        };
        let Some(id) = text(&course, "id") else { continue };
        // Organizations (clubs, orientation sites) aren't courses.
        if course.get("organization").and_then(Value::as_bool) == Some(true) || !seen.insert(id.clone()) {
            continue;
        }
        let term = match text(&course, "termId") {
            Some(tid) => {
                if !terms.contains_key(&tid) {
                    // A student often can't read terms; the course still lists without one.
                    let t = match s.get_json::<Value>(&format!("{API}/v1/terms/{}", enc(&tid))).await {
                        Ok(t) => Some(t),
                        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
                        Err(_) => None,
                    };
                    terms.insert(tid.clone(), t);
                }
                terms[&tid].clone()
            }
            None => None,
        };
        let available = text_at(&course, &["availability", "available"]).as_deref() == Some("Yes")
            && text_at(&m, &["availability", "available"]).is_none_or(|a| a == "Yes");
        let ended = |d: Option<&Value>| d.and_then(|d| text(d, "end")).is_some_and(|end| end.get(..19).unwrap_or(&end) < &now[..19]);
        let course_dur = course.get("availability").and_then(|a| a.get("duration"));
        let term_dur = term.as_ref().and_then(|t| t.get("availability")).and_then(|a| a.get("duration"));
        out.push(Course {
            name: text(&course, "name").unwrap_or_else(|| id.clone()),
            code: text(&course, "courseId"),
            term: term.as_ref().and_then(|t| text(t, "name")),
            current: available && !ended(course_dur) && !ended(term_dur),
            id,
        });
    }
    out.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub async fn content(s: &Session, course_id: &str) -> Result<CourseContent, LmsError> {
    // A refusal here (or a login page) means the session ended, not that the course hides something.
    whoami(s).await?;
    let cid = enc(course_id);
    let mut out = CourseContent::default();

    // Gradebook columns give due dates and points; a course may hide them from students.
    let mut columns = Vec::new();
    match paged(s, &format!("{API}/v2/courses/{cid}/gradebook/columns?limit=100")).await {
        Ok(c) => columns = c,
        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
        Err(e) => out.skipped.push(format!("Due dates from the grade book ({})", plain(&e))),
    }
    let by_content: HashMap<String, &Value> = columns.iter().filter_map(|c| Some((text(c, "contentId")?, c))).collect();

    // Walk the content tree, folders breadth-first so the order follows the course outline.
    let mut items: Vec<Item> = Vec::new();
    let roots = paged(s, &format!("{API}/v1/courses/{cid}/contents?limit=200")).await?;
    let mut queue: VecDeque<(Vec<Value>, Vec<String>, usize)> = VecDeque::from([(roots, Vec::new(), 0)]);
    let mut truncated = false;
    while let Some((list, path, depth)) = queue.pop_front() {
        for v in list {
            if items.len() >= MAX_ITEMS {
                truncated = true;
                break;
            }
            let Some(id) = text(&v, "id") else { continue };
            let title = text(&v, "title").unwrap_or_else(|| "Untitled".into());
            let handler = text_at(&v, &["contentHandler", "id"]).unwrap_or_default();
            let container = is_container(&handler);
            let has_children = v.get("hasChildren").and_then(Value::as_bool).unwrap_or(container);
            if container && has_children {
                if depth + 1 > MAX_DEPTH {
                    truncated = true;
                } else {
                    match paged(s, &format!("{API}/v1/courses/{cid}/contents/{}/children?limit=200", enc(&id))).await {
                        Ok(children) => {
                            let mut p = path.clone();
                            p.push(title.replace('/', "-"));
                            queue.push_back((children, p, depth + 1));
                        }
                        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
                        Err(e) => out.skipped.push(format!("The folder “{title}” ({})", plain(&e))),
                    }
                }
            }
            items.push(Item { id, parent: text(&v, "parentId"), title, handler, path: path.clone(), raw: v });
        }
    }
    if truncated {
        out.skipped.push("Part of the course content (it is nested too deeply or is too large to read in full)".into());
    }

    let base = s.site.base.clone();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut assigned: HashSet<String> = HashSet::new();
    let mut modules: Vec<Module> = Vec::new();
    let mut module_of: HashMap<String, usize> = HashMap::new();
    let mut loose = Module { name: "Course content".into(), items: Vec::new() };

    for it in &items {
        let body = fix_body(&base, &it.body());
        let folder = (!it.path.is_empty()).then(|| it.path.join("/"));
        let mut entries: Vec<String> = Vec::new();
        let files_before = out.files.len();
        let page_url = item_url(&base, course_id, &it.id);

        if is_container(&it.handler) {
            module_of.insert(it.id.clone(), modules.len());
            let name = it.path.iter().chain(std::iter::once(&it.title)).cloned().collect::<Vec<_>>().join(" / ");
            modules.push(Module { name, items: Vec::new() });
            if !body.trim().is_empty() {
                out.pages.push(Page { title: it.title.clone(), html: body.clone(), url: Some(page_url.clone()) });
            }
        } else if it.handler == "resource/x-bb-externallink" {
            let target = text_at(&it.raw, &["contentHandler", "url"]).and_then(|u| Url::parse(&u).ok());
            if let Some(url) = target {
                out.links.push(Link { title: it.title.clone(), url });
            }
            if !body.trim().is_empty() {
                out.pages.push(Page { title: it.title.clone(), html: body.clone(), url: Some(page_url.clone()) });
            }
            entries.push(it.title.clone());
        } else if is_gradable(&it.handler) || by_content.contains_key(&it.id) {
            let col = by_content.get(&it.id);
            assigned.insert(it.id.clone());
            out.assignments.push(Assignment {
                title: it.title.clone(),
                due: col.and_then(|c| text_at(c, &["grading", "due"])),
                points: col.and_then(|c| c.get("score")).and_then(|sc| sc.get("possible")).and_then(Value::as_f64),
                html: body.clone(),
                url: Some(page_url.clone()),
            });
            entries.push(it.title.clone());
        } else if it.handler != "resource/x-bb-file" && !body.trim().is_empty() {
            // Documents, blank pages, the Original syllabus tool and anything else that carries text.
            out.pages.push(Page { title: it.title.clone(), html: body.clone(), url: Some(page_url.clone()) });
            entries.push(it.title.clone());
        } else if it.handler != "resource/x-bb-file" {
            // A tool link (test, discussion, LTI tool) with nothing to save: named in the outline only.
            entries.push(it.title.clone());
        }

        // Files attached to the item (an uploaded file, a document's attachments, an assignment's handout).
        if has_attachments(&it.handler) {
            let path = format!("{API}/v1/courses/{}/contents/{}/attachments", enc(course_id), enc(&it.id));
            match paged(s, &path).await {
                Ok(list) => {
                    for a in list {
                        let Some(aid) = text(&a, "id") else { continue };
                        let name = text(&a, "fileName").or_else(|| text_at(&it.raw, &["contentHandler", "file", "fileName"])).unwrap_or_else(|| it.title.clone());
                        let Ok(url) = base.join(&format!("{path}/{}/download", enc(&aid))) else { continue };
                        if !seen_files.insert(url.to_string()) {
                            continue;
                        }
                        let mut aliases: Vec<Url> = Vec::new();
                        aliases.extend(base.join(&format!("{path}/{}", enc(&aid))).ok());
                        aliases.extend(nautilus(&base, course_id, &it.id, it.parent.as_deref()));
                        entries.push(name.clone());
                        out.files.push(RemoteFile { name, folder: folder.clone(), url, size: None, mime: text(&a, "mimeType"), aliases });
                    }
                }
                Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
                Err(LmsError::NotFound(_)) => {}
                Err(e) => out.skipped.push(format!("The files in “{}” ({})", it.title, plain(&e))),
            }
        }

        // Files embedded in the item's text by Learn's editor (`/bbcswebdav/...`).
        for (url, name) in webdav_links(&base, &body) {
            if seen_files.insert(url.to_string()) {
                out.files.push(RemoteFile { name, folder: folder.clone(), url, size: None, mime: None, aliases: Vec::new() });
            }
        }

        // Syllabus: Learn has no single syllabus field; it's an item titled so (or the Original syllabus tool).
        if out.syllabus.is_none() && (it.handler == "resource/x-bb-syllabus" || it.title.to_lowercase().contains("syllabus")) {
            let files: String = out
                .files[files_before..]
                .iter()
                .map(|f| format!("<p><a href=\"{}\">{}</a></p>", f.url, escape(&f.name)))
                .collect();
            if !body.trim().is_empty() || !files.is_empty() {
                out.syllabus = Some(format!("{body}{files}"));
            }
        }

        let module = it.parent.as_ref().and_then(|p| module_of.get(p)).copied();
        match module {
            Some(i) => modules[i].items.extend(entries),
            None => loose.items.extend(entries),
        }
    }
    if !loose.items.is_empty() {
        modules.insert(0, loose);
    }
    out.modules = modules;

    // Grade book columns that aren't course items (an in-class exam, a participation grade) still have due dates.
    for c in &columns {
        if text(c, "contentId").is_some_and(|id| assigned.contains(&id)) || text_at(c, &["grading", "type"]).as_deref() == Some("Calculated") {
            continue;
        }
        let Some(due) = text_at(c, &["grading", "due"]) else { continue };
        out.assignments.push(Assignment {
            title: text(c, "name").unwrap_or_else(|| "Untitled".into()),
            due: Some(due),
            points: c.get("score").and_then(|sc| sc.get("possible")).and_then(Value::as_f64),
            html: text(c, "description").unwrap_or_default(),
            url: None,
        });
    }

    match paged(s, &format!("{API}/v1/courses/{cid}/announcements?limit=100")).await {
        Ok(list) => {
            for a in list {
                out.announcements.push(Announcement {
                    title: text(&a, "title").unwrap_or_else(|| "Announcement".into()),
                    posted: text_at(&a, &["availability", "duration", "start"]).or_else(|| text(&a, "created")),
                    html: fix_body(&base, &text(&a, "body").unwrap_or_default()),
                });
            }
            out.announcements.sort_by(|a, b| b.posted.cmp(&a.posted));
        }
        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
        Err(e) => out.skipped.push(format!("Announcements ({})", plain(&e))),
    }
    Ok(out)
}

struct Item {
    id: String,
    parent: Option<String>,
    title: String,
    handler: String,
    /// Titles of the folders it sits in, outermost first.
    path: Vec<String>,
    raw: Value,
}

impl Item {
    fn body(&self) -> String {
        let b = text(&self.raw, "body").unwrap_or_default();
        if b.trim().is_empty() { text(&self.raw, "description").unwrap_or_default() } else { b }
    }
}

/// Folders, learning modules and lesson plans: they hold other items.
fn is_container(handler: &str) -> bool {
    matches!(
        handler,
        "resource/x-bb-folder" | "resource/x-bb-lesson" | "resource/x-bb-learnmodule" | "resource/x-bb-module-page" | "resource/x-bb-lessonplan"
    )
}

/// Items the grade book tracks: assignments, tests and surveys.
fn is_gradable(handler: &str) -> bool {
    matches!(handler, "resource/x-bb-assignment" | "resource/x-bb-asmt-test-link" | "resource/x-bb-asmt-survey-link")
}

fn has_attachments(handler: &str) -> bool {
    matches!(handler, "resource/x-bb-file" | "resource/x-bb-document" | "resource/x-bb-assignment" | "resource/x-bb-syllabus")
}

/// The person's user id. 401/403 or a login page from this call: signed out.
async fn whoami(s: &Session) -> Result<String, LmsError> {
    let me: Value = s.get_json(&format!("{API}/v1/users/me")).await.map_err(|e| match e {
        LmsError::Forbidden(_) | LmsError::NotFound(_) => LmsError::SignedOut,
        e => e,
    })?;
    text(&me, "id").ok_or(LmsError::SignedOut)
}

/// Every result of a listing, following `paging.nextPage` (a path on the site).
async fn paged(s: &Session, first: &str) -> Result<Vec<Value>, LmsError> {
    let mut out = Vec::new();
    let mut next = Some(first.to_string());
    let mut pages = 0;
    while let Some(path) = next.take() {
        let v: Value = s.get_json(&path).await?;
        match &v {
            Value::Array(a) => out.extend(a.iter().cloned()),
            _ => out.extend(v.get("results").and_then(Value::as_array).into_iter().flatten().cloned()),
        }
        pages += 1;
        // Only follow a next page that stays on the site (`get_json` would refuse anything else anyway).
        next = text_at(&v, &["paging", "nextPage"]).filter(|n| pages < MAX_PAGES && s.site.base.join(n).is_ok_and(|u| s.site.owns(&u)));
    }
    Ok(out)
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string).filter(|x| !x.is_empty())
}

fn text_at(v: &Value, keys: &[&str]) -> Option<String> {
    let mut at = v;
    for k in keys {
        at = at.get(k)?;
    }
    at.as_str().map(str::to_string).filter(|x| !x.is_empty())
}

/// The item as the person sees it on the site (the Ultra outline opens it; Original redirects there too).
fn item_url(base: &Url, course: &str, content: &str) -> Url {
    base.join(&format!("/ultra/courses/{}/outline/edit/document/{}?courseId={}", enc(course), enc(content), enc(course))).unwrap_or_else(|_| base.clone())
}

/// The address Ultra uses to open a file item; it redirects to the file.
fn nautilus(base: &Url, course: &str, content: &str, parent: Option<&str>) -> Option<Url> {
    let mut u = base.join("/ultra/redirect").ok()?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("redirectType", "nautilus").append_pair("courseId", course).append_pair("contentId", content);
        if let Some(p) = parent {
            q.append_pair("parentId", p);
        }
    }
    Some(u)
}

/// Learn's editor stores embedded files with a placeholder instead of the site address.
fn fix_body(base: &Url, html: &str) -> String {
    let root = base.as_str().trim_end_matches('/');
    html.replace("@X@EmbeddedFile.requestUrlStub@X@", &format!("{root}/")).replace("@X@EmbeddedFile.location@X@", &format!("{root}/"))
}

/// `/bbcswebdav/` files linked or embedded in an HTML body, with the name the editor gave them.
fn webdav_links(base: &Url, html: &str) -> Vec<(Url, String)> {
    let mut out: Vec<(Url, String)> = Vec::new();
    for attr in ["href=\"", "src=\"", "href='", "src='"] {
        let quote = attr.chars().last().unwrap_or('"');
        let mut rest = html;
        while let Some(i) = rest.find(attr) {
            let after = &rest[i + attr.len()..];
            let Some(end) = after.find(quote) else { break };
            let raw = after[..end].replace("&amp;", "&");
            rest = &after[end..];
            if !raw.contains("/bbcswebdav/") {
                continue;
            }
            let Ok(url) = base.join(&raw) else { continue };
            if url.origin() != base.origin() || out.iter().any(|(u, _)| *u == url) {
                continue;
            }
            // The link's own words name the file when they look like a file name ("Week 1 slides.pdf").
            let text = attr.starts_with("href").then(|| anchor_text(rest)).flatten().filter(|t| t.contains('.') && t.len() < 200);
            let last = url.path_segments().and_then(|mut s| s.next_back()).map(percent_decode).unwrap_or_default();
            let name = text.unwrap_or(if last.is_empty() { "file".into() } else { last });
            out.push((url, name));
        }
    }
    out
}

/// The words inside an `<a>` tag, given the HTML just after its `href` value.
fn anchor_text(after_href: &str) -> Option<String> {
    let start = after_href.find('>')? + 1;
    let end = after_href[start..].find("</a")? + start;
    let mut t = String::new();
    let mut in_tag = false;
    for c in after_href[start..end].chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => t.push(c),
            _ => {}
        }
    }
    let t = t.replace("&amp;", "&").replace("&nbsp;", " ");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then_some(t)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn plain(e: &LmsError) -> String {
    match e {
        LmsError::Forbidden(_) => "the course site didn’t allow reading it".into(),
        LmsError::NotFound(_) => "the course site couldn’t find it".into(),
        e => e.to_string(),
    }
}

/// One path segment: Learn ids (`_123_1`) pass as they are; anything else is percent-encoded.
fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(x) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(x);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Now in UTC as `YYYY-MM-DDTHH:MM:SSZ`, to compare with Learn's dates (also UTC, `Z`).
fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    rfc3339(secs)
}

fn rfc3339(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    //! Against a local fake Learn serving fixtures shaped like Learn's replies (`tests/fixtures/blackboard`).

    use super::*;
    use crate::lms::{Cookie, Kind, Site};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/blackboard/", $name, ".json"))
        };
    }

    #[derive(Clone)]
    struct Reply {
        status: &'static str,
        headers: String,
        body: Vec<u8>,
    }

    fn json(body: &str) -> Reply {
        Reply { status: "200 OK", headers: "content-type: application/json; charset=UTF-8\r\n".into(), body: body.as_bytes().to_vec() }
    }

    fn status(s: &'static str) -> Reply {
        Reply { status: s, headers: "content-type: application/json\r\n".into(), body: br#"{"status":0,"message":"no"}"#.to_vec() }
    }

    fn login_page() -> Reply {
        Reply {
            status: "200 OK",
            headers: "content-type: text/html;charset=UTF-8\r\n".into(),
            body: b"<!doctype html><title>Login</title><form action=\"/webapps/login/\" method=\"post\"></form>".to_vec(),
        }
    }

    fn redirect(to: &str) -> Reply {
        Reply { status: "302 Found", headers: format!("location: {to}\r\n"), body: Vec::new() }
    }

    type Log = Arc<Mutex<Vec<(String, Option<String>)>>>;

    /// Serve `routes` (exact path and query → reply; anything else 404) until the test ends,
    /// logging each request's path and Cookie header.
    async fn fake_learn(routes: Vec<(&str, Reply)>) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes: Arc<HashMap<String, Reply>> = Arc::new(routes.into_iter().map(|(p, r)| (p.to_string(), r)).collect());
        let log: Log = Arc::default();
        let log2 = log.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let routes = routes.clone();
                let log = log2.clone();
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
                    let method_ok = head.starts_with("GET ");
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let cookie = head.lines().find_map(|l| l.strip_prefix("cookie: ").or_else(|| l.strip_prefix("Cookie: ")).map(str::to_string));
                    log.lock().unwrap().push((if method_ok { path.clone() } else { format!("NOT GET {path}") }, cookie));
                    let r = routes.get(&path).cloned().unwrap_or_else(|| status("404 Not Found"));
                    let head = format!("HTTP/1.1 {}\r\n{}content-length: {}\r\nconnection: close\r\n\r\n", r.status, r.headers, r.body.len());
                    sock.write_all(head.as_bytes()).await.ok();
                    sock.write_all(&r.body).await.ok();
                    sock.shutdown().await.ok();
                });
            }
        });
        (base, log)
    }

    const ROUTER: &str = "expires:1760000000,id:ABC,signature:sig,site:s1,timeout:10800,user:4711,v:2,xsrf:tok-123";

    fn session(base: &str) -> Session {
        let cookies = vec![Cookie { name: "BbRouter".into(), value: ROUTER.into() }, Cookie { name: "JSESSIONID".into(), value: "J1".into() }];
        Session::new(Site::for_test(Kind::Blackboard, base), Credential { cookies, csrf: Some("tok-123".into()) })
    }

    const ME: &str = "/learn/api/public/v1/users/me";
    const C: &str = "/learn/api/public/v1/courses/_100_1";

    fn course_routes() -> Vec<(&'static str, Reply)> {
        vec![
            (ME, json(fixture!("users_me"))),
            ("/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100", json(fixture!("gradebook_columns"))),
            ("/learn/api/public/v1/courses/_100_1/contents?limit=200", json(fixture!("contents_root"))),
            ("/learn/api/public/v1/courses/_100_1/contents?limit=200&offset=3", json(fixture!("contents_root_2"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_1_1/children?limit=200", json(fixture!("children_week1"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_6_1/children?limit=200", json(fixture!("children_readings"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_2_1/attachments", json(fixture!("attachments_syllabus"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_5_1/attachments", json(fixture!("attachments_notes"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_9_1/attachments", json(fixture!("attachments_ch1"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_7_1/attachments", json(fixture!("attachments_empty"))),
            ("/learn/api/public/v1/courses/_100_1/contents/_4_1/attachments", json(fixture!("attachments_empty"))),
            ("/learn/api/public/v1/courses/_100_1/announcements?limit=100", json(fixture!("announcements"))),
            (
                "/learn/api/public/v1/courses/_100_1/contents/_9_1/attachments/_503_1/download",
                redirect("/bbcswebdav/pid-9-dt-content-rid-503_1/xid-503_1"),
            ),
            (
                "/bbcswebdav/pid-9-dt-content-rid-503_1/xid-503_1",
                Reply { status: "200 OK", headers: "content-type: application/pdf\r\n".into(), body: b"%PDF-1.7 chapter one".to_vec() },
            ),
        ]
    }

    #[test]
    fn login_url_is_the_site_root() {
        let base = Url::parse("https://learn.example.edu").unwrap();
        assert_eq!(login_url(&base).as_str(), "https://learn.example.edu/");
    }

    #[test]
    fn signed_in_only_on_the_site_past_login_with_a_bbrouter_cookie() {
        let base = Url::parse("https://learn.example.edu").unwrap();
        let router = Cookie { name: "BbRouter".into(), value: "\"expires%3A1760000000%2Cid%3AABC%2Cuser%3A4711%2Cxsrf%3Axyz-789\"".into() };
        let jsession = Cookie { name: "JSESSIONID".into(), value: "J1".into() };
        let at = |u: &str, cookies: &[Cookie]| {
            let url = Url::parse(u).unwrap();
            login_result(&base, &LoginNav { url: &url, cookies })
        };
        let both = [router.clone(), jsession.clone()];
        // Still signing in: the login form, the SSO hand-offs, the bare root, other origins.
        assert_eq!(at("https://learn.example.edu/webapps/login/?action=relogin", &both), None);
        assert_eq!(at("https://learn.example.edu/auth-saml/saml/login?apId=_1_1", &both), None);
        assert_eq!(at("https://learn.example.edu/webapps/bb-auth-provider-shibboleth-BBLEARN/execute/shibbolethLogin", &both), None);
        assert_eq!(at("https://learn.example.edu/", &both), None);
        assert_eq!(at("https://idp.example.edu/idp/profile/SAML2/Redirect/SSO", &both), None);
        assert_eq!(at("https://learn.example.edu.evil.test/ultra/course", &both), None);
        assert_eq!(at("http://learn.example.edu/ultra/course", &both), None);
        assert_eq!(at("https://learn.example.edu/ultra/session-expired", &both), None);
        // On the site but no session cookie yet.
        assert_eq!(at("https://learn.example.edu/ultra/course", std::slice::from_ref(&jsession)), None);
        assert_eq!(at("https://learn.example.edu/ultra/course", &[Cookie { name: "BbRouter".into(), value: " ".into() }]), None);
        // Ultra and Original landing pages: signed in, every site cookie kept, the xsrf read out of BbRouter.
        for u in ["https://learn.example.edu/ultra/course", "https://learn.example.edu/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"] {
            let c = at(u, &both).expect("signed in");
            assert_eq!(c.cookies, both.to_vec());
            assert_eq!(c.csrf.as_deref(), Some("xyz-789"));
        }
        // A BbRouter without an xsrf field still signs in.
        let plain = [Cookie { name: "BbRouter".into(), value: "expires:1,id:A,user:4711".into() }];
        assert_eq!(at("https://learn.example.edu/ultra/stream", &plain).unwrap().csrf, None);
    }

    #[tokio::test]
    async fn lists_courses_across_pages_with_terms() {
        let (base, log) = fake_learn(vec![
            (ME, json(fixture!("users_me"))),
            ("/learn/api/public/v1/users/_4711_1/courses?expand=course&limit=100", json(fixture!("memberships_1"))),
            ("/learn/api/public/v1/users/_4711_1/courses?expand=course&limit=100&offset=100", json(fixture!("memberships_2"))),
            ("/learn/api/public/v3/courses/_102_1", json(fixture!("course_102_v3"))),
            ("/learn/api/public/v1/terms/_10_1", json(fixture!("term_fall"))),
            ("/learn/api/public/v1/terms/_9_1", json(fixture!("term_spring"))),
        ])
        .await;
        let got = courses(&session(&base)).await.unwrap();
        let summary: Vec<_> = got.iter().map(|c| (c.id.as_str(), c.name.as_str(), c.code.as_deref(), c.term.as_deref(), c.current)).collect();
        assert_eq!(
            summary,
            vec![
                ("_100_1", "Calculus II", Some("MATH-M212-FA26"), Some("Fall 2026"), true),
                // The membership came without the course: read on its own; its own dates run to 2099.
                ("_102_1", "Discrete Structures", Some("CSCI-C241-FA26"), None, true),
                // Hidden by the instructor.
                ("_103_1", "American History", Some("HIST-H105-FA26"), None, false),
                // Its term ended.
                ("_101_1", "Introductory Psychology", Some("PSY-P101-SP26"), Some("Spring 2026"), false),
            ]
        );
        // The organization is left out, each term is read once, every call is a GET carrying the session.
        assert!(!got.iter().any(|c| c.id == "_200_1"));
        let log = log.lock().unwrap();
        assert_eq!(log.iter().filter(|(p, _)| p == "/learn/api/public/v1/terms/_10_1").count(), 1);
        let cookie = format!("BbRouter={ROUTER}; JSESSIONID=J1");
        assert!(log.iter().all(|(p, c)| p.starts_with('/') && c.as_deref() == Some(cookie.as_str())), "{log:?}");
    }

    #[tokio::test]
    async fn reads_a_whole_course() {
        let (base, log) = fake_learn(course_routes()).await;
        let s = session(&base);
        let got = content(&s, "_100_1").await.unwrap();
        let b = |p: &str| format!("{base}{p}");

        // Syllabus: the item titled so, with its attached PDF linked to its download.
        let syl = got.syllabus.as_deref().unwrap();
        assert!(syl.contains("ISBN 978-1-947172-14-2"), "{syl}");
        let pdf = b(&format!("{C}/contents/_2_1/attachments/_501_1/download"));
        assert!(syl.contains(&format!("<a href=\"{pdf}\">M212 syllabus.pdf</a>")), "{syl}");

        // Modules follow the outline: loose items first, then folders and nested lessons by path.
        let modules: Vec<_> = got.modules.iter().map(|m| (m.name.as_str(), m.items.iter().map(String::as_str).collect::<Vec<_>>())).collect();
        assert_eq!(
            modules,
            vec![
                ("Course content", vec!["Syllabus", "M212 syllabus.pdf", "OpenStax Calculus", "Homework 1", "lecture-notes.pdf", "Course tools"]),
                ("Week 1", vec!["Welcome", "Quiz 1"]),
                ("Week 1 / Readings", vec!["chapter1.pdf"]),
            ]
        );

        // Pages: the folder's own text, the syllabus and the welcome document, embedded-file stubs resolved.
        let titles: Vec<_> = got.pages.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, vec!["Week 1", "Syllabus", "Welcome"]);
        let welcome = &got.pages[2];
        assert!(welcome.html.contains(&format!("src=\"{base}/bbcswebdav/xid-78_1\"")), "{}", welcome.html);
        assert_eq!(welcome.url.as_ref().unwrap().as_str(), b("/ultra/courses/_100_1/outline/edit/document/_7_1?courseId=_100_1"));

        // Assignments: course items with grade book due dates, then grade-book-only columns; totals and undated columns left out.
        let a: Vec<_> = got.assignments.iter().map(|a| (a.title.as_str(), a.due.as_deref(), a.points)).collect();
        assert_eq!(
            a,
            vec![
                ("Homework 1", Some("2026-10-20T03:59:00.000Z"), Some(10.0)),
                ("Quiz 1", Some("2026-10-15T03:59:00.000Z"), Some(20.0)),
                ("Midterm exam", Some("2026-10-28T16:00:00.000Z"), Some(100.0)),
            ]
        );
        assert!(got.assignments[0].html.contains("Problems 1.1"));
        assert!(got.assignments[2].html.contains("calculator") && got.assignments[2].url.is_none());

        // Files: attachments with their folders, download addresses and aliases; embedded webdav files from bodies.
        let files: Vec<_> = got.files.iter().map(|f| (f.name.as_str(), f.folder.as_deref(), f.url.to_string())).collect();
        assert_eq!(
            files,
            vec![
                ("M212 syllabus.pdf", None, pdf.clone()),
                ("lecture-notes.pdf", None, b(&format!("{C}/contents/_5_1/attachments/_502_1/download"))),
                ("Week 1 slides.pdf", Some("Week 1"), b("/bbcswebdav/pid-7-dt-content-rid-77_1/xid-77_1")),
                ("xid-78_1", Some("Week 1"), b("/bbcswebdav/xid-78_1")),
                ("chapter1.pdf", Some("Week 1/Readings"), b(&format!("{C}/contents/_9_1/attachments/_503_1/download"))),
            ]
        );
        let ch1 = &got.files[4];
        assert_eq!(ch1.mime.as_deref(), Some("application/pdf"));
        let aliases: Vec<_> = ch1.aliases.iter().map(Url::to_string).collect();
        assert_eq!(
            aliases,
            vec![b(&format!("{C}/contents/_9_1/attachments/_503_1")), b("/ultra/redirect?redirectType=nautilus&courseId=_100_1&contentId=_9_1&parentId=_6_1")]
        );

        // External links the course lists; the LTI tool isn't one.
        let links: Vec<_> = got.links.iter().map(|l| (l.title.as_str(), l.url.as_str())).collect();
        assert_eq!(links, vec![("OpenStax Calculus", "https://openstax.org/books/calculus-volume-2/pages/1-introduction")]);

        // Announcements, newest first, by when they were shown.
        let ann: Vec<_> = got.announcements.iter().map(|a| (a.title.as_str(), a.posted.as_deref())).collect();
        assert_eq!(ann, vec![("Office hours moved", Some("2026-10-05T13:00:00.000Z")), ("Welcome to Calculus II", Some("2026-08-20T12:00:00.000Z"))]);
        assert!(got.announcements[0].html.contains(&format!("href=\"{base}/bbcswebdav/xid-90_1\"")));
        assert!(got.skipped.is_empty(), "{:?}", got.skipped);

        // A download follows Learn's redirect to the file, still with the session; nothing but GETs reached the site.
        let res = s.get(&ch1.url).await.unwrap();
        assert_eq!(res.bytes().await.unwrap().as_ref(), b"%PDF-1.7 chapter one");
        let log = log.lock().unwrap();
        assert!(log.iter().any(|(p, c)| p.starts_with("/bbcswebdav/pid-9") && c.is_some()));
        assert!(log.iter().all(|(p, _)| p.starts_with('/')), "{log:?}");
    }

    #[tokio::test]
    async fn parts_a_course_hides_are_skipped_in_plain_words() {
        let mut routes = course_routes();
        routes.retain(|(p, _)| !p.contains("gradebook") && !p.contains("announcements") && !p.contains("_6_1/children"));
        routes.push(("/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100", status("403 Forbidden")));
        routes.push(("/learn/api/public/v1/courses/_100_1/announcements?limit=100", status("403 Forbidden")));
        routes.push(("/learn/api/public/v1/courses/_100_1/contents/_6_1/children?limit=200", status("403 Forbidden")));
        let (base, _) = fake_learn(routes).await;
        let got = content(&session(&base), "_100_1").await.unwrap();
        assert_eq!(
            got.skipped,
            vec![
                "Due dates from the grade book (the course site didn’t allow reading it)",
                "The folder “Readings” (the course site didn’t allow reading it)",
                "Announcements (the course site didn’t allow reading it)",
            ]
        );
        assert!(got.announcements.is_empty());
        // Assignments still come from the course items, without due dates.
        let a: Vec<_> = got.assignments.iter().map(|a| (a.title.as_str(), a.due.is_none())).collect();
        assert_eq!(a, vec![("Homework 1", true), ("Quiz 1", true)]);
    }

    #[tokio::test]
    async fn an_ended_session_is_signed_out() {
        for me in [status("401 Unauthorized"), status("403 Forbidden"), login_page(), redirect("/webapps/login/?new_loc=%2Fultra")] {
            let (base, _) = fake_learn(vec![(ME, me), ("/webapps/login/?new_loc=%2Fultra", login_page())]).await;
            assert_eq!(courses(&session(&base)).await.unwrap_err(), LmsError::SignedOut);
            assert_eq!(content(&session(&base), "_100_1").await.unwrap_err(), LmsError::SignedOut);
        }
        // Signed out partway through a course (the session timed out between calls).
        let mut routes = course_routes();
        routes.retain(|(p, _)| !p.contains("_1_1/children"));
        routes.push(("/learn/api/public/v1/courses/_100_1/contents/_1_1/children?limit=200", status("401 Unauthorized")));
        let (base, _) = fake_learn(routes).await;
        assert_eq!(content(&session(&base), "_100_1").await.unwrap_err(), LmsError::SignedOut);
    }

    #[test]
    fn helpers() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_791_590_400), "2026-10-10T00:00:00Z");
        assert_eq!(rfc3339(951_782_400 + 3661), "2000-02-29T01:01:01Z");
        assert_eq!(enc("_100_1"), "_100_1");
        assert_eq!(enc("a/b c"), "a%2Fb%20c");
        assert_eq!(percent_decode("a%3Ab%2"), "a:b%2");
        assert_eq!(router_field("user:1,xsrf:", "xsrf"), None);
    }
}
