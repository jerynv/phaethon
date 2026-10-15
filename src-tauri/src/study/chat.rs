//! A quiz or deck offered in a chat reply. The assistant describes what it
//! will make in prose and ends its reply with a ```phaethon-study block (a
//! small JSON object); the reply shows it as a card with a Generate button.
//! Everything in the block is checked here (the webview only shows it): the
//! kind, bounds on every number and text, known question kinds, and sources
//! the space may read. Generating goes through generate.rs with the
//! conversation as context, and is recorded by the block's origin, so a
//! second click (or the same card after a reload) opens what was made
//! instead of making another.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::generate::{self, CARDS_MAX, DeckOptions, Emit, QUESTIONS_MAX, QuizOptions};
use super::grounded::Grounding;
use super::model::Model;
use super::quiz;
use super::sources;
use crate::lms::access::Visible;
use crate::lms::names;

/// The code block's language.
pub const FENCE: &str = "phaethon-study";
/// Largest block read.
const FENCE_MAX: usize = 8 * 1024;
const TITLE_MAX: usize = 120;
const FOCUS_MAX: usize = 300;
const SOURCES_MAX: usize = 20;
const SOURCE_MAX: usize = 500;
/// The question and the reply sent along as context, at most.
const QUESTION_MAX: usize = 3_000;
const REPLY_MAX: usize = 6_000;
/// Where what was made from chat is recorded: origin -> path.
const MADE: &str = ".phaethon/study/from-chat.json";
const MADE_KEEP: usize = 500;

/// What the assistant is taught, for every backend's prompt.
pub const PROMPT: &str = r#"# A quiz or flashcards from the chat

When creating new study material, never write practice questions, a practice test, quiz questions or flashcards in the chat yourself, not even one or two as examples: Phaethon makes them, checking every one against the course's own notes and the exam's scope, and you can't. When the user asks to create any of these, reply in a few short sentences of prose: what it will cover, which course material it draws on (by name), how many questions or cards, and which kinds of question. Everything Phaethon makes comes only from the course's own material (its files, syllabus, assignments, announcements and the readings it assigns) and what the user says it covers, so don't promise topics the course hasn't covered or an exam's coverage you haven't seen in its materials. Then end the reply with exactly one block like this, with nothing after it:

```phaethon-study
{"kind": "quiz", "title": "Test 1 practice", "exam": "Test 1", "focus": "", "count": 10, "kinds": ["choice", "truefalse", "short"], "difficulty": "exam", "sources": ["courses/<course folder>"]}
```

Reviewing existing study material is allowed directly in chat. When the user asks to review a completed quiz or explain a missed item, read the saved attempt and the quiz it names. Phaethon's own assistant can call study_attempt to find and read an attempt. Reproduce the original question and its answer choices on request, identify their selected answer and the correct answer, and explain the reasoning using the course material. Do not generate a new quiz or a study block unless the user asks for one.

The user sees it as a button; pressing it makes the quiz from that material and opens it in Study. "kind" is "quiz" or "deck" (flashcards). "exam" names the exam it is for, as the course names it ("Test 1", "Midterm 2", "Final"), when it is for one: only that exam's scope is used, and if Phaethon can't find what the exam covers it asks the user. "count" is 1 to 50 questions, or 1 to 100 cards. For a quiz, "kinds" are some of choice, multi, truefalse, short, cloze, and "difficulty" is easier, exam or harder. "focus" names topics to narrow to, in a few words, or is empty. "sources" are the course folders (courses/<folder>) or files to draw on, as paths in this space; leave it empty for all of the user's courses. Use the block only when the user wants a quiz or flashcards made. To change one, reply with a new block."#;

/// [`PROMPT`], then the space's tutor mode if it has one (last: it shapes every answer).
pub fn with_prompt(mode: Option<&str>) -> String {
    match mode {
        Some(m) => format!("{PROMPT}\n\n{m}"),
        None => PROMPT.to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Quiz,
    Deck,
}

/// A block, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    pub kind: Kind,
    pub title: Option<String>,
    pub focus: Option<String>,
    pub count: usize,
    pub kinds: Vec<String>,
    pub difficulty: String,
    pub sources: Vec<String>,
    /// The exam it is for, as the course names it.
    pub exam: Option<String>,
    /// What was changed to fit (in plain words).
    pub notes: Vec<String>,
}

fn text_field(v: &Value, keys: &[&str], max: usize, what: &str) -> Result<Option<String>, String> {
    for k in keys {
        match v.get(*k) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) => {
                let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
                if s.chars().count() > max {
                    return Err(format!("its {what} is too long (over {max} characters)"));
                }
                return Ok(Some(s).filter(|s| !s.is_empty()));
            }
            Some(_) => return Err(format!("its {what} isn’t text")),
        }
    }
    Ok(None)
}

