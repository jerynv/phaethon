//! What each imported course document is made of, so nobody works from bad
//! text without knowing it: typed pages read from their text layer, pages
//! that are handwriting or scans (read by text recognition, with how many of
//! their words the course's typed material also uses, a rough sign of how
//! well they were read), typed pages that also show pictures (figures,
//! diagrams: those can't be read as text), and pages nothing could be read
//! from.
//!
//! Worked out at import (and every re-import) from each document's text copy
//! and its pages' text layers (text.rs, in a child process), and kept with the
//! course in lms.json. A document unchanged since it was last looked at keeps
//! what was found then; only how well its handwriting was read is worked out
//! again, against the course as it is now.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::text::{self, Layer};

pub const VERSION: u32 = 1;
/// Below this share of known words, handwriting was read poorly; below [`FAIR`], so-so.
pub const GOOD: f32 = 0.85;
pub const FAIR: f32 = 0.65;
/// Most bytes of a text copy read.
const COPY_MAX: u64 = 16 * 1024 * 1024;

/// One document of a course.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuality {
    /// Relative to the course folder ("files/Notes/week 3.pdf").
    pub path: String,
    /// Pages (a picture file is one; 0 for Word and PowerPoint, read whole).
    #[serde(default)]
    pub pages: u32,
    /// Pages read from their text layer.
    #[serde(default)]
    pub typed: u32,
    /// Pages read from their picture by text recognition (handwriting, scans).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handwriting: Vec<u32>,
    /// Pages that are pictures nothing could be read from (recognition not
    /// available, failed, or a picture with no words).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<u32>,
    /// Typed pages that also show pictures: (page, how many).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pictures: Vec<(u32, u32)>,
    /// Of the words read from its handwriting, the share the course's typed
    /// material also uses (0 to 1): a rough sign of how well they were read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_words: Option<f32>,
    /// What this was worked out from: the document's size and its text copy's time changed.
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub copy_modified: u64,
}

impl FileQuality {
    /// Pages a model that can't see pictures reads badly or not at all.
    pub fn flagged_pages(&self) -> u32 {
        (self.handwriting.len() + self.unreadable.len()) as u32
    }
    pub fn picture_count(&self) -> u32 {
        self.pictures.iter().map(|(_, n)| n).sum()
    }
    pub fn flagged(&self) -> bool {
        self.flagged_pages() > 0 || !self.pictures.is_empty()
    }
    /// Pages worth showing a model that can look at pictures: handwriting and
    /// unreadable pages first, then typed pages with pictures.
    pub fn picture_pages(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self.handwriting.iter().chain(&self.unreadable).copied().collect();
        out.sort_unstable();
        out.extend(self.pictures.iter().map(|(p, _)| *p));
        out
    }
}

/// Every document of a course.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub files: Vec<FileQuality>,
    /// Why handwriting couldn't be read on the computer that imported it, when it couldn't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cant_recognise: Option<String>,
}

/// A document worth naming in a report: its path and what is wrong with it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flagged {
    pub path: String,
    pub handwriting: u32,
    pub unreadable: u32,
    pub pictures: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_words: Option<f32>,
}

/// A report in numbers and words, as the UI shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub documents: usize,
    /// Documents with nothing flagged.
    pub typed_documents: usize,
    pub handwriting_pages: u32,
    pub unreadable_pages: u32,
    /// Pictures on typed pages.
    pub pictures: u32,
    /// "good", "fair" or "poor": how well the handwriting was read, when there is any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readability: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_words: Option<f32>,
    /// Why handwriting couldn't be read here, with what to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cant_recognise: Option<String>,
    /// The report in sentences, most important first.
    pub lines: Vec<String>,
    pub flagged: Vec<Flagged>,
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn readability(share: f32) -> &'static str {
    if share >= GOOD {
        "good"
    } else if share >= FAIR {
        "fair"
    } else {
        "poor"
    }
}

