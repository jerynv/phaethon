//! The importer end to end against two local fake servers: the course site
//! (which wants the session cookie) and "the internet" (a publisher, a blog,
//! a storage host the site redirects to), which must never see the cookie.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use super::*;
use crate::lms::text::test_pdf;
use crate::lms::{Announcement, Assignment, Cookie, Credential, Kind, Link, Module, Page, RemoteFile, Site};

#[derive(Clone)]
struct Route {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn ok(ct: &str, body: impl Into<Vec<u8>>) -> Route {
    Route { status: "200 OK", headers: vec![("Content-Type".into(), ct.into())], body: body.into() }
}

/// A request's path and its Cookie header, if any.
type Hit = (String, Option<String>);

#[derive(Clone, Default)]
struct Server {
    routes: Arc<Mutex<HashMap<String, Route>>>,
    /// (path, the Cookie header if any), in order.
    log: Arc<Mutex<Vec<Hit>>>,
}

impl Server {
    async fn start() -> (Server, Url) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let s = Server::default();
        let me = s.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let me = me.clone();
                tokio::spawn(async move {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 8192];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = sock.read(&mut buf).await else { return };
                        if n == 0 {
                            return;
                        }
                        req.extend_from_slice(&buf[..n]);
                    }
                    let text = String::from_utf8_lossy(&req).into_owned();
                    let target = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let path = target.split('?').next().unwrap_or("/").to_string();
                    let cookie = text.lines().find_map(|l| l.strip_prefix("cookie: ").or_else(|| l.strip_prefix("Cookie: ")).map(str::to_string));
                    me.log.lock().unwrap().push((path.clone(), cookie));
                    let route = me.routes.lock().unwrap().get(&path).cloned();
                    let r = route.unwrap_or(Route { status: "404 Not Found", headers: vec![], body: b"nope".to_vec() });
                    let mut head = format!("HTTP/1.1 {}\r\nConnection: close\r\nContent-Length: {}\r\n", r.status, r.body.len());
                    for (k, v) in &r.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&r.body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (s, base)
    }

    fn route(&self, path: &str, r: Route) {
        self.routes.lock().unwrap().insert(path.into(), r);
    }

    fn hits(&self, path: &str) -> Vec<Option<String>> {
        self.log.lock().unwrap().iter().filter(|(p, _)| p == path).map(|(_, c)| c.clone()).collect()
    }
}

fn file(name: &str, folder: Option<&str>, url: Url, size: Option<u64>, aliases: Vec<Url>) -> RemoteFile {
    RemoteFile { name: name.into(), folder: folder.map(String::from), url, size, mime: None, aliases }
}

struct Fixture {
    site: Server,
    web: Server,
    s: Url,
    e: Url,
    root: std::path::PathBuf,
    session: Session,
}

