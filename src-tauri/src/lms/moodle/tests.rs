//! Moodle against a local fake site: the dashboard carrying `M.cfg`'s sesskey,
//! the AJAX service (results and errors in Moodle's own shapes), and the
//! course and activity pages used when a function isn't open to AJAX.

use super::*;
use crate::lms::{Cookie, Kind, Site};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SESSKEY: &str = "Xq7Lm2Pz9K";

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    cookie: Option<String>,
    body: String,
}

#[derive(Clone, Copy, Default)]
struct Behaviour {
    /// Dashboard redirects to the login page.
    signed_out: bool,
    /// `core_courseformat_get_state` isn't there (an older site): read the course page.
    no_state: bool,
    /// Every AJAX call fails with this error code.
    ajax_error: Option<&'static str>,
    /// The state lists one more page, which the site no longer has.
    gone_page: bool,
}

struct Fake {
    base: String,
    log: Arc<Mutex<Vec<Req>>>,
}

impl Fake {
    fn requests(&self) -> Vec<Req> {
        self.log.lock().unwrap().clone()
    }
    fn session(&self) -> Session {
        let site = Site::for_test(Kind::Moodle, &self.base);
        Session::new(site, Credential { cookies: vec![cookie("MoodleSession", "s3ss10n"), cookie("BIGipServerMoodle", "lb1")], csrf: None })
    }
}

fn cookie(name: &str, value: &str) -> Cookie {
    Cookie { name: name.into(), value: value.into() }
}

fn fixture(name: &str, base: &str) -> String {
    let raw = match name {
        "my" => include_str!("fixtures/my.html"),
        "login" => include_str!("fixtures/login.html"),
        "course" => include_str!("fixtures/course.html"),
        "resource" => include_str!("fixtures/resource.html"),
        "page" => include_str!("fixtures/page.html"),
        "url" => include_str!("fixtures/url.html"),
        "assign" => include_str!("fixtures/assign.html"),
        "forum" => include_str!("fixtures/forum.html"),
        "folder" => include_str!("fixtures/folder.html"),
        _ => unreachable!(),
    };
    raw.replace("{BASE_ESCAPED}", &base.replace('/', "\\/")).replace("{BASE}", base)
}

fn ok(data: Value) -> Value {
    json!([{ "error": false, "data": data }])
}

fn err(code: &str) -> Value {
    json!([{ "error": true, "exception": { "message": format!("Error: {code}"), "errorcode": code, "link": "", "moreinfourl": "" } }])
}

fn courses_json() -> Value {
    json!({
        "courses": [
            { "id": 7, "fullname": "C241 Discrete Structures for Computer Science", "shortname": "C241-FA26", "idnumber": "",
              "summary": "<p>Logic, sets, proofs &amp; counting.</p>", "summaryformat": 1, "startdate": 1_756_684_800, "enddate": 0,
              "visible": true, "fullnamedisplay": "C241 Discrete Structures for Computer Science", "viewurl": "", "hidden": false,
              "coursecategory": "Fall 2026" },
            { "id": 3, "fullname": "M211 Calculus I", "shortname": "M211-SP26", "summary": "", "startdate": 1_735_689_600,
              "enddate": 1_747_000_000, "visible": true, "hidden": true, "coursecategory": "Spring 2026" },
            { "id": 9, "fullname": "Research &amp; Writing", "shortname": "", "summary": "", "startdate": 4_102_444_800_i64, "enddate": 0, "coursecategory": "" }
        ],
        "nextoffset": 3
    })
}