/// [`Summary`] of the documents of `report` for which `keep` holds.
pub fn summarise(report: &Report, keep: impl Fn(&FileQuality) -> bool) -> Summary {
    let files: Vec<&FileQuality> = report.files.iter().filter(|f| keep(f)).collect();
    let mut s = Summary { documents: files.len(), cant_recognise: report.cant_recognise.clone(), ..Default::default() };
    let (mut known, mut weight) = (0.0f32, 0.0f32);
    for f in &files {
        s.handwriting_pages += f.handwriting.len() as u32;
        s.unreadable_pages += f.unreadable.len() as u32;
        s.pictures += f.picture_count();
        if f.flagged() {
            s.flagged.push(Flagged { path: f.path.clone(), handwriting: f.handwriting.len() as u32, unreadable: f.unreadable.len() as u32, pictures: f.picture_count(), known_words: f.known_words });
        } else {
            s.typed_documents += 1;
        }
        if let Some(k) = f.known_words {
            known += k * f.handwriting.len() as f32;
            weight += f.handwriting.len() as f32;
        }
    }
    if weight > 0.0 {
        let share = known / weight;
        s.known_words = Some(share);
        s.readability = Some(readability(share));
    }
    if s.handwriting_pages > 0 {
        let how = match s.readability {
            Some("good") => "read with text recognition; it reads well, but may contain mistakes",
            Some("fair") => "read with text recognition; expect some mistakes",
            Some(_) => "read with text recognition, and much of it reads badly: expect many mistakes",
            None => "read with text recognition; may contain mistakes",
        };
        let are = if s.handwriting_pages == 1 { "page is" } else { "pages are" };
        s.lines.push(format!("{} {are} handwriting or scans: {how}.", s.handwriting_pages));
    }
    if s.unreadable_pages > 0 {
        let why = match &s.cant_recognise {
            Some(w) => format!(": {w}"),
            None => " (pictures with no words, or text recognition couldn’t read them)".into(),
        };
        let are = if s.unreadable_pages == 1 { "page couldn’t be read" } else { "pages couldn’t be read" };
        s.lines.push(format!("{} {are} at all{why}.", s.unreadable_pages));
    }
    if s.pictures > 0 {
        let they = if s.pictures == 1 { "it can’t be read as text" } else { "they can’t be read as text" };
        s.lines.push(format!("{}: {they}.", plural(s.pictures, "picture (a figure, diagram or photo)", "pictures (figures, diagrams or photos)")));
    }
    if s.lines.is_empty() && s.documents > 0 {
        s.lines.push(format!("{} typed text, read as it is.", if s.documents == 1 { "The document is".to_string() } else { format!("All {} documents are", s.documents) }));
    }
    s
}

// ---- Working it out ---------------------------------------------------------------

/// A text copy's pages: number → (recognised from a picture?, its text).
fn copy_pages(copy: &str) -> BTreeMap<u32, (bool, String)> {
    let mut out = BTreeMap::new();
    let mut cur: Option<(u32, bool, String)> = None;
    for line in copy.lines() {
        if let Some(rest) = line.strip_prefix("## Page ") {
            if let Some((n, r, t)) = cur.take() {
                out.insert(n, (r, t));
            }
            let num: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if let Ok(n) = num.parse() {
                cur = Some((n, rest.contains(text::RECOGNISED), String::new()));
            }
            continue;
        }
        if let Some((_, _, t)) = cur.as_mut() {
            t.push_str(line);
            t.push('\n');
        }
    }
    if let Some((n, r, t)) = cur {
        out.insert(n, (r, t));
    }
    out
}

/// A page whose copy says it couldn't be read.
fn says_unreadable(body: &str) -> bool {
    let b = body.trim();
    b.starts_with('(') && (b.contains(text::CANT_RECOGNISE) || b.contains("couldn’t be recognised") || b.contains("needs macOS for now") || b.contains("such pages are recognised"))
}

/// One PDF, from its pages' text layers and its text copy.
pub fn assess_pdf(path: &str, layers: &[Layer], copy: &str) -> FileQuality {
    let pages = copy_pages(copy);
    let mut q = FileQuality { path: path.to_string(), pages: layers.len() as u32, ..Default::default() };
    for l in layers {
        let typed_layer = text::letters(&l.text) >= text::SPARSE;
        match pages.get(&l.page) {
            Some((true, _)) => q.handwriting.push(l.page),
            Some((false, body)) if says_unreadable(body) => q.unreadable.push(l.page),
            Some((false, body)) if body.trim() == "(No text was found on this page.)" => {
                // A picture with no words (a diagram or photo page); a blank page is nothing.
                if l.pictures > 0 {
                    q.unreadable.push(l.page);
                }
            }
            Some(_) | None if typed_layer => {
                q.typed += 1;
                if l.pictures > 0 {
                    q.pictures.push((l.page, l.pictures));
                }
            }
            Some(_) => q.typed += 1,
            // Not in the copy (it was cut at its size limit), and no text of its own.
            None => q.unreadable.push(l.page),
        }
    }
    q
}

