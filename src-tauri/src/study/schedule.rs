//! Confidence-based repetition (Brainscape style) with SM-2-like intervals.
//!
//! After seeing the answer the person rates how well they knew it, 1 ("Not at
//! all") to 5 ("Perfectly"). 1 and 2 come back in the same session (the UI
//! puts 1 about 3 cards later and 2 about 8 later) and soon across days; 3–5
//! push the card out further each time, by an ease factor that grows with 5s
//! and shrinks with 1–3. When the deck's course has an exam coming, no card is
//! scheduled past the day before it: one that would be is brought back about
//! halfway to the exam, so every card is seen again before it.
//!
//! All times are ms since the epoch; the clock is always passed in, so tests
//! run on a fake one.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const MINUTE: u64 = 60_000;
pub const HOUR: u64 = 60 * MINUTE;
pub const DAY: u64 = 24 * HOUR;
const EASE_START: f64 = 2.5;
const EASE_MIN: f64 = 1.3;
const EASE_MAX: f64 = 3.2;
const INTERVAL_MAX_DAYS: f64 = 365.0;
const HISTORY: usize = 8;
/// "Recently" for mastery: the last rating counts for this long.
const MASTERY_WINDOW: u64 = 30 * DAY;
/// The latest a card may be due before an exam.
const EXAM_MARGIN: u64 = 12 * HOUR;
/// Never sooner than this when an exam pulls a card forward.
const EXAM_FLOOR: u64 = 30 * MINUTE;

/// One card's scheduling state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardState {
    /// Successful reviews in a row (3 or better).
    pub reps: u32,
    /// Times a learned card was rated 1.
    pub lapses: u32,
    pub ease: f64,
    /// The last interval, in days (0 for a card still being learned).
    pub interval: f64,
    pub due: u64,
    pub last: u64,
    /// The last few ratings, oldest first.
    pub history: Vec<u8>,
}

impl CardState {
    pub fn last_confidence(&self) -> Option<u8> {
        self.history.last().copied()
    }
}

/// `<space>/.phaethon/study/progress.json`: card states by deck path and card
/// id, and the days (local, as days since the epoch) something was studied.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Progress {
    pub version: u32,
    pub decks: BTreeMap<String, BTreeMap<String, CardState>>,
    pub days: BTreeSet<i64>,
}

/// The new state after a rating, and whether the card comes back this session.
/// `exam` is the start of the deck's next exam, if it has one.
pub fn rate(prev: Option<&CardState>, confidence: u8, now: u64, exam: Option<u64>) -> (CardState, bool) {
    let c = confidence.clamp(1, 5);
    let mut s = prev.cloned().unwrap_or(CardState { reps: 0, lapses: 0, ease: EASE_START, interval: 0.0, due: now, last: now, history: vec![] });
    let prev_interval = s.interval;
    let (interval_days, wait) = match c {
        1 => {
            if s.reps > 0 || prev_interval >= 1.0 {
                s.lapses += 1;
            }
            s.reps = 0;
            s.ease -= 0.20;
            (0.0, 10 * MINUTE)
        }
        2 => {
            s.reps = 0;
            s.ease -= 0.15;
            // Known once, shaky now: start again from a day, never from where it was.
            (1.0, 0)
        }
        _ => {
            s.reps += 1;
            let (first, second, factor, ease_step) = match c {
                3 => (1.0, 3.0, 0.85, -0.05),
                4 => (3.0, 7.0, 1.0, 0.0),
                _ => (5.0, 12.0, 1.3, 0.10),
            };
            s.ease += ease_step;
            let next = match s.reps {
                1 => first,
                2 => second,
                _ => prev_interval.max(first) * s.ease.clamp(EASE_MIN, EASE_MAX) * factor,
            };
            // A good rating never shortens the interval.
            let next = if c >= 4 { next.max(prev_interval + 1.0) } else { next };
            (next.min(INTERVAL_MAX_DAYS), 0)
        }
    };
    s.ease = s.ease.clamp(EASE_MIN, EASE_MAX);
    s.interval = interval_days;
    let mut due = now + if wait > 0 { wait } else { (interval_days * DAY as f64) as u64 };
    if let Some(exam) = exam.filter(|e| *e > now) {
        let latest = exam.saturating_sub(EXAM_MARGIN);
        if due > latest {
            due = now + (latest.saturating_sub(now) / 2).max(EXAM_FLOOR);
        }
    }
    s.due = due;
    s.last = now;
    s.history.push(c);
    if s.history.len() > HISTORY {
        s.history.remove(0);
    }
    (s, c <= 2)
}

/// Share of `card_ids` last rated 4 or 5 within the last 30 days.
pub fn mastery(states: Option<&BTreeMap<String, CardState>>, card_ids: &[String], now: u64) -> f64 {
    if card_ids.is_empty() {
        return 0.0;
    }
    let Some(states) = states else { return 0.0 };
    let known = card_ids
        .iter()
        .filter_map(|id| states.get(id))
        .filter(|s| s.last_confidence().is_some_and(|c| c >= 4) && now.saturating_sub(s.last) <= MASTERY_WINDOW)
        .count();
    known as f64 / card_ids.len() as f64
}

