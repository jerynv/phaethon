//! Quizzes (`<space>/study/quizzes/<Title>.json`) and grading every kind but
//! short answers, which the model grades (generate.rs).

use serde::{Deserialize, Serialize};

pub const KINDS: [&str; 5] = ["choice", "multi", "truefalse", "short", "cloze"];
pub const QUESTIONS_MAX: usize = 100;
const PROMPT_MAX: usize = 2_000;
const CHOICE_MAX: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quiz {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course: Option<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    /// When it was made, ms since the epoch.
    #[serde(default)]
    pub created: u64,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// Given when missing ("q1", "q2"...).
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    /// choice / truefalse / short / cloze: a string ("true"/"false" for
    /// truefalse); multi: every right choice.
    pub answer: Answer,
    /// cloze only: other answers that also count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<Vec<String>>,
    #[serde(default)]
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// An answer: one string or several. A hand-written `true`/`false` reads as text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Answer {
    One(String),
    Many(Vec<String>),
    Bool(bool),
}

impl Answer {
    pub fn one(&self) -> Option<String> {
        match self {
            Answer::One(s) => Some(s.clone()),
            Answer::Bool(b) => Some(b.to_string()),
            Answer::Many(v) if v.len() == 1 => Some(v[0].clone()),
            Answer::Many(_) => None,
        }
    }
    pub fn many(&self) -> Vec<String> {
        match self {
            Answer::Many(v) => v.clone(),
            Answer::One(s) => vec![s.clone()],
            Answer::Bool(b) => vec![b.to_string()],
        }
    }
    pub fn text(&self) -> String {
        match self {
            Answer::Many(v) => v.join(", "),
            other => other.one().unwrap_or_default(),
        }
    }
}

/// The result for one question in an attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResult {
    pub id: String,
    pub correct: bool,
    /// Partial credit, 0..1, when it was neither right nor wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<f64>,
    pub given: Answer,
    pub expected: Answer,
    /// Plain words: right or not, why, and where it's from.
    pub feedback: String,
    /// A short answer that couldn't be graded (no model); left out of the score.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ungraded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    /// This attempt's own file, relative to the space.
    pub path: String,
    /// The quiz's path.
    pub quiz: String,
    pub taken: u64,
    /// 0..1 over the graded questions.
    pub score: f64,
    pub results: Vec<QuestionResult>,
}

pub fn score(results: &[QuestionResult]) -> f64 {
    let graded: Vec<&QuestionResult> = results.iter().filter(|r| !r.ungraded).collect();
    if graded.is_empty() {
        return 0.0;
    }
    let sum: f64 = graded.iter().map(|r| if r.correct { 1.0 } else { r.partial.unwrap_or(0.0) }).sum();
    sum / graded.len() as f64
}

/// Normalise a quiz as read (a hand-written `true` answer becomes "true"; a
/// truefalse question gets its two choices) and check it, in plain words.
pub fn normalize(quiz: &mut Quiz) -> Result<(), String> {
    if quiz.title.trim().is_empty() {
        return Err("The quiz needs a title.".into());
    }
    if quiz.questions.is_empty() {
        return Err("The quiz has no questions.".into());
    }
    if quiz.questions.len() > QUESTIONS_MAX {
        return Err(format!("A quiz can hold up to {QUESTIONS_MAX} questions."));
    }
    let mut ids = std::collections::HashSet::new();
    for (i, q) in quiz.questions.iter_mut().enumerate() {
        let n = i + 1;
        if q.id.trim().is_empty() {
            q.id = format!("q{n}");
        }
        if !ids.insert(q.id.clone()) {
            return Err(format!("Two questions share the id \"{}\".", q.id));
        }
        check_question(q).map_err(|e| format!("Question {n}: {e}"))?;
    }
    Ok(())
}