fn list_field(v: &Value, keys: &[&str], max_items: usize, what: &str) -> Result<Vec<String>, String> {
    for k in keys {
        match v.get(*k) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) => return Ok(vec![s.trim().to_string()].into_iter().filter(|s| !s.is_empty()).collect()),
            Some(Value::Array(a)) => {
                if a.len() > max_items {
                    return Err(format!("it lists too many {what} (over {max_items})"));
                }
                let mut out = vec![];
                for x in a {
                    let s = x.as_str().ok_or_else(|| format!("its {what} aren’t all text"))?.trim().to_string();
                    if s.chars().count() > SOURCE_MAX {
                        return Err(format!("one of its {what} is too long"));
                    }
                    if !s.is_empty() && !out.contains(&s) {
                        out.push(s);
                    }
                }
                return Ok(out);
            }
            Some(_) => return Err(format!("its {what} aren’t a list")),
        }
    }
    Ok(vec![])
}

/// Read and check a block's JSON. `Err` says what is wrong, in words for the person.
pub fn parse(block: &str) -> Result<Action, String> {
    if block.len() > FENCE_MAX {
        return Err("The plan is too long to read.".into());
    }
    let v: Value = serde_json::from_str(block.trim()).map_err(|_| "The plan isn’t written in a form Phaethon can read.".to_string())?;
    if !v.is_object() {
        return Err("The plan isn’t written in a form Phaethon can read.".into());
    }
    let bad = |why: String| format!("The plan can’t be used: {why}.");
    let kind = match v.get("kind").and_then(Value::as_str).map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("quiz") => Kind::Quiz,
        Some("deck" | "flashcards" | "cards") => Kind::Deck,
        Some(other) => return Err(bad(format!("“{other}” isn’t a quiz or flashcards"))),
        None => return Err(bad("it doesn’t say whether it is a quiz or flashcards".into())),
    };
    let mut notes = vec![];
    let (max, default, noun) = match kind {
        Kind::Quiz => (QUESTIONS_MAX, 10, "questions"),
        Kind::Deck => (CARDS_MAX, 20, "cards"),
    };
    let count = match v.get("count") {
        None | Some(Value::Null) => default,
        Some(n) => {
            let n = n.as_f64().or_else(|| n.as_str().and_then(|s| s.trim().parse().ok())).ok_or_else(|| bad("its count isn’t a number".into()))?;
            if !n.is_finite() || n < 1.0 || n.fract() != 0.0 {
                return Err(bad("its count must be a whole number, at least 1".into()));
            }
            if n > max as f64 {
                notes.push(format!("At most {max} {noun} are made at once, so this makes {max}."));
                max
            } else {
                n as usize
            }
        }
    };
    let title = text_field(&v, &["title"], TITLE_MAX, "title")?;
    let focus = text_field(&v, &["focus", "topic", "topics"], FOCUS_MAX, "focus")?;
    let sources = list_field(&v, &["sources", "source"], SOURCES_MAX, "sources")?;
    let mut kinds = vec![];
    let mut difficulty = "exam".to_string();
    if kind == Kind::Quiz {
        for k in list_field(&v, &["kinds", "questionKinds", "types", "questionTypes"], 10, "kinds of question")? {
            let said = k.clone();
            let k = k.to_ascii_lowercase().replace(['-', '_', ' ', '/'], "");
            let k = match k.as_str() {
                "choice" | "multiplechoice" | "mcq" => "choice",
                "multi" | "multiselect" | "selectall" => "multi",
                "truefalse" | "tf" => "truefalse",
                "short" | "shortanswer" => "short",
                "cloze" | "fillin" | "fillintheblank" => "cloze",
                _ => {
                    notes.push(format!("“{said}” isn’t a kind of question Phaethon makes, so it’s left out."));
                    continue;
                }
            };
            if !kinds.iter().any(|x| x == k) {
                kinds.push(k.to_string());
            }
        }
        if kinds.is_empty() {
            kinds = ["choice", "truefalse", "short"].map(String::from).to_vec();
        }
        debug_assert!(kinds.iter().all(|k| quiz::KINDS.contains(&k.as_str())));
        if let Some(d) = text_field(&v, &["difficulty", "level"], 20, "difficulty")? {
            match d.to_ascii_lowercase().as_str() {
                "easier" | "easy" => difficulty = "easier".into(),
                "exam" | "medium" | "normal" | "mixed" => difficulty = "exam".into(),
                "harder" | "hard" => difficulty = "harder".into(),
                _ => notes.push(format!("“{d}” isn’t a difficulty, so it’s at exam level.")),
            }
        }
    }
    let exam = text_field(&v, &["exam", "test"], 80, "exam")?;
    Ok(Action { kind, title, focus, count, kinds, difficulty, sources, exam, notes })
}

/// A short, stable name for a block in its conversation: the question it
/// answers and the block itself, whitespace aside (FNV-1a, 64 bits).
pub fn origin(question: &str, block: &str) -> String {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in norm(question).bytes().chain([0u8]).chain(norm(block).bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// A source the plan will read, and how it's said.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSource {
    pub path: String,
    pub name: String,
}

/// What the card shows: the block checked and its sources resolved.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub origin: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    pub count: usize,
    pub kinds: Vec<String>,
    pub difficulty: String,
    pub sources: Vec<PlanSource>,
    /// Sources named that aren't in this space (or that it may not read).
    pub unknown: Vec<String>,
    pub notes: Vec<String>,
    /// What was already made from it, if it still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub made: Option<String>,
    /// Being made right now.
    pub running: bool,
    /// The exam it is for, as the block names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exam: Option<String>,
    /// What is known so far about that exam's scope (from the kept map; nothing is built here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<PlanScope>,
    /// Said when the material leans on pages the space's model can't look at (handwriting, diagrams).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material: Option<crate::vision::Alert>,
}

