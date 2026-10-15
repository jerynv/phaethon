//! Making decks and quizzes from course material (grounded.rs writes and
//! checks them against the course's notes and the exam's scope), grading
//! short answers and reviewing a quiz's mistakes (one model call each,
//! model.rs). The model is asked for strict JSON, which is checked before
//! anything is written.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::deck::{self, Deck, Note};
use super::grounded::{self, Grounding};
use super::model::{Model, ask_json};
use super::quiz::{self, Answer, Attempt, Question, QuestionResult, Quiz};
use super::sources::{self, Material};
use crate::lms::access::Visible;

pub const CARDS_MAX: usize = 100;
pub const QUESTIONS_MAX: usize = 50;
/// Most existing fronts shown to the model so it doesn't repeat them.
const EXISTING_MAX: usize = 150;

/// Streamed by the make, submit and review commands; ends with exactly one
/// `done` or `error`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StudyEvent {
    /// `step`: "mapping" (what the course teaches and each exam covers),
    /// "reading" (the material), "making" (the model writes; `done` is the
    /// round), "checking" (each one against the notes, with how many were
    /// kept and dropped so far), "saving", "grading" or "reviewing".
    Progress {
        step: &'static str,
        done: usize,
        total: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        kept: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dropped: Option<usize>,
    },
    Done(Finished),
    Error { message: String },
    /// Stopped by the person (study_chat_cancel); nothing was saved.
    Cancelled,
    /// What the exam covers wasn't found, so nothing was made; the person can
    /// say (study_scope_state). Comes just before the `error`.
    NeedsScope(super::grounded::UnknownScope),
}

impl StudyEvent {
    pub fn progress(step: &'static str, done: usize, total: usize) -> StudyEvent {
        StudyEvent::Progress { step, done, total, kept: None, dropped: None }
    }
    pub fn checking(done: usize, total: usize, kept: usize, dropped: usize) -> StudyEvent {
        StudyEvent::Progress { step: "checking", done, total, kept: Some(kept), dropped: Some(dropped) }
    }
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
    /// make: what it was made against, what was kept and dropped, and coverage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounding: Option<Box<super::grounded::Grounding>>,
}

fn progress(step: &'static str, done: usize, total: usize) -> StudyEvent {
    StudyEvent::progress(step, done, total)
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
    /// The conversation that asked for it (chat.rs), so it matches what was discussed.
    #[serde(default)]
    pub context: Option<String>,
    /// The exam it is for ("Test 1"): only that exam's scope is used.
    #[serde(default)]
    pub exam: Option<String>,
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
    /// The conversation that asked for it (chat.rs), so it matches what was discussed.
    #[serde(default)]
    pub context: Option<String>,
    /// The exam it is for ("Test 1"): only that exam's scope is used.
    #[serde(default)]
    pub exam: Option<String>,
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

fn file_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Math written `$...$` with "}}" or "{{" in it (`\frac{1}{x^{2}}`) would read
/// as a fill-in blank; a space between the braces means the same to KaTeX.
pub fn space_math_braces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_math = false;
    let mut prev = '\0';
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' && prev != '\\' {
            in_math = !in_math;
        }
        out.push(c);
        if in_math && (c == '}' || c == '{') && chars.peek() == Some(&c) {
            out.push(' ');
        }
        prev = c;
    }
    out
}

