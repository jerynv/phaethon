//! Named CLI instances, ported from T3 Code's ProviderInstanceConfig and managed-home pattern
//! (MIT, pingdotgg/t3code, 7f6f47b). Credentials stay in each CLI's own local home.
use crate::{
    agent::{self, Cli},
    vault::Vault,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub cli: String,
    pub name: String,
    #[serde(default)]
    pub binary: String,
    #[serde(default)]
    pub args: Vec<String>,
}

pub fn cli(id: &str) -> Result<Cli, String> {
    Cli::ALL
        .into_iter()
        .find(|c| c.id() == id)
        .ok_or_else(|| "Unknown assistant.".into())
}

pub fn list(vault: &Vault) -> Vec<Instance> {
    list_at(vault, crate::vault::home_dir().as_deref())
}

const SYSTEM_IDS: [&str; 2] = ["codex-system", "gemini-system"];

fn system_instance(id: &str) -> Option<Instance> {
    let c = match id {
        "codex-system" => Cli::Codex,
        "gemini-system" => Cli::Gemini,
        _ => return None,
    };
    Some(Instance {
        id: id.into(),
        cli: c.id().into(),
        name: format!("{} · System", c.name()),
        binary: String::new(),
        args: vec![],
    })
}

fn system_home(user_home: Option<&Path>, id: &str) -> Option<PathBuf> {
    let user_home = user_home?;
    match id {
        "codex-system" => Some(user_home.join(".codex")).filter(|path| path.is_dir()),
        // GEMINI_CLI_HOME is the parent home, not the .gemini configuration directory.
        "gemini-system" if user_home.join(".gemini").is_dir() => Some(user_home.into()),
        _ => None,
    }
}

fn list_at(vault: &Vault, user_home: Option<&Path>) -> Vec<Instance> {
    let mut instances: Vec<Instance> = Cli::ALL
        .into_iter()
        .map(|c| Instance {
            id: c.id().into(),
            cli: c.id().into(),
            name: c.name().into(),
            binary: String::new(),
            args: vec![],
        })
        .collect();
    let settings = vault.settings();
    if let Some(raw) = settings.agent_instances {
        if let Ok(saved) = serde_json::from_value::<Vec<Instance>>(raw) {
            for instance in saved
                .into_iter()
                .filter(|i| !SYSTEM_IDS.contains(&i.id.as_str()) && validate(i).is_ok())
            {
                if let Some(old) = instances.iter_mut().find(|i| i.id == instance.id) {
                    *old = instance;
                } else {
                    instances.push(instance);
                }
            }
        }
    }
    for id in SYSTEM_IDS {
        let config = system_instance(id).expect("known system connection");
        let explicitly_selected = settings
            .active_agent_instances
            .as_ref()
            .and_then(|selection| selection.get(&config.cli))
            .and_then(|selection| selection.as_str())
            == Some(id);
        // A missing selected home stays unavailable; it must not become another account.
        if explicitly_selected || system_home(user_home, id).is_some() {
            instances.push(config);
        }
    }
    instances
}

fn validate(i: &Instance) -> Result<(), String> {
    if SYSTEM_IDS.contains(&i.id.as_str()) {
        return Err("System CLI configuration is computed from its existing home.".into());
    }
    cli(&i.cli)?;
    if Cli::ALL
        .into_iter()
        .any(|c| c.id() == i.id && c.id() != i.cli)
    {
        return Err("The built-in assistant identifier belongs to another assistant.".into());
    }
    if i.id.is_empty()
        || i.id.len() > 96
        || !i.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid assistant instance.".into());
    }
    if i.name.trim().is_empty() || i.name.chars().count() > 80 {
        return Err("Use a name of 1–80 characters.".into());
    }
    if i.binary.len() > 4096 || i.binary.contains('\0') {
        return Err("Invalid executable path.".into());
    }
    if i.args.len() > 64
        || i.args
            .iter()
            .any(|a| a.len() > 4096 || a.contains('\0') || a.contains('\n'))
    {
        return Err("Use at most 64 single-line arguments.".into());
    }
    // The stream protocol belongs to the harness; a custom argument must not replace it.
    if i.args.iter().any(|a| {
        [
            "--output-format",
            "--input-format",
            "--resume",
            "--session-id",
            "--print",
            "-p",
            "--json",
            "--help",
            "--version",
        ]
        .iter()
        .any(|flag| a == flag || a.starts_with(&format!("{flag}=")))
    }) {
        return Err("Output, session and prompt arguments are managed by Phaethon.".into());
    }
    Ok(())
}

pub fn selected(vault: &Vault, c: Cli) -> Instance {
    selected_at(vault, c, crate::vault::home_dir().as_deref())
}