/// What `core_courseformat_get_state` returns: a JSON string. Ids come as strings,
/// as PHP sends database ids.
fn state_json(base: &str) -> String {
    json!({
        "course": { "id": "7", "numsections": 1, "sectionlist": ["50", "51"], "editmode": false, "highlighted": "Highlighted", "baseurl": format!("{base}/course/view.php?id=7") },
        "section": [
            { "id": "50", "section": 0, "number": 0, "title": "General", "hassummary": false, "rawtitle": null, "cmlist": ["100", "101", "102"], "visible": true, "sectionurl": format!("{base}/course/section.php?id=50") },
            { "id": "51", "section": 1, "number": 1, "title": "Week 1: Logic &amp; Proofs", "hassummary": true, "rawtitle": "Week 1: Logic & Proofs", "cmlist": ["103", "104", "105", "106", "107"], "visible": true, "sectionurl": format!("{base}/course/section.php?id=51") }
        ],
        "cm": [
            { "id": "100", "anchor": "module-100", "name": "Announcements", "visible": true, "uservisible": true, "sectionid": "50", "sectionnumber": 0, "modname": "Forum", "module": "forum", "plugin": "mod_forum", "url": format!("{base}/mod/forum/view.php?id=100") },
            { "id": "101", "anchor": "module-101", "name": "Course syllabus", "visible": true, "uservisible": true, "sectionid": "50", "module": "resource", "url": format!("{base}/mod/resource/view.php?id=101") },
            { "id": "102", "anchor": "module-102", "name": "Office hours: Tue 2–4pm", "visible": true, "uservisible": true, "sectionid": "50", "module": "label" },
            { "id": "103", "anchor": "module-103", "name": "Reading guide", "visible": true, "uservisible": true, "sectionid": "51", "module": "page", "url": format!("{base}/mod/page/view.php?id=103") },
            { "id": "104", "anchor": "module-104", "name": "Open textbook: Discrete Math", "visible": true, "uservisible": true, "sectionid": "51", "module": "url", "url": format!("{base}/mod/url/view.php?id=104") },
            { "id": "105", "anchor": "module-105", "name": "Homework 1", "visible": true, "uservisible": true, "sectionid": "51", "module": "assign", "url": format!("{base}/mod/assign/view.php?id=105") },
            { "id": "106", "anchor": "module-106", "name": "Lecture slides", "visible": true, "uservisible": true, "sectionid": "51", "module": "folder", "url": format!("{base}/mod/folder/view.php?id=106") },
            { "id": "107", "anchor": "module-107", "name": "Quiz 1 (opens after Homework 1)", "visible": true, "uservisible": false, "sectionid": "51", "module": "quiz", "url": format!("{base}/mod/quiz/view.php?id=107") }
        ]
    })
    .to_string()
}

fn events_json(base: &str) -> Value {
    json!({
        "events": [
            { "id": 5001, "name": "Homework 1 is due", "modulename": "assign", "instance": 31, "eventtype": "due",
              "timestart": 1_792_295_940, "timesort": 1_792_295_940, "overdue": false,
              "url": format!("{base}/mod/assign/view.php?id=105"), "action": { "name": "Add submission", "url": "", "itemcount": 1, "actionable": true } }
        ],
        "firstid": 5001,
        "lastid": 5001
    })
}

fn posts_json(discussion: u64) -> Value {
    let (subject, message, at) = match discussion {
        902 => ("Test 1 moved", "<p>Test 1 is now on <strong>October 16</strong>.</p>", 1_791_554_400),
        _ => ("Welcome to C241", "<p>Welcome! The syllabus is in General.</p>", 1_787_576_400),
    };
    json!({
        "posts": [
            { "id": discussion * 10, "subject": subject, "replysubject": format!("Re: {subject}"), "message": message, "messageformat": 1,
              "author": { "id": 2, "fullname": "Prof. Ada Lovelace" }, "discussionid": discussion, "hasparent": false, "parentid": null,
              "timecreated": at, "timemodified": at, "unread": null, "isdeleted": false },
            { "id": discussion * 10 + 1, "subject": format!("Re: {subject}"), "message": "<p>Thanks!</p>", "discussionid": discussion,
              "hasparent": true, "parentid": discussion * 10, "timecreated": at + 60 }
        ],
        "forumid": 12,
        "courseid": 7,
        "ratinginfo": { "contextid": 400, "component": "mod_forum", "ratingarea": "post", "canviewall": null, "canviewany": null, "scales": [], "ratings": [] }
    })
}

