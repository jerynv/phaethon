//! Study: flashcard decks with confidence-based repetition, quizzes graded in
//! Rust (short answers by the model), and making both from course material.
//!
//! Everything is plain files in the space:
//! - `study/decks/<Title>.md`: decks (deck.rs has the format)
//! - `study/quizzes/<Title>.json`: quizzes (quiz.rs)
//! - `study/exams.json`: `[{ course?, title, date }]`, read for exam-aware scheduling
//! - `.phaethon/study/progress.json`: card scheduling (schedule.rs), not hand-edited
//! - `.phaethon/study/attempts/<quiz>-<time>.json`: quiz attempts
//!
//! The webview names decks and quizzes by these paths relative to the space;
//! each is checked to be exactly one of them (no other folder, no links).

pub(crate) mod commands;
pub mod deck;
pub mod generate;
pub mod model;
pub mod quiz;
pub mod schedule;
pub mod sources;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::lms::names;
use deck::{Deck, Kind, Note};
use quiz::{Attempt, Quiz};
use schedule::{Exam, Progress};

pub const DECKS: &str = "study/decks";
pub const QUIZZES: &str = "study/quizzes";
pub const EXAMS: &str = "study/exams.json";
const PROGRESS: &str = ".phaethon/study/progress.json";
pub const ATTEMPTS: &str = ".phaethon/study/attempts";
/// Largest deck or quiz file read.
const FILE_MAX: u64 = 4 * 1024 * 1024;
pub const SESSION_MAX: usize = 500;

/// Progress is read, changed and written under this lock, so two quick
/// ratings never lose one another.
static PROGRESS_LOCK: Mutex<()> = Mutex::new(());

pub fn now_ms() -> u64 {
    crate::lms::store::now_ms()
}

// ---- Paths -----------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Item {
    Deck,
    Quiz,
    Attempt,
}

impl Item {
    fn folder(self) -> &'static str {
        match self {
            Item::Deck => DECKS,
            Item::Quiz => QUIZZES,
            Item::Attempt => ATTEMPTS,
        }
    }
    fn ext(self) -> &'static str {
        match self {
            Item::Deck => ".md",
            _ => ".json",
        }
    }
}

/// `path` checked to be a file directly in `item`'s folder, with its
/// extension, and a plain name. Returns it normalised (forward slashes).
pub fn check_path(path: &str, item: Item) -> Result<String, String> {
    let p = path.trim().replace('\\', "/");
    let name = p.strip_prefix(item.folder()).and_then(|r| r.strip_prefix('/')).unwrap_or("");
    let ok = !name.is_empty()
        && !name.contains('/')
        && !name.starts_with('.')
        && name.len() > item.ext().len()
        && name.to_ascii_lowercase().ends_with(item.ext())
        && !name.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if !ok {
        return Err(match item {
            Item::Deck => "That isn’t a deck in this space.".into(),
            Item::Quiz => "That isn’t a quiz in this space.".into(),
            Item::Attempt => "That isn’t a quiz attempt in this space.".into(),
        });
    }
    Ok(p)
}

/// The real file for a checked `rel`, if it exists as a plain file reached
/// without any link on the way.
fn plain_file(space: &Path, rel: &str) -> Option<PathBuf> {
    let mut at = space.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        let m = fs::symlink_metadata(&at).ok()?;
        let last = i + 1 == parts.len();
        if (last && !m.is_file()) || (!last && !m.is_dir()) {
            return None;
        }
    }
    Some(at)
}