fn selected_at(vault: &Vault, c: Cli, user_home: Option<&Path>) -> Instance {
    let settings = vault.settings();
    let id = settings
        .active_agent_instances
        .as_ref()
        .and_then(|v| v.get(c.id()))
        .and_then(|v| v.as_str())
        .unwrap_or(c.id());
    list_at(vault, user_home)
        .into_iter()
        .find(|i| i.id == id && i.cli == c.id())
        .unwrap_or_else(|| Instance {
            id: c.id().into(),
            cli: c.id().into(),
            name: c.name().into(),
            binary: String::new(),
            args: vec![],
        })
}

pub fn home(vault: &Vault, root: Option<&Path>, instance: &Instance) -> Option<PathBuf> {
    home_at(vault, root, instance, crate::vault::home_dir().as_deref())
}

fn home_at(
    vault: &Vault,
    root: Option<&Path>,
    instance: &Instance,
    user_home: Option<&Path>,
) -> Option<PathBuf> {
    let c = cli(&instance.cli).ok()?;
    if let Some(system) = system_instance(&instance.id) {
        return (system.cli == instance.cli)
            .then(|| system_home(user_home, &instance.id))
            .flatten();
    }
    if instance.id == c.id() {
        if !c.own_home() && !vault.settings().isolate_claude_config {
            return None;
        }
        return root.map(|r| {
            if c == Cli::Claude {
                r.join(vault.name())
            } else {
                r.join(format!("{}-{}", vault.name(), c.id()))
            }
        });
    }
    root.map(|r| r.join(format!("{}-instance-{}", vault.name(), instance.id)))
}

pub fn require_home(
    vault: &Vault,
    root: Option<&Path>,
    instance: &Instance,
) -> Result<Option<PathBuf>, String> {
    require_home_at(vault, root, instance, crate::vault::home_dir().as_deref())
}

fn require_home_at(
    vault: &Vault,
    root: Option<&Path>,
    instance: &Instance,
    user_home: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let path = home_at(vault, root, instance, user_home);
    if instance.id != instance.cli && path.is_none() {
        return Err(
            "Phaethon cannot find a local configuration folder for this connection.".into(),
        );
    }
    Ok(path)
}

pub fn save(
    vault: &Vault,
    root: Option<&Path>,
    mut instance: Instance,
) -> Result<Instance, String> {
    if SYSTEM_IDS.contains(&instance.id.as_str()) {
        return Err("System CLI connections are managed by their CLI. Add a separate connection to customize a launch.".into());
    }
    instance.name = instance.name.trim().into();
    instance.binary = instance.binary.trim().into();
    validate(&instance)?;
    require_home(vault, root, &instance)?;
    let mut all = list(vault);
    if let Some(old) = all.iter_mut().find(|i| i.id == instance.id) {
        if old.cli != instance.cli {
            return Err("An instance cannot change assistant type.".into());
        }
        *old = instance.clone();
    } else {
        all.push(instance.clone());
    }
    // System connections are computed from existing homes, never persisted configuration.
    all.retain(|entry| !SYSTEM_IDS.contains(&entry.id.as_str()));
    // Legacy Claude uses the person's own config. Custom launch options get their own home.
    if let Some(dir) = home(vault, root, &instance) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("phaethon-instance.json");
        let tmp = file.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec(&instance).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(tmp, file).map_err(|e| e.to_string())?;
    } else if !instance.binary.is_empty() || !instance.args.is_empty() {
        return Err("Add a named Claude Code instance to customize its launch options.".into());
    }
    vault
        .set_setting(
            "agentInstances",
            serde_json::to_value(all).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    Ok(instance)
}

pub fn select(vault: &Vault, id: &str) -> Result<(), String> {
    let instance = list(vault)
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("Assistant instance not found.")?;
    let mut selected = vault
        .settings()
        .active_agent_instances
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    selected[&instance.cli] = serde_json::Value::String(id.into());
    vault
        .set_setting("activeAgentInstances", selected)
        .map_err(|e| e.to_string())?;
    vault
        .set_setting(
            "backend",
            serde_json::Value::String(format!("{}-cli", instance.cli)),
        )
        .map_err(|e| e.to_string())
}

