//! Questions and cards made only from what a course teaches, and checked
//! before they are kept. Time is spent on purpose: a practice test with a
//! question the course never covered is worse than a shorter one.
//!
//! 1. Scope. For course material, the course's scope map (scope.rs) is built
//!    or reused; an exam named in the request (or its focus) fixes the topics
//!    in scope. An exam whose coverage is unknown stops here and says so.
//! 2. Coverage. Questions are spread over the topics in scope by how much the
//!    course leans on each (scope::allocate), and the material sent is those
//!    topics' own passages, with homework in scope as the level to match.
//! 3. Writing. Every question names its topic and cites the passages it needs,
//!    copied word for word.
//! 4. The gate. Mechanically: the topic is in scope, and every quote is in the
//!    file it names, which the space may read. Words the course never uses are
//!    picked out. Then an independent check (a fresh call of the study model,
//!    given only the scope, the cited passages, the course's notation whose
//!    passages are found in its files, and the question): is every concept and
//!    notation taught there, inside the exam's scope, and is the answer right?
//!    "No" or "unsure" drops it.
//! 5. Shortfalls are written again, a bounded number of times; what is still
//!    short is delivered short, with the reasons, never padded.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::deck::Note;
use super::generate::{self, Emit, StudyEvent, similar};
use super::model::{Model, extract_json};
use super::quiz::Question;
use super::quote;
use super::schedule::Exam;
use super::scope::{self, Evidence, ExamScope, ScopeMap, Topic};
use super::sources::{self, CourseFile, Material};
use crate::lms::access::{Seen, Visible};

/// Writing rounds at most: the first, then two to make up what was dropped.
pub const ROUNDS: usize = 3;
/// Questions checked in one call of the checker.
const CHECK_BATCH: usize = 12;
/// Characters around a quote shown to the checker.
const AROUND: usize = 700;
const CITES_MAX: usize = 3;
/// Material sent for writing (about 25k tokens), of which homework examples.
const BUDGET: usize = 100_000;
const HOMEWORK_BUDGET: usize = 12_000;

// ---- What is saved and shown -------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    /// The question or card, as written.
    pub text: String,
    pub why: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub topic: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<String>,
    pub count: usize,
    /// Why it has none, when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// What a quiz or deck was made against, and how the check went.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grounding {
    /// The exam it is for ("Test 1").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exam: Option<String>,
    /// That exam's scope in words ("through HW 6; not graphs or combinatorics").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The scope is the person's word, not found in the materials.
    #[serde(default)]
    pub from_user: bool,
    /// Where the scope comes from.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// How many were asked for, and kept.
    pub asked: usize,
    pub kept: usize,
    #[serde(default)]
    pub dropped: Vec<Dropped>,
    /// Each topic in scope and how many it got.
    #[serde(default)]
    pub coverage: Vec<Coverage>,
    /// Said when fewer were kept than asked for, or a focus didn't match.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

// ---- Reading cited files -----------------------------------------------------------

struct Doc {
    label: String,
    text: String,
    compact: OnceLock<quote::Compact>,
}

/// Cited files, read once each through the space's walls (sources::read_cited).
pub struct Library<'a> {
    space: &'a Path,
    visible: &'a Visible,
    docs: Mutex<Vec<Arc<Doc>>>,
    /// Pages the model was shown as pictures: a quote from one is checked roughly against its recognised text.
    pictured: Mutex<Vec<super::material::PageRef>>,
}

impl<'a> Library<'a> {
    pub fn new(space: &'a Path, visible: &'a Visible, files: &[CourseFile]) -> Library<'a> {
        let docs = files.iter().map(|f| Arc::new(Doc { label: f.label.clone(), text: f.text.clone(), compact: OnceLock::new() })).collect();
        Library { space, visible, docs: Mutex::new(docs), pictured: Mutex::default() }
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

    fn doc(&self, source: &str) -> Result<Arc<Doc>, String> {
        let labels: Vec<String> = self.docs.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|d| d.label.clone()).collect();
        if let Some(l) = sources::match_label(source, &labels) {
            return Ok(self.docs.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|d| d.label == l).cloned().expect("listed"));
        }
        let c = sources::read_cited(self.space, self.visible, source)?;
        let mut docs = self.docs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(d) = docs.iter().find(|d| d.label == c.label) {
            return Ok(d.clone());
        }
        let d = Arc::new(Doc { label: c.label, text: c.text, compact: OnceLock::new() });
        docs.push(d.clone());
        Ok(d)
    }

    /// The quote, found in the file it names: the evidence as kept and the
    /// passage around it for a checker. `Err` says why not, in words.
    pub fn check(&self, source: &str, q: &str) -> Result<(Evidence, String), String> {
        if let Some(why) = quote::unusable(q) {
            return Err(format!("its quote {why}"));
        }
        let d = self.doc(source).map_err(|e| format!("it cites {e}"))?;
        let hay = d.compact.get_or_init(|| quote::compact(&d.text));
        let Some(f) = quote::find_in(&d.text, hay, q) else {
            // Not word for word: only a page shown as a picture may match, and only roughly.
            let shown: Vec<u32> = self.pictured.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(l, _)| *l == d.label).map(|(_, p)| *p).collect();
            let page = super::material::picture_quote(&d.text, &shown, q).ok_or_else(|| format!("its quote isn’t in {}", file_name(&d.label)))?;
            let recognised = quote::page_text(&d.text, page).unwrap_or_default();
            let passage = format!("[{} p. {page}, read from the picture of the page; text recognition read it as:] {}\nQuoted from the picture: «{}»", d.label, recognised.chars().take(2 * AROUND).collect::<String>(), quote::tidy(q));
            return Ok((Evidence { source: d.label.clone(), quote: quote::tidy(q), at: Some(format!("p. {page}")), picture: Some(page) }, passage));
        };
        let problem_set = is_problem_set(&d.label);
        let (before, hit, after) = quote::context(&d.text, f, AROUND);
        let at = quote::locate(&d.text, f.start, problem_set);
        let shown = format!("[{}{}] {before}«{hit}»{after}", d.label, at.as_deref().map(|a| format!(" {a}")).unwrap_or_default());
        Ok((Evidence { source: d.label.clone(), quote: quote::tidy(q), at, picture: None }, shown))
    }
}

fn file_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

pub(crate) fn is_problem_set(label: &str) -> bool {
    let name = file_name(label).to_lowercase();
    name.starts_with("hw") || name.contains("homework") || name.contains("problem set") || name.contains("worksheet") || name.contains("review")
}

