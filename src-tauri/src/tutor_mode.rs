//! A space's tutor mode: `"tutorMode"` in `<space>/.phaethon/space.json`,
//! beside its name, colour and model, so it travels with the space. A mode
//! other than normal adds its instructions to the agent's system prompt
//! (agent_loop.rs) or, with Claude Code answering, to the CLI's through
//! `--append-system-prompt` (agent.rs). The file is user-editable: a value
//! that isn't a mode is read as normal.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::spaces::{self, meta_file, read_meta_raw, write_meta};
use crate::vault::Vault;

const FIELD: &str = "tutorMode";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Normal,
    /// Quiz me: one question at a time from the course material.
    Quiz,
    /// Explain it back (Feynman): the person explains, the agent finds the gaps.
    Explain,
    /// Socratic: questions and hints, never the answer straight away.
    Socratic,
    /// Exam cram: a high-yield summary, then practice.
    Cram,
}

impl Mode {
    pub const ALL: [Mode; 5] = [Mode::Normal, Mode::Quiz, Mode::Explain, Mode::Socratic, Mode::Cram];

    pub fn id(self) -> &'static str {
        match self {
            Mode::Normal => "normal",
            Mode::Quiz => "quiz",
            Mode::Explain => "explain",
            Mode::Socratic => "socratic",
            Mode::Cram => "cram",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.id() == s.trim())
    }

    fn title(self) -> &'static str {
        match self {
            Mode::Normal => "Normal",
            Mode::Quiz => "Quiz me",
            Mode::Explain => "Explain it back",
            Mode::Socratic => "Socratic",
            Mode::Cram => "Exam cram",
        }
    }

    /// What the agent is told to do in this mode; `None` for normal.
    pub fn instructions(self) -> Option<&'static str> {
        Some(match self {
            Mode::Normal => return None,
            Mode::Quiz => {
                "The user wants to be quizzed. Base every question on their own course material: before the first question, read the \
relevant course folder (README.md, syllabus.md, the notes, slides and readings the topic touches; PDFs and Office files have a text copy \
ending in .md beside them). If they haven't said which course or topic, ask once, briefly.\n\
- Ask exactly one question per message, then stop and wait for the answer. Never put the answer, a hint or the next question in the \
same message as a question.\n\
- When they answer, say plainly whether it is right, partly right or wrong, explain why in a few sentences, and name the file the answer \
comes from. Then ask the next question.\n\
- Mix recall, understanding and short worked problems. Make questions harder after right answers and easier after wrong ones, and come \
back later to anything they missed.\n\
- If they say \"I don't know\", teach the point briefly, then ask a similar question.\n\
- When they want to stop, give a short tally and the topics to review next."
            }
            Mode::Explain => {
                "The user wants to learn by explaining (the Feynman technique). Ask them to explain a concept from their course in their own \
words, as if to someone new to it; if they haven't chosen one, offer two or three from the course folder's current material.\n\
- Don't explain it for them first. Wait for their explanation.\n\
- Then point out, kindly and specifically: what they got right, any gaps, anything vague or hand-waved, and any mistakes, checked \
against the course's own material (read it; name the file).\n\
- Ask one follow-up question that targets the biggest gap, and let them try again. Repeat until their explanation is complete and \
simple, then summarise it in a few lines they could keep."
            }
            Mode::Socratic => {
                "The user wants to work things out themselves. Tutor them Socratically:\n\
- Never give the final answer or a full solution straight away, even when asked directly. Reply with a guiding question or a small \
hint that moves them one step forward.\n\
- Start by asking what they already know or have tried. Build on their reasoning; when a step is wrong, ask a question that lets them \
see why rather than correcting it outright.\n\
- Use their course material (read the course folder) so the hints match how their course teaches it.\n\
- Keep each message short: one question or one hint.\n\
- Only after they reach the answer, or ask three times in a row for it after real attempts, confirm or show it and explain the \
reasoning briefly."
            }
            Mode::Cram => {
                "The user is preparing for an exam soon and wants the most value for their time. Read the course folder first (README.md \
for what's coming up and the exam's scope, syllabus.md, the recent modules, notes and readings). Then:\n\
1. Give a high-yield summary: the key definitions, formulas, theorems and procedures the exam is most likely to test, as tight bullet \
points, with the file each comes from. Flag common mistakes.\n\
2. Then give practice: a few exam-style questions, one at a time, waiting for each answer before marking it and explaining briefly.\n\
3. End with a short list of what to review again, based on what they missed.\n\
Be concise. Prefer what the course emphasises (what the syllabus, slides and past assignments stress) over general knowledge."
            }
        })
    }
}

/// The mode saved for the space in `dir`; normal when none, or when the file can't be read.
pub fn get(dir: &Path) -> Mode {
    read_meta_raw(dir)
        .ok()
        .flatten()
        .and_then(|meta| meta.get(FIELD)?.as_str().and_then(Mode::parse))
        .unwrap_or_default()
}

/// The system prompt section for the space's mode, or `None` in normal mode.
pub fn prompt_section(dir: &Path) -> Option<String> {
    let mode = get(dir);
    let text = mode.instructions()?;
    Some(format!(
        "# Tutor mode: {}\n\nThe user turned this on for this space, so it holds for every message until they turn it off. {text}",
        mode.title()
    ))
}

/// Claude Code's arguments for the space's mode: its instructions appended
/// to the CLI's own system prompt; none in normal mode. The text is fixed
/// here, never anything the user or a file wrote.
pub fn cli_args(dir: &Path) -> Vec<String> {
    prompt_section(dir).map(|s| vec!["--append-system-prompt".to_string(), s]).unwrap_or_default()
}

