//! Study and what a course's documents are made of (lms/material.rs): which
//! pages a model reads badly from their text (handwriting, scans, diagrams),
//! the pictures of those pages for a model that can look at them, a quote
//! read from such a picture checked against the page's recognised text, and
//! what to tell the person when their model can't look.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::Serialize;

use super::model::Picture;
use super::quote;
use super::scope::{self, ExamScope, ScopeMap};
use crate::lms::access::{Seen, Visible};
use crate::lms::material::{FileQuality, Report, summarise};
use crate::lms::text;
use crate::vision::{self, Alert, Sight};

/// Pictures shown in one call: mapping, writing, checking.
pub const MAP_PICTURES: usize = 6;
pub const WRITE_PICTURES: usize = 6;
pub const CHECK_PICTURES: usize = 4;
/// Most bytes of pictures (as base64) in one call.
const CALL_BYTES: usize = 16 * 1024 * 1024;
/// Largest picture file sent as it is.
const FILE_BYTES: u64 = 3_500_000;

/// A page of a course file: its label (`courses/<folder>/files/x.pdf`) and page number.
pub type PageRef = (String, u32);

pub fn report_of(seen: &Seen) -> Option<&Report> {
    seen.state.material.as_ref()
}

/// The file a label names inside the course folder ("files/x.pdf").
pub fn rel_of<'a>(seen: &Seen, label: &'a str) -> Option<&'a str> {
    label.strip_prefix("courses/")?.strip_prefix(seen.folder())?.strip_prefix('/')
}

/// What the report says about the file `label` names.
pub fn quality<'a>(seen: &'a Seen, label: &str) -> Option<&'a FileQuality> {
    let rel = rel_of(seen, label)?;
    report_of(seen)?.files.iter().find(|f| f.path == rel)
}

/// Pages that count against a model that can't see: handwriting, unreadable, and typed pages with pictures.
fn weight(f: &FileQuality) -> u32 {
    f.flagged_pages() + f.pictures.len() as u32
}

/// The pictures of `pages`, at most `max` (and [`CALL_BYTES`] in all), in
/// the order given: each PDF page drawn or taken as stored (text.rs, in a
/// child process), a picture file as it is. A page that can't be had is left out.
pub fn pictures(visible: &Visible, seen: &Seen, pages: &[PageRef], max: usize) -> Vec<Picture> {
    let Some(dir) = visible.dir_of(seen) else { return vec![] };
    let mut by_file: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    let mut order: Vec<&str> = vec![];
    for (label, page) in pages.iter().take(max) {
        if !by_file.contains_key(label.as_str()) {
            order.push(label);
        }
        by_file.entry(label).or_default().push(*page);
    }
    let mut got: Vec<(String, u32, Picture)> = vec![];
    for label in order {
        let Some(rel) = rel_of(seen, label) else { continue };
        let Ok(clean) = crate::tools::clean_rel(rel) else { continue };
        let path = dir.join(clean);
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let wanted = &by_file[label];
        match text::kind_of(&path) {
            text::Doc::Pdf => {
                for p in text::page_pictures(None, &path, wanted) {
                    got.push((label.to_string(), p.page, Picture { label: format!("{label}, page {}", p.page), mime: p.mime, data: p.data }));
                }
            }
            text::Doc::Picture => {
                if let Some(pic) = picture_file(&path, label) {
                    got.push((label.to_string(), 1, pic));
                }
            }
            _ => {}
        }
    }
    // Back in the order asked for, within the size limit.
    let mut out = vec![];
    let mut bytes = 0;
    for (label, page) in pages.iter().take(max) {
        if let Some(i) = got.iter().position(|(l, p, _)| l == label && p == page) {
            let (_, _, pic) = got.remove(i);
            if bytes + pic.data.len() > CALL_BYTES {
                break;
            }
            bytes += pic.data.len();
            out.push(pic);
        }
    }
    out
}