pub fn remove(vault: &Vault, id: &str) -> Result<(), String> {
    if SYSTEM_IDS.contains(&id) || Cli::ALL.into_iter().any(|c| c.id() == id) {
        return Err("Built-in assistants cannot be removed.".into());
    }
    let all: Vec<_> = list(vault)
        .into_iter()
        .filter(|i| i.id != id && !SYSTEM_IDS.contains(&i.id.as_str()))
        .collect();
    vault
        .set_setting(
            "agentInstances",
            serde_json::to_value(all).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
}

pub async fn sign_out(c: Cli, home: Option<&Path>) -> Result<(), String> {
    let bin = binary(c, home).ok_or("Assistant executable not found.")?;
    let args: &[&str] = match c {
        Cli::Claude => &["auth", "logout"],
        Cli::Codex => &["logout"],
        Cli::Gemini => return Err("Use Gemini CLI to sign out of this account.".into()),
    };
    let mut cmd = agent::command(c, &bin, &std::env::temp_dir(), home);
    cmd.args(args).stdin(std::process::Stdio::null());
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "Sign-out timed out.".to_string())?
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err("The assistant did not finish signing out.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub available: bool,
    pub windows: Vec<UsageWindow>,
    pub reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<serde_json::Value>,
}

/// Port of T3's Claude control get_usage and Codex account/rateLimits/read probes.
/// Initialization and account metadata only: no user message or model turn is submitted.
pub async fn usage(c: Cli, home: Option<&Path>) -> Usage {
    if c == Cli::Gemini {
        return unavailable_usage("Gemini CLI does not expose account limits.");
    }
    let Some(bin) = binary(c, home) else {
        return unavailable_usage("Assistant executable not found.");
    };
    usage_from_command(c, agent::command(c, &bin, &std::env::temp_dir(), home)).await
}

fn unavailable_usage(reason: &str) -> Usage {
    Usage {
        available: false,
        windows: vec![],
        reason: Some(reason.into()),
    }
}

async fn usage_from_command(c: Cli, mut cmd: tokio::process::Command) -> Usage {
    if c == Cli::Claude {
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
        ]);
    } else {
        cmd.arg("app-server");
    }
    cmd.stderr(std::process::Stdio::null());
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let mut child = cmd.spawn().ok()?;
        let mut input = child.stdin.take()?;
        let mut lines = BufReader::new(child.stdout.take()?).lines();
        let requests = if c == Cli::Claude { vec![
            serde_json::json!({"type":"control_request","request_id":"phaethon-init","request":{"subtype":"initialize"}}),
            serde_json::json!({"type":"control_request","request_id":"phaethon-usage","request":{"subtype":"get_usage","skipBehaviors":true}}),
        ] } else { vec![
            serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"phaethon","version":"0.1.2"},"capabilities":{"experimentalApi":true}}}),
            serde_json::json!({"method":"initialized","params":{}}),
            serde_json::json!({"id":2,"method":"account/rateLimits/read","params":null}),
        ] };
        for request in requests { input.write_all(format!("{request}\n").as_bytes()).await.ok()?; input.flush().await.ok()?; }
        let mut result = None;
        for _ in 0..100 {
            let line = lines.next_line().await.ok()??;
            if line.len() > 1024 * 1024 { break; }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            if c == Cli::Claude && v["response"]["request_id"] == "phaethon-usage" { result = v["response"].get("response").cloned(); break; }
            if c == Cli::Codex && v["id"] == 2 { result = v.get("result").cloned(); break; }
        }
        let _ = child.kill().await;
        result
    }).await.ok().flatten();
    let Some(value) = result else {
        return unavailable_usage("Usage is unavailable. Refresh to try again.");
    };
    let windows = parse_usage(c, &value);
    if windows.is_empty() {
        unavailable_usage("This account does not report usage windows.")
    } else {
        Usage {
            available: true,
            windows,
            reason: None,
        }
    }
}

fn parse_usage(c: Cli, value: &serde_json::Value) -> Vec<UsageWindow> {
    if c == Cli::Codex {
        return codex_usage_windows(value);
    }
    let mut out = vec![];
    let names = [
        ("five_hour", "5 hours"),
        ("seven_day", "7 days"),
        ("seven_day_sonnet", "Sonnet · 7 days"),
    ];
    for (key, label) in names {
        let v = &value["rate_limits"][key];
        let Some(percent) = v["utilization"].as_f64().filter(|p| p.is_finite()) else {
            continue;
        };
        out.push(UsageWindow {
            label: label.into(),
            used_percent: percent.clamp(0.0, 100.0),
            resets_at: v["resets_at"]
                .as_str()
                .map(|s| serde_json::Value::String(s.into())),
        });
    }
    out
}

