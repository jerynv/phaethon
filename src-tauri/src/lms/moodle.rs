//! Moodle, through the person's own signed-in session: no web service token.
//!
//! Which data to ask for follows the open-source Moodle MCP servers, which use a
//! web service token instead:
//! - moodle-mcp-server, https://github.com/peancor/moodle-mcp-server, MIT,
//!   Copyright (c) 2025 peancor (courses, assignments, forums).
//! - moodle-mcp, https://github.com/linomck/moodle-mcp (no licence file: function
//!   names only, nothing copied).
//!
//! Their functions (`core_course_get_contents`, `mod_assign_get_assignments`,
//! `core_enrol_get_users_courses`) are token-only. Moodle's own pages call
//! functions marked `'ajax' => true` in `db/services.php` through
//! `lib/ajax/service.php`, with the session cookie and the page's `sesskey`; this
//! module does the same with those (checked against Moodle 4.5):
//! `core_course_get_enrolled_courses_by_timeline_classification` (the course
//! list), `core_courseformat_get_state` (sections and activities, Moodle 4.0+),
//! `core_calendar_get_action_events_by_course` (due dates) and
//! `mod_forum_get_discussion_posts` (announcements). Everything else is read
//! from the course's own pages: the course page when the state call isn't there,
//! and each activity's view page. Read-only throughout. Grades come from the
//! person's own user report page (see `grades`).