/// An exam's scope as the card shows it before anything is made.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanScope {
    /// The exam as the course names it.
    pub exam: String,
    /// "known" (found or said), "unknown" (looked, not found), "unmapped" (not looked yet).
    pub state: &'static str,
    /// "through HW 6; not graphs or combinatorics"
    #[serde(skip_serializing_if = "String::is_empty")]
    pub words: String,
    pub from_user: bool,
    pub evidence: Vec<super::scope::Evidence>,
    /// "courses/<folder>", to say what it covers.
    pub course: String,
    pub course_name: String,
}

/// What the kept map (and the person's word) say about `exam` in the plan's course.
fn plan_scope(space: &Path, visible: &Visible, sources: &[PlanSource], exam: &str) -> Option<PlanScope> {
    let inputs: Vec<String> = sources.iter().map(|s| s.path.clone()).collect();
    let seen = sources::course_of(space, visible, &inputs)?;
    let base = |state, words: String, from_user, evidence, exam: String| PlanScope { exam, state, words, from_user, evidence, course: format!("courses/{}", seen.folder()), course_name: seen.state.name.clone() };
    let said = super::scope::stated(visible, seen);
    let probe = |e: &str| super::scope::find_exam(std::slice::from_ref(&super::scope::ExamScope { title: e.to_string(), date: None, known: false, summary: String::new(), includes: vec![], excludes: vec![], excluded_words: vec![], homework: vec![], evidence: vec![], from_user: false }), exam).is_some();
    if let Some(s) = said.iter().find(|s| probe(&s.exam)) {
        return Some(base("known", s.text.clone(), true, vec![super::scope::Evidence { source: super::scope::FROM_YOU.into(), quote: s.text.clone(), ..Default::default() }], s.exam.clone()));
    }
    let Some((map, _)) = super::scope::cached(visible, seen, None) else {
        return Some(base("unmapped", String::new(), false, vec![], exam.to_string()));
    };
    Some(match super::scope::find_exam(&map.exams, exam) {
        Some(e) if e.known => base("known", super::scope::scope_words(e).split_once(": ").map_or(String::new(), |(_, w)| w.to_string()), false, e.evidence.clone(), e.title.clone()),
        Some(e) => base("unknown", String::new(), false, vec![], e.title.clone()),
        None => base("unknown", String::new(), false, vec![], exam.to_string()),
    })
}

/// The course a name points to: its folder, its name or its code, ignoring
/// case and spaces ("M301", "MATH-M 301", "courses/MATH-M 301 Fall 2026/").
fn course_by_name<'a>(list: &'a [sources::CourseSource], raw: &str) -> Option<&'a sources::CourseSource> {
    let squash = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = squash(raw.trim().trim_end_matches('/').trim_start_matches("courses/"));
    if want.len() < 3 {
        return None;
    }
    let exact = list.iter().find(|c| squash(c.folder.trim_start_matches("courses/")) == want || squash(&c.name) == want);
    if exact.is_some() {
        return exact;
    }
    // "M301" is in "mathm301fall2026": a name, folder or code contained either way, when only one course fits.
    let hits: Vec<_> = list.iter().filter(|c| squash(&c.name).contains(&want) || squash(&c.folder).contains(&want) || want.contains(&squash(&c.name))).collect();
    (hits.len() == 1).then(|| hits[0])
}

/// `raw` as a path in the space: absolute paths into the space or its
/// courses become relative; anything else is kept for `resolve` to check.
fn relative(space: &Path, visible: &Visible, raw: &str) -> String {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return raw.trim_start_matches("./").to_string();
    }
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let space_c = space.canonicalize().unwrap_or_else(|_| space.to_path_buf());
    if let Ok(rest) = canon.strip_prefix(&space_c) {
        return rest.to_string_lossy().replace('\\', "/");
    }
    for seen in &visible.courses {
        if let Some(dir) = visible.dir_of(seen)
            && let Ok(rest) = canon.strip_prefix(&dir)
        {
            let rest = rest.to_string_lossy().replace('\\', "/");
            return if rest.is_empty() { format!("courses/{}", seen.folder()) } else { format!("courses/{}/{rest}", seen.folder()) };
        }
    }
    raw.to_string()
}

fn file_name(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}