async fn fixture(tag: &str) -> Fixture {
    let (site, s) = Server::start().await;
    let (web, e) = Server::start().await;
    let root = std::env::temp_dir().join(format!("phaethon-import-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("courses")).unwrap();
    let cred = Credential { cookies: vec![Cookie { name: "canvas_session".into(), value: "SECRET".into() }], csrf: None };
    let session = Session::new(Site::for_test(Kind::Canvas, s.as_str()), cred);
    Fixture { site, web, s, e, root, session }
}

fn content(f: &Fixture) -> CourseContent {
    let s = &f.s;
    let e = &f.e;
    let j = |b: &Url, p: &str| b.join(p).unwrap();
    let syllabus = format!(
        "<h1>Syllabus</h1><p>Required textbook: <a href=\"{book}\">OpenStax Calculus</a>, ISBN 978-1-337-61392-7.</p>\
         <p>Slides: <a href=\"/courses/1/files/1?verifier=zz&amp;wrap=1\">Lecture 1</a>. Start with <a href=\"/courses/1/pages/intro\">the intro</a>.</p>\
         <p>Tips: <a href=\"{blog}\">this blog</a>. Notes: <a href=\"{notes}\">Notes</a>. <a href=\"{locked}\">Publisher chapter</a> (required reading).</p>\
         <p>Due: <a href=\"/courses/1/assignments/5\">Problem Set 1</a>.</p><script>steal()</script>",
        book = j(e, "/book"),
        blog = j(e, "/blog"),
        notes = j(e, "/notes.pdf"),
        locked = j(e, "/locked.pdf"),
    );
    CourseContent {
        syllabus: Some(syllabus),
        modules: vec![Module { name: "Week 1".into(), items: vec!["Intro".into(), "Lecture 1.pdf".into(), "Problem Set 1".into(), "Unknown thing".into()] }],
        pages: vec![Page {
            title: "Intro".into(),
            html: "<p>Back to <a href=\"/courses/1/files/1/preview\">the slides</a>.</p>".into(),
            url: Some(j(s, "/courses/1/pages/intro")),
        }],
        assignments: vec![
            Assignment { title: "Problem Set 1".into(), due: Some("2099-01-02T03:59:00Z".into()), points: Some(10.0), html: "<p>Do it.</p>".into(), url: Some(j(s, "/courses/1/assignments/5")) },
            Assignment { title: "Old quiz".into(), due: Some("2001-01-01T00:00:00Z".into()), points: None, html: String::new(), url: None },
        ],
        announcements: vec![Announcement { title: "Welcome".into(), posted: Some("2026-08-20T12:00:00Z".into()), html: "<p>Hi all</p>".into() }],
        files: vec![
            file("Lecture 1.pdf", Some("Week 1"), j(s, "/files/1/download?verifier=abc"), None, vec![j(s, "/courses/1/files/1")]),
            file("../../evil.txt", Some("../.."), j(s, "/files/2/download"), Some(1), vec![]),
            file("Evil.txt", None, j(s, "/files/3/download"), Some(1), vec![]),
            file("huge.zip", None, j(s, "/files/4/download"), Some(10 * 1024 * 1024 * 1024), vec![]),
            file("stream.bin", None, j(s, "/files/5/download"), None, vec![]),
            file("storage.pdf", None, j(s, "/files/6/download"), None, vec![]),
        ],
        links: vec![Link { title: "Course blog".into(), url: j(e, "/blog") }],
        skipped: vec!["Discussions: turned off for this course".into()],
    }
}

fn serve(f: &Fixture, lecture: &str, etag: &str) {
    let mut lec = ok("application/pdf", test_pdf(lecture));
    lec.headers.push(("ETag".into(), etag.into()));
    f.site.route("/files/1/download", lec);
    f.site.route("/files/2/download", ok("text/plain", "x"));
    f.site.route("/files/3/download", ok("text/plain", "y"));
    f.site.route("/files/5/download", ok("application/octet-stream", vec![7u8; 3000]));
    let storage = f.e.join("/storage/6").unwrap();
    f.site.route("/files/6/download", Route { status: "302 Found", headers: vec![("Location".into(), storage.to_string())], body: vec![] });
    f.web.route("/storage/6", ok("application/pdf", test_pdf("Stored on another host")));
    f.web.route("/book", ok("text/html", "<html><head><title>Calculus Volume 1</title></head><body><a href=\"/about\">About</a><a href=\"/book/download.pdf\">Download PDF</a></body></html>"));
    f.web.route("/book/download.pdf", ok("application/pdf", test_pdf("Calculus textbook text")));
    f.web.route("/blog", ok("text/html; charset=utf-8", "<title>Study Tips Blog</title><p>tips</p>"));
    f.web.route("/notes.pdf", ok("application/pdf", test_pdf("Lecture notes")));
    f.web.route("/locked.pdf", Route { status: "403 Forbidden", headers: vec![], body: b"no".to_vec() });
}

fn course() -> Course {
    Course { id: "1".into(), name: "Calculus I".into(), code: Some("M211".into()), term: Some("Fall 2026".into()), current: true }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_course_is_imported_and_reimported_with_only_what_changed() {
    let f = fixture("e2e").await;
    serve(&f, "Derivatives lecture", "\"v1\"");
    let opts = Options { max_download: 2000, max_links: 80 };
    let courses = f.root.join("courses");
    let mut steps = vec![];
    let out = import_course(&f.session, &courses, &course(), content(&f), None, &[], &opts, &mut |s, d, t| steps.push((s, d, t))).await.unwrap();
    let c = courses.join("Calculus I");

    // Course files, with the session.
    assert!(read(&c.join("files/Week 1/Lecture 1.pdf.md")).contains("Derivatives lecture"));
    assert_eq!(read(&c.join("files/evil.txt")), "x", "a ../ name stays inside files/");
    assert_eq!(read(&c.join("files/Evil (2).txt")), "y", "a clashing name is numbered");
    let in_courses: Vec<String> = std::fs::read_dir(&courses).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(in_courses, vec!["Calculus I"]);
    assert!(f.site.hits("/files/2/download").iter().all(|c| c.as_deref() == Some("canvas_session=SECRET")));
    assert!(f.site.hits("/files/4/download").is_empty(), "a file known to be too big is never requested");
    assert!(out.skipped.iter().any(|s| s.starts_with("huge.zip: too big to download")), "{:?}", out.skipped);
    assert!(out.skipped.iter().any(|s| s.starts_with("stream.bin: ") && s.contains("too big") || s.starts_with("stream.bin: it is bigger")), "{:?}", out.skipped);
    assert!(!c.join("files/stream.bin").exists());
    assert!(out.skipped.contains(&"Discussions: turned off for this course".to_string()));
    // A redirect off the site: followed, but without the session.
    assert!(read(&c.join("files/storage.pdf.md")).contains("Stored on another host"));
    assert_eq!(f.site.hits("/files/6/download"), vec![Some("canvas_session=SECRET".into())]);
    assert_eq!(f.web.hits("/storage/6"), vec![None]);
    // The internet never sees the session.
    assert!(f.web.log.lock().unwrap().iter().all(|(_, c)| c.is_none()));

    // Links rewritten.
    let syl = read(&c.join("syllabus.md"));
    assert!(syl.contains("[Lecture 1](files/Week%201/Lecture%201.pdf)"), "{syl}");
    assert!(syl.contains("[the intro](pages/Intro.md)"), "{syl}");
    assert!(syl.contains("[Problem Set 1](assignments.md#problem-set-1)"), "{syl}");
    assert!(syl.contains(&format!("[this blog]({})", f.e.join("/blog").unwrap())), "external links are kept: {syl}");
    assert!(!syl.contains("steal"));
    assert!(read(&c.join("pages/Intro.md")).contains("[the slides](../files/Week%201/Lecture%201.pdf)"));

    // The textbook: its page → its PDF (one level), saved with a text copy.
    let book = read(&c.join("readings/Calculus Volume 1.pdf.md"));
    assert!(book.contains("Calculus textbook text"), "{book}");
    assert!(read(&c.join("readings/notes.pdf.md")).contains("Lecture notes"));
    // A web page is listed, not saved.
    let links = read(&c.join("links.md"));
    assert!(links.contains("[Study Tips Blog]("), "{links}");
    let readings: Vec<String> = std::fs::read_dir(c.join("readings")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(!readings.iter().any(|n| n.contains("blog") || n.ends_with(".part")), "{readings:?}");

    let readme = read(&c.join("README.md"));
    assert!(readme.contains("M211 · Fall 2026"));
    assert!(readme.contains("## Coming up") && readme.contains("[Problem Set 1](assignments.md#problem-set-1)") && !readme.contains("Old quiz"), "{readme}");
    assert!(readme.contains("**Textbook**: [Calculus Volume 1](readings/Calculus%20Volume%201.pdf)"), "{readme}");
    assert!(readme.contains("the PDF linked from its page"));
    assert!(readme.contains("ISBN 9781337613927"), "{readme}");
    assert!(readme.contains("Publisher chapter") && readme.contains("needs a sign-in"), "{readme}");
    assert!(readme.contains("Reading: [Notes](readings/notes.pdf)"), "{readme}");
    let modules = read(&c.join("modules.md"));
    assert!(modules.contains("- [Intro](pages/Intro.md)") && modules.contains("- [Lecture 1.pdf](files/Week%201/Lecture%201.pdf)") && modules.contains("- Unknown thing"), "{modules}");
    assert!(read(&c.join("assignments.md")).find("Problem Set 1").unwrap() > read(&c.join("assignments.md")).find("Old quiz").unwrap(), "by due date");

    assert_eq!((out.files, out.downloaded, out.readings, out.links), (4, 4, 2, 1));
    assert_eq!(out.state.folder, "Calculus I");
    assert!(steps.contains(&(STEP_WRITING, 1, 1)));
    let lecture_key = file_key(&f.s.join("/files/1/download").unwrap());
    assert_eq!(out.state.files[&lecture_key].etag.as_deref(), Some("\"v1\""));

    // Re-import: the lecture changed (new ETag); nothing else did.
    let evil_before = std::fs::metadata(c.join("files/evil.txt")).unwrap().modified().unwrap();
    let web_before = f.web.log.lock().unwrap().len();
    serve(&f, "Integrals lecture", "\"v2\"");
    // Text copies made before pages were recognised (a page left empty) are made again, without downloading.
    let old_copy = "# Text of storage.pdf\n\n## Page 1\n\n\n\n## Page 2\n\nkept\n";
    std::fs::write(c.join("files/storage.pdf.md"), old_copy).unwrap();
    std::fs::write(c.join("readings/notes.pdf.md"), "# Text of notes.pdf\n\n(This file has no text in it: it may be scanned pages or pictures.)\n").unwrap();
    let again = import_course(&f.session, &courses, &course(), content(&f), Some(&out.state), &[], &opts, &mut |_, _, _| {}).await.unwrap();
    assert_eq!(again.state.folder, "Calculus I");
    assert_eq!(again.downloaded, 1, "only the changed file: {:?}", again.skipped);
    assert!(read(&c.join("files/Week 1/Lecture 1.pdf.md")).contains("Integrals lecture"));
    assert!(read(&c.join("files/storage.pdf.md")).contains("Stored on another host"));
    assert!(read(&c.join("readings/notes.pdf.md")).contains("Lecture notes"));
    assert_eq!(std::fs::metadata(c.join("files/evil.txt")).unwrap().modified().unwrap(), evil_before);
    assert!(c.join("files/Evil (2).txt").exists() && !c.join("files/Evil (3).txt").exists(), "paths are kept, not renumbered");
    let web_after: Vec<String> = f.web.log.lock().unwrap()[web_before..].iter().map(|(p, _)| p.clone()).collect();
    assert!(!web_after.iter().any(|p| p == "/book" || p == "/notes.pdf" || p == "/blog"), "saved readings aren't fetched again: {web_after:?}");
    assert_eq!(again.readings, 2);
    // PHAETHON_KEEP_IMPORT=1 keeps the folder to look at.
    if std::env::var_os("PHAETHON_KEEP_IMPORT").is_none() {
        std::fs::remove_dir_all(&f.root).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_course_with_the_same_name_gets_its_own_folder_and_a_symlinked_folder_is_refused() {
    let f = fixture("folders").await;
    let courses = f.root.join("courses");
    let opts = Options::default();
    let empty = CourseContent::default();
    let out = import_course(&f.session, &courses, &course(), empty.clone(), None, &["calculus i".into()], &opts, &mut |_, _, _| {}).await.unwrap();
    assert_eq!(out.state.folder, "Calculus I (M211)");
    assert!(read(&courses.join("Calculus I (M211)/README.md")).contains("The course doesn’t name a textbook"));
    #[cfg(unix)]
    {
        let outside = f.root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, courses.join("Linked")).unwrap();
        let mut c = course();
        c.name = "Linked".into();
        c.code = None;
        assert!(import_course(&f.session, &courses, &c, empty, None, &[], &opts, &mut |_, _, _| {}).await.is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
    std::fs::remove_dir_all(&f.root).unwrap();
}

#[test]
fn links_match_files_without_their_query_or_download_suffix() {
    let u = |s: &str| Url::parse(s).unwrap();
    assert_eq!(link_key(&u("https://x/courses/1/files/9/download?download_frd=1")), link_key(&u("https://x/courses/1/files/9?wrap=1")));
    assert_eq!(link_key(&u("https://x/courses/1/files/9/preview#p")), "https://x/courses/1/files/9");
    assert_eq!(file_key(&u("https://x/f/9/download?verifier=a")), "https://x/f/9/download");
}

#[test]
fn documents_are_told_by_their_bytes() {
    assert_eq!(sniff(b"%PDF-1.7", "text/html", ""), Some("pdf"));
    assert_eq!(sniff(b"<html>", "application/pdf", "pdf"), None, "a page calling itself a PDF isn't one");
    assert_eq!(sniff(b"PK\x03\x04", "application/epub+zip", ""), Some("epub"));
    assert_eq!(sniff(b"PK\x03\x04", "application/zip", "zip"), None);
    assert_eq!(sniff(&[0xD0, 0xCF, 0x11, 0xE0], "application/msword", ""), Some("doc"));
}
