//! What a course actually teaches, and what each exam covers: the scope map.
//!
//! Built by the study model (model.rs: every provider and CLI) from the
//! course's own text as the space may see it: the announcements, syllabus,
//! assignments, homework and review sheets whole, and the start (the table of
//! contents) of everything else. Every passage the model quotes as evidence is
//! looked up in its file (quote.rs) and dropped when it isn't there; a topic
//! left with no evidence is dropped, and an exam whose coverage has no
//! evidence is "unknown", never guessed. The person can say what an exam
//! covers; that is kept and shown as "from you".
//!
//! Kept in `<vault>/.phaethon/scope/<course folder>.json`, out of reach of the
//! agent's tools: one map per set of parts a space may see (a space that can't
//! see the announcements never gets a map built from them), each with a
//! fingerprint of the files it was built from (path, size, time changed), so a
//! changed course is mapped again before it is used.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::model::{Model, extract_json};
use super::quote;
use super::schedule::Exam;
use super::sources::{self, CourseFile};
use crate::lms::access::{Part, Seen, Visible};
use crate::lms::names;

/// 2: readings (textbooks) count only where the course points to them.
pub const VERSION: u32 = 2;
const DIR: &str = "scope";
/// Characters of course text in one mapping call (about 45k tokens).
pub const MAP_CHUNK: usize = 180_000;
/// A guide file (announcements, syllabus, homework) is sent whole up to this.
const GUIDE_MAX: usize = 70_000;
/// Of any other file, its start (where a table of contents is).
const HEAD_MAX: usize = 6_000;
const TOPICS_MAX: usize = 80;
const EVIDENCE_MAX: usize = 4;
const TEXT_MAX: usize = 300;

/// A passage that shows something: the file it is in, and the words, checked to be there.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// `courses/<folder>/<path>`, or "from you" for what the person said.
    pub source: String,
    pub quote: String,
    /// Where in the file: "§5.3", "#3", "p. 4".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Read by the model from the picture of this page (handwriting or a
    /// scan): checked only roughly against the page's recognised text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<u32>,
}

pub const FROM_YOU: &str = "from you";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub title: String,
    /// The course's own numbering, when it has one ("3.8–3.13").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<String>,
    /// Words the course uses for it, to find its passages.
    #[serde(default)]
    pub terms: Vec<String>,
    /// 1..5: how much the course leans on it (homework problems, lecture time, "focus on").
    #[serde(default = "one")]
    pub weight: f64,
    /// Homework problems on it ("HW 4 #3").
    #[serde(default)]
    pub homework: Vec<String>,
    pub evidence: Vec<Evidence>,
    /// Only in the readings (a textbook), and nothing the course gives out
    /// (syllabus, assignments, announcements, its pages) points to it: there
    /// for reference, never tested.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reference: bool,
    /// For a topic found only in the readings: where the course points
    /// students to it ("Read sections 5.1–5.3").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assigned_by: Vec<Evidence>,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notation {
    pub symbol: String,
    pub meaning: String,
    pub evidence: Vec<Evidence>,
}

/// What one exam covers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamScope {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Whether what it covers was found (or said by the person). Unknown: nothing below is used.
    pub known: bool,
    /// In a few words: "through HW 6; not graphs or combinatorics".
    #[serde(default)]
    pub summary: String,
    /// The topics it covers, by id.
    #[serde(default)]
    pub includes: Vec<String>,
    /// Topics it explicitly leaves out, by id.
    #[serde(default)]
    pub excludes: Vec<String>,
    /// What it leaves out, in the course's words ("graphs", "combinatorics").
    #[serde(default)]
    pub excluded_words: Vec<String>,
    /// Homework in scope, as files (`courses/…/HW 06.pdf`): calibration for difficulty.
    #[serde(default)]
    pub homework: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// Said by the person, not found in the materials.
    #[serde(default)]
    pub from_user: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeMap {
    pub version: u32,
    /// The course's folder name.
    pub course: String,
    pub name: String,
    /// The parts it was built from.
    pub parts: Vec<String>,
    pub fingerprint: String,
    pub built: u64,
    pub topics: Vec<Topic>,
    #[serde(default)]
    pub notation: Vec<Notation>,
    #[serde(default)]
    pub exams: Vec<ExamScope>,
    /// Quotes the model gave that weren't in the files, so were dropped.
    #[serde(default)]
    pub dropped: usize,
}

/// What the person said an exam covers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stated {
    pub exam: String,
    pub text: String,
    pub at: u64,
    /// Topic ids it was read as, and the map (fingerprint) they belong to.
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_for: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    maps: BTreeMap<String, ScopeMap>,
    #[serde(default)]
    stated: Vec<Stated>,
}

// ---- Where it lives -------------------------------------------------------------

/// The vault a course folder is in (`<vault>/courses/<folder>`).
pub fn vault_of(visible: &Visible, seen: &Seen) -> Option<PathBuf> {
    visible.dir_of(seen)?.parent()?.parent().map(Path::to_path_buf)
}

fn store_rel(seen: &Seen) -> PathBuf {
    Path::new(crate::tools::STATE_DIR).join(DIR).join(format!("{}.json", names::segment(seen.folder())))
}

fn load_store(vault: &Path, seen: &Seen) -> Store {
    let path = vault.join(store_rel(seen));
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() && m.len() <= 8 * 1024 * 1024 => {}
        _ => return Store::default(),
    }
    std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_store(vault: &Path, seen: &Seen, store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    names::write(vault, &store_rel(seen), text.as_bytes()).map_err(|e| format!("The course’s scope couldn’t be saved: {e}"))
}

/// The parts a space sees, as the key its map is kept under.
pub fn parts_key(seen: &Seen) -> String {
    Part::ALL.iter().filter(|p| seen.can(**p)).map(|p| p.name()).collect::<Vec<_>>().join(",")
}

