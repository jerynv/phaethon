//! The study planner's files in a space: what's coming up (the due dates the
//! course import keeps in `.phaethon/lms.json`), the exams the person adds
//! (`study/exams.json`, plain JSON they may edit), the schedule written out as
//! `study/plan.md`, and the planner's own state (study days, session length,
//! what was checked off) in `.phaethon/study/plan.json`. The webview never
//! names a path: each command knows its one file.

use std::io;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::lms::{names, store};
use crate::tools::STATE_DIR;

pub const EXAMS_FILE: &str = "study/exams.json";
pub const PLAN_FILE: &str = "study/plan.md";
const STATE_FILE: &str = "study/plan.json";

const MAX_READ: u64 = 1024 * 1024;
const MAX_PLAN: usize = 256 * 1024;
const MAX_EXAMS: usize = 200;
const MAX_UPCOMING: usize = 300;
const MAX_TITLE: usize = 120;
const MAX_COURSE: usize = 200;
const MAX_DONE: usize = 2000;

/// Something due from an imported course.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upcoming {
    /// The course's name on the site.
    pub course: String,
    /// Its folder under `courses/`.
    pub folder: String,
    pub title: String,
    /// When it is due, ms since the epoch.
    pub due: i64,
    /// Where it is described, relative to the space (for `file_open`).
    pub link: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exam {
    pub id: String,
    /// The course's folder name under `courses/` (or any short name the person gave it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    pub title: String,
    /// The day, `YYYY-MM-DD`.
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanState {
    /// Days of the week to study on, 0 = Sunday.
    pub study_days: Vec<u8>,
    pub sessions_per_day: u8,
    pub session_minutes: u16,
    /// Ids of the sessions checked off.
    #[serde(default)]
    pub done: Vec<String>,
}

impl Default for PlanState {
    fn default() -> Self {
        Self { study_days: vec![0, 1, 2, 3, 4, 5], sessions_per_day: 3, session_minutes: 25, done: vec![] }
    }
}

/// An imported course: its name and its folder under `courses/`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CourseRef {
    pub name: String,
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpcomingView {
    /// Every imported course, by name (for choosing an exam's course).
    pub courses: Vec<CourseRef>,
    /// What's due from now on, soonest first.
    pub items: Vec<Upcoming>,
}

/// The space's imported courses and everything due from now on in them.
pub fn upcoming(space_dir: &Path, now_secs: i64) -> Result<UpcomingView, String> {
    let st = store::load(space_dir)?;
    let mut out = vec![];
    let mut courses = vec![];
    for conn in &st.connections {
        for c in conn.courses.values() {
            if !courses.iter().any(|r: &CourseRef| r.folder == c.folder) {
                courses.push(CourseRef { name: c.name.clone(), folder: c.folder.clone() });
            }
            for (t, d) in store::upcoming(&c.due, now_secs) {
                let anchor = if d.anchor.is_empty() { String::new() } else { format!("#{}", d.anchor) };
                out.push(Upcoming {
                    course: c.name.clone(),
                    folder: c.folder.clone(),
                    title: d.title.clone(),
                    due: t * 1000,
                    link: format!("courses/{}/assignments.md{anchor}", c.folder),
                });
            }
        }
    }
    out.sort_by(|a, b| a.due.cmp(&b.due).then_with(|| a.course.cmp(&b.course)).then_with(|| a.title.cmp(&b.title)));
    out.truncate(MAX_UPCOMING);
    courses.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(UpcomingView { courses, items: out })
}

// ---- Exams -------------------------------------------------------------------

/// The exams in `study/exams.json`, by date. An entry edited by hand into
/// something that isn't an exam is left out rather than failing the rest.
pub fn exams_get(space_dir: &Path) -> Result<Vec<Exam>, String> {
    let Some(text) = read_small(space_dir, Path::new(EXAMS_FILE)).map_err(|e| format!("Your exams couldn’t be read: {e}"))? else {
        return Ok(vec![]);
    };
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("Your exams file is damaged ({e}). Fix or remove study/exams.json."))?;
    let mut exams: Vec<Exam> = raw
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Exam>(v).ok())
        .filter_map(|e| clean_exam(e).ok())
        .take(MAX_EXAMS)
        .collect();
    exams.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.title.cmp(&b.title)));
    Ok(exams)
}