/// Why a question or card is about the material's files rather than its
/// ideas, or about course logistics, if it is.
fn about_files(text: &str, m: &Material) -> Option<String> {
    let lower = text.to_lowercase();
    for label in &m.labels {
        let name = file_name(label).to_lowercase();
        let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
        if stem.chars().count() >= 6 && lower.contains(stem) {
            return Some(format!("asks about the file “{}”; ask about the ideas in it instead", file_name(label)));
        }
    }
    const LOGISTICS: [&str; 8] = ["due date", "office hours", "late policy", "late penalty", "grading policy", "which file", "which lecture", "file name"];
    if let Some(w) = LOGISTICS.iter().find(|w| lower.contains(*w)) {
        return Some(format!("is about course logistics (“{w}”), not the material"));
    }
    if [".pdf", ".docx", ".pptx"].iter().any(|ext| lower.contains(ext)) {
        return Some("names a file; ask about the ideas instead".into());
    }
    None
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

/// How flashcards are written (grounded.rs adds where they must come from and the reply's form).
pub const DECK_RULES: &str = r#"You write flashcards for a student from their own course material.

Rules:
- One idea per card: a definition, a fact, a step of a method, a distinction, or how to apply a rule to a small example. Prefer cards that make the student recall or apply, not just recognise.
- Be accurate to the material. Never add facts it doesn't support. When the material is a problem set or review sheet, make cards on the concepts and techniques its problems test (a tiny worked example on the back helps), not on its instructions.
- Never make cards about course logistics: due dates, grading, submission rules, office hours, policies.
- The front stands on its own: no "in this problem", "the above" or "as shown". Fronts under 200 characters, backs under 300. Plain words; write math as LaTeX between $...$ (for example $A\mathbf{x} = \mathbf{b}$, $\det(A - \lambda I) = 0$, $\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$); simple symbols may stay Unicode (→ ∈ ⊆ ≤).
- A card may instead be fill-in (cloze): a sentence in "front" with the key term in {{double braces}}, and "back" empty or a short note. The blank holds a word or a short expression a student could type, never LaTeX. Use it for terms and formulas, for at most a third of the cards.
- Never ask about the material's files themselves (their names, which lecture or page says what).
- Don't repeat the cards the student already has (listed as already written), even in other words."#;

/// Check the model's cards: structure, sources, and no repeats of `existing`
/// or of each other (repeats are dropped, not errors).
/// One card from the model's JSON, checked (its source given by the caller).
pub fn card_from(c: &Value, n: usize, m: &Material, source: Option<String>) -> Result<Note, String> {
    let note = Note { front: space_math_braces(&str_field(c, "front")), back: space_math_braces(&str_field(c, "back")), source, quote: None };
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
    if let Some(why) = about_files(&note.front, m) {
        return Err(format!("card {n} {why}"));
    }
    Ok(note)
}

pub fn check_cards(v: &Value, m: &Material, existing: &[String], count: usize) -> Result<(Option<String>, Vec<Note>), String> {
    let mut out: Vec<Note> = vec![];
    for (i, c) in items(v, "cards")?.iter().enumerate() {
        let n = i + 1;
        let note = card_from(c, n, m, Some(cited(c, m, &format!("card {n}"))?))?;
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

/// Make a deck and save it. Returns its path, how many cards it has, and
/// what it was made against (grounded.rs: every card checked against the notes).
pub async fn make_deck<M: Model>(space: &Path, courses: &Visible, inputs: &[String], opts: &DeckOptions, model: &M, emit: Emit<'_>, now: u64) -> Result<(String, usize, Grounding), String> {
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
        // The topics it missed, as the course names them (the scope narrows to those).
        let mut topics: Vec<&str> = missed.iter().filter_map(|(q, _)| q.topic.as_deref()).map(|t| t.split(" (").next().unwrap_or(t)).collect();
        topics.dedup();
        if focus.is_none() && !topics.is_empty() {
            focus = Some(topics.join(", "));
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
    let course = sources::course_of(space, courses, &inputs).map(|s| s.folder().to_string());
    let existing = super::existing_fronts(space, course.as_deref());
    let shown: Vec<String> = existing.iter().rev().take(EXISTING_MAX).cloned().collect();
    let focus_line = opts.focus.as_deref().filter(|f| !f.trim().is_empty()).map(|f| format!("\n\nFocus on: {f}.")).unwrap_or_default();
    let extra = format!("{focus_line}{extra}");
    let ask = grounded::Ask { count, exam: opts.exam.as_deref(), focus: focus.as_deref(), context: opts.context.as_deref(), extra: &extra };
    let made = grounded::make(space, courses, &inputs, grounded::Want::Deck { existing: &shown }, &ask, model, emit, now).await?;
    emit(progress("saving", 0, 1));
    let notes: Vec<Note> = made.items.into_iter().filter_map(|i| if let grounded::Item::N(n) = i { Some(n) } else { None }).collect();
    let title = opts.title.clone().filter(|t| !t.trim().is_empty()).or(default_title).or(made.title).unwrap_or_else(|| "New deck".into());
    let mut used: Vec<String> = vec![];
    for n in &notes {
        if let Some(s) = &n.source
            && !used.contains(s)
        {
            used.push(s.clone());
        }
    }
    let d = Deck { title: title.trim().chars().take(deck::TITLE_MAX).collect(), course: made.material.course.clone().or(course), sources: used, notes, ..Default::default() };
    let n = d.notes.len();
    let path = super::deck_create(space, &d)?;
    emit(progress("saving", 1, 1));
    Ok((path, n, made.grounding))
}

// ---- Quizzes ------------------------------------------------------------------------

/// How quiz questions are written (grounded.rs adds where they must come from and the reply's form).
pub const QUIZ_RULES: &str = r#"You write a practice quiz for a student from their own course material.

Kinds of question (use only the kinds asked for, mixed):
- "choice": one right answer among 4 "choices", all different. Distractors must be plausible: the mistakes students really make with this material, near-misses, the same length and style as the right answer. Never "all/none of the above". "answer" is the right choice's text, copied exactly.
- "multi": 2 or 3 right among 4 or 5 "choices", at least one wrong; the prompt ends "Select all that apply." "answer" is the list of right choices' texts, copied exactly.
- "truefalse": a statement; "answer" is "true" or "false". False statements are plausible misconceptions, never silly. Mix true and false.
- "short": an open question answered in one to three sentences; "answer" is a model answer a grader can compare with.
- "cloze": a sentence with exactly one blank written ___ that doesn't give the answer away; "answer" is the missing word or short expression as a student would type it (plain text such as 2^n or det(A) = 0, never LaTeX); "accept" lists other correct forms.

Difficulty: "easier" = recall of definitions and facts; "exam" = like the course's own exams and review sheets, applying ideas to new small examples, with a few warm-ups and a few that take several steps; "harder" = several steps, combining ideas, edge cases. Order the questions from easier to harder.

Work each question out before you write it: the answer must follow from the material, and a computed answer (a determinant, an eigenvalue, a count) must be checked step by step. Each question tests a different idea or skill; no two ask the same thing.

Every question has "explanation" (one or two sentences: why the answer is right; for choice questions, why the tempting wrong one is wrong). Be accurate to the material; never test course logistics (dates, grading, policies) or the files themselves (their names, which lecture or page says what). Plain words; write math as LaTeX between $...$ (for example $A\mathbf{x} = \mathbf{b}$, $\lambda = 3$, $\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$) in prompts, choices and explanations; simple symbols may stay Unicode (→ ∈ ⊆ ≤)."#;

/// A small deterministic shuffle (the model tends to put the answer first).
fn shuffle<T>(v: &mut [T], seed: &mut u64) {
    for i in (1..v.len()).rev() {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        v.swap(i, (*seed % (i as u64 + 1)) as usize);
    }
}

/// What makes a generated question unfair or broken beyond its shape
/// (quiz::check_question): trick choices, an answer key that lists a right
/// answer twice or every choice, a blank that gives its answer away.
fn check_quality(q: &Question) -> Result<(), String> {
    let choices = q.choices.clone().unwrap_or_default();
    match q.kind.as_str() {
        "choice" | "multi" => {
            if choices.len() < 3 {
                return Err("needs at least 3 choices".into());
            }
            if choices.iter().any(|c| {
                let c = c.to_lowercase();
                c.contains("all of the above") || c.contains("none of the above") || c.contains("both a and b")
            }) {
                return Err("uses “all/none of the above”; give real choices".into());
            }
            if q.kind == "multi" {
                let right = q.answer.many();
                let mut uniq: Vec<String> = right.iter().map(|a| a.trim().to_lowercase()).collect();
                uniq.sort();
                uniq.dedup();
                if uniq.len() != right.len() {
                    return Err("lists the same right answer twice".into());
                }
                if right.len() >= choices.len() {
                    return Err("has every choice right; at least one must be wrong".into());
                }
            }
        }
        "cloze" => {
            let blanks = q.prompt.matches("___").count().max(q.prompt.matches("{{").count());
            if blanks != 1 {
                return Err("needs exactly one blank (___)".into());
            }
            let a = quiz::norm(&q.answer.text());
            if a.chars().count() >= 4 && quiz::norm(&q.prompt.replace("___", " ")).contains(&a) {
                return Err("gives its answer away in the sentence".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// One question from the model's JSON, checked: its shape, kind, quality, and
/// that it is about the ideas, not the files (its source given by the caller).
pub fn question_from(raw: &Value, n: usize, m: &Material, kinds: &[String], source: Option<String>) -> Result<Question, String> {
    let answer = match &raw["answer"] {
        Value::Array(a) => Answer::Many(a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()),
        Value::Bool(b) => Answer::One(b.to_string()),
        Value::Null => return Err(format!("question {n} has no answer")),
        other => Answer::One(other.as_str().map(String::from).unwrap_or_else(|| other.to_string())),
    };
    let list = |k: &str| raw[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).collect::<Vec<_>>());
    let mut q = Question {
        id: format!("q{n}"),
        kind: str_field(raw, "kind"),
        prompt: str_field(raw, "prompt"),
        choices: list("choices"),
        answer,
        accept: list("accept").filter(|a| !a.is_empty()),
        explanation: str_field(raw, "explanation"),
        source,
        topic: None,
        citations: vec![],
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
    check_quality(&q).map_err(|e| format!("question {n} {e}"))?;
    let all = format!("{} {}", q.prompt, q.choices.as_deref().unwrap_or_default().join(" "));
    if let Some(why) = about_files(&all, m) {
        return Err(format!("question {n} {why}"));
    }
    Ok(q)
}

/// Choices in a fixed shuffled order (the model tends to put the answer first).
pub fn shuffle_choices(q: &mut Question, seed: &mut u64) {
    if matches!(q.kind.as_str(), "choice" | "multi")
        && let Some(c) = q.choices.as_mut()
    {
        shuffle(c, seed);
    }
}

pub fn check_questions(v: &Value, m: &Material, kinds: &[String], count: usize, seed: u64) -> Result<(Option<String>, Vec<Question>), String> {
    let mut out: Vec<Question> = vec![];
    let mut seed = seed | 1;
    for (i, raw) in items(v, "questions")?.iter().enumerate() {
        let n = i + 1;
        let mut q = question_from(raw, n, m, kinds, Some(cited(raw, m, &format!("question {n}"))?))?;
        // The same question twice (in other words) is dropped, not an error.
        if out.iter().any(|o| similar(&o.prompt, &q.prompt)) {
            continue;
        }
        shuffle_choices(&mut q, &mut seed);
        out.push(q);
    }
    if out.is_empty() {
        return Err("there were no questions".into());
    }
    out.truncate(count);
    // A mix was asked for: every kind shows up when there's room for each.
    if kinds.len() > 1
        && out.len() >= 2 * kinds.len()
        && let Some(missing) = kinds.iter().find(|k| !out.iter().any(|q| &q.kind == *k))
    {
        return Err(format!("there are no \"{missing}\" questions; mix the kinds asked for: {}", kinds.join(", ")));
    }
    for (i, q) in out.iter_mut().enumerate() {
        q.id = format!("q{}", i + 1);
    }
    Ok((Some(str_field(v, "title")).filter(|t| !t.is_empty()), out))
}

/// Make a quiz and save it (grounded.rs: every question checked against the
/// notes and the exam's scope). Returns its path, how many questions it has,
/// and what it was made against.
pub async fn make_quiz<M: Model>(space: &Path, courses: &Visible, inputs: &[String], opts: &QuizOptions, model: &M, emit: Emit<'_>, now: u64) -> Result<(String, usize, Grounding), String> {
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
    let focus_line = opts.focus.as_deref().filter(|f| !f.trim().is_empty()).map(|f| format!("\n\nFocus on: {f}.")).unwrap_or_default();
    let ask = grounded::Ask { count, exam: opts.exam.as_deref(), focus: opts.focus.as_deref(), context: opts.context.as_deref(), extra: &focus_line };
    let made = grounded::make(space, courses, inputs, grounded::Want::Quiz { kinds: &kinds, difficulty }, &ask, model, emit, now).await?;
    emit(progress("saving", 0, 1));
    let questions: Vec<Question> = made.items.into_iter().filter_map(|i| if let grounded::Item::Q(q) = i { Some(q) } else { None }).collect();
    let title = opts.title.clone().filter(|t| !t.trim().is_empty()).or(made.title).unwrap_or_else(|| "New quiz".into());
    let mut used: Vec<String> = vec![];
    for c in questions.iter().flat_map(|q| &q.citations) {
        if !used.contains(&c.source) {
            used.push(c.source.clone());
        }
    }
    let course = sources::course_of(space, courses, inputs).map(|s| s.folder().to_string()).or(made.material.course.clone());
    let q = Quiz { title: title.trim().chars().take(deck::TITLE_MAX).collect(), course, sources: used, created: now, questions, grounding: Some(made.grounding.clone()) };
    let n = q.questions.len();
    let path = super::quiz_create(space, &q)?;
    emit(progress("saving", 1, 1));
    Ok((path, n, made.grounding))
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
            Ok(m) => ask_json(&m, &super::course_only(GRADE_SYSTEM), &user, |v| check_grades(v, &ids)).await,
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
        Ok(m) => m.complete(&super::course_only(REVIEW_SYSTEM), &user).await,
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

    /// A course with a review sheet (two Test 1 topics and one after it) and an announcement of Test 1's scope.
    pub fn space(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-study-gen-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let c = dir.join("courses/CSCI-C 241/files/HW");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("Test 1 Review.pdf"), "%PDF").unwrap();
        fs::write(c.join("Test 1 Review.pdf.md"), format!("# Text of Test 1 Review.pdf\n\n{Q1}\n{Q2}\n{Q3}")).unwrap();
        fs::write(dir.join("courses/CSCI-C 241/announcements.md"), format!("# Announcements\n\n## Test 1\n\n{QA}\n")).unwrap();
        crate::lms::access::fixture(&dir, "s", &[("CSCI-C 241", &crate::lms::access::Part::ALL)]);
        dir.join("spaces/s").canonicalize().unwrap()
    }

    /// What the test space sees (the vault is two folders up).
    fn vis(space: &std::path::Path) -> Visible {
        crate::lms::access::visible(&crate::vault::Vault::at(space.parent().unwrap().parent().unwrap()), "s")
    }

    const SRC: &str = "courses/CSCI-C 241/files/HW/Test 1 Review.pdf";
    const Q1: &str = "A conditional p → q is false only when p is true and q is false.";
    const Q2: &str = "The power set of a set with n members has 2^n members.";
    const Q3: &str = "After Test 1, a graph is a set of vertices joined by edges.";
    const QA: &str = "Test 1 covers conditionals and power sets. It will not cover graphs.";

    /// The scope map the "model" gives for that course: Test 1 is t1 and t2, not t3.
    pub fn map_reply() -> String {
        format!(
            r#"{{"topics": [
  {{"id": "t1", "title": "Conditionals", "terms": ["conditional"], "weight": 3, "evidence": [{{"source": "{SRC}", "quote": "{Q1}"}}]}},
  {{"id": "t2", "title": "Power sets", "terms": ["power set"], "weight": 2, "evidence": [{{"source": "Test 1 Review.pdf", "quote": "{Q2}"}}]}},
  {{"id": "t3", "title": "Graphs", "terms": ["graph"], "weight": 2, "evidence": [{{"source": "Test 1 Review.pdf", "quote": "{Q3}"}}]}}],
 "exams": [{{"title": "Test 1", "includes": ["t1", "t2"], "excludes": ["t3"], "excludedWords": ["graphs"], "summary": "conditionals and power sets", "evidence": [{{"source": "courses/CSCI-C 241/announcements.md", "quote": "{QA}"}}]}}]}}"#
        )
    }

    fn cite(q: &str) -> String {
        format!(r#"[{{"source": "{SRC}", "quote": "{q}"}}]"#)
    }

    /// The checker's answer: one verdict per item, in order.
    pub fn verdicts(v: &[&str]) -> String {
        let list: Vec<String> = v.iter().enumerate().map(|(i, x)| format!(r#"{{"id": "i{}", "verdict": "{x}", "missing": "{}", "answerOk": true}}"#, i + 1, if *x == "yes" { "" } else { "preimages aren't taught" })).collect();
        format!(r#"{{"verdicts": [{}]}}"#, list.join(","))
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn steps(events: &Mutex<Vec<StudyEvent>>) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = vec![];
        for e in events.lock().unwrap().iter() {
            if let StudyEvent::Progress { step, .. } = e
                && out.last() != Some(step)
            {
                out.push(step);
            }
        }
        out
    }

    #[test]
    fn a_deck_is_mapped_written_checked_and_reads_back_with_its_passages() {
        let dir = space("deck");
        let good = format!(
            r#"Here are your cards:
```json
{{"title": "Logic basics", "cards": [
  {{"topic": "t1", "front": "When is p → q false?", "back": "Only when p is true and q is false.", "citations": {}}},
  {{"topic": "t2", "front": "A set with n members has {{{{2^n}}}} subsets.", "back": "", "citations": [{{"source": "Test 1 Review.pdf", "quote": "{Q2}"}}]}}
]}}
```"#,
            cite(Q1)
        );
        let m = Scripted::new(&[&map_reply(), "Sorry, no JSON here.", &good, &verdicts(&["yes", "yes"])]);
        let events = Mutex::new(vec![]);
        let emit = |e: StudyEvent| events.lock().unwrap().push(e);
        let (path, n, g) = block_on(make_deck(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &DeckOptions { count: 2, ..Default::default() }, &m, &emit, 5)).unwrap();
        assert_eq!((path.as_str(), n), ("study/decks/Logic basics.md", 2));
        assert_eq!(m.calls(), 4, "map, a reply with nothing usable, the cards, the check");
        let asked = m.asked.lock().unwrap();
        assert!(asked[1].1.contains("Write 3 flashcards") && asked[1].1.contains("- t1: Conditionals") && asked[1].1.contains("p → q is false"), "a little over, to absorb drops: {}", asked[1].1);
        assert!(!asked[1].1.contains("t3: Graphs"), "no exam: every topic, but…");
        assert!(asked[3].0.contains("You check practice questions") && asked[3].1.contains("«A conditional p → q is false only when p is true and q is false.»"), "the checker sees the cited passage");
        drop(asked);
        let v = super::super::deck_view(&dir, &path).unwrap();
        assert_eq!(v.course.as_deref(), Some("CSCI-C 241"));
        assert_eq!(v.sources, [SRC]);
        assert_eq!(v.cards[0].quote.as_deref(), Some(Q1), "each card keeps its passage");
        assert_eq!(v.cards[1].kind, deck::Kind::Cloze);
        assert_eq!(steps(&events), ["mapping", "reading", "making", "checking", "saving"]);
        assert_eq!((g.asked, g.kept, g.exam.as_deref()), (2, 2, None));
        assert!(dir.parent().unwrap().parent().unwrap().join(".phaethon/scope/CSCI-C 241.json").is_file(), "the map is kept");

        // Again: the map is reused, the cards the deck has are shown, and a repeat is dropped before the check.
        let again = format!(r#"{{"cards": [{{"topic": "t1", "front": "When is p → q false?", "back": "x", "citations": {c}}}, {{"topic": "t1", "front": "What makes a conditional false?", "back": "A true p and a false q.", "citations": {c}}}]}}"#, c = cite(Q1));
        let m = Scripted::new(&[&again, &verdicts(&["yes"])]);
        let (path2, n, _) = block_on(make_deck(&dir, &vis(&dir), &[SRC.into()], &DeckOptions { count: 1, title: Some("More logic".into()), ..Default::default() }, &m, &emit, 6)).unwrap();
        assert_eq!((path2.as_str(), n), ("study/decks/More logic.md", 1));
        assert!(m.asked.lock().unwrap()[0].1.contains("Already written (don't repeat these):\n- A set with n members"));
        assert!(m.asked.lock().unwrap()[1].1.contains("What makes a conditional false?") && !m.asked.lock().unwrap()[1].1.contains("When is p → q false?"));
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn nothing_usable_writes_nothing() {
        let dir = space("bad");
        let emit = |_: StudyEvent| {};
        let m = Scripted::new(&[&map_reply(), "Sorry, I can't.", "Still no.", "No."]);
        let err = block_on(make_deck(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &DeckOptions::default(), &m, &emit, 1)).unwrap_err();
        assert!(err.contains("nothing was saved"), "{err}");
        assert_eq!(m.calls(), 4, "bounded: the map and three rounds");
        assert!(!dir.join("study/decks").exists());
        // No model at all: its message, and nothing written.
        let m = Scripted::failing(super::super::model::NO_MODEL);
        assert_eq!(block_on(make_deck(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &DeckOptions::default(), &m, &emit, 1)).unwrap_err(), super::super::model::NO_MODEL);
        assert!(block_on(make_deck(&dir, &vis(&dir), &["../elsewhere".into()], &DeckOptions::default(), &m, &emit, 1)).is_err());
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    /// Four good questions on Test 1's topics, one on graphs (out of scope), one
    /// quoting words the file doesn't have, and one on preimages (cited, but not taught).
    fn quiz_reply() -> String {
        format!(
            r#"{{"title": "Test 1 practice", "questions": [
  {{"topic": "t1", "kind": "choice", "prompt": "When is p → q false?", "choices": ["p true, q false", "p false, q true", "both false", "both true"], "answer": "p true, q false", "explanation": "A conditional only fails when a true premise leads to a false conclusion.", "citations": {c1}}},
  {{"topic": "t2", "kind": "truefalse", "prompt": "A set with 3 members has 6 subsets.", "answer": false, "explanation": "It has 2^3 = 8.", "citations": {c2}}},
  {{"topic": "t2", "kind": "short", "prompt": "Why does a set with n members have 2^n subsets?", "answer": "Each member is either in or out of a subset: two choices, n times.", "explanation": "Counting in-or-out choices.", "citations": {c2}}},
  {{"topic": "t3", "kind": "truefalse", "prompt": "Every graph has at least one edge.", "answer": "false", "explanation": "A graph may have no edges.", "citations": {c3}}},
  {{"topic": "t1", "kind": "truefalse", "prompt": "If q is true then p → q is true.", "answer": "true", "explanation": "The only false case has q false.", "citations": [{{"source": "{SRC}", "quote": "A conditional is true whenever its conclusion is true."}}]}},
  {{"topic": "t2", "kind": "short", "prompt": "What is the preimage of a set under a function?", "answer": "Every input mapped into it.", "explanation": "By definition of preimage.", "citations": {c2}}},
  {{"topic": "t2", "kind": "cloze", "prompt": "The power set of a set with n members has ___ members.", "answer": "2^n", "accept": ["2ⁿ"], "explanation": "One subset per in-or-out pattern.", "citations": {c2}}}
]}}"#,
            c1 = cite(Q1),
            c2 = cite(Q2),
            c3 = cite(Q3)
        )
    }

    fn quiz_opts(count: usize) -> QuizOptions {
        QuizOptions { count, kinds: ["choice", "truefalse", "short", "cloze"].map(String::from).to_vec(), difficulty: Some("exam".into()), exam: Some("Test 1".into()), ..Default::default() }
    }

    #[test]
    fn a_quiz_for_an_exam_keeps_only_what_is_taught_and_in_scope() {
        let dir = space("quiz");
        let events = Mutex::new(vec![]);
        let emit = |e: StudyEvent| events.lock().unwrap().push(e);
        // The checker passes four and refuses the preimage question; conditionals (2 of 4 by weight)
        // came up one short, so a second round writes one more.
        let more = format!(r#"{{"questions": [{{"topic": "t1", "kind": "truefalse", "prompt": "If p is false, p → q is true.", "answer": "true", "explanation": "Only true p and false q fail.", "citations": {}}}]}}"#, cite(Q1));
        let m = Scripted::new(&[&map_reply(), &quiz_reply(), &verdicts(&["yes", "yes", "yes", "no", "yes"]), &more, &verdicts(&["yes"])]);
        let (path, n, g) = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &quiz_opts(4), &m, &emit, 1_791_000_000_000)).unwrap();
        assert_eq!((path.as_str(), n), ("study/quizzes/Test 1 practice.json", 4));
        assert_eq!(m.calls(), 5, "map, write, check, then one more round for the topic that fell short");
        let asked = m.asked.lock().unwrap();
        assert!(asked[1].1.contains("- t1: Conditionals — 3 questions") && asked[1].1.contains("- t2: Power sets — 2 questions"), "spread by weight, a little over: {}", asked[1].1);
        assert!(asked[1].1.contains("<not_in_scope>\nGraphs\ngraphs\n</not_in_scope>"), "{}", asked[1].1);
        assert!(asked[2].1.contains("Exam: Test 1: conditionals and power sets; not graphs") && asked[2].1.contains("Words in it that appear nowhere in the course's materials: preimage"), "{}", asked[2].1);
        assert!(!asked[2].1.contains("Every graph has") && !asked[2].1.contains("whenever its conclusion"), "the mechanical gate drops those before the checker");
        assert!(asked[3].1.contains("- t1: Conditionals — 1 questions") && !asked[3].1.contains("- t2:") && asked[3].1.contains("thrown away by the check"), "{}", asked[3].1);
        drop(asked);
        let (_, q) = super::super::load_quiz(&dir, &path).unwrap();
        assert!(q.questions.iter().all(|q| !q.prompt.contains("preimage") && !q.prompt.contains("graph")));
        assert_eq!(q.questions.iter().map(|q| q.topic.as_deref().unwrap()).collect::<Vec<_>>(), ["Conditionals", "Conditionals", "Power sets", "Power sets"], "in the course's order");
        assert_eq!(q.questions[0].citations[0].quote, Q1);
        assert_eq!(q.questions[0].source.as_deref(), Some(SRC));
        let gq = q.grounding.as_ref().unwrap();
        assert_eq!(gq, &g);
        assert_eq!((g.exam.as_deref(), g.scope.as_deref(), g.asked, g.kept), (Some("Test 1"), Some("conditionals and power sets; not graphs"), 4, 4));
        assert_eq!(g.evidence[0].quote, QA);
        let whys: Vec<&str> = g.dropped.iter().map(|d| d.why.as_str()).collect();
        assert!(whys.iter().any(|w| w.contains("Graphs, isn’t in scope")) && whys.iter().any(|w| w.contains("quote isn’t in Test 1 Review.pdf")) && whys.iter().any(|w| w.contains("preimages aren't taught")), "{whys:?}");
        assert_eq!(g.coverage.iter().map(|c| (c.topic.as_str(), c.count)).collect::<Vec<_>>(), [("Conditionals", 2), ("Power sets", 2)]);
        assert!(g.notes.is_empty(), "{:?}", g.notes);
        let checking: Vec<(usize, usize)> = events.lock().unwrap().iter().filter_map(|e| if let StudyEvent::Progress { step: "checking", kept: Some(k), dropped: Some(d), .. } = e { Some((*k, *d)) } else { None }).collect();
        assert_eq!(checking.last(), Some(&(5, 3)), "kept and dropped are said as it checks");

        // Taken, graded and reviewed as before.
        let mut answers = std::collections::HashMap::new();
        answers.insert("q1".to_string(), Answer::One("p false, q true".into()));
        answers.insert("q2".to_string(), Answer::One("true".into()));
        answers.insert("q3".to_string(), Answer::One("false".into()));
        answers.insert("q4".to_string(), Answer::One("because each element can be in or out".into()));
        let grader = Scripted::new(&[r#"{"grades": [{"id": "q4", "score": 0.75, "feedback": "Right idea; say it's two choices for each of the n members."}]}"#]);
        let a = block_on(submit(&dir, &path, &answers, || Ok(grader), &emit, 1_791_000_100_000)).unwrap();
        let r: Vec<(bool, Option<f64>)> = a.results.iter().map(|r| (r.correct, r.partial)).collect();
        assert_eq!(r, [(false, None), (true, None), (true, None), (false, Some(0.75))]);
        assert!(a.results[3].feedback.ends_with("(From Test 1 Review.pdf.)"));
        let o = super::super::overview(&dir, 1_791_000_200_000);
        assert_eq!(o.quizzes[0].last_score, Some(a.score));
        let none = || -> Result<Scripted, String> { Err(super::super::model::NO_MODEL.into()) };
        let b = block_on(submit(&dir, &path, &answers, none, &emit, 1_791_000_300_000)).unwrap();
        assert!(b.results[3].ungraded && b.results[3].feedback.contains("couldn’t be graded"));
        let reviewer = Scripted::new(&["```markdown\n## Conditionals\nYou mixed up which side must be true.\n```"]);
        assert_eq!(block_on(review(&dir, &a.path, || Ok(reviewer), &emit)).unwrap(), "## Conditionals\nYou mixed up which side must be true.");

        // A deck from the mistakes: its material, the mistakes said after it.
        let cards = format!(r#"{{"cards": [{{"topic": "t1", "front": "If p is false, what is p → q?", "back": "True, whatever q is.", "citations": {}}}]}}"#, cite(Q1));
        let m = Scripted::new(&[&cards, &verdicts(&["yes"])]);
        let (deck, _, _) = block_on(make_deck(&dir, &vis(&dir), &[], &DeckOptions { from_attempt: Some(a.path.clone()), count: 1, ..Default::default() }, &m, &emit, 2)).unwrap();
        assert_eq!(deck, "study/decks/Mistakes from Test 1 practice.md");
        assert!(m.asked.lock().unwrap()[0].1.contains("<mistakes>") && m.asked.lock().unwrap()[0].1.contains("Their answer: p false, q true"));
        super::super::delete(&dir, &path).unwrap();
        assert!(super::super::load_attempt(&dir, &a.path).is_err());
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn short_after_the_rounds_is_delivered_short_with_why_never_padded() {
        let dir = space("short");
        let emit = |_: StudyEvent| {};
        let one_ok = format!(r#"{{"questions": [{{"topic": "t1", "kind": "truefalse", "prompt": "If p is false, p → q is true.", "answer": "true", "explanation": "Only true p and false q fail.", "citations": {}}}]}}"#, cite(Q1));
        let one_bad = format!(r#"{{"questions": [{{"topic": "t2", "kind": "short", "prompt": "What is the preimage of a set?", "answer": "Inputs mapped into it.", "explanation": "Definition.", "citations": {}}}]}}"#, cite(Q2));
        let m = Scripted::new(&[&map_reply(), &one_ok, &verdicts(&["yes"]), &one_bad, &verdicts(&["no"]), &one_bad.replace("preimage of a set?", "preimage of a subset?"), &verdicts(&["unsure"])]);
        let (path, n, g) = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &quiz_opts(3), &m, &emit, 9)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(m.calls(), 7, "three rounds of writing at most: {:?}", g.dropped);
        assert!(m.asked.lock().unwrap()[3].1.contains("thrown away by the check") || m.asked.lock().unwrap()[3].1.contains("Already written"), "a later round knows what passed");
        assert!(g.notes.iter().any(|n| n.starts_with("Only 1 of the 3 questions you asked for passed the check")), "{:?}", g.notes);
        assert_eq!(g.coverage.iter().map(|c| (c.count, c.why.is_some())).collect::<Vec<_>>(), [(1, false), (0, true)]);
        assert!(super::super::load_quiz(&dir, &path).unwrap().1.questions.len() == 1);
        // Nothing passing at all: an error, nothing saved.
        let m = Scripted::new(&[&one_bad, &verdicts(&["no"]), &one_bad, &verdicts(&["no"]), &one_bad, &verdicts(&["no"])]);
        let err = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &quiz_opts(2), &m, &emit, 10)).unwrap_err();
        assert!(err.starts_with("Nothing passed the check against your notes, so nothing was saved"), "{err}");
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn an_exam_whose_scope_is_unknown_stops_and_asks() {
        let dir = space("unknown");
        let events = Mutex::new(vec![]);
        let emit = |e: StudyEvent| events.lock().unwrap().push(e);
        let m = Scripted::new(&[&map_reply()]);
        let err = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &QuizOptions { exam: Some("Final".into()), ..quiz_opts(5) }, &m, &emit, 1)).unwrap_err();
        assert!(err.contains("I couldn’t find what Final covers") && err.contains("I won’t guess"), "{err}");
        assert_eq!(m.calls(), 1, "nothing is written");
        let asked = events.lock().unwrap().iter().find_map(|e| if let StudyEvent::NeedsScope(u) = e { Some(u.clone()) } else { None }).unwrap();
        assert_eq!((asked.course.as_str(), asked.exam.as_str()), ("courses/CSCI-C 241", "Final"));
        // Said by the person: read against the topics, then used, shown as theirs.
        let v = vis(&dir);
        super::super::scope::state(&v, &v.courses[0], "Final", "Only conditionals", 2).unwrap();
        let q = format!(r#"{{"questions": [{{"topic": "t1", "kind": "truefalse", "prompt": "If p is false, p → q is true.", "answer": "true", "explanation": "Only true p and false q fail.", "citations": {}}}]}}"#, cite(Q1));
        let m = Scripted::new(&[r#"{"includes": ["t1"], "excludes": []}"#, &q, &verdicts(&["yes"])]);
        let (_, n, g) = block_on(make_quiz(&dir, &v, &["courses/CSCI-C 241".into()], &QuizOptions { exam: Some("final".into()), ..quiz_opts(1) }, &m, &emit, 3)).unwrap();
        assert_eq!(n, 1);
        assert!(g.from_user && g.evidence[0].source == "from you" && g.scope.as_deref() == Some("Only conditionals"), "{g:?}");
        assert!(m.asked.lock().unwrap()[1].1.contains("<not_in_scope>\nPower sets\nGraphs"), "{}", m.asked.lock().unwrap()[1].1);
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    fn material() -> Material {
        Material { text: String::new(), labels: vec![SRC.into()], course: None }
    }

    fn one(q: &str) -> Result<Vec<Question>, String> {
        let kinds = quiz::KINDS.map(String::from).to_vec();
        let v: Value = serde_json::from_str(&format!(r#"{{"questions": [{q}]}}"#)).unwrap();
        check_questions(&v, &material(), &kinds, 10, 7).map(|(_, qs)| qs)
    }

    #[test]
    fn answer_keys_and_fairness_are_checked() {
        let ok = format!(r#"{{"kind":"choice","prompt":"What is $\\det\\begin{{bmatrix}} 1 & 2 \\\\ 3 & 4 \\end{{bmatrix}}$?","choices":["$-2$","$2$","$10$","$-10$"],"answer":"$-2$","explanation":"1·4 − 2·3 = −2.","source":"{SRC}"}}"#);
        let q = one(&ok).unwrap();
        assert!(q[0].prompt.contains("\\begin{bmatrix}") && q[0].choices.as_ref().unwrap().contains(&"$-2$".to_string()), "LaTeX is kept as written");
        let bad = |body: &str| format!(r#"{{{body},"explanation":"why","source":"{SRC}"}}"#);
        let cases = [
            (bad(r#""kind":"choice","prompt":"Pick","choices":["a","b","c","d"],"answer":"e""#), "isn't one of its choices"),
            (bad(r#""kind":"choice","prompt":"Pick","choices":["a","A","c","d"],"answer":"a""#), "two choices are the same"),
            (bad(r#""kind":"choice","prompt":"Pick","choices":["a","b"],"answer":"a""#), "at least 3 choices"),
            (bad(r#""kind":"choice","prompt":"Pick","choices":["a","b","All of the above"],"answer":"a""#), "all/none of the above"),
            (bad(r#""kind":"multi","prompt":"Pick all","choices":["a","b","c"],"answer":["a","b","c"]"#), "every choice right"),
            (bad(r#""kind":"multi","prompt":"Pick all","choices":["a","b","c","d"],"answer":["a","a"]"#), "same right answer twice"),
            (bad(r#""kind":"cloze","prompt":"A ___ has ___ edges.","answer":"tree""#), "exactly one blank"),
            (bad(r#""kind":"cloze","prompt":"The eigenvalue ___ is an eigenvalue.","answer":"eigenvalue""#), "gives its answer away"),
            (bad(r#""kind":"short","prompt":"What does Test 1 Review cover?","answer":"logic""#), "asks about the file"),
            (bad(r#""kind":"short","prompt":"When is the due date for HW 3?","answer":"Friday""#), "logistics"),
            (bad(r#""kind":"truefalse","prompt":"The notes.pdf says sets are lists.","answer":"false""#), "names a file"),
            (format!(r#"{{"kind":"short","prompt":"Why?","answer":"because","source":"{SRC}"}}"#), "no explanation"),
        ];
        for (q, want) in cases {
            let err = one(&q).unwrap_err();
            assert!(err.contains(want), "{q}\n→ {err}");
        }
        // The same question twice is dropped, not refused.
        let tf = |p: &str| format!(r#"{{"kind":"truefalse","prompt":"{p}","answer":"true","explanation":"x","source":"{SRC}"}}"#);
        let qs = one(&format!("{},{}", tf("Every square matrix with a zero row is singular."), tf("Every square matrix with a zero row is singular!"))).unwrap();
        assert_eq!(qs.len(), 1);
        // A mix asked for, with room for each, gets each.
        let kinds = ["choice", "truefalse"].map(String::from).to_vec();
        let five: Vec<String> = (0..5).map(|i| tf(&format!("Statement number {i} about matrices holds"))).collect();
        let v: Value = serde_json::from_str(&format!(r#"{{"questions": [{}]}}"#, five.join(","))).unwrap();
        let err = check_questions(&v, &material(), &kinds, 5, 1).unwrap_err();
        assert!(err.contains("no \"choice\" questions"), "{err}");
    }

    #[test]
    fn math_braces_never_make_a_blank() {
        assert_eq!(space_math_braces("$\\frac{1}{x^{2}}$ and {{term}}"), "$\\frac{1}{x^{2} }$ and {{term}}");
        assert_eq!(space_math_braces("costs \\$5 {{x}}"), "costs \\$5 {{x}}");
        let v: Value = serde_json::from_str(&format!(r#"{{"cards": [{{"front": "What is $\\frac{{1}}{{x^{{2}}}}$ integrated?", "back": "$-\\frac{{1}}{{x}} + C$", "source": "{SRC}"}}]}}"#)).unwrap();
        let (_, notes) = check_cards(&v, &material(), &[], 5).unwrap();
        assert_eq!(notes[0].kind(), deck::Kind::Basic, "{}", notes[0].front);
        let d = Deck { title: "M".into(), notes, ..Default::default() };
        deck::validate(&d).unwrap();
    }

    #[test]
    fn the_discussion_and_focus_ride_along_inside_the_scope() {
        let dir = space("ctx");
        let emit = |_: StudyEvent| {};
        let m = Scripted::new(&[&map_reply(), &quiz_reply(), &verdicts(&["yes", "yes", "yes", "no", "yes"])]);
        let opts = QuizOptions {
            focus: Some("conditionals".into()),
            context: Some("The student asked:\nquiz me on conditionals\n\nTheir assistant answered, promising this:\n4 questions on p → q".into()),
            exam: None,
            ..quiz_opts(2)
        };
        let (_, _, g) = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &opts, &m, &emit, 1)).unwrap();
        let asked = m.asked.lock().unwrap()[1].1.clone();
        let (material_at, discussion_at) = (asked.find("<material>").unwrap(), asked.find("<discussion>").unwrap());
        assert!(material_at < discussion_at && asked.contains("4 questions on p → q") && asked.contains("not course material"), "{asked}");
        assert!(asked.contains("- t1: Conditionals") && !asked.contains("- t2:"), "the focus narrows the topics: {asked}");
        assert_eq!(g.coverage.len(), 1);
        // A focus the course doesn't teach is said, not stretched to.
        let m = Scripted::new(&[&quiz_reply(), &verdicts(&["yes", "yes", "yes", "no", "yes"])]);
        let (_, _, g) = block_on(make_quiz(&dir, &vis(&dir), &["courses/CSCI-C 241".into()], &QuizOptions { focus: Some("eigenvalues".into()), ..quiz_opts(4) }, &m, &emit, 2)).unwrap();
        assert!(g.notes.iter().any(|n| n.contains("I couldn’t find “eigenvalues” among the topics")), "{:?}", g.notes);
        assert!(!m.asked.lock().unwrap()[0].1.contains("<discussion>"), "without a conversation, nothing is added");
        fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    /// A checker that keeps the checker's rule literally: an item passes only when every
    /// symbol in it is in a passage it cites or in <course_notation>, and no word of it is
    /// one the course never uses. Anything else asked of it is a writer's reply, in order.
    struct RuleChecker {
        writes: Mutex<Vec<String>>,
        asked: Mutex<Vec<(String, String)>>,
    }

    impl super::super::model::Model for RuleChecker {
        async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
            self.asked.lock().unwrap().push((system.into(), user.into()));
            if !system.contains("You check practice questions") {
                let mut w = self.writes.lock().unwrap();
                return Ok(if w.is_empty() { "nothing more".into() } else { w.remove(0) });
            }
            let notation = user.split_once("<course_notation>").and_then(|(_, r)| r.split_once("</course_notation>")).map_or("", |(n, _)| n);
            let mut verdicts = vec![];
            for chunk in user.split("<item id=\"").skip(1) {
                let (id, body) = chunk.split_once("\">").unwrap();
                let (asked, rest) = body.split_once("\n<cited>\n").unwrap();
                let (cited, after) = rest.split_once("</cited>").unwrap();
                let symbol = |c: char| !c.is_alphanumeric() && !c.is_whitespace() && !".,;:?!'\"()=-+^_".contains(c);
                let missing: Vec<char> = asked.chars().filter(|c| symbol(*c) && !cited.contains(*c) && !notation.contains(*c)).collect();
                let unknown = after.contains("appear nowhere in the course");
                let verdict = if missing.is_empty() && !unknown { "yes" } else { "no" };
                let why = if !missing.is_empty() { format!("{} isn't taught", missing[0]) } else if unknown { "preimages aren't taught".into() } else { String::new() };
                verdicts.push(format!(r#"{{"id": "{id}", "verdict": "{verdict}", "missing": "{why}", "answerOk": true}}"#));
            }
            Ok(format!(r#"{{"verdicts": [{}]}}"#, verdicts.join(",")))
        }
    }

    #[test]
    fn the_checker_takes_the_courses_evidenced_notation_as_taught_and_nothing_else() {
        let dir = space("notation");
        let vault = dir.parent().unwrap().parent().unwrap().to_path_buf();
        // The course defines ∅ in a file of its own; the power set passage the questions cite
        // (and the text around it the checker sees) doesn't.
        const Q4: &str = "The empty set ∅ is the set with no members, and it is a subset of every set.";
        const NOTES: &str = "courses/CSCI-C 241/files/Notation.md";
        fs::write(vault.join(NOTES), format!("# Notation\n\n{Q4}\n")).unwrap();
        let map = map_reply().replace(r#" "exams":"#, &format!(r#" "notation": [{{"symbol": "∅", "meaning": "the empty set", "evidence": {{"source": "Notation.md", "quote": "{Q4}"}}}}], "exams":"#));
        let v = vis(&dir);
        let built = block_on(super::super::scope::build(&v, &v.courses[0], &[], &Scripted::new(&[&map]), 1, &|_, _| {})).unwrap();
        assert_eq!(built.notation.iter().map(|n| n.symbol.as_str()).collect::<Vec<_>>(), ["∅"]);
        // Two entries without a passage really in the files (one made up, one with none),
        // as a hand-edited or older map could have: never given to the writer or the checker.
        let store = vault.join(".phaethon/scope/CSCI-C 241.json");
        let mut kept: Value = serde_json::from_str(&fs::read_to_string(&store).unwrap()).unwrap();
        let entry = kept["maps"].as_object_mut().unwrap().values_mut().next().unwrap();
        entry["notation"].as_array_mut().unwrap().push(serde_json::json!({"symbol": "|S|", "meaning": "how many members S has", "evidence": [{"source": SRC, "quote": "The size |S| of a set S is how many members it has."}]}));
        entry["notation"].as_array_mut().unwrap().push(serde_json::json!({"symbol": "⊆", "meaning": "is a subset of", "evidence": []}));
        fs::write(&store, serde_json::to_string(&kept).unwrap()).unwrap();

        let tf = |p: &str, a: &str, e: &str| format!(r#"{{"topic": "t2", "kind": "truefalse", "prompt": "{p}", "answer": "{a}", "explanation": "{e}", "citations": {}}}"#, cite(Q2));
        let reply = format!(
            r#"{{"title": "Power sets", "questions": [{}, {}, {}, {}]}}"#,
            tf("The power set of every set has ∅ as a member.", "true", "∅ is a subset of every set, so it is in the power set."),
            tf("If |S| = 3, the power set of S has 8 members.", "true", "It has 2^3 = 8 members."),
            tf("If A ⊆ B, the power set of A has fewer members.", "false", "Not if A = B."),
            tf("The preimage of a set is its power set.", "false", "By definition of preimage."),
        );
        let m = RuleChecker { writes: Mutex::new(vec![reply]), asked: Mutex::default() };
        let (path, n, g) = block_on(make_quiz(&dir, &v, &["courses/CSCI-C 241".into()], &QuizOptions { exam: Some("Test 1".into()), ..quiz_opts(4) }, &m, &|_| {}, 4)).unwrap();
        assert_eq!(n, 1);
        let q = super::super::load_quiz(&dir, &path).unwrap().1;
        assert_eq!(q.questions[0].prompt, "The power set of every set has ∅ as a member.", "∅ is the course's own, evidenced notation: the question is fair");
        let whys: Vec<(&str, &str)> = g.dropped.iter().map(|d| (d.text.as_str(), d.why.as_str())).collect();
        assert!(whys.contains(&("If |S| = 3, the power set of S has 8 members.", "not taught in your notes or not in scope: | isn't taught")), "{whys:?}");
        assert!(whys.contains(&("If A ⊆ B, the power set of A has fewer members.", "not taught in your notes or not in scope: ⊆ isn't taught")), "{whys:?}");
        assert!(whys.iter().any(|(t, w)| t.contains("preimage") && w.contains("preimages aren't taught")), "the wall still holds: {whys:?}");
        let asked = m.asked.lock().unwrap();
        let check = asked.iter().find(|(s, _)| s.contains("You check practice questions")).unwrap();
        assert!(check.0.contains("a symbol listed in <course_notation> counts as taught") && check.0.contains("doesn't make any other symbol, term or idea taught"));
        let given = check.1.split_once("<course_notation>").unwrap().1.split_once("</course_notation>").unwrap().0;
        assert_eq!(given.trim(), format!("∅: the empty set [source: {NOTES} \"{Q4}\"]"), "only the entry whose passage is in the files");
        assert!(check.1.contains("Words in it that appear nowhere in the course's materials: preimage"));
        let first = check.1.split("<item id=").nth(1).unwrap();
        assert!(first.contains("has ∅ as a member") && !first.split_once("<cited>").unwrap().1.contains('∅'), "the passage it cites doesn't define ∅");
        let write = &asked[0].1;
        assert!(write.contains("<notation>\n∅: the empty set") && !write.contains("|S|") && !write.contains("⊆:"), "the writer gets the same list: {write}");
        drop(asked);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn similar_fronts() {
        assert!(similar("What is a set?", "what is a SET"));
        assert!(similar("When is the conditional p → q false?", "When is the conditional p → q ever false?"));
        assert!(!similar("What is a set?", "What is a graph?"));
    }
}