/// The sources the plan names, resolved against what the space may read:
/// (usable, unknown). None named: every course the space sees, or (with one
/// course) that course.
pub fn resolve_sources(space: &Path, visible: &Visible, raw: &[String]) -> (Vec<PlanSource>, Vec<String>) {
    let list = sources::courses(visible);
    let course_name = |folder: &str| list.iter().find(|c| c.folder == folder).map(|c| c.name.clone()).unwrap_or_else(|| folder.trim_start_matches("courses/").to_string());
    let (mut ok, mut unknown): (Vec<PlanSource>, Vec<String>) = (vec![], vec![]);
    let mut push = |s: PlanSource| {
        if !ok.iter().any(|o| o.path == s.path) {
            ok.push(s);
        }
    };
    for r in raw {
        let rel = relative(space, visible, r.trim());
        let rel = rel.trim_end_matches('/');
        match sources::resolve(space, visible, rel) {
            Ok(sources::Source::Courses) => push(PlanSource { path: "courses".into(), name: "all your courses".into() }),
            Ok(sources::Source::Course { seen, sub, .. }) => {
                let folder = format!("courses/{}", seen.folder());
                let name = course_name(&folder);
                if sub.as_os_str().is_empty() {
                    push(PlanSource { path: folder, name });
                } else {
                    let path = format!("{folder}/{}", sub.to_string_lossy().replace('\\', "/"));
                    push(PlanSource { name: format!("{} ({name})", file_name(&path)), path });
                }
            }
            Ok(sources::Source::Local(_)) if !rel.is_empty() && rel != "." => push(PlanSource { path: rel.to_string(), name: file_name(rel).to_string() }),
            _ => match course_by_name(&list, r) {
                Some(c) => push(PlanSource { path: c.folder.clone(), name: c.name.clone() }),
                None => unknown.push(r.trim().to_string()),
            },
        }
    }
    if ok.is_empty() && unknown.is_empty() {
        match list.len() {
            0 => {}
            1 => ok.push(PlanSource { path: list[0].folder.clone(), name: list[0].name.clone() }),
            _ => ok.push(PlanSource { path: "courses".into(), name: "all your courses".into() }),
        }
    }
    (ok, unknown)
}

// ---- What was made, and what is being made ---------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct Made {
    #[serde(default)]
    made: Vec<MadeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MadeEntry {
    origin: String,
    path: String,
    at: u64,
}