/// A picture file a model can take as it is (PNG, JPEG, GIF, WebP, not too big).
fn picture_file(path: &Path, label: &str) -> Option<Picture> {
    use base64::Engine;
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    if std::fs::metadata(path).ok()?.len() > FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(Picture { label: label.to_string(), mime: mime.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// What the model is told about the pictures it is shown.
pub fn pictures_note(shown: &[Picture]) -> String {
    if shown.is_empty() {
        return String::new();
    }
    let list: Vec<String> = shown.iter().map(|p| p.label.clone()).collect();
    format!(
        "\n\n<pictures>\nThe pictures attached are these pages, in order: {}. Each is handwriting, a scan, or a page with a figure; its text above was read by text recognition and may be wrong, or is missing. Read them from the pictures. A quote from one of these pages may be in the words you see on it, cited by the file's path as usual: it is checked against the recognised text loosely, and shown as read from a picture.\n</pictures>",
        list.join("; ")
    )
}

/// A quote that isn't word for word in a file's text, checked against the
/// pages of it shown as pictures (`shown`): the page it roughly matches.
/// Only pages recognised from their picture: a typed page (even one shown
/// for its figure) is held to the exact check.
pub fn picture_quote(copy: &str, shown: &[u32], q: &str) -> Option<u32> {
    let recognised = |p: u32| copy.lines().any(|l| l.strip_prefix("## Page ").is_some_and(|r| r.starts_with(&format!("{p} ")) && r.contains(text::RECOGNISED)));
    shown.iter().copied().filter(|&p| recognised(p)).find(|&p| quote::page_text(copy, p).is_some_and(|t| quote::roughly(&t, q)))
}

/// Pages of each flagged file in a mapping call's text (`<source path="…">`
/// blocks), at most `max`, taken in turn from each file: those whose
/// "## Page N" the call shows, else the file's first flagged pages.
pub fn pages_in_chunk(seen: &Seen, chunk: &str, max: usize) -> Vec<PageRef> {
    let mut per_file: Vec<Vec<PageRef>> = vec![];
    for block in chunk.split("<source path=\"").skip(1) {
        let Some((label, body)) = block.split_once("\">") else { continue };
        let Some(q) = quality(seen, label) else { continue };
        let flagged = q.picture_pages();
        if flagged.is_empty() {
            continue;
        }
        let shown: Vec<u32> = body.lines().filter_map(|l| l.strip_prefix("## Page ")).filter_map(|r| r.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()).collect();
        let mut pages: Vec<u32> = flagged.iter().copied().filter(|p| shown.contains(p)).collect();
        if pages.is_empty() {
            pages = flagged.into_iter().take(2).collect();
        }
        per_file.push(pages.into_iter().map(|p| (label.to_string(), p)).collect());
    }
    round_robin(per_file, max)
}

/// The flagged pages the passages of a writing request come from (each
/// `<source path="…">` block found in its file's cleaned text: the page it
/// starts on and any it runs into), at most `max`, a file at a time in turn.
pub fn pages_of_passages(seen: &Seen, files: &[super::sources::CourseFile], material: &str, max: usize) -> Vec<PageRef> {
    let mut per_file: BTreeMap<String, Vec<PageRef>> = BTreeMap::new();
    let mut cleaned: BTreeMap<&str, String> = BTreeMap::new();
    for block in material.split("<source path=\"").skip(1) {
        let Some((label, rest)) = block.split_once("\">") else { continue };
        let Some(q) = quality(seen, label) else { continue };
        let flagged = q.picture_pages();
        if flagged.is_empty() {
            continue;
        }
        let Some(f) = files.iter().find(|f| f.label == label) else { continue };
        let clean = cleaned.entry(f.label.as_str()).or_insert_with(|| super::sources::clean(&f.text));
        let body = rest.split("</source>").next().unwrap_or("").trim();
        let mut cut = body.len().min(80);
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut pages: Vec<u32> = clean.find(&body[..cut]).and_then(|at| quote::page_at(clean, at)).into_iter().collect();
        pages.extend(body.lines().filter_map(|l| l.strip_prefix("## Page ")).filter_map(|r| r.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u32>().ok()));
        let list = per_file.entry(label.to_string()).or_default();
        for p in pages.into_iter().filter(|p| flagged.contains(p)) {
            if !list.iter().any(|(_, x)| *x == p) {
                list.push((label.to_string(), p));
            }
        }
    }
    round_robin(per_file.into_values().collect(), max)
}

/// One from each list in turn, until `max`.
pub fn round_robin(lists: Vec<Vec<PageRef>>, max: usize) -> Vec<PageRef> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    for i in 0..longest {
        for l in &lists {
            if out.len() >= max {
                return out;
            }
            if let Some(p) = l.get(i)
                && seen.insert(p.clone())
            {
                out.push(p.clone());
            }
        }
    }
    out
}

// ---- What the person is told -------------------------------------------------------------

/// One exam's share of the flagged pages.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamMaterial {
    pub title: String,
    pub pages: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert: Option<Alert>,
}

/// What Study shows about a course's material and the space's model.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialView {
    /// The report in sentences (lms/material.rs).
    pub lines: Vec<String>,
    /// Pages a model that can't see reads badly: handwriting, scans, pages with pictures.
    pub pages: u32,
    pub sight: Sight,
    /// For the whole course.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert: Option<Alert>,
    /// Each exam the map knows of.
    pub exams: Vec<ExamMaterial>,
}

