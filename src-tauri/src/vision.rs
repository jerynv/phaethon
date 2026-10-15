//! Whether the model answering in a space can look at pictures, and what to
//! tell the person when their course leans on pages it can't read.
//!
//! - Claude Code and Codex: their models see pictures, and Study hands them
//!   the pages that are handwriting or diagrams (study/model.rs).
//! - Gemini CLI: its models see pictures, but Study has no way to hand them
//!   any yet.
//! - Phaethon's own providers: what the provider's model list said, where it
//!   says (OpenRouter's `architecture.input_modalities`; Ollama's
//!   `capabilities` from `/api/tags` or `/api/show`: [`from_metadata`]), kept
//!   by [`remember`] whenever a list is fetched (openai.rs) and on disk
//!   between launches. Otherwise by the model's name, from a conservative
//!   list of families known to take images; a model it doesn't know is
//!   "unknown", never assumed to see.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::Cli;
use crate::vault::{Backend, Vault};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sees {
    Yes,
    No,
    Unknown,
}

/// What a space's model can do with pictures.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sight {
    pub sees: Sees,
    /// The model or program as the person knows it ("Claude Code", "gpt-3.5-turbo").
    pub model: String,
    /// Study shows it the pictures of handwriting and diagram pages.
    pub shown: bool,
}

pub const BETTER: &str = "A model that can read pictures (for example Claude, GPT-4o or newer, Gemini, or a vision model such as Llama 3.2 Vision in Ollama) would do better.";

/// Model names (any provider) of families known to take images.
const SEE: &[&str] = &[
    "claude-3", "claude-opus", "claude-sonnet", "claude-haiku", "claude-4", "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "chatgpt-4o", "o4-mini",
    "gemini", "gemma-3", "gemma3", "llava", "bakllava", "vision", "pixtral", "moondream", "minicpm-v", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen2.5vl", "qwen3-vl",
    "-vl-", "-vl:", "llama-4", "llama4", "grok-4", "grok-2-vision", "mistral-small3.1", "mistral-small-3.1", "mistral-medium-3", "granite3.2-vision", "phi-3.5-vision",
    "phi-4-multimodal", "kimi-vl", "glm-4v", "glm-4.5v",
];
/// Names known not to take images (checked first: "o3-mini" before "o3").
const BLIND: &[&str] = &["gpt-3.5", "gpt-4-0613", "gpt-4-32k", "o1-mini", "o1-preview", "o3-mini", "claude-2", "claude-instant", "deepseek", "embed", "whisper", "tts", "codestral", "devstral"];

/// Whether `model` (as `provider` names it) takes images, by its name.
pub fn model_sees(provider: &str, model: &str) -> Sees {
    let m = model.to_lowercase();
    // OpenRouter and some servers write "vendor/model".
    let bare = m.rsplit('/').next().unwrap_or(&m);
    if BLIND.iter().any(|b| bare.contains(b)) || provider == "deepseek" {
        return Sees::No;
    }
    if SEE.iter().any(|s| bare.contains(s) || m.contains(s)) || bare.ends_with("-vl") {
        return Sees::Yes;
    }
    // OpenAI's own reasoning models o1 and o3 take images; plain gpt-4 doesn't.
    if (provider == "openai" || m.starts_with("openai/")) && (bare == "o1" || bare.starts_with("o1-2") || bare == "o3" || bare.starts_with("o3-2") || bare.starts_with("o3-pro")) {
        return Sees::Yes;
    }
    if (provider == "openai" || m.starts_with("openai/")) && bare.starts_with("gpt-4") {
        return Sees::No;
    }
    if provider == "anthropic" && bare.starts_with("claude-") {
        return Sees::Yes;
    }
    Sees::Unknown
}

/// From one model's entry in a provider's model list, where it says:
/// `architecture.input_modalities` (OpenRouter, and servers that copy its
/// list) naming "image"; else Ollama's `capabilities` naming "vision"
/// (Ollama's "image" is a model that makes pictures, not one that reads
/// them). `None` when the entry says nothing about what it takes in.
pub fn from_metadata(v: &Value) -> Option<Sees> {
    let has = |list: &Vec<Value>, word: &str| list.iter().any(|x| x.as_str().is_some_and(|s| s.eq_ignore_ascii_case(word)));
    if let Some(list) = v["architecture"]["input_modalities"].as_array() {
        return Some(if has(list, "image") { Sees::Yes } else { Sees::No });
    }
    let list = v["capabilities"].as_array().filter(|l| !l.is_empty())?;
    Some(if has(list, "vision") { Sees::Yes } else { Sees::No })
}