/// Replace the exams with `exams`, each checked; returns them as saved (trimmed, by date).
pub fn exams_set(space_dir: &Path, exams: Vec<Exam>) -> Result<Vec<Exam>, String> {
    if exams.len() > MAX_EXAMS {
        return Err(format!("A space can keep up to {MAX_EXAMS} exams."));
    }
    let mut clean = Vec::with_capacity(exams.len());
    for e in exams {
        let e = clean_exam(e)?;
        if clean.iter().any(|c: &Exam| c.id == e.id) {
            return Err("Two exams have the same id.".into());
        }
        clean.push(e);
    }
    clean.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.title.cmp(&b.title)));
    let mut json = serde_json::to_vec_pretty(&clean).map_err(|e| e.to_string())?;
    json.push(b'\n');
    names::write(space_dir, Path::new(EXAMS_FILE), &json).map_err(|e| format!("Your exams couldn’t be saved: {e}"))?;
    Ok(clean)
}

fn clean_exam(e: Exam) -> Result<Exam, String> {
    let id = e.id.trim().to_string();
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("That exam’s id isn’t one Phaethon made.".into());
    }
    let title = one_line(&e.title);
    if title.is_empty() {
        return Err("An exam needs a name, like “Test 1”.".into());
    }
    if title.chars().count() > MAX_TITLE {
        return Err(format!("An exam’s name can be at most {MAX_TITLE} characters."));
    }
    if !valid_date(&e.date) {
        return Err("An exam needs a real date.".into());
    }
    let course = match e.course.as_deref().map(one_line) {
        None => None,
        Some(c) if c.is_empty() => None,
        Some(c) if c.chars().count() > MAX_COURSE || c.contains(['/', '\\']) || c == "." || c == ".." => {
            return Err("That course name can’t be used.".into());
        }
        Some(c) => Some(c),
    };
    Ok(Exam { id, course, title, date: e.date.trim().to_string() })
}

/// Whitespace (newlines and other control characters too) collapsed to single spaces.
fn one_line(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `YYYY-MM-DD`, a real day between the years 2000 and 2100.
fn valid_date(s: &str) -> bool {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse::<u32>().ok());
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else { return false };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (2000..=2100).contains(&y) && (1..=days).contains(&d)
}

// ---- The plan --------------------------------------------------------------

/// Write the schedule (Markdown made by the planner) to `study/plan.md`.
pub fn save_plan(space_dir: &Path, markdown: &str) -> Result<String, String> {
    if markdown.len() > MAX_PLAN {
        return Err("That plan is too long to save.".into());
    }
    names::write(space_dir, Path::new(PLAN_FILE), markdown.as_bytes()).map_err(|e| format!("The plan couldn’t be saved: {e}"))?;
    Ok(PLAN_FILE.into())
}

pub fn state_get(space_dir: &Path) -> PlanState {
    read_small(space_dir, &Path::new(STATE_DIR).join(STATE_FILE))
        .ok()
        .flatten()
        .and_then(|t| serde_json::from_str::<PlanState>(&t).ok())
        .and_then(|s| clean_state(s).ok())
        .unwrap_or_default()
}

pub fn state_set(space_dir: &Path, state: PlanState) -> Result<PlanState, String> {
    let state = clean_state(state)?;
    let json = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    names::write(space_dir, &Path::new(STATE_DIR).join(STATE_FILE), &json).map_err(|e| format!("The plan couldn’t be saved: {e}"))?;
    Ok(state)
}