/// Files that say what a course is (announcements, the syllabus, the
/// assignment list), not where it teaches: never the passages questions come from.
fn is_logistics(label: &str) -> bool {
    let rel = label.splitn(3, '/').nth(2).unwrap_or(label).to_lowercase();
    matches!(rel.as_str(), "announcements.md" | "assignments.md" | "syllabus.md" | "grades.md") || file_name(&rel).contains("syllabus")
}

// ---- Words the course never uses ----------------------------------------------------

const COMMON: [&str; 40] = [
    "which", "following", "true", "false", "statement", "statements", "correct", "incorrect", "select", "apply", "answer", "explain", "about",
    "these", "those", "there", "their", "would", "could", "should", "every", "where", "what", "when", "whose", "given", "suppose", "consider",
    "because", "therefore", "neither", "either", "another", "other", "between", "without", "within", "exactly", "least", "most",
];

/// Words of `text` (LaTeX commands left out) the course never uses: for the checker to weigh.
pub fn unknown_words(text: &str, vocab: &HashSet<String>) -> Vec<String> {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            while chars.peek().is_some_and(|n| n.is_alphabetic()) {
                chars.next();
            }
            plain.push(' ');
        } else {
            plain.push(c);
        }
    }
    let mut out: Vec<String> = vec![];
    for w in plain.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 4) {
        let w = w.to_lowercase();
        if COMMON.contains(&w.as_str()) || out.contains(&w) {
            continue;
        }
        let stems = [w.clone(), w.trim_end_matches('s').to_string(), w.strip_suffix("es").unwrap_or(&w).to_string(), w.strip_suffix("ed").unwrap_or(&w).to_string(), w.strip_suffix("ing").unwrap_or(&w).to_string(), w.strip_suffix("ly").unwrap_or(&w).to_string()];
        let known = stems.iter().any(|s| s.len() >= 3 && (vocab.contains(s) || vocab.contains(&format!("{s}s")) || vocab.contains(&format!("{s}e")) || vocab.contains(&format!("{s}es"))));
        if !known {
            out.push(w);
        }
    }
    out.truncate(10);
    out
}

// ---- Material for writing -------------------------------------------------------------

/// Words to find a topic's passages by: its terms and the longer words of its title.
fn topic_terms(t: &Topic) -> Vec<String> {
    let mut out: Vec<String> = t.terms.iter().map(|x| x.to_lowercase()).filter(|x| x.chars().count() >= 3).collect();
    for w in t.title.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if w.chars().count() >= 5 && !out.iter().any(|o| o == w) && !["about", "using", "their", "with", "from", "proofs", "basic", "definitions"].contains(&w) {
            out.push(w.to_string());
        }
    }
    out
}

/// Section numbers a topic names ("3.8–3.13" → 3.8, 3.9 … 3.13; "5.4" → 5.4).
pub(crate) fn section_numbers(s: Option<&str>) -> Vec<String> {
    let Some(s) = s else { return vec![] };
    let nums: Vec<&str> = s.split(|c: char| !(c.is_ascii_digit() || c == '.')).map(|x| x.trim_matches('.')).filter(|x| x.contains('.')).collect();
    match nums.as_slice() {
        [a, b] => {
            let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split('.').collect(), b.split('.').collect());
            if pa.len() == 2 && pb.len() == 2 && pa[0] == pb[0]
                && let (Ok(x), Ok(y)) = (pa[1].parse::<u32>(), pb[1].parse::<u32>())
                && x <= y
                && y - x <= 30
            {
                return (x..=y).map(|k| format!("{}.{k}", pa[0])).collect();
            }
            vec![a.to_string(), b.to_string()]
        }
        list => list.iter().map(|x| x.to_string()).collect(),
    }
}

struct Piece {
    label: String,
    text: String,
}

/// The passages that teach `topics` (each as many as its share of questions
/// needs), then homework in scope as examples of the level, within the budget.
/// A contents page ("5.3 Properties of Functions . . . . 117"): it names every
/// section and teaches none.
fn is_contents(p: &str) -> bool {
    p.matches(". . .").count() >= 5
}

/// At most `len` bytes of `p`, around the first place `terms` (or a section heading) appear.
fn around_terms(p: &str, terms: &[String], sections: &[String], len: usize) -> String {
    if p.len() <= len {
        return p.to_string();
    }
    let lower = p.to_lowercase();
    let at = sections
        .iter()
        .filter_map(|s| p.find(&format!("{s} ")))
        .chain(terms.iter().filter_map(|t| lower.find(t.as_str())))
        .min()
        .unwrap_or(0);
    let mut start = at.saturating_sub(len / 4);
    while !p.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + len).min(p.len());
    while !p.is_char_boundary(end) {
        end -= 1;
    }
    let s = &p[start..end];
    // Whole words at the cut.
    let s = if start > 0 { s.split_once(char::is_whitespace).map_or(s, |(_, r)| r) } else { s };
    let s = if end < p.len() { s.rsplit_once(char::is_whitespace).map_or(s, |(l, _)| l) } else { s };
    s.to_string()
}