// ---- What providers' model lists said ----------------------------------------------

/// What each provider's list (at its address) said about pictures, by model.
#[derive(Default, Serialize, Deserialize)]
struct Known {
    #[serde(default)]
    lists: BTreeMap<String, BTreeMap<String, Sees>>,
}

/// Most lists, and models in one, kept.
const KNOWN_LISTS: usize = 32;
const KNOWN_MODELS: usize = 5000;

/// What lists said, and the file it is kept in (none in unit tests).
fn known_cell() -> &'static Mutex<(Known, Option<PathBuf>)> {
    static K: OnceLock<Mutex<(Known, Option<PathBuf>)>> = OnceLock::new();
    K.get_or_init(Mutex::default)
}

fn list_key(provider: &str, base: &str) -> String {
    format!("{provider} {}", base.trim_end_matches('/'))
}

/// Keep what lists say in `file` (the app's data, not the synced vault: an
/// Ollama's models are this computer's), and read what it kept last time.
pub fn keep_at(file: PathBuf) {
    let read: Known = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut k = known_cell().lock().unwrap_or_else(|e| e.into_inner());
    for (list, models) in read.lists {
        k.0.lists.entry(list).or_insert(models);
    }
    k.1 = Some(file);
}

/// What `provider`'s list at `base` says now, for the models whose entry
/// said (see [`from_metadata`]): it replaces what that list said before. A
/// list that said nothing about any model is forgotten (names are used again).
pub fn remember(provider: &str, base: &str, models: impl IntoIterator<Item = (String, Sees)>) {
    let models: BTreeMap<String, Sees> = models.into_iter().take(KNOWN_MODELS).collect();
    let mut k = known_cell().lock().unwrap_or_else(|e| e.into_inner());
    let key = list_key(provider, base);
    if models.is_empty() {
        if k.0.lists.remove(&key).is_none() {
            return;
        }
    } else {
        if k.0.lists.get(&key) == Some(&models) || (!k.0.lists.contains_key(&key) && k.0.lists.len() >= KNOWN_LISTS) {
            return;
        }
        k.0.lists.insert(key, models);
    }
    if let Some(file) = k.1.clone()
        && let Ok(json) = serde_json::to_vec(&k.0)
    {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }
}

/// What `provider`'s list at `base` said about `model`, if it said.
pub fn known(provider: &str, base: &str, model: &str) -> Option<Sees> {
    let k = known_cell().lock().unwrap_or_else(|e| e.into_inner());
    k.0.lists.get(&list_key(provider, base))?.get(model).copied()
}

/// Whether `model` from `provider` at `base` takes images: what its list
/// said, else by its name.
pub fn sees(provider: &str, base: &str, model: &str) -> Sees {
    known(provider, base, model).unwrap_or_else(|| model_sees(provider, model))
}

/// The space's model, as Study will ask it (study/model.rs's choice), without
/// reading the keychain.
pub fn for_space(vault: &Vault, space_dir: &Path) -> Sight {
    let settings = vault.settings();
    match settings.backend {
        Backend::ClaudeCli => return Sight { sees: Sees::Yes, model: Cli::Claude.name().into(), shown: true },
        b => {
            if let Some(cli) = Cli::of(b) {
                return match cli {
                    Cli::Gemini => Sight { sees: Sees::Yes, model: cli.name().into(), shown: false },
                    _ => Sight { sees: Sees::Yes, model: cli.name().into(), shown: true },
                };
            }
        }
    }
    match crate::providers::model_for_space(&settings, space_dir) {
        Ok(r) => {
            let base = crate::providers::base_url(&settings, r.provider).unwrap_or_default();
            let sees = sees(r.provider.id, &base, &r.model);
            Sight { sees, model: r.model, shown: sees == Sees::Yes }
        }
        Err(_) => Sight { sees: Sees::Unknown, model: crate::providers::chosen(&settings).name.to_string(), shown: false },
    }
}