/// T3 Code's codexRateLimitsToLimits/codexRateLimitsToWindows (MIT, 7f6f47b):
/// the legacy snapshot can describe a model pool, not the account allowance.
fn codex_usage_windows(value: &serde_json::Value) -> Vec<UsageWindow> {
    let snapshot = value["rateLimitsByLimitId"]
        .get("codex")
        .filter(|snapshot| snapshot.is_object())
        .unwrap_or(&value["rateLimits"]);
    if snapshot["limitId"].as_str().is_some_and(|id| id != "codex") {
        return vec![];
    }
    let monthly_plan = matches!(snapshot["planType"].as_str(), Some("free" | "go"));
    let mut out = vec![];
    for (key, fallback_mins) in [
        ("primary", if monthly_plan { 43_200.0 } else { 300.0 }),
        ("secondary", 10_080.0),
    ] {
        let window = &snapshot[key];
        let Some(percent) = window["usedPercent"].as_f64().filter(|p| p.is_finite()) else {
            continue;
        };
        let duration = window["windowDurationMins"]
            .as_f64()
            .filter(|mins| mins.is_finite() && *mins > 0.0)
            .unwrap_or(fallback_mins);
        let label = if duration >= 43_200.0 {
            "Monthly"
        } else if duration >= 10_080.0 {
            "Weekly"
        } else {
            "Session"
        };
        out.push(UsageWindow {
            label: label.into(),
            used_percent: percent.clamp(0.0, 100.0),
            resets_at: codex_reset_at(window),
        });
    }
    let credit = &snapshot["individualLimit"];
    if let Some(remaining) = credit["remainingPercent"]
        .as_f64()
        .filter(|p| p.is_finite())
    {
        out.push(UsageWindow {
            label: "Monthly credit limit".into(),
            used_percent: (100.0 - remaining).clamp(0.0, 100.0),
            resets_at: codex_reset_at(credit),
        });
    }
    out
}

fn codex_reset_at(window: &serde_json::Value) -> Option<serde_json::Value> {
    window["resetsAt"]
        .as_i64()
        .filter(|seconds| *seconds > 0)
        .map(serde_json::Value::from)
}

pub fn launch(home: Option<&Path>) -> Option<Instance> {
    launch_at(home, crate::vault::home_dir().as_deref())
}

fn launch_at(home: Option<&Path>, user_home: Option<&Path>) -> Option<Instance> {
    let home = home?;
    // An immutable identity preserves account-specific session tags and command env cleanup
    // without reading or writing a phaethon-instance.json in another CLI's existing home.
    for id in SYSTEM_IDS {
        if system_home(user_home, id).as_deref() == Some(home) {
            return system_instance(id);
        }
    }
    let value: Instance =
        serde_json::from_slice(&std::fs::read(home.join("phaethon-instance.json")).ok()?).ok()?;
    validate(&value).ok()?;
    Some(value)
}

pub fn binary(c: Cli, home: Option<&Path>) -> Option<PathBuf> {
    match launch(home).filter(|i| i.cli == c.id() && !i.binary.is_empty()) {
        Some(i) if Path::new(&i.binary).is_absolute() => {
            Some(PathBuf::from(i.binary)).filter(|p| agent::is_executable(p))
        }
        Some(i) => agent::find_on_path(&i.binary, &agent::common_bin_dirs()),
        None => c.find(),
    }
}