fn route(b: Behaviour, base: &str, req: &Req) -> (u16, &'static str, String, Option<String>) {
    let html = |name: &str| (200, "text/html; charset=utf-8", fixture(name, base), None);
    let (path, query) = req.path.split_once('?').unwrap_or((&req.path, ""));
    match (req.method.as_str(), path) {
        ("GET", "/my/") if b.signed_out => (303, "text/html", String::new(), Some(format!("{base}/login/index.php"))),
        ("GET", "/my/") => html("my"),
        ("GET", "/login/index.php") => html("login"),
        ("POST", "/lib/ajax/service.php") => {
            let q: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
            let calls: Value = serde_json::from_str(&req.body).unwrap();
            let call = &calls[0];
            assert_eq!(q.get("info").map(String::as_str), call["methodname"].as_str(), "info names the function");
            let out = if q.get("sesskey").map(String::as_str) != Some(SESSKEY) {
                err("invalidsesskey")
            } else if let Some(code) = b.ajax_error {
                err(code)
            } else {
                match call["methodname"].as_str().unwrap() {
                    "core_course_get_enrolled_courses_by_timeline_classification" => ok(courses_json()),
                    "core_courseformat_get_state" if b.no_state => err("servicenotavailable"),
                    "core_courseformat_get_state" if b.gone_page => {
                        let mut state: Value = serde_json::from_str(&state_json(base)).unwrap();
                        state["cm"].as_array_mut().unwrap().push(json!({ "id": "108", "name": "Gone page", "uservisible": true, "module": "page", "url": format!("{base}/mod/page/view.php?id=108") }));
                        state["section"][1]["cmlist"].as_array_mut().unwrap().push(json!("108"));
                        ok(Value::String(state.to_string()))
                    }
                    "core_courseformat_get_state" => ok(Value::String(state_json(base))),
                    "core_calendar_get_action_events_by_course" => ok(events_json(base)),
                    "mod_forum_get_discussion_posts" => ok(posts_json(call["args"]["discussionid"].as_u64().unwrap())),
                    _ => err("servicenotavailable"),
                }
            };
            (200, "application/json; charset=utf-8", out.to_string(), None)
        }
        ("GET", "/course/view.php") if query == "id=7" => html("course"),
        ("GET", "/mod/resource/view.php") if query == "id=101&forceview=1" => html("resource"),
        ("GET", "/mod/page/view.php") if query == "id=103" => html("page"),
        ("GET", "/mod/url/view.php") if query == "id=104&forceview=1" => html("url"),
        ("GET", "/mod/assign/view.php") if query == "id=105" => html("assign"),
        ("GET", "/mod/forum/view.php") if query == "id=100" => html("forum"),
        ("GET", "/mod/folder/view.php") if query == "id=106" => html("folder"),
        _ => (404, "text/html", "<h1>Not found</h1>".into(), None),
    }
}

async fn fake(b: Behaviour) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let (served, at) = (log.clone(), base.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let (log, base) = (served.clone(), at.clone());
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 8192];
                let (head, body) = loop {
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len: usize = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                        if raw.len() >= h + 4 + len {
                            break (text[..h].to_string(), text[h + 4..].to_string());
                        }
                    }
                };
                let mut first = head.lines().next().unwrap().split(' ');
                let req = Req {
                    method: first.next().unwrap().to_string(),
                    path: first.next().unwrap().to_string(),
                    cookie: head.lines().find_map(|l| l.strip_prefix("cookie: ").map(str::to_string)),
                    body,
                };
                let (status, ctype, out, location) = route(b, &base, &req);
                log.lock().unwrap().push(req);
                let loc = location.map(|l| format!("location: {l}\r\n")).unwrap_or_default();
                let head = format!("HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\n{loc}content-length: {}\r\nconnection: close\r\n\r\n", out.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(out.as_bytes()).await;
            });
        }
    });
    Fake { base, log }
}

// --- signing in -------------------------------------------------------------

#[test]
fn login_opens_the_sites_own_login_page() {
    let base = Url::parse("https://moodle.iu.edu").unwrap();
    assert_eq!(login_url(&base).as_str(), "https://moodle.iu.edu/login/index.php");
}

