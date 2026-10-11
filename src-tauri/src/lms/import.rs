//! Writing one course into a space as plain files (see the layout in mod.rs's
//! callers): Markdown for the syllabus, assignments, announcements, modules
//! and pages; the course's files downloaded with the session; documents the
//! course links to downloaded without it into readings/; a text copy beside
//! every PDF and Office file; and a README that says what's coming up, which
//! textbooks the course uses and where each one is.
//!
//! Everything is written under `<space>/courses/<course>/` through names.rs,
//! which never follows a symlink. A re-import keeps the same folder and
//! downloads only files that are new or changed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use url::Url;

use super::html::{self, FoundLink};
use super::store::{self, CourseState, Due, FileRec, LinkRec};
use super::textbooks::{self, Isbn};
use super::{Course, CourseContent, LmsError, MAX_DOWNLOAD, Session, names, text};

pub struct Options {
    /// Largest single download.
    pub max_download: u64,
    /// Most links out of one course that are fetched (the rest are listed).
    pub max_links: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_download: MAX_DOWNLOAD, max_links: 80 }
    }
}

/// What importing one course did.
#[derive(Debug)]
pub struct Outcome {
    pub state: CourseState,
    /// Course files in the folder (downloaded now or already up to date).
    pub files: usize,
    /// Downloaded now (new or changed).
    pub downloaded: usize,
    pub readings: usize,
    pub links: usize,
    pub skipped: Vec<String>,
}

/// Progress steps, as the UI's `LmsImportStep`.
pub const STEP_FILES: &str = "files";
pub const STEP_READINGS: &str = "readings";
pub const STEP_WRITING: &str = "writing";

const README: &str = "README.md";
const FIXED: &[&str] = &[README, "syllabus.md", "assignments.md", "announcements.md", "modules.md", "links.md", "pages", "files", "readings"];
/// Most of an HTML page read for its title or a book's PDF link.
const MAX_PAGE: usize = 2 * 1024 * 1024;
const INDEX_LIST_MAX: usize = 200;

/// A file's identity on the site: its address without query or fragment
/// (Canvas adds `?verifier=…`, which can change).
pub fn file_key(u: &Url) -> String {
    let mut u = u.clone();
    u.set_query(None);
    u.set_fragment(None);
    u.to_string()
}

/// For matching links in course HTML: also without a trailing slash and a
/// trailing `/download` or `/preview`.
pub fn link_key(u: &Url) -> String {
    let k = file_key(u);
    let k = k.trim_end_matches('/');
    let k = k.strip_suffix("/download").or_else(|| k.strip_suffix("/preview")).unwrap_or(k);
    k.to_string()
}

/// GitHub-style heading anchors, numbered when repeated.
fn anchor(title: &str, used: &mut HashMap<String, usize>) -> String {
    let base: String = title
        .to_lowercase()
        .chars()
        .filter_map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { Some(c) } else if c == ' ' { Some('-') } else { None })
        .collect();
    let n = used.entry(base.clone()).or_insert(0);
    let a = if *n == 0 { base.clone() } else { format!("{base}-{n}") };
    *n += 1;
    a
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn mb(bytes: u64) -> String {
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if b < K * K {
        format!("{} KB", (b / K).ceil().max(1.0))
    } else if b < K * K * K {
        format!("{} MB", (b / K / K).round())
    } else {
        format!("{:.1} GB", b / K / K / K)
    }
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The course's folder name: the one it already has, else its name, made
/// unique among the space's other course folders.
fn pick_folder(course: &Course, prev: Option<&CourseState>, taken: &[String]) -> String {
    if let Some(p) = prev
        && names::segment(&p.folder) == p.folder
    {
        return p.folder.clone();
    }
    let taken: HashSet<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let base = names::segment(&course.name);
    let mut candidates = vec![base.clone()];
    if let Some(code) = &course.code {
        candidates.push(names::segment(&format!("{} ({code})", course.name)));
    }
    if let Some(c) = candidates.into_iter().find(|c| !taken.contains(&c.to_lowercase())) {
        return c;
    }
    (2..).map(|n| format!("{base} ({n})")).find(|c| !taken.contains(&c.to_lowercase())).expect("a free name")
}

/// Read from `stream` until at least `n` bytes (or the end).
async fn head<S, B>(stream: &mut S, n: usize) -> Result<Vec<u8>, String>
where
    S: futures_util::Stream<Item = reqwest::Result<B>> + Unpin,
    B: AsRef<[u8]>,
{
    let mut buf = Vec::new();
    while buf.len() < n {
        match stream.next().await {
            Some(Ok(c)) => buf.extend_from_slice(c.as_ref()),
            Some(Err(e)) => return Err(e.to_string()),
            None => break,
        }
    }
    Ok(buf)
}

/// Write `first` and the rest of `stream` to `file`, at most `cap` bytes.
async fn rest_to<S, B>(stream: &mut S, first: &[u8], file: &mut std::fs::File, cap: u64) -> Result<u64, String>
where
    S: futures_util::Stream<Item = reqwest::Result<B>> + Unpin,
    B: AsRef<[u8]>,
{
    let too_big = || format!("it is bigger than the {} limit", mb(cap));
    let mut total = first.len() as u64;
    if total > cap {
        return Err(too_big());
    }
    file.write_all(first).map_err(|e| e.to_string())?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("the download stopped: {e}"))?;
        let chunk = chunk.as_ref();
        total += chunk.len() as u64;
        if total > cap {
            return Err(too_big());
        }
        file.write_all(chunk).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(total)
}

