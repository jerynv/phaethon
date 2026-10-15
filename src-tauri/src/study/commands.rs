//! The `study_*` commands (src/lib/study.ts mirrors them). Each takes a space
//! id, checked through the vault; decks and quizzes are named by their paths
//! in the space, which mod.rs checks.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::State;
use tauri::ipc::Channel;

use super::generate::{self, DeckOptions, Finished, QuizOptions, StudyEvent};
use super::model::{self, AnyModel};
use super::quiz::{Answer, Quiz};
use crate::AppState;

fn space_dir(state: &AppState, space: &str) -> Result<PathBuf, String> {
    state.vault.space_dir(space)
}

fn model_for(state: &AppState, dir: &std::path::Path) -> Result<AnyModel, String> {
    model::for_space(&state.vault, dir, state.isolated_config_root.as_deref())
}

/// The courses the space may see and the parts of each it may see, for choosing what to make cards from.
#[tauri::command]
pub(crate) fn study_sources(state: State<'_, AppState>, space: String) -> Result<Vec<super::sources::CourseSource>, String> {
    space_dir(&state, &space)?;
    Ok(super::sources::courses(&crate::lms::access::visible(&state.vault, &space)))
}

#[tauri::command]
pub(crate) fn study_overview(state: State<'_, AppState>, space: String) -> Result<super::Overview, String> {
    Ok(super::overview(&space_dir(&state, &space)?, super::now_ms()))
}

#[tauri::command]
pub(crate) fn study_deck(state: State<'_, AppState>, space: String, path: String) -> Result<super::DeckView, String> {
    super::deck_view(&space_dir(&state, &space)?, &path)
}

/// Create (no `path`) or edit a deck; returns its path.
#[tauri::command]
pub(crate) fn study_deck_save(state: State<'_, AppState>, space: String, path: Option<String>, title: String, cards: Vec<super::CardInput>) -> Result<String, String> {
    super::deck_save(&space_dir(&state, &space)?, path.as_deref(), &title, &cards)
}

/// `paths` null: everything due (and new) in the space.
#[tauri::command]
pub(crate) fn study_session(state: State<'_, AppState>, space: String, paths: Option<Vec<String>>, limit: Option<usize>) -> Result<Vec<super::SessionCard>, String> {
    super::session(&space_dir(&state, &space)?, paths.as_deref(), limit.unwrap_or(20), super::now_ms())
}

#[tauri::command]
pub(crate) fn study_rate(state: State<'_, AppState>, space: String, deck: String, card: String, confidence: u8) -> Result<super::Rated, String> {
    super::rate(&space_dir(&state, &space)?, &deck, &card, confidence, super::now_ms())
}

#[tauri::command]
pub(crate) fn study_quiz(state: State<'_, AppState>, space: String, path: String) -> Result<Quiz, String> {
    super::load_quiz(&space_dir(&state, &space)?, &path).map(|(_, q)| q)
}

#[tauri::command]
pub(crate) fn study_delete(state: State<'_, AppState>, space: String, path: String) -> Result<(), String> {
    super::delete(&space_dir(&state, &space)?, &path)
}

fn sender(ch: &Channel<StudyEvent>) -> impl Fn(StudyEvent) + Send + Sync + '_ {
    move |e| {
        // The webview may have reloaded; the work still finishes.
        let _ = ch.send(e);
    }
}