#[test]
fn signed_in_only_back_on_the_site_past_the_login_pages_with_a_session() {
    let base = Url::parse("https://moodle.iu.edu").unwrap();
    let session = [cookie("MoodleSession", "abc"), cookie("MOODLEID1_", "x")];
    let at = |u: &str, cookies: &[Cookie]| login_result(&base, &LoginNav { url: &Url::parse(u).unwrap(), cookies });

    // The login form already carries a (guest) session cookie: not yet.
    assert_eq!(at("https://moodle.iu.edu/login/index.php", &session), None);
    // The school's SSO, its return page, multi-factor and the site policy: not yet.
    assert_eq!(at("https://idp.iu.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1", &session), None);
    assert_eq!(at("https://moodle.iu.edu/auth/saml2/sp/saml2-acs.php/moodle.iu.edu", &session), None);
    assert_eq!(at("https://moodle.iu.edu/admin/tool/mfa/auth.php", &session), None);
    assert_eq!(at("https://moodle.iu.edu/user/policy.php", &session), None);
    // Another site with the same path, or no session cookie: not signed in.
    assert_eq!(at("https://evil.example/my/", &session), None);
    assert_eq!(at("https://moodle.iu.edu/my/", &[cookie("MOODLEID1_", "x")]), None);
    assert_eq!(at("https://moodle.iu.edu/my/", &[cookie("MoodleSession", "")]), None);

    let got = at("https://moodle.iu.edu/my/", &session).expect("signed in");
    assert_eq!(got.cookies, session.to_vec());
    assert_eq!(got.csrf, None, "the sesskey is read from a page later");
    // A site's own cookie name suffix (`$CFG->sessioncookie`).
    assert!(at("https://moodle.iu.edu/", &[cookie("MoodleSessionprod", "abc")]).is_some());
}