fn topic_material(files: &[CourseFile], topics: &[(&Topic, usize)], homework: &[String]) -> Material {
    let teaching: Vec<(&CourseFile, Vec<String>)> = files.iter().filter(|f| !is_logistics(&f.label)).map(|f| (f, sources::chunks(&sources::clean(&f.text)))).collect();
    let active: Vec<(&Topic, usize)> = topics.iter().filter(|(_, n)| *n > 0).map(|(t, n)| (*t, *n)).collect();
    let mut picked: Vec<(usize, usize)> = vec![];
    let mut out: Vec<Piece> = vec![];
    let mut used = 0;
    let room = BUDGET - HOMEWORK_BUDGET;
    // Every topic its best passage first, so none is starved; each passage cut to fit.
    let piece = (room / active.len().max(1)).clamp(1_200, 2 * 2_500);
    for pass in 0..3 {
        for (t, n) in &active {
            if pass >= (1 + n).min(3) {
                continue;
            }
            let terms = topic_terms(t);
            let sections = section_numbers(t.sections.as_deref());
            let mut best: Option<(usize, usize, usize)> = None;
            for (fi, (f, parts)) in teaching.iter().enumerate() {
                let hw = is_problem_set(&f.label);
                for (ci, p) in parts.iter().enumerate() {
                    if picked.contains(&(fi, ci)) || is_contents(p) {
                        continue;
                    }
                    let lower = p.to_lowercase();
                    let mut score: usize = terms.iter().map(|x| lower.matches(x.as_str()).count()).sum();
                    for s in &sections {
                        if p.contains(&format!("{s} ")) {
                            score += 6;
                        }
                    }
                    // Teaching text before problem sets: a question needs the idea taught.
                    if !hw {
                        score *= 2;
                    }
                    if score > 0 && best.is_none_or(|(b, _, _)| score > b) {
                        best = Some((score, fi, ci));
                    }
                }
            }
            if let Some((_, fi, ci)) = best {
                let text = around_terms(&teaching[fi].1[ci], &terms, &sections, piece);
                if used + text.len() > room {
                    continue;
                }
                used += text.len();
                picked.push((fi, ci));
                out.push(Piece { label: teaching[fi].0.label.clone(), text });
            }
        }
    }
    // In the order the course has them: by file, then place in it.
    let mut keyed: Vec<((usize, usize), Piece)> = picked.iter().copied().zip(out).collect();
    keyed.sort_by_key(|(k, _)| *k);
    let mut text = String::new();
    let mut labels: Vec<String> = vec![];
    for (_, p) in &keyed {
        text.push_str(&format!("<source path=\"{}\">\n{}\n</source>\n\n", p.label, p.text));
        if !labels.contains(&p.label) {
            labels.push(p.label.clone());
        }
    }
    // Homework in scope: what the course asks of students, to match.
    let mut hw_used = 0;
    let hw_files: Vec<&CourseFile> = files.iter().filter(|f| homework.contains(&f.label)).collect();
    let share = if hw_files.is_empty() { 0 } else { (HOMEWORK_BUDGET / hw_files.len().min(3)).max(1_500) };
    for f in hw_files.iter().rev().take(3) {
        let sample = sources::sample(&sources::clean(&f.text), share, &[]);
        if hw_used + sample.len() > HOMEWORK_BUDGET + 500 {
            break;
        }
        hw_used += sample.len();
        text.push_str(&format!("<homework path=\"{}\">\n{}\n</homework>\n\n", f.label, sample));
        if !labels.contains(&f.label) {
            labels.push(f.label.clone());
        }
    }
    let course = labels.first().and_then(|l| l.strip_prefix("courses/")).and_then(|r| r.split_once('/')).map(|(c, _)| c.to_string());
    Material { text: text.trim_end().to_string(), labels, course }
}

// ---- The scope a request is made against -------------------------------------------

/// What a request is made against.
pub struct Scoped {
    pub map: Option<ScopeMap>,
    pub exam: Option<ExamScope>,
    /// Topics to write on and how many each, in the course's order.
    pub plan: Vec<(Topic, usize)>,
    /// Topics in the map but not in scope (for the checker and the writer to avoid).
    pub outside: Vec<Topic>,
    pub notes: Vec<String>,
}

/// The exam's scope could not be found: said to the person, who can state it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownScope {
    /// The course's folder ("courses/<folder>").
    pub course: String,
    pub course_name: String,
    pub exam: String,
}

fn focus_words(focus: &str) -> Vec<String> {
    sources::focus_terms(Some(focus)).into_iter().map(|w| w.trim_end_matches('s').to_string()).filter(|w| w.len() >= 3).collect()
}

fn topic_matches(t: &Topic, words: &[String]) -> bool {
    let hay = format!("{} {} {}", t.title, t.terms.join(" "), t.sections.as_deref().unwrap_or("")).to_lowercase();
    words.iter().any(|w| hay.contains(w.as_str()))
}

/// Settle the scope: the course's map (built or reused), the exam named, the
/// topics in scope (narrowed by the focus), and how many questions each gets.
#[allow(clippy::too_many_arguments)] // one request's inputs, each needed
pub async fn scoped<M: Model>(visible: &Visible, seen: &Seen, files: &[CourseFile], exams: &[Exam], exam: Option<&str>, focus: Option<&str>, count: usize, model: &M, emit: Emit<'_>, now: u64) -> Result<Scoped, (String, Option<UnknownScope>)> {
    let map = match scope::cached(visible, seen, Some(files)) {
        Some((m, true)) => m,
        _ => {
            emit(StudyEvent::progress("mapping", 0, 1));
            let progress = |d: usize, t: usize| emit(StudyEvent::progress("mapping", d, t));
            scope::build(visible, seen, exams, model, now, &progress).await.map_err(|e| (e, None))?
        }
    };
    let mut notes = vec![];
    // The exam asked for, or one named in the focus ("practice for Test 1").
    let wanted = exam.map(str::to_string).filter(|e| !e.trim().is_empty()).or_else(|| focus.and_then(|f| scope::named_exam(&map.exams, f)));
    let exam_scope = match wanted.as_deref() {
        None => None,
        Some(w) => match scope::exam_scope(visible, seen, &map, w, model).await.map_err(|e| (e, None))? {
            Some(e) => Some(e),
            None => {
                let title = scope::find_exam(&map.exams, w).map_or(w.to_string(), |e| e.title.clone());
                let msg = format!("I couldn’t find what {title} covers in your {} materials, so I haven’t made anything: I won’t guess. Tell me what it covers (for example “through HW 6, not graphs”) and I’ll make it from that.", seen.state.name);
                return Err((msg, Some(UnknownScope { course: format!("courses/{}", seen.folder()), course_name: seen.state.name.clone(), exam: title })));
            }
        },
    };
    let mut topics: Vec<&Topic> = scope::in_scope(&map, exam_scope.as_ref());
    if topics.is_empty() {
        return Err((format!("None of {}’s mapped topics are inside {}. Tell me what it covers, or map the course again.", seen.state.name, exam_scope.as_ref().map_or("the scope", |e| e.title.as_str())), None));
    }
    // A focus narrows the topics in scope; one that matches none is said, never stretched to.
    if let Some(f) = focus.filter(|f| !f.trim().is_empty()) {
        let words: Vec<String> = focus_words(f).into_iter().filter(|w| !scope::named_exam(&map.exams, w).is_some() && !["test", "exam", "quiz", "practice", "midterm", "final"].contains(&w.as_str())).collect();
        if !words.is_empty() {
            let narrowed: Vec<&Topic> = topics.iter().copied().filter(|t| topic_matches(t, &words)).collect();
            if narrowed.is_empty() {
                let in_course = map.topics.iter().any(|t| topic_matches(t, &words));
                notes.push(if in_course {
                    format!("“{f}” is outside {}, so the questions cover everything in it instead.", exam_scope.as_ref().map_or("what you chose".to_string(), |e| e.title.clone()))
                } else {
                    format!("I couldn’t find “{f}” among the topics {} teaches, so the questions cover {} instead.", map.name, exam_scope.as_ref().map_or("all of them".to_string(), |e| format!("everything in {}", e.title)))
                });
            } else {
                topics = narrowed;
            }
        }
    }
    let alloc = scope::allocate(&topics, count);
    let plan: Vec<(Topic, usize)> = topics.iter().zip(alloc).map(|(t, (_, n))| ((*t).clone(), n)).collect();
    let inside: HashSet<&str> = plan.iter().map(|(t, _)| t.id.as_str()).collect();
    let outside = map.topics.iter().filter(|t| !inside.contains(t.id.as_str())).cloned().collect();
    Ok(Scoped { map: Some(map), exam: exam_scope, plan, outside, notes })
}

