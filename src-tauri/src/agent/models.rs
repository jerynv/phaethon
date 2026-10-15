//! The models each CLI offers, from the CLI itself, for a space's model menu.
//! Phaethon never asks a provider with a CLI's sign-in and never reads what
//! the CLI saved; it runs the CLI (with the vault's own home for it) or reads
//! what the CLI documents. Checked against the installed versions, Oct 2026:
//!
//! - Codex 0.162: `codex debug models` prints its model catalog as JSON (the
//!   one shipped with it, refreshed by Codex itself when signed in); the
//!   models it shows in its own picker are `"visibility": "list"`, ordered by
//!   `priority`.
//! - Claude Code 2.1: no listing command; `claude --help` names the aliases
//!   `--model` takes ("e.g. 'fable', 'opus', or 'sonnet'") or a full name.
//! - Gemini CLI 0.63: no listing command or help text; its own model menu's
//!   choices are the aliases in its bundled source (`GEMINI_MODEL_ALIAS_*`:
//!   auto, pro, flash, flash-lite), read from its install.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::{Cli, command, is_valid_cli_model};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliModel {
    /// What the CLI is given (`-m`, `--model`).
    pub id: String,
    /// Its name for people.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliModels {
    pub models: Vec<CliModel>,
    /// Plain words when the CLI can't list its models (or couldn't now): what
    /// the list is instead, or why there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

const WAIT: Duration = Duration::from_secs(20);

/// The models `cli` offers. `home` is the vault's own home for Codex and
/// Gemini CLI (and Claude Code's when the vault keeps one).
pub async fn list(cli: Cli, home: Option<&Path>) -> CliModels {
    let Some(bin) = cli.find() else {
        return CliModels { models: vec![], note: Some(format!("{} isn’t installed on this computer.", cli.name())) };
    };
    match cli {
        Cli::Codex => codex(&bin, home).await,
        Cli::Claude => claude(&bin, home).await,
        Cli::Gemini => gemini(&bin),
    }
}

async fn output(cli: Cli, bin: &Path, home: Option<&Path>, args: &[&str]) -> Option<String> {
    let mut cmd = command(cli, bin, &std::env::temp_dir(), home);
    cmd.args(args).stdin(Stdio::null());
    let out = tokio::time::timeout(WAIT, cmd.output()).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn codex(bin: &Path, home: Option<&Path>) -> CliModels {
    let listed = match output(Cli::Codex, bin, home, &["debug", "models"]).await {
        Some(json) => parse_codex(&json),
        None => None,
    };
    match listed {
        Some(models) if !models.is_empty() => CliModels { models, note: None },
        _ => CliModels { models: vec![], note: Some("Codex couldn’t list its models just now. Type a model’s name with Another model…".into()) },
    }
}

/// `codex debug models`: the models Codex lists in its own picker, in its order.
pub(crate) fn parse_codex(json: &str) -> Option<Vec<CliModel>> {
    let v: Value = serde_json::from_str(json).ok()?;
    let mut listed: Vec<(i64, CliModel)> = v
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let id = m.get("slug")?.as_str()?.to_string();
            is_valid_cli_model(&id).then_some(())?;
            let name = m.get("display_name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(&id).to_string();
            let description = m.get("description").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty()).map(str::to_string);
            Some((m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX), CliModel { id, name, description }))
        })
        .collect();
    listed.sort_by_key(|(p, _)| *p);
    Some(listed.into_iter().map(|(_, m)| m).collect())
}

async fn claude(bin: &Path, home: Option<&Path>) -> CliModels {
    let models = output(Cli::Claude, bin, home, &["--help"]).await.map(|h| parse_claude_help(&h)).unwrap_or_default();
    CliModels {
        note: Some(if models.is_empty() {
            "Claude Code can’t list its models. Type a model’s name with Another model…".into()
        } else {
            "Claude Code can’t list its models: these are the names its help gives, each its newest model of that kind. Another model… takes a model’s full name.".into()
        }),
        models,
    }
}