/// A picture file, from its text copy.
pub fn assess_picture(path: &str, copy: &str) -> FileQuality {
    let mut q = FileQuality { path: path.to_string(), pages: 1, ..Default::default() };
    if copy.contains("## Picture") && copy.contains(text::RECOGNISED) {
        q.handwriting.push(1);
    } else if copy.contains(text::NO_TEXT_IN_PICTURE) {
        q.pictures.push((1, 1));
    } else {
        q.unreadable.push(1);
    }
    q
}

fn modified_ms(p: &Path) -> u64 {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn read_copy(p: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if !meta.is_file() || meta.len() > COPY_MAX {
        return None;
    }
    std::fs::read_to_string(p).ok()
}

/// Words worth checking: letters only, three or more, lower case.
fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase)
}

/// Everyday English words, so a course with little typed text still has a vocabulary.
const COMMON: &str = "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what where which while would there their about after again also back because before being between both could each even every first give great into last little look most must never next other right same should since small still these thing think those three through under until upon used using want went work world year then then example examples note notes section chapter page lecture class problem problems answer question questions show prove proof true false given find value values number numbers case cases set sets list called means mean define defined definition rule rules form forms part parts order step steps method follows following therefore thus hence let suppose assume consider write written read";

/// The course's typed words: its typed pages and Markdown (syllabus, pages, assignments…).
fn vocabulary(root: &Path, report: &Report) -> HashSet<String> {
    let mut v: HashSet<String> = COMMON.split_whitespace().map(String::from).collect();
    for f in &report.files {
        let Some(copy) = read_copy(&root.join(format!("{}.md", f.path))) else { continue };
        if f.pages == 0 {
            v.extend(words(&copy));
            continue;
        }
        for (n, (recognised, body)) in copy_pages(&copy) {
            if !recognised && !f.unreadable.contains(&n) {
                v.extend(words(&body));
            }
        }
    }
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if meta.is_dir() && seen < 2000 {
                seen += 1;
                stack.push(p);
            } else if meta.is_file()
                && name.ends_with(".md")
                && is_plain_markdown(&name)
                && let Some(t) = read_copy(&p)
            {
                v.extend(words(&t));
            }
        }
    }
    v
}

/// Markdown the import wrote itself (not a document's text copy).
fn is_plain_markdown(name: &str) -> bool {
    let stem = name.trim_end_matches(".md");
    !Path::new(stem).extension().is_some_and(|e| matches!(e.to_string_lossy().to_ascii_lowercase().as_str(), "pdf" | "docx" | "pptx" | "png" | "jpg" | "jpeg" | "heic" | "heif" | "tif" | "tiff" | "gif" | "webp" | "bmp"))
}

/// Of the words read from `f`'s handwriting pages, the share in `vocab`.
fn known_share(root: &Path, f: &FileQuality, vocab: &HashSet<String>) -> Option<f32> {
    if f.handwriting.is_empty() {
        return None;
    }
    let copy = read_copy(&root.join(format!("{}.md", f.path)))?;
    let (mut known, mut all) = (0usize, 0usize);
    let pages = copy_pages(&copy);
    let bodies: Vec<&str> = if f.pages == 1 && pages.is_empty() { vec![copy.as_str()] } else { f.handwriting.iter().filter_map(|n| pages.get(n).map(|(_, b)| b.as_str())).collect() };
    for body in bodies {
        for w in words(body) {
            all += 1;
            if vocab.contains(&w) || vocab.contains(w.trim_end_matches('s')) {
                known += 1;
            }
        }
    }
    (all > 0).then(|| known as f32 / all as f32)
}