/// One question's shape, fixing what can be fixed (`true` -> "true").
pub fn check_question(q: &mut Question) -> Result<(), String> {
    if !KINDS.contains(&q.kind.as_str()) {
        return Err(format!("\"{}\" isn't a kind of question (use one of {}).", q.kind, KINDS.join(", ")));
    }
    if let Answer::Bool(b) = q.answer {
        q.answer = Answer::One(b.to_string());
    }
    let prompt = q.prompt.trim();
    if prompt.is_empty() {
        return Err("it has no question.".into());
    }
    if prompt.chars().count() > PROMPT_MAX {
        return Err("the question is too long.".into());
    }
    let choices = q.choices.clone().unwrap_or_default();
    let in_choices = |a: &str| choices.iter().any(|c| c.trim() == a.trim());
    match q.kind.as_str() {
        "choice" | "multi" => {
            if choices.len() < 2 || choices.len() > 8 {
                return Err("it needs between 2 and 8 choices.".into());
            }
            if choices.iter().any(|c| c.trim().is_empty() || c.chars().count() > CHOICE_MAX) {
                return Err("a choice is empty or too long.".into());
            }
            let mut uniq: Vec<String> = choices.iter().map(|c| c.trim().to_lowercase()).collect();
            uniq.sort();
            uniq.dedup();
            if uniq.len() != choices.len() {
                return Err("two choices are the same.".into());
            }
            if q.kind == "choice" {
                let a = q.answer.one().ok_or("a choice question has exactly one answer.")?;
                if !in_choices(&a) {
                    return Err(format!("the answer \"{a}\" isn't one of its choices."));
                }
                q.answer = Answer::One(a.trim().to_string());
            } else {
                let a = q.answer.many();
                if a.is_empty() {
                    return Err("it has no right answer.".into());
                }
                if let Some(bad) = a.iter().find(|x| !in_choices(x)) {
                    return Err(format!("the answer \"{bad}\" isn't one of its choices."));
                }
                q.answer = Answer::Many(a.iter().map(|x| x.trim().to_string()).collect());
            }
        }
        "truefalse" => {
            let a = q.answer.one().map(|a| a.trim().to_lowercase()).ok_or("a true or false question has one answer.")?;
            let a = match a.as_str() {
                "true" | "t" => "true",
                "false" | "f" => "false",
                _ => return Err("the answer must be true or false.".into()),
            };
            q.answer = Answer::One(a.into());
            q.choices = Some(vec!["true".into(), "false".into()]);
        }
        _ => {
            let a = q.answer.one().ok_or("it has one answer, not a list.")?;
            if a.trim().is_empty() {
                return Err("it has no answer.".into());
            }
            if q.kind == "cloze" && !(prompt.contains("___") || prompt.contains("{{")) {
                return Err("a fill-in question needs a blank (___) in it.".into());
            }
            q.choices = None;
        }
    }
    Ok(())
}

// ---- Grading -------------------------------------------------------------------

/// Lower-case words and numbers only, for comparing typed answers.
pub fn norm(s: &str) -> String {
    let lower = s.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_alphanumeric() || matches!(c, '.' | '-' | '^' | '/' | '∩' | '∪' | '→' | '¬' | '∧' | '∨' | '∈' | '⊆')))
        .map(|w| w.trim_matches(['.', '-']))
        .filter(|w| !w.is_empty() && !matches!(*w, "a" | "an" | "the"))
        .collect();
    words.join(" ")
}

fn same_number(a: &str, b: &str) -> bool {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(x), Ok(y)) => (x - y).abs() < 1e-9,
        _ => false,
    }
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Where the explanation comes from, for feedback: " (From Test 1 Review - C241 Fa26.pdf.)"
fn from(q: &Question) -> String {
    q.source
        .as_deref()
        .map(|s| s.rsplit('/').next().unwrap_or(s))
        .map(|f| format!(" (From {f}.)"))
        .unwrap_or_default()
}

fn feedback(q: &Question, verdict: &str) -> String {
    let expl = q.explanation.trim();
    let mut s = verdict.to_string();
    if !expl.is_empty() {
        s.push(' ');
        s.push_str(expl);
    }
    s.push_str(&from(q));
    s
}