// --- courses ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn courses_through_the_ajax_service_with_the_pages_sesskey() {
    let f = fake(Behaviour::default()).await;
    let list = courses(&f.session()).await.unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(
        list[0],
        Course { id: "7".into(), name: "C241 Discrete Structures for Computer Science".into(), code: Some("C241-FA26".into()), term: Some("Fall 2026".into()), current: true }
    );
    assert!(!list[1].current, "ended");
    assert!(!list[2].current, "starts in 2100");
    assert_eq!(list[2].name, "Research & Writing");
    assert_eq!((list[2].code.as_deref(), list[2].term.as_deref()), (None, None));

    let reqs = f.requests();
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("GET", "/my/"));
    let call = &reqs[1];
    assert_eq!(call.method, "POST");
    assert_eq!(call.path, format!("/lib/ajax/service.php?sesskey={SESSKEY}&info=core_course_get_enrolled_courses_by_timeline_classification"));
    let body: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(body[0]["index"], 0);
    assert_eq!(body[0]["args"]["classification"], "allincludinghidden");
    for r in &reqs {
        assert_eq!(r.cookie.as_deref(), Some("MoodleSession=s3ss10n; BIGipServerMoodle=lb1"), "{}", r.path);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dashboard_that_sends_you_to_log_in_means_signed_out() {
    let f = fake(Behaviour { signed_out: true, ..Default::default() }).await;
    assert_eq!(courses(&f.session()).await, Err(LmsError::SignedOut));
    assert_eq!(content(&f.session(), "7").await.unwrap_err(), LmsError::SignedOut);
    assert!(f.requests().iter().all(|r| r.method == "GET"), "nothing posted without a sesskey");
}

#[tokio::test(flavor = "multi_thread")]
async fn ajax_session_errors_mean_signed_out_and_others_say_what_happened() {
    for code in ["servicerequireslogin", "invalidsesskey"] {
        let f = fake(Behaviour { ajax_error: Some(code), ..Default::default() }).await;
        assert_eq!(courses(&f.session()).await, Err(LmsError::SignedOut), "{code}");
        assert_eq!(content(&f.session(), "7").await.unwrap_err(), LmsError::SignedOut, "{code}");
    }
    let f = fake(Behaviour { ajax_error: Some("requireloginerror"), ..Default::default() }).await;
    assert!(matches!(courses(&f.session()).await, Err(LmsError::Forbidden(_))));
    // An error for the whole request (before any function ran) is an object, not a list.
    assert_eq!(ajax_error("invalidsesskey", ""), LmsError::SignedOut);
    assert!(matches!(ajax_error("servicenotavailable", ""), LmsError::Unsupported(_)));
    assert_eq!(ajax_error("x", "Can&#39;t do that"), LmsError::Other("Your course site answered with an error: Can't do that".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_course_id_that_isnt_a_number_is_refused_before_any_request() {
    let f = fake(Behaviour::default()).await;
    assert!(matches!(content(&f.session(), "../admin").await, Err(LmsError::NotFound(_))));
    assert!(f.requests().is_empty());
}

// --- content ----------------------------------------------------------------

fn check_content(c: &CourseContent, base: &str) {
    let names: Vec<(&str, Vec<&str>)> = c.modules.iter().map(|m| (m.name.as_str(), m.items.iter().map(String::as_str).collect())).collect();
    assert_eq!(
        names,
        vec![
            ("General", vec!["Announcements", "Course syllabus"]),
            ("Week 1: Logic & Proofs", vec!["Reading guide", "Open textbook: Discrete Math", "Homework 1", "Lecture slides"]),
        ]
    );

    let files: Vec<(&str, Option<&str>, &str)> = c.files.iter().map(|f| (f.name.as_str(), f.folder.as_deref(), f.url.as_str())).collect();
    let syllabus = format!("{base}/pluginfile.php/401/mod_resource/content/3/C241%20Syllabus%20Fall%202026.pdf");
    let l1 = format!("{base}/pluginfile.php/406/mod_folder/content/0/Lecture%201%20-%20Propositions.pdf");
    let l3 = format!("{base}/pluginfile.php/406/mod_folder/content/0/Week%202/Lecture%203%20-%20Sets.pptx");
    assert_eq!(
        files,
        vec![
            ("C241 Syllabus Fall 2026.pdf", Some("General"), syllabus.as_str()),
            ("Lecture 1 - Propositions.pdf", Some("Week 1: Logic & Proofs/Lecture slides"), l1.as_str()),
            ("Lecture 3 - Sets.pptx", Some("Week 1: Logic & Proofs/Lecture slides/Week 2"), l3.as_str()),
        ]
    );
    let aliases: Vec<&str> = c.files[0].aliases.iter().map(Url::as_str).collect();
    assert!(aliases.contains(&format!("{base}/mod/resource/view.php?id=101").as_str()), "{aliases:?}");

    assert_eq!(c.pages.len(), 1);
    let page = &c.pages[0];
    assert_eq!(page.title, "Reading guide");
    assert_eq!(page.url.as_ref().unwrap().as_str(), format!("{base}/mod/page/view.php?id=103"));
    assert!(page.html.starts_with("<div class=\"no-overflow\"><p>Read <strong>chapters 1&ndash;2</strong>"), "{}", page.html);
    assert!(page.html.contains("ISBN 978-0-9940479-1-4") && page.html.contains("/mod_page/content/2/solutions.pdf"));
    assert!(!page.html.contains("Last modified"), "only the page's own text");

    assert_eq!(c.links.len(), 1);
    assert_eq!(c.links[0].title, "Open textbook: Discrete Math");
    assert_eq!(c.links[0].url.as_str(), "https://discrete.openmathbooks.org/pdfs/dmoi4.pdf");

    assert_eq!(c.assignments.len(), 1);
    let a = &c.assignments[0];
    assert_eq!((a.title.as_str(), a.due.as_deref()), ("Homework 1", Some("2026-10-18T03:59:00Z")));
    assert!(a.html.contains("Problems 1.1–1.12") && a.html.contains("Due:"), "{}", a.html);
    assert!(!a.html.contains("Powered by Moodle"));

    let ann: Vec<(&str, Option<&str>)> = c.announcements.iter().map(|a| (a.title.as_str(), a.posted.as_deref())).collect();
    assert_eq!(ann, vec![("Test 1 moved", Some("2026-10-09T14:00:00Z")), ("Welcome to C241", Some("2026-08-24T13:00:00Z"))]);
    assert!(c.announcements[0].html.contains("October 16"));

    let syl = c.syllabus.as_deref().unwrap();
    assert_eq!(syl, format!("<p><a href=\"{syllabus}\">Course syllabus</a></p>"));
    assert!(c.skipped.is_empty(), "{:?}", c.skipped);
}

#[tokio::test(flavor = "multi_thread")]
async fn content_from_the_course_state_and_activity_pages() {
    let f = fake(Behaviour::default()).await;
    let c = content(&f.session(), "7").await.unwrap();
    check_content(&c, &f.base);

    let reqs = f.requests();
    assert!(!reqs.iter().any(|r| r.path.starts_with("/course/view.php")), "the state call was enough");
    assert!(!reqs.iter().any(|r| r.path.starts_with("/mod/quiz/")), "a quiz the person can't open yet isn't fetched");
    let posts: Vec<u64> = reqs
        .iter()
        .filter(|r| r.path.ends_with("info=mod_forum_get_discussion_posts"))
        .map(|r| serde_json::from_str::<Value>(&r.body).unwrap()[0]["args"]["discussionid"].as_u64().unwrap())
        .collect();
    assert_eq!(posts, vec![902, 901], "each discussion once, newest first as listed");
    assert!(reqs.iter().all(|r| r.method == "GET" || r.path.starts_with("/lib/ajax/service.php?sesskey=")), "only AJAX reads are posted");
}

#[tokio::test(flavor = "multi_thread")]
async fn content_from_the_course_page_when_the_state_call_isnt_there() {
    let f = fake(Behaviour { no_state: true, ..Default::default() }).await;
    let c = content(&f.session(), "7").await.unwrap();
    check_content(&c, &f.base);
    assert!(f.requests().iter().any(|r| r.path == "/course/view.php?id=7"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_activity_that_cant_be_read_is_listed_as_skipped() {
    let f = fake(Behaviour { gone_page: true, ..Default::default() }).await;
    let c = content(&f.session(), "7").await.unwrap();
    assert_eq!(c.skipped, vec!["“Gone page”: Your course site couldn’t find this.".to_string()]);
    assert_eq!(c.modules[1].items.last().map(String::as_str), Some("Gone page"), "still listed in its module");
    assert_eq!(c.pages.len(), 1, "the rest of the course came through");
}

// --- parsing ----------------------------------------------------------------

#[test]
fn the_course_page_outline() {
    let base = Url::parse("https://moodle.iu.edu").unwrap();
    let html = fixture("course", "https://moodle.iu.edu");
    let s = parse_course_page(&base, &html);
    assert_eq!(s.len(), 2);
    assert_eq!(s[1].name, "Week 1: Logic & Proofs");
    let cms: Vec<(u64, &str, &str)> = s[1].cms.iter().map(|c| (c.id, c.modname.as_str(), c.name.as_str())).collect();
    assert_eq!(cms, vec![(103, "page", "Reading guide"), (104, "url", "Open textbook: Discrete Math"), (105, "assign", "Homework 1"), (106, "folder", "Lecture slides")]);
    assert_eq!(s[1].cms[2].url.as_str(), "https://moodle.iu.edu/mod/assign/view.php?id=105");
    assert_eq!(s[0].cms[2].modname, "label");
}

#[test]
fn sesskey_from_m_cfg_and_not_from_elsewhere() {
    assert_eq!(find_sesskey(&fixture("my", "https://m.example")), Some(SESSKEY.into()));
    assert_eq!(find_sesskey("M.cfg = {\"sesskey\":\"\"}"), None);
    assert_eq!(find_sesskey("M.cfg = {\"sesskey\":\"ab\\\"c\"}"), None);
    assert_eq!(find_sesskey("<html>no config</html>"), None);
}

#[test]
fn html_helpers() {
    let tag = r#"<a class='x  y' data-x=1 href="/mod/page/view.php?id=1&amp;b=2" hidden>"#;
    assert_eq!(attr(tag, "href").as_deref(), Some("/mod/page/view.php?id=1&b=2"));
    assert_eq!(attr(tag, "data-x").as_deref(), Some("1"));
    assert_eq!(attr(tag, "hidden").as_deref(), Some(""));
    assert_eq!(attr(tag, "title"), None);
    assert!(attr(tag, "class").is_some_and(|c| has_word(&c, "y")));

    let html = r#"<div a="x>y"><div><br/></div><div class="in">t</div></div><div>after</div>"#;
    let (a, b) = open_tags(html, "div")[0];
    let (ia, ib) = inner(html, a, b, "div").unwrap();
    assert_eq!(&html[ia..ib], r#"<div><br/></div><div class="in">t</div>"#);
    assert_eq!(open_tags("<divx><div>", "div").len(), 1);

    assert_eq!(text("<p>Tom &amp; Jerry&#8217;s&nbsp;<b>show</b></p>\n &#x41; &bogus; & more"), "Tom & Jerry’s show A &bogus; & more");
    assert_eq!(percent_decode("Week%202/caf%C3%A9.pdf"), "Week 2/café.pdf");
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(1_760_759_940), "2025-10-18T03:59:00Z");
    assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
}