#[tauri::command]
pub(crate) async fn study_make_deck(state: State<'_, AppState>, space: String, sources: Vec<String>, options: DeckOptions, on_event: Channel<StudyEvent>) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        let m = model_for(&state, &dir)?;
        generate::make_deck(&dir, &crate::lms::access::visible(&state.vault, &space), &sources, &options, &m, &emit, super::now_ms()).await
    };
    emit(match run.await {
        Ok((path, cards, grounding)) => StudyEvent::Done(Finished { path: Some(path), cards: Some(cards), grounding: Some(Box::new(grounding)), ..Default::default() }),
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn study_make_quiz(state: State<'_, AppState>, space: String, sources: Vec<String>, options: QuizOptions, on_event: Channel<StudyEvent>) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        let m = model_for(&state, &dir)?;
        generate::make_quiz(&dir, &crate::lms::access::visible(&state.vault, &space), &sources, &options, &m, &emit, super::now_ms()).await
    };
    emit(match run.await {
        Ok((path, questions, grounding)) => StudyEvent::Done(Finished { path: Some(path), questions: Some(questions), grounding: Some(Box::new(grounding)), ..Default::default() }),
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn study_quiz_submit(
    state: State<'_, AppState>,
    space: String,
    path: String,
    answers: HashMap<String, Answer>,
    on_event: Channel<StudyEvent>,
) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        generate::submit(&dir, &path, &answers, || model_for(&state, &dir), &emit, super::now_ms()).await
    };
    emit(match run.await {
        Ok(attempt) => StudyEvent::Done(Finished { attempt: Some(attempt), ..Default::default() }),
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

/// What to study next after an attempt. Making a deck from its mistakes is
/// `study_make_deck` with `fromAttempt`.
#[tauri::command]
pub(crate) async fn study_review_mistakes(state: State<'_, AppState>, space: String, attempt_path: String, on_event: Channel<StudyEvent>) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        generate::review(&dir, &attempt_path, || model_for(&state, &dir), &emit).await
    };
    emit(match run.await {
        Ok(summary) => StudyEvent::Done(Finished { summary: Some(summary), ..Default::default() }),
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

// ---- A quiz or deck offered in a chat reply (chat.rs) ----

/// What a reply's phaethon-study block will make, checked; `Err` in plain words.
#[tauri::command]
pub(crate) fn study_chat_plan(state: State<'_, AppState>, space: String, block: String, question: String) -> Result<super::chat::Plan, String> {
    let dir = space_dir(&state, &space)?;
    let visible = crate::lms::access::visible(&state.vault, &space);
    let mut plan = super::chat::plan(&dir, &visible, &block, &question)?;
    plan.material = super::chat::material_alert(&dir, &visible, &plan, &crate::vision::for_space(&state.vault, &dir));
    Ok(plan)
}

/// Make what the block describes, with the conversation as context. Made
/// already: `done` with what was made, no model call. Being made: an error
/// that says so. Stopped with `study_chat_cancel`: `cancelled`.
#[tauri::command]
pub(crate) async fn study_chat_make(
    state: State<'_, AppState>,
    space: String,
    block: String,
    question: String,
    reply: String,
    on_event: Channel<StudyEvent>,
) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        let visible = crate::lms::access::visible(&state.vault, &space);
        let plan = super::chat::plan(&dir, &visible, &block, &question)?;
        let done = |path: String, n: usize, grounding: Option<super::grounded::Grounding>| match plan.kind {
            super::chat::Kind::Quiz => Finished { path: Some(path), questions: Some(n), grounding: grounding.map(Box::new), ..Default::default() },
            super::chat::Kind::Deck => Finished { path: Some(path), cards: Some(n), grounding: grounding.map(Box::new), ..Default::default() },
        };
        if let Some(path) = plan.made.clone() {
            return Ok(Some(done(path, 0, None)));
        }
        let Some(mut run) = super::chat::Run::claim(&dir, &plan.origin) else {
            return Err("This is already being made. It opens in Study when it’s ready.".to_string());
        };
        let m = model_for(&state, &dir)?;
        tokio::select! {
            made = super::chat::make(&dir, &visible, &plan, &question, &reply, &m, &emit, super::now_ms()) => made.map(|(path, n, g)| Some(done(path, n, g))),
            // Dropping the model call stops it (a CLI child is killed with it).
            _ = run.cancelled() => Ok(None),
        }
    };
    emit(match run.await {
        Ok(Some(f)) => StudyEvent::Done(f),
        Ok(None) => StudyEvent::Cancelled,
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

/// Stop making a block's quiz or deck (by the plan's origin). False when it wasn't being made.
#[tauri::command]
pub(crate) fn study_chat_cancel(state: State<'_, AppState>, space: String, origin: String) -> Result<bool, String> {
    Ok(super::chat::cancel(&space_dir(&state, &space)?, &origin))
}

// ---- What a course teaches and its exams cover (scope.rs) ----

/// A course's scope map as this space sees it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeView {
    /// "courses/<folder>"
    pub course: String,
    pub name: String,
    /// "none" (never mapped), "fresh", or "stale" (the course changed since).
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<super::scope::ScopeMap>,
    /// What the person said exams cover.
    pub stated: Vec<super::scope::Stated>,
    /// What the course's documents are made of, and whether the space's model can look at the pictures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material: Option<super::material::MaterialView>,
}

/// The course `course` names ("courses/<folder>" or the folder) among those the space sees.
fn seen_course<'a>(visible: &'a crate::lms::access::Visible, course: &str) -> Result<&'a crate::lms::access::Seen, String> {
    let folder = course.trim().trim_end_matches('/').trim_start_matches("courses/");
    visible.get(folder).ok_or_else(|| "That course isn’t one this space can see.".to_string())
}

/// The material view for a course: each exam the map found, with what the
/// person said one covers (once it has been read against the map) in place of
/// what was found.
fn scope_material(visible: &crate::lms::access::Visible, seen: &crate::lms::access::Seen, map: Option<&super::scope::ScopeMap>, sight: &crate::vision::Sight) -> Option<super::material::MaterialView> {
    let mut exams: Vec<super::scope::ExamScope> = map.map(|m| m.exams.clone()).unwrap_or_default();
    for s in super::scope::stated(visible, seen) {
        let resolved = map.is_some_and(|m| s.resolved_for.as_deref() == Some(m.fingerprint.as_str())) && !s.includes.is_empty();
        let said = super::scope::ExamScope { title: s.exam.clone(), date: None, known: resolved, summary: s.text.clone(), includes: s.includes.clone(), excludes: s.excludes.clone(), excluded_words: vec![], homework: vec![], evidence: vec![], from_user: true };
        match exams.iter_mut().find(|e| super::scope::find_exam(std::slice::from_ref(&said), &e.title).is_some()) {
            Some(e) if resolved => *e = super::scope::ExamScope { title: e.title.clone(), date: e.date.clone(), ..said },
            Some(_) => {}
            None => exams.push(said),
        }
    }
    super::material::view(seen, map, &exams, sight)
}

#[tauri::command]
pub(crate) fn study_scope(state: State<'_, AppState>, space: String, course: String) -> Result<ScopeView, String> {
    let dir = space_dir(&state, &space)?;
    let visible = crate::lms::access::visible(&state.vault, &space);
    let seen = seen_course(&visible, &course)?;
    let kept = super::scope::cached(&visible, seen, None);
    let material = scope_material(&visible, seen, kept.as_ref().map(|(m, _)| m), &crate::vision::for_space(&state.vault, &dir));
    Ok(ScopeView {
        course: format!("courses/{}", seen.folder()),
        name: seen.state.name.clone(),
        state: match &kept {
            None => "none",
            Some((_, true)) => "fresh",
            Some((_, false)) => "stale",
        },
        map: kept.map(|(m, _)| m),
        stated: super::scope::stated(&visible, seen),
        material,
    })
}

/// Map the course again (model calls: `mapping` progress, then `done` or `error`).
#[tauri::command]
pub(crate) async fn study_scope_build(state: State<'_, AppState>, space: String, course: String, on_event: Channel<StudyEvent>) -> Result<(), String> {
    let emit = sender(&on_event);
    let run = async {
        let dir = space_dir(&state, &space)?;
        let visible = crate::lms::access::visible(&state.vault, &space);
        let seen = seen_course(&visible, &course)?;
        let m = model_for(&state, &dir)?;
        emit(StudyEvent::progress("mapping", 0, 1));
        let progress = |d: usize, t: usize| emit(StudyEvent::progress("mapping", d, t));
        super::scope::build(&visible, seen, &super::load_exams(&dir), &m, super::now_ms(), &progress).await
    };
    emit(match run.await {
        Ok(_) => StudyEvent::Done(Finished::default()),
        Err(message) => StudyEvent::Error { message },
    });
    Ok(())
}

/// Say what an exam covers (kept for the course, shown as "from you"); empty `text` forgets it.
#[tauri::command]
pub(crate) fn study_scope_state(state: State<'_, AppState>, space: String, course: String, exam: String, text: String) -> Result<(), String> {
    space_dir(&state, &space)?;
    let visible = crate::lms::access::visible(&state.vault, &space);
    super::scope::state(&visible, seen_course(&visible, &course)?, &exam, &text, super::now_ms())
}

/// Whether each `[source: … "…"]` in a reply is really in that file, as this space may read it.
#[tauri::command]
pub(crate) fn study_citations_check(state: State<'_, AppState>, space: String, citations: Vec<super::citations::Asked>) -> Result<Vec<super::citations::Checked>, String> {
    let dir = space_dir(&state, &space)?;
    Ok(super::citations::check(&dir, &crate::lms::access::visible(&state.vault, &space), &citations))
}