/// Public CLI status output only. No credential files or tokens are read.
pub async fn account(
    c: Cli,
    home: Option<&Path>,
) -> (Option<bool>, Option<String>, Option<String>) {
    let Some(bin) = binary(c, home) else {
        return (None, None, None);
    };
    if c == Cli::Codex {
        return (agent::codex_logged_in(&bin, home).await, None, None);
    }
    if c != Cli::Claude {
        return (None, None, None);
    }
    let mut cmd = agent::command(c, &bin, &std::env::temp_dir(), home);
    cmd.args(["auth", "status", "--json"])
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output())
        .await
        .ok()
        .and_then(Result::ok);
    let parsed: Option<serde_json::Value> =
        output.and_then(|o| serde_json::from_slice(&o.stdout).ok());
    match parsed {
        Some(v) => (
            v["loggedIn"].as_bool(),
            v["email"].as_str().map(str::to_owned),
            v["subscriptionType"].as_str().map(str::to_owned),
        ),
        None => (None, None, None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    pub config: Instance,
    pub installed: bool,
    pub logged_in: Option<bool>,
    pub account: Option<String>,
    pub plan: Option<String>,
    pub selected: bool,
    pub managed_home: bool,
    pub source: &'static str,
    pub read_only: bool,
}

pub async fn views(vault: &Vault, root: Option<&Path>) -> Vec<InstanceView> {
    let mut out = vec![];
    for config in list(vault) {
        let Ok(c) = cli(&config.cli) else {
            continue;
        };
        let home = home(vault, root, &config);
        let installed =
            require_home(vault, root, &config).is_ok() && binary(c, home.as_deref()).is_some();
        let (logged_in, account, plan) = if installed {
            account(c, home.as_deref()).await
        } else {
            (None, None, None)
        };
        let selected = selected(vault, c).id == config.id
            && agent::Cli::of(vault.settings().backend) == Some(c);
        let read_only = SYSTEM_IDS.contains(&config.id.as_str());
        let system = read_only
            || (c == Cli::Claude && config.id == c.id() && !vault.settings().isolate_claude_config);
        let managed_home = home.is_some() && !system;
        out.push(InstanceView {
            config,
            installed,
            logged_in,
            account,
            plan,
            selected,
            managed_home,
            source: if system { "system" } else { "managed" },
            read_only,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_fixture(label: &str) -> (PathBuf, Vault, PathBuf, PathBuf) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "phaethon-system-{label}-{}-{nonce}",
            std::process::id()
        ));
        let vault = Vault::at(root.join("vault"));
        vault.ensure_initialized().unwrap();
        let user_home = root.join("user");
        let config_root = root.join("app-config");
        std::fs::create_dir_all(&user_home).unwrap();
        (root, vault, user_home, config_root)
    }

    #[test]
    fn existing_system_homes_are_listed_without_replacing_or_selecting_managed_accounts() {
        let (root, vault, user_home, config_root) = system_fixture("list");
        assert!(!list_at(&vault, Some(&user_home))
            .iter()
            .any(|entry| SYSTEM_IDS.contains(&entry.id.as_str())));
        std::fs::create_dir_all(user_home.join(".codex")).unwrap();
        std::fs::create_dir_all(user_home.join(".gemini")).unwrap();
        let before = std::fs::read(vault.root().join(".phaethon/settings.json")).ok();
        let entries = list_at(&vault, Some(&user_home));
        for id in ["codex", "gemini", "codex-system", "gemini-system"] {
            assert_eq!(entries.iter().filter(|entry| entry.id == id).count(), 1);
        }
        assert_eq!(
            entries.iter().filter(|entry| entry.cli == "claude").count(),
            1
        );
        assert_eq!(
            selected_at(&vault, Cli::Codex, Some(&user_home)).id,
            "codex"
        );
        assert_eq!(
            before,
            std::fs::read(vault.root().join(".phaethon/settings.json")).ok()
        );
        assert!(
            !config_root.exists(),
            "listing does not create app or system metadata"
        );
        assert!(!user_home.join(".codex/phaethon-instance.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn system_cli_home_environment_and_session_identity_stay_separate_from_managed() {
        let (root, vault, user_home, config_root) = system_fixture("environment");
        std::fs::create_dir_all(user_home.join(".codex")).unwrap();
        std::fs::create_dir_all(user_home.join(".gemini")).unwrap();
        for (id, c, expected_system_home) in [
            ("codex-system", Cli::Codex, user_home.join(".codex")),
            ("gemini-system", Cli::Gemini, user_home.clone()),
        ] {
            let system = system_instance(id).unwrap();
            let system_path =
                home_at(&vault, Some(&config_root), &system, Some(&user_home)).unwrap();
            assert_eq!(system_path, expected_system_home);
            let managed = Instance {
                id: c.id().into(),
                cli: c.id().into(),
                name: c.name().into(),
                binary: String::new(),
                args: vec![],
            };
            let managed_path =
                home_at(&vault, Some(&config_root), &managed, Some(&user_home)).unwrap();
            assert_ne!(system_path, managed_path);
            let launch = launch_at(Some(&system_path), Some(&user_home)).unwrap();
            assert_eq!(launch.id, id);
            assert_ne!(
                format!("{}-{}", c.id(), launch.id),
                c.id(),
                "system sessions cannot reuse the managed namespace"
            );
            for path in [&system_path, &managed_path] {
                let cmd = agent::command(c, &root.join("fake-cli"), &root, Some(path));
                assert!(cmd
                    .as_std()
                    .get_envs()
                    .any(|(key, value)| key == c.config_var() && value == Some(path.as_os_str())));
                assert!(!path.join("phaethon-instance.json").exists());
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn computed_system_connections_cannot_be_saved_removed_or_poisoned() {
        let (root, vault, user_home, config_root) = system_fixture("readonly");
        std::fs::create_dir_all(user_home.join(".codex")).unwrap();
        let marker = user_home.join(".codex/phaethon-instance.json");
        let poison = serde_json::json!({"id":"codex-system","cli":"claude","name":"Wrong account","binary":"/not-the-system-cli","args":["--wrong-account"]});
        let contents = serde_json::to_vec(&poison).unwrap();
        std::fs::write(&marker, &contents).unwrap();
        vault
            .set_setting("agentInstances", serde_json::json!([poison]))
            .unwrap();
        let system = list_at(&vault, Some(&user_home))
            .into_iter()
            .find(|entry| entry.id == "codex-system")
            .unwrap();
        assert_eq!(system.cli, "codex");
        assert!(system.binary.is_empty() && system.args.is_empty());
        assert!(save(&vault, Some(&config_root), system.clone()).is_err());
        assert!(remove(&vault, "codex-system").is_err());
        let virtual_launch = launch_at(Some(&user_home.join(".codex")), Some(&user_home)).unwrap();
        assert_eq!(virtual_launch.id, "codex-system");
        assert!(virtual_launch.binary.is_empty() && virtual_launch.args.is_empty());
        assert_eq!(std::fs::read(marker).unwrap(), contents);
        assert!(!config_root.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saving_managed_connections_never_persists_computed_system_entries() {
        let (root, vault, _, config_root) = system_fixture("persistence");
        save(
            &vault,
            Some(&config_root),
            Instance {
                id: "codex-work".into(),
                cli: "codex".into(),
                name: "Work".into(),
                binary: String::new(),
                args: vec![],
            },
        )
        .unwrap();
        let stored = vault.settings().agent_instances.unwrap();
        assert!(!stored
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| SYSTEM_IDS.contains(&entry["id"].as_str().unwrap_or_default())));
        assert!(config_root
            .join("vault-instance-codex-work/phaethon-instance.json")
            .is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_selected_system_home_fails_without_switching_to_another_account() {
        let (root, vault, user_home, config_root) = system_fixture("missing");
        std::fs::create_dir_all(user_home.join(".codex")).unwrap();
        vault
            .set_setting(
                "activeAgentInstances",
                serde_json::json!({"codex":"codex-system"}),
            )
            .unwrap();
        std::fs::remove_dir(user_home.join(".codex")).unwrap();
        let selected = selected_at(&vault, Cli::Codex, Some(&user_home));
        assert_eq!(selected.id, "codex-system");
        assert!(require_home_at(&vault, Some(&config_root), &selected, Some(&user_home)).is_err());
        assert!(!config_root.exists());
        assert!(!user_home.join(".codex").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn usage_queries_read_the_chosen_home_without_mixing_system_and_managed_accounts() {
        use std::os::unix::fs::PermissionsExt;
        let (root, vault, user_home, config_root) = system_fixture("usage");
        std::fs::create_dir_all(user_home.join(".codex")).unwrap();
        let system = system_instance("codex-system").unwrap();
        let managed = Instance {
            id: "codex".into(),
            cli: "codex".into(),
            name: "Codex".into(),
            binary: String::new(),
            args: vec![],
        };
        let system_path = require_home_at(&vault, Some(&config_root), &system, Some(&user_home))
            .unwrap()
            .unwrap();
        let managed_path = require_home_at(&vault, Some(&config_root), &managed, Some(&user_home))
            .unwrap()
            .unwrap();
        std::fs::create_dir_all(&managed_path).unwrap();
        for (path, percent) in [(&system_path, 76), (&managed_path, 0)] {
            std::fs::write(path.join("usage.json"), serde_json::to_vec(&serde_json::json!({"rateLimits":{"primary":{"usedPercent":percent,"windowDurationMins":10080}}})).unwrap()).unwrap();
        }
        let binary = root.join("fake-codex");
        std::fs::write(&binary, r##"#!/bin/sh
[ "$1" = 'app-server' ] || exit 9
while IFS= read -r line; do
  case "$line" in
    *account/rateLimits/read*) printf '{"id":2,"result":'; cat "$CODEX_HOME/usage.json"; printf '}\n' ;;
    *initialize*) printf '%s\n' '{"id":1,"result":{}}' ;;
  esac
done
"##).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        for (path, expected) in [(&system_path, 76.0), (&managed_path, 0.0)] {
            let command = agent::command(Cli::Codex, &binary, &root, Some(path));
            let usage = usage_from_command(Cli::Codex, command).await;
            assert!(usage.available);
            assert_eq!(usage.windows.len(), 1);
            assert_eq!(usage.windows[0].label, "Weekly");
            assert_eq!(usage.windows[0].used_percent, expected);
            assert!(!path.join("phaethon-instance.json").exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_arguments_preserve_protocol_and_are_not_shell_parsed() {
        let mut i = Instance {
            id: "claude-work".into(),
            cli: "claude".into(),
            name: "Work".into(),
            binary: "/opt/bin/claude".into(),
            args: vec!["--setting".into(), "a value with spaces".into()],
        };
        assert!(validate(&i).is_ok());
        i.args.push("--output-format=json".into());
        assert!(validate(&i).is_err());
        i.args.clear();
        i.id = "../escape".into();
        assert!(validate(&i).is_err());
    }

    #[test]
    fn missing_local_storage_cannot_fall_back_to_a_different_account() {
        let vault = Vault::at(std::env::temp_dir().join("phaethon-missing-instance-home"));
        let instance = Instance {
            id: "claude-work".into(),
            cli: "claude".into(),
            name: "Work".into(),
            binary: String::new(),
            args: vec![],
        };
        assert!(require_home(&vault, None, &instance).is_err());
        assert!(save(&vault, None, instance).is_err());
    }

    #[test]
    fn independent_accounts_keep_launch_config_outside_the_vault() {
        let root = std::env::temp_dir().join(format!("phaethon-instances-{}", std::process::id()));
        let vault = Vault::at(root.join("vault"));
        vault.ensure_initialized().unwrap();
        let configs = root.join("local-config");
        for id in ["claude-work", "claude-personal"] {
            save(
                &vault,
                Some(&configs),
                Instance {
                    id: id.into(),
                    cli: "claude".into(),
                    name: id.into(),
                    binary: String::new(),
                    args: vec![],
                },
            )
            .unwrap();
        }
        select(&vault, "claude-work").unwrap();
        let work = home(&vault, Some(&configs), &selected(&vault, Cli::Claude)).unwrap();
        select(&vault, "claude-personal").unwrap();
        let personal = home(&vault, Some(&configs), &selected(&vault, Cli::Claude)).unwrap();
        assert_ne!(work, personal);
        assert!(!work.starts_with(vault.root()));
        assert_eq!(launch(Some(&work)).unwrap().id, "claude-work");
        assert_eq!(launch(Some(&personal)).unwrap().id, "claude-personal");
        remove(&vault, "claude-personal").unwrap();
        assert_eq!(selected(&vault, Cli::Claude).id, "claude");
        assert!(
            personal.is_dir(),
            "removing a row does not delete a CLI's credentials"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn both_protocols_return_usage_in_the_same_ui_units() {
        let claude = parse_usage(
            Cli::Claude,
            &serde_json::json!({"rate_limits":{"five_hour":{"utilization":37.5,"resets_at":"2026-11-05T05:00:00Z"}}}),
        );
        assert_eq!(claude[0].used_percent, 37.5);
        let codex = parse_usage(
            Cli::Codex,
            &serde_json::json!({"rateLimits":{"primary":{"usedPercent":42,"resetsAt":1793854800}}}),
        );
        assert_eq!(codex[0].used_percent, 42.0);
        assert!(parse_usage(
            Cli::Claude,
            &serde_json::json!({"rate_limits_available":false})
        )
        .is_empty());
    }

    // Protocol fields and expected normalization follow T3 Code's
    // apps/server/src/provider/codexUsageLimits{,.test}.ts at 7f6f47b and
    // codex-cli 0.166.0's generated GetAccountRateLimitsResponse schema.
    #[test]
    fn codex_usage_prefers_the_main_account_bucket_over_a_model_bucket() {
        let windows = parse_usage(
            Cli::Codex,
            &serde_json::json!({
                "rateLimits": {
                    "limitId": "codex_bengalfox",
                    "primary": {"usedPercent": 0, "windowDurationMins": 300},
                    "secondary": {"usedPercent": 0, "windowDurationMins": 10080}
                },
                "rateLimitsByLimitId": {
                    "codex_bengalfox": {"secondary": {"usedPercent": 0}},
                    "codex": {
                        "limitId": "codex", "planType": "plus",
                        "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1784000000},
                        "secondary": {"usedPercent": 67, "windowDurationMins": 10080, "resetsAt": 1784500000}
                    }
                }
            }),
        );
        assert_eq!(windows.len(), 2);
        assert_eq!(
            (windows[0].label.as_str(), windows[0].used_percent),
            ("Session", 12.0)
        );
        assert_eq!(
            (windows[1].label.as_str(), windows[1].used_percent),
            ("Weekly", 67.0)
        );
        assert_eq!(windows[1].resets_at, Some(serde_json::json!(1784500000)));
    }

    #[test]
    fn model_only_codex_limits_are_not_presented_as_account_allowance() {
        for bucket_map in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({
                "codex_bengalfox": {"secondary": {"usedPercent": 0}}
            }),
        ] {
            assert!(parse_usage(
                Cli::Codex,
                &serde_json::json!({
                    "rateLimits": {"limitId": "codex_bengalfox", "secondary": {"usedPercent": 0}},
                    "rateLimitsByLimitId": bucket_map
                })
            )
            .is_empty());
        }
    }

    #[test]
    fn codex_window_labels_follow_duration_and_plan_instead_of_array_position() {
        let swapped = parse_usage(
            Cli::Codex,
            &serde_json::json!({"rateLimits": {
                "primary": {"usedPercent": 47, "windowDurationMins": 10080},
                "secondary": {"usedPercent": 12, "windowDurationMins": 300}
            }}),
        );
        assert_eq!(
            swapped
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            ["Weekly", "Session"]
        );
        for plan in ["free", "go"] {
            let monthly = parse_usage(
                Cli::Codex,
                &serde_json::json!({"rateLimits": {
                    "planType": plan, "primary": {"usedPercent": 80, "resetsAt": null}
                }}),
            );
            assert_eq!(monthly[0].label, "Monthly");
            assert_eq!(monthly[0].used_percent, 80.0);
        }
    }

    #[test]
    fn codex_individual_monthly_credit_allowance_is_not_dropped() {
        let windows = parse_usage(
            Cli::Codex,
            &serde_json::json!({
                "rateLimits": {"limitId": "spark"},
                "rateLimitsByLimitId": {"codex": {
                    "limitId": "codex", "planType": "enterprise_cbp_usage_based",
                    "primary": null, "secondary": null,
                    "individualLimit": {"remainingPercent": 99, "resetsAt": 1784500000}
                }}
            }),
        );
        assert_eq!(windows.len(), 1);
        assert_eq!(
            (windows[0].label.as_str(), windows[0].used_percent),
            ("Monthly credit limit", 1.0)
        );
        assert_eq!(windows[0].resets_at, Some(serde_json::json!(1784500000)));
    }

    #[test]
    fn missing_codex_windows_are_not_zero_filled_or_borrowed_from_other_buckets() {
        let windows = parse_usage(
            Cli::Codex,
            &serde_json::json!({
                "rateLimits": {"primary": {"usedPercent": 5}, "secondary": {"usedPercent": 0}},
                "rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 42}, "secondary": null}}
            }),
        );
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 42.0);
        assert!(parse_usage(
            Cli::Codex,
            &serde_json::json!({"rateLimits": {
                "primary": {"usedPercent": null}, "secondary": {"resetsAt": 1784500000}
            }})
        )
        .is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn configured_binary_and_literal_arguments_drive_status_and_usage() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("phaethon-instance-protocol-{}", std::process::id()));
        let vault = Vault::at(root.join("vault"));
        vault.ensure_initialized().unwrap();
        let binary = root.join("custom-claude");
        std::fs::write(&binary, r##"#!/bin/sh
[ "$1" = '--connection' ] && [ "$2" = 'work account' ] || exit 9
shift 2
if [ "$1" = 'auth' ]; then
  printf '%s\n' '{"loggedIn":true,"email":"work@example.test","subscriptionType":"max"}'
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
    *phaethon-usage*) printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"phaethon-usage","response":{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":63,"resets_at":null}}}}}' ;;
    *phaethon-init*) printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"phaethon-init","response":{}}}' ;;
  esac
done
"##).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let instance = save(
            &vault,
            Some(&root),
            Instance {
                id: "claude-work".into(),
                cli: "claude".into(),
                name: "Work".into(),
                binary: binary.display().to_string(),
                args: vec!["--connection".into(), "work account".into()],
            },
        )
        .unwrap();
        let home = home(&vault, Some(&root), &instance).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            super::binary(Cli::Claude, Some(&home)).is_none(),
            "a non-executable file cannot report an installed assistant"
        );
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let command = agent::command(Cli::Claude, &binary, &root, Some(&home));
        for name in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ] {
            assert!(
                command
                    .as_std()
                    .get_envs()
                    .any(|(key, value)| key == name && value.is_none()),
                "{name} must not override the named account"
            );
        }
        let account = account(Cli::Claude, Some(&home)).await;
        assert_eq!(
            account,
            (
                Some(true),
                Some("work@example.test".into()),
                Some("max".into())
            )
        );
        let result = usage(Cli::Claude, Some(&home)).await;
        assert!(result.available);
        assert_eq!(result.windows[0].used_percent, 63.0);

        std::fs::write(
            &binary,
            r##"#!/bin/sh
shift 2
if [ "$1" = 'auth' ] && [ "$2" = 'status' ]; then
  printf '%s\n' '{"loggedIn":true,"email":"work@example.test"}'
  exit 0
fi
exit 7
"##,
        )
        .unwrap();
        let outcome =
            agent::sign_in::claude_sign_in(&agent::Runs::default(), Some(&home), "claude-work")
                .await;
        assert_eq!(
            outcome.status,
            agent::sign_in::SignInStatus::NotSignedIn,
            "a failed account switch cannot inherit the previous account's success"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "Explicit local account probe; initializes CLI without submitting a model turn"]
    async fn live_claude_usage_probe() {
        let result = usage(Cli::Claude, None).await;
        assert!(result.available, "{:?}", result.reason);
        println!(
            "Claude usage: {} real account windows",
            result.windows.len()
        );
    }

    #[tokio::test]
    #[ignore = "Explicit local account probe; initializes CLI without submitting a model turn"]
    async fn live_codex_usage_probe() {
        let config = crate::vault::home_dir().unwrap().join(".codex");
        let result = usage(Cli::Codex, Some(&config)).await;
        assert!(result.available, "{:?}", result.reason);
        println!("Codex usage: {} real account windows", result.windows.len());
    }
}