fn read_capped(path: &Path) -> Result<String, String> {
    let f = fs::File::open(path).map_err(|e| format!("It couldn’t be read: {e}"))?;
    let mut bytes = vec![];
    std::io::Read::read_to_end(&mut std::io::Read::take(f, FILE_MAX + 1), &mut bytes).map_err(|e| format!("It couldn’t be read: {e}"))?;
    if bytes.len() as u64 > FILE_MAX {
        return Err("It’s too big to open here (over 4 MB).".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// The names (not paths) of `item`'s files in the space, sorted.
fn list(space: &Path, item: Item) -> Vec<String> {
    let Some(dir) = plain_dir(space, item.folder()) else { return vec![] };
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<String> = rd
        .filter_map(Result::ok)
        .filter(|e| fs::symlink_metadata(e.path()).is_ok_and(|m| m.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| check_path(&format!("{}/{n}", item.folder()), item).is_ok())
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

fn plain_dir(space: &Path, rel: &str) -> Option<PathBuf> {
    let mut at = space.to_path_buf();
    for part in rel.split('/') {
        at.push(part);
        if !fs::symlink_metadata(&at).ok()?.is_dir() {
            return None;
        }
    }
    Some(at)
}

/// A file name for `title` in `item`'s folder that no file uses yet
/// (compared without case): `Title.md`, `Title (2).md`...
fn free_path(space: &Path, item: Item, title: &str) -> String {
    let taken: std::collections::HashSet<String> = list(space, item).iter().map(|n| n.to_lowercase()).collect();
    let mut stem = names::segment(title);
    if stem.to_lowercase().ends_with(item.ext()) {
        stem.truncate(stem.len() - item.ext().len());
    }
    let stem: String = stem.chars().take(90).collect();
    let stem = if stem.trim().is_empty() { "Untitled".to_string() } else { stem };
    let mut name = format!("{stem}{}", item.ext());
    let mut n = 2;
    while taken.contains(&name.to_lowercase()) {
        name = format!("{stem} ({n}){}", item.ext());
        n += 1;
    }
    format!("{}/{name}", item.folder())
}

fn write_file(space: &Path, rel: &str, text: &str) -> Result<(), String> {
    names::write(space, Path::new(rel), text.as_bytes()).map_err(|e| format!("It couldn’t be saved: {e}"))
}

fn file_title(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.').map_or(name, |(s, _)| s).to_string()
}

// ---- Reading -----------------------------------------------------------------------

pub fn load_deck(space: &Path, path: &str) -> Result<(String, Deck), String> {
    let rel = check_path(path, Item::Deck)?;
    let file = plain_file(space, &rel).ok_or("That deck isn’t in this space any more.")?;
    Ok((rel.clone(), deck::parse(&read_capped(&file)?, &file_title(&rel))))
}

pub fn load_quiz(space: &Path, path: &str) -> Result<(String, Quiz), String> {
    let rel = check_path(path, Item::Quiz)?;
    let file = plain_file(space, &rel).ok_or("That quiz isn’t in this space any more.")?;
    let mut q: Quiz = serde_json::from_str(&read_capped(&file)?).map_err(|e| format!("This quiz file can’t be read ({e}). Fix or delete {rel}."))?;
    quiz::normalize(&mut q).map_err(|e| format!("This quiz file has a problem: {e} Fix or delete {rel}."))?;
    Ok((rel, q))
}

pub fn load_attempt(space: &Path, path: &str) -> Result<Attempt, String> {
    let rel = check_path(path, Item::Attempt)?;
    let file = plain_file(space, &rel).ok_or("That quiz attempt isn’t in this space any more.")?;
    serde_json::from_str(&read_capped(&file)?).map_err(|e| format!("That quiz attempt can’t be read: {e}"))
}

fn load_progress(space: &Path) -> Progress {
    plain_file(space, PROGRESS)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_progress(space: &Path, p: &Progress) -> Result<(), String> {
    let mut p = p.clone();
    p.version = 1;
    let text = serde_json::to_string(&p).map_err(|e| e.to_string())?;
    names::write(space, Path::new(PROGRESS), text.as_bytes()).map_err(|e| format!("Your progress couldn’t be saved: {e}"))
}

/// Exams from `study/exams.json`; a missing or broken file is no exams.
pub fn load_exams(space: &Path) -> Vec<Exam> {
    let Some(file) = plain_file(space, EXAMS) else { return vec![] };
    let Ok(text) = read_capped(&file) else { return vec![] };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Array(items)) => items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect(),
        Ok(v) => v.get("exams").and_then(|e| serde_json::from_value(e.clone()).ok()).unwrap_or_default(),
        Err(_) => vec![],
    }
}

// ---- Views (the IPC contract) ----------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    pub cards: usize,
    pub due: usize,
    pub new: usize,
    pub mastery: f64,
    pub updated: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizSummary {
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    pub questions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_taken: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub decks: Vec<DeckSummary>,
    pub quizzes: Vec<QuizSummary>,
    pub due: usize,
    pub streak_days: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub kind: Kind,
    /// For a cloze card, the text with its `{{...}}` blanks (the UI hides them).
    pub front: String,
    /// For a cloze card, an optional extra note (the answers are the blanks).
    pub back: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The last rating, 1..5.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckView {
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    pub sources: Vec<String>,
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCard {
    #[serde(flatten)]
    pub card: Card,
    pub deck: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rated {
    pub due: u64,
    pub again: bool,
}

fn cards_of(path: &str, d: &Deck, states: Option<&BTreeMap<String, schedule::CardState>>) -> Vec<Card> {
    deck::card_ids(path, d)
        .into_iter()
        .zip(&d.notes)
        .map(|(id, n)| {
            let st = states.and_then(|s| s.get(&id));
            Card {
                kind: n.kind(),
                front: n.front.clone(),
                back: n.back.clone(),
                source: n.source.clone(),
                confidence: st.and_then(|s| s.last_confidence()),
                due: st.map(|s| s.due),
                id,
            }
        })
        .collect()
}

fn attempts(space: &Path) -> Vec<Attempt> {
    list(space, Item::Attempt).iter().filter_map(|n| load_attempt(space, &format!("{ATTEMPTS}/{n}")).ok()).collect()
}

pub fn overview(space: &Path, now: u64) -> Overview {
    let progress = load_progress(space);
    let mut decks = vec![];
    for name in list(space, Item::Deck) {
        let path = format!("{DECKS}/{name}");
        let Ok((path, d)) = load_deck(space, &path) else { continue };
        let ids = deck::card_ids(&path, &d);
        let states = progress.decks.get(&path);
        let due = ids.iter().filter(|id| states.and_then(|s| s.get(*id)).is_some_and(|s| s.due <= now)).count();
        let new = ids.iter().filter(|id| states.is_none_or(|s| !s.contains_key(*id))).count();
        let file = plain_file(space, &path);
        decks.push(DeckSummary {
            mastery: schedule::mastery(states, &ids, now),
            cards: ids.len(),
            due,
            new,
            updated: file.map_or(0, |f| modified_ms(&f)),
            title: d.title,
            course: d.course,
            path,
        });
    }
    let tries = attempts(space);
    let mut quizzes = vec![];
    for name in list(space, Item::Quiz) {
        let path = format!("{QUIZZES}/{name}");
        let last = tries.iter().filter(|a| a.quiz == path).max_by_key(|a| a.taken);
        let (title, course, questions) = match load_quiz(space, &path) {
            Ok((_, q)) => (q.title, q.course, q.questions.len()),
            // Shown anyway, so a broken file can be found and deleted.
            Err(_) => (file_title(&path), None, 0),
        };
        quizzes.push(QuizSummary { path, title, course, questions, last_score: last.map(|a| a.score), last_taken: last.map(|a| a.taken) });
    }
    let due = decks.iter().map(|d| d.due).sum();
    let today = schedule::local_day(now, schedule::local_offset_secs(now));
    Overview { decks, quizzes, due, streak_days: schedule::streak(&progress.days, today) }
}

pub fn deck_view(space: &Path, path: &str) -> Result<DeckView, String> {
    let (path, d) = load_deck(space, path)?;
    let progress = load_progress(space);
    Ok(DeckView { cards: cards_of(&path, &d, progress.decks.get(&path)), title: d.title, course: d.course, sources: d.sources, path })
}

/// A card as the webview sends it to save.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CardInput {
    pub front: String,
    #[serde(default)]
    pub back: String,
    #[serde(default)]
    pub source: Option<String>,
}

/// Create (`path` None or empty) or edit a deck. Editing keeps the file, its
/// course, sources and anything hand-written outside the cards; a card whose
/// front is unchanged keeps its source and its progress.
pub fn deck_save(space: &Path, path: Option<&str>, title: &str, cards: &[CardInput]) -> Result<String, String> {
    let existing = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(load_deck(space, p)?),
        None => None,
    };
    let key = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut d = existing.as_ref().map(|(_, d)| d.clone()).unwrap_or_default();
    let old_sources: BTreeMap<String, Option<String>> = d.notes.iter().map(|n| (key(&n.front), n.source.clone())).collect();
    d.title = title.trim().to_string();
    d.notes = cards
        .iter()
        .map(|c| {
            let front = c.front.replace("\r\n", "\n").trim().to_string();
            let source = c.source.clone().filter(|s| !s.trim().is_empty()).or_else(|| old_sources.get(&key(&front)).cloned().flatten());
            Note { back: c.back.replace("\r\n", "\n").trim().to_string(), source, front }
        })
        .collect();
    deck::validate(&d)?;
    let rel = match &existing {
        Some((rel, _)) => rel.clone(),
        None => free_path(space, Item::Deck, &d.title),
    };
    write_file(space, &rel, &deck::write(&d))?;
    // Progress for cards that are gone goes with them.
    let ids: std::collections::HashSet<String> = deck::card_ids(&rel, &d).into_iter().collect();
    let _g = PROGRESS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut progress = load_progress(space);
    if let Some(states) = progress.decks.get_mut(&rel) {
        let before = states.len();
        states.retain(|id, _| ids.contains(id));
        if states.len() != before {
            save_progress(space, &progress)?;
        }
    }
    Ok(rel)
}

/// Write a new deck (from generation). Returns its path.
pub fn deck_create(space: &Path, d: &Deck) -> Result<String, String> {
    deck::validate(d)?;
    let rel = free_path(space, Item::Deck, &d.title);
    write_file(space, &rel, &deck::write(d))?;
    Ok(rel)
}

pub fn quiz_create(space: &Path, q: &Quiz) -> Result<String, String> {
    let mut q = q.clone();
    quiz::normalize(&mut q)?;
    let rel = free_path(space, Item::Quiz, &q.title);
    let text = serde_json::to_string_pretty(&q).map_err(|e| e.to_string())?;
    write_file(space, &rel, &text)?;
    Ok(rel)
}

pub fn attempt_save(space: &Path, a: &mut Attempt) -> Result<(), String> {
    let stem: String = names::segment(&file_title(&a.quiz)).chars().take(80).collect();
    a.path = format!("{ATTEMPTS}/{stem}-{}.json", a.taken);
    check_path(&a.path, Item::Attempt)?;
    let text = serde_json::to_string_pretty(a).map_err(|e| e.to_string())?;
    write_file(space, &a.path, &text)
}

/// The exam that caps a deck's intervals, if any.
fn exam_for(exams: &[Exam], d: &Deck, now: u64) -> Option<u64> {
    schedule::next_exam(exams, d.course.as_deref(), now, schedule::local_offset_secs(now))
}

/// Cards to study, in order: due ones (most overdue first), then new ones in
/// deck order, up to `limit`. With `paths` (chosen decks) and room left, cards
/// due soonest after that, so a chosen deck can always be studied.
pub fn session(space: &Path, paths: Option<&[String]>, limit: usize, now: u64) -> Result<Vec<SessionCard>, String> {
    let limit = limit.clamp(1, SESSION_MAX);
    let chosen: Vec<String> = match paths {
        Some(p) => p.iter().map(|p| check_path(p, Item::Deck)).collect::<Result<_, _>>()?,
        None => list(space, Item::Deck).iter().map(|n| format!("{DECKS}/{n}")).collect(),
    };
    let progress = load_progress(space);
    let (mut due, mut new, mut ahead) = (vec![], vec![], vec![]);
    for path in &chosen {
        let (path, d) = match load_deck(space, path) {
            Ok(x) => x,
            Err(e) if paths.is_some() => return Err(e),
            Err(_) => continue,
        };
        for card in cards_of(&path, &d, progress.decks.get(&path)) {
            let sc = SessionCard { deck: path.clone(), card };
            match sc.card.due {
                Some(t) if t <= now => due.push((t, sc)),
                Some(t) => ahead.push((t, sc)),
                None => new.push(sc),
            }
        }
    }
    due.sort_by_key(|(t, _)| *t);
    ahead.sort_by_key(|(t, _)| *t);
    let mut out: Vec<SessionCard> = due.into_iter().map(|(_, c)| c).chain(new).collect();
    if paths.is_some() {
        out.extend(ahead.into_iter().map(|(_, c)| c));
    }
    out.truncate(limit);
    Ok(out)
}

/// Rate a card 1..5 after seeing its answer.
pub fn rate(space: &Path, deck_path: &str, card: &str, confidence: u8, now: u64) -> Result<Rated, String> {
    if !(1..=5).contains(&confidence) {
        return Err("Rate how well you knew it from 1 to 5.".into());
    }
    let (path, d) = load_deck(space, deck_path)?;
    if !deck::card_ids(&path, &d).iter().any(|id| id == card) {
        return Err("That card isn’t in the deck any more; it may have been edited.".into());
    }
    let exam = exam_for(&load_exams(space), &d, now);
    let _g = PROGRESS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut progress = load_progress(space);
    let states = progress.decks.entry(path).or_default();
    let (state, again) = schedule::rate(states.get(card), confidence, now, exam);
    let due = state.due;
    states.insert(card.to_string(), state);
    progress.days.insert(schedule::local_day(now, schedule::local_offset_secs(now)));
    save_progress(space, &progress)?;
    Ok(Rated { due, again })
}

/// Delete a deck (and its progress) or a quiz (and its attempts).
pub fn delete(space: &Path, path: &str) -> Result<(), String> {
    let (rel, item) = match check_path(path, Item::Deck) {
        Ok(r) => (r, Item::Deck),
        Err(_) => (check_path(path, Item::Quiz).map_err(|_| "That isn’t a deck or quiz in this space.".to_string())?, Item::Quiz),
    };
    let file = plain_file(space, &rel).ok_or("It isn’t in this space any more.")?;
    fs::remove_file(file).map_err(|e| format!("It couldn’t be deleted: {e}"))?;
    match item {
        Item::Deck => {
            let _g = PROGRESS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let mut progress = load_progress(space);
            if progress.decks.remove(&rel).is_some() {
                save_progress(space, &progress)?;
            }
        }
        _ => {
            for a in attempts(space).into_iter().filter(|a| a.quiz == rel) {
                if let Some(f) = plain_file(space, &a.path) {
                    let _ = fs::remove_file(f);
                }
            }
        }
    }
    Ok(())
}

/// Fronts of the decks of `course` (or of every deck without one), so new
/// cards don't repeat them.
pub fn existing_fronts(space: &Path, course: Option<&str>) -> Vec<String> {
    list(space, Item::Deck)
        .iter()
        .filter_map(|n| load_deck(space, &format!("{DECKS}/{n}")).ok())
        .filter(|(_, d)| match (course, d.course.as_deref()) {
            (Some(c), Some(dc)) => schedule::same_course(c, dc),
            (None, None) => true,
            _ => false,
        })
        .flat_map(|(_, d)| d.notes.into_iter().map(|n| n.front))
        .collect()
}

// ---- The agent's prompt --------------------------------------------------------------

/// A short note for the agent's system prompt about the study folder and the
/// deck format, so it can find decks and make one with write_file. Only for a
/// space that sees courses or has a study folder.
pub fn prompt_section(space: &Path, has_courses: bool, now: u64) -> Option<String> {
    if !has_courses && plain_dir(space, "study").is_none() {
        return None;
    }
    let mut s = String::from(
        "# Study\n\nStudy material lives in study/: flashcard decks in study/decks/<Title>.md, quizzes in study/quizzes/<Title>.json, \
the study plan in study/plan.md and exam dates in study/exams.json ([{\"course\", \"title\", \"date\": \"YYYY-MM-DD\"}]). \
A deck is Markdown: front matter between --- lines (title:, optional course: the course folder name, optional sources: a list of files), \
then the cards, each \"Q: <question>\" on one line, \"A: <answer>\" on the next, optionally \"From: <file it came from>\", with a blank line between cards. \
Writing {{a term}} in a question makes a fill-in card that hides it. To make flashcards for the user, write a new deck with write_file in this format: \
one idea per card, from the course's own material.",
    );
    let off = schedule::local_offset_secs(now);
    let mut upcoming: Vec<(u64, &Exam)> = vec![];
    let exams = load_exams(space);
    for e in &exams {
        if let Some(t) = schedule::exam_start(&e.date, off).filter(|t| *t > now) {
            upcoming.push((t, e));
        }
    }
    upcoming.sort_by_key(|(t, _)| *t);
    if !upcoming.is_empty() {
        let list: Vec<String> = upcoming
            .iter()
            .take(5)
            .map(|(_, e)| match &e.course {
                Some(c) => format!("{} ({c}) on {}", e.title, e.date),
                None => format!("{} on {}", e.title, e.date),
            })
            .collect();
        s.push_str(&format!("\n\nUpcoming exams: {}.", list.join("; ")));
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use schedule::{DAY, MINUTE};

    pub fn space(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-study-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    const T0: u64 = 1_791_000_000_000;

    fn cards(pairs: &[(&str, &str)]) -> Vec<CardInput> {
        pairs.iter().map(|(f, b)| CardInput { front: f.to_string(), back: b.to_string(), source: None }).collect()
    }

    #[test]
    fn paths_are_only_decks_and_quizzes_in_their_folders() {
        assert_eq!(check_path("study/decks/Sets.md", Item::Deck).unwrap(), "study/decks/Sets.md");
        assert_eq!(check_path("study\\decks\\Sets.md", Item::Deck).unwrap(), "study/decks/Sets.md");
        for bad in ["study/decks/../x.md", "study/decks/a/b.md", "study/decks/.md", "study/decks/.hidden.md", "study/decks/x.txt", "/study/decks/x.md", "notes.md", "study/quizzes/x.json", "study/decks/", "study/decks/a:b.md"] {
            assert!(check_path(bad, Item::Deck).is_err(), "{bad}");
        }
        assert!(check_path("study/quizzes/Q.json", Item::Quiz).is_ok());
        assert!(check_path(".phaethon/study/attempts/Q-1.json", Item::Attempt).is_ok());
        assert!(check_path(".phaethon/study/progress.json", Item::Attempt).is_err());
    }

    #[test]
    fn save_study_rate_and_delete_a_deck() {
        let dir = space("flow");
        let path = deck_save(&dir, None, "Sets: basics", &cards(&[("What is ∅?", "The empty set."), ("|{1,2}| = {{2}}", "")])).unwrap();
        assert_eq!(path, "study/decks/Sets- basics.md");
        // Same title again: a new file, not an overwrite.
        assert_eq!(deck_save(&dir, Some(""), "Sets: basics", &cards(&[("x", "y")])).unwrap(), "study/decks/Sets- basics (2).md");
        let v = deck_view(&dir, &path).unwrap();
        assert_eq!(v.title, "Sets: basics");
        assert_eq!(v.cards.len(), 2);
        assert_eq!(v.cards[1].kind, Kind::Cloze);

        let o = overview(&dir, T0);
        let d = o.decks.iter().find(|d| d.path == path).unwrap();
        assert_eq!((o.decks.len(), d.new, d.due, o.due, o.streak_days), (2, 2, 0, 0, 0));

        let s = session(&dir, Some(std::slice::from_ref(&path)), 20, T0).unwrap();
        assert_eq!(s.len(), 2);
        let r = rate(&dir, &path, &s[0].card.id, 1, T0).unwrap();
        assert!(r.again && r.due == T0 + 10 * MINUTE);
        let r = rate(&dir, &path, &s[1].card.id, 5, T0).unwrap();
        assert!(!r.again && r.due == T0 + 5 * DAY);
        assert!(rate(&dir, &path, "nope", 3, T0).is_err());
        assert!(rate(&dir, &path, &s[0].card.id, 6, T0).is_err());

        // Later: the forgotten card is due, the known one isn't.
        let later = T0 + HOUR_MS;
        let o = overview(&dir, later);
        let d = o.decks.iter().find(|d| d.path == path).unwrap();
        assert_eq!((d.due, d.new, o.streak_days), (1, 0, 1));
        assert_eq!(d.mastery, 0.5);
        let all = session(&dir, None, 20, later).unwrap();
        assert_eq!(all[0].card.id, s[0].card.id, "due first");
        assert_eq!(all.len(), 2, "plus the other deck's new card; not the card due in 5 days");
        // Choosing the deck itself also offers what's due later.
        assert_eq!(session(&dir, Some(std::slice::from_ref(&path)), 20, later).unwrap().len(), 2);

        // Editing an answer keeps progress; changing a question drops that card's.
        let edited = cards(&[("What is ∅?", "The set with no members."), ("|{1,2,3}| = {{3}}", "")]);
        deck_save(&dir, Some(&path), "Sets: basics", &edited).unwrap();
        let v = deck_view(&dir, &path).unwrap();
        assert_eq!(v.cards[0].confidence, Some(1));
        assert_eq!(v.cards[1].confidence, None);
        assert_eq!(load_progress(&dir).decks[&path].len(), 1);

        delete(&dir, &path).unwrap();
        assert!(!load_progress(&dir).decks.contains_key(&path));
        assert!(deck_view(&dir, &path).is_err());
        assert!(delete(&dir, "notes.md").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    const HOUR_MS: u64 = 60 * MINUTE;

    #[test]
    fn hand_written_decks_and_bad_saves() {
        let dir = space("hand");
        fs::create_dir_all(dir.join(DECKS)).unwrap();
        fs::write(dir.join(DECKS).join("Spanish.md"), "q: uno\r\na: one\r\n\r\nQ: dos\r\nA: two\r\n").unwrap();
        let o = overview(&dir, T0);
        assert_eq!((o.decks[0].title.as_str(), o.decks[0].cards), ("Spanish", 2));
        let err = deck_save(&dir, Some("study/decks/Spanish.md"), "Spanish", &cards(&[("uno", "")])).unwrap_err();
        assert!(err.contains("no answer"), "{err}");
        assert!(deck_save(&dir, None, "  ", &cards(&[("a", "b")])).is_err());
        assert!(deck_save(&dir, Some("study/decks/Missing.md"), "x", &cards(&[("a", "b")])).is_err());
        // Nothing was written by the failed saves.
        assert_eq!(fs::read_to_string(dir.join(DECKS).join("Spanish.md")).unwrap(), "q: uno\r\na: one\r\n\r\nQ: dos\r\nA: two\r\n");
        assert_eq!(list(&dir, Item::Deck), ["Spanish.md"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_folders_and_files_are_never_used() {
        let dir = space("links");
        let outside = space("links-outside");
        fs::write(outside.join("Evil.md"), "Q: a\nA: b\n").unwrap();
        fs::create_dir_all(dir.join("study")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(DECKS)).unwrap();
        assert!(overview(&dir, T0).decks.is_empty());
        assert!(deck_view(&dir, "study/decks/Evil.md").is_err());
        assert!(deck_save(&dir, None, "New", &cards(&[("a", "b")])).is_err(), "never written through the link");
        assert!(!outside.join("New.md").exists());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn exams_cap_intervals_and_reach_the_prompt() {
        let dir = space("exams");
        assert_eq!(prompt_section(&dir, false, T0), None, "no courses, no study folder: nothing");
        assert!(prompt_section(&dir, true, T0).is_some(), "a space that sees courses gets it");
        fs::create_dir_all(dir.join("study")).unwrap();
        let path = deck_save(&dir, None, "Logic", &cards(&[("p → q is false when?", "p true, q false")])).unwrap();
        let mut text = fs::read_to_string(dir.join(&path)).unwrap();
        text = text.replace("title: Logic\n", "title: Logic\ncourse: CSCI-C 241 Fall 2026 (All Sections)\n");
        fs::write(dir.join(&path), text).unwrap();
        let exam_day = "2026-10-15";
        fs::write(dir.join(EXAMS), format!(r#"[{{"course": "CSCI-C 241", "title": "Test 1", "date": "{exam_day}"}}]"#)).unwrap();
        let now = schedule::exam_start("2026-10-12", schedule::local_offset_secs(T0)).unwrap() + 10 * HOUR_MS;
        let id = deck_view(&dir, &path).unwrap().cards[0].id.clone();
        let r = rate(&dir, &path, &id, 5, now).unwrap();
        let exam = schedule::exam_start(exam_day, schedule::local_offset_secs(now)).unwrap();
        assert!(r.due < exam, "seen again before the exam");
        let p = prompt_section(&dir, false, now).unwrap();
        assert!(p.contains("study/decks/<Title>.md") && p.contains("Q: <question>") && p.contains("Test 1 (CSCI-C 241) on 2026-10-15"), "{p}");
        assert!(!prompt_section(&dir, false, exam + DAY).unwrap().contains("Upcoming"));
        fs::remove_dir_all(dir).unwrap();
    }
}