/// Save `mode` for the space; normal removes the field. Every other field in
/// space.json is kept; a file that can't be read is refused, not overwritten.
pub fn set(vault: &Vault, id: &str, mode: Mode) -> Result<(), String> {
    let dir = vault.space_dir(id)?;
    let mut meta = match read_meta_raw(&dir) {
        Ok(Some(serde_json::Value::Object(o))) => o,
        Ok(None) => serde_json::Map::new(),
        Ok(Some(_)) | Err(_) if meta_file(&dir).exists() => {
            return Err(format!(
                "This space’s settings file can’t be read, so the tutor mode wasn’t changed. Fix or delete {}.",
                meta_file(&dir).display()
            ));
        }
        _ => serde_json::Map::new(),
    };
    match mode {
        Mode::Normal => meta.remove(FIELD),
        m => meta.insert(FIELD.into(), m.id().into()),
    };
    write_meta(&dir, &meta).map_err(|e| format!("The tutor mode couldn’t be saved: {e}"))
}

/// Every space with a mode other than normal, by id.
pub fn list(vault: &Vault) -> Result<BTreeMap<String, Mode>, String> {
    Ok(spaces::list(vault)?
        .into_iter()
        .filter_map(|s| {
            let mode = get(&vault.space_dir(&s.id).ok()?);
            (mode != Mode::Normal).then_some((s.id, mode))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> (PathBuf, Vault) {
        let root = std::env::temp_dir().join(format!("phaethon-tutor-mode-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let vault = Vault::at(&root);
        vault.ensure_initialized().unwrap();
        (root, vault)
    }

    fn saved(root: &Path, id: &str) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(root.join("spaces").join(id).join(".phaethon/space.json")).unwrap()).unwrap()
    }

    #[test]
    fn each_space_keeps_its_own_mode_and_other_fields() {
        let (root, vault) = temp_vault("own");
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), r#"{"name":"Uni","hue":200,"model":"claude-haiku-5-5"}"#).unwrap();
        let (school, work) = (vault.space_dir("school").unwrap(), vault.space_dir("work").unwrap());
        assert_eq!(get(&school), Mode::Normal);

        set(&vault, "school", Mode::Quiz).unwrap();
        assert_eq!(get(&school), Mode::Quiz);
        assert_eq!(get(&work), Mode::Normal, "another space is not affected");
        assert_eq!(saved(&root, "school"), json!({ "name": "Uni", "hue": 200, "model": "claude-haiku-5-5", "tutorMode": "quiz" }));
        assert_eq!(list(&vault).unwrap(), BTreeMap::from([("school".to_string(), Mode::Quiz)]));
        // A rename or a model change keeps it.
        spaces::update(&vault, "school", Some("School"), None, None).unwrap();
        crate::space_model::set(&vault, "school", None).unwrap();
        assert_eq!(get(&school), Mode::Quiz);

        set(&vault, "school", Mode::Normal).unwrap();
        assert_eq!(saved(&root, "school"), json!({ "name": "School", "hue": 200 }));
        assert!(list(&vault).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ids_round_trip_and_anything_else_is_normal() {
        for m in Mode::ALL {
            assert_eq!(Mode::parse(m.id()), Some(m));
            assert_eq!(serde_json::to_value(m).unwrap(), json!(m.id()));
        }
        for bad in ["", "Quiz", "quiz me", "--help", "normal; rm"] {
            assert_eq!(Mode::parse(bad), None, "{bad:?}");
        }
        let (root, vault) = temp_vault("edited");
        let state = root.join("spaces/work/.phaethon");
        fs::create_dir_all(&state).unwrap();
        let dir = vault.space_dir("work").unwrap();
        for bad in [json!({ "tutorMode": "--help" }), json!({ "tutorMode": 3 }), json!({ "tutorMode": null }), json!([1])] {
            fs::write(state.join("space.json"), bad.to_string()).unwrap();
            assert_eq!(get(&dir), Mode::Normal, "{bad}");
            assert_eq!(prompt_section(&dir), None);
            assert!(cli_args(&dir).is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bad_spaces_and_unreadable_files_are_refused() {
        let (root, vault) = temp_vault("bad");
        for id in ["nope", "../memory", "", "work/../school"] {
            assert!(set(&vault, id, Mode::Cram).is_err(), "{id:?}");
        }
        let state = root.join("spaces/work/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), "{ broken").unwrap();
        let err = set(&vault, "work", Mode::Cram).unwrap_err();
        assert!(err.contains("can’t be read"), "{err}");
        assert_eq!(fs::read_to_string(state.join("space.json")).unwrap(), "{ broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn each_mode_has_its_own_instructions() {
        assert_eq!(Mode::Normal.instructions(), None);
        let quiz = Mode::Quiz.instructions().unwrap();
        assert!(quiz.contains("one question per message") && quiz.contains("wait"), "{quiz}");
        assert!(Mode::Socratic.instructions().unwrap().contains("Never give the final answer"));
        assert!(Mode::Explain.instructions().unwrap().contains("Feynman"));
        assert!(Mode::Cram.instructions().unwrap().contains("high-yield"));

        let (root, vault) = temp_vault("prompt");
        let dir = vault.space_dir("school").unwrap();
        set(&vault, "school", Mode::Socratic).unwrap();
        let section = prompt_section(&dir).unwrap();
        assert!(section.starts_with("# Tutor mode: Socratic"), "{section}");
        let args = cli_args(&dir);
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--append-system-prompt");
        assert_eq!(args[1], section);
        fs::remove_dir_all(root).unwrap();
    }
}
