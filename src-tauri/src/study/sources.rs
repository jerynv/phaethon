//! The course material a deck or quiz is made from, cut to a budget.
//!
//! The person picks course folders or files in the space. A course folder
//! gives its syllabus, assignments, pages, readings and the text copies of its
//! files (`x.pdf.md`, made at import); a PDF or Office file gives its text
//! copy. Real lecture notes run to 500 KB, far more than a model call should
//! carry, so each file gets a share of the budget by how useful it tends to be
//! (a review sheet before the syllabus's policies), and a file longer than its
//! share is cut into sections and sampled: the sections that mention the focus
//! when there is one, else sections spread evenly through it.

use std::fs;
use std::path::{Path, PathBuf};

use crate::lms::access::{self, Place, Seen, Visible};
use crate::tools;

/// Characters of material sent with one request (about 15k tokens).
pub const BUDGET: usize = 60_000;
const CHUNK: usize = 2_500;
/// A file whose share would be smaller than this is left out.
const MIN_SHARE: usize = 600;
const MAX_FILES: usize = 400;
const MAX_SENT: usize = 40;
const READ_MAX: u64 = 4 * 1024 * 1024;
const WALK_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    /// Every source as `<source path="...">text</source>`.
    pub text: String,
    /// The paths the material came from, as the model must cite them.
    pub labels: Vec<String>,
    /// The course folder name, when every source is in the same course.
    pub course: Option<String>,
}

struct Found {
    /// What the card cites: the original file (`x.pdf`), relative to the space.
    label: String,
    /// The file actually read (`x.pdf.md`).
    real: PathBuf,
    weight: f64,
    /// For a course file: its course and path inside it, to show it as the space may see it.
    course: Option<(Seen, PathBuf)>,
}

fn is_text(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"))
}

/// Index files an import writes, which hold links, not material.
fn is_index(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    matches!(name.as_str(), "readme.md" | "modules.md" | "links.md")
}

fn weight(rel: &str, explicit: bool, focus: &[String]) -> f64 {
    let r = rel.to_lowercase();
    let name = r.rsplit('/').next().unwrap_or(&r);
    let mut w = if explicit {
        10.0
    } else if ["review", "exam", "midterm", "final", "study guide", "practice", "test "].iter().any(|k| name.contains(k)) {
        8.0
    } else if ["notes", "lecture", "slides", "chapter"].iter().any(|k| name.contains(k)) {
        6.0
    } else if r.contains("/readings/") {
        5.0
    } else if name.contains("syllabus") {
        2.0
    } else if matches!(name, "assignments.md" | "announcements.md") {
        1.0
    } else if r.contains("/pages/") || r.contains("/files/") {
        4.0
    } else {
        3.0
    };
    if focus.iter().any(|f| name.contains(f.as_str())) {
        w *= 2.0;
    }
    w
}

/// Words of the focus worth searching for.
pub fn focus_terms(focus: Option<&str>) -> Vec<String> {
    const STOP: [&str; 12] = ["the", "and", "for", "with", "from", "about", "that", "this", "what", "into", "are", "how"];
    focus
        .unwrap_or("")
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .map(String::from)
        .collect()
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// `x.pdf.md` beside `x.pdf` cites `x.pdf`; anything else cites itself.
fn label_for(root: &Path, real: &Path) -> String {
    let rel = rel_of(root, real);
    if let Some(stem) = rel.strip_suffix(".md")
        && Path::new(stem).extension().is_some()
        && real.with_extension("").is_file()
    {
        return stem.to_string();
    }
    rel
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > WALK_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // Never follow a link: it could lead out of the space.
        let Ok(meta) = fs::symlink_metadata(e.path()) else { continue };
        if meta.is_dir() {
            walk(&e.path(), depth + 1, out);
        } else if meta.is_file() && is_text(&e.path()) && out.len() < MAX_FILES {
            out.push(e.path());
        }
    }
}

