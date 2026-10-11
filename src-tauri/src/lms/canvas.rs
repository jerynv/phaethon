//! Canvas. The person signs in on the school's own login page; Phaethon then
//! reads the Canvas REST API (`/api/v1`) with the session that sign-in left,
//! the way Canvas's own web pages do. GETs only: nothing on the site changes.
//!
//! Which endpoints carry the useful data, their parameters and their shapes
//! follow two Canvas MCP servers, ported to Rust and from API tokens to the
//! person's session:
//! - canvas-mcp, https://github.com/vishalsachdev/canvas-mcp, MIT License,
//!   Copyright (c) 2025 Vishal Sachdev
//! - canvas-mcp, https://github.com/r-huijts/canvas-mcp, MIT License,
//!   Copyright (c) 2024 R.Huijts
//!
//! Grades (`grades`) follow the Canvas REST API docs (enrollments, submissions,
//! assignment groups) and the grade tools of vishalsachdev/canvas-mcp above.

use super::{
    Announcement, Assignment, Course, CourseContent, CourseGrades, Credential, GradeGroup, GradeItem, GradeSummary, Link, LmsError, LoginNav, Module, Page,
    RemoteFile, Session,
};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use url::Url;

/// Canvas's session cookie (older and self-hosted sites use the second name).
const SESSION_COOKIES: [&str; 2] = ["_normandy_session", "canvas_session"];
/// Pages of results followed for one list, at 100 a page.
const MAX_PAGES: usize = 100;
/// Files fetched one by one because a module or a link names them.
const MAX_REFERENCED: usize = 300;

pub fn login_url(base: &Url) -> Url {
    base.join("/login").unwrap_or_else(|_| base.clone())
}

/// Signed in once the window is back on the site, past the login pages, holding
/// Canvas's session cookie. (The cookie alone isn't enough: Canvas sets it on the
/// login page too.)
pub fn login_result(base: &Url, nav: &LoginNav) -> Option<Credential> {
    if nav.url.origin() != base.origin() {
        return None;
    }
    let path = nav.url.path();
    if ["/login", "/logout", "/register"].iter().any(|p| path.starts_with(p)) {
        return None;
    }
    if !nav.cookies.iter().any(|c| SESSION_COOKIES.contains(&c.name.as_str()) && !c.value.is_empty()) {
        return None;
    }
    let csrf = nav.cookies.iter().find(|c| c.name == "_csrf_token").map(|c| percent_decode(&c.value)).filter(|t| !t.is_empty());
    Some(Credential { cookies: nav.cookies.to_vec(), csrf })
}