// ---- Writing and checking ---------------------------------------------------------------

/// What is being made.
pub enum Want<'a> {
    Quiz { kinds: &'a [String], difficulty: &'a str },
    Deck { existing: &'a [String] },
}

/// One written question or card, before and after the gate.
#[derive(Debug, Clone)]
pub enum Item {
    Q(Question),
    N(Note),
}

impl Item {
    fn text(&self) -> String {
        match self {
            Item::Q(q) => q.prompt.clone(),
            Item::N(n) => n.front.clone(),
        }
    }
    /// Everything a student reads in it, for the checker and the word check.
    fn whole(&self) -> String {
        match self {
            Item::Q(q) => {
                let mut s = format!("Question ({}): {}", q.kind, q.prompt);
                if let Some(c) = &q.choices
                    && q.kind != "truefalse"
                {
                    s.push_str(&format!("\nChoices: {}", c.join(" | ")));
                }
                s.push_str(&format!("\nMarked answer: {}", q.answer.text()));
                if let Some(a) = &q.accept {
                    s.push_str(&format!(" (also accepted: {})", a.join(", ")));
                }
                s.push_str(&format!("\nExplanation: {}", q.explanation));
                s
            }
            Item::N(n) => format!("Card front: {}\nCard back: {}", n.front, n.back),
        }
    }
    /// What it says, without the labels, for the word check.
    fn words(&self) -> String {
        match self {
            Item::Q(q) => format!("{} {} {} {} {}", q.prompt, q.choices.as_deref().unwrap_or_default().join(" "), q.answer.text(), q.accept.as_deref().unwrap_or_default().join(" "), q.explanation),
            Item::N(n) => format!("{} {}", n.front, n.back),
        }
    }
}

struct Candidate {
    item: Item,
    topic: Option<String>,
    cites: Vec<Evidence>,
    passages: Vec<String>,
    unknown: Vec<String>,
}

pub const GROUNDING_RULES: &str = r#"Ground every one in the course, strictly:
- It tests exactly one topic from <topics>, named by its id in "topic". Write the number asked for each topic.
- It uses only ideas, terms, notation and techniques taught in the <material> passages, written the course's way (its notation, its names). A standard idea of the subject that these passages don't teach is off limits, however natural it seems: the student will be tested on this course, not the subject.
- Nothing from <not_in_scope>, not even as a distractor or in an explanation.
- "citations": 1 to 3 passages it is built on, each {"source": the <source> path copied exactly, "quote": one or two sentences copied character for character from that source (at least five words; no paraphrase, no stitching)}. Together they must teach everything a student needs to answer it. Cite the teaching passages, not <homework>.
- Match the level of the <homework> problems: like them in difficulty and style, never beyond.
Every one is checked: a quote not found in its file, a topic out of scope, or an idea the cited passages don't teach throws it away."#;

pub const VERIFY_SYSTEM: &str = r#"You check practice questions and flashcards against a student's own course materials, before the student sees them. Someone else wrote them; be strict and independent.

For each item you get the exam scope, the topic it claims, the passages it cites (with the text around them, the quote marked «like this»), and words in it that appear nowhere in the course's materials. You may also get <course_notation>: symbols the course itself defines, each with the passage where it does, found in the course's files.

Answer "yes" only if all of these hold:
1. Every concept, term, symbol, notation and technique needed to understand it and to answer it (including its choices, its answer and its explanation) is taught in the cited passages, except that a symbol listed in <course_notation> counts as taught, with the meaning given there, even when the cited passages don't define it. That list covers only those symbols as written: it doesn't make any other symbol, term or idea taught. A standard idea of the subject that the passages don't teach is a "no", however basic. A word that appears nowhere in the course is a strong sign of that.
2. Its topic is inside the exam's scope: not excluded, not after the cutoff.
3. The marked answer is right according to the passages, and the question has one defensible answer.
Answer "no" when any fails, and "unsure" when you can't tell from what you were given.

Reply with only JSON: {"verdicts": [{"id": "...", "verdict": "yes" | "no" | "unsure", "missing": "what isn't taught or in scope, in a few words (empty for yes)", "answerOk": true}]}"#;

fn scope_block(s: &Scoped, course: &str) -> String {
    let mut out = String::from("<scope>\n");
    match &s.exam {
        Some(e) => out.push_str(&format!("Exam: {}\n", scope::scope_words(e))),
        None if s.map.is_some() => out.push_str(&format!("No particular exam: anything {course} has taught.\n")),
        None => out.push_str("The chosen material only.\n"),
    }
    if !s.plan.is_empty() {
        out.push_str("Topics in scope:\n");
        for (t, _) in &s.plan {
            out.push_str(&format!("- {}{}\n", t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default()));
        }
    }
    let mut not: Vec<String> = s.outside.iter().map(|t| t.title.clone()).collect();
    if let Some(e) = &s.exam {
        not.extend(e.excluded_words.iter().cloned());
    }
    if !not.is_empty() {
        out.push_str(&format!("Not in scope: {}\n", not.join("; ")));
    }
    out.push_str("</scope>");
    out
}

/// The course's notation that may be taken as taught: only entries of the map
/// whose evidence is still found, word for word, in a file the space may read.
/// An entry without such a passage is never given to the writer or the checker.
fn taught_notation(map: Option<&ScopeMap>, library: &Library) -> String {
    let Some(map) = map else { return String::new() };
    let mut out = vec![];
    for n in &map.notation {
        let found = n.evidence.iter().filter(|e| e.source != scope::FROM_YOU).find_map(|e| library.check(&e.source, &e.quote).ok());
        if let Some((ev, _)) = found
            && !n.symbol.trim().is_empty()
        {
            out.push(format!("{}: {} {}", n.symbol.trim(), n.meaning.trim(), scope::cite(&ev)));
        }
    }
    out.join("\n")
}