/// A note for the person.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// "cantSee", "unknown" or "notShown".
    pub kind: &'static str,
    pub text: String,
}

/// What to say when material (`of`: "this course", "Test 1’s material") has
/// `pages` pages that are handwriting, scans or diagrams, to a person whose
/// model is `sight`. `None` when there is nothing to warn about: no such
/// pages, or a model that is shown them.
pub fn alert(pages: u32, of: &str, sight: &Sight) -> Option<Alert> {
    if pages == 0 || (sight.sees == Sees::Yes && sight.shown) {
        return None;
    }
    let are = if pages == 1 { format!("1 page of {of} is handwriting or a diagram") } else { format!("{pages} pages of {of} are handwriting or diagrams") };
    let effect = "Questions from those pages may have mistakes or be missed.";
    Some(match (sight.sees, sight.shown) {
        (Sees::No, _) => Alert { kind: "cantSee", text: format!("Your model can’t look at pictures, and {are}. {effect} {BETTER}") },
        (Sees::Unknown, _) => Alert {
            kind: "unknown",
            text: format!("Phaethon can’t tell whether your model ({}) can look at pictures, and {are}. If it can’t, questions from those pages may have mistakes or be missed. {BETTER}", sight.model),
        },
        (Sees::Yes, _) => Alert {
            kind: "notShown",
            text: format!("Phaethon can’t show pictures to {} yet, and {are}. {effect} Claude Code, Codex, or a model of your own that can read pictures would do better.", sight.model),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_are_known_to_see_known_not_to_or_unknown() {
        for (p, m) in [("anthropic", "claude-opus-5-5"), ("anthropic", "claude-3-5-haiku-latest"), ("openai", "gpt-4o-mini"), ("openai", "gpt-5"), ("openai", "o3"), ("openai", "o4-mini"),
            ("openrouter", "google/gemini-2.5-pro"), ("openrouter", "anthropic/claude-sonnet-4.5"), ("openrouter", "qwen/qwen2.5-vl-72b-instruct"), ("ollama", "llama3.2-vision:11b"),
            ("ollama", "llava:13b"), ("ollama", "gemma3:12b"), ("mistral", "pixtral-large-latest"), ("groq", "meta-llama/llama-4-scout-17b-16e-instruct"), ("xai", "grok-4")]
        {
            assert_eq!(model_sees(p, m), Sees::Yes, "{p} {m}");
        }
        for (p, m) in [("openai", "gpt-3.5-turbo"), ("openai", "gpt-4"), ("openai", "o3-mini"), ("openai", "o1-mini"), ("deepseek", "deepseek-chat"), ("openrouter", "deepseek/deepseek-r1"), ("anthropic", "claude-2.1"), ("mistral", "codestral-latest")] {
            assert_eq!(model_sees(p, m), Sees::No, "{p} {m}");
        }
        for (p, m) in [("ollama", "llama3.1:8b"), ("custom", "my-model"), ("together", "Qwen/Qwen2.5-72B-Instruct-Turbo"), ("groq", "llama-3.3-70b-versatile")] {
            assert_eq!(model_sees(p, m), Sees::Unknown, "{p} {m}");
        }
    }

    #[test]
    fn a_providers_list_says_what_its_models_take_in() {
        use serde_json::json;
        // OpenRouter's /models entries, as it publishes them (checked Oct 11 2026).
        let or = |inputs: Value| json!({"id": "x/y", "architecture": {"modality": "text->text", "input_modalities": inputs, "output_modalities": ["text"], "tokenizer": "Other"}});
        assert_eq!(from_metadata(&or(json!(["text", "image", "file"]))), Some(Sees::Yes));
        assert_eq!(from_metadata(&or(json!(["image", "text"]))), Some(Sees::Yes));
        assert_eq!(from_metadata(&or(json!(["text"]))), Some(Sees::No));
        // Ollama's /api/show and /api/tags (types/model/capability.go): "vision" reads pictures, "image" makes them.
        assert_eq!(from_metadata(&json!({"capabilities": ["completion", "vision"]})), Some(Sees::Yes));
        assert_eq!(from_metadata(&json!({"capabilities": ["completion", "tools", "thinking"]})), Some(Sees::No));
        assert_eq!(from_metadata(&json!({"capabilities": ["image"]})), Some(Sees::No));
        assert_eq!(from_metadata(&json!({"capabilities": []})), None, "an empty list says nothing");
        assert_eq!(from_metadata(&json!({"id": "x"})), None);
    }

    #[test]
    fn what_a_list_said_comes_before_the_name_and_the_next_list_replaces_it() {
        let base = "http://127.0.0.1:1/v1/";
        assert_eq!(sees("ollama", base, "llama3.1:8b"), Sees::Unknown, "by name");
        remember("ollama", base, [("llama3.1:8b".to_string(), Sees::No), ("my-vlm:latest".to_string(), Sees::Yes)]);
        assert_eq!(sees("ollama", "http://127.0.0.1:1/v1", "llama3.1:8b"), Sees::No, "the address with or without its last /");
        assert_eq!(sees("ollama", base, "my-vlm:latest"), Sees::Yes);
        assert_eq!(sees("ollama", "http://127.0.0.1:2/v1", "my-vlm:latest"), Sees::Unknown, "another server's list says nothing here");
        assert_eq!(sees("lmstudio", base, "my-vlm:latest"), Sees::Unknown);
        assert_eq!(sees("ollama", base, "llava:13b"), Sees::Yes, "not in the list: by name");
        remember("ollama", base, [("llama3.1:8b".to_string(), Sees::No)]);
        assert_eq!(sees("ollama", base, "my-vlm:latest"), Sees::Unknown, "gone from the list");
        // A list can also say a model named like a seeing one doesn't.
        remember("openrouter", "https://or.test/api/v1", [("acme/gemini-text-only".to_string(), Sees::No)]);
        assert_eq!(sees("openrouter", "https://or.test/api/v1", "acme/gemini-text-only"), Sees::No);
        remember("ollama", base, []);
        assert_eq!(sees("ollama", base, "llama3.1:8b"), Sees::Unknown, "a list that says nothing is forgotten");
    }

    #[test]
    fn what_lists_said_is_kept_on_disk_between_launches() {
        let dir = std::env::temp_dir().join(format!("phaethon-sight-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("model-pictures.json");
        std::fs::write(&file, r#"{"lists":{"openrouter https://kept.test/api/v1":{"acme/reader":"yes"}}}"#).unwrap();
        keep_at(file.clone());
        assert_eq!(known("openrouter", "https://kept.test/api/v1", "acme/reader"), Some(Sees::Yes));
        remember("openrouter", "https://kept2.test/api/v1", [("acme/blind".to_string(), Sees::No)]);
        let on_disk: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(on_disk["lists"]["openrouter https://kept2.test/api/v1"]["acme/blind"], "no");
        assert_eq!(on_disk["lists"]["openrouter https://kept.test/api/v1"]["acme/reader"], "yes");
        known_cell().lock().unwrap().1 = None;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_alert_comes_only_when_the_course_leans_on_pictures_the_model_isnt_shown() {
        let sight = |sees, shown| Sight { sees, model: "gpt-3.5-turbo".into(), shown };
        assert_eq!(alert(0, "this course", &sight(Sees::No, false)), None, "nothing to read from pictures");
        assert_eq!(alert(12, "this course", &sight(Sees::Yes, true)), None, "it sees, and is shown them");
        let a = alert(12, "this course", &sight(Sees::No, false)).unwrap();
        assert_eq!(a.kind, "cantSee");
        assert!(a.text.starts_with("Your model can’t look at pictures, and 12 pages of this course are handwriting or diagrams. Questions from those pages may have mistakes or be missed. A model that can read pictures (for example"), "{}", a.text);
        let a = alert(1, "Test 1’s material", &sight(Sees::Unknown, false)).unwrap();
        assert_eq!(a.kind, "unknown");
        assert!(a.text.starts_with("Phaethon can’t tell whether your model (gpt-3.5-turbo) can look at pictures, and 1 page of Test 1’s material is handwriting or a diagram."), "{}", a.text);
        let gemini = Sight { sees: Sees::Yes, model: "Gemini CLI".into(), shown: false };
        assert_eq!(alert(3, "this course", &gemini).unwrap().kind, "notShown");
    }
}
