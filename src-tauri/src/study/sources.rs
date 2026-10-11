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

/// The real path of a source `rel` (relative to the space). Every source path
/// goes through here, so what a space may read is decided in one place.
pub fn resolve(space: &Path, rel: &str) -> Result<PathBuf, String> {
    tools::resolve(space, rel, true).map_err(|_| format!("“{rel}” isn’t in this space."))
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

/// The course folders under `<space>/courses/` (never through a link), by name.
pub fn courses(space: &Path) -> Vec<CourseSource> {
    let Ok(entries) = fs::read_dir(space.join("courses")) else { return vec![] };
    let mut out: Vec<CourseSource> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let folder = e.file_name().to_str()?.to_string();
            let dir = e.path();
            let plain = |name: &str| fs::symlink_metadata(dir.join(name)).is_ok_and(|m| !m.file_type().is_symlink());
            let name = fs::read_to_string(dir.join("README.md"))
                .ok()
                .and_then(|r| r.lines().next().and_then(|l| l.strip_prefix("# ")).map(|t| t.trim().to_string()))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| folder.clone());
            Some(CourseSource {
                name,
                folder: format!("courses/{folder}"),
                syllabus: plain("syllabus.md"),
                assignments: plain("assignments.md"),
                files: plain("files"),
                readings: plain("readings"),
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

/// The files `inputs` (paths relative to the space) stand for, checked to stay
/// inside the space.
fn find(space: &Path, inputs: &[String], focus: &[String]) -> Result<Vec<Found>, String> {
    let root = space.canonicalize().map_err(|e| format!("This space’s folder can’t be read: {e}"))?;
    let mut found: Vec<Found> = vec![];
    for input in inputs {
        let shown = input.trim().trim_end_matches('/');
        if shown.is_empty() {
            continue;
        }
        let real = resolve(&root, shown)?;
        if real.is_dir() {
            for f in folder_files(&real) {
                let rel = rel_of(&root, &f);
                if !is_index(&rel) {
                    found.push(Found { label: label_for(&root, &f), weight: weight(&rel, false, focus), real: f });
                }
            }
        } else if is_text(&real) {
            found.push(Found { label: label_for(&root, &real), weight: weight(shown, true, focus), real });
        } else {
            let copy = PathBuf::from(format!("{}.md", real.display()));
            let ok = fs::symlink_metadata(&copy).is_ok_and(|m| m.is_file());
            if !ok {
                let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                return Err(format!("“{name}” has no text copy Phaethon can read. Import the course again, or choose its text instead."));
            }
            found.push(Found { label: rel_of(&root, &real), weight: weight(shown, true, focus), real: copy });
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|f| seen.insert(f.real.clone()));
    if found.is_empty() {
        return Err("There’s nothing to read in what you chose: no notes, syllabus or text copies of files.".into());
    }
    Ok(found)
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
pub fn gather(space: &Path, inputs: &[String], focus: Option<&str>, budget: usize) -> Result<Material, String> {
    let terms = focus_terms(focus);
    let mut found = find(space, inputs, &terms)?;
    found.sort_by(|a, b| b.weight.total_cmp(&a.weight).then(a.label.cmp(&b.label)));
    found.truncate(MAX_SENT);
    let mut texts: Vec<(Found, String)> = vec![];
    for f in found {
        let Ok(file) = fs::File::open(&f.real) else { continue };
        let mut bytes = vec![];
        let _ = std::io::Read::read_to_end(&mut std::io::Read::take(file, READ_MAX), &mut bytes);
        let text = clean(&String::from_utf8_lossy(&bytes));
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
    #[test]
    fn a_spaces_courses_and_their_parts() {
        let tmp = std::env::temp_dir().join(format!("phaethon-study-sources-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let c241 = tmp.join("courses/CSCI-C 241 Fall 2026");
        fs::create_dir_all(c241.join("files")).unwrap();
        fs::write(c241.join("README.md"), "# CSCI-C 241 Fall 2026 (All Sections)\n\nmore").unwrap();
        fs::write(c241.join("syllabus.md"), "x").unwrap();
        fs::create_dir_all(tmp.join("courses/Bare")).unwrap();
        fs::write(tmp.join("courses/not-a-folder.md"), "x").unwrap();
        let got = courses(&tmp);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "Bare");
        assert!(!got[0].syllabus && !got[0].files);
        assert_eq!(got[1].name, "CSCI-C 241 Fall 2026 (All Sections)");
        assert_eq!(got[1].folder, "courses/CSCI-C 241 Fall 2026");
        assert!(got[1].syllabus && got[1].files && !got[1].assignments && !got[1].readings);
        assert!(courses(&tmp.join("nowhere")).is_empty());
        fs::remove_dir_all(&tmp).unwrap();
    }

    use super::*;

    fn space(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-study-src-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
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
        let dir = space("course");
        let c = "courses/CSCI-C 241 Fall 2026";
        put(&dir, &format!("{c}/README.md"), "index only");
        put(&dir, &format!("{c}/syllabus.md"), "# Syllabus\nGrading policy.");
        put(&dir, &format!("{c}/files/HW/Test 1 Review.pdf"), "%PDF");
        put(&dir, &format!("{c}/files/HW/Test 1 Review.pdf.md"), "# Text of Test 1 Review.pdf\n\nTranslate into logic.");
        put(&dir, &format!("{c}/files/HW/HW 01.pdf"), "%PDF");
        put(&dir, &format!("{c}/.hidden.md"), "secret");
        put(&dir, ".phaethon/state.md", "never");
        let m = gather(&dir, &[c.to_string()], None, BUDGET).unwrap();
        assert_eq!(m.course.as_deref(), Some("CSCI-C 241 Fall 2026"));
        assert_eq!(m.labels[0], format!("{c}/files/HW/Test 1 Review.pdf"), "the review sheet first, cited as the PDF");
        assert!(m.labels.contains(&format!("{c}/syllabus.md")));
        assert!(!m.text.contains("index only") && !m.text.contains("secret") && !m.text.contains("never"));
        assert!(m.text.contains("Translate into logic."));
        // A PDF chosen on its own is read through its text copy...
        let m = gather(&dir, &[format!("{c}/files/HW/Test 1 Review.pdf")], None, BUDGET).unwrap();
        assert_eq!(m.labels, [format!("{c}/files/HW/Test 1 Review.pdf")]);
        // ...and one without a copy says so.
        assert!(gather(&dir, &[format!("{c}/files/HW/HW 01.pdf")], None, BUDGET).unwrap_err().contains("no text copy"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_outside_the_space_are_refused() {
        let dir = space("escape");
        put(&dir, "notes.md", "fine");
        let outside = space("escape-outside");
        put(&outside, "secret.md", "secret");
        for bad in ["../x", "/etc/passwd", ".phaethon/progress.json", "nope.md"] {
            assert!(gather(&dir, &[bad.into()], None, BUDGET).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("s.md")).unwrap();
            assert!(gather(&dir, &["link".into()], None, BUDGET).is_err());
            assert!(gather(&dir, &["s.md".into()], None, BUDGET).is_err());
            // A link inside a chosen folder is skipped, not followed.
            let m = gather(&dir, &["".into(), ".".into()], None, BUDGET).unwrap();
            assert!(!m.text.contains("secret"), "{}", m.text);
        }
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn big_notes_are_budgeted_and_sampled() {
        let dir = space("budget");
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
        put(&dir, "courses/C/files/Notes/Lecture Notes.pdf.md", &notes);
        put(&dir, "courses/C/files/Notes/Lecture Notes.pdf", "%PDF");
        put(&dir, "courses/C/syllabus.md", "Short syllabus.");
        let m = gather(&dir, &["courses/C".into()], None, BUDGET).unwrap();
        assert!(m.text.len() <= BUDGET + 2_000, "{}", m.text.len());
        assert!(m.text.contains("Short syllabus."), "a short file is sent whole");
        assert!(m.text.contains("[…]"));
        let pages: Vec<u32> = m.text.split("## Page ").skip(1).filter_map(|s| s.split_whitespace().next()?.parse().ok()).collect();
        assert!(pages.len() >= 10 && pages.contains(&0) && pages.iter().any(|&p| p >= 170), "spread through the notes: {pages:?}");
        // With a focus, the matching section is in.
        let m = gather(&dir, &["courses/C".into()], Some("bipartite graphs"), 10_000).unwrap();
        assert!(m.text.contains("bipartite graph splits"));
        assert!(m.text.len() <= 12_000);
        fs::remove_dir_all(dir).unwrap();
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