/// Days in a row, ending today (or yesterday, when nothing's been studied yet
/// today), with at least one card rated.
pub fn streak(days: &BTreeSet<i64>, today: i64) -> u32 {
    let mut day = if days.contains(&today) { today } else { today - 1 };
    let mut n = 0;
    while days.contains(&day) {
        n += 1;
        day -= 1;
    }
    n
}

// ---- Local days and exams ----------------------------------------------------

/// Seconds east of UTC for this computer's time zone at `ms`.
pub fn local_offset_secs(ms: u64) -> i64 {
    #[cfg(unix)]
    {
        let t = (ms / 1000) as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r writes only into `tm`, which outlives the call.
        if !unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
            return tm.tm_gmtoff as i64;
        }
    }
    let _ = ms;
    0
}

/// The local day `ms` falls on, as days since 1970-01-01.
pub fn local_day(ms: u64, offset_secs: i64) -> i64 {
    (ms as i64 / 1000 + offset_secs).div_euclid(86_400)
}

/// An exam from `<space>/study/exams.json` (`[{ course?, title, date }]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Exam {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    #[serde(default)]
    pub title: String,
    pub date: String,
}

/// Start of an exam in ms: a date alone ("2026-10-15") is local midnight; a
/// time without a zone is local too.
pub fn exam_start(date: &str, offset_secs: i64) -> Option<u64> {
    let d = date.trim();
    let tail = d.get(11..).unwrap_or("");
    let has_zone = tail.ends_with(['Z', 'z']) || tail.contains(['+', '-']);
    let secs = crate::lms::store::parse_time(d)?;
    let secs = if has_zone { secs } else { secs - offset_secs };
    u64::try_from(secs).ok().map(|s| s * 1000)
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Whether an exam's course names the deck's course. Either may be the short
/// code ("CSCI-C 241") or the folder name ("CSCI-C 241 Fall 2026 (All Sections)").
pub fn same_course(exam_course: &str, deck_course: &str) -> bool {
    let (a, b) = (squash(exam_course), squash(deck_course));
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
}

/// The start of the next exam for a deck of `course`: an exam naming that
/// course, or one naming no course (it applies to every deck).
pub fn next_exam(exams: &[Exam], course: Option<&str>, now: u64, offset_secs: i64) -> Option<u64> {
    exams
        .iter()
        .filter(|e| match (e.course.as_deref().filter(|c| !c.trim().is_empty()), course) {
            (None, _) => true,
            (Some(ec), Some(dc)) => same_course(ec, dc),
            (Some(_), None) => false,
        })
        .filter_map(|e| exam_start(&e.date, offset_secs))
        .filter(|t| *t > now)
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_791_000_000_000; // a fixed "now", in October 2026

    /// Rate a new card through `ratings`, one review each time it falls due.
    fn run(ratings: &[u8], exam: Option<u64>) -> Vec<(CardState, bool)> {
        let mut out: Vec<(CardState, bool)> = vec![];
        let mut now = T0;
        for &r in ratings {
            let prev = out.last().map(|(s, _)| s.clone());
            if let Some(p) = &prev {
                now = p.due;
            }
            out.push(rate(prev.as_ref(), r, now, exam));
        }
        out
    }

    #[test]
    fn low_ratings_come_back_this_session_and_soon() {
        let (s, again) = rate(None, 1, T0, None);
        assert!(again);
        assert_eq!(s.due, T0 + 10 * MINUTE);
        let (s, again) = rate(None, 2, T0, None);
        assert!(again);
        assert_eq!(s.due, T0 + DAY);
        for c in 3..=5 {
            assert!(!rate(None, c, T0, None).1, "{c}");
        }
    }

    #[test]
    fn intervals_grow_with_confidence_and_history() {
        let fives = run(&[5, 5, 5, 5], None);
        let fours = run(&[4, 4, 4, 4], None);
        let threes = run(&[3, 3, 3, 3], None);
        let days = |v: &[(CardState, bool)]| v.iter().map(|(s, _)| s.interval).collect::<Vec<_>>();
        let (f5, f4, f3) = (days(&fives), days(&fours), days(&threes));
        // Each rating sequence grows...
        for v in [&f5, &f4, &f3] {
            assert!(v.windows(2).all(|w| w[1] > w[0]), "{v:?}");
        }
        // ...and higher confidence means longer gaps at every step.
        for i in 0..4 {
            assert!(f5[i] > f4[i] && f4[i] > f3[i], "step {i}: {f5:?} {f4:?} {f3:?}");
        }
        assert_eq!((f4[0], f4[1]), (3.0, 7.0));
        assert!(fives.last().unwrap().0.ease > EASE_START && threes.last().unwrap().0.ease < EASE_START);
        // Never past a year.
        let many = run(&[5; 20], None);
        assert!(many.last().unwrap().0.interval <= INTERVAL_MAX_DAYS);
    }

    #[test]
    fn forgetting_resets_and_counts_a_lapse() {
        let v = run(&[4, 4, 4, 1], None);
        let (s, again) = &v[3];
        assert!(again);
        assert_eq!((s.reps, s.lapses, s.interval), (0, 1, 0.0));
        assert!(s.ease < EASE_START);
        // Relearning starts small again.
        let (s2, _) = rate(Some(s), 4, s.due, None);
        assert_eq!(s2.interval, 3.0);
        // A 1 on a brand-new card isn't a lapse.
        assert_eq!(rate(None, 1, T0, None).0.lapses, 0);
        // Ease never drops below the floor.
        let low = run(&[1; 30], None);
        assert!((low.last().unwrap().0.ease - EASE_MIN).abs() < 1e-9);
        assert_eq!(low.last().unwrap().0.history.len(), HISTORY);
    }

    #[test]
    fn an_exam_caps_every_interval_before_it() {
        let exam = T0 + 5 * DAY;
        let v = run(&[5, 5, 5, 5, 5, 5], Some(exam));
        for (s, _) in &v {
            assert!(s.due <= exam - EXAM_MARGIN || s.due - s.last == EXAM_FLOOR, "due {} after the exam cap", s.due);
            assert!(s.due < exam);
        }
        // Without the exam the second review would be 12 days out.
        assert_eq!(run(&[5, 5], None)[1].0.interval, 12.0);
        // After the exam, intervals are free again.
        let (s, _) = rate(None, 5, exam + DAY, Some(exam));
        assert_eq!(s.due, exam + DAY + 5 * DAY);
        // An exam in a few hours: still before it, never sooner than the floor.
        let soon = T0 + 3 * HOUR;
        let (s, _) = rate(None, 5, T0, Some(soon));
        assert_eq!(s.due, T0 + EXAM_FLOOR);
    }

    #[test]
    fn mastery_counts_recent_fours_and_fives() {
        let ids: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), rate(None, 5, T0, None).0);
        m.insert("b".to_string(), rate(None, 4, T0, None).0);
        m.insert("c".to_string(), rate(None, 2, T0, None).0);
        assert_eq!(mastery(Some(&m), &ids, T0), 0.5);
        // Old ratings stop counting.
        assert_eq!(mastery(Some(&m), &ids, T0 + 31 * DAY), 0.0);
        assert_eq!(mastery(None, &ids, T0), 0.0);
        assert_eq!(mastery(Some(&m), &[], T0), 0.0);
    }

    #[test]
    fn streaks() {
        let days: BTreeSet<i64> = [10, 11, 12, 14].into();
        assert_eq!(streak(&days, 14), 1);
        assert_eq!(streak(&days, 13), 3, "nothing yet today: yesterday's run still counts");
        assert_eq!(streak(&days, 12), 3);
        assert_eq!(streak(&days, 16), 0);
        assert_eq!(local_day(DAY * 3 + 1, 0), 3);
        assert_eq!(local_day(DAY * 3 + 1, -3600), 2);
    }

    #[test]
    fn exams_match_their_course_and_dates_are_local() {
        let exams = vec![
            Exam { course: Some("CSCI-C 241".into()), title: "Test 1".into(), date: "2026-10-15".into() },
            Exam { course: Some("MATH-M 301".into()), title: "Exam".into(), date: "2026-10-21T14:00".into() },
            Exam { course: None, title: "Finals".into(), date: "2026-12-14".into() },
            Exam { course: None, title: "bad".into(), date: "soon".into() },
        ];
        let off = -4 * 3600; // EDT
        let now = exam_start("2026-10-10T12:00:00Z", 0).unwrap();
        let c241 = next_exam(&exams, Some("CSCI-C 241 Fall 2026 (All Sections)"), now, off).unwrap();
        assert_eq!(c241, exam_start("2026-10-15T04:00:00Z", 0).unwrap(), "local midnight");
        // An exam without a course applies to every deck.
        assert_eq!(next_exam(&exams, Some("FA26- LINEAR ALGEBRA & APPLICATIONS- 11179"), now, off), exam_start("2026-12-14T04:00:00Z", 0));
        assert_eq!(next_exam(&exams, None, now, off), exam_start("2026-12-14T04:00:00Z", 0));
        assert_eq!(next_exam(&exams, Some("MATH-M 301"), now, off), exam_start("2026-10-21T18:00:00Z", 0));
        assert_eq!(exam_start("2026-10-21T14:00:00-04:00", 99), exam_start("2026-10-21T18:00:00Z", 0));
        // Past exams don't count.
        assert_eq!(next_exam(&exams[..1], Some("CSCI-C 241"), c241 + 1, off), None);
        assert!(!same_course("", "x") && same_course("csci c241", "CSCI-C 241 Fall"));
    }
}
