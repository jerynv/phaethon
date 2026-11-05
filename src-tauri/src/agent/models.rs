//! The models each CLI offers, from the CLI itself, for a space's model menu.
//! Discovery runs the selected account's CLI, never a model turn. Claude uses
//! the same initialize capability response as T3's SDK adapter; Codex reads
//! its published catalog. Known Claude metadata provides an offline fallback.
//!
//! - Codex: app-server model/list reports canonical names, catalog default and
//!   model-specific reasoning levels; debug models is the offline fallback.
//! - Claude Code: stream-JSON initialize reports resolved names and effort levels.
//!   The version-filtered fallback is projected from T3's MIT model manifest,
//!   commit7f6f47b27b44456f1c8214d3b566b375c09f629e (2026-11-02).
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliModels {
    pub models: Vec<CliModel>,
    /// A short actionable error only when no usable catalog is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

const WAIT: Duration = Duration::from_secs(20);

/// The models `cli` offers. `home` is the vault's own home for Codex and
/// Gemini CLI (and Claude Code's when the vault keeps one).
pub async fn list(cli: Cli, home: Option<&Path>) -> CliModels {
    let Some(bin) = crate::agent_instances::binary(cli, home) else {
        return CliModels {
            models: vec![],
            note: Some(format!("{} isn’t installed.", cli.name())),
            default_model: None,
        };
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
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn codex(bin: &Path, home: Option<&Path>) -> CliModels {
    let mut cmd = command(Cli::Codex, bin, &std::env::temp_dir(), home);
    cmd.arg("app-server").stderr(Stdio::null());
    if let Some(models) = codex_catalog(cmd).await {
        return models;
    }
    let listed = match output(Cli::Codex, bin, home, &["debug", "models"]).await {
        Some(json) => parse_codex(&json),
        None => None,
    };
    match listed {
        Some(models) if !models.is_empty() => CliModels {
            models,
            note: None,
            default_model: None,
        },
        _ => CliModels {
            models: vec![],
            note: Some("Couldn’t load models. Retry.".into()),
            default_model: None,
        },
    }
}

/// The same metadata-only model/list protocol used by T3's Codex provider.
async fn codex_catalog(mut cmd: tokio::process::Command) -> Option<CliModels> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    tokio::time::timeout(WAIT, async {
        let mut child = cmd.spawn().ok()?;
        let mut input = child.stdin.take()?;
        let mut lines = BufReader::new(child.stdout.take()?.take(2 * 1024 * 1024)).lines();
        let init = serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"phaethon","version":"0.1.2"},"capabilities":{"experimentalApi":true}}});
        input.write_all(format!("{init}\n").as_bytes()).await.ok()?;
        input.flush().await.ok()?;
        let mut ready = false;
        for _ in 0..100 {
            let line = lines.next_line().await.ok()??;
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if value["id"] == 1 { ready = value.get("result").is_some(); break }
        }
        if !ready { return None }
        input.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n").await.ok()?;
        let mut result = CliModels { models: vec![], note: None, default_model: None };
        let mut cursors: Vec<String> = vec![];
        let mut cursor: Option<String> = None;
        for page in 0..32 {
            let id = page + 2;
            let request = serde_json::json!({"id":id,"method":"model/list","params":{"limit":100,"includeHidden":false,"cursor":cursor}});
            input.write_all(format!("{request}\n").as_bytes()).await.ok()?;
            input.flush().await.ok()?;
            let mut payload = None;
            for _ in 0..100 {
                let line = lines.next_line().await.ok()??;
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if value["id"] == id { payload = value.get("result").cloned(); break }
            }
            let payload = payload?;
            let page_models = parse_codex_app_models(&payload)?;
            if let Some(default) = page_models.default_model {
                if result.default_model.as_ref().is_some_and(|known| known != &default) { return None }
                result.default_model = Some(default);
            }
            for model in page_models.models {
                if !result.models.iter().any(|known| known.id == model.id) { result.models.push(model); }
                if result.models.len() > 1000 { return None }
            }
            let next = payload.get("nextCursor").and_then(Value::as_str).filter(|s| !s.is_empty());
            match next {
                None => { let _ = child.kill().await; return (!result.models.is_empty()).then_some(result) }
                Some(next) if cursors.iter().any(|seen| seen == next) => return None,
                Some(next) => { cursors.push(next.to_string()); cursor = Some(next.to_string()); }
            }
        }
        None
    }).await.ok().flatten()
}

