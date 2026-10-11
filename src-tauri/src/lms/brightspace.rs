//! Brightspace (D2L), read through its Valence API (`/d2l/api/...`) with the
//! person's own browser session: the `d2lSessionVal` and `d2lSecureSessionVal`
//! cookies their sign-in leaves. No OAuth app, no API token.
//!
//! Which endpoints give the useful data, their shapes, bookmark paging and how a
//! dead session shows itself are adapted from brightspace-mcp-server
//! (https://github.com/RohanMuppa/brightspace-mcp-server), MIT licence,
//! Copyright (c) 2026 Rohan Muppa. That server trades the session for a Bearer
//! token at `/d2l/lp/auth/oauth2/token`; Phaethon doesn't, and sends the session
//! cookies on GETs only. Endpoint details: the Valence docs
//! (https://docs.valence.desire2learn.com).
//!
//! CSRF: D2L's web UI reads its XSRF token from `GET /d2l/lp/auth/xsrf-tokens`
//! (`{"referrerToken": ...}`, cached in localStorage `XSRF.Token`) and sends it
//! as `X-Csrf-Token` (Brightspace/frau-xsrf-token, Apache-2.0). Writes need it;
//! every call here is a GET, which the session cookies alone allow, so
//! `Credential::csrf` stays `None`.
//!
//! A session that has ended shows up as 401, a redirect to `/d2l/login`, a 200
//! HTML page (the `/d2l/login?sessionExpired=1` stub) where JSON was asked for,
//! or 403 from `whoami`: all of them are [`LmsError::SignedOut`].

use super::{
    Announcement, Assignment, Course, CourseContent, Credential, Html, LmsError, LoginNav, Module, Page, RemoteFile, Session,
};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

const SESSION_COOKIES: [&str; 2] = ["d2lSessionVal", "d2lSecureSessionVal"];
/// Bookmark pages followed at most (a server repeating "more" can't loop us).
const MAX_PAGES: usize = 200;
/// Largest HTML topic read into a page.
const MAX_HTML: usize = 5 * 1024 * 1024;

pub fn login_url(base: &Url) -> Url {
    base.join("/d2l/login").expect("login path")
}

/// Signed in once the window is back on the site past the login and auth pages
/// (`/d2l/login`, `/d2l/lp/auth/...` are where SSO lands mid-way, and the login
/// page sets session cookies of its own) and both session cookies hold a value.
pub fn login_result(base: &Url, nav: &LoginNav) -> Option<Credential> {
    let u = nav.url;
    if u.origin() != base.origin() {
        return None;
    }
    let path = u.path().to_ascii_lowercase();
    if !path.starts_with("/d2l/") || path.starts_with("/d2l/login") || path.starts_with("/d2l/logout") || path.starts_with("/d2l/lp/auth/") {
        return None;
    }
    let has = |name: &str| nav.cookies.iter().any(|c| c.name == name && !c.value.is_empty());
    if !SESSION_COOKIES.iter().all(|n| has(n)) {
        return None;
    }
    let cookies = nav.cookies.iter().filter(|c| !c.value.is_empty()).cloned().collect();
    Some(Credential { cookies, csrf: None })
}