/// The person's courses: those running now, then past ones (concluded enrollments).
pub async fn courses(s: &Session) -> Result<Vec<Course>, LmsError> {
    let now = now_secs();
    let list = |state: &'static str| api(s, &["courses"], &[("enrollment_state", state), ("include[]", "term"), ("per_page", "100")]);
    let active = get_all(s, &list("active")).await?;
    let past = match get_all(s, &list("completed")).await {
        Ok(v) => v,
        Err(e @ (LmsError::SignedOut | LmsError::Network(_))) => return Err(e),
        Err(_) => Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (v, concluded) in active.iter().map(|v| (v, false)).chain(past.iter().map(|v| (v, true))) {
        if let Some(c) = course_from(v, concluded, now)
            && seen.insert(c.id.clone())
        {
            out.push(c);
        }
    }
    Ok(out)
}

fn course_from(v: &Value, concluded: bool, now: i64) -> Option<Course> {
    let id = id_str(&v["id"])?;
    let name = v["name"].as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let code = v["course_code"].as_str().map(str::trim).filter(|c| !c.is_empty() && *c != name).map(str::to_string);
    let term = &v["term"];
    let term_name = term["name"].as_str().map(str::trim).filter(|t| !t.is_empty() && *t != "Default Term").map(str::to_string);
    // The course's own dates win only when it's set to override the term's.
    let dates = if v["restrict_enrollments_to_course_dates"].as_bool() == Some(true) { v } else { term };
    let ended = dates["end_at"].as_str().and_then(unix).is_some_and(|t| t < now);
    let not_started = dates["start_at"].as_str().and_then(unix).is_some_and(|t| t > now);
    let current = !concluded && v["workflow_state"].as_str() != Some("completed") && !ended && !not_started;
    Some(Course { id, name: name.to_string(), code, term: term_name, current })
}

pub async fn content(s: &Session, course_id: &str) -> Result<CourseContent, LmsError> {
    if course_id.is_empty() || !course_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(LmsError::NotFound("Your course site couldn’t find this course.".into()));
    }
    let cid = course_id;
    let course = get_one(s, &api(s, &["courses", cid], &[("include[]", "syllabus_body")])).await?;
    let mut c = CourseContent { syllabus: course["syllabus_body"].as_str().filter(|h| !h.trim().is_empty()).map(str::to_string), ..Default::default() };

    let mut ignore = Vec::new();
    let tabs = Tabs(part(s, get_all(s, &api(s, &["courses", cid, "tabs"], &[("per_page", "100")])).await, "", &mut ignore).await?);
    if c.syllabus.is_none() && !tabs.open("syllabus") {
        tabs.note(&mut c.skipped, "syllabus", "Syllabus");
    }
    for t in tabs.external() {
        c.skipped.push(format!("{t}: an outside tool, open it on the course site"));
    }

    // Files, with their folder paths.
    let mut folders = HashMap::new();
    if let Ok(list) = get_all(s, &api(s, &["courses", cid, "folders"], &[("per_page", "100")])).await {
        folders = folder_paths(&list);
    }
    let mut files = Files::default();
    if tabs.open("files") {
        if let Some(list) = part(s, get_all(s, &api(s, &["courses", cid, "files"], &[("per_page", "100")])).await, "Files", &mut c.skipped).await? {
            for v in &list {
                files.add(s, cid, v, &folders, &mut c.skipped);
            }
        }
    } else {
        tabs.note(&mut c.skipped, "files", "Files");
    }

    // Pages: the list has no bodies, so each is fetched.
    let mut pages: Vec<(String, Page)> = Vec::new();
    if tabs.open("pages") {
        if let Some(list) = part(s, get_all(s, &api(s, &["courses", cid, "pages"], &[("per_page", "100")])).await, "Pages", &mut c.skipped).await? {
            let slugs: Vec<String> = list.iter().filter_map(|p| p["url"].as_str()).map(str::to_string).collect();
            let urls: Vec<Url> = slugs.iter().map(|slug| api(s, &["courses", cid, "pages", slug], &[])).collect();
            let got: Vec<_> = futures_util::stream::iter(urls.iter().map(|u| get_one(s, u)).collect::<Vec<_>>()).buffered(4).collect().await;
            for (slug, r) in slugs.iter().zip(got) {
                if let Some(v) = part(s, r, &format!("Page “{slug}”"), &mut c.skipped).await? {
                    page_into(s, cid, slug, &v, &mut pages, &mut c.skipped);
                }
            }
        }
    } else {
        tabs.note(&mut c.skipped, "pages", "Pages");
    }

    let mut assignments: Vec<(String, Assignment)> = Vec::new();
    if tabs.open("assignments") {
        let url = api(s, &["courses", cid, "assignments"], &[("order_by", "due_at"), ("per_page", "100")]);
        if let Some(list) = part(s, get_all(s, &url).await, "Assignments", &mut c.skipped).await? {
            assignments.extend(list.iter().filter_map(|v| assignment_from(s, v)));
        }
    } else {
        tabs.note(&mut c.skipped, "assignments", "Assignments");
    }

    if tabs.open("announcements") {
        let url = api(s, &["courses", cid, "discussion_topics"], &[("only_announcements", "true"), ("per_page", "100")]);
        if let Some(list) = part(s, get_all(s, &url).await, "Announcements", &mut c.skipped).await? {
            c.announcements = list.iter().filter_map(announcement_from).collect();
        }
    } else {
        tabs.note(&mut c.skipped, "announcements", "Announcements");
    }

    // Modules, in order. Their items name files, pages and assignments that the lists above
    // may not have (a tab hidden from students still lets a module link its pages).
    let mut modules: Vec<(String, Vec<Item>)> = Vec::new();
    let mut links: Vec<Link> = Vec::new();
    if tabs.open("modules") {
        let url = api(s, &["courses", cid, "modules"], &[("include[]", "items"), ("include[]", "content_details"), ("per_page", "100")]);
        if let Some(list) = part(s, get_all(s, &url).await, "Modules", &mut c.skipped).await? {
            for m in &list {
                let name = m["name"].as_str().unwrap_or("Module").trim().to_string();
                let raw = match m["items"].as_array() {
                    Some(items) => items.clone(),
                    // Canvas leaves the items out of a long module.
                    None => match m["items_url"].as_str().and_then(|u| Url::parse(u).ok()) {
                        Some(mut u) => {
                            u.query_pairs_mut().append_pair("include[]", "content_details").append_pair("per_page", "100");
                            part(s, get_all(s, &u).await, &format!("Module “{name}”"), &mut c.skipped).await?.unwrap_or_default()
                        }
                        None => Vec::new(),
                    },
                };
                let mut items = Vec::new();
                for it in &raw {
                    if let Some(item) = item_from(it, &mut links) {
                        items.push(item);
                    }
                }
                modules.push((name, items));
            }
        }
    } else {
        tabs.note(&mut c.skipped, "modules", "Modules");
    }

    for (_, items) in &modules {
        for item in items {
            match item {
                Item::File(id, title) if !files.has(id) && files.fetched < MAX_REFERENCED => {
                    files.fetched += 1;
                    let r = get_one(s, &api(s, &["courses", cid, "files", id], &[])).await;
                    if let Some(v) = part(s, r, &format!("File “{title}”"), &mut c.skipped).await? {
                        files.add(s, cid, &v, &folders, &mut c.skipped);
                    }
                }
                Item::Page(slug, title) if !pages.iter().any(|(s, _)| s == slug) => {
                    let r = get_one(s, &api(s, &["courses", cid, "pages", slug], &[])).await;
                    if let Some(v) = part(s, r, &format!("Page “{title}”"), &mut c.skipped).await? {
                        page_into(s, cid, slug, &v, &mut pages, &mut c.skipped);
                    }
                }
                Item::Assignment(id, title) if !assignments.iter().any(|(a, _)| a == id) => {
                    let r = get_one(s, &api(s, &["courses", cid, "assignments", id], &[])).await;
                    if let Some(v) = part(s, r, &format!("Assignment “{title}”"), &mut c.skipped).await?
                        && let Some(a) = assignment_from(s, &v)
                    {
                        assignments.push(a);
                    }
                }
                _ => {}
            }
        }
    }

    // Files the course's own text links to (a syllabus pointing at the schedule PDF),
    // fetched one by one when the file list didn't have them or wasn't open.
    let mut html: Vec<&str> = c.syllabus.iter().map(String::as_str).collect();
    html.extend(pages.iter().map(|(_, p)| p.html.as_str()));
    html.extend(assignments.iter().map(|(_, a)| a.html.as_str()));
    html.extend(c.announcements.iter().map(|a| a.html.as_str()));
    let mut wanted: Vec<(bool, String)> = Vec::new();
    for h in html {
        for r in file_refs(s, cid, h) {
            if !files.has(&r.1) && !wanted.iter().any(|w| w.1 == r.1) {
                wanted.push(r);
            }
        }
    }
    for (in_course, id) in wanted {
        if files.fetched >= MAX_REFERENCED {
            break;
        }
        files.fetched += 1;
        let url = if in_course { api(s, &["courses", cid, "files", &id], &[]) } else { api(s, &["files", &id], &[]) };
        let r = get_one(s, &url).await;
        if let Some(v) = part(s, r, &format!("A linked file (number {id})"), &mut c.skipped).await? {
            files.add(s, cid, &v, &folders, &mut c.skipped);
        }
    }

    c.modules = modules
        .into_iter()
        .map(|(name, items)| Module {
            name,
            items: items
                .into_iter()
                .map(|item| match item {
                    Item::File(id, title) => files.name(&id).unwrap_or(title),
                    Item::Page(slug, title) => pages.iter().find(|(s, _)| *s == slug).map(|(_, p)| p.title.clone()).unwrap_or(title),
                    Item::Assignment(_, title) | Item::Other(title) => title,
                })
                .collect(),
        })
        .collect();
    c.files = files.list;
    c.pages = pages.into_iter().map(|(_, p)| p).collect();
    c.assignments = assignments.into_iter().map(|(_, a)| a).collect();
    c.links = links;
    Ok(c)
}

/// The course menu, as Canvas shows it to this person (`None`: couldn't be read, so
/// every part is tried).
struct Tabs(Option<Vec<Value>>);

impl Tabs {
    fn find(&self, id: &str) -> Option<&Value> {
        self.0.as_ref()?.iter().find(|t| t["id"].as_str() == Some(id))
    }

    /// Students don't get hidden tabs at all; teachers get them marked hidden.
    fn open(&self, id: &str) -> bool {
        self.0.is_none() || self.find(id).is_some_and(|t| t["hidden"].as_bool() != Some(true))
    }