/// The request for one round of writing.
#[allow(clippy::too_many_arguments)] // one round's inputs, each needed
fn write_request(s: &Scoped, want: &Want, material: &Material, need: &[(Topic, usize)], kept: &[String], refused: &[Dropped], context: Option<&str>, extra: &str, notation: &str) -> String {
    let noun = if matches!(want, Want::Quiz { .. }) { "questions" } else { "flashcards" };
    let total: usize = need.iter().map(|(_, n)| n).sum();
    let mut u = String::new();
    match want {
        Want::Quiz { kinds, difficulty } => u.push_str(&format!("Write {total} practice questions. Kinds: {}. Difficulty: {difficulty}.\n\n", kinds.join(", "))),
        Want::Deck { .. } => u.push_str(&format!("Write {total} flashcards.\n\n")),
    }
    if need.iter().any(|(t, _)| !t.id.is_empty()) {
        u.push_str("<topics>\n");
        for (t, n) in need {
            u.push_str(&format!("- {}: {}{} — {n} {noun}\n", t.id, t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default()));
        }
        u.push_str("</topics>\n\n");
    }
    let mut not: Vec<String> = s.outside.iter().map(|t| t.title.clone()).collect();
    if let Some(e) = &s.exam {
        not.extend(e.excluded_words.iter().cloned());
    }
    if !not.is_empty() {
        u.push_str(&format!("<not_in_scope>\n{}\n</not_in_scope>\n\n", not.join("\n")));
    }
    if !notation.is_empty() {
        u.push_str(&format!("<notation>\n{notation}\n</notation>\n\n"));
    }
    u.push_str(&format!("<material>\n{}\n</material>", material.text));
    if !kept.is_empty() {
        u.push_str(&format!("\n\nAlready written (don't repeat these):\n{}", kept.iter().map(|k| format!("- {k}")).collect::<Vec<_>>().join("\n")));
    }
    if !refused.is_empty() {
        u.push_str(&format!(
            "\n\nThese were thrown away by the check; don't write anything like them again:\n{}",
            refused.iter().rev().take(12).map(|d| format!("- {} ({})", d.text.chars().take(200).collect::<String>(), d.why)).collect::<Vec<_>>().join("\n")
        ));
    }
    if let Some(c) = context.map(str::trim).filter(|c| !c.is_empty()) {
        u.push_str(&format!(
            "\n\n<discussion>\n{c}\n</discussion>\n\nThe student asked for these {noun} in that conversation. Keep to what was promised there only as far as the scope and the material allow: the discussion is not course material."
        ));
    }
    u.push_str(extra);
    u
}

fn str_of(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// The candidates in one reply, each through the mechanical part of the gate.
#[allow(clippy::too_many_arguments)] // one round's inputs, each needed
fn sort_reply(v: &Value, want: &Want, s: &Scoped, material: &Material, library: &Library, vocab: &HashSet<String>, start: usize, dropped: &mut Vec<Dropped>) -> Vec<Candidate> {
    let key = if matches!(want, Want::Quiz { .. }) { "questions" } else { "cards" };
    let list = v.get(key).and_then(Value::as_array).or_else(|| v.as_array()).cloned().unwrap_or_default();
    let ids: HashMap<&str, &Topic> = s.plan.iter().map(|(t, _)| (t.id.as_str(), t)).collect();
    let mut out = vec![];
    for (i, raw) in list.iter().enumerate() {
        let n = start + i + 1;
        let shown = str_of(raw, if key == "questions" { "prompt" } else { "front" });
        let mut drop = |why: String| dropped.push(Dropped { text: shown.clone(), why });
        // Its topic: one in scope.
        let topic_id = str_of(raw, "topic");
        let topic = if s.plan.is_empty() {
            None
        } else {
            match ids.get(topic_id.as_str()) {
                Some(t) => Some(*t),
                None => {
                    let out_of = s.outside.iter().find(|t| t.id == topic_id).map(|t| t.title.clone());
                    drop(match out_of {
                        Some(t) => format!("its topic, {t}, isn’t in scope"),
                        None => "it doesn’t name a topic in scope".to_string(),
                    });
                    continue;
                }
            }
        };
        // Every quote in the file it names.
        let mut cites = vec![];
        let mut passages = vec![];
        let mut bad = None;
        let list: Vec<&Value> = match &raw["citations"] {
            Value::Array(a) => a.iter().take(CITES_MAX).collect(),
            Value::Object(_) => vec![&raw["citations"]],
            _ => vec![],
        };
        for c in list {
            match library.check(&str_of(c, "source"), &str_of(c, "quote")) {
                Ok((ev, passage)) => {
                    if !cites.iter().any(|x: &Evidence| x.quote == ev.quote) {
                        cites.push(ev);
                        passages.push(passage);
                    }
                }
                Err(why) => {
                    bad = Some(why);
                    break;
                }
            }
        }
        if let Some(why) = bad {
            drop(why);
            continue;
        }
        if cites.is_empty() {
            drop("it cites no passage".into());
            continue;
        }
        let source = Some(cites[0].source.clone());
        let item = match want {
            Want::Quiz { kinds, .. } => generate::question_from(raw, n, material, kinds, source).map(Item::Q),
            Want::Deck { .. } => generate::card_from(raw, n, material, source).map(|mut note| {
                note.quote = Some(cites[0].quote.clone());
                note.picture = cites[0].picture;
                Item::N(note)
            }),
        };
        let item = match item {
            Ok(i) => i,
            Err(e) => {
                drop(e.trim_start_matches(&format!("question {n} ")).trim_start_matches(&format!("card {n} ")).to_string());
                continue;
            }
        };
        let unknown = unknown_words(&item.words(), vocab);
        out.push(Candidate { item, topic: topic.map(|t| t.id.clone()), cites, passages, unknown });
    }
    out
}

/// The independent check, in batches. Returns, per candidate, `None` to keep or why it goes.
#[allow(clippy::too_many_arguments)] // one check's inputs, each needed
async fn verify<M: Model>(
    s: &Scoped,
    course: &str,
    notation: &str,
    cands: &[Candidate],
    model: &M,
    pictures_of: &(dyn Fn(&[super::material::PageRef], usize) -> Vec<super::model::Picture> + Sync),
    emit: Emit<'_>,
    kept_so_far: usize,
    dropped_so_far: usize,
) -> Result<Vec<Option<String>>, String> {
    let system = super::course_only(VERIFY_SYSTEM);
    let mut out: Vec<Option<String>> = vec![];
    let titles: HashMap<&str, String> = s.plan.iter().map(|(t, _)| (t.id.as_str(), format!("{}{}", t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default()))).collect();
    let mut scope = scope_block(s, course);
    if !notation.is_empty() {
        scope.push_str(&format!("\n\n<course_notation>\n{notation}\n</course_notation>"));
    }
    let (mut kept, mut dropped) = (kept_so_far, dropped_so_far);
    for (b, batch) in cands.chunks(CHECK_BATCH).enumerate() {
        emit(StudyEvent::checking(b * CHECK_BATCH, cands.len(), kept, dropped));
        let mut u = format!("{scope}\n\n");
        for (i, c) in batch.iter().enumerate() {
            u.push_str(&format!("<item id=\"i{}\">\n", i + 1));
            if let Some(t) = c.topic.as_deref().and_then(|t| titles.get(t)) {
                u.push_str(&format!("Claimed topic: {t}\n"));
            }
            u.push_str(&c.item.whole());
            u.push_str("\n<cited>\n");
            for p in &c.passages {
                u.push_str(p);
                u.push_str("\n\n");
            }
            u.push_str("</cited>\n");
            if !c.unknown.is_empty() {
                u.push_str(&format!("Words in it that appear nowhere in the course's materials: {}\n", c.unknown.join(", ")));
            }
            u.push_str("</item>\n\n");
        }
        let ids: Vec<String> = (1..=batch.len()).map(|i| format!("i{i}")).collect();
        // A passage read from a page's picture is checked against that picture too.
        let read: Vec<super::material::PageRef> = batch.iter().flat_map(|c| c.cites.iter().filter_map(|e| e.picture.map(|p| (e.source.clone(), p)))).collect();
        let pictures = pictures_of(&super::material::round_robin(vec![read], super::material::CHECK_PICTURES), super::material::CHECK_PICTURES);
        u.push_str(&super::material::pictures_note(&pictures));
        let verdicts = super::model::ask_json_seeing(model, &system, &u, &pictures, |v| {
            let list = v.get("verdicts").and_then(Value::as_array).ok_or("expected an object with a \"verdicts\" array")?;
            let mut got: HashMap<String, (String, String, bool)> = HashMap::new();
            for x in list {
                let id = str_of(x, "id");
                let verdict = str_of(x, "verdict").to_lowercase();
                if !["yes", "no", "unsure"].contains(&verdict.as_str()) {
                    return Err(format!("the verdict for {id} must be yes, no or unsure"));
                }
                got.insert(id, (verdict, str_of(x, "missing"), x["answerOk"].as_bool().unwrap_or(true)));
            }
            if got.is_empty() {
                return Err("there were no verdicts".into());
            }
            Ok(got)
        })
        .await
        .map_err(|e| format!("The questions couldn’t be checked against your notes, so nothing was saved: {e}"))?;
        for (i, _) in batch.iter().enumerate() {
            let why = match verdicts.get(&ids[i]) {
                Some((v, _, true)) if v == "yes" => None,
                Some((v, _, false)) if v == "yes" => Some("its answer isn’t right by the notes".to_string()),
                Some((v, missing, _)) => Some(if missing.is_empty() {
                    if v == "no" { "the check found it isn’t taught in the passages it cites".into() } else { "the check couldn’t confirm it is taught in your notes".into() }
                } else {
                    format!("{}: {}", if v == "no" { "not taught in your notes or not in scope" } else { "couldn’t be confirmed" }, missing.chars().take(160).collect::<String>())
                }),
                None => Some("the check gave no verdict on it".into()),
            };
            if why.is_none() {
                kept += 1;
            } else {
                dropped += 1;
            }
            out.push(why);
        }
    }
    emit(StudyEvent::checking(cands.len(), cands.len(), kept, dropped));
    Ok(out)
}

/// What a made thing is: its items, its title, and the grounding to keep with it.
pub struct Made {
    pub title: Option<String>,
    pub items: Vec<Item>,
    pub grounding: Grounding,
    pub material: Material,
}

/// What to make.
pub struct Ask<'a> {
    pub count: usize,
    pub exam: Option<&'a str>,
    pub focus: Option<&'a str>,
    pub context: Option<&'a str>,
    /// Said after everything else (a quiz's mistakes, for a deck from them).
    pub extra: &'a str,
}