/// The flagged pages an exam's material leans on: in files that its topics'
/// passages come from, and in files no topic's passage comes from (pages
/// the map couldn't read may well be in scope). Files only topics outside it
/// come from don't count. Without a map or a known scope: every flagged page.
pub fn exam_pages(report: &Report, folder: &str, map: Option<&ScopeMap>, exam: Option<&ExamScope>) -> u32 {
    let (Some(map), Some(exam)) = (map, exam.filter(|e| e.known)) else {
        return report.files.iter().map(weight).sum();
    };
    let rel = |label: &str| label.strip_prefix("courses/").and_then(|r| r.strip_prefix(folder)).and_then(|r| r.strip_prefix('/')).map(str::to_string);
    let inside: HashSet<String> = scope::in_scope(map, Some(exam)).iter().flat_map(|t| t.evidence.iter().filter_map(|e| rel(&e.source))).collect();
    let cited: HashSet<String> = map.topics.iter().flat_map(|t| t.evidence.iter().filter_map(|e| rel(&e.source))).collect();
    report.files.iter().filter(|f| inside.contains(&f.path) || !cited.contains(&f.path)).map(weight).sum()
}

/// Everything Study shows about `seen`'s material for a person whose model is `sight`.
pub fn view(seen: &Seen, map: Option<&ScopeMap>, exams: &[ExamScope], sight: &Sight) -> Option<MaterialView> {
    let report = report_of(seen)?;
    let s = summarise(report, |_| true);
    let pages: u32 = report.files.iter().map(weight).sum();
    let exams = exams
        .iter()
        .map(|e| {
            let n = exam_pages(report, seen.folder(), map, Some(e));
            ExamMaterial { title: e.title.clone(), pages: n, alert: vision::alert(n, &format!("{}’s material", e.title), sight) }
        })
        .collect();
    Some(MaterialView { lines: s.lines, pages, sight: sight.clone(), alert: vision::alert(pages, "this course", sight), exams })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::access::{Part, fixture};
    use crate::lms::material::VERSION;
    use crate::study::scope::{Evidence, Topic};
    use crate::vision::Sees;

    pub fn report() -> Report {
        Report {
            version: VERSION,
            files: vec![
                FileQuality { path: "files/Notes/week1.pdf".into(), pages: 3, handwriting: vec![1, 2, 3], ..Default::default() },
                FileQuality { path: "files/Notes/week9.pdf".into(), pages: 2, handwriting: vec![1, 2], ..Default::default() },
                FileQuality { path: "files/slides.pdf".into(), pages: 10, typed: 10, pictures: vec![(4, 2)], ..Default::default() },
                FileQuality { path: "files/typed.pdf".into(), pages: 5, typed: 5, ..Default::default() },
            ],
            cant_recognise: None,
        }
    }

    fn topic(id: &str, source: &str) -> Topic {
        Topic { id: id.into(), title: id.into(), sections: None, terms: vec![], weight: 1.0, homework: vec![], evidence: vec![Evidence { source: source.into(), quote: "q".into(), at: None, picture: None }], reference: false, assigned_by: vec![] }
    }

    #[test]
    fn an_exam_leans_on_the_flagged_pages_of_its_own_topics_and_of_what_no_topic_placed() {
        let r = report();
        let map = ScopeMap {
            version: scope::VERSION,
            course: "C".into(),
            name: "C".into(),
            parts: vec![],
            fingerprint: String::new(),
            built: 0,
            topics: vec![topic("t1", "courses/C/files/Notes/week1.pdf"), topic("t2", "courses/C/files/typed.pdf"), topic("t3", "courses/C/files/slides.pdf")],
            notation: vec![],
            exams: vec![],
            dropped: 0,
        };
        let exam = |inc: &[&str]| ExamScope { title: "Test 1".into(), date: None, known: true, summary: String::new(), includes: inc.iter().map(|s| s.to_string()).collect(), excludes: vec![], excluded_words: vec![], homework: vec![], evidence: vec![], from_user: false };
        // t1's handwriting (3) and week 9, which no topic placed (2).
        assert_eq!(exam_pages(&r, "C", Some(&map), Some(&exam(&["t1", "t2"]))), 5);
        // t3's slides (1 page with pictures) and week 9; not week 1, only t1's.
        assert_eq!(exam_pages(&r, "C", Some(&map), Some(&exam(&["t3"]))), 3);
        // No map, or a scope not known: all of it.
        assert_eq!(exam_pages(&r, "C", None, None), 6);
        let unknown = ExamScope { known: false, ..exam(&[]) };
        assert_eq!(exam_pages(&r, "C", Some(&map), Some(&unknown)), 6);
    }

    #[test]
    fn the_view_alerts_only_a_model_that_isnt_shown_the_pictures() {
        let root = std::env::temp_dir().join(format!("phaethon-study-material-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("courses/C/files")).unwrap();
        let mut vis = fixture(&root, "s", &[("C", &Part::ALL)]);
        assert!(view(&vis.courses[0], None, &[], &Sight { sees: Sees::No, model: "m".into(), shown: false }).is_none(), "no report yet");
        vis.courses[0].state.material = Some(report());
        let blind = Sight { sees: Sees::No, model: "gpt-3.5-turbo".into(), shown: false };
        let v = view(&vis.courses[0], None, &[], &blind).unwrap();
        assert_eq!(v.pages, 6);
        assert!(v.alert.as_ref().unwrap().text.starts_with("Your model can’t look at pictures, and 6 pages of this course are handwriting or diagrams."), "{:?}", v.alert);
        assert_eq!(v.lines[0], "5 pages are handwriting or scans: read with text recognition; may contain mistakes.");
        let sees = Sight { sees: Sees::Yes, model: "Claude Code".into(), shown: true };
        assert_eq!(view(&vis.courses[0], None, &[], &sees).unwrap().alert, None);

        // Mapping calls are shown the flagged pages of the files they carry.
        let chunk = "<source path=\"courses/C/files/Notes/week1.pdf\">\n## Page 1 (recognised…)\n\nsets\n\n## Page 2 (recognised…)\n\nmore\n[… the rest of this file isn’t shown here]\n</source>\n\n<source path=\"courses/C/files/slides.pdf\">\n## Page 1\n\ntext\n</source>\n\n<source path=\"courses/C/files/typed.pdf\">x</source>";
        let pages = pages_in_chunk(&vis.courses[0], chunk, 6);
        assert_eq!(pages, [("courses/C/files/Notes/week1.pdf".to_string(), 1), ("courses/C/files/slides.pdf".to_string(), 4), ("courses/C/files/Notes/week1.pdf".to_string(), 2)]);
        assert_eq!(pages_in_chunk(&vis.courses[0], chunk, 1).len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Real Claude Code calls (one per page) on real handwritten pages, read
    /// only: `PHAETHON_VISION_PAGES="<pdf>|<page>;<pdf>|<page>" PHAETHON_VISION_OUT=<file.md>
    /// cargo test --lib vision_real -- --ignored --nocapture`. Writes, per page, what text
    /// recognition read (from the text copy beside the PDF) and what the model read from the picture.
    #[test]
    #[ignore]
    fn vision_real() {
        let spec = std::env::var("PHAETHON_VISION_PAGES").expect("set PHAETHON_VISION_PAGES");
        let out = std::env::var("PHAETHON_VISION_OUT").expect("set PHAETHON_VISION_OUT");
        let bin = crate::agent::claude::find_claude().expect("claude");
        let cwd = std::env::temp_dir().join(format!("phaethon-vision-real-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let m = crate::study::model::CliModel { bin, cwd: cwd.clone(), config_dir: None };
        let mut report = String::new();
        for item in spec.split(';').filter(|s| !s.trim().is_empty()) {
            let (pdf, page) = item.rsplit_once('|').unwrap();
            let page: u32 = page.trim().parse().unwrap();
            let path = std::path::Path::new(pdf.trim());
            let copy = std::fs::read_to_string(format!("{}.md", path.display())).unwrap();
            let before = quote::page_text(&copy, page).unwrap_or_default();
            let pics = text::page_pictures(None, path, &[page]);
            let pic = Picture { label: format!("{}, page {page}", path.file_name().unwrap().to_string_lossy()), mime: pics[0].mime.clone(), data: pics[0].data.clone() };
            let started = std::time::Instant::now();
            let after = tauri::async_runtime::block_on(crate::study::model::Model::complete_seeing(
                &m,
                "You transcribe a student's handwritten class notes from a picture of one page, exactly as written: every word, and math in Unicode symbols (∈, ⊆, ∅, →). Lines as on the page. No commentary.",
                "Transcribe the page in the picture.",
                &[pic],
            ))
            .unwrap();
            // Each transcribed line that is a sentence, checked roughly against what recognition read.
            let lines: Vec<&str> = after.lines().filter(|l| l.split_whitespace().filter(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 3).count() >= 4).collect();
            let matched = lines.iter().filter(|l| quote::roughly(&before, l)).count();
            report.push_str(&format!(
                "## {} page {page} ({:.1?}, {} bytes {})\n\n### Text recognition (before)\n\n{before}\n\n### Read from the picture (after)\n\n{after}\n\nLines of four or more words that roughly match the recognised text: {matched} of {}\n\n",
                path.file_name().unwrap().to_string_lossy(),
                started.elapsed(),
                pics[0].data.len() * 3 / 4,
                pics[0].mime,
                lines.len()
            ));
        }
        std::fs::write(&out, report).unwrap();
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn a_picture_read_quote_is_found_on_the_page_shown_and_nowhere_else() {
        let copy = "## Page 1\n\nTyped words here and more.\n\n## Page 2 (recognised from handwriting or a scan; may contain mistakes)\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R";
        let q = "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R";
        assert_eq!(picture_quote(copy, &[2], q), Some(2));
        assert_eq!(picture_quote(copy, &[1], q), None, "only pages shown as pictures");
        assert_eq!(picture_quote(copy, &[], q), None);
    }

    #[test]
    fn pictures_of_a_scanned_pdf_and_a_picture_file_are_taken_as_stored() {
        let root = std::env::temp_dir().join(format!("phaethon-study-pictures-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("courses/C/files")).unwrap();
        let grey: Vec<u8> = (0..400 * 300).map(|i| (i % 200) as u8).collect();
        std::fs::write(root.join("courses/C/files/scan.pdf"), crate::lms::text::pictures::tests::grey_pdf(400, 300, &grey)).unwrap();
        let png = crate::lms::text::png::encode(2, 2, 1, &[0, 1, 2, 3], false).unwrap();
        std::fs::write(root.join("courses/C/files/board.png"), &png).unwrap();
        let vis = fixture(&root, "s", &[("C", &Part::ALL)]);
        let pages = [("courses/C/files/scan.pdf".to_string(), 1), ("courses/C/files/board.png".to_string(), 1), ("courses/C/files/scan.pdf".to_string(), 7), ("courses/C/../x.png".to_string(), 1)];
        let got = pictures(&vis, &vis.courses[0], &pages, 6);
        assert_eq!(got.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), ["courses/C/files/scan.pdf, page 1", "courses/C/files/board.png"]);
        assert_eq!(got[0].mime, "image/png");
        assert_eq!(got[1].mime, "image/png");
        assert_eq!(pictures(&vis, &vis.courses[0], &pages, 1).len(), 1, "never more than asked");
        assert!(pictures_note(&got).contains("courses/C/files/scan.pdf, page 1; courses/C/files/board.png"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