    fn note(&self, skipped: &mut Vec<String>, id: &str, fallback: &str) {
        let label = self.find(id).and_then(|t| t["label"].as_str()).unwrap_or(fallback);
        skipped.push(format!("{label}: hidden in this course"));
    }

    /// Outside tools in the menu (a publisher's homework site): only reachable on the site.
    fn external(&self) -> Vec<String> {
        let Some(tabs) = &self.0 else { return Vec::new() };
        tabs.iter()
            .filter(|t| t["id"].as_str().is_some_and(|i| i.starts_with("context_external_tool_")) && t["hidden"].as_bool() != Some(true))
            .filter_map(|t| t["label"].as_str().map(str::to_string))
            .collect()
    }
}

/// A part of the course that may be closed to this person. Canvas answers 401 both
/// when the session has ended and when the person may not see this part, so a 401 is
/// checked against their own profile before it counts as signed out.
async fn part<T>(s: &Session, r: Result<T, LmsError>, what: &str, skipped: &mut Vec<String>) -> Result<Option<T>, LmsError> {
    let closed = match r {
        Ok(v) => return Ok(Some(v)),
        Err(LmsError::SignedOut) => {
            if let Err(e @ (LmsError::SignedOut | LmsError::Network(_))) = get_one(s, &api(s, &["users", "self"], &[])).await {
                return Err(e);
            }
            None
        }
        Err(e @ LmsError::Network(_)) => return Err(e),
        Err(LmsError::Forbidden(_) | LmsError::NotFound(_)) => None,
        Err(e) => Some(e.to_string()),
    };
    if !what.is_empty() {
        skipped.push(match closed {
            None => format!("{what}: not open to you in this course"),
            Some(e) => format!("{what}: {e}"),
        });
    }
    Ok(None)
}

enum Item {
    File(String, String),
    Page(String, String),
    Assignment(String, String),
    Other(String),
}

/// One module item; external ones also go to `links`. Headings inside a module are left out.
fn item_from(v: &Value, links: &mut Vec<Link>) -> Option<Item> {
    let title = v["title"].as_str()?.trim().to_string();
    let id = || id_str(&v["content_id"]);
    Some(match v["type"].as_str()? {
        "SubHeader" => return None,
        "File" => Item::File(id()?, title),
        "Page" => Item::Page(v["page_url"].as_str()?.to_string(), title),
        "Assignment" => Item::Assignment(id()?, title),
        "ExternalUrl" | "ExternalTool" => {
            if let Some(u) = v["external_url"].as_str().and_then(|u| Url::parse(u).ok()).filter(|u| matches!(u.scheme(), "https" | "http"))
                && !links.iter().any(|l| l.url == u)
            {
                links.push(Link { title: title.clone(), url: u });
            }
            Item::Other(title)
        }
        _ => Item::Other(title),
    })
}

fn page_into(s: &Session, cid: &str, slug: &str, v: &Value, pages: &mut Vec<(String, Page)>, skipped: &mut Vec<String>) {
    let title = v["title"].as_str().unwrap_or(slug).trim().to_string();
    let Some(html) = v["body"].as_str() else {
        skipped.push(format!("Page “{title}”: locked for now"));
        return;
    };
    let url = on_site(s, v["html_url"].as_str()).or_else(|| Some(site(s, &["courses", cid, "pages", slug])));
    pages.push((slug.to_string(), Page { title, html: html.to_string(), url }));
}

fn assignment_from(s: &Session, v: &Value) -> Option<(String, Assignment)> {
    let id = id_str(&v["id"])?;
    let a = Assignment {
        title: v["name"].as_str()?.trim().to_string(),
        due: v["due_at"].as_str().map(str::to_string),
        points: v["points_possible"].as_f64(),
        html: v["description"].as_str().unwrap_or_default().to_string(),
        url: on_site(s, v["html_url"].as_str()),
    };
    Some((id, a))
}

fn announcement_from(v: &Value) -> Option<Announcement> {
    Some(Announcement {
        title: v["title"].as_str()?.trim().to_string(),
        posted: ["posted_at", "delayed_post_at", "created_at"].iter().find_map(|k| v[*k].as_str()).map(str::to_string),
        html: v["message"].as_str().unwrap_or_default().to_string(),
    })
}

#[derive(Default)]
struct Files {
    list: Vec<RemoteFile>,
    ids: Vec<String>,
    fetched: usize,
}

impl Files {
    fn has(&self, id: &str) -> bool {
        self.ids.iter().any(|i| i == id)
    }

    fn name(&self, id: &str) -> Option<String> {
        self.ids.iter().position(|i| i == id).map(|n| self.list[n].name.clone())
    }

    fn add(&mut self, s: &Session, cid: &str, v: &Value, folders: &HashMap<String, Option<String>>, skipped: &mut Vec<String>) {
        let Some(id) = id_str(&v["id"]) else { return };
        let Some(name) = v["display_name"].as_str().or(v["filename"].as_str()).map(str::trim).filter(|n| !n.is_empty()) else { return };
        if self.has(&id) {
            return;
        }
        if v["locked_for_user"].as_bool() == Some(true) || v["hidden_for_user"].as_bool() == Some(true) || v["url"].as_str() == Some("") {
            skipped.push(format!("File “{name}”: locked for now"));
            return;
        }
        let url = on_site(s, v["url"].as_str()).unwrap_or_else(|| {
            let mut u = site(s, &["courses", cid, "files", &id, "download"]);
            u.query_pairs_mut().append_pair("download_frd", "1");
            u
        });
        let mut aliases: Vec<Url> = [
            site(s, &["courses", cid, "files", &id]),
            site(s, &["courses", cid, "files", &id, "download"]),
            site(s, &["courses", cid, "files", &id, "preview"]),
            site(s, &["files", &id]),
            site(s, &["files", &id, "download"]),
            api(s, &["courses", cid, "files", &id], &[]),
            api(s, &["files", &id], &[]),
        ]
        .into();
        if let Some(p) = on_site(s, v["preview_url"].as_str()) {
            aliases.push(p);
        }
        let folder = id_str(&v["folder_id"]).and_then(|f| folders.get(&f).cloned()).flatten();
        self.ids.push(id);
        self.list.push(RemoteFile {
            name: name.to_string(),
            folder,
            url,
            size: v["size"].as_u64(),
            mime: v["content-type"].as_str().map(str::to_string),
            aliases,
        });
    }
}