/// Where a source `rel` (relative to the space) leads. Every source path goes
/// through here, so what a space may read is decided in one place: its own
/// files, or `courses/...` as far as course-access.json lets it see them.
pub fn resolve<'a>(space: &Path, courses: &'a Visible, rel: &str) -> Result<Source<'a>, String> {
    let refused = || format!("“{rel}” isn’t in this space.");
    match tools::clean_rel(rel).ok().filter(|c| access::is_courses_path(c)) {
        Some(clean) => match courses.place(&clean, true).map_err(|_| refused())? {
            Place::Root => Ok(Source::Courses),
            Place::Course { seen, dir, sub, real } => Ok(Source::Course { seen, dir, sub, real }),
        },
        None => tools::resolve(space, rel, true).map(Source::Local).map_err(|_| refused()),
    }
}

/// A resolved source.
pub enum Source<'a> {
    Local(PathBuf),
    /// `courses` itself: every course the space may see.
    Courses,
    Course { seen: &'a Seen, dir: PathBuf, sub: PathBuf, real: PathBuf },
}

/// One imported course a space can make cards from, and which of the standard
/// parts its folder has (what the source picker offers).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseSource {
    /// The course's name, from its README's title (else the folder's name).
    pub name: String,
    /// "courses/<folder>", as study sources name it.
    pub folder: String,
    pub syllabus: bool,
    pub assignments: bool,
    pub files: bool,
    pub readings: bool,
}

/// The courses this space may see, by name, with the parts of each it may
/// see that the folder has (never through a link).
pub fn courses(visible: &Visible) -> Vec<CourseSource> {
    use access::Part;
    let mut out: Vec<CourseSource> = visible
        .courses
        .iter()
        .filter_map(|seen| {
            let dir = visible.dir_of(seen)?;
            let plain = |name: &str| fs::symlink_metadata(dir.join(name)).is_ok_and(|m| !m.file_type().is_symlink());
            Some(CourseSource {
                name: if seen.state.name.trim().is_empty() { seen.folder().to_string() } else { seen.state.name.clone() },
                folder: format!("courses/{}", seen.folder()),
                syllabus: seen.can(Part::Syllabus) && plain("syllabus.md"),
                assignments: seen.can(Part::Assignments) && plain("assignments.md"),
                files: seen.can(Part::Files) && plain("files"),
                readings: seen.can(Part::Files) && plain("readings"),
            })
        })
        .collect();
    out.sort_by_key(|c| c.name.to_lowercase());
    out
}

/// The text files of a chosen folder (a course folder, or any folder): the one
/// place a folder's material is listed.
pub fn folder_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = vec![];
    walk(dir, 0, &mut files);
    files
}

/// What a course file is cited as: `courses/<folder>/<path>`, the original
/// (`x.pdf`) for a text copy (`x.pdf.md`).
fn course_label(seen: &Seen, sub: &Path, real: &Path) -> String {
    let rel = sub.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let rel = match rel.strip_suffix(".md") {
        Some(stem) if Path::new(stem).extension().is_some() && real.with_extension("").is_file() => stem.to_string(),
        _ => rel,
    };
    format!("courses/{}/{rel}", seen.folder())
}