fn load_made(space: &Path) -> Made {
    super::plain_file(space, MADE).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The deck or quiz made from `origin`, if its file is still there.
pub fn made(space: &Path, origin: &str) -> Option<String> {
    let entry = load_made(space).made.into_iter().rev().find(|e| e.origin == origin)?;
    let item = if entry.path.starts_with(super::DECKS) { super::Item::Deck } else { super::Item::Quiz };
    let rel = super::check_path(&entry.path, item).ok()?;
    super::plain_file(space, &rel).map(|_| rel)
}

static MADE_LOCK: Mutex<()> = Mutex::new(());

fn record(space: &Path, origin: &str, path: &str, now: u64) -> Result<(), String> {
    let _g = MADE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut m = load_made(space);
    m.made.retain(|e| e.origin != origin);
    m.made.push(MadeEntry { origin: origin.into(), path: path.into(), at: now });
    if m.made.len() > MADE_KEEP {
        let cut = m.made.len() - MADE_KEEP;
        m.made.drain(..cut);
    }
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    names::write(space, Path::new(MADE), text.as_bytes()).map_err(|e| format!("It was made, but couldn’t be noted: {e}"))
}

type RunMap = HashMap<String, tokio::sync::watch::Sender<bool>>;
static RUNS: Mutex<Option<RunMap>> = Mutex::new(None);

fn run_key(space: &Path, origin: &str) -> String {
    format!("{}\n{origin}", space.display())
}

/// One plan being made; dropping it lets the plan be made again.
pub struct Run {
    key: String,
    cancel: tokio::sync::watch::Receiver<bool>,
}

impl Run {
    /// `None` when this plan is already being made.
    pub fn claim(space: &Path, origin: &str) -> Option<Run> {
        let key = run_key(space, origin);
        let mut g = RUNS.lock().unwrap_or_else(|p| p.into_inner());
        let map = g.get_or_insert_with(HashMap::new);
        if map.contains_key(&key) {
            return None;
        }
        let (tx, rx) = tokio::sync::watch::channel(false);
        map.insert(key.clone(), tx);
        Some(Run { key, cancel: rx })
    }

    /// Resolves when the person stops it.
    pub async fn cancelled(&mut self) {
        while !*self.cancel.borrow() {
            if self.cancel.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let mut g = RUNS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(map) = g.as_mut() {
            map.remove(&self.key);
        }
    }
}

pub fn running(space: &Path, origin: &str) -> bool {
    RUNS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|m| m.contains_key(&run_key(space, origin)))
}

/// Stop making a plan. False when it wasn't being made.
pub fn cancel(space: &Path, origin: &str) -> bool {
    let g = RUNS.lock().unwrap_or_else(|p| p.into_inner());
    match g.as_ref().and_then(|m| m.get(&run_key(space, origin))) {
        Some(tx) => {
            let _ = tx.send(true);
            true
        }
        None => false,
    }
}

// ---- The plan, and making it ---------------------------------------------------------

/// Check a block and say what it will make. `Err` for a block that can't be used.
pub fn plan(space: &Path, visible: &Visible, block: &str, question: &str) -> Result<Plan, String> {
    let a = parse(block)?;
    let origin = origin(question, block);
    let (sources, unknown) = resolve_sources(space, visible, &a.sources);
    if sources.is_empty() {
        return Err(if unknown.is_empty() {
            "There’s no course material in this space to make it from. Import a course first, or ask about files in this space.".into()
        } else {
            format!("None of what it names is in this space or its courses: {}.", unknown.join(", "))
        });
    }
    let scope = a.exam.as_deref().and_then(|e| plan_scope(space, visible, &sources, e));
    Ok(Plan {
        made: made(space, &origin),
        running: running(space, &origin),
        origin,
        kind: a.kind,
        title: a.title,
        focus: a.focus,
        count: a.count,
        kinds: a.kinds,
        difficulty: a.difficulty,
        sources,
        unknown,
        notes: a.notes,
        exam: a.exam,
        scope,
        material: None,
    })
}

/// What to tell the person before making `plan` when its material leans on
/// pages their model (`sight`) can't look at: the exam's share when the plan
/// is for one, else the course's.
pub fn material_alert(space: &Path, visible: &Visible, plan: &Plan, sight: &crate::vision::Sight) -> Option<crate::vision::Alert> {
    let inputs: Vec<String> = plan.sources.iter().map(|s| s.path.clone()).collect();
    let seen = sources::course_of(space, visible, &inputs)?;
    let report = super::material::report_of(seen)?;
    let map = super::scope::cached(visible, seen, None).map(|(m, _)| m);
    let exam = plan.exam.as_deref().and_then(|e| map.as_ref().and_then(|m| super::scope::find_exam(&m.exams, e).cloned()));
    let pages = super::material::exam_pages(report, seen.folder(), map.as_ref(), exam.as_ref());
    let of = match &exam {
        Some(e) if e.known => format!("{}’s material", e.title),
        _ => "this course".to_string(),
    };
    crate::vision::alert(pages, &of, sight)
}

fn cut(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str(" […]");
    out
}

/// The reply without its plan block (and any other fenced code), for context.
pub fn prose(reply: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in reply.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

/// The conversation as the generator sees it.
pub fn context(question: &str, reply: &str) -> Option<String> {
    let (q, r) = (cut(question, QUESTION_MAX), cut(&prose(reply), REPLY_MAX));
    if q.is_empty() && r.is_empty() {
        return None;
    }
    Some(format!("The student asked:\n{q}\n\nTheir assistant answered, promising this:\n{r}"))
}

/// Make what `plan` describes, and record it by its origin. A plan already
/// made gives back what was made, without asking the model again.
#[allow(clippy::too_many_arguments)] // one plan's inputs, each needed
pub async fn make<M: Model>(space: &Path, visible: &Visible, plan: &Plan, question: &str, reply: &str, model: &M, emit: Emit<'_>, now: u64) -> Result<(String, usize, Option<Grounding>), String> {
    if let Some(path) = made(space, &plan.origin) {
        return Ok((path, 0, None));
    }
    let inputs: Vec<String> = plan.sources.iter().map(|s| s.path.clone()).collect();
    let ctx = context(question, reply);
    let (path, n, grounding) = match plan.kind {
        Kind::Quiz => {
            let opts = QuizOptions {
                count: plan.count,
                kinds: plan.kinds.clone(),
                difficulty: Some(plan.difficulty.clone()),
                focus: plan.focus.clone(),
                title: plan.title.clone(),
                context: ctx,
                exam: plan.exam.clone(),
            };
            generate::make_quiz(space, visible, &inputs, &opts, model, emit, now).await?
        }
        Kind::Deck => {
            let opts = DeckOptions { count: plan.count, focus: plan.focus.clone(), title: plan.title.clone(), from_attempt: None, context: ctx, exam: plan.exam.clone() };
            generate::make_deck(space, visible, &inputs, &opts, model, emit, now).await?
        }
    };
    record(space, &plan.origin, &path, now)?;
    Ok((path, n, Some(grounding)))
}

/// Where the space's record of chat-made items is (for tests).
#[cfg(test)]
pub fn made_file(space: &Path) -> std::path::PathBuf {
    space.join(MADE)
}

#[cfg(test)]
mod tests {
    use super::super::generate::StudyEvent;
    use super::super::model::tests::Scripted;
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn space(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-study-chat-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let c = dir.join("courses/MATH-M 301 Fall 2026/files");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("Eigen notes.pdf"), "%PDF").unwrap();
        fs::write(
            c.join("Eigen notes.pdf.md"),
            "# Text of Eigen notes.pdf\n\nAn eigenvector of A is a nonzero vector v with Av = λv; λ is its eigenvalue.\nThe eigenvalues are the roots of det(A − λI) = 0.\nA 2×2 matrix with two distinct eigenvalues is diagonalizable.",
        )
        .unwrap();
        crate::lms::access::fixture(&dir, "s", &[("MATH-M 301 Fall 2026", &crate::lms::access::Part::ALL)]);
        dir.join("spaces/s").canonicalize().unwrap()
    }

    fn vis(space: &Path) -> Visible {
        crate::lms::access::visible(&crate::vault::Vault::at(space.parent().unwrap().parent().unwrap()), "s")
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_block_is_read_strictly_and_bounded() {
        let a = parse(r#"{"kind":"quiz","title":"Eigen  practice","focus":"eigenvalues","count":12,"kinds":["choice","True/False","essay"],"difficulty":"hard","sources":["courses/X","courses/X"]}"#).unwrap();
        assert_eq!((a.kind, a.count, a.difficulty.as_str()), (Kind::Quiz, 12, "harder"));
        assert_eq!(a.title.as_deref(), Some("Eigen practice"));
        assert_eq!(a.kinds, ["choice", "truefalse"]);
        assert!(a.notes.iter().any(|n| n.contains("essay")), "an unknown kind is said, not used");
        assert_eq!(a.sources, ["courses/X"], "repeats dropped");

        let a = parse(r#"{"kind":"quiz","count":500}"#).unwrap();
        assert_eq!(a.count, QUESTIONS_MAX);
        assert!(a.notes[0].contains("At most 50"));
        assert_eq!(a.kinds, ["choice", "truefalse", "short"], "no kinds: the usual mix");
        assert_eq!(parse(r#"{"kind":"flashcards"}"#).unwrap().count, 20);
        assert_eq!(parse(r#"{"kind":"deck","count":"7"}"#).unwrap().count, 7);
        assert_eq!(parse(r#"{"kind":"deck","count":9999}"#).unwrap().count, CARDS_MAX);

        for bad in [
            "",
            "{",
            "[1]",
            r#""quiz""#,
            r#"{"count": 3}"#,
            r#"{"kind":"essay"}"#,
            r#"{"kind":"quiz","count":0}"#,
            r#"{"kind":"quiz","count":2.5}"#,
            r#"{"kind":"quiz","count":-1}"#,
            r#"{"kind":"quiz","count":true}"#,
            r#"{"kind":"quiz","title":7}"#,
            r#"{"kind":"quiz","sources":{"a":1}}"#,
            r#"{"kind":"quiz","sources":[1,2]}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let long = format!(r#"{{"kind":"quiz","title":"{}"}}"#, "x".repeat(200));
        assert!(parse(&long).unwrap_err().contains("too long"));
        let many = format!(r#"{{"kind":"quiz","sources":[{}]}}"#, (0..30).map(|i| format!("\"s{i}\"")).collect::<Vec<_>>().join(","));
        assert!(parse(&many).unwrap_err().contains("too many"));
        assert!(parse(&"x".repeat(FENCE_MAX + 1)).is_err());
    }

    #[test]
    fn the_origin_ignores_whitespace_only() {
        let a = origin("Quiz me on eigenvalues", "{\"kind\": \"quiz\"}");
        assert_eq!(a, origin("Quiz me on  eigenvalues\n", "{\"kind\":  \"quiz\"}\n"));
        assert_ne!(a, origin("Quiz me on matrices", "{\"kind\": \"quiz\"}"));
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn sources_are_resolved_within_what_the_space_sees() {
        let dir = space("src");
        let v = vis(&dir);
        let folder = "courses/MATH-M 301 Fall 2026";
        // By folder, by course code, by a file in it, and by an absolute path to it.
        for raw in [folder, "MATH-M 301", "M301", "courses/MATH-M 301 Fall 2026/"] {
            let (ok, unknown) = resolve_sources(&dir, &v, &[raw.to_string()]);
            assert_eq!((ok.len(), unknown.len()), (1, 0), "{raw}");
            assert_eq!(ok[0].path, folder, "{raw}");
        }
        let file = format!("{folder}/files/Eigen notes.pdf");
        let (ok, _) = resolve_sources(&dir, &v, std::slice::from_ref(&file));
        assert_eq!(ok[0].path, file);
        assert_eq!(ok[0].name, "Eigen notes.pdf (MATH-M 301 Fall 2026)");
        let abs = v.dir_of(&v.courses[0]).unwrap().join("files/Eigen notes.pdf");
        let (ok, _) = resolve_sources(&dir, &v, &[abs.to_string_lossy().into_owned()]);
        assert_eq!(ok[0].path, file, "an absolute path from a CLI becomes the space's path");
        // Unknown names, other places and escapes are said, never read, and never swapped for another course.
        let (ok, unknown) = resolve_sources(&dir, &v, &["CHEM 101".into(), "../../etc/passwd".into(), "/etc/hosts".into(), "courses/Secret".into()]);
        assert_eq!(unknown.len(), 4);
        assert!(ok.is_empty());
        assert!(plan(&dir, &v, r#"{"kind":"quiz","sources":["CHEM 101"]}"#, "q").unwrap_err().contains("CHEM 101"), "named but not here: nothing is made");
        // Nothing named: the space's course.
        let (ok, _) = resolve_sources(&dir, &v, &[]);
        assert_eq!(ok[0].path, folder);
        // A space that sees no courses has nothing to make it from.
        let none = Visible::default();
        let err = plan(&dir, &none, r#"{"kind":"quiz","sources":["CHEM 101"]}"#, "q").unwrap_err();
        assert!(err.contains("CHEM 101"), "{err}");
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    const BLOCK: &str = r#"{"kind":"quiz","title":"Eigen practice","focus":"eigenvalues","count":2,"kinds":["choice","truefalse"],"sources":["M301"]}"#;

    const EV: &str = "An eigenvector of A is a nonzero vector v with Av = λv; λ is its eigenvalue.";
    const ROOTS: &str = "The eigenvalues are the roots of det(A − λI) = 0.";

    fn map_reply(src: &str) -> String {
        format!(r#"{{"topics": [{{"id": "t1", "title": "Eigenvalues and eigenvectors", "terms": ["eigenvalue", "eigenvector"], "weight": 3, "evidence": [{{"source": "{src}", "quote": "{EV}"}}]}}, {{"id": "t2", "title": "Diagonalization", "terms": ["diagonalizable"], "evidence": [{{"source": "{src}", "quote": "A 2×2 matrix with two distinct eigenvalues is diagonalizable."}}]}}], "exams": []}}"#)
    }

    fn reply(src: &str) -> String {
        format!(
            r#"{{"title":"x","questions":[
{{"topic":"t1","kind":"choice","prompt":"Which $\\lambda$ are eigenvalues of $A$?","choices":["Roots of $\\det(A-\\lambda I)=0$","Entries on any row","Columns of $A$","Pivots of $A^T$"],"answer":"Roots of $\\det(A-\\lambda I)=0$","explanation":"Av = λv with v ≠ 0 needs A − λI singular.","citations":[{{"source":"{src}","quote":"{ROOTS}"}}]}},
{{"topic":"t1","kind":"truefalse","prompt":"An eigenvector may be the zero vector.","answer":"false","explanation":"Eigenvectors are nonzero by definition.","citations":[{{"source":"{src}","quote":"{EV}"}}]}}
]}}"#
        )
    }

    const YES2: &str = r#"{"verdicts": [{"id": "i1", "verdict": "yes", "answerOk": true}, {"id": "i2", "verdict": "yes", "answerOk": true}]}"#;

    #[test]
    fn a_plan_is_made_once_with_the_conversation_and_opened_again_after() {
        let dir = space("make");
        let v = vis(&dir);
        let question = "Can you quiz me on eigenvalues for M301?";
        let answer = format!("I'll make 2 questions on eigenvalues from your M301 notes.\n\n```phaethon-study\n{BLOCK}\n```");
        let p = plan(&dir, &v, BLOCK, question).unwrap();
        assert_eq!((p.made.as_deref(), p.running, p.sources[0].name.as_str()), (None, false, "MATH-M 301 Fall 2026"));
        assert_eq!((p.exam.as_deref(), p.scope.as_ref()), (None, None));
        let with_exam = plan(&dir, &v, &BLOCK.replace("\"count\":2", "\"count\":2,\"exam\":\"Midterm\""), question).unwrap();
        assert_eq!((with_exam.exam.as_deref(), with_exam.scope.as_ref().map(|s| s.state)), (Some("Midterm"), Some("unmapped")), "nothing looked at yet: said so, not guessed");
        let src = "courses/MATH-M 301 Fall 2026/files/Eigen notes.pdf";
        let m = Scripted::new(&[&map_reply(src), &reply(src), YES2]);
        let emit = |_: StudyEvent| {};
        let (path, n, g) = block_on(make(&dir, &v, &p, question, &answer, &m, &emit, 1_791_000_000_000)).unwrap();
        assert_eq!((path.as_str(), n), ("study/quizzes/Eigen practice.json", 2));
        assert_eq!(g.unwrap().coverage.iter().map(|c| c.topic.as_str()).collect::<Vec<_>>(), ["Eigenvalues and eigenvectors"], "the focus narrowed it to one topic");
        let asked = m.asked.lock().unwrap()[1].1.clone();
        assert!(asked.contains("<discussion>") && asked.contains("quiz me on eigenvalues") && asked.contains("from your M301 notes"), "{asked}");
        assert!(!asked.contains("phaethon-study"), "the block itself isn't context");
        assert!(asked.contains("Focus on: eigenvalues.") && asked.contains("Av = λv"), "{asked}");
        // The map is kept now: an exam it doesn't know is "unknown".
        let with_exam = plan(&dir, &v, &BLOCK.replace("\"count\":2", "\"count\":2,\"exam\":\"Midterm\""), question).unwrap();
        assert_eq!(with_exam.scope.map(|s| s.state), Some("unknown"));
        // Again (a second click, or the card after a reload): what was made, and no model call.
        let p = plan(&dir, &v, BLOCK, question).unwrap();
        assert_eq!(p.made.as_deref(), Some(path.as_str()));
        let none = Scripted::new(&[]);
        assert_eq!(block_on(make(&dir, &v, &p, question, &answer, &none, &emit, 1)).unwrap().0, path);
        assert_eq!(none.calls(), 0);
        assert!(made_file(&dir).is_file());
        // Deleted since: it can be made again.
        super::super::delete(&dir, &path).unwrap();
        assert_eq!(plan(&dir, &v, BLOCK, question).unwrap().made, None);
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn one_run_per_plan_and_it_can_be_stopped() {
        let dir = PathBuf::from("/tmp/phaethon-chat-runs");
        let run = Run::claim(&dir, "abc").unwrap();
        assert!(Run::claim(&dir, "abc").is_none(), "a second click doesn't start another");
        assert!(running(&dir, "abc") && Run::claim(&dir, "other").is_some());
        assert!(cancel(&dir, "abc"));
        let mut run = run;
        block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(2), run.cancelled()).await.expect("stop reaches the run");
        });
        drop(run);
        assert!(!running(&dir, "abc") && !cancel(&dir, "abc"));
        assert!(Run::claim(&dir, "abc").is_some(), "free again once it ended");
    }

    /// A real practice test for a real course's exam, through the installed,
    /// logged-in `claude` CLI (study::model's one-shot path): the course's text
    /// copies (never the original folder, which is only read) in a temporary
    /// vault, its scope map built, then the quiz written and checked. Real calls
    /// on the person's account (about six), so run it rarely:
    /// `PHAETHON_REAL_COURSE=<course folder> PHAETHON_REAL_EXAM="Test 1" cargo test --lib real_cli_practice_test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_cli_practice_test() {
        let from = PathBuf::from(std::env::var("PHAETHON_REAL_COURSE").expect("PHAETHON_REAL_COURSE names a course folder"));
        let exam = std::env::var("PHAETHON_REAL_EXAM").unwrap_or_else(|_| "Test 1".into());
        let count: usize = std::env::var("PHAETHON_REAL_COUNT").ok().and_then(|c| c.parse().ok()).unwrap_or(10);
        let folder = from.file_name().unwrap().to_string_lossy().into_owned();
        // Kept after the run for reading; PHAETHON_REAL_REUSE=1 runs again on it (its map reused while the copy is unchanged).
        let root = std::env::temp_dir().join("phaethon-real-course");
        let reuse = std::env::var("PHAETHON_REAL_REUSE").is_ok() && root.join("spaces/s").is_dir();
        // Copy the text: every .md, and an empty stand-in for each original it is a copy of.
        fn copy(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for e in fs::read_dir(from).unwrap().flatten() {
                let name = e.file_name();
                let (src, dst) = (e.path(), to.join(&name));
                let meta = fs::symlink_metadata(&src).unwrap();
                if meta.is_dir() {
                    copy(&src, &dst);
                } else if meta.is_file() && name.to_string_lossy().ends_with(".md") {
                    fs::copy(&src, &dst).unwrap();
                } else if meta.is_file() {
                    fs::write(&dst, b"").unwrap();
                }
            }
        }
        if !reuse {
            let _ = fs::remove_dir_all(&root);
            copy(&from, &root.join("courses").join(&folder));
            crate::lms::access::fixture(&root, "s", &[(&folder, &crate::lms::access::Part::ALL)]);
        }
        let _ = fs::remove_dir_all(root.join("spaces/s/study"));
        let _ = fs::remove_dir_all(root.join("spaces/s/.phaethon/study"));
        let dir = root.join("spaces/s").canonicalize().unwrap();
        let v = vis(&dir);
        let bin = crate::agent::find_claude().expect("claude is installed");
        let m = super::super::model::CliModel { bin, cwd: dir.clone(), config_dir: None };
        let block = format!(r#"{{"kind":"quiz","title":"{exam} practice test","exam":"{exam}","count":{count},"kinds":["choice","multi","truefalse","short","cloze"],"difficulty":"exam","sources":["courses/{folder}"]}}"#);
        let question = format!("Can you make me a practice test for {exam}?");
        let reply = format!("I'll make a {count}-question practice test for {exam} from your course materials.\n\n```phaethon-study\n{block}\n```");
        let p = plan(&dir, &v, &block, &question).unwrap();
        let started = std::time::Instant::now();
        let emit = |e: StudyEvent| eprintln!("[{:>4}s] {e:?}", started.elapsed().as_secs());
        let made = block_on(make(&dir, &v, &p, &question, &reply, &m, &emit, super::super::now_ms()));
        let out = std::env::temp_dir().join("phaethon-real-practice");
        fs::create_dir_all(&out).unwrap();
        let (map, _) = super::super::scope::cached(&v, &v.courses[0], None).expect("the map was kept");
        fs::write(out.join("scope.json"), serde_json::to_string_pretty(&map).unwrap()).unwrap();
        eprintln!("scope map: {} topics, {} exams, {} quotes dropped; kept at {}", map.topics.len(), map.exams.len(), map.dropped, out.join("scope.json").display());
        for e in &map.exams {
            eprintln!("  {} (known: {}): {}", e.title, e.known, super::super::scope::scope_words(e));
        }
        let (path, n, _) = made.expect("the practice test was made");
        let text = fs::read_to_string(dir.join(&path)).unwrap();
        fs::write(out.join("quiz.json"), &text).unwrap();
        eprintln!("{path}: {n} questions in {}s; kept at {}", started.elapsed().as_secs(), out.join("quiz.json").display());
    }

    #[test]
    fn context_is_the_question_and_the_prose() {
        let c = context("quiz me", "Here is the plan.\n```phaethon-study\n{}\n```\n").unwrap();
        assert!(c.contains("quiz me") && c.contains("Here is the plan.") && !c.contains("```"));
        let long = context(&"q".repeat(10_000), "r").unwrap();
        assert!(long.len() < 4_000 && long.contains("[…]"));
        assert_eq!(context(" ", ""), None);
    }
}