fn header(res: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    res.headers().get(name).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() < 512)
}

/// A file name from Content-Disposition (`filename*=UTF-8''…` or `filename="…"`).
fn disposition_name(res: &reqwest::Response) -> Option<String> {
    let v = header(res, reqwest::header::CONTENT_DISPOSITION)?;
    for part in v.split(';').map(str::trim) {
        if let Some(n) = part.strip_prefix("filename*=") {
            let n = n.rsplit("''").next().unwrap_or(n);
            return Some(super::csrf::url_decode(n.trim_matches('"')));
        }
    }
    v.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename=")).map(|n| n.trim_matches('"').to_string())
}

/// The document type of a download from its first bytes, its content type and
/// its address: `Some(extension)` for a document worth keeping as a reading.
fn sniff(first: &[u8], content_type: &str, name_ext: &str) -> Option<&'static str> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if first.starts_with(b"%PDF-") {
        return Some("pdf");
    }
    let by = |pairs: &[(&'static str, &str)]| -> Option<&'static str> {
        pairs.iter().find(|(ext, mime)| name_ext == *ext || ct == *mime).map(|(ext, _)| *ext)
    };
    if first.starts_with(b"PK\x03\x04") {
        return by(&[
            ("epub", "application/epub+zip"),
            ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("odt", "application/vnd.oasis.opendocument.text"),
            ("odp", "application/vnd.oasis.opendocument.presentation"),
        ]);
    }
    if first.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return by(&[("doc", "application/msword"), ("ppt", "application/vnd.ms-powerpoint"), ("xls", "application/vnd.ms-excel")]);
    }
    if first.starts_with(b"{\\rtf") {
        return Some("rtf");
    }
    None
}

fn looks_html(first: &[u8], content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("text/html") || ct.starts_with("application/xhtml") {
        return true;
    }
    let start = String::from_utf8_lossy(&first[..first.len().min(512)]).trim_start().to_ascii_lowercase();
    start.starts_with("<!doctype html") || start.starts_with("<html")
}

fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// What came of fetching one link out of the course.
enum Fetched {
    /// A document, in a temporary file in readings/, with the name to give it.
    Saved { tmp: PathBuf, name: String, via: Option<Url>, title: Option<String> },
    Page { title: Option<String> },
    Failed(String),
}

fn why_not(e: &LmsError) -> String {
    match e {
        LmsError::Network(_) => "couldn’t be reached".into(),
        LmsError::Other(m) if m.contains("(401)") || m.contains("(403)") => {
            "needs a sign-in (the publisher’s or the library’s), so Phaethon couldn’t download it".into()
        }
        LmsError::Other(m) if m.contains("(404)") || m.contains("(410)") => "the link is broken (the page isn’t there)".into(),
        other => format!("couldn’t be downloaded: {other}"),
    }
}