fn parse_codex_app_models(response: &Value) -> Option<CliModels> {
    let rows = response.get("data")?.as_array()?;
    let mut models = vec![];
    let mut default_model = None;
    for row in rows.iter().take(1001) {
        if row.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let id = row.get("model").or_else(|| row.get("id"))?.as_str()?;
        if !is_valid_cli_model(id) {
            continue;
        }
        let name = row
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(id)
            .to_string();
        let reasoning_efforts = effort_levels(
            row.get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("reasoningEffort").and_then(Value::as_str)),
        );
        let default_reasoning_effort = row
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .filter(|e| reasoning_efforts.iter().any(|known| known == e))
            .map(str::to_string);
        let aliases = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|a| *a != id && is_valid_cli_model(a))
            .map(str::to_string)
            .into_iter()
            .collect();
        if row.get("isDefault").and_then(Value::as_bool) == Some(true) {
            if default_model.as_ref().is_some_and(|known| known != id) {
                return None;
            }
            default_model = Some(id.to_string());
        }
        models.push(CliModel {
            id: id.into(),
            name,
            description: row
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            aliases,
            reasoning_efforts,
            default_reasoning_effort,
        });
    }
    Some(CliModels {
        models,
        note: None,
        default_model,
    })
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
            let name = m
                .get("display_name")
                .and_then(Value::as_str)
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(&id)
                .to_string();
            let description = m
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string);
            let reasoning_efforts = effort_levels(
                m.get("supported_reasoning_levels")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.get("effort").and_then(Value::as_str)),
            );
            let default_reasoning_effort = m
                .get("default_reasoning_level")
                .and_then(Value::as_str)
                .filter(|e| reasoning_efforts.iter().any(|known| known == e))
                .map(str::to_string);
            let aliases = m
                .get("aliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|a| is_valid_cli_model(a))
                .map(str::to_string)
                .collect();
            Some((
                m.get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX),
                CliModel {
                    id,
                    name,
                    description,
                    aliases,
                    reasoning_efforts,
                    default_reasoning_effort,
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(p, _)| *p);
    Some(listed.into_iter().map(|(_, m)| m).collect())
}

fn effort_levels<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out = vec![];
    for value in values.take(64) {
        if [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
        .contains(&value)
            && !out.iter().any(|known| known == value)
        {
            out.push(value.to_string());
        }
    }
    out
}

async fn claude(bin: &Path, home: Option<&Path>) -> CliModels {
    let mut cmd = command(Cli::Claude, bin, &std::env::temp_dir(), home);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
    ])
    .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
    .env("CLAUDE_CODE_AUTO_CONNECT_IDE", "0")
    .env("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1")
    .stderr(Stdio::null());
    if let Some(models) = claude_initialize(cmd).await {
        return models;
    }
    let version = output(Cli::Claude, bin, home, &["--version"]).await;
    let models = claude_fallback(version.as_deref());
    CliModels {
        note: models
            .is_empty()
            .then(|| "Couldn’t load models. Retry.".into()),
        models,
        default_model: None,
    }
}

/// Initialize only: no user message is ever sent and no model turn is started.
async fn claude_initialize(mut cmd: tokio::process::Command) -> Option<CliModels> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    tokio::time::timeout(WAIT, async {
        let mut child = cmd.spawn().ok()?;
        let mut input = child.stdin.take()?;
        let request = serde_json::json!({"type":"control_request","request_id":"phaethon-models","request":{"subtype":"initialize"}});
        input.write_all(format!("{request}\n").as_bytes()).await.ok()?;
        input.flush().await.ok()?;
        let mut lines = BufReader::new(child.stdout.take()?.take(2 * 1024 * 1024)).lines();
        let mut result = None;
        for _ in 0..100 {
            let Some(line) = lines.next_line().await.ok()? else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            let response = &value["response"];
            if response["request_id"] == "phaethon-models" {
                if response["subtype"] == "success" { result = parse_claude_models(&response["response"]); }
                break;
            }
        }
        let _ = child.kill().await;
        result
    }).await.ok().flatten()
}

