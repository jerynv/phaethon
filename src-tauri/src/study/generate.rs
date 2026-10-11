//! Making decks and quizzes from course material, grading short answers and
//! reviewing a quiz's mistakes, all through one model call each (model.rs).
//! The model is asked for strict JSON, which is checked before anything is
//! written; a bad answer is retried once and then refused whole.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::deck::{self, Deck, Note};
use super::model::{Model, ask_json};
use super::quiz::{self, Answer, Attempt, Question, QuestionResult, Quiz};
use super::sources::{self, Material};

pub const CARDS_MAX: usize = 100;
pub const QUESTIONS_MAX: usize = 50;
/// Most existing fronts shown to the model so it doesn't repeat them.
const EXISTING_MAX: usize = 150;

/// Streamed by the make, submit and review commands; ends with exactly one
/// `done` or `error`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StudyEvent {
    /// `step`: "reading" (the material), "making" (the model writes),
    /// "saving", "grading" or "reviewing".
    Progress { step: &'static str, done: usize, total: usize },
    Done(Finished),
    Error { message: String },
}

/// What a `done` event carries: whichever fields the command fills.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cards: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<Attempt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deck_path: Option<String>,
}

fn progress(step: &'static str, done: usize, total: usize) -> StudyEvent {
    StudyEvent::Progress { step, done, total }
}