fn title_of(v: &Value) -> Option<String> {
    Some(str_of(v, "title")).filter(|t| !t.is_empty())
}

/// Write, check, and write again what was dropped (at most [`ROUNDS`] times);
/// what still falls short is delivered short, with why.
#[allow(clippy::too_many_arguments)] // one request's inputs, each needed
pub async fn make<M: Model>(
    space: &Path,
    visible: &Visible,
    inputs: &[String],
    want: Want<'_>,
    ask: &Ask<'_>,
    model: &M,
    emit: Emit<'_>,
    now: u64,
) -> Result<Made, String> {
    let seen = sources::course_of(space, visible, inputs);
    let files = seen.map(|s| sources::course_files(visible, s)).unwrap_or_default();
    let (s, material, vocab_files) = match seen.filter(|_| !files.is_empty()) {
        Some(seen) => {
            let exams = super::load_exams(space);
            let s = match scoped(visible, seen, &files, &exams, ask.exam, ask.focus, ask.count, model, emit, now).await {
                Ok(s) => s,
                Err((message, unknown)) => {
                    if let Some(u) = unknown {
                        emit(StudyEvent::NeedsScope(u));
                    }
                    return Err(message);
                }
            };
            emit(StudyEvent::progress("reading", 0, 1));
            let need: Vec<(&Topic, usize)> = s.plan.iter().map(|(t, n)| (t, *n)).collect();
            let homework = match &s.exam {
                Some(e) if !e.homework.is_empty() => e.homework.clone(),
                // No exam: the homework files of the topics' course, any.
                _ => files.iter().filter(|f| is_problem_set(&f.label) && !f.label.to_lowercase().contains("review")).map(|f| f.label.clone()).collect(),
            };
            let m = topic_material(&files, &need, &homework);
            if m.text.trim().is_empty() {
                return Err(format!("I couldn’t find passages in {} that teach the topics in scope, so nothing was made.", seen.state.name));
            }
            (s, m, files.clone())
        }
        None => {
            emit(StudyEvent::progress("reading", 0, 1));
            let m = sources::gather(space, visible, inputs, ask.focus, sources::BUDGET)?;
            let s = Scoped { map: None, exam: None, plan: vec![], outside: vec![], notes: vec![] };
            let mut files = vec![];
            for l in &m.labels {
                if let Ok(c) = sources::read_cited(space, visible, l) {
                    files.push(CourseFile { label: c.label, sub: Default::default(), text: c.text, size: 0, modified: 0 });
                }
            }
            (s, m, files)
        }
    };
    emit(StudyEvent::progress("reading", 1, 1));
    let library = Library::new(space, visible, &vocab_files);
    let mut vocab = HashSet::new();
    for f in &vocab_files {
        sources::words_of(&f.text, &mut vocab);
    }
    let course_name = seen.map_or("your material".to_string(), |s| s.state.name.clone());
    let notation = taught_notation(s.map.as_ref(), &library);
    let system = super::course_only(&match want {
        Want::Quiz { .. } => format!("{}\n\n{GROUNDING_RULES}\n\nReply with only JSON, no prose: {{\"title\": \"a short quiz title\", \"questions\": [{{\"kind\": \"...\", \"topic\": \"t1\", \"prompt\": \"...\", \"choices\": [\"...\"], \"answer\": \"...\", \"accept\": [\"...\"], \"explanation\": \"...\", \"citations\": [{{\"source\": \"...\", \"quote\": \"...\"}}]}}]}}", generate::QUIZ_RULES),
        Want::Deck { .. } => format!("{}\n\n{GROUNDING_RULES}\n\nReply with only JSON, no prose: {{\"title\": \"a short deck title\", \"cards\": [{{\"topic\": \"t1\", \"front\": \"...\", \"back\": \"...\", \"citations\": [{{\"source\": \"...\", \"quote\": \"...\"}}]}}]}}", generate::DECK_RULES),
    });
    // The handwritten, scanned and figure pages the passages come from, for a model that can look at them.
    let pictures_of = |pages: &[super::material::PageRef], max: usize| match seen {
        Some(seen) if model.shows_pictures() && !pages.is_empty() => {
            let pics = super::material::pictures(visible, seen, pages, max);
            let shown: Vec<super::material::PageRef> = pages.iter().filter(|(l, p)| pics.iter().any(|x| x.label == format!("{l}, page {p}") || x.label == *l)).cloned().collect();
            library.shown(&shown);
            pics
        }
        _ => vec![],
    };
    let writing_pictures = match seen {
        Some(seen) => pictures_of(&super::material::pages_of_passages(seen, &vocab_files, &material.text, super::material::WRITE_PICTURES), super::material::WRITE_PICTURES),
        None => vec![],
    };
    let existing: Vec<String> = match &want {
        Want::Deck { existing } => existing.to_vec(),
        Want::Quiz { .. } => vec![],
    };
    // Without a map there is one "topic": the material itself.
    let target: Vec<(Topic, usize)> = if s.plan.is_empty() {
        vec![(Topic { weight: 1.0, ..Default::default() }, ask.count)]
    } else {
        s.plan.clone()
    };
    let mut kept: Vec<Candidate> = vec![];
    let mut dropped: Vec<Dropped> = vec![];
    let mut title = None;
    let mut seed = now | 1;
    let mut written = 0;
    for round in 0..ROUNDS {
        // What each topic still needs; the first round asks a little over, to absorb drops.
        let have = |id: &str| kept.iter().filter(|c| c.topic.as_deref().unwrap_or("") == id).count();
        let mut need: Vec<(Topic, usize)> = target.iter().filter_map(|(t, n)| {
            let short = n.saturating_sub(have(&t.id));
            (short > 0).then(|| (t.clone(), short))
        }).collect();
        if need.is_empty() {
            break;
        }
        if round == 0 {
            let extra = (ask.count / 4).max(1);
            let mut by_weight: Vec<usize> = (0..need.len()).collect();
            by_weight.sort_by(|&a, &b| need[b].0.weight.total_cmp(&need[a].0.weight));
            for &i in by_weight.iter().cycle().take(extra) {
                need[i].1 += 1;
            }
        }
        emit(StudyEvent::progress("making", round, ROUNDS));
        let kept_texts: Vec<String> = kept.iter().map(|c| c.item.text()).chain(existing.iter().cloned()).collect();
        let user = write_request(&s, &want, &material, &need, &kept_texts, &dropped, ask.context, ask.extra, &notation) + &super::material::pictures_note(&writing_pictures);
        let reply = match model.complete_seeing(&system, &user, &writing_pictures).await {
            Ok(r) => r,
            Err(e) if kept.is_empty() => return Err(e),
            // A later round failing keeps what passed.
            Err(e) => {
                dropped.push(Dropped { text: String::new(), why: format!("writing more stopped: {e}") });
                break;
            }
        };
        let Some(v) = extract_json(&reply) else {
            if round + 1 == ROUNDS && kept.is_empty() {
                return Err("The model’s answer had nothing usable in it, so nothing was saved. Try again.".into());
            }
            continue;
        };
        if title.is_none() {
            title = title_of(&v);
        }
        let mut cands = sort_reply(&v, &want, &s, &material, &library, &vocab, written, &mut dropped);
        written += cands.len();
        // Repeats (of what was kept, of each other, of existing cards) go before the check.
        let mut fresh: Vec<Candidate> = vec![];
        for c in cands.drain(..) {
            let t = c.item.text();
            if kept.iter().chain(fresh.iter()).any(|k| similar(&k.item.text(), &t)) || existing.iter().any(|e| similar(e, &t)) {
                continue;
            }
            fresh.push(c);
        }
        if fresh.is_empty() {
            continue;
        }
        let verdicts = verify(&s, &course_name, &notation, &fresh, model, &pictures_of, emit, kept.len(), dropped.len()).await?;
        for (c, why) in fresh.into_iter().zip(verdicts) {
            match why {
                None => kept.push(c),
                Some(w) => dropped.push(Dropped { text: c.item.text(), why: w }),
            }
        }
    }
    // Keep each topic's share; extras fill topics that fell short, heaviest first.
    let mut chosen: Vec<usize> = vec![];
    for (t, n) in &target {
        let mine: Vec<usize> = (0..kept.len()).filter(|&i| kept[i].topic.as_deref().unwrap_or("") == t.id).take(*n).collect();
        chosen.extend(mine);
    }
    if chosen.len() < ask.count {
        let mut spare: Vec<usize> = (0..kept.len()).filter(|i| !chosen.contains(i)).collect();
        let weight = |i: usize| target.iter().find(|(t, _)| Some(t.id.as_str()) == kept[i].topic.as_deref()).map_or(0.0, |(t, _)| t.weight);
        spare.sort_by(|&a, &b| weight(b).total_cmp(&weight(a)));
        chosen.extend(spare.into_iter().take(ask.count - chosen.len()));
    }
    // In the course's order, then as written.
    let order: HashMap<String, usize> = target.iter().enumerate().map(|(i, (t, _))| (t.id.clone(), i)).collect();
    chosen.sort_by_key(|&i| (order.get(kept[i].topic.as_deref().unwrap_or("")).copied().unwrap_or(0), i));
    let topic_label: HashMap<String, String> = target.iter().filter(|(t, _)| !t.id.is_empty()).map(|(t, _)| (t.id.clone(), format!("{}{}", t.title, t.sections.as_deref().map(|x| format!(" ({x})")).unwrap_or_default()))).collect();
    let mut items = vec![];
    let mut per_topic: HashMap<String, usize> = HashMap::new();
    for &i in &chosen {
        let c = &kept[i];
        *per_topic.entry(c.topic.clone().unwrap_or_default()).or_default() += 1;
        items.push(match &c.item {
            Item::Q(q) => {
                let mut q = q.clone();
                q.id = format!("q{}", items.len() + 1);
                q.topic = c.topic.as_ref().and_then(|t| topic_label.get(t).cloned());
                q.citations = c.cites.clone();
                generate::shuffle_choices(&mut q, &mut seed);
                Item::Q(q)
            }
            Item::N(n) => Item::N(n.clone()),
        });
    }
    if items.is_empty() {
        let why: Vec<String> = dropped.iter().filter(|d| !d.why.is_empty()).take(3).map(|d| d.why.clone()).collect();
        return Err(format!(
            "Nothing passed the check against your notes, so nothing was saved{}. Try a different focus, or check the course was imported whole.",
            if why.is_empty() { String::new() } else { format!(" ({})", why.join("; ")) }
        ));
    }
    let noun = if matches!(want, Want::Quiz { .. }) { ("question", "questions") } else { ("card", "cards") };
    let mut notes = s.notes.clone();
    if items.len() < ask.count {
        notes.push(format!(
            "Only {} of the {} {} you asked for passed the check against your notes, so there are {}. The rest weren’t padded with others: {} were dropped, mostly because {}.",
            items.len(),
            ask.count,
            noun.1,
            items.len(),
            dropped.len(),
            most_common_why(&dropped)
        ));
    }
    let coverage: Vec<Coverage> = s.plan.iter().map(|(t, n)| {
        let count = per_topic.get(&t.id).copied().unwrap_or(0);
        let why = (count == 0).then(|| if *n == 0 {
            format!("fewer {} than topics: one near it in the course, which it leans on more, got it", noun.1)
        } else {
            match dropped.iter().find(|d| kept.iter().all(|k| k.item.text() != d.text) && !d.why.is_empty()) {
                Some(_) => format!("its {} didn’t pass the check", noun.1),
                None => format!("no {} on it could be written from your notes", noun.0),
            }
        });
        Coverage { topic: t.title.clone(), sections: t.sections.clone(), count, why }
    }).collect();
    let grounding = Grounding {
        exam: s.exam.as_ref().map(|e| e.title.clone()),
        scope: s.exam.as_ref().map(|e| scope::scope_words(e).split_once(": ").map_or(String::new(), |(_, w)| w.to_string())),
        from_user: s.exam.as_ref().is_some_and(|e| e.from_user),
        evidence: s.exam.as_ref().map(|e| e.evidence.clone()).unwrap_or_default(),
        asked: ask.count,
        kept: items.len(),
        dropped: dropped.into_iter().filter(|d| !d.text.is_empty() || !d.why.is_empty()).collect(),
        coverage,
        notes,
    };
    Ok(Made { title, items, grounding, material })
}

