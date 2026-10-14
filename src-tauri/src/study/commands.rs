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
        generate::make_deck(&dir, &crate::lms::access::visible(&state.vault, &space), &sources, &options, &m, &emit).await
    };
    emit(match run.await {
        Ok((path, cards)) => StudyEvent::Done(Finished { path: Some(path), cards: Some(cards), ..Default::default() }),
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
        Ok((path, questions)) => StudyEvent::Done(Finished { path: Some(path), questions: Some(questions), ..Default::default() }),
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
    super::chat::plan(&dir, &crate::lms::access::visible(&state.vault, &space), &block, &question)
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
        let done = |path: String, n: usize| match plan.kind {
            super::chat::Kind::Quiz => Finished { path: Some(path), questions: Some(n), ..Default::default() },
            super::chat::Kind::Deck => Finished { path: Some(path), cards: Some(n), ..Default::default() },
        };
        if let Some(path) = plan.made.clone() {
            return Ok(Some(done(path, 0)));
        }
        let Some(mut run) = super::chat::Run::claim(&dir, &plan.origin) else {
            return Err("This is already being made. It opens in Study when it’s ready.".to_string());
        };
        let m = model_for(&state, &dir)?;
        tokio::select! {
            made = super::chat::make(&dir, &visible, &plan, &question, &reply, &m, &emit, super::now_ms()) => made.map(|(path, n)| Some(done(path, n))),
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