pub type Emit<'a> = &'a (dyn Fn(StudyEvent) + Send + Sync);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckOptions {
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// A quiz attempt's path: make cards from what it got wrong.
    #[serde(default)]
    pub from_attempt: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizOptions {
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub difficulty: Option<String>,
    /// What to concentrate on ("test 1", "chapter 3"), as for decks.
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

// ---- Shared ------------------------------------------------------------------------

fn words(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Same card in other words: equal words, or nearly all the same words.
pub fn similar(a: &str, b: &str) -> bool {
    let (wa, wb) = (words(a), words(b));
    if wa == wb {
        return true;
    }
    let (sa, sb): (HashSet<&String>, HashSet<&String>) = (wa.iter().collect(), wb.iter().collect());
    let (inter, union) = (sa.intersection(&sb).count(), sa.union(&sb).count());
    sa.len() >= 4 && sb.len() >= 4 && union > 0 && inter as f64 / union as f64 >= 0.8
}

fn str_field(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// The cited source mapped onto the material's labels, or an error naming them.
fn cited(v: &Value, m: &Material, what: &str) -> Result<String, String> {
    let s = str_field(v, "source");
    sources::match_label(&s, &m.labels).ok_or_else(|| {
        format!("{what} cites \"{s}\", which isn't one of the sources; \"source\" must be one of: {}", m.labels.join(", "))
    })
}

fn items<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v.get(key).and_then(Value::as_array).or_else(|| v.as_array()).ok_or_else(|| format!("expected an object with a \"{key}\" array"))
}

fn material_block(m: &Material) -> String {
    format!("<material>\n{}\n</material>", m.text)
}

fn file_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// What an attempt got wrong: (question, result), graded ones only.
fn mistakes(quiz: &Quiz, attempt: &Attempt) -> Vec<(Question, QuestionResult)> {
    attempt
        .results
        .iter()
        .filter(|r| !r.correct && !r.ungraded)
        .filter_map(|r| quiz.questions.iter().find(|q| q.id == r.id).map(|q| (q.clone(), r.clone())))
        .collect()
}

fn mistakes_block(list: &[(Question, QuestionResult)]) -> String {
    let mut s = String::from("<mistakes>\n");
    for (q, r) in list {
        s.push_str(&format!(
            "- Question: {}\n  Their answer: {}\n  Right answer: {}\n  Why: {}\n  Source: {}\n",
            q.prompt,
            if r.given.text().trim().is_empty() { "(blank)".to_string() } else { r.given.text() },
            q.answer.text(),
            q.explanation,
            q.source.as_deref().unwrap_or("unknown"),
        ));
    }
    s.push_str("</mistakes>");
    s
}

// ---- Decks -------------------------------------------------------------------------

pub const DECK_SYSTEM: &str = r#"You write flashcards for a student from their own course material.

Rules:
- One idea per card: a definition, a fact, a step of a method, a distinction, or how to apply a rule to a small example. Prefer cards that make the student recall or apply, not just recognise.
- Be accurate to the material. Never add facts it doesn't support. When the material is a problem set or review sheet, make cards on the concepts and techniques its problems test (a tiny worked example on the back helps), not on its instructions.
- Never make cards about course logistics: due dates, grading, submission rules, office hours, policies.
- The front stands on its own: no "in this problem", "the above" or "as shown". Fronts under 200 characters, backs under 300. Plain text; write math with Unicode symbols (→ ↔ ¬ ∧ ∨ ∀ ∃ ∈ ∉ ⊆ ⊂ ∩ ∪ ∅ ℕ ℤ ℝ ≤ ≥ ≠), never LaTeX.
- A card may instead be fill-in (cloze): a sentence in "front" with the key term in {{double braces}}, and "back" empty or a short note. Use it for terms and formulas, for at most a third of the cards.
- "source" is the path of the <source> the card came from, copied exactly.
- Don't repeat the cards the student already has (listed in <existing_cards>), even in other words.

Reply with only JSON, no prose: {"title": "a short deck title", "cards": [{"front": "...", "back": "...", "source": "..."}]}"#;

/// Check the model's cards: structure, sources, and no repeats of `existing`
/// or of each other (repeats are dropped, not errors).
pub fn check_cards(v: &Value, m: &Material, existing: &[String], count: usize) -> Result<(Option<String>, Vec<Note>), String> {
    let mut out: Vec<Note> = vec![];
    for (i, c) in items(v, "cards")?.iter().enumerate() {
        let n = i + 1;
        let note = Note { front: str_field(c, "front"), back: str_field(c, "back"), source: Some(cited(c, m, &format!("card {n}"))?) };
        if note.front.is_empty() {
            return Err(format!("card {n} has no front"));
        }
        if note.front.chars().count() > deck::FRONT_MAX || note.back.chars().count() > deck::BACK_MAX {
            return Err(format!("card {n} is too long"));
        }
        match note.kind() {
            deck::Kind::Cloze => {
                deck::cloze_answers(&note.front).map_err(|e| format!("card {n}: {e}"))?;
            }
            deck::Kind::Basic if note.back.is_empty() => return Err(format!("card {n} has no back")),
            deck::Kind::Basic if note.front.contains("}}") => return Err(format!("card {n} has a stray }}}}")),
            deck::Kind::Basic => {}
        }
        if existing.iter().chain(out.iter().map(|o| &o.front)).any(|e| similar(e, &note.front)) {
            continue;
        }
        out.push(note);
    }
    if out.is_empty() {
        return Err("there were no new cards: every card repeats one the student already has".into());
    }
    out.truncate(count);
    let title = Some(str_field(v, "title")).filter(|t| !t.is_empty());
    Ok((title, out))
}

/// Make a deck and save it. Returns its path and how many cards it has.
pub async fn make_deck<M: Model>(space: &Path, inputs: &[String], opts: &DeckOptions, model: &M, emit: Emit<'_>) -> Result<(String, usize), String> {
    let count = if opts.count == 0 { 20 } else { opts.count.min(CARDS_MAX) };
    let mut inputs = inputs.to_vec();
    let mut focus = opts.focus.clone().filter(|f| !f.trim().is_empty());
    let mut extra = String::new();
    let mut default_title = None;
    if let Some(a) = opts.from_attempt.as_deref() {
        let attempt = super::load_attempt(space, a)?;
        let (_, quiz) = super::load_quiz(space, &attempt.quiz)?;
        let missed = mistakes(&quiz, &attempt);
        if missed.is_empty() {
            return Err("You got everything right in that quiz, so there are no mistakes to make cards from.".into());
        }
        let cited: Vec<String> = missed.iter().filter_map(|(q, _)| q.source.clone()).collect();
        inputs.extend(if cited.is_empty() { quiz.sources.clone() } else { cited });
        inputs.dedup();
        if focus.is_none() {
            focus = Some(missed.iter().map(|(q, _)| q.prompt.as_str()).collect::<Vec<_>>().join(" "));
        }
        extra = format!(
            "\n\nThe student got these quiz questions wrong. Make the cards about the ideas behind them (what they misunderstood), not copies of the questions.\n{}",
            mistakes_block(&missed)
        );
        default_title = Some(format!("Mistakes from {}", quiz.title));
    }
    if inputs.is_empty() {
        return Err("Choose a course or some files to make cards from.".into());
    }
    emit(progress("reading", 0, 1));
    let material = sources::gather(space, &inputs, focus.as_deref(), sources::BUDGET)?;
    let existing = super::existing_fronts(space, material.course.as_deref());
    emit(progress("reading", 1, 1));

    let shown: Vec<&str> = existing.iter().rev().take(EXISTING_MAX).map(String::as_str).collect();
    let focus_line = opts.focus.as_deref().filter(|f| !f.trim().is_empty()).map(|f| format!(" Focus on: {f}.")).unwrap_or_default();
    let user = format!(
        "Make {count} flashcards from this material.{focus_line}\n\n{}\n\n<existing_cards>\n{}\n</existing_cards>{extra}",
        material_block(&material),
        if shown.is_empty() { "(none)".to_string() } else { shown.join("\n") },
    );
    emit(progress("making", 0, 1));
    let (title, notes) = ask_json(model, DECK_SYSTEM, &user, |v| check_cards(v, &material, &existing, count)).await?;
    emit(progress("making", 1, 1));
    emit(progress("saving", 0, 1));
    let title = opts.title.clone().filter(|t| !t.trim().is_empty()).or(default_title).or(title).unwrap_or_else(|| "New deck".into());
    let used: Vec<String> = material.labels.iter().filter(|l| notes.iter().any(|n| n.source.as_deref() == Some(l.as_str()))).cloned().collect();
    let d = Deck { title: title.trim().chars().take(deck::TITLE_MAX).collect(), course: material.course.clone(), sources: used, notes, ..Default::default() };
    let n = d.notes.len();
    let path = super::deck_create(space, &d)?;
    emit(progress("saving", 1, 1));
    Ok((path, n))
}

// ---- Quizzes ------------------------------------------------------------------------

pub const QUIZ_SYSTEM: &str = r#"You write a practice quiz for a student from their own course material.

Kinds of question (use only the kinds asked for, mixed):
- "choice": one right answer among 4 "choices". Distractors must be plausible: the mistakes students really make with this material, near-misses, the same length and style as the right answer. Never "all/none of the above". "answer" is the right choice's text, copied exactly.
- "multi": 2 or 3 right among 4 or 5 "choices"; the prompt ends "Select all that apply." "answer" is the list of right choices' texts.
- "truefalse": a statement; "answer" is "true" or "false". False statements are plausible misconceptions, never silly.
- "short": an open question answered in one to three sentences; "answer" is a model answer a grader can compare with.
- "cloze": a sentence with one blank written ___; "answer" is the missing word or symbol; "accept" lists other correct forms.

Difficulty: "easier" = recall of definitions and facts; "exam" = like the course's own exams and review sheets, applying ideas to new small examples; "harder" = several steps, combining ideas, edge cases.

Every question has "explanation" (one or two sentences: why the answer is right; for choice questions, why the tempting wrong one is wrong) and "source" (the path of the <source> it came from, copied exactly). Be accurate to the material; never test course logistics (dates, grading, policies). Plain text; math in Unicode symbols, never LaTeX.

Reply with only JSON, no prose: {"title": "a short quiz title", "questions": [{"kind": "...", "prompt": "...", "choices": ["..."], "answer": "...", "accept": ["..."], "explanation": "...", "source": "..."}]}"#;

/// A small deterministic shuffle (the model tends to put the answer first).
fn shuffle<T>(v: &mut [T], seed: &mut u64) {
    for i in (1..v.len()).rev() {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        v.swap(i, (*seed % (i as u64 + 1)) as usize);
    }
}

pub fn check_questions(v: &Value, m: &Material, kinds: &[String], count: usize, seed: u64) -> Result<(Option<String>, Vec<Question>), String> {
    let mut out = vec![];
    let mut seed = seed | 1;
    for (i, raw) in items(v, "questions")?.iter().enumerate() {
        let n = i + 1;
        let answer = match &raw["answer"] {
            Value::Array(a) => Answer::Many(a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()),
            Value::Bool(b) => Answer::One(b.to_string()),
            Value::Null => return Err(format!("question {n} has no answer")),
            other => Answer::One(other.as_str().map(String::from).unwrap_or_else(|| other.to_string())),
        };
        let list = |k: &str| raw[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).collect::<Vec<_>>());
        let mut q = Question {
            id: format!("q{}", out.len() + 1),
            kind: str_field(raw, "kind"),
            prompt: str_field(raw, "prompt"),
            choices: list("choices"),
            answer,
            accept: list("accept").filter(|a| !a.is_empty()),
            explanation: str_field(raw, "explanation"),
            source: Some(cited(raw, m, &format!("question {n}"))?),
        };
        if !kinds.contains(&q.kind) {
            return Err(format!("question {n} is a \"{}\" question, but only these kinds were asked for: {}", q.kind, kinds.join(", ")));
        }
        quiz::check_question(&mut q).map_err(|e| format!("question {n}: {e}"))?;
        if q.kind != "cloze" {
            q.accept = None;
        }
        if q.explanation.is_empty() {
            return Err(format!("question {n} has no explanation"));
        }
        if matches!(q.kind.as_str(), "choice" | "multi")
            && let Some(c) = q.choices.as_mut()
        {
            shuffle(c, &mut seed);
        }
        out.push(q);
    }
    if out.is_empty() {
        return Err("there were no questions".into());
    }
    out.truncate(count);
    Ok((Some(str_field(v, "title")).filter(|t| !t.is_empty()), out))
}

pub async fn make_quiz<M: Model>(space: &Path, inputs: &[String], opts: &QuizOptions, model: &M, emit: Emit<'_>, now: u64) -> Result<(String, usize), String> {
    let count = if opts.count == 0 { 10 } else { opts.count.min(QUESTIONS_MAX) };
    let mut kinds: Vec<String> = opts.kinds.iter().filter(|k| quiz::KINDS.contains(&k.as_str())).cloned().collect();
    kinds.dedup();
    if kinds.is_empty() {
        if !opts.kinds.is_empty() {
            return Err(format!("Choose kinds of question from: {}.", quiz::KINDS.join(", ")));
        }
        kinds = ["choice", "truefalse", "short"].map(String::from).to_vec();
    }
    let difficulty = match opts.difficulty.as_deref().unwrap_or("exam") {
        d @ ("easier" | "exam" | "harder") => d,
        _ => return Err("Difficulty is easier, exam or harder.".into()),
    };
    if inputs.is_empty() {
        return Err("Choose a course or some files to make the quiz from.".into());
    }
    emit(progress("reading", 0, 1));
    let material = sources::gather(space, inputs, opts.focus.as_deref(), sources::BUDGET)?;
    emit(progress("reading", 1, 1));
    let focus_line = opts.focus.as_deref().filter(|f| !f.trim().is_empty()).map(|f| format!(" Focus on: {f}.")).unwrap_or_default();
    let user = format!(
        "Make a quiz of {count} questions from this material. Kinds: {}. Difficulty: {difficulty}.{focus_line}\n\n{}",
        kinds.join(", "),
        material_block(&material)
    );
    emit(progress("making", 0, 1));
    let (title, questions) = ask_json(model, QUIZ_SYSTEM, &user, |v| check_questions(v, &material, &kinds, count, now)).await?;
    emit(progress("making", 1, 1));
    emit(progress("saving", 0, 1));
    let title = opts.title.clone().filter(|t| !t.trim().is_empty()).or(title).unwrap_or_else(|| "New quiz".into());
    let q = Quiz { title: title.trim().chars().take(deck::TITLE_MAX).collect(), course: material.course.clone(), sources: material.labels.clone(), created: now, questions };
    let n = q.questions.len();
    let path = super::quiz_create(space, &q)?;
    emit(progress("saving", 1, 1));
    Ok((path, n))
}

// ---- Grading ----------------------------------------------------------------------

pub const GRADE_SYSTEM: &str = r#"You grade a student's short answers on a practice quiz, against the model answer and explanation from their course.

Score each answer 0, 0.25, 0.5, 0.75 or 1: 1 = right (wording may differ), between = the right idea with parts missing or wrong, 0 = wrong, off topic or blank. Don't be stricter than the model answer, and don't reward length.
Feedback: one or two sentences in plain words to the student: what was right, then what is missing or wrong.

Reply with only JSON, no prose: {"grades": [{"id": "...", "score": 1, "feedback": "..."}]}"#;

fn check_grades(v: &Value, ids: &[String]) -> Result<Vec<(String, f64, String)>, String> {
    let mut out = vec![];
    for g in items(v, "grades")? {
        let id = str_field(g, "id");
        let score = g["score"].as_f64().ok_or_else(|| format!("the grade for {id} has no numeric score"))?;
        if !(0.0..=1.0).contains(&score) {
            return Err(format!("the score for {id} must be between 0 and 1"));
        }
        let feedback = str_field(g, "feedback");
        if feedback.is_empty() {
            return Err(format!("the grade for {id} has no feedback"));
        }
        out.push((id, score, feedback));
    }
    if let Some(missing) = ids.iter().find(|id| !out.iter().any(|(g, _, _)| g == *id)) {
        return Err(format!("there is no grade for question {missing}"));
    }
    Ok(out)
}

/// Grade an attempt and save it. Short answers go to the model (made only if
/// one needs grading); if there's none, they're marked ungraded with the
/// model answer to compare.
pub async fn submit<M: Model>(
    space: &Path,
    path: &str,
    answers: &std::collections::HashMap<String, Answer>,
    model: impl FnOnce() -> Result<M, String>,
    emit: Emit<'_>,
    now: u64,
) -> Result<Attempt, String> {
    let (rel, quiz) = super::load_quiz(space, path)?;
    let blank = Answer::One(String::new());
    let mut results: Vec<Option<QuestionResult>> = vec![];
    let mut short: Vec<(usize, &Question, Answer)> = vec![];
    for (i, q) in quiz.questions.iter().enumerate() {
        let given = answers.get(&q.id).cloned().unwrap_or_else(|| blank.clone());
        let given_blank = given.many().iter().all(|g| g.trim().is_empty());
        match quiz::grade(q, &given) {
            Some(r) => results.push(Some(r)),
            None if given_blank => results.push(Some(QuestionResult {
                id: q.id.clone(),
                correct: false,
                partial: None,
                given,
                expected: q.answer.clone(),
                feedback: format!("No answer given. A good answer: {}", q.answer.text()),
                ungraded: false,
            })),
            None => {
                results.push(None);
                short.push((i, q, given));
            }
        }
    }
    if !short.is_empty() {
        emit(progress("grading", 0, short.len()));
        let ids: Vec<String> = short.iter().map(|(_, q, _)| q.id.clone()).collect();
        let mut user = String::from("Grade these answers.\n\n");
        for (_, q, given) in &short {
            user.push_str(&format!(
                "<question id=\"{}\">\nQuestion: {}\nModel answer: {}\nExplanation: {}\nStudent's answer: {}\n</question>\n\n",
                q.id,
                q.prompt,
                q.answer.text(),
                q.explanation,
                given.text()
            ));
        }
        let graded = match model() {
            Ok(m) => ask_json(&m, GRADE_SYSTEM, &user, |v| check_grades(v, &ids)).await,
            Err(e) => Err(e),
        };
        for (i, q, given) in short {
            let from = q.source.as_deref().map(|s| format!(" (From {}.)", file_name(s))).unwrap_or_default();
            results[i] = Some(match &graded {
                Ok(grades) => {
                    let (_, score, feedback) = grades.iter().find(|(id, _, _)| *id == q.id).expect("checked");
                    let correct = *score >= 0.95;
                    QuestionResult {
                        id: q.id.clone(),
                        correct,
                        partial: (!correct && *score > 0.0).then_some(*score),
                        given,
                        expected: q.answer.clone(),
                        feedback: format!("{feedback}{from}"),
                        ungraded: false,
                    }
                }
                Err(e) => QuestionResult {
                    id: q.id.clone(),
                    correct: false,
                    partial: None,
                    given,
                    expected: q.answer.clone(),
                    feedback: format!("This one couldn’t be graded: {e} Compare yours with a good answer: {}{from}", q.answer.text()),
                    ungraded: true,
                },
            });
        }
        emit(progress("grading", ids.len(), ids.len()));
    }
    let results: Vec<QuestionResult> = results.into_iter().map(|r| r.expect("every question graded")).collect();
    let mut attempt = Attempt { path: String::new(), quiz: rel, taken: now, score: quiz::score(&results), results };
    super::attempt_save(space, &mut attempt)?;
    Ok(attempt)
}

// ---- Reviewing mistakes -------------------------------------------------------------

pub const REVIEW_SYSTEM: &str = "You help a student review the questions they got wrong on a practice quiz from their course. \
Group the mistakes by topic. For each topic write a \"## \" heading, one or two sentences on what went wrong (the misunderstanding, not only the right answer), \
and what to study next, naming the source file by its name. End with \"## Before the exam\" and the one to three most useful things to do. \
Markdown, plain words, under 300 words. Use only what's given; don't invent material.";

/// A summary without a model: the mistakes grouped by the file they came from.
pub fn plain_review(list: &[(Question, QuestionResult)]) -> String {
    let mut groups: Vec<(String, Vec<&Question>)> = vec![];
    for (q, _) in list {
        let key = q.source.as_deref().map(file_name).unwrap_or("Other").to_string();
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(q),
            None => groups.push((key, vec![q])),
        }
    }
    let mut s = String::new();
    for (k, qs) in groups {
        s.push_str(&format!("## {k}\n\n"));
        for q in qs {
            s.push_str(&format!("- {} The answer is {}.\n", q.prompt, q.answer.text()));
        }
        s.push('\n');
    }
    s.trim_end().to_string()
}

fn strip_fence(s: &str) -> String {
    let t = s.trim();
    t.strip_prefix("```markdown").or_else(|| t.strip_prefix("```md")).or_else(|| t.strip_prefix("```")).and_then(|r| r.strip_suffix("```")).unwrap_or(t).trim().to_string()
}

/// What to study next after an attempt, by topic.
pub async fn review<M: Model>(space: &Path, attempt_path: &str, model: impl FnOnce() -> Result<M, String>, emit: Emit<'_>) -> Result<String, String> {
    let attempt = super::load_attempt(space, attempt_path)?;
    let (_, quiz) = super::load_quiz(space, &attempt.quiz)?;
    let missed = mistakes(&quiz, &attempt);
    if missed.is_empty() {
        return Ok("You got everything right on this quiz. Nothing to review: try a harder quiz, or keep up your flashcards.".into());
    }
    emit(progress("reviewing", 0, 1));
    let user = format!("Quiz: {}\n\n{}", quiz.title, mistakes_block(&missed));
    let out = match model() {
        Ok(m) => m.complete(REVIEW_SYSTEM, &user).await,
        Err(e) => Err(e),
    };
    emit(progress("reviewing", 1, 1));
    Ok(match out {
        Ok(text) if !text.trim().is_empty() => strip_fence(&text),
        Ok(_) => plain_review(&missed),
        Err(e) => format!("{}\n\n_A fuller review needs a model: {e}_", plain_review(&missed)),
    })
}

#[cfg(test)]
mod tests {
    use super::super::model::tests::Scripted;
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    fn space(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-study-gen-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let c = dir.join("courses/CSCI-C 241/files/HW");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("Test 1 Review.pdf"), "%PDF").unwrap();
        fs::write(c.join("Test 1 Review.pdf.md"), "# Text of Test 1 Review.pdf\n\nA conditional p → q is false only when p is true and q is false.\nThe power set of a set with n members has 2^n members.").unwrap();
        dir.canonicalize().unwrap()
    }

    const SRC: &str = "courses/CSCI-C 241/files/HW/Test 1 Review.pdf";

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn collect() -> (Mutex<Vec<StudyEvent>>,) {
        (Mutex::new(vec![]),)
    }

    #[test]
    fn bad_json_then_good_makes_a_deck_that_reads_back() {
        let dir = space("deck");
        let good = format!(
            r#"Here are your cards:
```json
{{"title": "Logic basics", "cards": [
  {{"front": "When is p → q false?", "back": "Only when p is true and q is false.", "source": "{SRC}"}},
  {{"front": "A set with n members has {{{{2^n}}}} subsets.", "back": "", "source": "Test 1 Review.pdf"}}
]}}
```"#
        );
        let m = Scripted::new(&[r#"{"cards": [{"front": "Q", "back": "A", "source": "made-up.pdf"}]}"#, &good]);
        let (events,) = collect();
        let emit = |e: StudyEvent| events.lock().unwrap().push(e);
        let (path, n) = block_on(make_deck(&dir, &["courses/CSCI-C 241".into()], &DeckOptions { count: 8, ..Default::default() }, &m, &emit)).unwrap();
        assert_eq!((path.as_str(), n), ("study/decks/Logic basics.md", 2));
        assert_eq!(m.calls(), 2);
        let asked = m.asked.lock().unwrap();
        assert!(asked[0].1.contains("Make 8 flashcards") && asked[0].1.contains("p → q is false"));
        assert!(asked[1].1.contains("isn't one of the sources"), "the retry says what was wrong");
        drop(asked);
        let v = super::super::deck_view(&dir, &path).unwrap();
        assert_eq!(v.course.as_deref(), Some("CSCI-C 241"));
        assert_eq!(v.sources, [SRC]);
        assert!(v.cards.iter().all(|c| c.source.as_deref() == Some(SRC)), "a shortened citation is mapped to the file");
        assert_eq!(v.cards[1].kind, deck::Kind::Cloze);
        let steps: Vec<&str> = events.lock().unwrap().iter().filter_map(|e| if let StudyEvent::Progress { step, .. } = e { Some(*step) } else { None }).collect();
        assert_eq!(steps, ["reading", "reading", "making", "making", "saving", "saving"]);

        // Again for the same course: the existing cards are shown, and repeats are dropped.
        let again = format!(r#"{{"cards": [{{"front": "When is p → q false?", "back": "x", "source": "{SRC}"}}, {{"front": "What is ¬(p ∧ q) equivalent to?", "back": "¬p ∨ ¬q", "source": "{SRC}"}}]}}"#);
        let m = Scripted::new(&[&again]);
        let (path2, n) = block_on(make_deck(&dir, &[SRC.into()], &DeckOptions { count: 5, title: Some("More logic".into()), ..Default::default() }, &m, &emit)).unwrap();
        assert_eq!((path2.as_str(), n), ("study/decks/More logic.md", 1));
        assert!(m.asked.lock().unwrap()[0].1.contains("<existing_cards>\nA set with n members"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_bad_answers_write_nothing() {
        let dir = space("bad");
        let m = Scripted::new(&["Sorry, I can't.", r#"{"cards": [{"front": "", "back": "x", "source": "x"}]}"#]);
        let emit = |_: StudyEvent| {};
        let err = block_on(make_deck(&dir, &["courses/CSCI-C 241".into()], &DeckOptions::default(), &m, &emit)).unwrap_err();
        assert!(err.contains("nothing was saved"), "{err}");
        assert!(!dir.join("study/decks").exists());
        // No model at all: its message, and nothing written.
        let m = Scripted::failing(super::super::model::NO_MODEL);
        assert_eq!(block_on(make_deck(&dir, &["courses/CSCI-C 241".into()], &DeckOptions::default(), &m, &emit)).unwrap_err(), super::super::model::NO_MODEL);
        assert!(block_on(make_deck(&dir, &["../elsewhere".into()], &DeckOptions::default(), &m, &emit)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    fn quiz_reply() -> String {
        format!(
            r#"{{"title": "Test 1 practice", "questions": [
  {{"kind": "choice", "prompt": "When is p → q false?", "choices": ["p true, q false", "p false, q true", "both false", "both true"], "answer": "p true, q false", "explanation": "A conditional only fails when a true premise leads to a false conclusion.", "source": "{SRC}"}},
  {{"kind": "truefalse", "prompt": "A set with 3 members has 6 subsets.", "answer": false, "explanation": "It has 2^3 = 8.", "source": "{SRC}"}},
  {{"kind": "short", "prompt": "Why does a set with n members have 2^n subsets?", "answer": "Each member is either in or out of a subset: two choices, n times.", "explanation": "Counting in-or-out choices.", "source": "{SRC}"}},
  {{"kind": "cloze", "prompt": "The power set of a set with n members has ___ members.", "answer": "2^n", "accept": ["2ⁿ"], "explanation": "One subset per in-or-out pattern.", "source": "{SRC}"}}
]}}"#
        )
    }

    #[test]
    fn a_quiz_is_made_taken_graded_and_reviewed() {
        let dir = space("quiz");
        let emit = |_: StudyEvent| {};
        let wrong_kind = format!(r#"{{"questions": [{{"kind": "essay", "prompt": "x", "answer": "y", "explanation": "z", "source": "{SRC}"}}]}}"#);
        let m = Scripted::new(&[&wrong_kind, &quiz_reply()]);
        let kinds = ["choice", "truefalse", "short", "cloze"].map(String::from).to_vec();
        let (path, n) = block_on(make_quiz(&dir, &["courses/CSCI-C 241".into()], &QuizOptions { count: 10, kinds, difficulty: Some("exam".into()), focus: None, title: None }, &m, &emit, 1_791_000_000_000)).unwrap();
        assert_eq!((path.as_str(), n), ("study/quizzes/Test 1 practice.json", 4));
        assert!(m.asked.lock().unwrap()[1].1.contains("only these kinds"));
        let (_, q) = super::super::load_quiz(&dir, &path).unwrap();
        assert_eq!(q.questions[1].answer, Answer::One("false".into()));
        assert_eq!(q.questions[0].choices.as_ref().unwrap().len(), 4);
        assert!(q.questions[0].choices.as_ref().unwrap().contains(&"p true, q false".to_string()));

        let mut answers = std::collections::HashMap::new();
        answers.insert("q1".to_string(), Answer::One("p false, q true".into()));
        answers.insert("q2".to_string(), Answer::One("false".into()));
        answers.insert("q3".to_string(), Answer::One("because each element can be in or out".into()));
        answers.insert("q4".to_string(), Answer::One("2ⁿ".into()));
        let grader = Scripted::new(&[r#"{"grades": [{"id": "q3", "score": 0.75, "feedback": "Right idea; say it's two choices for each of the n members."}]}"#]);
        let a = block_on(submit(&dir, &path, &answers, || Ok(grader), &emit, 1_791_000_100_000)).unwrap();
        let r: Vec<(bool, Option<f64>)> = a.results.iter().map(|r| (r.correct, r.partial)).collect();
        assert_eq!(r, [(false, None), (true, None), (false, Some(0.75)), (true, None)]);
        assert!((a.score - 2.75 / 4.0).abs() < 1e-9);
        assert!(a.results[2].feedback.ends_with("(From Test 1 Review.pdf.)"));
        assert!(a.path.starts_with(".phaethon/study/attempts/Test 1 practice-"));
        let o = super::super::overview(&dir, 1_791_000_200_000);
        assert_eq!(o.quizzes[0].last_score, Some(a.score));

        // No model: short answers are left ungraded and out of the score.
        let none = || -> Result<Scripted, String> { Err(super::super::model::NO_MODEL.into()) };
        let b = block_on(submit(&dir, &path, &answers, none, &emit, 1_791_000_300_000)).unwrap();
        assert!(b.results[2].ungraded && b.results[2].feedback.contains("couldn’t be graded"));
        assert!((b.score - 2.0 / 3.0).abs() < 1e-9);

        // Review: by topic from the model, or plainly without one.
        let reviewer = Scripted::new(&["```markdown\n## Conditionals\nYou mixed up which side must be true.\n```"]);
        let s = block_on(review(&dir, &a.path, || Ok(reviewer), &emit)).unwrap();
        assert_eq!(s, "## Conditionals\nYou mixed up which side must be true.");
        let none = || -> Result<Scripted, String> { Err("offline".into()) };
        let s = block_on(review(&dir, &a.path, none, &emit)).unwrap();
        assert!(s.starts_with("## Test 1 Review.pdf") && s.contains("When is p → q false?") && s.contains("offline"), "{s}");

        // A deck from the mistakes.
        let cards = format!(r#"{{"cards": [{{"front": "If p is false, what is p → q?", "back": "True, whatever q is.", "source": "{SRC}"}}]}}"#);
        let m = Scripted::new(&[&cards]);
        let (deck, _) = block_on(make_deck(&dir, &[], &DeckOptions { from_attempt: Some(a.path.clone()), ..Default::default() }, &m, &emit)).unwrap();
        assert_eq!(deck, "study/decks/Mistakes from Test 1 practice.md");
        assert!(m.asked.lock().unwrap()[0].1.contains("<mistakes>") && m.asked.lock().unwrap()[0].1.contains("Their answer: p false, q true"));

        // Deleting the quiz takes its attempts with it.
        super::super::delete(&dir, &path).unwrap();
        assert!(super::super::load_attempt(&dir, &a.path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn similar_fronts() {
        assert!(similar("What is a set?", "what is a SET"));
        assert!(similar("When is the conditional p → q false?", "When is the conditional p → q ever false?"));
        assert!(!similar("What is a set?", "What is a graph?"));
    }
}