/// Grade a question in Rust; `None` for a short answer (the model grades those).
pub fn grade(q: &Question, given: &Answer) -> Option<QuestionResult> {
    let expected = q.answer.clone();
    let result = |correct: bool, partial: Option<f64>, verdict: String| QuestionResult {
        id: q.id.clone(),
        correct,
        partial,
        given: given.clone(),
        expected: expected.clone(),
        feedback: feedback(q, &verdict),
        ungraded: false,
    };
    let blank = given.many().iter().all(|g| g.trim().is_empty());
    if blank {
        return Some(result(false, None, format!("No answer given. The answer is {}.", expected.text())));
    }
    match q.kind.as_str() {
        "choice" | "truefalse" => {
            let g = given.one().unwrap_or_default();
            let a = expected.one().unwrap_or_default();
            let ok = g.trim().eq_ignore_ascii_case(a.trim());
            Some(if ok { result(true, None, "Right.".into()) } else { result(false, None, format!("Not quite: the answer is {a}.")) })
        }
        "multi" => {
            let right: Vec<String> = expected.many().iter().map(|s| s.trim().to_lowercase()).collect();
            let picked: Vec<String> = given.many().iter().map(|s| s.trim().to_lowercase()).collect();
            let hits = picked.iter().filter(|p| right.contains(p)).count();
            let wrong = picked.iter().filter(|p| !right.contains(p)).count();
            if hits == right.len() && wrong == 0 {
                return Some(result(true, None, "Right: you picked every one.".into()));
            }
            let credit = ((hits as f64 - wrong as f64) / right.len() as f64).max(0.0);
            let missed = right.len() - hits;
            let mut why = vec![];
            if missed > 0 {
                why.push(format!("missed {missed}"));
            }
            if wrong > 0 {
                why.push(format!("picked {wrong} that {}", if wrong == 1 { "isn’t right" } else { "aren’t right" }));
            }
            Some(result(false, (credit > 0.0).then_some(credit), format!("Partly: you {}. The right ones are {}.", why.join(" and "), expected.text())))
        }
        "cloze" => {
            let g = given.one().unwrap_or_else(|| given.text());
            let mut accepted = expected.many();
            accepted.extend(q.accept.clone().unwrap_or_default());
            let gn = norm(&g);
            let exact = accepted.iter().any(|a| norm(a) == gn || same_number(a, &g));
            if exact {
                return Some(result(true, None, "Right.".into()));
            }
            let close = accepted.iter().any(|a| {
                let an = norm(a);
                an.chars().count() >= 6 && edit_distance(&an, &gn) <= 1
            });
            Some(if close {
                result(true, None, format!("Right (check the spelling: {}).", expected.text()))
            } else {
                result(false, None, format!("Not quite: the answer is {}.", expected.text()))
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(kind: &str, choices: Option<&[&str]>, answer: Answer) -> Question {
        Question {
            id: "q1".into(),
            kind: kind.into(),
            prompt: "Which ___ is it?".into(),
            choices: choices.map(|c| c.iter().map(|s| s.to_string()).collect()),
            answer,
            accept: None,
            explanation: "Because the notes say so.".into(),
            source: Some("courses/C241/files/Notes/notes.pdf".into()),
        }
    }
    fn one(s: &str) -> Answer {
        Answer::One(s.into())
    }

    #[test]
    fn choice_and_truefalse() {
        let c = q("choice", Some(&["A set", "A graph", "A tree"]), one("A graph"));
        let r = grade(&c, &one("a graph")).unwrap();
        assert!(r.correct);
        assert_eq!(r.feedback, "Right. Because the notes say so. (From notes.pdf.)");
        let r = grade(&c, &one("A set")).unwrap();
        assert!(!r.correct && r.feedback.starts_with("Not quite: the answer is A graph."));
        let mut tf = q("truefalse", None, Answer::Bool(true));
        check_question(&mut tf).unwrap();
        assert_eq!(tf.answer, one("true"));
        assert!(grade(&tf, &one("True")).unwrap().correct);
        assert!(!grade(&tf, &one("false")).unwrap().correct);
        assert!(!grade(&tf, &one("  ")).unwrap().feedback.is_empty());
    }

    #[test]
    fn multi_gives_partial_credit() {
        let m = q("multi", Some(&["1", "2", "3", "4"]), Answer::Many(vec!["1".into(), "2".into(), "3".into()]));
        assert!(grade(&m, &Answer::Many(vec!["3".into(), "1".into(), "2".into()])).unwrap().correct);
        let r = grade(&m, &Answer::Many(vec!["1".into(), "2".into()])).unwrap();
        assert!(!r.correct);
        assert!((r.partial.unwrap() - 2.0 / 3.0).abs() < 1e-9);
        assert!(r.feedback.contains("missed 1"));
        let r = grade(&m, &Answer::Many(vec!["1".into(), "4".into()])).unwrap();
        assert_eq!(r.partial, None, "one right, one wrong: nothing");
        assert!(r.feedback.contains("picked 1 that isn’t right"));
    }

    #[test]
    fn cloze_forgives_case_articles_numbers_and_one_typo() {
        let mut c = q("cloze", None, one("the chromatic number"));
        c.accept = Some(vec!["χ(G)".into()]);
        for ok in ["Chromatic Number", "chromatic  number.", "chromatc number", "χ(G)"] {
            assert!(grade(&c, &one(ok)).unwrap().correct, "{ok}");
        }
        assert!(!grade(&c, &one("clique number")).unwrap().correct);
        let n = q("cloze", None, one("2"));
        assert!(grade(&n, &one("2.0")).unwrap().correct);
        assert!(!grade(&n, &one("3")).unwrap().correct, "short answers get no typo slack");
        assert!(grade(&q("short", None, one("x")), &one("y")).is_none());
    }

    #[test]
    fn validation_says_what_is_wrong() {
        let mut bad = Quiz { title: "t".into(), course: None, sources: vec![], created: 0, questions: vec![q("choice", Some(&["a", "b"]), one("c"))] };
        assert!(normalize(&mut bad).unwrap_err().contains("isn't one of its choices"));
        bad.questions[0] = q("essay", None, one("x"));
        assert!(normalize(&mut bad).unwrap_err().contains("isn't a kind"));
        bad.questions[0] = q("multi", Some(&["a", "A "]), Answer::Many(vec!["a".into()]));
        assert!(normalize(&mut bad).unwrap_err().contains("two choices are the same"));
        bad.questions[0] = q("cloze", None, one("x"));
        bad.questions[0].prompt = "no blank".into();
        assert!(normalize(&mut bad).unwrap_err().contains("blank"));
        // A hand-written quiz with no ids gets them, and reads back as written.
        let text = r#"{"title":"T","questions":[{"kind":"truefalse","prompt":"p?","answer":false},{"id":"","kind":"short","prompt":"Why?","answer":"Because."}]}"#;
        let mut quiz: Quiz = serde_json::from_str(text).unwrap();
        normalize(&mut quiz).unwrap();
        assert_eq!(quiz.questions.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), ["q1", "q2"]);
        let back: Quiz = serde_json::from_str(&serde_json::to_string(&quiz).unwrap()).unwrap();
        assert_eq!(back, quiz);
    }

    #[test]
    fn score_leaves_out_ungraded() {
        let r = |correct, partial, ungraded| QuestionResult { id: "x".into(), correct, partial, given: one(""), expected: one(""), feedback: String::new(), ungraded };
        assert_eq!(score(&[r(true, None, false), r(false, Some(0.5), false), r(false, None, true)]), 0.75);
        assert_eq!(score(&[r(false, None, true)]), 0.0);
    }
}