/// Every document in `docs` (paths relative to the course folder `root`),
/// reusing what `prev` found for one unchanged since. `layers` reads a PDF's
/// pages (text.rs's child). A document with no text copy is left out.
pub fn assess_course(root: &Path, docs: &[String], prev: Option<&Report>, layers: &dyn Fn(&Path) -> Result<Vec<Layer>, String>) -> Report {
    let mut report = Report { version: VERSION, files: vec![], cant_recognise: text::ocr::availability().err() };
    let mut seen = HashSet::new();
    for rel in docs {
        if !seen.insert(rel.clone()) {
            continue;
        }
        let full = root.join(rel);
        let copy_path = root.join(format!("{rel}.md"));
        let Some(copy) = read_copy(&copy_path) else { continue };
        let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
        let copy_modified = modified_ms(&copy_path);
        if let Some(old) = prev.filter(|p| p.version == VERSION).and_then(|p| p.files.iter().find(|f| &f.path == rel))
            && old.size == size
            && old.copy_modified == copy_modified
        {
            report.files.push(old.clone());
            continue;
        }
        let mut q = match text::kind_of(&full) {
            text::Doc::Pdf => match layers(&full) {
                Ok(l) => assess_pdf(rel, &l, &copy),
                Err(_) => FileQuality { path: rel.clone(), ..Default::default() },
            },
            text::Doc::Picture => assess_picture(rel, &copy),
            text::Doc::Docx | text::Doc::Pptx => FileQuality { path: rel.clone(), ..Default::default() },
            text::Doc::Other => continue,
        };
        q.size = size;
        q.copy_modified = copy_modified;
        report.files.push(q);
    }
    let vocab = vocabulary(root, &report);
    let shares: Vec<Option<f32>> = report.files.iter().map(|f| known_share(root, f, &vocab)).collect();
    for (f, s) in report.files.iter_mut().zip(shares) {
        f.known_words = s.map(|x| (x * 1000.0).round() / 1000.0);
    }
    report.files.sort_by(|a, b| a.path.cmp(&b.path));
    report
}