fn most_common_why(dropped: &[Dropped]) -> String {
    let mut counts: Vec<(String, usize)> = vec![];
    for d in dropped {
        let key = if d.why.contains("isn’t in") && d.why.contains("quote") {
            "their quotes weren’t in the files they named".to_string()
        } else if d.why.contains("scope") {
            "they were outside the scope".to_string()
        } else if d.why.contains("not taught") || d.why.contains("confirm") || d.why.contains("check") {
            "they needed ideas your notes don’t teach".to_string()
        } else {
            "they weren’t well formed".to_string()
        };
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => counts.push((key, 1)),
        }
    }
    counts.sort_by_key(|c| std::cmp::Reverse(c.1));
    counts.first().map_or("they didn’t pass".into(), |(k, _)| k.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_the_course_never_uses_are_picked_out() {
        let mut vocab = HashSet::new();
        sources::words_of("A function is injective when no two inputs share an output. Functions on sets: the image of a set.", &mut vocab);
        let w = unknown_words("Which statement about the preimage $f^{-1}(B)$ of an injective \\mathbb{R} function is true?", &vocab);
        assert_eq!(w, ["preimage"], "LaTeX commands and common quiz words aren't counted; plurals and the course's own words are known");
        assert!(unknown_words("Functions and images", &vocab).is_empty());
    }

    #[test]
    fn sections_are_read_as_ranges() {
        assert_eq!(section_numbers(Some("3.8–3.13")), ["3.8", "3.9", "3.10", "3.11", "3.12", "3.13"]);
        assert_eq!(section_numbers(Some("5.4")), ["5.4"]);
        assert_eq!(section_numbers(Some("Chapter 2")), Vec::<String>::new());
        assert!(is_logistics("courses/C/announcements.md") && is_logistics("courses/C/files/Syllabus - C241.pdf") && !is_logistics("courses/C/files/Notes.pdf"));
    }

    #[test]
    fn a_question_may_quote_a_page_read_from_its_picture_only_once_that_picture_was_shown() {
        let label = "courses/C/files/Week 4.pdf";
        let text = format!("## Page 1\n\nTyped: a set is a collection of distinct objects.\n\n## Page 2 {}\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R", crate::lms::text::RECOGNISED);
        let files = [CourseFile { label: label.into(), sub: Default::default(), text, size: 0, modified: 0 }];
        let visible = Visible::default();
        let lib = Library::new(Path::new("/nonexistent"), &visible, &files);
        let q = "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R";
        assert!(lib.check(label, q).unwrap_err().contains("isn’t in Week 4.pdf"), "not shown: the check is exact");
        lib.shown(&[(label.to_string(), 1)]);
        assert!(lib.check(label, q).is_err(), "shown page 1, not the page it is on");
        lib.shown(&[(label.to_string(), 2)]);
        let (ev, passage) = lib.check(label, q).unwrap();
        assert_eq!((ev.picture, ev.at.as_deref()), (Some(2), Some("p. 2")));
        assert!(passage.contains("read from the picture of the page") && passage.contains("(a,a) e R"), "the checker sees what recognition read: {passage}");
        // Typed text on a page shown as a picture still has to be word for word.
        let (typed, _) = lib.check(label, "a set is a collection of distinct objects").unwrap();
        assert_eq!(typed.picture, None);
        assert!(lib.check(label, "a set is a colection of distinct objects, as typed").is_err(), "page 1 wasn't read from a picture");
    }
}