pub(crate) fn parse_claude_models(response: &Value) -> Option<CliModels> {
    let reported = response.get("models")?.as_array()?;
    let mut models: Vec<CliModel> = vec![];
    let mut default_model = None;
    for entry in reported.iter().take(1000) {
        let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
        let resolved = entry
            .get("resolvedModel")
            .and_then(Value::as_str)
            .filter(|id| is_valid_cli_model(id));
        if value == "default" {
            default_model = resolved.map(str::to_string);
            continue;
        }
        let Some(id) = resolved.or_else(|| is_valid_cli_model(value).then_some(value)) else {
            continue;
        };
        let display = entry
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let name = if id.starts_with("claude-") && !display.starts_with("Claude ") {
            format!("Claude {display}")
        } else {
            display.to_string()
        };
        let reasoning_efforts =
            if entry.get("supportsEffort").and_then(Value::as_bool) == Some(true) {
                effort_levels(
                    entry
                        .get("supportedEffortLevels")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str),
                )
            } else {
                vec![]
            };
        let alias = (value != id && is_valid_cli_model(value)).then(|| value.to_string());
        if let Some(existing) = models.iter_mut().find(|m| m.id == id) {
            if let Some(alias) = alias
                && !existing.aliases.contains(&alias)
            {
                existing.aliases.push(alias);
            }
            continue;
        }
        let default_reasoning_effort = entry
            .get("defaultEffortLevel")
            .and_then(Value::as_str)
            .filter(|e| reasoning_efforts.iter().any(|known| known == e))
            .map(str::to_string);
        models.push(CliModel {
            id: id.into(),
            name,
            description: entry
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            aliases: alias.into_iter().collect(),
            reasoning_efforts,
            default_reasoning_effort,
        });
    }
    if models.is_empty() {
        return None;
    }
    Some(CliModels {
        models,
        note: None,
        default_model,
    })
}

// Projection of T3's Claude model manifest, not a claim of live account access.
// Virtual Ultracode/Ultrathink options are omitted: they require T3's workflow/prompt adapters.
const CLAUDE_FALLBACK: &str = r#"[{"id":"claude-opus-5-5","name":"Claude Opus 5.5","aliases":["opus","opus-5.5","claude-opus-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.280"},{"id":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","aliases":["sonnet","sonnet-5.5","claude-sonnet-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.284"},{"id":"claude-fable-5-1","name":"Claude Fable 5.1","aliases":["fable","fable-5.1","claude-fable-5.1"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.257"},{"id":"claude-fable-5","name":"Claude Fable 5","aliases":[],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.169"},{"id":"claude-opus-5","name":"Claude Opus 5","aliases":["opus-5","claude-opus-5.0","claude-opus-5-0"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.219"},{"id":"claude-opus-4-8","name":"Claude Opus 4.8","aliases":["opus-4.8","claude-opus-4.8"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.154"},{"id":"claude-opus-4-7","name":"Claude Opus 4.7","aliases":["opus-4.7","claude-opus-4.7"],"levels":["low","medium","high","max"],"minVersion":"2.1.111"},{"id":"claude-opus-4-6","name":"Claude Opus 4.6","aliases":["opus-4.6","claude-opus-4.6","claude-opus-4-6-20251117"],"levels":["low","medium","high","max"],"minVersion":null},{"id":"claude-opus-4-5","name":"Claude Opus 4.5","aliases":[],"levels":["low","medium","high","max"],"minVersion":null},{"id":"claude-sonnet-5","name":"Claude Sonnet 5","aliases":["sonnet-5","claude-sonnet-5.0","claude-sonnet-5-0"],"levels":["low","medium","high","xhigh","max"],"minVersion":null},{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","aliases":["sonnet-4.6","claude-sonnet-4.6","claude-sonnet-4-6-20251117"],"levels":["low","medium","high"],"minVersion":null},{"id":"claude-haiku-5-5","name":"Claude Haiku 5.5","aliases":["haiku","haiku-5.5","claude-haiku-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.293"},{"id":"claude-haiku-4-5","name":"Claude Haiku 4.5","aliases":["haiku-4.5","claude-haiku-4.5","claude-haiku-4-5-20251001"],"levels":[],"minVersion":null}]"#;

fn version(value: &str) -> Option<[u64; 3]> {
    value.split_whitespace().find_map(|word| {
        let mut parts = word.trim_start_matches('v').split('.');
        Some([
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.split('-').next()?.parse().ok()?,
        ])
    })
}

fn claude_fallback(installed: Option<&str>) -> Vec<CliModel> {
    let installed = installed.and_then(version);
    let Ok(Value::Array(entries)) = serde_json::from_str(CLAUDE_FALLBACK) else {
        return vec![];
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            if let Some(minimum) = entry
                .get("minVersion")
                .and_then(Value::as_str)
                .and_then(version)
                && installed.is_none_or(|v| v < minimum)
            {
                return None;
            }
            let id = entry.get("id")?.as_str()?.to_string();
            let name = entry.get("name")?.as_str()?.to_string();
            let aliases = entry
                .get("aliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            let reasoning_efforts = effort_levels(
                entry
                    .get("levels")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            );
            Some(CliModel {
                id,
                name,
                aliases,
                description: None,
                reasoning_efforts,
                default_reasoning_effort: None,
            })
        })
        .collect()
}