// ---- Valence shapes (only the fields read) ----

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProductVersion {
    product_code: String,
    latest_version: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct RichText {
    text: String,
    html: String,
}

impl RichText {
    fn to_html(&self) -> Option<Html> {
        if !self.html.trim().is_empty() {
            Some(self.html.clone())
        } else if !self.text.trim().is_empty() {
            Some(format!("<p>{}</p>", escape(&self.text)))
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Paged<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    paging_info: Option<PagingInfo>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct PagingInfo {
    bookmark: Option<String>,
    has_more_items: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Enrollment {
    org_unit: OrgUnit,
    #[serde(default)]
    access: Access,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct OrgUnit {
    id: u64,
    name: String,
    code: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Access {
    is_active: Option<bool>,
    can_access: Option<bool>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct CourseOffering {
    start_date: Option<String>,
    end_date: Option<String>,
    is_active: Option<bool>,
    semester: Option<Named>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Named {
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Toc {
    modules: Vec<TocModule>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct TocModule {
    title: String,
    sort_order: i64,
    is_hidden: bool,
    modules: Vec<TocModule>,
    topics: Vec<TocTopic>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct TocTopic {
    topic_id: u64,
    type_identifier: String,
    title: String,
    url: Option<String>,
    sort_order: i64,
    is_hidden: bool,
    is_broken: bool,
    /// CONTENTACTIVITYTYPE_T: 1 file, 2 link, 3 dropbox, 4 quiz, 5/6 discussion, 7/27 LTI.
    activity_type: Option<i64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Overview {
    description: Option<RichText>,
    has_attachment: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct DropboxFolder {
    id: u64,
    name: String,
    custom_instructions: Option<RichText>,
    attachments: Vec<FileRef>,
    due_date: Option<String>,
    is_hidden: bool,
    assessment: Option<Assessment>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Assessment {
    score_denominator: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct FileRef {
    file_id: u64,
    file_name: String,
    size: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Quiz {
    quiz_id: u64,
    name: String,
    due_date: Option<String>,
    is_active: Option<bool>,
    description: Option<QuizDescription>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct QuizDescription {
    text: Option<RichText>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ObjectPage<T> {
    objects: Vec<T>,
    next: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct NewsItem {
    id: u64,
    title: String,
    body: Option<RichText>,
    created_date: Option<String>,
    start_date: Option<String>,
    is_published: Option<bool>,
    attachments: Vec<FileRef>,
}

/// The lp and le API versions this site offers (its latest of each).
struct Api {
    lp: String,
    le: String,
}

impl Api {
    async fn discover(s: &Session) -> Result<Api, LmsError> {
        let list: Vec<ProductVersion> = s.get_json("/d2l/api/versions/").await.map_err(|e| match e {
            LmsError::SignedOut | LmsError::Network(_) => e,
            _ => LmsError::Unsupported("This Brightspace site didn’t say which versions of its API it offers.".into()),
        })?;
        let pick = |code: &str| list.iter().find(|v| v.product_code.eq_ignore_ascii_case(code)).map(|v| v.latest_version.clone());
        let ok = |v: &String| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.');
        match (pick("lp"), pick("le")) {
            (Some(lp), Some(le)) if ok(&lp) && ok(&le) => Ok(Api { lp, le }),
            _ => Err(LmsError::Unsupported("This Brightspace site doesn’t offer the parts of its API Phaethon reads.".into())),
        }
    }

    fn lp(&self, path: &str) -> String {
        format!("/d2l/api/lp/{}{path}", self.lp)
    }

    fn le(&self, ou: &str, path: &str) -> String {
        format!("/d2l/api/le/{}/{ou}{path}", self.le)
    }
}

/// Confirms the session still belongs to someone. `whoami` is open to every
/// signed-in user, so any refusal here means the session ended.
async fn whoami(s: &Session, api: &Api) -> Result<(), LmsError> {
    match s.get_json::<serde_json::Value>(&api.lp("/users/whoami")).await {
        Ok(_) => Ok(()),
        Err(LmsError::Forbidden(_) | LmsError::NotFound(_) | LmsError::SignedOut) => Err(LmsError::SignedOut),
        Err(e) => Err(e),
    }
}

pub async fn courses(s: &Session) -> Result<Vec<Course>, LmsError> {
    let api = Api::discover(s).await?;
    whoami(s, &api).await?;

    // orgUnitTypeId=3: course offerings (not departments or semesters).
    let first = api.lp("/enrollments/myenrollments/?orgUnitTypeId=3");
    let mut enrollments: Vec<Enrollment> = Vec::new();
    let mut seen = HashSet::new();
    let mut path = first.clone();
    for _ in 0..MAX_PAGES {
        let page: Paged<Enrollment> = s.get_json(&path).await?;
        enrollments.extend(page.items);
        let Some(info) = page.paging_info else { break };
        match info.bookmark {
            Some(b) if info.has_more_items && !b.is_empty() && seen.insert(b.clone()) => {
                path = format!("{first}&bookmark={}", url::form_urlencoded::byte_serialize(b.as_bytes()).collect::<String>());
            }
            _ => break,
        }
    }

    let mut ids = HashSet::new();
    enrollments.retain(|e| e.access.can_access != Some(false) && ids.insert(e.org_unit.id));

    // The course offering has the semester and its own dates; students can be
    // refused it, and then the enrollment's dates stand.
    let reads: Vec<_> = enrollments
        .iter()
        .map(|e| {
            let path = api.lp(&format!("/courses/{}", e.org_unit.id));
            async move { s.get_json::<CourseOffering>(&path).await }
        })
        .collect();
    let offerings: Vec<Result<CourseOffering, LmsError>> = stream::iter(reads)
    .buffered(4)
    .collect()
    .await;

    let now = now_iso();
    let mut out = Vec::new();
    for (e, off) in enrollments.into_iter().zip(offerings) {
        let off = match off {
            Ok(o) => Some(o),
            Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
            Err(_) => None,
        };
        let start = off.as_ref().and_then(|o| o.start_date.clone()).or(e.access.start_date.clone());
        let end = off.as_ref().and_then(|o| o.end_date.clone()).or(e.access.end_date.clone());
        let active = e.access.is_active.unwrap_or(true) && off.as_ref().and_then(|o| o.is_active).unwrap_or(true);
        let current = active && start.as_deref().is_none_or(|d| !after(d, &now)) && end.as_deref().is_none_or(|d| after(d, &now));
        let term = off.and_then(|o| o.semester).map(|n| n.name).filter(|n| !n.trim().is_empty());
        out.push(Course {
            id: e.org_unit.id.to_string(),
            name: e.org_unit.name,
            code: e.org_unit.code.filter(|c| !c.trim().is_empty()),
            term,
            current,
        });
    }
    Ok(out)
}

pub async fn content(s: &Session, course_id: &str) -> Result<CourseContent, LmsError> {
    // The id goes into paths: digits only.
    if course_id.is_empty() || !course_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(LmsError::NotFound("Your course site couldn’t find this course.".into()));
    }
    let ou = course_id;
    let api = Api::discover(s).await?;
    whoami(s, &api).await?;
    let base = &s.site.base;
    let mut c = CourseContent::default();
    let mut file_urls = HashSet::new();

    // Content: modules and their topics.
    let toc = match s.get_json::<Toc>(&api.le(ou, "/content/toc")).await {
        Ok(t) => t,
        Err(e) => {
            fatal(&e)?;
            c.skipped.push("The course’s content (modules and their files) couldn’t be read.".into());
            Toc::default()
        }
    };
    let mut html_topics: Vec<(String, Url)> = Vec::new();
    let mut syllabus_topic: Option<Html> = None;
    let mut modules = toc.modules;
    walk(s, &api, ou, &mut modules, &[], &mut c, &mut file_urls, &mut html_topics, &mut syllabus_topic);

    // HTML topics become pages, read as the browser would show them so their
    // relative links resolve against the page's own address.
    let reads: Vec<_> = html_topics
        .into_iter()
        .map(|(title, url)| async move {
            let r = fetch_html(s, &url).await;
            (title, url, r)
        })
        .collect();
    let fetched: Vec<(String, Url, Result<String, LmsError>)> = stream::iter(reads)
    .buffered(4)
    .collect()
    .await;
    for (title, url, r) in fetched {
        match r {
            Ok(html) => {
                if syllabus_topic.is_none() && is_syllabus(&title) {
                    syllabus_topic = Some(html.clone());
                }
                c.pages.push(Page { title, html, url: Some(url) });
            }
            Err(e) => {
                fatal(&e)?;
                c.skipped.push(format!("The page “{title}” couldn’t be read."));
            }
        }
    }

    // Syllabus: the course overview (and its attachment), else a content topic called Syllabus.
    match s.get_json::<Overview>(&api.le(ou, "/overview")).await {
        Ok(o) => {
            c.syllabus = o.description.as_ref().and_then(RichText::to_html);
            if o.has_attachment {
                let url = join(base, &api.le(ou, "/overview/attachment"))?;
                let name = attachment_name(s, &url).await?.unwrap_or_else(|| "Syllabus".into());
                let link = format!("<p>Syllabus: <a href=\"{}\">{}</a></p>", escape(url.as_str()), escape(&name));
                c.syllabus = Some(match c.syllabus.take() {
                    Some(h) => format!("{h}\n{link}"),
                    None => link,
                });
                push_file(&mut c, &mut file_urls, RemoteFile { name, folder: None, url, size: None, mime: None, aliases: vec![] });
            }
        }
        Err(e) => fatal(&e)?,
    }
    if c.syllabus.is_none() {
        c.syllabus = syllabus_topic;
    }

    // Assignments (dropbox folders).
    match s.get_json::<FolderList>(&api.le(ou, "/dropbox/folders/")).await {
        Ok(list) => {
            for f in list.into_vec().into_iter().filter(|f| !f.is_hidden) {
                let mut html = f.custom_instructions.as_ref().and_then(RichText::to_html).unwrap_or_default();
                for a in &f.attachments {
                    let url = join(base, &api.le(ou, &format!("/dropbox/folders/{}/attachments/{}", f.id, a.file_id)))?;
                    html.push_str(&format!("\n<p><a href=\"{}\">{}</a></p>", escape(url.as_str()), escape(&a.file_name)));
                    let folder = Some(format!("Assignments/{}", clean(&f.name)));
                    push_file(&mut c, &mut file_urls, RemoteFile { name: clean(&a.file_name), folder, url, size: a.size, mime: None, aliases: vec![] });
                }
                c.assignments.push(Assignment {
                    title: f.name,
                    due: f.due_date,
                    points: f.assessment.and_then(|a| a.score_denominator),
                    html,
                    url: base.join(&format!("/d2l/lms/dropbox/user/folder_submit_files.d2l?db={}&ou={ou}", f.id)).ok(),
                });
            }
        }
        Err(e) => {
            fatal(&e)?;
            c.skipped.push("Assignments couldn’t be read.".into());
        }
    }

    // Quizzes, for their due dates.
    match objects::<Quiz>(s, &api.le(ou, "/quizzes/")).await {
        Ok(qs) => {
            for q in qs.into_iter().filter(|q| q.is_active != Some(false)) {
                c.assignments.push(Assignment {
                    title: q.name,
                    due: q.due_date,
                    points: None,
                    html: q.description.and_then(|d| d.text).as_ref().and_then(RichText::to_html).unwrap_or_default(),
                    url: base.join(&format!("/d2l/lms/quizzing/user/quiz_summary.d2l?qi={}&ou={ou}", q.quiz_id)).ok(),
                });
            }
        }
        Err(e) => {
            fatal(&e)?;
            c.skipped.push("Quizzes couldn’t be read.".into());
        }
    }

    // Announcements (news).
    match s.get_json::<Vec<NewsItem>>(&api.le(ou, "/news/")).await {
        Ok(items) => {
            for n in items.into_iter().filter(|n| n.is_published != Some(false)) {
                let mut html = n.body.as_ref().and_then(RichText::to_html).unwrap_or_default();
                for a in &n.attachments {
                    let url = join(base, &api.le(ou, &format!("/news/{}/attachments/{}", n.id, a.file_id)))?;
                    html.push_str(&format!("\n<p><a href=\"{}\">{}</a></p>", escape(url.as_str()), escape(&a.file_name)));
                    push_file(&mut c, &mut file_urls, RemoteFile {
                        name: clean(&a.file_name),
                        folder: Some("Announcements".into()),
                        url,
                        size: a.size,
                        mime: None,
                        aliases: vec![],
                    });
                }
                c.announcements.push(Announcement { title: n.title, posted: n.start_date.or(n.created_date), html });
            }
        }
        Err(e) => {
            fatal(&e)?;
            c.skipped.push("Announcements couldn’t be read.".into());
        }
    }

    Ok(c)
}

/// Dropbox folders come as a bare list, or as `{Objects: [...]}` on some versions.
#[derive(Deserialize)]
#[serde(untagged)]
enum FolderList {
    List(Vec<DropboxFolder>),
    Paged(ObjectPage<DropboxFolder>),
}

impl FolderList {
    fn into_vec(self) -> Vec<DropboxFolder> {
        match self {
            FolderList::List(v) => v,
            FolderList::Paged(p) => p.objects,
        }
    }
}

/// Every object of an `{Objects, Next}` endpoint. `Next` is a full address or a
/// bookmark; only addresses back into `/d2l/api/` on this site are followed.
async fn objects<T: serde::de::DeserializeOwned + Default>(s: &Session, first: &str) -> Result<Vec<T>, LmsError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut path = first.to_string();
    for _ in 0..MAX_PAGES {
        let page: ObjectPage<T> = s.get_json(&path).await?;
        out.extend(page.objects);
        let Some(next) = page.next.filter(|n| !n.is_empty() && seen.insert(n.clone())) else { break };
        path = if next.starts_with('/') || next.contains("://") {
            match s.site.base.join(&next) {
                Ok(u) if s.site.owns(&u) && u.path().starts_with("/d2l/api/") => {
                    u.query().map_or(u.path().to_string(), |q| format!("{}?{q}", u.path()))
                }
                _ => break,
            }
        } else {
            let sep = if first.contains('?') { '&' } else { '?' };
            format!("{first}{sep}bookmark={}", url::form_urlencoded::byte_serialize(next.as_bytes()).collect::<String>())
        };
    }
    Ok(out)
}

/// Walks the table of contents: each module with topics becomes a [`Module`]
/// named by its path ("Week 1 / Readings"), its file topics files in that
/// folder, its link topics links, its HTML topics pages (fetched afterwards).
#[allow(clippy::too_many_arguments)]
fn walk(
    s: &Session,
    api: &Api,
    ou: &str,
    modules: &mut [TocModule],
    parents: &[String],
    c: &mut CourseContent,
    file_urls: &mut HashSet<Url>,
    html_topics: &mut Vec<(String, Url)>,
    syllabus: &mut Option<Html>,
) {
    let base = &s.site.base;
    modules.sort_by_key(|m| m.sort_order);
    for m in modules.iter_mut().filter(|m| !m.is_hidden) {
        let mut trail = parents.to_vec();
        trail.push(clean(&m.title));
        let folder = trail.join("/");
        let mut items = Vec::new();
        m.topics.sort_by_key(|t| t.sort_order);
        for t in m.topics.iter().filter(|t| !t.is_hidden && !t.is_broken) {
            let kind = topic_kind(t);
            let target = t.url.as_deref().and_then(|u| base.join(u).ok());
            match (kind, target) {
                (TopicKind::File, Some(at)) if s.site.owns(&at) => {
                    if is_html(&at) {
                        html_topics.push((t.title.clone(), at));
                        items.push(t.title.clone());
                        continue;
                    }
                    let Ok(url) = base.join(&api.le(ou, &format!("/content/topics/{}/file", t.topic_id))) else { continue };
                    let name = file_name(&t.title, &at);
                    let mut aliases = vec![at];
                    if let Ok(view) = base.join(&format!("/d2l/le/content/{ou}/viewContent/{}/View", t.topic_id)) {
                        aliases.push(view);
                    }
                    if syllabus.is_none() && is_syllabus(&t.title) {
                        *syllabus = Some(format!("<p>The syllabus is the file <a href=\"{}\">{}</a>.</p>", escape(url.as_str()), escape(&name)));
                    }
                    items.push(name.clone());
                    push_file(c, file_urls, RemoteFile { name, folder: Some(folder.clone()), url, size: None, mime: None, aliases });
                }
                (TopicKind::Link, Some(at)) if !s.site.owns(&at) && matches!(at.scheme(), "https" | "http") => {
                    if syllabus.is_none() && is_syllabus(&t.title) {
                        *syllabus = Some(format!("<p>The syllabus is at <a href=\"{}\">{}</a>.</p>", escape(at.as_str()), escape(&t.title)));
                    }
                    items.push(t.title.clone());
                    c.links.push(super::Link { title: t.title.clone(), url: at });
                }
                // Assignments, quizzes, discussions, tools and links within the site: listed in order only.
                _ => items.push(t.title.clone()),
            }
        }
        if !items.is_empty() || m.modules.is_empty() {
            c.modules.push(Module { name: trail.join(" / "), items });
        }
        walk(s, api, ou, &mut m.modules, &trail, c, file_urls, html_topics, syllabus);
    }
}

#[derive(PartialEq)]
enum TopicKind {
    File,
    Link,
    Other,
}

fn topic_kind(t: &TocTopic) -> TopicKind {
    match (t.activity_type, t.type_identifier.to_ascii_lowercase().as_str()) {
        (Some(1), _) | (None, "file") => TopicKind::File,
        (Some(2), _) | (None, "link") => TopicKind::Link,
        _ => TopicKind::Other,
    }
}

fn push_file(c: &mut CourseContent, seen: &mut HashSet<Url>, f: RemoteFile) {
    if seen.insert(f.url.clone()) {
        c.files.push(f);
    }
}

/// SignedOut and network failures stop the whole read; anything else only skips a part.
fn fatal(e: &LmsError) -> Result<(), LmsError> {
    match e {
        LmsError::SignedOut | LmsError::Network(_) => Err(e.clone()),
        _ => Ok(()),
    }
}

async fn fetch_html(s: &Session, url: &Url) -> Result<String, LmsError> {
    let res = s.get(url).await?;
    if res.url().path().to_ascii_lowercase().starts_with("/d2l/login") {
        return Err(LmsError::SignedOut);
    }
    if res.content_length().is_some_and(|n| n > MAX_HTML as u64) {
        return Err(LmsError::Other("Too large.".into()));
    }
    let body = res.bytes().await.map_err(|e| LmsError::Network(e.to_string()))?;
    if body.len() > MAX_HTML {
        return Err(LmsError::Other("Too large.".into()));
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if text.len() < 4096 && text.contains("/d2l/login?sessionExpired=1") {
        return Err(LmsError::SignedOut);
    }
    Ok(text)
}

/// The name a download from the site carries (`Content-Disposition`), read from its headers only.
async fn attachment_name(s: &Session, url: &Url) -> Result<Option<String>, LmsError> {
    match s.get(url).await {
        Ok(res) => Ok(res
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(disposition_name)
            .map(|n| clean(&n))),
        Err(e) => fatal(&e).map(|_| None),
    }
}

fn disposition_name(v: &str) -> Option<String> {
    let mut plain = None;
    for part in v.split(';').map(str::trim) {
        if let Some(enc) = part.strip_prefix("filename*=") {
            let raw = enc.split("''").nth(1).unwrap_or(enc);
            if let Ok(d) = percent_decode(raw) {
                return Some(d);
            }
        } else if let Some(p) = part.strip_prefix("filename=") {
            plain = Some(p.trim_matches('"').to_string());
        }
    }
    plain.filter(|n| !n.is_empty())
}

fn percent_decode(s: &str) -> Result<String, std::string::FromUtf8Error> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match (b[i], b.get(i + 1).copied().and_then(hex), b.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (c, _, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out)
}

/// A file topic's name: its title, with the file's extension when the title lacks it.
fn file_name(title: &str, at: &Url) -> String {
    let last = at.path_segments().and_then(|mut s| s.next_back()).map(|s| percent_decode(s).unwrap_or_else(|_| s.to_string())).unwrap_or_default();
    let ext = last.rsplit_once('.').map(|(_, e)| e.to_string()).filter(|e| !e.is_empty() && e.len() <= 5);
    let title = clean(title);
    let title = if title.is_empty() { clean(&last) } else { title };
    match ext {
        Some(e) if !title.to_ascii_lowercase().ends_with(&format!(".{}", e.to_ascii_lowercase())) => format!("{title}.{e}"),
        _ => title,
    }
}

fn is_html(u: &Url) -> bool {
    let p = u.path().to_ascii_lowercase();
    p.ends_with(".html") || p.ends_with(".htm")
}

fn is_syllabus(title: &str) -> bool {
    title.to_ascii_lowercase().contains("syllab")
}

/// No path separators or control characters in a name used as a file or folder.
fn clean(name: &str) -> String {
    name.chars().map(|c| if matches!(c, '/' | '\\') || c.is_control() { '-' } else { c }).collect::<String>().trim().to_string()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn join(base: &Url, path: &str) -> Result<Url, LmsError> {
    base.join(path).map_err(|e| LmsError::Other(e.to_string()))
}

/// `a` is later than `b`; both ISO 8601 in UTC as D2L gives them ("2026-12-20T04:59:00.000Z").
fn after(a: &str, b: &str) -> bool {
    let cut = |s: &str| s.get(..19).unwrap_or(s).to_string();
    cut(a) > cut(b)
}

/// Current time as "2026-10-10T14:03:00Z".
fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant), proleptic Gregorian, UTC.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::{Cookie, Kind, Site};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    macro_rules! fx {
        ($name:literal) => {
            include_str!(concat!("../../tests/fixtures/brightspace/", $name))
        };
    }

    struct Reply {
        status: u16,
        ctype: &'static str,
        body: String,
        headers: Vec<(&'static str, String)>,
    }

    fn json(body: &str) -> Reply {
        Reply { status: 200, ctype: "application/json; charset=utf-8", body: body.into(), headers: vec![] }
    }
    fn html(body: &str) -> Reply {
        Reply { status: 200, ctype: "text/html; charset=utf-8", body: body.into(), headers: vec![] }
    }
    fn status(code: u16) -> Reply {
        Reply { status: code, ctype: "application/json", body: String::new(), headers: vec![] }
    }
    fn redirect(to: &str) -> Reply {
        Reply { status: 302, ctype: "text/html", body: String::new(), headers: vec![("location", to.into())] }
    }

    /// Requests seen: (path and query, Cookie header).
    type Log = Arc<Mutex<Vec<(String, Option<String>)>>>;

    /// A fake Brightspace answering `routes` by exact path and query (anything else: 404).
    async fn serve(routes: HashMap<String, Reply>) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = Arc::new(routes);
        let log: Log = Arc::default();
        let seen = log.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (routes, seen) = (routes.clone(), seen.clone());
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
                    let text = String::from_utf8_lossy(&req).into_owned();
                    let target = text.split_whitespace().nth(1).unwrap_or("").to_string();
                    let cookie = text.lines().find_map(|l| l.to_ascii_lowercase().starts_with("cookie:").then(|| l[7..].trim().to_string()));
                    seen.lock().unwrap().push((target.clone(), cookie));
                    let missing = status(404);
                    let r = routes.get(&target).unwrap_or(&missing);
                    let extra: String = r.headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
                    let head = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n",
                        r.status,
                        r.ctype,
                        r.body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(r.body.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });
        (base, log)
    }

    const LP: &str = "/d2l/api/lp/1.49";
    const LE: &str = "/d2l/api/le/1.82/6606";
    const COOKIES: &str = "d2lSessionVal=s3ss10n; d2lSecureSessionVal=s3cur3";

    fn site_routes() -> HashMap<String, Reply> {
        let mut r = HashMap::new();
        r.insert("/d2l/api/versions/".into(), json(fx!("versions.json")));
        r.insert(format!("{LP}/users/whoami"), json(fx!("whoami.json")));
        r.insert(format!("{LP}/enrollments/myenrollments/?orgUnitTypeId=3"), json(fx!("enrollments-1.json")));
        r.insert(format!("{LP}/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=6606"), json(fx!("enrollments-2.json")));
        r.insert(format!("{LP}/courses/6606"), json(fx!("course-6606.json")));
        // Students are often refused course offering details.
        r.insert(format!("{LP}/courses/6610"), status(403));
        r.insert(format!("{LE}/content/toc"), json(fx!("toc.json")));
        r.insert("/content/enforced/6606-M301-F26-12345/Week1/welcome.html".into(), html(fx!("welcome.html")));
        r.insert(format!("{LE}/overview"), json(fx!("overview.json")));
        r.insert(
            format!("{LE}/overview/attachment"),
            Reply {
                status: 200,
                ctype: "application/pdf",
                body: "%PDF-1.4\n".into(),
                headers: vec![("content-disposition", "attachment; filename=\"M301 Syllabus Fall 2026.pdf\"".into())],
            },
        );
        r.insert(format!("{LE}/dropbox/folders/"), json(fx!("dropbox.json")));
        r.insert(format!("{LE}/quizzes/"), json(fx!("quizzes.json")));
        r.insert(format!("{LE}/quizzes/?bookmark=QB-8"), json(fx!("quizzes-2.json")));
        r.insert(format!("{LE}/news/"), json(fx!("news.json")));
        r.insert("/d2l/login?sessionExpired=1".into(), html(fx!("login-stub.html")));
        r
    }

    fn session(base: &str) -> Session {
        let cookies = COOKIES
            .split("; ")
            .map(|kv| {
                let (n, v) = kv.split_once('=').unwrap();
                Cookie { name: n.into(), value: v.into() }
            })
            .collect();
        Session::new(Site::for_test(Kind::Brightspace, base), Credential { cookies, csrf: None })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn courses_follow_the_bookmark_and_read_the_semester() {
        let (base, log) = serve(site_routes()).await;
        let list = courses(&session(&base)).await.unwrap();

        assert_eq!(list.len(), 2, "the course the person can't open yet is left out: {list:?}");
        assert_eq!(
            list[0],
            Course { id: "6606".into(), name: "Calculus II".into(), code: Some("M301-F26-12345".into()), term: Some("Fall 2026".into()), current: true }
        );
        // Offering refused: no semester, and the enrollment's dates (ended in 2025) decide.
        assert_eq!(list[1].id, "6610");
        assert_eq!(list[1].term, None);
        assert!(!list[1].current);

        let log = log.lock().unwrap();
        assert!(log.iter().any(|(p, _)| p.ends_with("orgUnitTypeId=3&bookmark=6606")), "second page asked for by bookmark");
        assert!(log.iter().all(|(_, c)| c.as_deref() == Some(COOKIES)), "every request carries the session: {log:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn content_reads_modules_files_pages_links_assignments_and_news() {
        let (base, _) = serve(site_routes()).await;
        let c = content(&session(&base), "6606").await.unwrap();
        let b = Url::parse(&base).unwrap();
        assert!(c.skipped.is_empty(), "{:?}", c.skipped);

        // Modules in SortOrder, nested ones by path, hidden topics left out.
        let mods: Vec<(&str, Vec<&str>)> = c.modules.iter().map(|m| (m.name.as_str(), m.items.iter().map(String::as_str).collect())).collect();
        assert_eq!(
            mods,
            vec![
                ("Week 1: Integration review", vec!["Course Syllabus.pdf", "Welcome"]),
                ("Week 1: Integration review / Readings", vec!["OpenStax Calculus Volume 2", "Section 3.1 notes.pdf"]),
                ("Week 2: Series", vec!["Homework 1 (submit here)", "Pearson MyLab"]),
            ]
        );

        // File topics download through the topic file route; the content path is an alias.
        let notes = c.files.iter().find(|f| f.name == "Section 3.1 notes.pdf").expect("notes file");
        assert_eq!(notes.folder.as_deref(), Some("Week 1: Integration review/Readings"));
        assert_eq!(notes.url, b.join(&format!("{LE}/content/topics/1102/file")).unwrap());
        assert!(notes.aliases.contains(&b.join("/content/enforced/6606-M301-F26-12345/Week1/Readings/3.1%20notes.pdf").unwrap()));
        assert!(notes.aliases.contains(&b.join("/d2l/le/content/6606/viewContent/1102/View").unwrap()));
        assert!(!c.files.iter().any(|f| f.name.contains("Answer key")));
        let names: Vec<(&str, Option<&str>)> = c.files.iter().map(|f| (f.name.as_str(), f.folder.as_deref())).collect();
        for want in [
            ("Course Syllabus.pdf", Some("Week 1: Integration review")),
            ("M301 Syllabus Fall 2026.pdf", None),
            ("hw1.pdf", Some("Assignments/Homework 1")),
            ("Week 1 slides.pptx", Some("Announcements")),
        ] {
            assert!(names.contains(&want), "{want:?} in {names:?}");
        }
        assert_eq!(c.files.len(), 5);
        let hw = c.files.iter().find(|f| f.name == "hw1.pdf").unwrap();
        assert_eq!(hw.url, b.join(&format!("{LE}/dropbox/folders/41/attachments/9001")).unwrap());
        let slides = c.files.iter().find(|f| f.name == "Week 1 slides.pptx").unwrap();
        assert_eq!(slides.url, b.join(&format!("{LE}/news/501/attachments/77")).unwrap());

        // HTML topics are pages, kept at their own address so relative links resolve.
        assert_eq!(c.pages.len(), 1);
        assert_eq!(c.pages[0].title, "Welcome");
        assert!(c.pages[0].html.contains("Welcome to Calculus II"));
        assert_eq!(c.pages[0].url, Some(b.join("/content/enforced/6606-M301-F26-12345/Week1/welcome.html").unwrap()));

        // External links only; links into the site (a dropbox quicklink, an LTI tool) aren't.
        assert_eq!(c.links.len(), 1);
        assert_eq!(c.links[0].url.as_str(), "https://openstax.org/details/books/calculus-volume-2");

        // The overview is the syllabus, with its attachment linked.
        let syl = c.syllabus.as_deref().unwrap();
        assert!(syl.contains("integration techniques"));
        assert!(syl.contains(&format!("{LE}/overview/attachment")) && syl.contains("M301 Syllabus Fall 2026.pdf"));

        // Dropbox folders (hidden left out) and active quizzes across both pages.
        let a: Vec<(&str, Option<&str>)> = c.assignments.iter().map(|a| (a.title.as_str(), a.due.as_deref())).collect();
        assert_eq!(
            a,
            vec![
                ("Homework 1", Some("2026-09-05T03:59:00.000Z")),
                ("Final project draft", None),
                ("Quiz 1: Integration by parts", Some("2026-09-12T03:59:00.000Z")),
                ("Quiz 2: Series", Some("2026-10-03T03:59:00.000Z")),
            ]
        );
        assert_eq!(c.assignments[0].points, Some(20.0));
        assert!(c.assignments[0].html.contains("1&ndash;15 odd") && c.assignments[0].html.contains("hw1.pdf"));
        assert_eq!(c.assignments[0].url, b.join("/d2l/lms/dropbox/user/folder_submit_files.d2l?db=41&ou=6606").ok());
        assert_eq!(c.assignments[3].html, "<p>Covers chapter 5</p>");

        // Published news only, dated by when it showed.
        assert_eq!(c.announcements.len(), 1);
        assert_eq!(c.announcements[0].title, "Welcome to M301");
        assert_eq!(c.announcements[0].posted.as_deref(), Some("2026-08-24T13:00:00.000Z"));
        assert!(c.announcements[0].html.contains("<strong>Tuesdays</strong>") && c.announcements[0].html.contains("Week 1 slides.pptx"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn syllabus_falls_back_to_the_topic_and_refused_parts_are_skipped() {
        let mut r = site_routes();
        r.remove(&format!("{LE}/overview"));
        r.insert(format!("{LE}/dropbox/folders/"), status(403));
        r.insert(format!("{LE}/news/"), status(500));
        let (base, _) = serve(r).await;
        let c = content(&session(&base), "6606").await.unwrap();

        let syl = c.syllabus.unwrap();
        assert!(syl.contains(&format!("{LE}/content/topics/1001/file")) && syl.contains("Course Syllabus.pdf"), "{syl}");
        assert_eq!(c.skipped, vec!["Assignments couldn’t be read.".to_string(), "Announcements couldn’t be read.".to_string()]);
        assert_eq!(c.assignments.len(), 2, "quizzes still read");
        assert_eq!(c.modules.len(), 3);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_ended_session_is_signed_out() {
        let whoami = format!("{LP}/users/whoami");
        type Case = (&'static str, fn() -> Reply);
        let cases: Vec<Case> = vec![
            ("whoami refused", || status(403)),
            ("whoami 401", || status(401)),
            ("redirect to the login page", || redirect("/d2l/login?sessionExpired=1")),
            ("login stub instead of JSON", || html(fx!("login-stub.html"))),
        ];
        for (what, reply) in cases {
            let mut r = site_routes();
            r.insert(whoami.clone(), reply());
            let (base, _) = serve(r).await;
            assert_eq!(courses(&session(&base)).await.unwrap_err(), LmsError::SignedOut, "courses: {what}");
            assert_eq!(content(&session(&base), "6606").await.unwrap_err(), LmsError::SignedOut, "content: {what}");
        }

        // Mid-read: the table of contents, an HTML topic bounced to the login page, a later page of enrollments.
        let mut r = site_routes();
        r.insert(format!("{LE}/content/toc"), status(401));
        let (base, _) = serve(r).await;
        assert_eq!(content(&session(&base), "6606").await.unwrap_err(), LmsError::SignedOut);
        let mut r = site_routes();
        r.insert("/content/enforced/6606-M301-F26-12345/Week1/welcome.html".into(), redirect("/d2l/login?sessionExpired=1"));
        let (base, _) = serve(r).await;
        assert_eq!(content(&session(&base), "6606").await.unwrap_err(), LmsError::SignedOut);
        let mut r = site_routes();
        r.insert(format!("{LP}/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=6606"), html(fx!("login-stub.html")));
        let (base, _) = serve(r).await;
        assert_eq!(courses(&session(&base)).await.unwrap_err(), LmsError::SignedOut);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_course_id_is_digits_only() {
        let (base, log) = serve(site_routes()).await;
        for bad in ["", "../6606", "6606/content", "66 06"] {
            assert!(matches!(content(&session(&base), bad).await, Err(LmsError::NotFound(_))), "{bad:?}");
        }
        assert!(log.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_versions_offered_is_unsupported() {
        let mut r = site_routes();
        r.insert("/d2l/api/versions/".into(), json(r#"[{"ProductCode":"lp","LatestVersion":"1.49","SupportedVersions":[]}]"#));
        let (base, _) = serve(r).await;
        assert!(matches!(courses(&session(&base)).await, Err(LmsError::Unsupported(_))));
    }

    fn cookie(name: &str, value: &str) -> Cookie {
        Cookie { name: name.into(), value: value.into() }
    }

    #[test]
    fn signed_in_only_past_the_login_with_both_session_cookies() {
        let base = Url::parse("https://school.brightspace.com").unwrap();
        assert_eq!(login_url(&base).as_str(), "https://school.brightspace.com/d2l/login");
        let both = [cookie("d2lSessionVal", "a"), cookie("d2lSecureSessionVal", "b"), cookie("clientId", "c"), cookie("empty", "")];
        let at = |u: &str, cookies: &[Cookie]| {
            let url = Url::parse(u).unwrap();
            login_result(&base, &LoginNav { url: &url, cookies })
        };

        let got = at("https://school.brightspace.com/d2l/home", &both).expect("signed in");
        assert_eq!(got.csrf, None);
        assert_eq!(got.cookies, both[..3].to_vec(), "keeps every cookie with a value");
        assert!(at("https://school.brightspace.com/d2l/home/6606", &both).is_some());

        // The login page and SSO hops set session cookies before sign-in finishes.
        assert!(at("https://school.brightspace.com/d2l/login", &both).is_none());
        assert!(at("https://school.brightspace.com/d2l/login?sessionExpired=1", &both).is_none());
        assert!(at("https://school.brightspace.com/d2l/lp/auth/login/ProcessLoginActions.d2l", &both).is_none());
        assert!(at("https://school.brightspace.com/d2l/lp/auth/saml/initiate-login?entityId=x", &both).is_none());
        assert!(at("https://school.brightspace.com/d2l/logout", &both).is_none());
        // Still at the school's identity provider, or another origin with the same path.
        assert!(at("https://login.microsoftonline.com/d2l/home", &both).is_none());
        assert!(at("http://school.brightspace.com/d2l/home", &both).is_none());
        // One cookie missing or empty.
        assert!(at("https://school.brightspace.com/d2l/home", &both[..1]).is_none());
        assert!(at("https://school.brightspace.com/d2l/home", &[cookie("d2lSessionVal", "a"), cookie("d2lSecureSessionVal", "")]).is_none());
    }

    #[test]
    fn names_from_titles_and_headers() {
        let at = Url::parse("https://s.example/content/enforced/1-X/Week1/3.1%20notes.pdf").unwrap();
        assert_eq!(file_name("Section 3.1 notes", &at), "Section 3.1 notes.pdf");
        assert_eq!(file_name("notes.PDF", &at), "notes.PDF");
        assert_eq!(file_name("Unit 1/2 slides", &at), "Unit 1-2 slides.pdf");
        assert_eq!(file_name("", &at), "3.1 notes.pdf");
        assert_eq!(disposition_name("attachment; filename=\"Syllabus.pdf\""), Some("Syllabus.pdf".into()));
        assert_eq!(disposition_name("attachment; filename=\"x.pdf\"; filename*=UTF-8''Caf%C3%A9%20syllabus.pdf"), Some("Café syllabus.pdf".into()));
        assert_eq!(disposition_name("inline"), None);
        assert!(after("2026-12-20T04:59:00.000Z", "2026-10-10T14:03:00Z"));
        assert!(!after("2025-05-10T03:59:00.000Z", "2026-10-10T14:03:00Z"));
    }
}