/// Folder id → its path below the course's top folder ("course files/Lectures/Week 1"
/// → "Lectures/Week 1"; the top folder itself → none).
fn folder_paths(list: &[Value]) -> HashMap<String, Option<String>> {
    let roots: Vec<&str> = list.iter().filter(|f| f["parent_folder_id"].is_null()).filter_map(|f| f["full_name"].as_str()).collect();
    list.iter()
        .filter_map(|f| {
            let id = id_str(&f["id"])?;
            let full = f["full_name"].as_str()?;
            let below = roots
                .iter()
                .find_map(|r| if full == *r { Some("") } else { full.strip_prefix(r).and_then(|x| x.strip_prefix('/')) })
                .unwrap_or_else(|| full.split_once('/').map_or("", |(_, rest)| rest));
            Some((id, Some(below.to_string()).filter(|b| !b.is_empty())))
        })
        .collect()
}

/// File ids that links and images in `html` point at on this site: `(in this course, id)`.
fn file_refs(s: &Session, cid: &str, html: &str) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    for attr in ["href=", "src=", "data-api-endpoint="] {
        let mut rest = html;
        while let Some(i) = rest.find(attr) {
            rest = &rest[i + attr.len()..];
            let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
            let Some(end) = rest[1..].find(q) else { break };
            let value = rest[1..1 + end].replace("&amp;", "&");
            rest = &rest[1 + end..];
            let Some(u) = s.site.base.join(value.trim()).ok().filter(|u| s.site.owns(u)) else { continue };
            let segs: Vec<&str> = u.path_segments().map(|p| p.collect()).unwrap_or_default();
            let found = match segs.as_slice() {
                ["api", "v1", "courses", c, "files", f, ..] | ["courses", c, "files", f, ..] => Some((*c == cid, *f)),
                ["api", "v1", "files", f, ..] | ["files", f, ..] | ["users", _, "files", f, ..] => Some((false, *f)),
                _ => None,
            };
            if let Some((here, f)) = found
                && !f.is_empty()
                && f.bytes().all(|b| b.is_ascii_digit())
                && !out.iter().any(|(_, x): &(bool, String)| x == f)
            {
                out.push((here, f.to_string()));
            }
        }
    }
    out
}

/// `/api/v1/<segments>?<query>` on the site.
fn api(s: &Session, segs: &[&str], query: &[(&str, &str)]) -> Url {
    let mut u = site(s, &[["api", "v1"].as_slice(), segs].concat());
    if !query.is_empty() {
        u.query_pairs_mut().extend_pairs(query);
    }
    u
}

fn site(s: &Session, segs: &[&str]) -> Url {
    let mut u = s.site.base.clone();
    u.path_segments_mut().expect("an origin has a path").clear().extend(segs);
    u
}

/// An address the site gave, kept only when it's on the site.
fn on_site(s: &Session, raw: Option<&str>) -> Option<Url> {
    raw.filter(|r| !r.is_empty()).and_then(|r| s.site.base.join(r).ok()).filter(|u| s.site.owns(u))
}

async fn get_one(s: &Session, url: &Url) -> Result<Value, LmsError> {
    get_page(s, url).await.map(|(v, _)| v)
}

/// Every page of a list, following `Link: <…>; rel="next"` while it stays on the site.
async fn get_all(s: &Session, url: &Url) -> Result<Vec<Value>, LmsError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut next = Some(url.clone());
    while let Some(u) = next {
        if !s.site.owns(&u) {
            return Err(LmsError::Other("Your course site pointed the rest of a list at another site, so Phaethon stopped there.".into()));
        }
        if !seen.insert(u.to_string()) || seen.len() > MAX_PAGES {
            break;
        }
        let (v, n) = get_page(s, &u).await?;
        match v {
            Value::Array(items) => out.extend(items),
            _ => return Err(unexpected("a list was expected")),
        }
        next = n;
    }
    Ok(out)
}

/// One API response: its JSON (minus the `while(1);` guard Canvas puts in front of
/// JSON for a browser session) and the next page's address. Landing on the login
/// page, or getting HTML back, means the session has ended.
async fn get_page(s: &Session, url: &Url) -> Result<(Value, Option<Url>), LmsError> {
    let res = s.get(url).await?;
    let at = res.url().clone();
    if !s.site.owns(&at) {
        return Err(unexpected("it answered from another site"));
    }
    if at.path().starts_with("/login") {
        return Err(LmsError::SignedOut);
    }
    let ctype = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if ctype.starts_with("text/html") {
        return Err(LmsError::SignedOut);
    }
    let next = res.headers().get_all(reqwest::header::LINK).iter().filter_map(|v| v.to_str().ok()).find_map(next_link).and_then(|l| at.join(&l).ok());
    let text = res.text().await.map_err(|e| LmsError::Network(e.to_string()))?;
    let body = text.trim_start();
    let body = body.strip_prefix("while(1);").unwrap_or(body);
    let v = serde_json::from_str(body).map_err(|e| unexpected(&e.to_string()))?;
    Ok((v, next))
}

fn unexpected(why: &str) -> LmsError {
    LmsError::Other(format!("Your course site sent something unexpected: {why}"))
}

/// The `rel="next"` target of a Link header.
fn next_link(header: &str) -> Option<String> {
    let mut rest = header;
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let end = after.find('>')?;
        let tail = &after[end + 1..];
        let params = &tail[..tail.find('<').unwrap_or(tail.len())];
        let is_next = params.split([';', ',']).any(|p| {
            p.split_once('=').is_some_and(|(k, v)| {
                k.trim().eq_ignore_ascii_case("rel") && v.trim().trim_matches('"').split_whitespace().any(|r| r.eq_ignore_ascii_case("next"))
            })
        });
        if is_next {
            return Some(after[..end].to_string());
        }
        rest = tail;
    }
    None
}