fn gemini(bin: &Path) -> CliModels {
    let models = bin
        .canonicalize()
        .ok()
        .and_then(|real| real.parent().map(gemini_aliases))
        .unwrap_or_default();
    CliModels {
        note: models
            .is_empty()
            .then(|| "Couldn’t load models. Retry.".into()),
        models,
        default_model: None,
    }
}

/// The aliases in Gemini CLI's bundled source in `dir` (`var GEMINI_MODEL_ALIAS_PRO = "pro";`).
pub(crate) fn gemini_aliases(dir: &Path) -> Vec<CliModel> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<CliModel> = vec![];
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "js")
            || e.metadata().map(|m| m.len() > 64 << 20).unwrap_or(true)
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        for (i, _) in text.match_indices("var GEMINI_MODEL_ALIAS_") {
            let Some(line) = text[i..].lines().next() else {
                continue;
            };
            let Some(value) = line.split('"').nth(1) else {
                continue;
            };
            if is_valid_cli_model(value) && !out.iter().any(|m| m.id == value) {
                out.push(CliModel {
                    id: value.into(),
                    name: capitalized(value),
                    description: None,
                    aliases: vec![],
                    reasoning_efforts: vec![],
                    default_reasoning_effort: None,
                });
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
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
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
        assert_eq!(
            m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["gpt-6.1-sol", "gpt-6-astra"]
        );
        assert_eq!(
            m[0],
            CliModel {
                id: "gpt-6.1-sol".into(),
                name: "GPT-6.1-Sol".into(),
                description: Some("Latest workhorse.".into()),
                aliases: vec![],
                reasoning_efforts: vec![],
                default_reasoning_effort: None
            }
        );
        assert_eq!(parse_codex("not json"), None);
    }

    #[test]
    fn claude_initialize_has_resolved_names_aliases_and_model_specific_effort() {
        let result = parse_claude_models(&serde_json::json!({"models":[
            {"value":"default","resolvedModel":"claude-opus-5-5"},
            {"value":"opus","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"claude-opus-5-5","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"haiku-old","displayName":"Haiku 4.5","resolvedModel":"claude-haiku-4-5-20251001"},
            {"value":"gateway/relay","displayName":"School Relay","supportsEffort":true,"supportedEffortLevels":["high","high","--bad"]}
        ]})).unwrap();
        assert_eq!(result.default_model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(result.models.len(), 3);
        assert_eq!(result.models[0].id, "claude-opus-5-5");
        assert_eq!(result.models[0].name, "Claude Opus 5.5");
        assert_eq!(result.models[0].aliases, ["opus"]);
        assert_eq!(
            result.models[0].reasoning_efforts,
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert!(result.models[1].reasoning_efforts.is_empty());
        assert_eq!(result.models[2].name, "School Relay");
        assert_eq!(result.models[2].reasoning_efforts, ["high"]);
        assert!(result.note.is_none());
        assert!(parse_claude_models(&serde_json::json!({"models":[]})).is_none());
    }

    #[test]
    fn claude_fallback_is_version_gated_and_uses_full_provider_names() {
        let current = claude_fallback(Some("2.1.318 (Claude Code)"));
        assert!(current.iter().any(|m| m.id == "claude-opus-5-5"
            && m.name == "Claude Opus 5.5"
            && m.aliases.contains(&"opus".into())));
        assert!(current.iter().any(|m| m.id == "claude-haiku-5-5"));
        assert!(
            current
                .iter()
                .all(|m| !m.reasoning_efforts.iter().any(|e| e.starts_with("ultra")))
        );
        assert!(
            !claude_fallback(Some("2.1.200"))
                .iter()
                .any(|m| m.id == "claude-opus-5-5")
        );
        assert!(
            !claude_fallback(None)
                .iter()
                .any(|m| m.id == "claude-opus-5-5")
        );
    }

    #[test]
    fn codex_preserves_real_reasoning_levels_and_default() {
        let models = parse_codex(r#"{"models":[{"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"},{"effort":"--bad"}]}]}"#).unwrap();
        assert_eq!(
            models[0].reasoning_efforts,
            ["low", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("low"));
    }

    #[test]
    fn codex_app_server_names_default_and_effort_are_authoritative() {
        let listed = parse_codex_app_models(&serde_json::json!({"data":[
            {"id":"provider-alias","model":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","isDefault":true,"defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"max"},{"reasoningEffort":"ultra"}]},
            {"id":"hidden","model":"hidden","displayName":"Hidden","hidden":true}
        ]})).unwrap();
        assert_eq!(listed.models.len(), 1);
        assert_eq!(listed.default_model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(listed.models[0].aliases, ["provider-alias"]);
        assert_eq!(listed.models[0].reasoning_efforts, ["low", "max", "ultra"]);
        assert_eq!(
            listed.models[0].default_reasoning_effort.as_deref(),
            Some("low")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_discovery_sends_only_initialize_and_discards_account_metadata() {
        let input_path = std::env::temp_dir().join(format!(
            "phaethon-model-request-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", r#"IFS= read -r request
printf '%s\n' "$request" > "$1"
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"phaethon-models","response":{"account":{"email":"fixture-private@example.test"},"models":[{"value":"opus","displayName":"Opus 5.5","resolvedModel":"claude-opus-5-5","supportsEffort":true,"supportedEffortLevels":["low","max"]}]}}}'
IFS= read -r unexpected
"#, "probe"]).arg(&input_path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let result = claude_initialize(cmd).await.unwrap();
        let input = std::fs::read_to_string(&input_path).unwrap();
        std::fs::remove_file(input_path).unwrap();
        let request: Value = serde_json::from_str(input.trim()).unwrap();
        assert_eq!(request["type"], "control_request");
        assert_eq!(request["request"]["subtype"], "initialize");
        assert_eq!(input.lines().count(), 1);
        assert_eq!(result.models[0].name, "Claude Opus 5.5");
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("fixture-private")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_discovery_reads_every_page_without_starting_a_turn() {
        let input_path = std::env::temp_dir().join(format!(
            "phaethon-codex-model-requests-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", r#"while IFS= read -r request; do
printf '%s\n' "$request" >> "$1"
case "$request" in
  *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
  *'"id":2'*) printf '%s\n' '{"id":2,"result":{"data":[{"model":"gpt-6-luna","displayName":"GPT-6-Luna"}],"nextCursor":"page-2"}}' ;;
  *'"id":3'*) printf '%s\n' '{"id":3,"result":{"data":[{"model":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","isDefault":true,"defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}],"nextCursor":null}}' ;;
esac
done"#, "probe"]).arg(&input_path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let listed = codex_catalog(cmd).await.unwrap();
        assert_eq!(listed.models.len(), 2);
        assert_eq!(listed.default_model.as_deref(), Some("gpt-6.1-sol"));
        let input = std::fs::read_to_string(&input_path).unwrap();
        std::fs::remove_file(input_path).unwrap();
        let requests: Vec<Value> = input
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(|r| {
            ["initialize", "initialized", "model/list"].contains(&r["method"].as_str().unwrap())
        }));
        assert_eq!(requests[3]["params"]["cursor"], "page-2");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_discovery_rejects_cyclic_listing() {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", r#"while IFS= read -r request; do
case "$request" in
  *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
  *'"id":2'*) printf '%s\n' '{"id":2,"result":{"data":[{"model":"gpt-6.1-sol","isDefault":true}],"nextCursor":"cycle"}}' ;;
  *'"id":3'*) printf '%s\n' '{"id":3,"result":{"data":[],"nextCursor":"cycle"}}' ;;
esac
done"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        assert!(codex_catalog(cmd).await.is_none());
    }

    #[test]
    fn gemini_clis_aliases_come_from_its_bundle() {
        let dir =
            std::env::temp_dir().join(format!("phaethon-gemini-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chunk-A.js"), "var x = 1;\n").unwrap();
        std::fs::write(
            dir.join("chunk-B.js"),
            "var GEMINI_MODEL_ALIAS_AUTO = \"auto\";\nvar GEMINI_MODEL_ALIAS_PRO = \"pro\";\nvar GEMINI_MODEL_ALIAS_FLASH = \"flash\";\nvar GEMINI_MODEL_ALIAS_FLASH_LITE = \"flash-lite\";\n",
        )
        .unwrap();
        let m = gemini_aliases(&dir);
        assert_eq!(
            m.iter()
                .map(|m| (m.id.as_str(), m.name.as_str()))
                .collect::<Vec<_>>(),
            [
                ("auto", "Auto"),
                ("pro", "Pro"),
                ("flash", "Flash"),
                ("flash-lite", "Flash-Lite")
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