/// The aliases `claude --help` gives for `--model`: the quoted names in its
/// description ("Provide an alias for the latest model (e.g. 'fable', 'opus',
/// or 'sonnet') or a model's full name.").
pub(crate) fn parse_claude_help(help: &str) -> Vec<CliModel> {
    let mut lines = help.lines().skip_while(|l| !l.trim_start().starts_with("--model "));
    let Some(first) = lines.next() else { return vec![] };
    let mut text = first.to_string();
    for l in lines.take_while(|l| !l.trim_start().starts_with('-')) {
        text.push(' ');
        text.push_str(l.trim());
    }
    let mut out: Vec<CliModel> = vec![];
    for (i, part) in text.split('\'').enumerate() {
        if i % 2 == 1 && is_valid_cli_model(part) && !out.iter().any(|m| m.id == part) {
            out.push(CliModel { id: part.into(), name: capitalized(part), description: None });
        }
    }
    out
}

fn gemini(bin: &Path) -> CliModels {
    let models = bin.canonicalize().ok().and_then(|real| real.parent().map(gemini_aliases)).unwrap_or_default();
    CliModels {
        note: Some(if models.is_empty() {
            "Gemini CLI can’t list its models. Type a model’s name with Another model…".into()
        } else {
            "Gemini CLI can’t list its models: these are the choices its own model menu offers. Another model… takes a model’s full name.".into()
        }),
        models,
    }
}

/// The aliases in Gemini CLI's bundled source in `dir` (`var GEMINI_MODEL_ALIAS_PRO = "pro";`).
pub(crate) fn gemini_aliases(dir: &Path) -> Vec<CliModel> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<CliModel> = vec![];
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "js") || e.metadata().map(|m| m.len() > 64 << 20).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        for (i, _) in text.match_indices("var GEMINI_MODEL_ALIAS_") {
            let Some(line) = text[i..].lines().next() else { continue };
            let Some(value) = line.split('"').nth(1) else { continue };
            if is_valid_cli_model(value) && !out.iter().any(|m| m.id == value) {
                out.push(CliModel { id: value.into(), name: capitalized(value), description: None });
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// "flash-lite" → "Flash-Lite".
fn capitalized(id: &str) -> String {
    id.split('-')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_lists_what_its_own_picker_shows_in_its_order() {
        let json = r#"{"models":[
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","description":"Frontier intelligence.","visibility":"list","priority":2},
            {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","description":"Latest workhorse.","visibility":"list","priority":1},
            {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","priority":43},
            {"slug":"--yolo","display_name":"x","visibility":"list","priority":3}
        ]}"#;
        let m = parse_codex(json).unwrap();
        assert_eq!(m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-6-astra"]);
        assert_eq!(m[0], CliModel { id: "gpt-6.1-sol".into(), name: "GPT-6.1-Sol".into(), description: Some("Latest workhorse.".into()) });
        assert_eq!(parse_codex("not json"), None);
    }

    #[test]
    fn claude_codes_help_gives_its_aliases() {
        // As claude 2.1.296 prints it, wrapped.
        let help = "  --fallback-model <model>              Enable automatic fallback\n  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name ('x')\n";
        let m = parse_claude_help(help);
        assert_eq!(m.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect::<Vec<_>>(), [("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet")]);
        assert!(parse_claude_help("no such option").is_empty());
    }

    #[test]
    fn gemini_clis_aliases_come_from_its_bundle() {
        let dir = std::env::temp_dir().join(format!("phaethon-gemini-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chunk-A.js"), "var x = 1;\n").unwrap();
        std::fs::write(
            dir.join("chunk-B.js"),
            "var GEMINI_MODEL_ALIAS_AUTO = \"auto\";\nvar GEMINI_MODEL_ALIAS_PRO = \"pro\";\nvar GEMINI_MODEL_ALIAS_FLASH = \"flash\";\nvar GEMINI_MODEL_ALIAS_FLASH_LITE = \"flash-lite\";\n",
        )
        .unwrap();
        let m = gemini_aliases(&dir);
        assert_eq!(m.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect::<Vec<_>>(), [("auto", "Auto"), ("pro", "Pro"), ("flash", "Flash"), ("flash-lite", "Flash-Lite")]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