use super::{
    Announcement, Assignment, Course, CourseContent, CourseGrades, Credential, GradeGroup, GradeItem, GradeSummary, Link, LmsError, LoginNav, Module, Page,
    RemoteFile, Session,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use url::Url;

/// Newest discussions read from the announcements forum.
const MAX_ANNOUNCEMENTS: usize = 30;

pub fn login_url(base: &Url) -> Url {
    base.join("login/index.php").unwrap_or_else(|_| base.clone())
}

/// Pages on the site where the person isn't through signing in yet (the login
/// form, SSO return pages, multi-factor, the site policy to accept).
const SIGNING_IN: [&str; 5] = ["/login/", "/auth/", "/admin/tool/mfa/", "/admin/tool/policy/", "/user/policy.php"];

/// Signed in once the window is back on the site, past the sign-in pages, with a
/// `MoodleSession…` cookie (the name takes the site's `sessioncookie` suffix).
/// The sesskey lives in the page, not the URL or cookies, so it's read later.
pub fn login_result(base: &Url, nav: &LoginNav) -> Option<Credential> {
    if nav.url.origin() != base.origin() {
        return None;
    }
    let path = nav.url.path();
    if SIGNING_IN.iter().any(|p| path.contains(p)) {
        return None;
    }
    if !nav.cookies.iter().any(|c| c.name.starts_with("MoodleSession") && !c.value.is_empty()) {
        return None;
    }
    Some(Credential { cookies: nav.cookies.to_vec(), csrf: None })
}

pub async fn courses(s: &Session) -> Result<Vec<Course>, LmsError> {
    let key = sesskey(s).await?;
    let now = now();
    Ok(enrolled(s, &key)
        .await?
        .into_iter()
        .map(|c| Course {
            id: c.id.to_string(),
            name: text(&c.fullname),
            code: Some(text(&c.shortname)).filter(|t| !t.is_empty()),
            term: c.coursecategory.as_deref().map(text).filter(|t| !t.is_empty()),
            current: c.startdate <= now && (c.enddate == 0 || c.enddate > now),
        })
        .collect())
}

pub async fn content(s: &Session, course_id: &str) -> Result<CourseContent, LmsError> {
    let id: u64 = course_id.parse().map_err(|_| LmsError::NotFound("That course isn’t on your course site.".into()))?;
    let key = sesskey(s).await?;
    let base = &s.site.base;
    let mut out = CourseContent::default();

    let state = match ajax::<String>(s, &key, "core_courseformat_get_state", json!({ "courseid": id })).await {
        Ok(st) => parse_state(base, &st),
        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
        Err(_) => None,
    };
    let outline = match state {
        Some(o) => o,
        None => parse_course_page(base, &page(s, &join(base, &format!("course/view.php?id={id}"))?).await?),
    };

    let summary = match enrolled(s, &key).await {
        Ok(list) => list.into_iter().find(|c| c.id == id).map(|c| c.summary).filter(|h| !text(h).is_empty()),
        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
        Err(_) => None,
    };
    let dues = match due_dates(s, &key, id).await {
        Ok(d) => d,
        Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
        Err(_) => HashMap::new(),
    };

    // The announcements forum: one named so, else the first forum in the top section
    // (where Moodle puts it), not discussion forums that can run to hundreds of posts.
    let forums: Vec<&Cm> = outline.iter().flat_map(|sec| sec.cms.iter()).filter(|c| c.modname == "forum").collect();
    let news: Vec<u64> = {
        let named: Vec<u64> = forums.iter().filter(|c| is_news_name(&c.name)).map(|c| c.id).collect();
        if !named.is_empty() {
            named
        } else {
            outline.first().and_then(|sec| sec.cms.iter().find(|c| c.modname == "forum")).map(|c| vec![c.id]).unwrap_or_default()
        }
    };

    let mut seen_files = HashSet::new();
    let mut syllabus_file = None;
    for sec in &outline {
        let mut items = Vec::new();
        for cm in &sec.cms {
            if cm.modname != "label" {
                items.push(cm.name.clone());
            }
            let got = match cm.modname.as_str() {
                "resource" => resource(s, cm, &sec.name).await.map(|f| {
                    if syllabus_file.is_none() && cm.name.to_lowercase().contains("syllabus") {
                        syllabus_file = Some((cm.name.clone(), f.url.clone()));
                    }
                    if seen_files.insert(f.url.clone()) {
                        out.files.push(f);
                    }
                }),
                "folder" => folder(s, cm, &sec.name).await.map(|fs| {
                    for f in fs {
                        if seen_files.insert(f.url.clone()) {
                            out.files.push(f);
                        }
                    }
                }),
                "page" => activity_page(s, cm).await.map(|html| out.pages.push(Page { title: cm.name.clone(), html, url: Some(cm.url.clone()) })),
                "url" => url_target(s, cm).await.map(|u| {
                    if let Some(url) = u {
                        out.links.push(Link { title: cm.name.clone(), url });
                    }
                }),
                "assign" => page(s, &cm.url).await.map(|html| {
                    out.assignments.push(Assignment {
                        title: cm.name.clone(),
                        due: dues.get(&cm.id).map(|t| rfc3339(*t)),
                        points: None,
                        html: main_region(&html).to_string(),
                        url: Some(cm.url.clone()),
                    })
                }),
                "forum" if news.contains(&cm.id) => announcements(s, &key, cm).await.map(|a| out.announcements.extend(a)),
                _ => Ok(()),
            };
            match got {
                Ok(()) => {}
                Err(LmsError::SignedOut) => return Err(LmsError::SignedOut),
                Err(e) => out.skipped.push(format!("“{}”: {e}", cm.name)),
            }
        }
        out.modules.push(Module { name: sec.name.clone(), items });
    }

    out.syllabus = out
        .pages
        .iter()
        .find(|p| p.title.to_lowercase().contains("syllabus"))
        .map(|p| p.html.clone())
        .or_else(|| syllabus_file.map(|(name, url)| format!("<p><a href=\"{}\">{}</a></p>", escape(url.as_str()), escape(&name))))
        .or(summary);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Talking to the site

/// GET a page on the site as text. Landing on the login page (a redirect there)
/// or a page for someone not signed in means the session ended.
async fn page(s: &Session, url: &Url) -> Result<String, LmsError> {
    let res = s.get(url).await?;
    if res.url().path().contains("/login/") {
        return Err(LmsError::SignedOut);
    }
    let html = res.text().await.map_err(|e| LmsError::Network(e.to_string()))?;
    let signed_out = open_tags(&html, "body").first().is_some_and(|&(a, b)| attr(&html[a..b], "class").is_some_and(|c| has_word(&c, "notloggedin")));
    if signed_out {
        return Err(LmsError::SignedOut);
    }
    Ok(html)
}

/// The session's `sesskey`, from `M.cfg` on the person's dashboard. The login
/// window only sees addresses and cookies, so it's read here on each use.
async fn sesskey(s: &Session) -> Result<String, LmsError> {
    let html = page(s, &join(&s.site.base, "my/")?).await?;
    find_sesskey(&html).ok_or(LmsError::SignedOut)
}

fn find_sesskey(html: &str) -> Option<String> {
    let at = html.find("\"sesskey\":\"")? + "\"sesskey\":\"".len();
    let key: String = html[at..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (!key.is_empty() && html[at + key.len()..].starts_with('"')).then_some(key)
}

/// Call one AJAX-enabled function the way Moodle's own pages do.
async fn ajax<T: serde::de::DeserializeOwned>(s: &Session, key: &str, method: &str, args: Value) -> Result<T, LmsError> {
    let path = format!("lib/ajax/service.php?sesskey={key}&info={method}");
    let body = json!([{ "index": 0, "methodname": method, "args": args }]);
    let v: Value = s.post_json(&path, &body, None).await?;
    let one = match v {
        Value::Array(mut a) if !a.is_empty() => a.swap_remove(0),
        // The whole request failed before any function ran.
        Value::Object(o) => {
            let code = o.get("errorcode").and_then(Value::as_str).unwrap_or("");
            let msg = o.get("error").and_then(Value::as_str).unwrap_or("");
            return Err(ajax_error(code, msg));
        }
        _ => return Err(LmsError::Other("Your course site sent something unexpected.".into())),
    };
    if one.get("error").and_then(Value::as_bool).unwrap_or(false) {
        let ex = one.get("exception").cloned().unwrap_or(Value::Null);
        return Err(ajax_error(ex.get("errorcode").and_then(Value::as_str).unwrap_or(""), ex.get("message").and_then(Value::as_str).unwrap_or("")));
    }
    serde_json::from_value(one.get("data").cloned().unwrap_or(Value::Null))
        .map_err(|e| LmsError::Other(format!("Your course site sent something unexpected: {e}")))
}

fn ajax_error(code: &str, message: &str) -> LmsError {
    match code {
        "servicerequireslogin" | "invalidsesskey" | "sessionerroruser" | "sessiontimedout" => LmsError::SignedOut,
        "requireloginerror" | "nopermissions" | "accessdenied" | "notenrolled" => LmsError::Forbidden("Your course site didn’t allow this.".into()),
        "servicenotavailable" => LmsError::Unsupported("Your course site doesn’t offer this.".into()),
        _ if message.is_empty() => LmsError::Other(format!("Your course site answered with an error ({code}).")),
        _ => LmsError::Other(format!("Your course site answered with an error: {}", text(message))),
    }
}

#[derive(Deserialize)]
struct Enrolled {
    courses: Vec<MoodleCourse>,
}

#[derive(Deserialize)]
struct MoodleCourse {
    id: u64,
    fullname: String,
    #[serde(default)]
    shortname: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    startdate: i64,
    #[serde(default)]
    enddate: i64,
    #[serde(default)]
    coursecategory: Option<String>,
}

/// Every course the person is enrolled in, including ones they hid on their
/// dashboard (`allincludinghidden`, Moodle 3.9+; older sites: `all`).
async fn enrolled(s: &Session, key: &str) -> Result<Vec<MoodleCourse>, LmsError> {
    const F: &str = "core_course_get_enrolled_courses_by_timeline_classification";
    match ajax::<Enrolled>(s, key, F, json!({ "classification": "allincludinghidden", "limit": 0, "offset": 0 })).await {
        Ok(e) => Ok(e.courses),
        Err(LmsError::SignedOut) => Err(LmsError::SignedOut),
        Err(_) => Ok(ajax::<Enrolled>(s, key, F, json!({ "classification": "all", "limit": 0, "offset": 0 })).await?.courses),
    }
}

#[derive(Deserialize)]
struct Events {
    #[serde(default)]
    events: Vec<Event>,
}

#[derive(Deserialize)]
struct Event {
    id: u64,
    #[serde(default)]
    timesort: i64,
    #[serde(default)]
    url: String,
    #[serde(default)]
    eventtype: String,
}

/// Due dates by activity id, from the course's action events (what the
/// timeline block shows: things still to do, overdue ones included).
async fn due_dates(s: &Session, key: &str, course: u64) -> Result<HashMap<u64, i64>, LmsError> {
    const PAGE: usize = 50;
    let mut out = HashMap::new();
    let mut after = 0;
    for _ in 0..10 {
        let got: Events = ajax(s, key, "core_calendar_get_action_events_by_course", json!({ "courseid": course, "aftereventid": after, "limitnum": PAGE })).await?;
        for e in &got.events {
            if e.eventtype != "due" && e.eventtype != "duedate" && !e.url.contains("/mod/assign/") {
                continue;
            }
            if let Some(cm) = Url::parse(&decode_entities(&e.url)).ok().as_ref().and_then(|u| query_id(u, "id")) {
                out.entry(cm).or_insert(e.timesort);
            }
        }
        match got.events.last() {
            Some(last) if got.events.len() >= PAGE => after = last.id,
            _ => break,
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
struct Posts {
    #[serde(default)]
    posts: Vec<Post>,
}

#[derive(Deserialize)]
struct Post {
    #[serde(default)]
    subject: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    timecreated: i64,
    #[serde(default)]
    hasparent: bool,
}

/// The forum's newest discussions (listed on its page), each with its opening post.
async fn announcements(s: &Session, key: &str, cm: &Cm) -> Result<Vec<Announcement>, LmsError> {
    let html = page(s, &cm.url).await?;
    let mut ids = Vec::new();
    for (a, b) in open_tags(&html, "a") {
        let Some(href) = attr(&html[a..b], "href") else { continue };
        let Some(u) = cm.url.join(&href).ok().filter(|u| u.path().ends_with("/mod/forum/discuss.php")) else { continue };
        if let Some(d) = query_id(&u, "d").filter(|d| !ids.contains(d)) {
            ids.push(d);
        }
    }
    let mut out = Vec::new();
    for d in ids.into_iter().take(MAX_ANNOUNCEMENTS) {
        let got: Posts = ajax(s, key, "mod_forum_get_discussion_posts", json!({ "discussionid": d, "sortby": "created", "sortdirection": "ASC" })).await?;
        if let Some(p) = got.posts.iter().find(|p| !p.hasparent).or(got.posts.first()) {
            out.push(Announcement { title: text(&p.subject), posted: (p.timecreated > 0).then(|| rfc3339(p.timecreated)), html: p.message.clone() });
        }
    }
    Ok(out)
}

/// A file activity: its view page (`forceview` so it shows rather than
/// redirects) names the file at `pluginfile.php`. If it can't be found there,
/// the view address with `redirect=1` still leads to the file.
async fn resource(s: &Session, cm: &Cm, section: &str) -> Result<RemoteFile, LmsError> {
    let mut view = cm.url.clone();
    view.query_pairs_mut().append_pair("forceview", "1");
    let html = page(s, &view).await?;
    let folder = Some(section.to_string()).filter(|f| !f.is_empty());
    let mut redirect = cm.url.clone();
    redirect.query_pairs_mut().append_pair("redirect", "1");
    let found = plugin_files(&html, &cm.url, "/mod_resource/content/").into_iter().next();
    Ok(match found {
        Some((url, _, name)) => RemoteFile { name, folder, url, size: None, mime: None, aliases: vec![cm.url.clone(), redirect] },
        None => RemoteFile { name: cm.name.clone(), folder, url: redirect, size: None, mime: None, aliases: vec![cm.url.clone()] },
    })
}

/// A folder activity: every file it lists, keeping its subfolders.
async fn folder(s: &Session, cm: &Cm, section: &str) -> Result<Vec<RemoteFile>, LmsError> {
    let html = page(s, &cm.url).await?;
    Ok(plugin_files(&html, &cm.url, "/mod_folder/content/")
        .into_iter()
        .map(|(url, sub, name)| {
            let parts: Vec<&str> = [section, cm.name.as_str()].into_iter().chain(sub.iter().map(String::as_str)).filter(|p| !p.is_empty()).collect();
            RemoteFile { name, folder: Some(parts.join("/")), url, size: None, mime: None, aliases: vec![] }
        })
        .collect())
}

/// A page activity's own text (the box under its title), else the page's main region.
async fn activity_page(s: &Session, cm: &Cm) -> Result<String, LmsError> {
    let html = page(s, &cm.url).await?;
    let main = main_region(&html);
    let boxed = open_tags(main, "div")
        .into_iter()
        .find(|&(a, b)| attr(&main[a..b], "class").is_some_and(|c| has_word(&c, "generalbox")))
        .and_then(|(a, b)| inner(main, a, b, "div"));
    Ok(boxed.map(|(a, b)| main[a..b].trim().to_string()).unwrap_or_else(|| main.trim().to_string()))
}

/// A link activity's target, from its view page (`forceview`: the "click the
/// link" page, or the embed/frame page). `None` when it points back into the site.
async fn url_target(s: &Session, cm: &Cm) -> Result<Option<Url>, LmsError> {
    let mut view = cm.url.clone();
    view.query_pairs_mut().append_pair("forceview", "1");
    let html = page(s, &view).await?;
    let external = |raw: Option<String>| raw.and_then(|h| cm.url.join(&h).ok()).filter(|u| matches!(u.scheme(), "http" | "https"));
    // "Click <a>…</a> link to open resource."
    if let Some((a, b)) = open_tags(&html, "div").into_iter().find(|&(a, b)| attr(&html[a..b], "class").is_some_and(|c| has_word(&c, "urlworkaround")))
        && let Some((ia, ib)) = inner(&html, a, b, "div")
    {
        let region = &html[ia..ib];
        let u = open_tags(region, "a").into_iter().find_map(|(x, y)| external(attr(&region[x..y], "href")));
        if let Some(u) = u {
            return Ok(Some(u).filter(|u| !s.site.owns(u)));
        }
    }
    // Embedded or framed: the first address off the site.
    let main = main_region(&html);
    for (region, tag, name) in [(main, "a", "href"), (main, "iframe", "src"), (main, "object", "data"), (html.as_str(), "frame", "src")] {
        if let Some(u) = open_tags(region, tag).into_iter().find_map(|(x, y)| external(attr(&region[x..y], name)).filter(|u| !s.site.owns(u))) {
            return Ok(Some(u));
        }
    }
    Err(LmsError::NotFound("Couldn’t find where this link goes.".into()))
}

// ---------------------------------------------------------------------------
// The course outline: sections and their activities

#[derive(Debug, Clone, PartialEq)]
struct Cm {
    id: u64,
    modname: String,
    name: String,
    url: Url,
}

#[derive(Debug, Clone, PartialEq)]
struct Section {
    name: String,
    cms: Vec<Cm>,
}

fn id_of(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// `core_courseformat_get_state`'s JSON: sections in order, each listing its
/// activities by id. Activities the person can't open are left out.
fn parse_state(base: &Url, raw: &str) -> Option<Vec<Section>> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let mut cms = HashMap::new();
    for c in v.get("cm")?.as_array()? {
        let Some(id) = c.get("id").and_then(id_of) else { continue };
        if c.get("uservisible").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let modname = c.get("module").and_then(Value::as_str).unwrap_or("").to_string();
        let url = c
            .get("url")
            .and_then(Value::as_str)
            .and_then(|u| base.join(&decode_entities(u)).ok())
            .or_else(|| base.join(&format!("mod/{modname}/view.php?id={id}")).ok())?;
        cms.insert(id, Cm { id, name: text(c.get("name").and_then(Value::as_str).unwrap_or("")), modname, url });
    }
    let mut out = Vec::new();
    for sec in v.get("section")?.as_array()? {
        let name = text(sec.get("title").and_then(Value::as_str).unwrap_or(""));
        let list = sec.get("cmlist").and_then(Value::as_array).map(|l| l.iter().filter_map(id_of).filter_map(|id| cms.get(&id).cloned()).collect()).unwrap_or_default();
        out.push(Section { name, cms: list });
    }
    Some(out)
}

/// The course page itself (`course/view.php`), for sites without the state call:
/// `<li id="section-N">` with its `sectionname` heading, holding
/// `<li id="module-N" class="activity modtype_X">` items (Boost and Classic, 3.x and 4.x).
fn parse_course_page(base: &Url, html: &str) -> Vec<Section> {
    let mut out = Vec::new();
    for (a, b) in open_tags(html, "li") {
        let tag = &html[a..b];
        let Some(n) = attr(tag, "id").and_then(|id| id.strip_prefix("section-").map(str::to_string)) else { continue };
        if n.parse::<u64>().is_err() {
            continue;
        }
        let Some((ia, ib)) = inner(html, a, b, "li") else { continue };
        let body = &html[ia..ib];
        let heading = ["h3", "h2", "h4"].iter().find_map(|h| {
            open_tags(body, h)
                .into_iter()
                .find(|&(x, y)| attr(&body[x..y], "class").is_some_and(|c| has_word(&c, "sectionname")))
                .and_then(|(x, y)| inner(body, x, y, h))
                .map(|(x, y)| text(&body[x..y]))
        });
        let name = heading.filter(|h| !h.is_empty()).or_else(|| attr(tag, "aria-label")).unwrap_or_else(|| format!("Section {n}"));
        let mut cms = Vec::new();
        for (x, y) in open_tags(body, "li") {
            let mtag = &body[x..y];
            let Some(id) = attr(mtag, "id").and_then(|i| i.strip_prefix("module-").and_then(|n| n.parse::<u64>().ok())) else { continue };
            let Some(modname) = attr(mtag, "class").and_then(|c| c.split_whitespace().find_map(|w| w.strip_prefix("modtype_").map(str::to_string))) else { continue };
            let Some((mx, my)) = inner(body, x, y, "li") else { continue };
            let item = &body[mx..my];
            let url = open_tags(item, "a")
                .into_iter()
                .filter_map(|(p, q)| attr(&item[p..q], "href"))
                .filter_map(|h| base.join(&h).ok())
                .find(|u| u.path().contains(&format!("/mod/{modname}/view.php")))
                .or_else(|| base.join(&format!("mod/{modname}/view.php?id={id}")).ok());
            let Some(url) = url else { continue };
            let name = instance_name(item).unwrap_or_default();
            if name.is_empty() && modname != "label" {
                continue;
            }
            cms.push(Cm { id, modname, name, url });
        }
        out.push(Section { name, cms });
    }
    out
}

/// `<span class="instancename">Name<span class="accesshide"> File</span></span>`.
fn instance_name(item: &str) -> Option<String> {
    let (a, b) = open_tags(item, "span").into_iter().find(|&(a, b)| attr(&item[a..b], "class").is_some_and(|c| has_word(&c, "instancename")))?;
    let (ia, ib) = inner(item, a, b, "span")?;
    let mut s = item[ia..ib].to_string();
    while let Some((x, y)) = open_tags(&s, "span").into_iter().find(|&(x, y)| attr(&s[x..y], "class").is_some_and(|c| has_word(&c, "accesshide"))) {
        let end = inner(&s, x, y, "span").map(|(_, e)| e + "</span>".len()).unwrap_or(y);
        s.replace_range(x..end.min(s.len()), "");
    }
    Some(text(&s))
}

fn is_news_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("announcement") || n.contains("news")
}

/// Files at `pluginfile.php/<context>/<area>/<revision or item>/<path…>/<name>` in a
/// page: (address without `forcedownload`, subfolders, decoded name), first seen first.
fn plugin_files(html: &str, page_url: &Url, area: &str) -> Vec<(Url, Vec<String>, String)> {
    let mut out: Vec<(Url, Vec<String>, String)> = Vec::new();
    for tag in ["a", "img", "object", "iframe", "frame", "embed", "source"] {
        for (a, b) in open_tags(html, tag) {
            for name in ["href", "src", "data"] {
                let Some(mut u) = attr(&html[a..b], name).and_then(|h| page_url.join(&h).ok()) else { continue };
                let path = u.path().to_string();
                let Some(at) = path.find(area).filter(|_| path.contains("/pluginfile.php/")) else { continue };
                let mut segs: Vec<String> = path[at + area.len()..].split('/').skip(1).filter(|p| !p.is_empty()).map(percent_decode).collect();
                let Some(file) = segs.pop() else { continue };
                u.set_query(None);
                u.set_fragment(None);
                if !out.iter().any(|(o, _, _)| *o == u) {
                    out.push((u, segs, file));
                }
            }
        }
    }
    out
}

/// The page's main content: Moodle's `<div role="main">`, else `#region-main`, else the body.
fn main_region(html: &str) -> &str {
    let found = open_tags(html, "div")
        .into_iter()
        .find(|&(a, b)| attr(&html[a..b], "role").as_deref() == Some("main"))
        .and_then(|(a, b)| inner(html, a, b, "div"))
        .or_else(|| {
            open_tags(html, "section").into_iter().find(|&(a, b)| attr(&html[a..b], "id").as_deref() == Some("region-main")).and_then(|(a, b)| inner(html, a, b, "section"))
        })
        .or_else(|| open_tags(html, "body").first().and_then(|&(a, b)| inner(html, a, b, "body")));
    found.map(|(a, b)| &html[a..b]).unwrap_or(html)
}

// ---------------------------------------------------------------------------
// Small helpers: just enough HTML reading for Moodle's own markup.

/// Every opening `<name …>` tag: (start, index after its `>`).
fn open_tags(html: &str, name: &str) -> Vec<(usize, usize)> {
    let pat = format!("<{name}");
    let bytes = html.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = html[i..].find(&pat) {
        let start = i + p;
        let after = start + pat.len();
        if matches!(bytes.get(after), Some(b) if b.is_ascii_whitespace() || *b == b'>' || *b == b'/') {
            let Some(end) = tag_end(html, after) else { break };
            out.push((start, end));
            i = end;
        } else {
            i = after;
        }
    }
    out
}

/// Index just past the `>` that closes a tag, skipping quoted attribute values.
fn tag_end(html: &str, from: usize) -> Option<usize> {
    let mut quote = None;
    for (i, b) in html.as_bytes()[from..].iter().enumerate() {
        match (quote, *b) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(*b),
            (None, b'>') => return Some(from + i + 1),
            _ => {}
        }
    }
    None
}

/// The content between an opening tag (start `a`, end `b`) and its matching close.
fn inner(html: &str, a: usize, b: usize, name: &str) -> Option<(usize, usize)> {
    if html[a..b].ends_with("/>") {
        return None;
    }
    let open = format!("<{name}");
    let close = format!("</{name}");
    let bytes = html.as_bytes();
    let mut depth = 1;
    let mut i = b;
    loop {
        let next_close = html[i..].find(&close).map(|p| i + p)?;
        let next_open = html[i..next_close].find(&open).map(|p| i + p).filter(|&p| {
            matches!(bytes.get(p + open.len()), Some(c) if c.is_ascii_whitespace() || *c == b'>')
        });
        match next_open {
            Some(p) => {
                let end = tag_end(html, p + open.len())?;
                if !html[p..end].ends_with("/>") {
                    depth += 1;
                }
                i = end;
            }
            None => {
                depth -= 1;
                if depth == 0 {
                    return Some((b, next_close));
                }
                i = next_close + close.len();
            }
        }
    }
}

/// An attribute's value from an opening tag, entities decoded.
fn attr(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut i = tag.find(|c: char| c.is_ascii_whitespace())?;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        let ns = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && !matches!(bytes[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        let key = &tag[ns..i];
        if key.is_empty() {
            return None;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = "";
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            match bytes.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    let end = tag[i + 1..].find(q as char).map(|p| i + 1 + p).unwrap_or(tag.len());
                    value = &tag[i + 1..end];
                    i = end + 1;
                }
                _ => {
                    let vs = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                        i += 1;
                    }
                    value = &tag[vs..i];
                }
            }
        }
        if key.eq_ignore_ascii_case(name) {
            return Some(decode_entities(value));
        }
    }
    None
}

fn has_word(list: &str, word: &str) -> bool {
    list.split_whitespace().any(|w| w == word)
}

/// Plain text from HTML: tags dropped, entities decoded, whitespace collapsed.
fn text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let end = rest[..rest.len().min(12)].find(';');
        let decoded = end.and_then(|e| {
            let ent = &rest[1..e];
            let c = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                _ => ent
                    .strip_prefix("#x")
                    .or_else(|| ent.strip_prefix("#X"))
                    .map(|h| u32::from_str_radix(h, 16).ok())
                    .unwrap_or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_id(u: &Url, key: &str) -> Option<u64> {
    u.query_pairs().find(|(k, _)| k == key).and_then(|(_, v)| v.parse().ok())
}

fn join(base: &Url, path: &str) -> Result<Url, LmsError> {
    base.join(path).map_err(|e| LmsError::Other(e.to_string()))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Unix seconds as RFC 3339 in UTC.
fn rfc3339(t: i64) -> String {
    let days = t.div_euclid(86_400);
    let secs = t.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

// ---------------------------------------------------------------------------
// Grades
//
// Moodle's grade functions (`gradereport_user_get_grade_items`,
// `gradereport_user_get_grades_table`) are open to the mobile app's token only,
// not to AJAX (Moodle 4.5's grade/report/user/db/services.php has no `ajax`
// flag), so the person's own user report page is read instead:
// `grade/report/user/index.php?id=<course>`, the table Moodle draws for them.
// Each cell carries `column-<name>` (itemname, weight, grade, range,
// percentage, lettergrade, feedback) and `headers` naming its category; a
// category's header cell has the id `cat_<id>_<user>`. Grades hidden from the
// person show as "-" (or aren't there at all) and stay absent.

pub async fn grades(s: &Session, course_id: &str) -> Result<CourseGrades, LmsError> {
    let id: u64 = course_id.parse().map_err(|_| LmsError::NotFound("That course isn’t on your course site.".into()))?;
    let html = match page(s, &join(&s.site.base, &format!("grade/report/user/index.php?id={id}"))?).await {
        Ok(h) => h,
        Err(e) => return super::grades_refused(e),
    };
    Ok(parse_user_report(&html))
}

/// One cell of the report: its classes, `id`, `headers` and inner HTML.
struct Cell<'a> {
    class: String,
    id: String,
    headers: String,
    html: &'a str,
}

impl Cell<'_> {
    fn is(&self, column: &str) -> bool {
        has_word(&self.class, &format!("column-{column}"))
    }
}

fn parse_user_report(html: &str) -> CourseGrades {
    let Some(table) = open_tags(html, "table")
        .into_iter()
        .find(|&(a, b)| attr(&html[a..b], "class").is_some_and(|c| has_word(&c, "user-grade")))
        .and_then(|(a, b)| inner(html, a, b, "table"))
        .map(|(a, b)| &html[a..b])
    else {
        return CourseGrades { note: Some(super::GRADES_HIDDEN.into()), ..Default::default() };
    };
    let mut out = CourseGrades::default();
    // Category id → name (the course's own top category isn't a group).
    let mut cats: Vec<(String, String)> = Vec::new();
    let mut top: Option<String> = None;
    let mut weights: HashMap<String, f64> = HashMap::new();
    for (a, b) in open_tags(table, "tr") {
        let Some((ra, rb)) = inner(table, a, b, "tr") else { continue };
        let row = &table[ra..rb];
        let mut cells: Vec<(usize, Cell)> = Vec::new();
        for name in ["th", "td"] {
            for (ca, cb) in open_tags(row, name) {
                let tag = &row[ca..cb];
                let Some((ia, ib)) = inner(row, ca, cb, name) else { continue };
                cells.push((ca, Cell { class: attr(tag, "class").unwrap_or_default(), id: attr(tag, "id").unwrap_or_default(), headers: attr(tag, "headers").unwrap_or_default(), html: &row[ia..ib] }));
            }
        }
        cells.sort_by_key(|(at, _)| *at);
        let cells: Vec<Cell> = cells.into_iter().map(|(_, c)| c).collect();
        // (The column headings' row has `header` cells.)
        let Some(name) = cells.iter().find(|c| c.is("itemname") && !has_word(&c.class, "header")) else { continue };
        let cat_of = |c: &Cell| c.headers.split_whitespace().find(|h| h.starts_with("cat_")).map(|h| h.split('_').nth(1).unwrap_or("").to_string());
        let col = |n: &str| cells.iter().find(|c| c.is(n)).map(|c| text(c.html)).filter(|t| !t.is_empty() && t != "-");

        if has_word(&name.class, "category") {
            let cid = name.id.split('_').nth(1).unwrap_or("").to_string();
            let title = text(name.html);
            if top.is_none() {
                top = Some(cid);
            } else if !title.is_empty() {
                cats.push((cid, title));
            }
            continue;
        }
        let kind = if name.html.contains("courseitem") {
            "course"
        } else if name.html.contains("categoryitem") || ["baggt", "baggb"].iter().any(|w| has_word(&name.class, w)) {
            "category"
        } else {
            "item"
        };
        let header_cat = cells.iter().find_map(cat_of);
        let grade_text = col("grade");
        let score = grade_text.as_deref().and_then(number);
        let possible = col("range").as_deref().and_then(|r| r.split(['–', '-', '—']).filter_map(number).next_back());
        let percent = col("percentage").as_deref().and_then(number).or_else(|| super::percent_of(score, possible));
        let letter = col("lettergrade");
        match kind {
            "course" => {
                out.current = GradeSummary { percent, letter, points: score, possible: possible.filter(|_| score.is_some()) };
            }
            "category" => {
                // A category's total row: its weight in the course is the group's weight.
                if let (Some(c), Some(w)) = (header_cat, col("weight").as_deref().and_then(number)) {
                    weights.insert(c, w);
                }
            }
            _ => {
                let title = row_title(name.html);
                if title.is_empty() {
                    continue;
                }
                let submitted_only = grade_text.as_deref().is_some_and(|g| score.is_none() && g.to_lowercase().starts_with("submitted"));
                let shown = grade_text.filter(|g| score.is_none() && !submitted_only && !g.eq_ignore_ascii_case("error"));
                let feedback = cells.iter().find(|c| c.is("feedback")).map(|c| text(c.html)).filter(|t| !t.is_empty());
                out.items.push(GradeItem {
                    title,
                    group: header_cat.filter(|c| Some(c) != top.as_ref()).and_then(|c| cats.iter().find(|(id, _)| *id == c).map(|(_, n)| n.clone())),
                    score,
                    possible,
                    percent: if score.is_some() { percent } else { None },
                    grade: shown.clone(),
                    submitted: submitted_only,
                    graded: score.is_some() || shown.is_some(),
                    comments: feedback.into_iter().collect(),
                    ..Default::default()
                });
            }
        }
    }
    out.groups = cats.into_iter().map(|(id, name)| GradeGroup { weight: weights.get(&id).copied(), name }).collect();
    out
}

/// The item's name: Moodle 4's `rowtitle`, else the grade item link (3.x), else the cell's text.
fn row_title(cell: &str) -> String {
    let by_class = |tag: &str, class: &str| {
        open_tags(cell, tag)
            .into_iter()
            .find(|&(a, b)| attr(&cell[a..b], "class").is_some_and(|c| has_word(&c, class)))
            .and_then(|(a, b)| inner(cell, a, b, tag))
            .map(|(a, b)| text(&cell[a..b]))
    };
    by_class("div", "rowtitle").or_else(|| by_class("a", "gradeitemheader")).or_else(|| by_class("span", "gradeitemheader")).unwrap_or_else(|| text(cell))
}

/// A number as Moodle prints it ("85.00", "85,00 %", "1,234.5"), or none.
fn number(s: &str) -> Option<f64> {
    let t: String = s.trim().trim_end_matches('%').trim().chars().filter(|c| !c.is_whitespace()).collect();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-')) {
        return None;
    }
    let t = if t.contains('.') { t.replace(',', "") } else { t.replace(',', ".") };
    t.parse().ok()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod grade_tests;