/// The files `inputs` (paths relative to the space) stand for, checked to stay
/// inside what the space may read.
fn find(space: &Path, visible: &Visible, inputs: &[String], focus: &[String]) -> Result<Vec<Found>, String> {
    let root = space.canonicalize().map_err(|e| format!("This space’s folder can’t be read: {e}"))?;
    let mut found: Vec<Found> = vec![];
    let in_course = |seen: &Seen, dir: &Path, start: &Path, found: &mut Vec<Found>| {
        for (sub, f) in visible.walk(seen, dir, start, MAX_FILES) {
            let label = course_label(seen, &sub, &f);
            if is_text(&f) && !is_index(&label) {
                found.push(Found { weight: weight(&label, false, focus), label, real: f, course: Some((seen.clone(), sub)) });
            }
        }
    };
    for input in inputs {
        let shown = input.trim().trim_end_matches('/');
        if shown.is_empty() {
            continue;
        }
        match resolve(&root, visible, shown)? {
            Source::Courses => {
                for seen in &visible.courses {
                    if let Some(dir) = visible.dir_of(seen) {
                        in_course(seen, &dir, &dir, &mut found);
                    }
                }
            }
            Source::Course { seen, dir, real, .. } if real.is_dir() => in_course(seen, &dir, &real, &mut found),
            Source::Course { seen, dir, sub, real } => {
                if is_text(&real) {
                    found.push(Found { label: course_label(seen, &sub, &real), weight: weight(shown, true, focus), real, course: Some((seen.clone(), sub)) });
                } else {
                    // The text copy beside it, checked like any other course path.
                    let copy = visible.place(&tools::clean_rel(&format!("{shown}.md"))?, true).ok().and_then(|p| match p {
                        Place::Course { real, sub, .. } if fs::symlink_metadata(&real).is_ok_and(|m| m.is_file()) => Some((real, sub)),
                        _ => None,
                    });
                    let Some((copy, copy_sub)) = copy else { return Err(no_copy(&real)) };
                    let _ = dir;
                    found.push(Found { label: course_label(seen, &sub, &real), weight: weight(shown, true, focus), real: copy, course: Some((seen.clone(), copy_sub)) });
                }
            }
            Source::Local(real) if real.is_dir() => {
                for f in folder_files(&real) {
                    let rel = rel_of(&root, &f);
                    // The space's own folder named like the courses is never read as material.
                    if !is_index(&rel) && !access::is_courses_path(Path::new(&rel)) {
                        found.push(Found { label: label_for(&root, &f), weight: weight(&rel, false, focus), real: f, course: None });
                    }
                }
            }
            Source::Local(real) if is_text(&real) => found.push(Found { label: label_for(&root, &real), weight: weight(shown, true, focus), real, course: None }),
            Source::Local(real) => {
                let copy = PathBuf::from(format!("{}.md", real.display()));
                if !fs::symlink_metadata(&copy).is_ok_and(|m| m.is_file()) {
                    return Err(no_copy(&real));
                }
                found.push(Found { label: rel_of(&root, &real), weight: weight(shown, true, focus), real: copy, course: None });
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|f| seen.insert(f.real.clone()));
    if found.is_empty() {
        return Err("There’s nothing to read in what you chose: no notes, syllabus or text copies of files.".into());
    }
    Ok(found)
}

fn no_copy(real: &Path) -> String {
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("“{name}” has no text copy Phaethon can read. Import the course again, or choose its text instead.")
}

/// Text copies of PDFs break lines after every symbol ("x\n∈\nA"): join those
/// fragments, drop the copy's own header, and squeeze spaces.
pub fn clean(text: &str) -> String {
    let mut out: Vec<String> = vec![];
    let mut prev_short = false;
    for (i, raw) in text.lines().enumerate() {
        if i < 4 && (raw.starts_with("# Text of ") || raw.starts_with("Copied from [")) {
            continue;
        }
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            prev_short = false;
            if out.last().is_some_and(|l| !l.is_empty()) {
                out.push(String::new());
            }
            continue;
        }
        let short = line.chars().count() <= 3;
        let heading = line.starts_with('#');
        match out.last_mut() {
            Some(last) if !last.is_empty() && !heading && !last.starts_with('#') && (short || prev_short) => {
                last.push(' ');
                last.push_str(&line);
            }
            _ => out.push(line),
        }
        prev_short = short;
    }
    out.join("\n").trim().to_string()
}

/// Cut text into sections of about [`CHUNK`] characters, at paragraph or page
/// breaks where it can, never inside a character.
pub fn chunks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    for para in text.split("\n\n") {
        if !cur.is_empty() && cur.len() + para.len() > CHUNK {
            out.push(std::mem::take(&mut cur));
        }
        if para.len() > CHUNK * 2 {
            let mut piece = String::new();
            for line in para.split_inclusive('\n') {
                for ch in line.chars() {
                    piece.push(ch);
                    if piece.len() >= CHUNK && (ch == ' ' || ch == '\n') {
                        out.push(std::mem::take(&mut piece));
                    }
                }
            }
            cur = piece;
            continue;
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// At most `allot` characters of `text`: all of it when it fits, else the
/// sections that mention `focus` most (in their order), else sections spread
/// evenly. Gaps are marked `[…]`.
pub fn sample(text: &str, allot: usize, focus: &[String]) -> String {
    if text.len() <= allot {
        return text.to_string();
    }
    let parts = chunks(text);
    let take = (allot / CHUNK).max(1).min(parts.len());
    let mut picked: Vec<usize> = if focus.is_empty() {
        (0..take).map(|i| i * parts.len() / take).collect()
    } else {
        let mut scored: Vec<(usize, usize)> = parts
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let lower = p.to_lowercase();
                (focus.iter().map(|f| lower.matches(f.as_str()).count()).sum(), i)
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let hits: Vec<usize> = scored.iter().filter(|(s, _)| *s > 0).take(take).map(|(_, i)| *i).collect();
        if hits.is_empty() { (0..take).map(|i| i * parts.len() / take).collect() } else { hits }
    };
    picked.sort();
    picked.dedup();
    let mut out = String::new();
    let mut last: Option<usize> = None;
    for i in picked {
        if last.map_or(i > 0, |l| i > l + 1) {
            out.push_str("\n[…]\n");
        }
        let room = allot.saturating_sub(out.len());
        if room == 0 {
            break;
        }
        let part = &parts[i];
        let end = (0..=room.min(part.len())).rev().find(|&e| part.is_char_boundary(e)).unwrap_or(0);
        out.push_str(&part[..end]);
        last = Some(i);
    }
    if last.is_some_and(|l| l + 1 < parts.len()) {
        out.push_str("\n[…]");
    }
    out
}

/// Read and budget the material behind `inputs` (paths in the space).
pub fn gather(space: &Path, visible: &Visible, inputs: &[String], focus: Option<&str>, budget: usize) -> Result<Material, String> {
    let terms = focus_terms(focus);
    let mut found = find(space, visible, inputs, &terms)?;
    found.sort_by(|a, b| b.weight.total_cmp(&a.weight).then(a.label.cmp(&b.label)));
    found.truncate(MAX_SENT);
    let mut texts: Vec<(Found, String)> = vec![];
    for f in found {
        let Ok(file) = fs::File::open(&f.real) else { continue };
        let mut bytes = vec![];
        let _ = std::io::Read::read_to_end(&mut std::io::Read::take(file, READ_MAX), &mut bytes);
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if let Some((seen, sub)) = &f.course {
            text = access::filter_text(seen, sub, text);
        }
        let text = clean(&text);
        if !text.trim().is_empty() {
            texts.push((f, text));
        }
    }
    if texts.is_empty() {
        return Err("The files you chose are empty, so there’s nothing to make cards from.".into());
    }
    // Shares by weight; a file shorter than its share gives the rest back.
    let mut allot = vec![0usize; texts.len()];
    let mut open: Vec<usize> = (0..texts.len()).collect();
    open.sort_by_key(|&i| texts[i].1.len());
    let mut left = budget;
    loop {
        let w: f64 = open.iter().map(|&i| texts[i].0.weight).sum();
        let Some(pos) = open.iter().position(|&i| texts[i].1.len() as f64 <= left as f64 * texts[i].0.weight / w) else { break };
        let i = open.remove(pos);
        allot[i] = texts[i].1.len();
        left -= allot[i];
        if open.is_empty() {
            break;
        }
    }
    let w: f64 = open.iter().map(|&i| texts[i].0.weight).sum();
    for &i in &open {
        allot[i] = (left as f64 * texts[i].0.weight / w) as usize;
    }
    let mut text = String::new();
    let mut labels = vec![];
    for (i, (f, body)) in texts.iter().enumerate() {
        if allot[i] < MIN_SHARE.min(body.len()) {
            continue;
        }
        text.push_str(&format!("<source path=\"{}\">\n{}\n</source>\n\n", f.label, sample(body, allot[i], &terms)));
        labels.push(f.label.clone());
    }
    let course = |l: &String| l.strip_prefix("courses/").and_then(|r| r.split_once('/')).map(|(c, _)| c.to_string());
    let first = labels.first().and_then(course);
    let course = first.filter(|c| labels.iter().all(|l| course(l).as_deref() == Some(c.as_str())));
    Ok(Material { text: text.trim_end().to_string(), labels, course })
}

// ---- Files read for checking: a cited file, a whole course --------------------------

/// A file's text as the space may read it, by what it is cited as.
#[derive(Debug, Clone, PartialEq)]
pub struct Cited {
    /// What it is cited as: `courses/<folder>/<path>`, the original for a text copy.
    pub label: String,
    /// Its text (the text copy for a PDF), filtered to what the space may see, not cleaned.
    pub text: String,
}

fn read_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("it couldn’t be read: {e}"))?;
    let mut bytes = vec![];
    std::io::Read::read_to_end(&mut std::io::Read::take(file, READ_MAX), &mut bytes).map_err(|e| format!("it couldn’t be read: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The file a citation names, read through the same walls as the material:
/// the space's own files or the courses it may see, the parts it may see,
/// never through a link, a PDF through its text copy. `Err` when it isn't a
/// file this space can read (whatever the reason: the same words).
pub fn read_cited(space: &Path, visible: &Visible, cited: &str) -> Result<Cited, String> {
    let shown = cited.trim().trim_start_matches("./").trim_end_matches('/');
    let refused = || format!("“{shown}” isn’t a file this space can read");
    if shown.is_empty() {
        return Err(refused());
    }
    let root = space.canonicalize().map_err(|_| refused())?;
    match resolve(&root, visible, shown).map_err(|_| refused())? {
        Source::Course { seen, sub, real, .. } if fs::symlink_metadata(&real).is_ok_and(|m| m.is_file()) => {
            let (copy, copy_sub) = if is_text(&real) {
                (real.clone(), sub.clone())
            } else {
                match visible.place(&tools::clean_rel(&format!("{shown}.md")).map_err(|_| refused())?, true) {
                    Ok(Place::Course { real: c, sub: s, .. }) if fs::symlink_metadata(&c).is_ok_and(|m| m.is_file()) => (c, s),
                    _ => return Err(refused()),
                }
            };
            let text = access::filter_text(seen, &copy_sub, read_text(&copy)?);
            Ok(Cited { label: course_label(seen, &sub, &real), text })
        }
        Source::Local(real) if fs::symlink_metadata(&real).is_ok_and(|m| m.is_file()) => {
            if is_text(&real) {
                Ok(Cited { label: label_for(&root, &real), text: read_text(&real)? })
            } else {
                let copy = PathBuf::from(format!("{}.md", real.display()));
                if !fs::symlink_metadata(&copy).is_ok_and(|m| m.is_file()) {
                    return Err(refused());
                }
                Ok(Cited { label: rel_of(&root, &real), text: read_text(&copy)? })
            }
        }
        _ => Err(refused()),
    }
}

/// One text file of a course, as the space may see it.
#[derive(Debug, Clone, PartialEq)]
pub struct CourseFile {
    /// `courses/<folder>/<path>` (the original for a text copy).
    pub label: String,
    /// Its path inside the course folder (the text copy's).
    pub sub: PathBuf,
    pub text: String,
    pub size: u64,
    pub modified: u64,
}

/// Every text file of `seen` the space may see (index files left out), in
/// path order. At most [`MAX_FILES`].
pub fn course_files(visible: &Visible, seen: &Seen) -> Vec<CourseFile> {
    let Some(dir) = visible.dir_of(seen) else { return vec![] };
    let mut out = vec![];
    for (sub, real) in visible.walk(seen, &dir, &dir, MAX_FILES) {
        let label = course_label(seen, &sub, &real);
        if !is_text(&real) || is_index(&label) {
            continue;
        }
        let Ok(meta) = fs::metadata(&real) else { continue };
        let Ok(text) = read_text(&real) else { continue };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        out.push(CourseFile { text: access::filter_text(seen, &sub, text), label, sub, size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

/// The course `inputs` all come from, when they name exactly one course the
/// space sees (a course folder or files in it).
pub fn course_of<'a>(space: &Path, visible: &'a Visible, inputs: &[String]) -> Option<&'a Seen> {
    let root = space.canonicalize().ok()?;
    let mut found: Option<&Seen> = None;
    for input in inputs.iter().map(|i| i.trim().trim_end_matches('/')).filter(|i| !i.is_empty()) {
        let seen = match resolve(&root, visible, input).ok()? {
            Source::Course { seen, .. } => seen,
            Source::Courses if visible.courses.len() == 1 => &visible.courses[0],
            _ => return None,
        };
        if found.is_some_and(|f| f.key != seen.key) {
            return None;
        }
        found = Some(seen);
    }
    found
}

/// Lower-case words of `text` (letters only, at least two), for "does the
/// course ever use this word".
pub fn words_of(text: &str, into: &mut std::collections::HashSet<String>) {
    for w in text.split(|c: char| !c.is_alphabetic()) {
        if w.chars().count() >= 2 {
            into.insert(w.to_lowercase());
        }
    }
}

/// The label among `labels` a model's citation means: exact, or the one whose
/// file name matches (models shorten paths).
pub fn match_label(cited: &str, labels: &[String]) -> Option<String> {
    let c = cited.trim().trim_start_matches("./");
    if let Some(l) = labels.iter().find(|l| l.as_str() == c) {
        return Some(l.clone());
    }
    let name = |s: &str| s.rsplit('/').next().unwrap_or(s).trim_end_matches(".md").to_lowercase();
    let n = name(c);
    let hits: Vec<&String> = labels.iter().filter(|l| name(l) == n || l.ends_with(c)).collect();
    (hits.len() == 1).then(|| hits[0].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::access::{Part, fixture};

    /// A vault in a temp folder; returns (vault root, the space "s").
    fn vault(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("phaethon-study-src-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("spaces/s")).unwrap();
        let root = root.canonicalize().unwrap();
        (root.clone(), root.join("spaces/s"))
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn the_courses_a_space_sees_and_their_parts() {
        let (root, _) = vault("courses");
        put(&root, "courses/CSCI-C 241 Fall 2026/files/x.pdf.md", "x");
        put(&root, "courses/CSCI-C 241 Fall 2026/readings/r.pdf.md", "x");
        put(&root, "courses/CSCI-C 241 Fall 2026/syllabus.md", "x");
        put(&root, "courses/CSCI-C 241 Fall 2026/assignments.md", "x");
        fs::create_dir_all(root.join("courses/Bare")).unwrap();
        fs::create_dir_all(root.join("courses/Hidden")).unwrap();
        let vis = fixture(&root, "s", &[("CSCI-C 241 Fall 2026", &[Part::Syllabus, Part::Files]), ("Bare", &Part::ALL), ("Hidden", &[])]);
        let got = courses(&vis);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].name, "Bare");
        assert!(!got[0].syllabus && !got[0].files);
        assert_eq!(got[1].folder, "courses/CSCI-C 241 Fall 2026");
        assert!(got[1].syllabus && got[1].files && got[1].readings, "{got:?}");
        assert!(!got[1].assignments, "assignments aren't shown to this space");
        assert!(courses(&Visible::default()).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pdf_text_fragments_are_joined() {
        let raw = "# Text of x.pdf\n\nCopied from [x.pdf](x.pdf) so it can be read here.\n\n## Page 1\n\nThree different members of\n{\n2\nx\n|\nx\n∈\nR\n}\n that are not members.\n(a)\nThe parking lot is open.";
        let c = clean(raw);
        assert!(!c.contains("Text of") && !c.contains("Copied from"));
        assert!(c.contains("Three different members of { 2 x | x ∈ R } that are not members."), "{c}");
        assert!(c.contains("(a) The parking lot is open."), "{c}");
        assert!(c.starts_with("## Page 1"));
    }

    #[test]
    fn a_course_folder_gives_its_material_cited_as_the_original_files() {
        let (root, dir) = vault("course");
        let f = "CSCI-C 241 Fall 2026";
        let c = format!("courses/{f}");
        put(&root, &format!("{c}/README.md"), "index only");
        put(&root, &format!("{c}/syllabus.md"), "# Syllabus\nGrading policy.");
        put(&root, &format!("{c}/files/HW/Test 1 Review.pdf"), "%PDF");
        put(&root, &format!("{c}/files/HW/Test 1 Review.pdf.md"), "# Text of Test 1 Review.pdf\n\nTranslate into logic.");
        put(&root, &format!("{c}/files/HW/HW 01.pdf"), "%PDF");
        put(&root, &format!("{c}/.hidden.md"), "secret");
        put(&dir, ".phaethon/state.md", "never");
        let vis = fixture(&root, "s", &[(f, &Part::ALL)]);
        let m = gather(&dir, &vis, std::slice::from_ref(&c), None, BUDGET).unwrap();
        assert_eq!(m.course.as_deref(), Some(f));
        assert_eq!(m.labels[0], format!("{c}/files/HW/Test 1 Review.pdf"), "the review sheet first, cited as the PDF");
        assert!(m.labels.contains(&format!("{c}/syllabus.md")));
        assert!(!m.text.contains("index only") && !m.text.contains("secret") && !m.text.contains("never"));
        assert!(m.text.contains("Translate into logic."));
        // "courses" itself: every course the space sees.
        assert_eq!(gather(&dir, &vis, &["courses".into()], None, BUDGET).unwrap().labels, m.labels);
        // A PDF chosen on its own is read through its text copy...
        let m = gather(&dir, &vis, &[format!("{c}/files/HW/Test 1 Review.pdf")], None, BUDGET).unwrap();
        assert_eq!(m.labels, [format!("{c}/files/HW/Test 1 Review.pdf")]);
        // ...and one without a copy says so.
        assert!(gather(&dir, &vis, &[format!("{c}/files/HW/HW 01.pdf")], None, BUDGET).unwrap_err().contains("no text copy"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_the_parts_the_space_may_see_are_material() {
        let (root, dir) = vault("parts");
        let c = "courses/C";
        put(&root, &format!("{c}/syllabus.md"), "Syllabus text.");
        put(&root, &format!("{c}/grades.md"), "Grade 91%.");
        put(&root, &format!("{c}/files/notes.pdf.md"), "Lecture notes text.");
        put(&root, &format!("{c}/README.md"), "# C\n\n**Grades**: 91% so far.\n\n## Coming up\n\nPS 4.\n");
        let vis = fixture(&root, "s", &[("C", &[Part::Syllabus, Part::Overview])]);
        let m = gather(&dir, &vis, &[c.into()], None, BUDGET).unwrap();
        assert_eq!(m.labels, [format!("{c}/syllabus.md")]);
        for bad in ["courses/C/grades.md", "courses/C/files/notes.pdf.md", "courses/C/files", "courses/D", "courses/C/../C/grades.md"] {
            assert!(gather(&dir, &vis, &[bad.into()], None, BUDGET).is_err(), "{bad}");
        }
        // README chosen on its own: as the space may see it, without the grade.
        let m = gather(&dir, &vis, &[format!("{c}/README.md")], None, BUDGET).unwrap();
        assert!(m.text.contains("PS 4") && !m.text.contains("91%"), "{}", m.text);
        // Another space sees nothing of it.
        fs::create_dir_all(root.join("spaces/t")).unwrap();
        let other = crate::lms::access::visible(&crate::vault::Vault::at(&root), "t");
        assert!(gather(&root.join("spaces/t"), &other, &[format!("{c}/syllabus.md")], None, BUDGET).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn paths_outside_the_space_are_refused() {
        let (root, dir) = vault("escape");
        put(&dir, "notes.md", "fine");
        let outside = root.join("outside");
        put(&outside, "secret.md", "secret");
        // The space's own leftover courses folder is never material.
        put(&dir, "courses/Old/notes.md", "secret");
        let vis = Visible::default();
        for bad in ["../x", "/etc/passwd", ".phaethon/progress.json", "nope.md", "courses/Old/notes.md", "Courses/Old"] {
            assert!(gather(&dir, &vis, &[bad.into()], None, BUDGET).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("s.md")).unwrap();
            assert!(gather(&dir, &vis, &["link".into()], None, BUDGET).is_err());
            assert!(gather(&dir, &vis, &["s.md".into()], None, BUDGET).is_err());
            // A link inside a chosen folder is skipped, not followed.
            let m = gather(&dir, &vis, &["".into(), ".".into()], None, BUDGET).unwrap();
            assert!(!m.text.contains("secret"), "{}", m.text);
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn big_notes_are_budgeted_and_sampled() {
        let (root, dir) = vault("budget");
        // 500 KB of "lecture notes", one section mentioning bipartite graphs.
        let mut notes = String::new();
        for i in 0..200 {
            notes.push_str(&format!("## Page {i}\n\n"));
            let topic = if i == 150 { "A bipartite graph splits its vertices in two." } else { "Sets and functions and logic." };
            for _ in 0..80 {
                notes.push_str(topic);
                notes.push(' ');
            }
            notes.push_str("\n\n");
        }
        assert!(notes.len() > 400_000);
        put(&root, "courses/C/files/Notes/Lecture Notes.pdf.md", &notes);
        put(&root, "courses/C/files/Notes/Lecture Notes.pdf", "%PDF");
        put(&root, "courses/C/syllabus.md", "Short syllabus.");
        let vis = fixture(&root, "s", &[("C", &Part::ALL)]);
        let m = gather(&dir, &vis, &["courses/C".into()], None, BUDGET).unwrap();
        assert!(m.text.len() <= BUDGET + 2_000, "{}", m.text.len());
        assert!(m.text.contains("Short syllabus."), "a short file is sent whole");
        assert!(m.text.contains("[…]"));
        let pages: Vec<u32> = m.text.split("## Page ").skip(1).filter_map(|s| s.split_whitespace().next()?.parse().ok()).collect();
        assert!(pages.len() >= 10 && pages.contains(&0) && pages.iter().any(|&p| p >= 170), "spread through the notes: {pages:?}");
        // With a focus, the matching section is in.
        let m = gather(&dir, &vis, &["courses/C".into()], Some("bipartite graphs"), 10_000).unwrap();
        assert!(m.text.contains("bipartite graph splits"));
        assert!(m.text.len() <= 12_000);
        fs::remove_dir_all(&root).unwrap();
    }


    #[test]
    fn sampling_never_splits_a_character() {
        let text = "é".repeat(20_000);
        let s = sample(&text, 5_000, &[]);
        assert!(s.len() <= 5_100);
        assert!(s.chars().all(|c| c == 'é' || "[…]\n".contains(c)));
    }

    #[test]
    fn citations_are_matched_to_the_sources() {
        let labels = vec!["courses/C/files/HW/Test 1 Review.pdf".to_string(), "courses/C/syllabus.md".to_string()];
        assert_eq!(match_label("courses/C/syllabus.md", &labels), Some(labels[1].clone()));
        assert_eq!(match_label("Test 1 Review.pdf", &labels), Some(labels[0].clone()));
        assert_eq!(match_label("files/HW/Test 1 Review.pdf.md", &labels), Some(labels[0].clone()));
        assert_eq!(match_label("lecture.pdf", &labels), None);
    }
}