/// A fingerprint of the files a map is built from: each one's path, size and time changed.
pub fn fingerprint(files: &[CourseFile]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for f in files {
        for b in f.label.bytes().chain([0]).chain(f.size.to_le_bytes()).chain(f.modified.to_le_bytes()) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// The map kept for what this space sees of `seen`, and whether the course
/// has changed since it was built.
pub fn cached(visible: &Visible, seen: &Seen, files: Option<&[CourseFile]>) -> Option<(ScopeMap, bool)> {
    let vault = vault_of(visible, seen)?;
    let map = load_store(&vault, seen).maps.remove(&parts_key(seen))?;
    if map.version != VERSION {
        return None;
    }
    let fresh = match files {
        Some(f) => fingerprint(f) == map.fingerprint,
        None => fingerprint(&sources::course_files(visible, seen)) == map.fingerprint,
    };
    Some((map, fresh))
}

pub fn stated(visible: &Visible, seen: &Seen) -> Vec<Stated> {
    vault_of(visible, seen).map(|v| load_store(&v, seen).stated).unwrap_or_default()
}

/// Keep what the person says `exam` covers (an empty `text` forgets it).
pub fn state(visible: &Visible, seen: &Seen, exam: &str, text: &str, now: u64) -> Result<(), String> {
    let exam = exam.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim();
    if exam.is_empty() || exam.chars().count() > 80 {
        return Err("Name the exam in a few words.".into());
    }
    if text.chars().count() > 1_000 {
        return Err("That’s too long; say what it covers in a sentence or two.".into());
    }
    let vault = vault_of(visible, seen).ok_or("That course isn’t there any more.")?;
    let mut store = load_store(&vault, seen);
    store.stated.retain(|s| exam_key(&s.exam) != exam_key(&exam));
    if !text.is_empty() {
        store.stated.push(Stated { exam, text: text.to_string(), at: now, includes: vec![], excludes: vec![], resolved_for: None });
    }
    save_store(&vault, seen, &store)
}

fn save_map(visible: &Visible, seen: &Seen, map: &ScopeMap) -> Result<(), String> {
    let vault = vault_of(visible, seen).ok_or("That course isn’t there any more.")?;
    let mut store = load_store(&vault, seen);
    store.maps.insert(parts_key(seen), map.clone());
    save_store(&vault, seen, &store)
}

fn save_stated(visible: &Visible, seen: &Seen, s: &Stated) -> Result<(), String> {
    let vault = vault_of(visible, seen).ok_or("That course isn’t there any more.")?;
    let mut store = load_store(&vault, seen);
    store.stated.retain(|x| exam_key(&x.exam) != exam_key(&s.exam));
    store.stated.push(s.clone());
    save_store(&vault, seen, &store)
}

// ---- Words ----------------------------------------------------------------------

pub fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// "Test 1" and "exam 1" name the same exam; "midterm" and "final" only themselves.
fn exam_key(s: &str) -> String {
    exam_tokens(s).join(" ")
}

/// An exam's name as words: lower case, "exam" and "quiz" read as "test", filler left out.
fn exam_tokens(s: &str) -> Vec<String> {
    const FILLER: [&str; 12] = ["the", "a", "my", "for", "on", "of", "practice", "please", "and", "to", "next", "upcoming"];
    let mut out = vec![];
    let lower = s.to_lowercase();
    for w in lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        // "test1" is "test 1".
        let split = w.find(|c: char| c.is_ascii_digit()).filter(|&i| i > 0 && w[..i].chars().all(char::is_alphabetic));
        let parts: Vec<&str> = match split {
            Some(i) => vec![&w[..i], &w[i..]],
            None => vec![w],
        };
        for p in parts {
            let p = match p {
                "exam" | "quiz" | "examination" => "test",
                p => p,
            };
            if !FILLER.contains(&p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// Whether every word of `small` is among `big`.
fn within(small: &[String], big: &[String]) -> bool {
    !small.is_empty() && small.iter().all(|w| big.contains(w))
}

/// The exam `wanted` names among `exams`: the same words, all of its words
/// ("final" for "Final Exam"), or one named inside it ("practice for Test 1").
pub fn find_exam<'a>(exams: &'a [ExamScope], wanted: &str) -> Option<&'a ExamScope> {
    let w = exam_tokens(wanted);
    if w.is_empty() {
        return None;
    }
    if let Some(e) = exams.iter().find(|e| exam_tokens(&e.title) == w) {
        return Some(e);
    }
    let hits: Vec<&ExamScope> = exams.iter().filter(|e| within(&w, &exam_tokens(&e.title)) || within(&exam_tokens(&e.title), &w)).collect();
    (hits.len() == 1).then(|| hits[0])
}

/// An exam's name as it appears in `text`, if exactly one exam of `exams` is named there.
pub fn named_exam(exams: &[ExamScope], text: &str) -> Option<String> {
    let t = exam_tokens(text);
    let hits: Vec<&ExamScope> = exams.iter().filter(|e| within(&exam_tokens(&e.title), &t)).collect();
    (hits.len() == 1).then(|| hits[0].title.clone())
}

// ---- Building -------------------------------------------------------------------

/// How useful a file is for mapping, and how much of it is sent: (rank, whole?).
fn guide_rank(label: &str) -> (u8, bool) {
    let l = label.to_lowercase();
    let name = l.rsplit('/').next().unwrap_or(&l);
    let rel = l.splitn(3, '/').nth(2).unwrap_or(&l);
    let review = ["review", "exam", "midterm", "final", "study guide", "practice", "test "].iter().any(|k| name.contains(k));
    let rank = if rel == "announcements.md" {
        0
    } else if name.contains("syllabus") || name.contains("schedule") || review {
        1
    } else if rel == "assignments.md" || super::grounded::is_problem_set(label) || name.starts_with("ps") {
        2
    } else {
        3
    };
    (rank, rank < 3)
}

/// The course text for mapping, in calls of at most [`MAP_CHUNK`]: guide files
/// whole (to [`GUIDE_MAX`]), the start of the rest. Most useful first.
pub fn map_chunks(files: &[CourseFile]) -> Vec<String> {
    let mut ranked: Vec<(u8, &CourseFile, bool)> = files.iter().map(|f| {
        let (r, whole) = guide_rank(&f.label);
        (r, f, whole)
    }).collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.label.cmp(&b.1.label)));
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    for (_, f, whole) in ranked {
        let text = sources::clean(&f.text);
        if text.trim().is_empty() {
            continue;
        }
        let cap = if whole { GUIDE_MAX } else { HEAD_MAX };
        let mut cut = cap.min(text.len());
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        let more = if cut < text.len() { "\n[… the rest of this file isn’t shown here]" } else { "" };
        let block = format!("<source path=\"{}\">\n{}{more}\n</source>\n\n", f.label, &text[..cut]);
        if !cur.is_empty() && cur.len() + block.len() > MAP_CHUNK {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(&block);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

pub const MAP_SYSTEM: &str = r#"You map what a course teaches, from its own materials, for a student preparing for its exams. Precision matters more than completeness: a student will be quizzed only on what you list, so never add a topic, exclusion or exam scope the materials don't state.

From the <source> files (and the current map, if one is given, which you extend and correct), list:
- "topics": what the course teaches, in the order it teaches it, at the grain of a lecture section or a homework problem (aim for 10 to 40 topics). Each: "id" (keep ids from the current map; new ones "t" plus a number), "title" (the course's own words), "sections" (the course's numbering if it has one, like "3.8–3.13", else omit), "terms" (2 to 8 words or short phrases the course uses for it), "weight" (1 to 5: how much the course leans on it: homework problems, lecture time, review sheets, "focus on"), "homework" (problems on it, like "HW 4 #3"), and "evidence": 1 to 3 passages that show the course teaches it.
- A topic whose evidence is only in readings/ files (textbooks and other readings the course links to) counts only where the course points students to it: give it "assignedBy", 1 or 2 passages from the syllabus, assignments, announcements, modules or the course's own pages that assign or point to that chapter, section or topic, naming it (same form as evidence). Without one it is kept as reference only and never tested. Never give a topic for a chapter of a textbook nothing in the course points to.
- "notation": symbols and notation the course defines that a student must know (like |s| for a string's length, ε for the empty string): "symbol", "meaning", "evidence" (one passage).
- "exams": every exam the materials mention. Each: "title" as the course names it ("Test 1"), "date" (YYYY-MM-DD) if stated, "through" (the last homework or section it covers, if stated), "includes" (topic ids it covers), "excludes" (topic ids it explicitly leaves out), "excludedWords" (what it leaves out, in the course's words), "homework" (paths of the homework files it covers, copied from the source paths), "summary" (a few words, like "through HW 6; not graphs or combinatorics"), and "evidence": the passages that say what it covers. If the materials don't say what an exam covers, give it with "includes": [] and no evidence. Never infer an exam's coverage from dates alone.

Evidence: {"source": the <source> path copied exactly, "quote": words copied exactly from that source, one or two sentences or a heading line (at least five words), never paraphrased, never stitched together}. Quotes are checked against the files: one that isn't there is thrown away, and a topic with no real evidence is dropped.

Reply with only JSON, no prose: {"topics": [...], "notation": [...], "exams": [...]}"#;

/// A model's evidence list, each quote checked against its file. Returns the kept and how many were dropped.
fn check_evidence(v: &Value, files: &Docs, max: usize) -> (Vec<Evidence>, usize) {
    let list: Vec<&Value> = match v {
        Value::Array(a) => a.iter().collect(),
        Value::Object(_) => vec![v],
        _ => vec![],
    };
    let (mut kept, mut dropped) = (vec![], 0);
    for e in list {
        let source = e["source"].as_str().unwrap_or("").trim().to_string();
        let q = e["quote"].as_str().unwrap_or("").trim().to_string();
        if source.is_empty() && q.is_empty() {
            continue;
        }
        match files.check(&source, &q) {
            Some(ev) if kept.len() < max && !kept.iter().any(|k: &Evidence| k.quote == ev.quote) => kept.push(ev),
            Some(_) => {}
            None => dropped += 1,
        }
    }
    (kept, dropped)
}

fn text(v: &Value, k: &str, max: usize) -> String {
    let s = match &v[k] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

fn strings(v: &Value, k: &str, max_items: usize, max_len: usize) -> Vec<String> {
    match &v[k] {
        Value::Array(a) => a.iter().filter_map(|x| match x {
            Value::String(s) => Some(s.trim().chars().take(max_len).collect::<String>()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }).filter(|s| !s.is_empty()).take(max_items).collect(),
        Value::String(s) if !s.trim().is_empty() => vec![s.trim().chars().take(max_len).collect()],
        _ => vec![],
    }
}

/// The course's files, to check quotes against (each compacted once).
pub struct Docs {
    files: Vec<(String, String)>,
    compact: Vec<std::sync::OnceLock<quote::Compact>>,
    /// Pages the model was shown as pictures: a quote from one is checked roughly against its recognised text.
    pictured: std::sync::Mutex<Vec<super::material::PageRef>>,
}

impl Docs {
    pub fn new(files: &[CourseFile]) -> Docs {
        Docs {
            files: files.iter().map(|f| (f.label.clone(), f.text.clone())).collect(),
            compact: files.iter().map(|_| std::sync::OnceLock::new()).collect(),
            pictured: std::sync::Mutex::default(),
        }
    }

    /// Note that the model was shown these pages as pictures.
    pub fn shown(&self, pages: &[super::material::PageRef]) {
        let mut p = self.pictured.lock().unwrap_or_else(|e| e.into_inner());
        for x in pages {
            if !p.contains(x) {
                p.push(x.clone());
            }
        }
    }

    pub fn labels(&self) -> Vec<String> {
        self.files.iter().map(|(l, _)| l.clone()).collect()
    }

    fn index(&self, source: &str) -> Option<usize> {
        let labels = self.labels();
        let l = sources::match_label(source, &labels)?;
        labels.iter().position(|x| *x == l)
    }

    /// The text of a file by what a model cited it as.
    pub fn text_of(&self, source: &str) -> Option<(&str, &str)> {
        self.index(source).map(|i| (self.files[i].0.as_str(), self.files[i].1.as_str()))
    }

    /// The quote checked against the file it names: the evidence as kept (the
    /// file's label, the quote, where it is), or `None` when it isn't there.
    pub fn check(&self, source: &str, q: &str) -> Option<Evidence> {
        let i = self.index(source)?;
        let (label, text) = (&self.files[i].0, &self.files[i].1);
        let hay = self.compact[i].get_or_init(|| quote::compact(text));
        let Some(f) = quote::find_in(text, hay, q) else {
            // Not word for word: only a page shown as a picture may match, and only roughly.
            let shown: Vec<u32> = self.pictured.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(l, _)| l == label).map(|(_, p)| *p).collect();
            let page = super::material::picture_quote(text, &shown, q)?;
            return Some(Evidence { source: label.clone(), quote: quote::tidy(q), at: Some(format!("p. {page}")), picture: Some(page) });
        };
        let problem_set = super::grounded::is_problem_set(label);
        Some(Evidence { source: label.clone(), quote: quote::tidy(q), at: quote::locate(text, f.start, problem_set), picture: None })
    }
}

/// A file among the course's readings (textbooks and other documents it links to).
pub fn is_reading(label: &str) -> bool {
    label.splitn(3, '/').nth(2).is_some_and(|r| r.to_lowercase().starts_with("readings/"))
}

/// Whether a passage of the course points to a topic: it names one of its
/// sections ("5.3"), its chapter ("chapter 5", "ch. 5"), one of its terms,
/// or a longer word of its title.
pub fn points_to(quote: &str, sections: Option<&str>, terms: &[String], title: &str) -> bool {
    let q = quote.to_lowercase();
    let has_number = |n: &str| {
        q.match_indices(n).any(|(i, _)| {
            let before = q[..i].chars().next_back();
            let after = q[i + n.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_digit() || c == '.') && !after.is_some_and(|c| c.is_ascii_digit())
        })
    };
    let numbers = super::grounded::section_numbers(sections);
    if numbers.iter().any(|n| has_number(n)) {
        return true;
    }
    let chapters: HashSet<&str> = numbers.iter().filter_map(|n| n.split('.').next()).chain(sections.into_iter().filter(|s| s.chars().all(|c| c.is_ascii_digit()))).collect();
    for c in chapters {
        if ["chapter ", "chapters ", "ch. ", "ch "].iter().any(|w| has_number(&format!("{w}{c}"))) {
            return true;
        }
    }
    const SKIP: [&str; 8] = ["about", "using", "their", "with", "from", "basic", "introduction", "definitions"];
    terms.iter().map(|t| t.to_lowercase()).filter(|t| t.chars().count() >= 4).any(|t| q.contains(&t))
        || title.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 5 && !SKIP.contains(w)).any(|w| q.contains(w))
}

/// Check a model's map: every quote found or dropped, topics without evidence
/// dropped, exam scopes without evidence unknown. `Err` only for a reply that
/// isn't a map at all (asked again).
/// A checked map: topics, notation, exams, and how many quotes were dropped.
pub type Checked = (Vec<Topic>, Vec<Notation>, Vec<ExamScope>, usize);

pub fn check_map(v: &Value, files: &Docs, prior_ids: &HashSet<String>) -> Result<Checked, String> {
    let topics_v = v.get("topics").and_then(Value::as_array).ok_or("expected an object with a \"topics\" array")?;
    let mut dropped = 0;
    let mut topics: Vec<Topic> = vec![];
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut next = 1;
    for t in topics_v.iter().take(TOPICS_MAX * 2) {
        let title = text(t, "title", 160);
        if title.is_empty() {
            continue;
        }
        let (evidence, d) = check_evidence(&t["evidence"], files, EVIDENCE_MAX);
        dropped += d;
        if evidence.is_empty() || topics.len() >= TOPICS_MAX {
            continue;
        }
        let said = text(t, "id", 20);
        let id = if !said.is_empty() && prior_ids.contains(&said) && !used.contains(&said) {
            said.clone()
        } else {
            loop {
                let c = format!("t{next}");
                next += 1;
                if !used.contains(&c) && !prior_ids.contains(&c) {
                    break c;
                }
            }
        };
        used.insert(id.clone());
        if !said.is_empty() {
            ids.insert(said, id.clone());
        }
        let weight = t["weight"].as_f64().or_else(|| t["weight"].as_str().and_then(|s| s.parse().ok())).unwrap_or(2.0).clamp(1.0, 5.0);
        let sections = Some(text(t, "sections", 40)).filter(|s| !s.is_empty());
        let terms = strings(t, "terms", 8, 60);
        // Only in the readings: tested only where the course points to it, by a passage found in its own files.
        let (assigned_by, reference) = if evidence.iter().all(|e| is_reading(&e.source)) {
            let (ab, d) = check_evidence(&t["assignedBy"], files, 2);
            dropped += d;
            let ab: Vec<Evidence> = ab.into_iter().filter(|e| !is_reading(&e.source) && points_to(&e.quote, sections.as_deref(), &terms, &title)).collect();
            let reference = ab.is_empty();
            (ab, reference)
        } else {
            (vec![], false)
        };
        topics.push(Topic { id, title, sections, terms, weight, homework: strings(t, "homework", 12, 40), evidence, reference, assigned_by });
    }
    if topics.is_empty() {
        return Err("none of the topics had a passage that is really in the files: quote each one exactly".into());
    }
    let mut notation = vec![];
    for n in v.get("notation").and_then(Value::as_array).into_iter().flatten().take(40) {
        let (symbol, meaning) = (text(n, "symbol", 60), text(n, "meaning", 200));
        let (evidence, d) = check_evidence(&n["evidence"], files, 1);
        dropped += d;
        if !symbol.is_empty() && !meaning.is_empty() && !evidence.is_empty() {
            notation.push(Notation { symbol, meaning, evidence });
        }
    }
    let labels = files.labels();
    let mut exams: Vec<ExamScope> = vec![];
    for e in v.get("exams").and_then(Value::as_array).into_iter().flatten().take(12) {
        let title = text(e, "title", 80);
        if title.is_empty() || exams.iter().any(|x| exam_key(&x.title) == exam_key(&title)) {
            continue;
        }
        let (evidence, d) = check_evidence(&e["evidence"], files, EVIDENCE_MAX);
        dropped += d;
        let map_ids = |k: &str| -> Vec<String> { strings(e, k, TOPICS_MAX, 20).iter().filter_map(|i| ids.get(i).cloned().or_else(|| used.contains(i).then(|| i.clone()))).collect() };
        let excludes = map_ids("excludes");
        let includes: Vec<String> = map_ids("includes").into_iter().filter(|i| !excludes.contains(i)).collect();
        let excluded_words = strings(e, "excludedWords", 12, 60);
        let known = !evidence.is_empty() && !includes.is_empty();
        let date = Some(text(e, "date", 10)).filter(|d| crate::lms::store::parse_time(d).is_some());
        let homework: Vec<String> = strings(e, "homework", 20, 300).iter().filter_map(|h| sources::match_label(h, &labels)).collect();
        let summary = text(e, "summary", TEXT_MAX);
        exams.push(if known {
            ExamScope { title, date, known, summary, includes, excludes, excluded_words, homework, evidence, from_user: false }
        } else {
            unknown_exam(&title, date)
        });
    }
    Ok((topics, notation, exams, dropped))
}

fn unknown_exam(title: &str, date: Option<String>) -> ExamScope {
    ExamScope {
        title: title.to_string(),
        date,
        known: false,
        summary: String::new(),
        includes: vec![],
        excludes: vec![],
        excluded_words: vec![],
        homework: vec![],
        evidence: vec![],
        from_user: false,
    }
}

/// The map so far, as the next mapping call sees it.
fn prior_json(topics: &[Topic], notation: &[Notation], exams: &[ExamScope]) -> String {
    let t: Vec<Value> = topics.iter().map(|t| json!({"id": t.id, "title": t.title, "sections": t.sections, "terms": t.terms, "weight": t.weight, "homework": t.homework, "evidence": t.evidence.iter().map(|e| json!({"source": e.source, "quote": e.quote})).collect::<Vec<_>>()})).collect();
    let n: Vec<Value> = notation.iter().map(|n| json!({"symbol": n.symbol, "meaning": n.meaning, "evidence": n.evidence.iter().map(|e| json!({"source": e.source, "quote": e.quote})).collect::<Vec<_>>()})).collect();
    let e: Vec<Value> = exams.iter().map(|e| json!({"title": e.title, "date": e.date, "includes": e.includes, "excludes": e.excludes, "excludedWords": e.excluded_words, "homework": e.homework, "summary": e.summary, "evidence": e.evidence.iter().map(|x| json!({"source": x.source, "quote": x.quote})).collect::<Vec<_>>()})).collect();
    serde_json::to_string(&json!({"topics": t, "notation": n, "exams": e})).unwrap_or_default()
}

/// Exams the person keeps in study/exams.json for this course, said to the mapper.
fn exams_note(exams: &[Exam], seen: &Seen) -> String {
    let mine: Vec<String> = exams
        .iter()
        .filter(|e| e.course.as_deref().is_none_or(|c| super::schedule::same_course(c, seen.folder()) || super::schedule::same_course(c, &seen.state.name)))
        .map(|e| format!("{} on {}", e.title, e.date))
        .collect();
    if mine.is_empty() { String::new() } else { format!("\n\nThe student's calendar lists these exams (dates only, not what they cover): {}.", mine.join("; ")) }
}

/// Map the course as this space sees it, and keep the map. `progress(done, total)` per mapping call.
pub async fn build<M: Model>(visible: &Visible, seen: &Seen, exams: &[Exam], model: &M, now: u64, progress: &(dyn Fn(usize, usize) + Send + Sync)) -> Result<ScopeMap, String> {
    let files = sources::course_files(visible, seen);
    if files.is_empty() {
        return Err(format!("There’s nothing this space can read in {} to map.", seen.state.name));
    }
    let docs = Docs::new(&files);
    let chunks = map_chunks(&files);
    let (mut topics, mut notation, mut exams_found, mut dropped) = (vec![], vec![], vec![], 0);
    let calendar = exams_note(exams, seen);
    let system = super::course_only(MAP_SYSTEM);
    for (i, chunk) in chunks.iter().enumerate() {
        progress(i, chunks.len());
        let prior = if i == 0 { String::new() } else { format!("\n\n<current_map>\n{}\n</current_map>\n\nExtend and correct the current map with what these files add; reply with the whole map.", prior_json(&topics, &notation, &exams_found)) };
        // Handwritten, scanned and figure pages this call carries, shown as pictures to a model that can look.
        let pictures = if model.shows_pictures() {
            let pages = super::material::pages_in_chunk(seen, chunk, super::material::MAP_PICTURES);
            let pics = super::material::pictures(visible, seen, &pages, super::material::MAP_PICTURES);
            docs.shown(&pages.into_iter().filter(|(l, p)| pics.iter().any(|x| x.label == format!("{l}, page {p}") || x.label == *l)).collect::<Vec<_>>());
            pics
        } else {
            vec![]
        };
        let user = format!("Course: {}{calendar}\n\n{chunk}{prior}{}", seen.state.name, super::material::pictures_note(&pictures));
        let prior_ids: HashSet<String> = topics.iter().map(|t: &Topic| t.id.clone()).collect();
        let reply = model.complete_seeing(&system, &user, &pictures).await?;
        let checked = match extract_json(&reply) {
            Some(v) => check_map(&v, &docs, &prior_ids),
            None => Err("the reply had no JSON in it".into()),
        };
        let checked = match checked {
            Ok(c) => c,
            Err(problem) => {
                let shown: String = reply.chars().take(3_000).collect();
                let retry = format!("{user}\n\n<previous_reply>\n{shown}\n</previous_reply>\n\nThat reply couldn't be used: {problem}. Answer again with only the corrected JSON.");
                let reply = model.complete_seeing(&system, &retry, &pictures).await?;
                match extract_json(&reply).map(|v| check_map(&v, &docs, &prior_ids)) {
                    Some(Ok(c)) => c,
                    Some(Err(p)) => return Err(format!("The course couldn’t be mapped ({p}). Try again.")),
                    None => return Err("The course couldn’t be mapped (the answer had no map in it). Try again.".into()),
                }
            }
        };
        // A later call that loses a topic keeps the earlier one: the map only grows.
        let (t, n, e, d) = checked;
        dropped += d;
        let mut merged = t;
        for old in topics {
            if !merged.iter().any(|x: &Topic| x.id == old.id || squash(&x.title) == squash(&old.title)) {
                merged.push(old);
            }
        }
        topics = merged;
        notation = if n.is_empty() { notation } else { n };
        let mut ex = e;
        for old in exams_found {
            if !ex.iter().any(|x: &ExamScope| exam_key(&x.title) == exam_key(&old.title)) {
                ex.push(old);
            } else if let Some(x) = ex.iter_mut().find(|x| exam_key(&x.title) == exam_key(&old.title))
                && !x.known
                && old.known
            {
                *x = old;
            }
        }
        exams_found = ex;
    }
    progress(chunks.len(), chunks.len());
    // Exams on the calendar the materials never describe: there, but unknown.
    for e in exams.iter().filter(|e| e.course.as_deref().is_none_or(|c| super::schedule::same_course(c, seen.folder()) || super::schedule::same_course(c, &seen.state.name))) {
        match exams_found.iter_mut().find(|x| exam_key(&x.title) == exam_key(&e.title)) {
            Some(x) => {
                if x.date.is_none() {
                    x.date = Some(e.date.chars().take(10).collect());
                }
            }
            None if !e.title.trim().is_empty() => exams_found.push(unknown_exam(e.title.trim(), Some(e.date.chars().take(10).collect()))),
            None => {}
        }
    }
    let map = ScopeMap {
        version: VERSION,
        course: seen.folder().to_string(),
        name: seen.state.name.clone(),
        parts: Part::ALL.iter().filter(|p| seen.can(**p)).map(|p| p.name().to_string()).collect(),
        fingerprint: fingerprint(&files),
        built: now,
        topics,
        notation,
        exams: exams_found,
        dropped,
    };
    save_map(visible, seen, &map)?;
    Ok(map)
}

// ---- The person's word ----------------------------------------------------------

pub const RESOLVE_SYSTEM: &str = r#"A student told you what an exam covers. Match what they said to the course's topics (given with ids, in the order taught). "includes": the ids of every topic the exam covers by what they said (for "through HW 6" or "up to section 5.4", every topic up to that point); "excludes": the ids of topics they said it leaves out. Use only what they said; when they don't say, leave the topic out of both.

Reply with only JSON: {"includes": ["t1"], "excludes": ["t9"], "summary": "a few words, like: through HW 6; not graphs or combinatorics"}"#;

/// The scope an exam has for generating: the person's word (read against the
/// map's topics, one model call the first time) over what was found; `None`
/// when neither says what it covers.
pub async fn exam_scope<M: Model>(visible: &Visible, seen: &Seen, map: &ScopeMap, exam: &str, model: &M) -> Result<Option<ExamScope>, String> {
    let found = find_exam(&map.exams, exam).cloned();
    let said = stated(visible, seen).into_iter().find(|s| find_exam(std::slice::from_ref(&unknown_exam(&s.exam, None)), exam).is_some());
    let Some(mut s) = said else {
        return Ok(found.filter(|e| e.known));
    };
    if s.resolved_for.as_deref() != Some(map.fingerprint.as_str()) || s.includes.is_empty() {
        let list: Vec<String> = map.topics.iter().map(|t| format!("{}: {}{}", t.id, t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default())).collect();
        let homework: Vec<String> = map.topics.iter().filter(|t| !t.homework.is_empty()).map(|t| format!("{}: {}", t.id, t.homework.join(", "))).collect();
        let user = format!("Exam: {}\nWhat the student said it covers: {}\n\nTopics:\n{}\n\nHomework on each topic:\n{}", s.exam, s.text, list.join("\n"), homework.join("\n"));
        let ids: HashSet<String> = map.topics.iter().map(|t| t.id.clone()).collect();
        let (inc, exc) = super::model::ask_json(model, &super::course_only(RESOLVE_SYSTEM), &user, |v| {
            let pick = |k: &str| strings(v, k, TOPICS_MAX, 20).into_iter().filter(|i| ids.contains(i)).collect::<Vec<_>>();
            let exc = pick("excludes");
            let inc: Vec<String> = pick("includes").into_iter().filter(|i| !exc.contains(i)).collect();
            if inc.is_empty() { Err("no topic id from the list is included".to_string()) } else { Ok((inc, exc)) }
        })
        .await?;
        s.includes = inc;
        s.excludes = exc;
        s.resolved_for = Some(map.fingerprint.clone());
        save_stated(visible, seen, &s)?;
    }
    let date = found.as_ref().and_then(|f| f.date.clone());
    Ok(Some(ExamScope {
        title: found.as_ref().map_or(s.exam.clone(), |f| f.title.clone()),
        date,
        known: true,
        summary: s.text.chars().take(TEXT_MAX).collect(),
        includes: s.includes.clone(),
        excludes: s.excludes.clone(),
        excluded_words: vec![],
        homework: found.map(|f| f.homework).unwrap_or_default(),
        evidence: vec![Evidence { source: FROM_YOU.into(), quote: s.text.clone(), ..Default::default() }],
        from_user: true,
    }))
}

// ---- Using it -------------------------------------------------------------------

/// How many questions each topic gets: by weight (largest remainders), in the
/// course's order. With fewer questions than topics, the heaviest get one each.
pub fn allocate(topics: &[&Topic], count: usize) -> Vec<(String, usize)> {
    if topics.is_empty() || count == 0 {
        return topics.iter().map(|t| (t.id.clone(), 0)).collect();
    }
    let mut n: Vec<usize> = vec![0; topics.len()];
    if count < topics.len() {
        // Spread over the whole scope, not its first chapters: the topics cut into
        // `count` runs in the course's order (each about an equal share of the
        // weight), and the heaviest topic of each run gets the question.
        let total: f64 = topics.iter().map(|t| t.weight.max(0.1)).sum();
        let mut start = 0;
        let mut acc = 0.0;
        for k in 0..count {
            let target = total * (k + 1) as f64 / count as f64;
            let mut end = start;
            // Leave at least one topic for each run still to come.
            while end < topics.len() - (count - k - 1) && (end == start || acc + topics[end].weight.max(0.1) <= target + 1e-9) {
                acc += topics[end].weight.max(0.1);
                end += 1;
            }
            let pick = (start..end).max_by(|&a, &b| topics[a].weight.total_cmp(&topics[b].weight).then(b.cmp(&a))).expect("a run has a topic");
            n[pick] = 1;
            start = end;
        }
    } else {
        let total: f64 = topics.iter().map(|t| t.weight.max(0.1)).sum();
        let exact: Vec<f64> = topics.iter().map(|t| t.weight.max(0.1) * count as f64 / total).collect();
        // Every topic gets one first, so nothing in scope is left out.
        for (i, x) in exact.iter().enumerate() {
            n[i] = (x.floor() as usize).max(1);
        }
        while n.iter().sum::<usize>() > count {
            let i = (0..n.len()).filter(|&i| n[i] > 1).min_by(|&a, &b| (exact[a] - n[a] as f64).total_cmp(&(exact[b] - n[b] as f64))).expect("some topic has more than one");
            n[i] -= 1;
        }
        while n.iter().sum::<usize>() < count {
            let i = (0..n.len()).max_by(|&a, &b| (exact[a] - n[a] as f64).total_cmp(&(exact[b] - n[b] as f64)).then(b.cmp(&a))).expect("topics");
            n[i] += 1;
        }
    }
    topics.iter().zip(n).map(|(t, k)| (t.id.clone(), k)).collect()
}

/// The topics an exam covers, in the course's order; all of them with no exam.
pub fn in_scope<'a>(map: &'a ScopeMap, exam: Option<&ExamScope>) -> Vec<&'a Topic> {
    // A reading the course never points to is reference only: never in scope.
    match exam {
        None => map.topics.iter().filter(|t| !t.reference).collect(),
        Some(e) => map.topics.iter().filter(|t| !t.reference && e.includes.contains(&t.id) && !e.excludes.contains(&t.id)).collect(),
    }
}

/// An exam's scope in words for a person: "Test 1: through HW 6; not graphs or combinatorics".
pub fn scope_words(e: &ExamScope) -> String {
    if !e.known {
        return format!("{}: I couldn’t find what it covers", e.title);
    }
    let mut s = if e.summary.is_empty() { format!("{} topics", e.includes.len()) } else { e.summary.clone() };
    // "no graphs or combinatorics" already says it: only words the summary doesn't name are added.
    let lower = s.to_lowercase();
    let unsaid: Vec<&str> = e.excluded_words.iter().map(|w| w.as_str()).filter(|w| !lower.contains(&w.to_lowercase())).collect();
    if !unsaid.is_empty() {
        s.push_str(&format!("; not {}", unsaid.join(" or ")));
    }
    format!("{}: {s}", e.title)
}

/// A citation as the chat writes it.
pub fn cite(e: &Evidence) -> String {
    format!("[source: {} \"{}\"]", e.source, e.quote.replace('"', "'"))
}

/// The scope maps of the courses this space sees, for the agent's prompt, with
/// how to cite. `None` when no course has one yet (nothing is built here: that
/// takes model calls, made only when the person asks for a quiz or a map).
pub fn prompt_section(visible: &Visible) -> Option<String> {
    let mut parts = vec![];
    for seen in &visible.courses {
        let Some((map, fresh)) = cached(visible, seen, None) else {
            parts.push(format!("## {}\n\nNot mapped yet: Phaethon hasn't checked what this course's exams cover. Don't guess an exam's coverage; say where you looked (announcements, syllabus) and cite it.", seen.state.name));
            continue;
        };
        let mut s = format!("## {}{}\n\nTopics, in the order taught:", map.name, if fresh { "" } else { " (the course has changed since this was mapped)" });
        for t in map.topics.iter().filter(|t| !t.reference) {
            s.push_str(&format!("\n- {}{}", t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default()));
        }
        let reference: Vec<String> = map.topics.iter().filter(|t| t.reference).map(|t| format!("{}{}", t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default())).collect();
        if !reference.is_empty() {
            s.push_str(&format!("\n\nIn the readings but never assigned, so reference only (not taught, never tested): {}.", reference.join("; ")));
        }
        if let Some(r) = seen.state.material.as_ref() {
            let m = crate::lms::material::summarise(r, |_| true);
            if m.handwriting_pages + m.unreadable_pages + m.pictures > 0 {
                s.push_str(&format!("\n\nIts files: {}", m.lines.join(" ")));
            }
        }
        let said = stated(visible, seen);
        for e in &map.exams {
            match said.iter().find(|x| exam_key(&x.exam) == exam_key(&e.title)) {
                Some(x) => s.push_str(&format!("\n\n{}: the student says it covers: {} (from the student).", e.title, x.text)),
                None if e.known => {
                    s.push_str(&format!("\n\n{}{}. Evidence: {}", scope_words(e), e.date.as_deref().map(|d| format!(" (on {d})")).unwrap_or_default(), e.evidence.iter().map(cite).collect::<Vec<_>>().join(" ")));
                    let out: Vec<&str> = map.topics.iter().filter(|t| !e.includes.contains(&t.id)).map(|t| t.title.as_str()).collect();
                    if !out.is_empty() {
                        s.push_str(&format!("\nNot on {}: {}.", e.title, out.join("; ")));
                    }
                }
                None => s.push_str(&format!("\n\n{}: what it covers wasn't found in the materials. Don't guess; ask the student or point them to the announcements.", e.title)),
            }
        }
        for x in said.iter().filter(|x| !map.exams.iter().any(|e| exam_key(&e.title) == exam_key(&x.exam))) {
            s.push_str(&format!("\n\n{}: the student says it covers: {} (from the student).", x.exam, x.text));
        }
        parts.push(s);
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "# What each course teaches, and what its exams cover\n\n{}\n\n\
Stay inside these when you advise the user what to study or explain course material: never teach, quiz or recommend a topic, term or notation the course hasn't covered, and never stretch an exam past its scope. \
Cite the course's own words for every claim about what a course covers or teaches, as [source: courses/<folder>/<file> \"words copied exactly from that file\"] (the file's path as it is under courses/, for a PDF the PDF's own name). \
Phaethon checks each citation against the file and shows the user whether it was found, so copy the words exactly and never cite what you haven't read. \
For new practice questions, a practice test or flashcards, offer them with a phaethon-study block instead of writing them in chat. Reviewing existing quizzes in chat is allowed, including reproducing their original questions and answer choices and explaining completed attempts. For new material, use the block with \"exam\" set when they are for an exam.\n\n{}",
        super::COURSE_ONLY_CHAT,
        parts.join("\n\n")
    ))
}

/// [`prompt_section`] for the space at `space_dir` (`<vault>/spaces/<id>`), for the CLIs.
pub fn prompt_for(space_dir: &Path) -> Option<String> {
    let id = space_dir.file_name()?.to_str()?;
    let vault = crate::vault::Vault::at(space_dir.parent()?.parent()?);
    prompt_section(&crate::lms::access::visible(&vault, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::access::fixture;
    use std::fs;

    pub fn course(tag: &str) -> (PathBuf, Visible) {
        let root = std::env::temp_dir().join(format!("phaethon-scope-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let c = root.join("courses/C241");
        fs::create_dir_all(c.join("files/HW")).unwrap();
        fs::create_dir_all(root.join("spaces/s")).unwrap();
        fs::write(c.join("announcements.md"), "# Announcements\n\n## Test 1 Next Week!\n\nThe test will cover everything up through and including HW 6. Test 1 will **not** cover graphs or combinatorics.\n").unwrap();
        fs::write(c.join("files/Notes.pdf"), "%PDF").unwrap();
        fs::write(c.join("files/Notes.pdf.md"), "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is injective if no two inputs give the same output.\n\n6.1 Graphs\n\nA graph is a set of vertices and a set of edges.").unwrap();
        fs::write(c.join("files/HW/HW 06.pdf.md"), "Problems\n1.\nDecide whether each function is injective.").unwrap();
        let vis = fixture(&root, "s", &[("C241", &Part::ALL)]);
        (root.canonicalize().unwrap(), vis)
    }

    const MAP: &str = r#"{"topics": [
      {"id": "a", "title": "Injective functions", "sections": "5.3", "terms": ["injective"], "weight": 4, "homework": ["HW 6 #1"], "evidence": [{"source": "courses/C241/files/Notes.pdf", "quote": "A function f is injective if no two inputs give the same output."}]},
      {"id": "b", "title": "Graphs", "sections": "6.1", "terms": ["graph", "vertices"], "weight": 2, "evidence": [{"source": "Notes.pdf", "quote": "A graph is a set of vertices and a set of edges."}]},
      {"id": "c", "title": "Preimages", "evidence": [{"source": "Notes.pdf", "quote": "The preimage of a set B under f is every input that lands in B."}]}
    ],
    "notation": [{"symbol": "f(x)", "meaning": "output", "evidence": {"source": "Notes.pdf", "quote": "no two inputs give the same output"}}],
    "exams": [
      {"title": "Test 1", "through": "HW 6", "includes": ["a", "c"], "excludes": ["b"], "excludedWords": ["graphs", "combinatorics"], "homework": ["HW 06.pdf.md"], "summary": "through HW 6; not graphs or combinatorics", "evidence": [{"source": "courses/C241/announcements.md", "quote": "Test 1 will not cover graphs or combinatorics."}, {"source": "announcements.md", "quote": "The test will cover all of chapter 9"}]},
      {"title": "Final", "includes": ["a", "b"], "evidence": [{"source": "announcements.md", "quote": "The final covers everything we did all semester long."}]}
    ]}"#;

    #[test]
    fn quotes_are_checked_and_unsupported_things_dropped() {
        let (root, vis) = course("check");
        let files = sources::course_files(&vis, &vis.courses[0]);
        assert_eq!(files.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["courses/C241/announcements.md", "courses/C241/files/HW/HW 06.pdf.md", "courses/C241/files/Notes.pdf"]);
        let docs = Docs::new(&files);
        let (topics, notation, exams, dropped) = check_map(&serde_json::from_str(MAP).unwrap(), &docs, &HashSet::new()).unwrap();
        assert_eq!(topics.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["Injective functions", "Graphs"], "a topic with no real passage is dropped");
        assert_eq!(topics[0].evidence[0].at.as_deref(), Some("§5.3"));
        assert_eq!(topics[0].evidence[0].source, "courses/C241/files/Notes.pdf", "a shortened path becomes the file's label");
        assert_eq!(notation.len(), 1);
        assert_eq!(dropped, 3, "the preimage passage, the chapter 9 claim and the final's");
        let t1 = &exams[0];
        assert!(t1.known && t1.includes == ["t1"] && t1.excludes == ["t2"], "{t1:?}");
        assert_eq!(t1.evidence.len(), 1, "only the quote that is in the announcement");
        assert_eq!(t1.homework, ["courses/C241/files/HW/HW 06.pdf.md"]);
        assert!(!exams[1].known && exams[1].includes.is_empty(), "the final's scope has no real evidence: unknown, not guessed");
        assert_eq!(scope_words(t1), "Test 1: through HW 6; not graphs or combinatorics");
        assert_eq!(scope_words(&exams[1]), "Final: I couldn’t find what it covers");
        // A summary that already leaves them out ("no …") isn't told again; one it doesn't name is added.
        let said = |summary: &str| ExamScope { summary: summary.into(), ..t1.clone() };
        assert_eq!(scope_words(&said("October 15 or 16; through HW 6; no graphs or combinatorics")), "Test 1: October 15 or 16; through HW 6; no graphs or combinatorics");
        assert_eq!(scope_words(&said("through HW 6; no graphs")), "Test 1: through HW 6; no graphs; not combinatorics");
        // Nothing real at all: asked again.
        assert!(check_map(&json!({"topics": [{"title": "x", "evidence": [{"source": "Notes.pdf", "quote": "not in the file at all, nowhere"}]}]}), &docs, &HashSet::new()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readings_count_only_where_the_course_points_to_them() {
        let (root, vis) = course("readings");
        let c = root.join("courses/C241");
        fs::create_dir_all(c.join("readings")).unwrap();
        fs::write(c.join("syllabus.md"), "# Syllabus\n\nBefore Test 1, read Chapter 5 of the textbook, sections 5.1 to 5.3.").unwrap();
        fs::write(c.join("readings/Book.pdf"), "%PDF").unwrap();
        fs::write(c.join("readings/Book.pdf.md"), "# Text of Book.pdf\n\n5.1 Relations\n\nA relation from A to B is a subset of the product A x B.\n\n7.2 Trees\n\nA tree is a connected graph with no cycles at all.").unwrap();
        let files = sources::course_files(&vis, &vis.courses[0]);
        let docs = Docs::new(&files);
        let map = json!({"topics": [
            {"id": "r1", "title": "Relations", "sections": "5.1", "evidence": [{"source": "readings/Book.pdf", "quote": "A relation from A to B is a subset of the product A x B."}],
             "assignedBy": [{"source": "syllabus.md", "quote": "read Chapter 5 of the textbook, sections 5.1 to 5.3."}]},
            {"id": "r2", "title": "Trees", "sections": "7.2", "evidence": [{"source": "readings/Book.pdf", "quote": "A tree is a connected graph with no cycles at all."}],
             "assignedBy": [{"source": "syllabus.md", "quote": "read Chapter 5 of the textbook, sections 5.1 to 5.3."}, {"source": "readings/Book.pdf", "quote": "A tree is a connected graph with no cycles at all."}]},
            {"id": "r3", "title": "Trees again", "evidence": [{"source": "readings/Book.pdf", "quote": "A tree is a connected graph with no cycles at all."}]},
            {"id": "a", "title": "Injective functions", "sections": "5.3", "evidence": [{"source": "Notes.pdf", "quote": "A function f is injective if no two inputs give the same output."}]}
        ], "exams": [{"title": "Test 1", "includes": ["r1", "r2", "a"], "evidence": [{"source": "announcements.md", "quote": "The test will cover everything up through and including HW 6."}]}]});
        let (topics, _, exams, _) = check_map(&map, &docs, &HashSet::new()).unwrap();
        let by = |t: &str| topics.iter().find(|x| x.title == t).unwrap();
        assert!(!by("Relations").reference && by("Relations").assigned_by[0].source == "courses/C241/syllabus.md", "the syllabus names its section");
        assert!(by("Trees").reference && by("Trees").assigned_by.is_empty(), "the syllabus passage doesn't name chapter 7, and a reading can't assign itself");
        assert!(by("Trees again").reference, "nothing points to it");
        assert!(!by("Injective functions").reference, "taught in the course's own files");
        let built = ScopeMap { version: VERSION, course: "C241".into(), name: "C241".into(), parts: vec![], fingerprint: String::new(), built: 0, topics: topics.clone(), notation: vec![], exams: exams.clone(), dropped: 0 };
        let titles = |ts: Vec<&Topic>| ts.iter().map(|t| t.title.clone()).collect::<Vec<_>>();
        assert_eq!(titles(in_scope(&built, Some(&exams[0]))), ["Relations", "Injective functions"], "reference topics are never in scope, even when an exam lists them");
        assert_eq!(titles(in_scope(&built, None)), ["Relations", "Injective functions"]);
        assert!(points_to("Read sections 5.1–5.3", Some("5.1"), &[], "x") && points_to("Homework covers Chapter 7", Some("7.2–7.4"), &[], "x"));
        assert!(!points_to("Read sections 5.10 and 15.1", Some("5.1"), &[], "x"), "5.10 isn't 5.1");
        assert!(points_to("This week: spanning trees", None, &["spanning tree".into()], "x") && !points_to("This week: sets", None, &[], "Trees"));
        fs::remove_dir_all(root).unwrap();
    }

    /// A model that can look at pictures: answers like [`Scripted`], and keeps what it was shown.
    struct Seeing(super::super::model::tests::Scripted, std::sync::Mutex<Vec<Vec<String>>>);

    impl Model for Seeing {
        async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
            self.1.lock().unwrap().push(vec![]);
            self.0.complete(system, user).await
        }
        fn shows_pictures(&self) -> bool {
            true
        }
        async fn complete_seeing(&self, system: &str, user: &str, pictures: &[super::super::model::Picture]) -> Result<String, String> {
            self.1.lock().unwrap().push(pictures.iter().map(|p| p.label.clone()).collect());
            self.0.complete(system, user).await
        }
    }

    #[test]
    fn a_model_that_sees_is_shown_handwritten_pages_and_its_quotes_from_them_are_checked_roughly() {
        let (root, mut vis) = course("pictures");
        let c = root.join("courses/C241");
        // A scanned page (a stored picture), and what text recognition read from it.
        let grey: Vec<u8> = (0..300 * 200).map(|i| (i % 250) as u8).collect();
        fs::write(c.join("files/Week 4.pdf"), crate::lms::text::pictures::tests::grey_pdf(300, 200, &grey)).unwrap();
        fs::write(c.join("files/Week 4.pdf.md"), format!("# Text of Week 4.pdf\n\n## Page 1 {}\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R", crate::lms::text::RECOGNISED)).unwrap();
        vis.courses[0].state.material = Some(crate::lms::material::Report {
            version: crate::lms::material::VERSION,
            files: vec![crate::lms::material::FileQuality { path: "files/Week 4.pdf".into(), pages: 1, handwriting: vec![1], ..Default::default() }],
            cant_recognise: None,
        });
        // The words as the model reads them from the picture, not as recognition did.
        let reply = r#"{"topics": [
          {"id": "r", "title": "Reflexive relations", "evidence": [{"source": "Week 4.pdf", "quote": "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R"}]},
          {"id": "a", "title": "Injective functions", "evidence": [{"source": "Notes.pdf", "quote": "A function f is injective if no two inputs give the same output."}]},
          {"id": "x", "title": "Made up", "evidence": [{"source": "Week 4.pdf", "quote": "A function is surjective when every element of the codomain is hit"}]}
        ], "exams": []}"#;
        let seeing = Seeing(super::super::model::tests::Scripted::new(&[reply]), Default::default());
        let map = tauri::async_runtime::block_on(build(&vis, &vis.courses[0], &[], &seeing, 1, &|_, _| {})).unwrap();
        assert_eq!(*seeing.1.lock().unwrap(), [vec!["courses/C241/files/Week 4.pdf, page 1".to_string()]], "shown the handwritten page");
        let (system, user) = seeing.0.asked.lock().unwrap()[0].clone();
        assert!(system.starts_with(crate::study::COURSE_ONLY), "{system}");
        assert!(user.contains("<pictures>") && user.contains("Week 4.pdf, page 1"));
        let r = map.topics.iter().find(|t| t.title == "Reflexive relations").unwrap();
        assert_eq!((r.evidence[0].picture, r.evidence[0].at.as_deref()), (Some(1), Some("p. 1")), "read from the picture, close enough to what was recognised");
        assert!(map.topics.iter().all(|t| t.title != "Made up"), "a quote the page doesn't roughly hold is dropped");
        assert_eq!(map.topics.iter().find(|t| t.title == "Injective functions").unwrap().evidence[0].picture, None, "typed text: exact, as before");

        // A model that can't look: never shown anything, and the same quote isn't believed.
        let blind = super::super::model::tests::Scripted::new(&[reply]);
        let map = tauri::async_runtime::block_on(build(&vis, &vis.courses[0], &[], &blind, 2, &|_, _| {})).unwrap();
        assert!(map.topics.iter().all(|t| t.title != "Reflexive relations"));
        assert!(!blind.asked.lock().unwrap()[0].1.contains("<pictures>"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn built_cached_invalidated_and_stated() {
        let (root, vis) = course("build");
        let seen = &vis.courses[0];
        assert!(cached(&vis, seen, None).is_none());
        let m = super::super::model::tests::Scripted::new(&["no json", MAP]);
        let calls = std::sync::Mutex::new(vec![]);
        let exams = [Exam { course: Some("C241".into()), title: "Test 1".into(), date: "2026-10-15".into() }, Exam { course: None, title: "Midterm 2".into(), date: "2026-11-20".into() }];
        let map = tauri::async_runtime::block_on(build(&vis, seen, &exams, &m, 7, &|d, t| calls.lock().unwrap().push((d, t)))).unwrap();
        assert_eq!(m.calls(), 2, "a reply with no map is asked again once");
        assert!(m.asked.lock().unwrap()[0].1.contains("Test 1 on 2026-10-15"), "the calendar's exams are told");
        assert_eq!(*calls.lock().unwrap(), [(0, 1), (1, 1)]);
        assert_eq!(map.exams.iter().map(|e| (e.title.as_str(), e.known, e.date.as_deref())).collect::<Vec<_>>(), [("Test 1", true, Some("2026-10-15")), ("Final", false, None), ("Midterm 2", false, Some("2026-11-20"))]);
        let (again, fresh) = cached(&vis, seen, None).unwrap();
        assert!(fresh && again == map);
        assert!(root.join(".phaethon/scope/C241.json").is_file(), "kept in the vault's own folder, out of the agent's reach");
        // A changed file makes it stale.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("courses/C241/files/Notes.pdf.md"), "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is injective if no two inputs give the same output. More.").unwrap();
        assert!(!cached(&vis, seen, None).unwrap().1);
        // The person's word, read against the topics once, shown as from them.
        state(&vis, seen, "Midterm 2", "Everything on functions, not graphs", 9).unwrap();
        let r = super::super::model::tests::Scripted::new(&[r#"{"includes": ["t1", "t9"], "excludes": ["t2"]}"#]);
        let e = tauri::async_runtime::block_on(exam_scope(&vis, seen, &map, "midterm 2", &r)).unwrap().unwrap();
        assert!(e.from_user && e.includes == ["t1"] && e.excludes == ["t2"] && e.evidence[0].source == FROM_YOU, "{e:?}");
        let none = super::super::model::tests::Scripted::new(&[]);
        let e2 = tauri::async_runtime::block_on(exam_scope(&vis, seen, &map, "Midterm 2", &none)).unwrap().unwrap();
        assert_eq!((e2.includes, none.calls()), (vec!["t1".to_string()], 0), "read once, then kept");
        assert!(tauri::async_runtime::block_on(exam_scope(&vis, seen, &map, "Final", &none)).unwrap().is_none(), "unknown stays unknown");
        let t1 = tauri::async_runtime::block_on(exam_scope(&vis, seen, &map, "test 1", &none)).unwrap().unwrap();
        assert!(!t1.from_user && t1.known);
        // In the prompt: topics, scopes with their evidence as citations, what isn't on it, and the person's word.
        let p = prompt_section(&vis).unwrap();
        assert!(p.contains("- Injective functions (5.3)") && p.contains("Test 1: through HW 6; not graphs or combinatorics"), "{p}");
        assert!(p.contains("[source: courses/C241/announcements.md \"Test 1 will not cover graphs or combinatorics.\"]") && p.contains("Not on Test 1: Graphs."), "{p}");
        assert!(p.contains("Midterm 2: the student says it covers: Everything on functions") && p.contains("Final: what it covers wasn't found"), "{p}");
        assert!(p.contains("changed since this was mapped"));
        state(&vis, seen, "Midterm 2", "", 10).unwrap();
        assert!(stated(&vis, seen).is_empty(), "an empty statement forgets it");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_space_seeing_fewer_parts_gets_its_own_map() {
        let (root, _) = course("parts");
        let vis = fixture(&root, "s", &[("C241", &[Part::Files])]);
        let files = sources::course_files(&vis, &vis.courses[0]);
        assert!(files.iter().all(|f| !f.label.ends_with("announcements.md")), "announcements aren't read for a space that can't see them");
        assert_eq!(parts_key(&vis.courses[0]), "files");
        let chunks = map_chunks(&files);
        assert!(!chunks.join("").contains("Test 1"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn questions_are_spread_by_weight_over_every_topic() {
        let t = |id: &str, w: f64| Topic { id: id.into(), title: id.into(), weight: w, ..Default::default() };
        let ts = [t("a", 5.0), t("b", 1.0), t("c", 2.0), t("d", 2.0)];
        let refs: Vec<&Topic> = ts.iter().collect();
        let a = allocate(&refs, 10);
        assert_eq!(a.iter().map(|(_, n)| *n).sum::<usize>(), 10);
        assert!(a.iter().all(|(_, n)| *n >= 1), "every topic in scope gets a question: {a:?}");
        assert!(a[0].1 > a[2].1 && a[2].1 >= a[1].1, "{a:?}");
        let few = allocate(&refs, 2);
        assert_eq!(few.iter().map(|(i, n)| (i.as_str(), *n)).collect::<Vec<_>>(), [("a", 1), ("b", 0), ("c", 1), ("d", 0)]);
        // Fewer questions than topics: spread over the whole scope, not its first chapters
        // (the real C241 Test 1 practice test had none on relations or functions before this).
        let many: Vec<Topic> = (0..26).map(|i| t(&format!("t{i}"), if i == 13 || i == 15 { 5.0 } else if i % 3 == 0 { 2.0 } else { 4.0 })).collect();
        let mrefs: Vec<&Topic> = many.iter().collect();
        let picked: Vec<usize> = allocate(&mrefs, 10).iter().enumerate().filter(|(_, (_, n))| *n == 1).map(|(i, _)| i).collect();
        assert_eq!(picked.len(), 10);
        assert!(picked.iter().any(|&i| i >= 22) && picked.iter().any(|&i| i <= 3), "from the first topics to the last: {picked:?}");
        assert!(picked.windows(2).all(|w| w[1] - w[0] <= 5), "no long stretch left out: {picked:?}");
        assert_eq!(allocate(&mrefs, 26).iter().map(|(_, n)| *n).sum::<usize>(), 26);
        assert_eq!(allocate(&refs, 4).iter().map(|(_, n)| *n).collect::<Vec<_>>(), [1, 1, 1, 1]);
    }

    #[test]
    fn exams_are_found_by_name() {
        let e = |t: &str| unknown_exam(t, None);
        let list = [e("Test 1"), e("Test 2"), e("Final Exam")];
        assert_eq!(find_exam(&list, "test 1").unwrap().title, "Test 1");
        assert_eq!(find_exam(&list, "Exam 1").unwrap().title, "Test 1");
        assert_eq!(find_exam(&list, "the final").unwrap().title, "Final Exam");
        assert!(find_exam(&list, "Test 3").is_none());
        assert_eq!(named_exam(&list, "practice test for Test 1 please").as_deref(), Some("Test 1"));
        assert_eq!(named_exam(&list, "Test 12 stuff"), None);
        assert_eq!(named_exam(&list, "sets and logic"), None);
    }
}