fn id_str(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(byte) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Seconds since 1970 for an ISO 8601 time as Canvas writes it ("2026-12-20T05:00:00Z",
/// fractions and ±hh:mm offsets allowed).
fn unix(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = s.get(19..)?;
    if rest.starts_with('.') {
        rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        r if r.len() == 6 => {
            let sign = match &r[..1] {
                "+" => 1,
                "-" => -1,
                _ => return None,
            };
            sign * (r.get(1..3)?.parse::<i64>().ok()? * 3600 + r.get(4..6)?.parse::<i64>().ok()? * 60)
        }
        _ => return None,
    };
    // Days from civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se - offset)
}

// ---- Grades ----------------------------------------------------------------

/// The person's grades in a course: the course grade from their own enrollment
/// (`grades.current_score` / `final_score`, as Canvas computes them), every
/// assignment's submission with its score, flags and comments, and the
/// assignment groups with their weights when the course weights them. Scores
/// Canvas hasn't posted come back empty and stay empty.
pub async fn grades(s: &Session, course_id: &str) -> Result<CourseGrades, LmsError> {
    if course_id.is_empty() || !course_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(LmsError::NotFound("Your course site couldn’t find this course.".into()));
    }
    let cid = course_id;
    let enrollments =
        api(s, &["courses", cid, "enrollments"], &[("user_id", "self"), ("type[]", "StudentEnrollment"), ("include[]", "current_points"), ("per_page", "100")]);
    let Some(enrollments) = grade_part(s, get_all(s, &enrollments).await).await? else {
        return Ok(CourseGrades { note: Some(super::GRADES_HIDDEN.into()), ..Default::default() });
    };
    let course = grade_part(s, get_one(s, &api(s, &["courses", cid], &[])).await).await?;
    let weighted = course.as_ref().and_then(|c| c["apply_assignment_group_weights"].as_bool()) == Some(true);
    let groups = grade_part(s, get_all(s, &api(s, &["courses", cid, "assignment_groups"], &[("per_page", "100")])).await).await?.unwrap_or_default();
    let subs = api(
        s,
        &["courses", cid, "students", "submissions"],
        &[("student_ids[]", "self"), ("include[]", "assignment"), ("include[]", "submission_comments"), ("per_page", "100")],
    );
    let subs = grade_part(s, get_all(s, &subs).await).await?.unwrap_or_default();

    let mut out = CourseGrades::default();
    let mut group_names: HashMap<String, String> = HashMap::new();
    for g in &groups {
        let (Some(id), Some(name)) = (id_str(&g["id"]), g["name"].as_str().map(str::trim).filter(|n| !n.is_empty())) else { continue };
        group_names.insert(id, name.to_string());
        out.groups.push(GradeGroup { name: name.to_string(), weight: if weighted { g["group_weight"].as_f64() } else { None } });
    }
    out.items = subs.iter().filter_map(|v| grade_item_from(v, &group_names)).collect();
    out.items.sort_by_key(|i| {
        let t = i.due.as_deref().and_then(unix);
        (t.is_none(), t)
    });

    if let Some(e) = enrollments.iter().find(|e| e["type"].as_str().is_none_or(|t| t == "StudentEnrollment")) {
        let g = &e["grades"];
        let num = |k: &str| g[k].as_f64().or_else(|| e[format!("computed_{k}").as_str()].as_f64());
        let letter = |k: &str| g[k].as_str().or_else(|| e[format!("computed_{k}").as_str()].as_str()).map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
        out.current = GradeSummary { percent: num("current_score"), letter: letter("current_grade"), points: g["current_points"].as_f64(), possible: None };
        // Points out of what's been graded, when the course grade is plain points (unweighted).
        if out.current.points.is_some() && !weighted {
            let possible: f64 = out.items.iter().filter(|i| i.score.is_some() && !i.excused).filter_map(|i| i.possible).sum();
            out.current.possible = (possible > 0.0).then_some(possible);
        }
        let fin = GradeSummary { percent: num("final_score"), letter: letter("final_grade"), points: None, possible: None };
        // Only worth saying when it differs from the grade so far (work still ungraded counts as zero).
        if !fin.is_empty() && (fin.percent != out.current.percent || fin.letter != out.current.letter) {
            out.final_grade = Some(fin);
        }
    }
    Ok(out)
}

/// A grade read where Canvas may refuse: `None` when the person may not see it
/// (Canvas answers 401 for that too, so a 401 is checked against their profile).
async fn grade_part<T>(s: &Session, r: Result<T, LmsError>) -> Result<Option<T>, LmsError> {
    let mut why = Vec::new();
    match part(s, r, "-", &mut why).await? {
        Some(v) => Ok(Some(v)),
        None if why.iter().all(|w| w.ends_with("not open to you in this course")) => Ok(None),
        None => Err(LmsError::Other(why.pop().unwrap_or_default().trim_start_matches("-: ").to_string())),
    }
}

fn grade_item_from(v: &Value, groups: &HashMap<String, String>) -> Option<GradeItem> {
    let a = &v["assignment"];
    let title = a["name"].as_str()?.trim().to_string();
    if title.is_empty() || a["published"].as_bool() == Some(false) {
        return None;
    }
    let state = v["workflow_state"].as_str().unwrap_or("");
    let score = v["score"].as_f64();
    let possible = a["points_possible"].as_f64();
    let excused = v["excused"].as_bool() == Some(true);
    // "A-", "complete": the grade as shown, when it isn't just the score.
    let grade = v["grade"].as_str().map(str::trim).filter(|g| !g.is_empty() && g.parse::<f64>().is_err()).map(str::to_string);
    let comments = v["submission_comments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["comment"].as_str().map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty()))
        .collect();
    Some(GradeItem {
        title,
        group: id_str(&a["assignment_group_id"]).and_then(|g| groups.get(&g).cloned()),
        score,
        possible,
        percent: super::percent_of(score, possible),
        grade: if excused { None } else { grade },
        due: a["due_at"].as_str().map(str::to_string),
        submitted: v["submitted_at"].as_str().is_some() || matches!(state, "submitted" | "pending_review"),
        // Graded but not posted: Canvas leaves the score out, so it doesn't count as graded here.
        graded: (state == "graded" && (score.is_some() || v["grade"].as_str().is_some())) || excused,
        late: v["late"].as_bool() == Some(true),
        missing: v["missing"].as_bool() == Some(true),
        excused,
        comments,
    })
}

#[cfg(test)]
mod grade_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::{Cookie, Kind, Site};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Reply {
        status: &'static str,
        ctype: &'static str,
        headers: Vec<String>,
        body: String,
    }

    fn json(body: String) -> Reply {
        Reply { status: "200 OK", ctype: "application/json; charset=utf-8", headers: vec![], body }
    }

    fn status(status: &'static str, body: &str) -> Reply {
        Reply { status, ctype: "application/json; charset=utf-8", headers: vec![], body: body.into() }
    }

    type Route = Arc<dyn Fn(&Url, &str) -> Reply + Send + Sync>;

    /// A fake Canvas on 127.0.0.1: answers each request through `route(url, base)` and
    /// records each request's head.
    async fn serve(route: Route) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (b, log) = (base.clone(), seen.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let (route, b, log) = (route.clone(), b.clone(), log.clone());
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !String::from_utf8_lossy(&req).contains("\r\n\r\n") {
                        let n = sock.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        req.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&req).into_owned();
                    let target = head.split_whitespace().nth(1).unwrap().to_string();
                    log.lock().unwrap().push(head);
                    let url = Url::parse(&format!("{b}{target}")).unwrap();
                    let r = route(&url, &b);
                    let extra: String = r.headers.iter().map(|h| format!("{h}\r\n")).collect();
                    let out = format!(
                        "HTTP/1.1 {}\r\ncontent-type: {}\r\n{extra}connection: close\r\ncontent-length: {}\r\n\r\n{}",
                        r.status,
                        r.ctype,
                        r.body.len(),
                        r.body
                    );
                    sock.write_all(out.as_bytes()).await.unwrap();
                });
            }
        });
        (base, seen)
    }

    fn session(base: &str) -> Session {
        let cookies = vec![
            Cookie { name: "_normandy_session".into(), value: "sess123".into() },
            Cookie { name: "log_session_id".into(), value: "abc".into() },
        ];
        Session::new(Site::for_test(Kind::Canvas, base), Credential { cookies, csrf: Some("tok+en==".into()) })
    }

    fn fixture(name: &str, base: &str) -> String {
        let raw = match name {
            "courses_active_1" => include_str!("../../tests/fixtures/canvas/courses_active_1.json"),
            "courses_active_2" => include_str!("../../tests/fixtures/canvas/courses_active_2.json"),
            "courses_completed" => include_str!("../../tests/fixtures/canvas/courses_completed.json"),
            "course" => include_str!("../../tests/fixtures/canvas/course.json"),
            "tabs" => include_str!("../../tests/fixtures/canvas/tabs.json"),
            "folders" => include_str!("../../tests/fixtures/canvas/folders.json"),
            "files" => include_str!("../../tests/fixtures/canvas/files.json"),
            "file_5009" => include_str!("../../tests/fixtures/canvas/file_5009.json"),
            "modules" => include_str!("../../tests/fixtures/canvas/modules.json"),
            "module_2_items" => include_str!("../../tests/fixtures/canvas/module_2_items.json"),
            "page_reading_guide" => include_str!("../../tests/fixtures/canvas/page_reading_guide.json"),
            "assignments" => include_str!("../../tests/fixtures/canvas/assignments.json"),
            "announcements" => include_str!("../../tests/fixtures/canvas/announcements.json"),
            _ => panic!("no fixture {name}"),
        };
        raw.replace("{BASE}", base)
    }

    const UNAUTHORIZED: &str = r#"{"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]}"#;
    const UNAUTHENTICATED: &str = r#"{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}"#;

    fn query(u: &Url, k: &str) -> Vec<String> {
        u.query_pairs().filter(|(key, _)| key == k).map(|(_, v)| v.into_owned()).collect()
    }

    #[test]
    fn login_url_is_the_sites_login_page() {
        let base = Url::parse("https://iu.instructure.com").unwrap();
        assert_eq!(login_url(&base).as_str(), "https://iu.instructure.com/login");
    }

    #[test]
    fn signed_in_only_back_on_the_site_past_login_with_a_session() {
        let base = Url::parse("https://iu.instructure.com").unwrap();
        let cookies = vec![
            Cookie { name: "_normandy_session".into(), value: "s3ss".into() },
            Cookie { name: "log_session_id".into(), value: "f00".into() },
            Cookie { name: "_csrf_token".into(), value: "abc%2Bdef%2F%3D%3D".into() },
        ];
        let at = |u: &str, c: &[Cookie]| {
            let url = Url::parse(u).unwrap();
            login_result(&base, &LoginNav { url: &url, cookies: c })
        };
        // Still signing in: the login page (Canvas sets its session cookie there too), the school's SSO.
        assert!(at("https://iu.instructure.com/login/canvas", &cookies).is_none());
        assert!(at("https://iu.instructure.com/login/saml", &cookies).is_none());
        assert!(at("https://idp.iu.edu/idp/profile/SAML2/Redirect/SSO", &cookies).is_none());
        // Look-alike origins don't count.
        assert!(at("http://iu.instructure.com/", &cookies).is_none());
        assert!(at("https://iu.instructure.com:8443/", &cookies).is_none());
        // Back on the dashboard without a session cookie: not signed in.
        assert!(at("https://iu.instructure.com/", &cookies[1..]).is_none());

        let cred = at("https://iu.instructure.com/?login_success=1", &cookies).expect("signed in");
        assert_eq!(cred.cookies, cookies, "every site cookie is kept");
        assert_eq!(cred.csrf.as_deref(), Some("abc+def/=="));

        let old = vec![Cookie { name: "canvas_session".into(), value: "x".into() }];
        let cred = at("https://iu.instructure.com/courses", &old).expect("older cookie name");
        assert_eq!(cred.csrf, None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn courses_across_pages_with_the_json_guard() {
        let (base, seen) = serve(Arc::new(|u: &Url, b: &str| match u.path() {
            "/api/v1/courses" if query(u, "enrollment_state") == ["completed"] => json(fixture("courses_completed", b)),
            "/api/v1/courses" if query(u, "page") == ["2"] => json(fixture("courses_active_2", b)),
            "/api/v1/courses" => {
                let mut r = json(format!("while(1);{}", fixture("courses_active_1", b)));
                r.headers.push(format!(
                    "Link: <{b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=1&per_page=100>; rel=\"current\",<{b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=2&per_page=100>; rel=\"next\",<{b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=1&per_page=100>; rel=\"first\""
                ));
                r
            }
            _ => status("404 Not Found", "{}"),
        }))
        .await;
        let list = courses(&session(&base)).await.unwrap();
        let got: Vec<_> = list.iter().map(|c| (c.id.as_str(), c.name.as_str(), c.code.as_deref(), c.term.as_deref(), c.current)).collect();
        assert_eq!(
            got,
            vec![
                ("1001", "Data Structures", Some("C343"), Some("Fall 2026"), true),
                ("1002", "Calculus II", Some("M212"), Some("Fall 2026"), true),
                ("1003", "Intro to Ethics", Some("P100"), Some("Spring 2020"), false),
                ("1005", "Research Seminar", None, None, false),
                ("900", "Discrete Mathematics", Some("C241"), Some("Spring 2026"), false),
            ]
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        for head in seen.iter() {
            assert!(head.starts_with("GET "), "read-only: {head}");
            assert!(head.to_lowercase().contains("cookie: _normandy_session=sess123; log_session_id=abc"), "{head}");
            assert!(!head.to_lowercase().contains("authorization:"), "no api token: {head}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ended_session_is_signed_out() {
        // 401 from the API.
        let (base, _) = serve(Arc::new(|_: &Url, _: &str| status("401 Unauthorized", UNAUTHENTICATED))).await;
        assert_eq!(courses(&session(&base)).await.unwrap_err(), LmsError::SignedOut);
        // Redirected to the login page.
        let (base, _) = serve(Arc::new(|u: &Url, _: &str| match u.path() {
            p if p.starts_with("/login") => Reply { status: "200 OK", ctype: "text/html; charset=utf-8", headers: vec![], body: "<form>Sign in</form>".into() },
            _ => Reply { status: "302 Found", ctype: "text/html", headers: vec!["Location: /login".into()], body: String::new() },
        }))
        .await;
        assert_eq!(courses(&session(&base)).await.unwrap_err(), LmsError::SignedOut);
        assert_eq!(content(&session(&base), "1001").await.unwrap_err(), LmsError::SignedOut);
        // A part answering 401 while the profile also does: signed out, not "hidden".
        let (base, _) = serve(Arc::new(|u: &Url, b: &str| match u.path() {
            "/api/v1/courses/1001" => json(fixture("course", b)),
            _ => status("401 Unauthorized", UNAUTHENTICATED),
        }))
        .await;
        assert_eq!(content(&session(&base), "1001").await.unwrap_err(), LmsError::SignedOut);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_course_with_its_files_pages_and_modules() {
        let (base, seen) = serve(Arc::new(|u: &Url, b: &str| match u.path() {
            "/api/v1/users/self" => json(r#"{"id":42,"name":"Sam Student"}"#.into()),
            "/api/v1/courses/1001" => json(fixture("course", b)),
            "/api/v1/courses/1001/tabs" => json(format!("while(1);{}", fixture("tabs", b))),
            "/api/v1/courses/1001/folders" => json(fixture("folders", b)),
            "/api/v1/courses/1001/files" => json(fixture("files", b)),
            "/api/v1/courses/1001/files/5009" => json(fixture("file_5009", b)),
            "/api/v1/courses/1001/pages/reading-guide" => json(fixture("page_reading_guide", b)),
            "/api/v1/courses/1001/assignments" => json(fixture("assignments", b)),
            "/api/v1/courses/1001/assignments/7003" => status("401 Unauthorized", UNAUTHORIZED),
            "/api/v1/courses/1001/discussion_topics" if query(u, "only_announcements") == ["true"] => json(fixture("announcements", b)),
            "/api/v1/courses/1001/modules" => json(fixture("modules", b)),
            "/api/v1/courses/1001/modules/2/items" => json(fixture("module_2_items", b)),
            _ => status("404 Not Found", r#"{"errors":[{"message":"The specified resource does not exist."}]}"#),
        }))
        .await;
        let c = content(&session(&base), "1001").await.unwrap();
        let at = |p: &str| Url::parse(&format!("{base}{p}")).unwrap();

        // The syllabus stays HTML, links and all: the importer resolves them.
        let syl = c.syllabus.as_deref().unwrap();
        assert!(syl.contains(r#"href="https://open.example.org/books/ods-java.pdf""#));
        assert!(syl.contains(&format!(r#"href="{base}/courses/1001/files/5003?verifier=Zx9&amp;wrap=1""#)));

        // Files, with folder paths below the course's top folder; the locked one is noted.
        let files: Vec<_> = c.files.iter().map(|f| (f.name.as_str(), f.folder.as_deref(), f.mime.as_deref())).collect();
        assert_eq!(
            files,
            vec![
                ("Lecture 1 - Arrays.pdf", Some("Lectures/Week 1"), Some("application/pdf")),
                ("schedule.pdf", None, Some("application/pdf")),
                ("Chapter 1 notes.pdf", Some("Lectures"), Some("application/pdf")),
            ],
            "5009 isn't in the list but the syllabus links it, so it was fetched by itself"
        );
        let schedule = &c.files[1];
        assert_eq!(schedule.url, at("/files/5003/download?download_frd=1&verifier=Sc3"));
        assert_eq!(schedule.size, Some(48_213));
        for alias in ["/courses/1001/files/5003", "/courses/1001/files/5003/download", "/files/5003", "/api/v1/courses/1001/files/5003", "/courses/1001/files/5003/file_preview?annotate=0"] {
            assert!(schedule.aliases.contains(&at(alias)), "alias {alias}");
        }
        assert!(c.files.iter().all(|f| f.url.as_str().starts_with(&base)), "downloads stay on the site");

        // Pages: the tab is hidden, so the list wasn't asked for, but the page a module links was.
        assert_eq!(c.pages.len(), 1);
        assert_eq!(c.pages[0].title, "Reading guide");
        assert_eq!(c.pages[0].url, Some(at("/courses/1001/pages/reading-guide")));
        assert!(c.pages[0].html.contains("Read chapter 1"));

        let a: Vec<_> = c.assignments.iter().map(|a| (a.title.as_str(), a.due.as_deref(), a.points)).collect();
        assert_eq!(a, vec![("Homework 1", Some("2026-10-20T03:59:00Z"), Some(10.0)), ("Homework 2", None, Some(10.0))]);
        assert!(c.assignments[0].html.contains("dynamic array"));
        assert_eq!(c.assignments[0].url, Some(at("/courses/1001/assignments/7001")));

        assert_eq!(c.announcements.len(), 1);
        assert_eq!(c.announcements[0].title, "Office hours moved");
        assert_eq!(c.announcements[0].posted.as_deref(), Some("2026-09-02T15:00:00Z"));

        let modules: Vec<_> = c.modules.iter().map(|m| (m.name.as_str(), m.items.iter().map(String::as_str).collect::<Vec<_>>())).collect();
        assert_eq!(
            modules,
            vec![
                ("Week 1: Arrays", vec!["Lecture 1 - Arrays.pdf", "Reading guide", "Homework 1", "Visualgo", "Connect homework"]),
                ("Week 2: Lists", vec!["Homework 2", "Quiz 1", "Bonus project"]),
            ]
        );
        let links: Vec<_> = c.links.iter().map(|l| (l.title.as_str(), l.url.as_str())).collect();
        assert_eq!(links, vec![("Visualgo", "https://visualgo.net/en/list"), ("Connect homework", "https://connect.mheducation.com/lti")]);

        assert_eq!(
            c.skipped,
            vec![
                "McGraw Hill Connect: an outside tool, open it on the course site",
                "File “Midterm key.pdf”: locked for now",
                "Pages: hidden in this course",
                "Assignment “Bonus project”: not open to you in this course",
            ]
        );

        let seen = seen.lock().unwrap();
        assert!(!seen.iter().any(|h| h.starts_with("GET /api/v1/courses/1001/pages?")), "hidden tab not read");
        assert!(seen.iter().all(|h| h.starts_with("GET ") && h.contains("_normandy_session=sess123")));
    }

    /// Canvas and the importer together: the course as the person would find it in
    /// their space, the syllabus's file link and textbook PDF resolved to local copies.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_canvas_course_imported_end_to_end() {
        const PDF: &str = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
        let pdf = |_: &Url, _: &str| Reply { status: "200 OK", ctype: "application/pdf", headers: vec![], body: PDF.into() };
        // The publisher's copy is a real PDF, so the agent gets its words.
        let book = String::from_utf8(crate::lms::text::test_pdf("Chapter 1. Arrays: a contiguous block of memory.")).unwrap();
        let (books, books_seen) = serve(Arc::new(move |_: &Url, _: &str| Reply { status: "200 OK", ctype: "application/pdf", headers: vec![], body: book.clone() })).await;
        let (base, _) = serve(Arc::new(move |u: &Url, b: &str| match u.path() {
            "/api/v1/users/self" => json(r#"{"id":42,"name":"Sam Student"}"#.into()),
            "/api/v1/courses/1001" => json(fixture("course", b).replace("https://open.example.org", &books)),
            "/api/v1/courses/1001/tabs" => json(fixture("tabs", b)),
            "/api/v1/courses/1001/folders" => json(fixture("folders", b)),
            "/api/v1/courses/1001/files" => json(fixture("files", b)),
            "/api/v1/courses/1001/files/5009" => json(fixture("file_5009", b)),
            "/api/v1/courses/1001/pages/reading-guide" => json(fixture("page_reading_guide", b)),
            "/api/v1/courses/1001/assignments" => json(fixture("assignments", b)),
            "/api/v1/courses/1001/discussion_topics" => json(fixture("announcements", b)),
            "/api/v1/courses/1001/modules" => json(fixture("modules", b)),
            "/api/v1/courses/1001/modules/2/items" => json(fixture("module_2_items", b)),
            p if p.ends_with("/download") => pdf(u, b),
            _ => status("404 Not Found", "{}"),
        }))
        .await;
        let s = session(&base);
        let c = content(&s, "1001").await.unwrap();
        let course = Course { id: "1001".into(), name: "C343 Data Structures".into(), code: Some("C343".into()), term: Some("Fall 2026".into()), current: true };
        let tmp = std::env::temp_dir().join(format!("phaethon-canvas-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let out = crate::lms::import::import_course(&s, &tmp, &course, c, None, &[], &Default::default(), &mut |_, _, _| {}).await.unwrap();

        let dir = std::fs::read_dir(&tmp).unwrap().next().unwrap().unwrap().path();
        let read = |p: &str| std::fs::read_to_string(dir.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
        let syllabus = read("syllabus.md");
        let readme = read("README.md");
        eprintln!("--- folder {}\n--- README.md\n{readme}\n--- syllabus.md\n{syllabus}\n--- outcome {out:?}", dir.display());
        assert!(out.files >= 3 && out.readings >= 1, "{out:?}");
        assert!(dir.join("files/Lectures/Week 1/Lecture 1 - Arrays.pdf").is_file());
        assert!(!books_seen.lock().unwrap().iter().any(|h| h.contains("sess123")), "the textbook site never got the session");
        assert!(!syllabus.contains(&base), "every course link points at a local copy: {syllabus}");
        assert!(std::fs::read_dir(dir.join("readings")).unwrap().count() >= 1, "the textbook PDF is in readings/");
        assert!(readme.contains("Textbooks") && readme.contains("readings/"), "the README points at the textbook copy");
        assert!(syllabus.contains("](readings/ods-java.pdf)"), "the syllabus's textbook link opens the downloaded copy");
        assert_eq!(readme.matches("**Textbook**").count(), 1, "one entry for the book, its ISBN beside the copy");
        assert!(readme.contains("ISBN 9781927356388"));
        let words = read("readings/ods-java.pdf.md");
        assert!(words.contains("contiguous block of memory"), "the textbook's text copy holds its words: {words}");
        assert!(readme.contains("Text copy: [readings/ods-java.pdf.md]"));
        assert!(!dir.join("files/schedule.pdf.md").exists() && !readme.contains("schedule.pdf.md"), "no text copy is promised for an unreadable file");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn never_leaves_the_site() {
        let (other, other_seen) = serve(Arc::new(|_: &Url, _: &str| json("[]".into()))).await;
        let (base, _) = serve(Arc::new(move |u: &Url, _: &str| match u.path() {
            "/api/v1/courses" => {
                let mut r = json("[]".into());
                r.headers.push(format!("Link: <{other}/api/v1/courses?page=2>; rel=\"next\""));
                r
            }
            _ => Reply { status: "302 Found", ctype: "text/plain", headers: vec![format!("Location: {other}/stolen")], body: String::new() },
        }))
        .await;
        let s = session(&base);
        // A next page on another site is refused before anything is sent.
        assert!(matches!(courses(&s).await, Err(LmsError::Other(_))));
        assert!(other_seen.lock().unwrap().is_empty(), "the next page on another site was never asked for");
        // A file whose download redirects to another site (a storage host): followed, without the session.
        let dl = Url::parse(&format!("{base}/files/1/download")).unwrap();
        let _ = s.get(&dl).await;
        let seen = other_seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "the redirect was followed once");
        assert!(seen.iter().all(|h| !h.contains("sess123") && !h.to_ascii_lowercase().contains("cookie:")), "without the session: {seen:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn course_ids_are_numbers() {
        let s = session("http://127.0.0.1:9");
        assert!(matches!(content(&s, "../users/self").await, Err(LmsError::NotFound(_))));
        assert!(matches!(content(&s, "").await, Err(LmsError::NotFound(_))));
    }

    #[test]
    fn link_headers_times_and_folders() {
        let h = r#"<https://x/a?page=1>; rel="current", <https://x/a?page=2&per_page=100>; rel="next", <https://x/a?page=9>; rel="last""#;
        assert_eq!(next_link(h).as_deref(), Some("https://x/a?page=2&per_page=100"));
        assert_eq!(next_link(r#"<https://x/a?page=1>; rel="first""#), None);
        assert_eq!(unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix("2026-10-10T12:00:00Z"), Some(1_791_633_600));
        assert_eq!(unix("2026-10-10T08:00:00.123-04:00"), Some(1_791_633_600));
        assert_eq!(unix("soon"), None);
        let f: Vec<Value> = serde_json::from_str(&fixture("folders", "")).unwrap();
        let p = folder_paths(&f);
        assert_eq!(p["10"], None);
        assert_eq!(p["12"].as_deref(), Some("Lectures/Week 1"));
        assert_eq!(percent_decode("a%2Bb%3D%zz"), "a+b=%zz");
    }
}