/// The documents of a course folder worth assessing: those under files/ and
/// readings/ a text copy is made for, by path relative to it.
pub fn documents(root: &Path) -> Vec<String> {
    let mut out = vec![];
    for top in ["files", "readings"] {
        let mut stack = vec![root.join(top)];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
                if meta.is_dir() && out.len() < 5000 {
                    stack.push(p);
                } else if meta.is_file() && text::kind_of(&p) != text::Doc::Other && let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
                }
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(page: u32, t: &str, pictures: u32) -> Layer {
        Layer { page, text: t.into(), pictures }
    }

    const TYPED: &str = "A function f is injective if no two inputs give the same output.";

    #[test]
    fn each_page_is_typed_handwriting_a_picture_or_unreadable() {
        let layers = [l(1, TYPED, 0), l(2, "", 1), l(3, TYPED, 2), l(4, "", 1), l(5, "", 0), l(6, "", 0), l(7, "", 1)];
        let copy = format!(
            "# Text of notes.pdf\n\n## Page 1\n\n{TYPED}\n\n## Page 2 {}\n\nSets and subsets\n\n## Page 3\n\n{TYPED}\n\n{}2 pictures (figures, diagrams or photos); they can’t be read as text.)\n\n## Page 4\n\n(No text was found on this page.)\n\n## Page 5\n\n(No text was found on this page.)\n\n## Page 6\n\n(This page is handwriting or a scan, and {} it needs the tesseract program.)\n\n## Page 7\n\n(This page is handwriting or a scan, and its text couldn’t be recognised: recognising its text took too long.)",
            text::RECOGNISED,
            text::PICTURES_NOTE,
            text::CANT_RECOGNISE
        );
        let q = assess_pdf("files/notes.pdf", &layers, &copy);
        assert_eq!(q.pages, 7);
        assert_eq!(q.typed, 2);
        assert_eq!(q.handwriting, [2]);
        assert_eq!(q.pictures, [(3, 2)]);
        assert_eq!(q.unreadable, [4, 6, 7], "a picture with no words, recognition missing, recognition failed; page 5 is blank");
        assert_eq!(q.flagged_pages(), 4);
        assert_eq!(q.picture_pages(), [2, 4, 6, 7, 3]);
        // Old copies said "needs macOS".
        let old = "## Page 1\n\n(This page is handwriting or a scan; text recognition needs macOS for now.)";
        assert_eq!(assess_pdf("x.pdf", &[l(1, "", 1)], old).unreadable, [1]);

        assert_eq!(assess_picture("files/board.jpg", &format!("## Picture {}\n\nO(n log n)", text::RECOGNISED)).handwriting, [1]);
        assert_eq!(assess_picture("files/venn.png", text::NO_TEXT_IN_PICTURE).pictures, [(1, 1)]);
        assert_eq!(assess_picture("files/venn.png", "(This is a picture, and its text can’t be recognised on this computer: x.)").unreadable, [1]);
    }

    #[test]
    fn the_summary_says_it_in_numbers_and_words() {
        let r = Report {
            version: VERSION,
            files: vec![
                FileQuality { path: "files/a.pdf".into(), pages: 10, typed: 10, ..Default::default() },
                FileQuality { path: "files/notes.pdf".into(), pages: 12, handwriting: (1..=12).collect(), known_words: Some(0.7), ..Default::default() },
                FileQuality { path: "files/slides.pdf".into(), pages: 30, typed: 30, pictures: vec![(3, 4), (9, 5)], ..Default::default() },
            ],
            cant_recognise: None,
        };
        let s = summarise(&r, |_| true);
        assert_eq!((s.documents, s.typed_documents, s.handwriting_pages, s.pictures, s.unreadable_pages), (3, 1, 12, 9, 0));
        assert_eq!(s.readability, Some("fair"));
        assert_eq!(
            s.lines,
            ["12 pages are handwriting or scans: read with text recognition; expect some mistakes.", "9 pictures (figures, diagrams or photos): they can’t be read as text."]
        );
        assert_eq!(s.flagged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["files/notes.pdf", "files/slides.pdf"]);
        let only = summarise(&r, |f| f.path == "files/a.pdf");
        assert_eq!(only.lines, ["The document is typed text, read as it is."]);
        let none = Report { cant_recognise: Some("it needs tesseract".into()), files: vec![FileQuality { path: "x.pdf".into(), pages: 2, unreadable: vec![1, 2], ..Default::default() }], ..r };
        assert_eq!(summarise(&none, |_| true).lines, ["2 pages couldn’t be read at all: it needs tesseract."]);
    }

    /// The report for real imported courses, read only:
    /// `PHAETHON_MATERIAL_COURSES=<a copy of <vault>/courses> cargo test --lib material_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn material_real() {
        let dir = std::path::PathBuf::from(std::env::var_os("PHAETHON_MATERIAL_COURSES").expect("set PHAETHON_MATERIAL_COURSES"));
        let mut courses: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        courses.sort();
        for c in courses {
            let docs = documents(&c);
            let started = std::time::Instant::now();
            let r = assess_course(&c, &docs, None, &|p| text::pdf_layers(None, p));
            let s = summarise(&r, |_| true);
            eprintln!("\n== {} ({} documents, {:.1?})", c.file_name().unwrap().to_string_lossy(), s.documents, started.elapsed());
            eprintln!("typed only: {}; handwriting pages: {}; unreadable pages: {}; pictures on typed pages: {}; known words: {:?} ({:?})", s.typed_documents, s.handwriting_pages, s.unreadable_pages, s.pictures, s.known_words, s.readability);
            for l in &s.lines {
                eprintln!("  {l}");
            }
            for f in &s.flagged {
                eprintln!("  - {} hw {} unreadable {} pictures {} known {:?}", f.path, f.handwriting, f.unreadable, f.pictures, f.known_words);
            }
        }
    }

    #[test]
    fn a_course_is_assessed_from_its_copies_and_unchanged_documents_are_reused() {
        let root = std::env::temp_dir().join(format!("phaethon-material-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("files/Notes")).unwrap();
        std::fs::write(root.join("syllabus.md"), "We study sets, functions, relations and graphs.").unwrap();
        std::fs::write(root.join("files/Notes/hand.pdf"), b"%PDF-1.4 x").unwrap();
        std::fs::write(
            root.join("files/Notes/hand.pdf.md"),
            format!("# Text of hand.pdf\n\n## Page 1 {}\n\nsets and fnctions and relatons\n\n## Page 2\n\n{TYPED}", text::RECOGNISED),
        )
        .unwrap();
        std::fs::write(root.join("files/deck.pptx"), b"PK").unwrap();
        std::fs::write(root.join("files/deck.pptx.md"), "## Slide 1\n\nGraphs").unwrap();
        std::fs::write(root.join("files/raw.pdf"), b"%PDF").unwrap(); // no copy: left out
        let docs = documents(&root);
        assert_eq!(docs, ["files/Notes/hand.pdf", "files/deck.pptx", "files/raw.pdf"]);
        let calls = std::cell::Cell::new(0);
        let layers = |_: &Path| {
            calls.set(calls.get() + 1);
            Ok(vec![l(1, "", 1), l(2, TYPED, 0)])
        };
        let r = assess_course(&root, &docs, None, &layers);
        assert_eq!(r.files.len(), 2);
        let hand = &r.files[0];
        assert_eq!((hand.handwriting.as_slice(), hand.typed), (&[1u32][..], 1));
        // "sets", "and" ×2 known; "fnctions", "relatons" not: 3 of 5.
        assert_eq!(hand.known_words, Some(0.6));
        assert_eq!(calls.get(), 1);
        // Unchanged: no PDF read again.
        let again = assess_course(&root, &docs, Some(&r), &layers);
        assert_eq!(calls.get(), 1);
        assert_eq!(again, r);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