/// Fetch a link out of the course without the session. A document is saved
/// into `readings_dir` under a temporary name; a web page gives its title,
/// and for a textbook its page is searched (one level, no further) for the
/// book's PDF.
async fn fetch_link(session: &Session, readings_dir: &Path, url: &Url, textbook: bool, cap: u64) -> Fetched {
    let res = match session.fetch_external(url).await {
        Ok(r) => r,
        Err(e) => return Fetched::Failed(why_not(&e)),
    };
    let final_url = res.url().clone();
    let ct = header(&res, reqwest::header::CONTENT_TYPE).unwrap_or_default();
    let dname = disposition_name(&res);
    if let Some(len) = res.content_length()
        && len > cap
        && !ct.to_ascii_lowercase().starts_with("text/html")
    {
        return Fetched::Failed(format!("is bigger than the {} limit", mb(cap)));
    }
    let mut stream = Box::pin(res.bytes_stream());
    let first = match head(&mut stream, 1024).await {
        Ok(b) => b,
        Err(e) => return Fetched::Failed(format!("couldn’t be downloaded: {e}")),
    };
    let base_name = dname
        .clone()
        .or_else(|| final_url.path_segments().and_then(|mut s| s.next_back().map(super::csrf::url_decode)).filter(|n| !n.is_empty()))
        .unwrap_or_else(|| "reading".into());
    if let Some(ext) = sniff(&first, &ct, &ext_of(&base_name)) {
        let name = if ext_of(&base_name) == ext { base_name } else { format!("{base_name}.{ext}") };
        return match save_tmp(readings_dir, &mut stream, &first, cap).await {
            Ok(tmp) => Fetched::Saved { tmp, name, via: None, title: None },
            Err(e) => Fetched::Failed(e),
        };
    }
    if !looks_html(&first, &ct) {
        let what = ct.split(';').next().unwrap_or("").trim().to_string();
        return Fetched::Failed(if what.is_empty() { "isn’t a document Phaethon saves".into() } else { format!("isn’t a document Phaethon saves ({what})") });
    }
    let mut page = first;
    while page.len() < MAX_PAGE {
        match stream.next().await {
            Some(Ok(c)) => page.extend_from_slice(c.as_ref()),
            _ => break,
        }
    }
    let page = String::from_utf8_lossy(&page).into_owned();
    let title = html::page_title(&page);
    if textbook
        && let Some(pdf) = textbooks::pdf_link_on_page(&page, &final_url)
        && pdf != *url
        && pdf != final_url
    {
        // One level only: the book's page → its PDF. Never further.
        if let Ok(res) = session.fetch_external(&pdf).await {
            let ct = header(&res, reqwest::header::CONTENT_TYPE).unwrap_or_default();
            let dname = disposition_name(&res);
            let mut stream = Box::pin(res.bytes_stream());
            if let Ok(first) = head(&mut stream, 1024).await
                && sniff(&first, &ct, "pdf") == Some("pdf")
                && let Ok(tmp) = save_tmp(readings_dir, &mut stream, &first, cap).await
            {
                let name = dname
                    .or_else(|| title.clone().map(|t| format!("{t}.pdf")))
                    .or_else(|| pdf.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
                    .unwrap_or_else(|| "textbook.pdf".into());
                let name = if ext_of(&name) == "pdf" { name } else { format!("{name}.pdf") };
                return Fetched::Saved { tmp, name, via: Some(final_url), title };
            }
        }
    }
    Fetched::Page { title }
}

async fn save_tmp<S, B>(dir: &Path, stream: &mut S, first: &[u8], cap: u64) -> Result<PathBuf, String>
where
    S: futures_util::Stream<Item = reqwest::Result<B>> + Unpin,
    B: AsRef<[u8]>,
{
    let (mut file, tmp, _) = names::temp_for(dir, Path::new("download")).map_err(|e| format!("couldn’t be saved: {e}"))?;
    match rest_to(stream, first, &mut file, cap).await {
        Ok(_) => Ok(tmp),
        Err(e) => {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Write a text copy (`name.ext.md`) beside a document, from the file at `root/rel`.
async fn text_copy(root: &Path, rel: &Path) -> Result<(), String> {
    if text::kind_of(rel) == text::Doc::Other {
        return Ok(());
    }
    let full = root.join(rel);
    let extracted = tokio::task::spawn_blocking(move || text::extract(&full)).await.map_err(|e| e.to_string())?;
    let name = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let body = match extracted {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) => "(This file has no text in it: it may be scanned pages or pictures. Open the file itself to read it.)".into(),
        Err(e) => return Err(format!("{name}: no text copy ({e})")),
    };
    let doc = format!(
        "# Text of {name}\n\nCopied from [{name}]({}) so it can be read here. Layout, pictures and equations may be missing; the file itself is the original.\n\n{body}\n",
        names::link_target(Path::new(&name))
    );
    let mut md = rel.as_os_str().to_owned();
    md.push(".md");
    names::write(root, Path::new(&md), doc.as_bytes()).map_err(|e| format!("{name}: no text copy ({e})"))
}

/// Where links in course HTML point once the course is on disk.
struct Targets {
    /// link_key → path relative to the course folder (with an optional #anchor).
    local: HashMap<String, String>,
    /// Links out of the course that were downloaded into readings/: link_key → path.
    /// The syllabus then points at the copy the agent can read, not the web.
    readings: HashMap<String, String>,
}

impl Targets {
    fn rewrite(&self, session: &Session, u: &Url, depth: usize) -> String {
        if session.site.owns(u)
            && let Some(rel) = self.local.get(&link_key(u))
        {
            let up = "../".repeat(depth);
            let (path, frag) = rel.split_once('#').map(|(p, f)| (p, Some(f))).unwrap_or((rel.as_str(), None));
            let mut s = format!("{up}{}", names::link_target(Path::new(path)));
            if let Some(f) = frag {
                s.push('#');
                s.push_str(f);
            }
            return s;
        }
        if !session.site.owns(u)
            && let Some(rel) = self.readings.get(&link_key(u))
        {
            return format!("{}{}", "../".repeat(depth), names::link_target(Path::new(rel)));
        }
        u.to_string()
    }
}

struct LinkSeen {
    found: FoundLink,
    textbook: bool,
    /// Where in the course it was linked from ("the syllabus", a page's title).
    from: String,
}

#[allow(clippy::too_many_arguments)] // each one is a separate input the caller owns
pub async fn import_course(
    session: &Session,
    courses_root: &Path,
    course: &Course,
    content: CourseContent,
    prev: Option<&CourseState>,
    other_folders: &[String],
    opts: &Options,
    progress: &mut (dyn FnMut(&'static str, usize, usize) + Send),
) -> Result<Outcome, String> {
    let folder = pick_folder(course, prev, other_folders);
    let root = names::dir_in(courses_root, Path::new(&folder)).map_err(|e| format!("The folder for {} couldn’t be made: {e}", course.name))?;
    let mut skipped = content.skipped.clone();
    let mut taken = names::Taken::default();
    for f in FIXED {
        taken.reserve(Path::new(f));
    }

    // ---- Plan where everything goes, so links can be rewritten. ----
    let prev_files: HashMap<&str, &FileRec> = prev.map(|p| p.files.iter().map(|(k, v)| (k.as_str(), v)).collect()).unwrap_or_default();
    let mut planned: Vec<PathBuf> = Vec::with_capacity(content.files.len());
    // A file keeps the path it had (if still a plain path under files/).
    let kept = |key: &str| {
        prev_files.get(key).map(|r| PathBuf::from(&r.path)).filter(|p| names::is_plain(p) && p.starts_with("files"))
    };
    for f in &content.files {
        if let Some(p) = kept(&file_key(&f.url)) {
            taken.reserve(&p);
        }
    }
    let mut seen_keys: HashSet<String> = HashSet::new();
    for f in &content.files {
        let key = file_key(&f.url);
        let p = match kept(&key) {
            Some(p) if seen_keys.insert(key.clone()) => p,
            _ => taken.claim(&Path::new("files").join(names::rel_path(f.folder.as_deref(), &f.name))),
        };
        let mut md = p.as_os_str().to_owned();
        md.push(".md");
        taken.reserve(Path::new(&md));
        planned.push(p);
    }
    let mut local: HashMap<String, String> = HashMap::new();
    for (f, p) in content.files.iter().zip(&planned) {
        let rel = p.to_string_lossy().replace('\\', "/");
        for u in std::iter::once(&f.url).chain(&f.aliases) {
            local.entry(link_key(u)).or_insert_with(|| rel.clone());
        }
    }
    let mut page_paths = vec![];
    for p in &content.pages {
        let rel = taken.claim(&Path::new("pages").join(format!("{}.md", names::segment(&p.title))));
        if let Some(u) = &p.url {
            local.entry(link_key(u)).or_insert_with(|| rel.to_string_lossy().replace('\\', "/"));
        }
        page_paths.push(rel);
    }
    let mut anchors_used = HashMap::new();
    let mut assignments: Vec<(&super::Assignment, String, Option<i64>)> =
        content.assignments.iter().map(|a| (a, anchor(&a.title, &mut anchors_used), a.due.as_deref().and_then(store::parse_time))).collect();
    assignments.sort_by_key(|(_, _, t)| (t.is_none(), *t));
    for (a, anc, _) in &assignments {
        if let Some(u) = &a.url {
            local.entry(link_key(u)).or_insert_with(|| format!("assignments.md#{anc}"));
        }
    }
    let mut targets = Targets { local, readings: HashMap::new() };

    // ---- Course files, with the session. ----
    let total = content.files.len();
    let mut files_state: BTreeMap<String, FileRec> = BTreeMap::new();
    let mut present = 0;
    let mut downloaded = 0;
    for (i, (f, rel)) in content.files.iter().zip(&planned).enumerate() {
        progress(STEP_FILES, i, total);
        let key = file_key(&f.url);
        if let Some(size) = f.size
            && size > opts.max_download
        {
            skipped.push(format!("{}: too big to download ({}; the limit is {})", f.name, mb(size), mb(opts.max_download)));
            continue;
        }
        let res = match session.get(&f.url).await {
            Ok(r) => r,
            Err(LmsError::SignedOut) => {
                skipped.push(format!("{}: couldn’t be downloaded (sign in again if this keeps happening)", f.name));
                continue;
            }
            Err(LmsError::Forbidden(_)) => {
                skipped.push(format!("{}: the course site didn’t allow downloading it", f.name));
                continue;
            }
            Err(LmsError::NotFound(_)) => {
                skipped.push(format!("{}: the course site couldn’t find it", f.name));
                continue;
            }
            Err(e) => {
                skipped.push(format!("{}: couldn’t be downloaded ({e})", f.name));
                continue;
            }
        };
        let etag = header(&res, reqwest::header::ETAG);
        let modified = header(&res, reqwest::header::LAST_MODIFIED);
        let size = f.size.or(res.content_length());
        let rec = FileRec { path: rel.to_string_lossy().replace('\\', "/"), size, etag: etag.clone(), modified: modified.clone() };
        // Unchanged: same size and the same ETag / Last-Modified (where the site sends them).
        if let Some(old) = prev_files.get(key.as_str())
            && old.path == rec.path
            && old.size == rec.size
            && old.etag == rec.etag
            && old.modified == rec.modified
            && std::fs::symlink_metadata(root.join(rel)).is_ok_and(|m| m.is_file())
        {
            drop(res); // not read: the copy on disk is this file
            present += 1;
            files_state.insert(key, rec);
            let mut md = rel.as_os_str().to_owned();
            md.push(".md");
            // Missing, or made before handwritten and scanned pages were recognised.
            if text::copy_is_stale(&root.join(&md))
                && let Err(e) = text_copy(&root, rel).await
            {
                skipped.push(e);
            }
            continue;
        }
        if let Some(len) = res.content_length()
            && len > opts.max_download
        {
            skipped.push(format!("{}: too big to download ({}; the limit is {})", f.name, mb(len), mb(opts.max_download)));
            continue;
        }
        let (mut file, tmp, dest) = match names::temp_for(&root, rel) {
            Ok(t) => t,
            Err(e) => {
                skipped.push(format!("{}: couldn’t be saved ({e})", f.name));
                continue;
            }
        };
        let mut stream = Box::pin(res.bytes_stream());
        match rest_to(&mut stream, &[], &mut file, opts.max_download).await {
            Ok(_) => {
                drop(file);
                if let Err(e) = names::finish(&tmp, &dest) {
                    skipped.push(format!("{}: couldn’t be saved ({e})", f.name));
                    continue;
                }
            }
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&tmp);
                skipped.push(format!("{}: {e}", f.name));
                continue;
            }
        }
        present += 1;
        downloaded += 1;
        files_state.insert(key, rec);
        if let Err(e) = text_copy(&root, rel).await {
            skipped.push(e);
        }
    }
    progress(STEP_FILES, total, total);

    // ---- Links out of the course, without the session. ----
    let site_base = session.site.base.clone();
    let mut texts: Vec<String> = vec![];
    let mut seen: Vec<LinkSeen> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut collect = |html: &str, base: Option<&Url>, from: &str, texts: &mut Vec<String>| {
        let scan = html::scan(html, base.or(Some(&site_base)));
        texts.push(scan.text);
        for l in scan.links {
            if l.url.scheme() == "mailto" || session.site.owns(&l.url) {
                continue;
            }
            let key = file_key(&l.url);
            let textbook = textbooks::is_textbook(&l);
            match index.get(&key) {
                Some(&i) => seen[i].textbook |= textbook,
                None => {
                    index.insert(key, seen.len());
                    seen.push(LinkSeen { found: l, textbook, from: from.to_string() });
                }
            }
        }
    };
    if let Some(s) = &content.syllabus {
        collect(s, None, "the syllabus", &mut texts);
    }
    for p in &content.pages {
        collect(&p.html, p.url.as_ref(), &p.title, &mut texts);
    }
    for a in &content.assignments {
        collect(&a.html, a.url.as_ref(), &a.title, &mut texts);
    }
    for a in &content.announcements {
        collect(&a.html, None, &a.title, &mut texts);
    }
    for l in &content.links {
        let html = format!("<a href=\"{}\">{}</a>", l.url.as_str().replace('"', "%22"), l.title.replace('<', "&lt;"));
        collect(&html, None, "the modules", &mut texts);
    }
    // Textbooks first, so the cap never drops one.
    let mut order: Vec<usize> = (0..seen.len()).collect();
    order.sort_by_key(|&i| !seen[i].textbook);
    let prev_links = prev.map(|p| p.links.clone()).unwrap_or_default();
    let mut links_state: BTreeMap<String, LinkRec> = BTreeMap::new();
    let readings_dir = names::dir_in(&root, Path::new("readings")).map_err(|e| format!("The readings folder couldn’t be made: {e}"))?;
    let mut to_fetch = vec![];
    let mut stale_readings: Vec<PathBuf> = vec![];
    for (n, &i) in order.iter().enumerate() {
        let key = file_key(&seen[i].found.url);
        let reuse = prev_links.get(&key).filter(|r| match &r.path {
            Some(p) => names::is_plain(Path::new(p)) && p.starts_with("readings/") && root.join(p).is_file(),
            None => r.note.is_none() || r.web_page,
        });
        if let Some(r) = reuse {
            if let Some(p) = &r.path {
                taken.reserve(Path::new(p));
                if text::copy_is_stale(&root.join(format!("{p}.md"))) {
                    stale_readings.push(PathBuf::from(p));
                }
            }
            links_state.insert(key, r.clone());
        } else if n < opts.max_links {
            to_fetch.push(i);
        } else {
            links_state.insert(key, LinkRec { note: Some("not checked (the course links to too many places)".into()), ..Default::default() });
        }
    }
    let fetch_total = to_fetch.len();
    progress(STEP_READINGS, 0, fetch_total);
    let reads: Vec<_> = to_fetch
        .into_iter()
        .map(|i| {
            let url = seen[i].found.url.clone();
            let textbook = seen[i].textbook;
            let dir = readings_dir.clone();
            async move { (i, fetch_link(session, &dir, &url, textbook, opts.max_download).await) }
        })
        .collect();
    let mut fetches = futures_util::stream::iter(reads)
    .buffer_unordered(4);
    let mut done = 0;
    let mut new_readings: Vec<PathBuf> = vec![];
    while let Some((i, fetched)) = fetches.next().await {
        done += 1;
        progress(STEP_READINGS, done, fetch_total);
        let key = file_key(&seen[i].found.url);
        let rec = match fetched {
            Fetched::Saved { tmp, name, via, title } => {
                let rel = taken.claim(&Path::new("readings").join(names::segment(&name)));
                let mut md = rel.as_os_str().to_owned();
                md.push(".md");
                taken.reserve(Path::new(&md));
                match names::finish(&tmp, &root.join(&rel)) {
                    Ok(()) => {
                        new_readings.push(rel.clone());
                        LinkRec { path: Some(rel.to_string_lossy().replace('\\', "/")), title, via: via.map(|v| v.to_string()), ..Default::default() }
                    }
                    Err(e) => LinkRec { note: Some(format!("couldn’t be saved: {e}")), ..Default::default() },
                }
            }
            Fetched::Page { title } => LinkRec { title, web_page: true, ..Default::default() },
            Fetched::Failed(note) => LinkRec { note: Some(note), ..Default::default() },
        };
        links_state.insert(key, rec);
    }
    drop(fetches);
    for l in &seen {
        if let Some(p) = links_state.get(&file_key(&l.found.url)).and_then(|r| r.path.clone()) {
            targets.readings.insert(link_key(&l.found.url), p);
        }
    }
    for rel in new_readings.iter().chain(&stale_readings) {
        if let Err(e) = text_copy(&root, rel).await {
            skipped.push(e);
        }
    }

    // ---- The Markdown. ----
    progress(STEP_WRITING, 0, 1);
    let write = |rel: &str, body: &str| names::write(&root, Path::new(rel), body.as_bytes()).map_err(|e| format!("{rel} couldn’t be written: {e}"));
    let md = |html_src: &str, base: Option<&Url>, depth: usize| {
        html::to_markdown(html_src, Some(base.unwrap_or(&session.site.base)), &mut |u| targets.rewrite(session, u, depth))
    };
    if let Some(s) = &content.syllabus {
        write("syllabus.md", &format!("# Syllabus: {}\n\n{}\n", course.name, md(s, None, 0)))?;
    }
    let mut due: Vec<Due> = vec![];
    if !assignments.is_empty() {
        let mut s = format!("# Assignments: {}\n\nBy due date; undated ones last.\n\n", course.name);
        for (a, anc, t) in &assignments {
            s.push_str(&format!("## {}\n\n", one_line(&a.title)));
            let mut facts = vec![];
            match t {
                Some(t) => facts.push(format!("Due {}", store::display_time(*t))),
                None => facts.push("No due date".into()),
            }
            if let Some(p) = a.points {
                facts.push(format!("{p} points"));
            }
            s.push_str(&facts.join(" · "));
            s.push_str("\n\n");
            let body = md(&a.html, a.url.as_ref(), 0);
            if !body.is_empty() {
                s.push_str(&body);
                s.push_str("\n\n");
            }
            if let Some(d) = &a.due
                && t.is_some()
            {
                due.push(Due { title: one_line(&a.title), due: d.clone(), anchor: anc.clone() });
            }
        }
        write("assignments.md", &s)?;
    }
    if !content.announcements.is_empty() {
        let mut list: Vec<&super::Announcement> = content.announcements.iter().collect();
        list.sort_by_key(|a| std::cmp::Reverse(a.posted.as_deref().and_then(store::parse_time)));
        let mut s = format!("# Announcements: {}\n\nNewest first.\n\n", course.name);
        for a in list {
            s.push_str(&format!("## {}\n\n", one_line(&a.title)));
            if let Some(t) = a.posted.as_deref().and_then(store::parse_time) {
                s.push_str(&format!("Posted {}\n\n", store::display_time(t)));
            }
            s.push_str(&md(&a.html, None, 0));
            s.push_str("\n\n");
        }
        write("announcements.md", &s)?;
    }
    for (p, rel) in content.pages.iter().zip(&page_paths) {
        let body = format!("# {}\n\n{}\n", one_line(&p.title), md(&p.html, p.url.as_ref(), 1));
        write(&rel.to_string_lossy(), &body)?;
    }
    if !content.modules.is_empty() {
        let mut by_title: HashMap<String, String> = HashMap::new();
        for (p, rel) in content.pages.iter().zip(&page_paths) {
            by_title.entry(p.title.clone()).or_insert_with(|| names::link_target(rel));
        }
        for (a, anc, _) in &assignments {
            by_title.entry(a.title.clone()).or_insert_with(|| format!("assignments.md#{anc}"));
        }
        for (f, rel) in content.files.iter().zip(&planned) {
            if files_state.contains_key(&file_key(&f.url)) {
                by_title.entry(f.name.clone()).or_insert_with(|| names::link_target(rel));
            }
        }
        for l in &content.links {
            by_title.entry(l.title.clone()).or_insert_with(|| l.url.to_string());
        }
        let mut s = format!("# Modules: {}\n\nIn the course’s order.\n\n", course.name);
        for m in &content.modules {
            s.push_str(&format!("## {}\n\n", one_line(&m.name)));
            for item in &m.items {
                match by_title.get(item) {
                    Some(t) => s.push_str(&format!("- [{}]({t})\n", one_line(item).replace(['[', ']'], ""))),
                    None => s.push_str(&format!("- {}\n", one_line(item))),
                }
            }
            s.push('\n');
        }
        write("modules.md", &s)?;
    }
    let web_pages: Vec<&LinkSeen> = seen.iter().filter(|l| links_state.get(&file_key(&l.found.url)).is_some_and(|r| r.web_page && r.path.is_none())).collect();
    if !web_pages.is_empty() {
        let mut s = format!("# Links: {}\n\nWeb pages the course links to. They aren’t saved here; open them in a browser.\n\n", course.name);
        for l in &web_pages {
            let rec = &links_state[&file_key(&l.found.url)];
            let label = rec.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| one_line(&l.found.text)).replace(['[', ']'], "");
            let label = if label.is_empty() { l.found.url.to_string() } else { label };
            s.push_str(&format!("- [{label}]({}) (from {})\n", l.found.url, l.from));
        }
        write("links.md", &s)?;
    }

    // ---- README. ----
    let isbns: Vec<Isbn> = texts.iter().flat_map(|t| textbooks::isbns(t)).fold(vec![], |mut acc: Vec<Isbn>, i| {
        if !acc.iter().any(|a| a.isbn == i.isbn) {
            acc.push(i);
        }
        acc
    });
    let readme = readme(course, session, &content, &assignments, &seen, &links_state, &isbns, &files_state, &planned, &page_paths, &skipped, &root);
    write(README, &readme)?;
    progress(STEP_WRITING, 1, 1);

    let readings = links_state.values().filter(|r| r.path.is_some()).count();
    let links = web_pages.len();
    let state = CourseState {
        name: course.name.clone(),
        code: course.code.clone(),
        term: course.term.clone(),
        folder,
        files: files_state,
        links: links_state,
        due,
        last_sync: Some(store::now_ms()),
    };
    Ok(Outcome { state, files: present, downloaded, readings, links, skipped })
}

#[allow(clippy::too_many_arguments)]
fn readme(
    course: &Course,
    session: &Session,
    content: &CourseContent,
    assignments: &[(&super::Assignment, String, Option<i64>)],
    seen: &[LinkSeen],
    links: &BTreeMap<String, LinkRec>,
    isbns: &[Isbn],
    files: &BTreeMap<String, FileRec>,
    planned: &[PathBuf],
    pages: &[PathBuf],
    skipped: &[String],
    root: &Path,
) -> String {
    let mut s = format!("# {}\n\n", one_line(&course.name));
    let facts: Vec<String> = [course.code.clone(), course.term.clone()].into_iter().flatten().collect();
    if !facts.is_empty() {
        s.push_str(&format!("{}\n\n", facts.join(" · ")));
    }
    s.push_str(&format!(
        "Imported from {} on {}. Importing again updates this folder and downloads only what changed.\n\n",
        session.site.base.as_str().trim_end_matches('/'),
        store::display_time(store::now_secs())
    ));

    s.push_str("## Coming up\n\n");
    let now = store::now_secs();
    let upcoming: Vec<_> = assignments.iter().filter(|(_, _, t)| t.is_some_and(|t| t >= now)).take(10).collect();
    if upcoming.is_empty() {
        s.push_str("Nothing with a due date ahead on the course site.\n\n");
    } else {
        for (a, anc, t) in upcoming {
            s.push_str(&format!("- {}: [{}](assignments.md#{anc})\n", store::display_time(t.unwrap_or(0)), one_line(&a.title).replace(['[', ']'], "")));
        }
        s.push('\n');
    }

    s.push_str("## Textbooks and readings\n\n");
    let mut any = false;
    let label = |l: &LinkSeen, r: &LinkRec| {
        let t = r.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| one_line(&l.found.text));
        let t = if t.is_empty() { l.found.url.to_string() } else { t };
        t.replace(['[', ']'], "")
    };
    // An ISBN in the same sentence as a linked textbook belongs to that entry.
    let mut placed = vec![false; isbns.len()];
    let mut isbn_of = |l: &LinkSeen| -> String {
        let text = one_line(&l.found.text);
        let mut s = String::new();
        for (n, i) in isbns.iter().enumerate() {
            if !placed[n] && !text.is_empty() && (i.line.contains(&text) || l.found.context.contains(&i.line) || l.found.context.contains(i.isbn.as_str())) {
                placed[n] = true;
                s.push_str(&format!(" ISBN {}.", i.isbn));
            }
        }
        s
    };
    for l in seen.iter().filter(|l| l.textbook) {
        let Some(r) = links.get(&file_key(&l.found.url)) else { continue };
        any = true;
        let isbn = isbn_of(l);
        match (&r.path, r.web_page) {
            (Some(p), _) => {
                let source = match r.via.as_deref() {
                    Some(page) => format!("the PDF linked from its page {page}"),
                    None => format!("downloaded from {}", l.found.url),
                };
                let copy = if text::kind_of(Path::new(p)) != text::Doc::Other && root.join(format!("{p}.md")).is_file() { format!(" Text copy: [{p}.md]({}.md).", names::link_target(Path::new(p))) } else { String::new() };
                s.push_str(&format!(
                    "- **Textbook**: [{}]({}), {source} (linked from {}).{isbn}{copy}\n",
                    label(l, r),
                    names::link_target(Path::new(p)),
                    l.from
                ));
            }
            (None, true) => s.push_str(&format!(
                "- **Textbook**: [{}]({}) (linked from {}) is a web page, not a file, so there’s no copy here; read it online.\n",
                label(l, r),
                l.found.url,
                l.from
            )),
            (None, false) => s.push_str(&format!(
                "- **Textbook**: [{}]({}) (linked from {}) {}.\n",
                label(l, r),
                l.found.url,
                l.from,
                r.note.as_deref().unwrap_or("wasn’t downloaded")
            )),
        }
    }
    for (_, i) in isbns.iter().enumerate().filter(|(n, _)| !placed[*n]) {
        any = true;
        s.push_str(&format!(
            "- **Textbook**: ISBN {}, from “{}”. The course doesn’t link a copy; the library or bookstore can find it by this number.\n",
            i.isbn,
            i.line.trim_end_matches('.').replace(['[', ']'], "")
        ));
    }
    for l in seen.iter().filter(|l| !l.textbook) {
        let Some(r) = links.get(&file_key(&l.found.url)) else { continue };
        match (&r.path, r.web_page, &r.note) {
            (Some(p), _, _) => {
                any = true;
                s.push_str(&format!("- Reading: [{}]({}), downloaded from {} (linked from {}).\n", label(l, r), names::link_target(Path::new(p)), l.found.url, l.from));
            }
            (None, false, Some(note)) if looks_like_document(&l.found.url) => {
                any = true;
                s.push_str(&format!("- Reading: [{}]({}) (linked from {}) {note}.\n", label(l, r), l.found.url, l.from));
            }
            _ => {}
        }
    }
    if !any {
        s.push_str("The course doesn’t name a textbook or link any readings.\n");
    }
    s.push('\n');

    s.push_str("## In this folder\n\n");
    if content.syllabus.is_some() {
        s.push_str("- [syllabus.md](syllabus.md): the syllabus\n");
    } else {
        s.push_str("- The course site has no syllabus for this course.\n");
    }
    if !assignments.is_empty() {
        s.push_str(&format!("- [assignments.md](assignments.md): {} by due date\n", count(assignments.len(), "assignment", "assignments")));
    }
    if !content.announcements.is_empty() {
        s.push_str(&format!("- [announcements.md](announcements.md): {}, newest first\n", count(content.announcements.len(), "announcement", "announcements")));
    }
    if !content.modules.is_empty() {
        s.push_str(&format!("- [modules.md](modules.md): {} in the course’s order\n", count(content.modules.len(), "module", "modules")));
    }
    let web = links.values().filter(|r| r.web_page && r.path.is_none()).count();
    if web > 0 {
        s.push_str(&format!("- [links.md](links.md): {} the course links to\n", count(web, "web page", "web pages")));
    }
    let mut list = |title: &str, items: Vec<String>| {
        if items.is_empty() {
            return;
        }
        s.push_str(&format!("\n### {title}\n\n"));
        for it in items.iter().take(INDEX_LIST_MAX) {
            s.push_str(&format!("- [{}]({})\n", it.replace(['[', ']'], ""), names::link_target(Path::new(it))));
        }
        if items.len() > INDEX_LIST_MAX {
            s.push_str(&format!("- …and {} more\n", items.len() - INDEX_LIST_MAX));
        }
    };
    list("Pages", pages.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect());
    let mut saved: Vec<String> = files.values().map(|r| r.path.clone()).collect();
    saved.sort();
    let _ = planned;
    list("Files", saved);
    let mut readings: Vec<String> = links.values().filter_map(|r| r.path.clone()).collect();
    readings.sort();
    list("Readings", readings);
    if !skipped.is_empty() {
        s.push_str("\n## Not imported\n\n");
        for k in skipped {
            s.push_str(&format!("- {k}\n"));
        }
    }
    s
}

fn looks_like_document(u: &Url) -> bool {
    matches!(ext_of(u.path()).as_str(), "pdf" | "epub" | "docx" | "doc" | "pptx" | "ppt" | "xlsx" | "odt" | "rtf")
}

#[cfg(test)]
mod tests;