fn clean_state(mut s: PlanState) -> Result<PlanState, String> {
    s.study_days.sort_unstable();
    s.study_days.dedup();
    if s.study_days.is_empty() || s.study_days.iter().any(|d| *d > 6) {
        return Err("Choose at least one day of the week to study on.".into());
    }
    if !(1..=8).contains(&s.sessions_per_day) {
        return Err("Plan between 1 and 8 sessions a day.".into());
    }
    if !(10..=120).contains(&s.session_minutes) {
        return Err("A session can be 10 to 120 minutes.".into());
    }
    s.done.retain(|d| !d.is_empty() && d.len() <= 300);
    s.done.dedup();
    if s.done.len() > MAX_DONE {
        let cut = s.done.len() - MAX_DONE;
        s.done.drain(..cut);
    }
    Ok(s)
}

/// A small file at `rel` under `root`, `None` when missing. Refuses a symlink
/// anywhere on the way, anything that isn't a plain file, and big files.
fn read_small(root: &Path, rel: &Path) -> io::Result<Option<String>> {
    let mut at = root.to_path_buf();
    for part in rel.components() {
        let Component::Normal(p) = part else { return Err(io::Error::other("not a plain path")) };
        at.push(p);
        match at.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => return Err(io::Error::other("it is a link")),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    let m = at.symlink_metadata()?;
    if !m.is_file() || m.len() > MAX_READ {
        return Err(io::Error::other("it isn’t a small plain file"));
    }
    std::fs::read_to_string(&at).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn space(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-plan-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn exam(id: &str, title: &str, date: &str) -> Exam {
        Exam { id: id.into(), course: None, title: title.into(), date: date.into() }
    }

    #[test]
    fn upcoming_lists_every_course_soonest_first_from_now_on() {
        let dir = space("upcoming");
        let mut st = store::Store::default();
        let mut conn = store::Conn {
            id: "c1".into(),
            kind: crate::lms::Kind::Canvas,
            address: "https://x".into(),
            school_name: None,
            last_sync: None,
            courses: Default::default(),
        };
        let due = |title: &str, due: &str, anchor: &str| store::Due { title: title.into(), due: due.into(), anchor: anchor.into() };
        conn.courses.insert(
            "1".into(),
            store::CourseState {
                name: "CSCI-C 241".into(),
                folder: "CSCI-C 241".into(),
                due: vec![due("HW 01", "2026-09-02T03:59:59Z", "hw-01"), due("HW 06", "2026-10-15T03:59:59Z", "hw-06")],
                ..Default::default()
            },
        );
        conn.courses.insert(
            "2".into(),
            store::CourseState {
                name: "Linear Algebra".into(),
                folder: "Linear Algebra".into(),
                due: vec![due("Quiz 3", "2026-10-12T16:00:00Z", ""), due("Bad date", "next week", "x")],
                ..Default::default()
            },
        );
        st.connections.push(conn);
        store::save(&dir, &st).unwrap();
        let now = store::parse_time("2026-10-10T12:00:00Z").unwrap();
        let view = upcoming(&dir, now).unwrap();
        assert_eq!(view.courses.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["CSCI-C 241", "Linear Algebra"]);
        let got = view.items;
        assert_eq!(got.iter().map(|u| u.title.as_str()).collect::<Vec<_>>(), ["Quiz 3", "HW 06"]);
        assert_eq!(got[0].link, "courses/Linear Algebra/assignments.md");
        assert_eq!(got[1].link, "courses/CSCI-C 241/assignments.md#hw-06");
        assert_eq!(got[1].due, store::parse_time("2026-10-15T03:59:59Z").unwrap() * 1000);
        assert_eq!(upcoming(&space("none"), now).unwrap(), UpcomingView { courses: vec![], items: vec![] }, "no courses, nothing due");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exams_are_checked_saved_by_date_and_read_back() {
        let dir = space("exams");
        assert!(exams_get(&dir).unwrap().is_empty());
        let mut first = exam("e1", "  Test 1\n(chapters 1–4) ", "2026-10-15");
        first.course = Some("CSCI-C 241 Fall 2026 (All Sections)".into());
        let saved = exams_set(&dir, vec![exam("e2", "Final", "2026-12-14"), first]).unwrap();
        assert_eq!(saved[0].title, "Test 1 (chapters 1–4)");
        assert_eq!(saved[0].course.as_deref(), Some("CSCI-C 241 Fall 2026 (All Sections)"));
        assert_eq!(saved[1].id, "e2");
        assert_eq!(exams_get(&dir).unwrap(), saved);
        let on_disk: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("study/exams.json")).unwrap()).unwrap();
        assert_eq!(on_disk[0]["date"], "2026-10-15");
        assert!(on_disk[1].get("course").is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bad_exams_are_refused_and_nothing_is_written() {
        let dir = space("bad-exams");
        let mut bad_course = exam("e1", "Test", "2026-10-15");
        bad_course.course = Some("../work".into());
        for (bad, why) in [
            (exam("e1", "", "2026-10-15"), "needs a name"),
            (exam("e1", "Test", "2026-02-30"), "real date"),
            (exam("e1", "Test", "15/10/2026"), "real date"),
            (exam("e1", "Test", "1999-10-15"), "real date"),
            (exam("../x", "Test", "2026-10-15"), "id"),
            (exam("e1", &"x".repeat(121), "2026-10-15"), "at most"),
            (bad_course, "course"),
        ] {
            let err = exams_set(&dir, vec![bad]).unwrap_err();
            assert!(err.contains(why), "{err}");
        }
        assert!(exams_set(&dir, vec![exam("a", "One", "2026-10-15"), exam("a", "Two", "2026-10-16")]).is_err());
        assert!(valid_date("2028-02-29") && !valid_date("2026-02-29") && !valid_date("2026-13-01"));
        assert!(!dir.join("study").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_hand_edited_exams_file_keeps_its_good_entries() {
        let dir = space("hand");
        fs::create_dir_all(dir.join("study")).unwrap();
        fs::write(
            dir.join("study/exams.json"),
            r#"[{"id":"x1","title":"Midterm","date":"2026-11-02"},{"id":"x2","title":"","date":"2026-11-03"},{"title":"no id"},7]"#,
        )
        .unwrap();
        let got = exams_get(&dir).unwrap();
        assert_eq!(got, vec![exam("x1", "Midterm", "2026-11-02")]);
        fs::write(dir.join("study/exams.json"), "{ broken").unwrap();
        assert!(exams_get(&dir).unwrap_err().contains("damaged"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_are_never_followed() {
        let dir = space("links");
        let outside = space("links-outside");
        fs::write(outside.join("exams.json"), r#"[{"id":"x","title":"Secret","date":"2026-11-02"}]"#).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("study")).unwrap();
        assert!(exams_get(&dir).is_err());
        assert!(exams_set(&dir, vec![exam("a", "One", "2026-10-15")]).is_err());
        assert!(save_plan(&dir, "# Plan").is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "nothing written through the link");
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn the_plan_and_its_state_are_saved() {
        let dir = space("plan");
        assert_eq!(save_plan(&dir, "# Study plan\n\n- [ ] Mon: review\n").unwrap(), "study/plan.md");
        assert!(fs::read_to_string(dir.join("study/plan.md")).unwrap().starts_with("# Study plan"));
        assert!(save_plan(&dir, &"x".repeat(MAX_PLAN + 1)).is_err());

        assert_eq!(state_get(&dir), PlanState::default());
        let s = PlanState { study_days: vec![5, 1, 1, 3], sessions_per_day: 2, session_minutes: 30, done: vec!["a".into(), "a".into()] };
        let saved = state_set(&dir, s).unwrap();
        assert_eq!(saved.study_days, vec![1, 3, 5]);
        assert_eq!(saved.done, vec!["a".to_string()]);
        assert_eq!(state_get(&dir), saved);
        for bad in [
            PlanState { study_days: vec![], ..PlanState::default() },
            PlanState { study_days: vec![7], ..PlanState::default() },
            PlanState { sessions_per_day: 0, ..PlanState::default() },
            PlanState { session_minutes: 5, ..PlanState::default() },
        ] {
            assert!(state_set(&dir, bad).is_err());
        }
        assert_eq!(state_get(&dir), saved, "a refused change keeps what was saved");
        fs::write(dir.join(".phaethon/study/plan.json"), "{ broken").unwrap();
        assert_eq!(state_get(&dir), PlanState::default());
        fs::remove_dir_all(dir).unwrap();
    }
}
