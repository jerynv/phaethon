//! Whether the model answering in a space can look at pictures, and what to
//! tell the person when their course leans on pages it can't read.
//!
//! - Claude Code and Codex: their models see pictures, and Study hands them
//!   the pages that are handwriting or diagrams (study/model.rs).
//! - Gemini CLI: its models see pictures, but Study has no way to hand them
//!   any yet.
//! - Phaethon's own providers: by the model's name, from a conservative list
//!   of families known to take images; a model it doesn't know is "unknown",
//!   never assumed to see. (The providers' model lists don't say, except
//!   OpenRouter's `architecture.input_modalities` and Ollama's `/api/show`
//!   `capabilities`; [`from_metadata`] reads those for when the model picker
//!   passes them on.)

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::agent::Cli;
use crate::vault::{Backend, Vault};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

/// From a provider's model metadata, where it says: OpenRouter's
/// `architecture.input_modalities`, Ollama's `capabilities`.
pub fn from_metadata(v: &Value) -> Option<Sees> {
    let list = v["architecture"]["input_modalities"].as_array().or_else(|| v["capabilities"].as_array())?;
    Some(if list.iter().any(|x| x.as_str().is_some_and(|s| s == "image" || s == "vision")) { Sees::Yes } else { Sees::No })
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
            let sees = model_sees(r.provider.id, &r.model);
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
        assert_eq!(from_metadata(&serde_json::json!({"architecture": {"input_modalities": ["text", "image"]}})), Some(Sees::Yes));
        assert_eq!(from_metadata(&serde_json::json!({"capabilities": ["completion", "vision"]})), Some(Sees::Yes));
        assert_eq!(from_metadata(&serde_json::json!({"capabilities": ["completion"]})), Some(Sees::No));
        assert_eq!(from_metadata(&serde_json::json!({"id": "x"})), None);
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
