//! Vault and space folders on disk.
//!
//! Layout (see docs/ARCHITECTURE.md): `<vault>/spaces/<space>/`, with per-space
//! app state in `<space>/.phaethon/`. Every path the UI names is validated here;
//! the UI only ever passes a space *id*, never a path.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Spaces created in a brand-new vault.
pub const DEFAULT_SPACES: &[&str] = &["school", "work"];
/// Vault created on first run.
pub const DEFAULT_VAULT: &str = "default";

#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

/// Per-vault preferences, read from `<vault>/.phaethon/settings.json`.
/// Preferences only: secrets never go in the vault (it may be synced).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultSettings {
    /// Opt-in: run the `claude` CLI with a per-vault `CLAUDE_CONFIG_DIR`.
    /// Off by default because a fresh config dir is logged out: turning this on
    /// means logging in to the CLI again for this vault. See ARCHITECTURE.md.
    pub isolate_claude_config: bool,
    /// Which agent runs in this vault's spaces.
    pub backend: Backend,
    /// Model for Phaethon's own loop; the provider's default when unset.
    pub model: Option<String>,
    /// Effort for Phaethon's own loop; the provider's default when unset.
    pub effort: Option<String>,
    /// The user's appearance and accessibility choices (theme, token overrides).
    /// Kept as raw JSON: the webview owns its meaning, the core only checks its
    /// shape with [`validate_appearance`] on the way in and out.
    pub appearance: Option<serde_json::Value>,
}

/// Largest appearance object accepted, serialized. Real ones are a few hundred bytes.
const APPEARANCE_MAX_BYTES: usize = 8 * 1024;
/// Most token overrides one appearance may carry.
const APPEARANCE_MAX_TOKENS: usize = 64;
/// Longest token value accepted, e.g. `oklch(0.62 0.08 168 / 90%)`.
const TOKEN_VALUE_MAX_LEN: usize = 64;

/// Check an appearance object from the webview (or a hand-edited settings
/// file) before it is stored or handed back. Shape:
///
/// ```json
/// { "version": 1, "theme": "system|light|dark",
///   "readingFont": "atkinson|opendyslexic|lexend|system",
///   "reduceMotion": "system|on|off", "increaseContrast": "system|on|off",
///   "tokens": { "--ph-accent-h": 290, "--ph-tracking-normal": "0.02em" } }
/// ```
///
/// Every field is optional; anything else is refused. Token names must be
/// `--ph-` plus lowercase letters, digits and dashes. Values are finite
/// numbers or short strings made only of characters a CSS number, length or
/// `oklch()`/`oklab()` colour needs, so nothing stored here can break out of a
/// CSS declaration. The webview applies its own, stricter per-token rules
/// (src/theme/tokens.ts).
pub fn validate_appearance(value: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    let obj = value.as_object().ok_or("Appearance must be an object.")?;
    let size = serde_json::to_vec(value).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > APPEARANCE_MAX_BYTES {
        return Err(format!("Appearance is too large ({size} bytes)."));
    }
    for (key, v) in obj {
        match key.as_str() {
            "version" => {
                if !matches!(v.as_u64(), Some(1..=1000)) {
                    return Err("Appearance version must be a small positive number.".into());
                }
            }
            "theme" => one_of(key, v, &["system", "light", "dark"])?,
            "readingFont" => one_of(key, v, &["atkinson", "opendyslexic", "lexend", "system"])?,
            "reduceMotion" | "increaseContrast" => one_of(key, v, &["system", "on", "off"])?,
            "tokens" => {
                let tokens = v.as_object().ok_or("Appearance tokens must be an object.")?;
                if tokens.len() > APPEARANCE_MAX_TOKENS {
                    return Err(format!("Too many token overrides ({}).", tokens.len()));
                }
                for (name, value) in tokens {
                    if !is_token_name(name) {
                        return Err(format!("\"{}\" is not a Phaethon token name.", truncate(name)));
                    }
                    let ok = match value {
                        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
                        Value::String(s) => is_token_value(s),
                        _ => false,
                    };
                    if !ok {
                        return Err(format!("{name} has a value Phaethon cannot use."));
                    }
                }
            }
            other => return Err(format!("Unknown appearance setting \"{}\".", truncate(other))),
        }
    }
    Ok(())
}

fn one_of(key: &str, v: &serde_json::Value, allowed: &[&str]) -> Result<(), String> {
    match v.as_str() {
        Some(s) if allowed.contains(&s) => Ok(()),
        _ => Err(format!("{key} must be one of: {}.", allowed.join(", "))),
    }
}

/// `^--ph-[a-z0-9-]+$`, at most 64 characters, not starting or ending in a dash.
fn is_token_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("--ph-") else {
        return false;
    };
    !rest.is_empty()
        && name.len() <= 64
        && !rest.starts_with('-')
        && !rest.ends_with('-')
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Numbers, lengths and oklch()/oklab() colours only: no quotes, semicolons,
/// braces, commas, `url(` or `var(`, so a stored value can never smuggle in other CSS.
fn is_token_value(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let parens = s.matches('(').count();
    !s.is_empty()
        && s.len() <= TOKEN_VALUE_MAX_LEN
        && s.chars().all(|c| c.is_ascii_alphanumeric() || " .%/-+()".contains(c))
        && parens == s.matches(')').count()
        && (parens == 0
            || (parens == 1
                && (lower.starts_with("oklch(") || lower.starts_with("oklab("))
                && s.ends_with(')')))
}

fn truncate(s: &str) -> String {
    s.chars().take(40).collect()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    /// Phaethon's own loop and tools, with the user's API key from the keychain.
    #[default]
    #[serde(alias = "steward")] // the name before the rename; still accepted in settings.json
    Phaethon,
    /// The official `claude` CLI the user installed and logged into.
    ClaudeCli,
}

impl Vault {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `~/Phaethon/default`.
    pub fn default_location() -> io::Result<Self> {
        let home = home_dir().ok_or_else(|| io::Error::other("home directory not found"))?;
        migrate_legacy_root(&home);
        Ok(Self::at(home.join("Phaethon").join(DEFAULT_VAULT)))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Vault name, used to namespace per-vault state outside the vault.
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| DEFAULT_VAULT.to_string())
    }

    /// Create the vault skeleton and default spaces if they do not exist yet.
    /// Never overwrites anything.
    pub fn ensure_initialized(&self) -> io::Result<()> {
        for dir in ["memory", "skills"] {
            fs::create_dir_all(self.root.join(dir))?;
        }
        for space in DEFAULT_SPACES {
            fs::create_dir_all(self.root.join("spaces").join(space))?;
        }
        Ok(())
    }

    /// Resolve a space id to its folder, refusing anything that is not a plain
    /// existing directory directly under `spaces/` (no traversal, no symlink escape).
    pub fn space_dir(&self, space_id: &str) -> Result<PathBuf, String> {
        if !is_valid_space_id(space_id) {
            return Err(format!("\"{space_id}\" is not a valid space name"));
        }
        let spaces = self
            .root
            .join("spaces")
            .canonicalize()
            .map_err(|e| format!("spaces folder unavailable: {e}"))?;
        // A symlink is never a space, even one to a sibling (spaces::list skips
        // it too): it would let one folder answer to two ids.
        if spaces.join(space_id).symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("space \"{space_id}\" is not a folder inside this vault"));
        }
        let dir = spaces
            .join(space_id)
            .canonicalize()
            .map_err(|_| format!("space \"{space_id}\" does not exist in this vault"))?;
        if dir.parent() != Some(spaces.as_path()) || !dir.is_dir() {
            return Err(format!(
                "space \"{space_id}\" is not a folder inside this vault"
            ));
        }
        Ok(dir)
    }

    /// Change one setting in `<vault>/.phaethon/settings.json`, keeping every
    /// other field (including ones this version does not know) as it was.
    pub fn set_setting(&self, key: &str, value: serde_json::Value) -> io::Result<()> {
        let path = self.root.join(".phaethon").join("settings.json");
        let mut obj = match fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(serde_json::Value::Object(o)) => o,
                _ => return Err(io::Error::other("settings.json is not a JSON object; fix or remove it first")),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => serde_json::Map::new(),
            Err(e) => return Err(e),
        };
        obj.insert(key.to_string(), value);
        fs::create_dir_all(path.parent().expect("settings file has a parent"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&obj)?)?;
        fs::rename(tmp, path)
    }

    pub fn settings(&self) -> VaultSettings {
        fs::read_to_string(self.root.join(".phaethon").join("settings.json"))
            .ok()
            .map(|s| s.replace("\"--st-", "\"--ph-")) // token names before the rename
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}

/// The app was called steward before it was Phaethon: its vault lived in
/// `~/Steward`, with app state in `.steward/` folders. Move them once, never
/// overwriting anything that already exists under the new names.
fn migrate_legacy_root(home: &Path) {
    let (old, new) = (home.join("Steward"), home.join("Phaethon"));
    // A new vault that holds no files at all is only the skeleton a first
    // launch creates; it may give way to the old one.
    if old.is_dir() && new.is_dir() && !has_files(&new) {
        let _ = fs::remove_dir_all(&new);
    }
    if old.is_dir() && !new.exists() && fs::rename(&old, &new).is_err() {
        return;
    }
    let Ok(vaults) = fs::read_dir(&new) else { return };
    for vault in vaults.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()) {
        rename_state_dir(&vault);
        if let Ok(spaces) = fs::read_dir(vault.join("spaces")) {
            for space in spaces.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()) {
                rename_state_dir(&space);
            }
        }
    }
}

fn has_files(dir: &Path) -> bool {
    fs::read_dir(dir).map_or(true, |entries| {
        entries.filter_map(Result::ok).any(|e| {
            let p = e.path();
            // symlink_metadata: a link counts as content and is never followed.
            match p.symlink_metadata() {
                Ok(m) if m.is_dir() => has_files(&p),
                _ => true,
            }
        })
    })
}

fn rename_state_dir(dir: &Path) {
    let (old, new) = (dir.join(".steward"), dir.join(".phaethon"));
    if old.is_dir() && !new.exists() {
        let _ = fs::rename(old, new);
    }
}

/// The CLI session this space resumes, if one was saved and is well-formed.
/// The file is user-editable and may be synced, so anything that is not a
/// plain UUID is ignored rather than passed to the CLI as an argument.
pub fn read_session(space_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(session_file(space_dir)).ok()?;
    let id = raw.trim();
    is_uuid(id).then(|| id.to_string())
}

pub fn write_session(space_dir: &Path, session_id: &str) -> io::Result<()> {
    if !is_uuid(session_id) {
        return Err(io::Error::other("refusing to save a malformed session id"));
    }
    let file = session_file(space_dir);
    fs::create_dir_all(file.parent().expect("session file has a parent"))?;
    fs::write(file, format!("{session_id}\n"))
}

pub fn clear_session(space_dir: &Path) {
    let _ = fs::remove_file(session_file(space_dir));
}

fn session_file(space_dir: &Path) -> PathBuf {
    space_dir.join(".phaethon").join("session")
}

pub(crate) fn is_valid_space_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_ids() {
        assert!(is_valid_space_id("school"));
        assert!(is_valid_space_id("side-project_2"));
        for bad in [
            "", "..", "../work", "a/b", "School", "-x", ".phaethon", "a b",
        ] {
            assert!(!is_valid_space_id(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn uuids() {
        assert!(is_uuid("e06355fe-8387-4cb5-9fda-517b0d2b996a"));
        assert!(!is_uuid("--dangerously-skip-permissions"));
        assert!(!is_uuid("e06355fe-8387-4cb5-9fda-517b0d2b996a\n--x"));
    }

    #[test]
    fn space_dir_rejects_escape() {
        let tmp = std::env::temp_dir().join(format!("phaethon-vault-test-{}", std::process::id()));
        let vault = Vault::at(&tmp);
        vault.ensure_initialized().unwrap();
        assert!(vault.space_dir("school").is_ok());
        assert!(vault.space_dir("nope").is_err());
        assert!(vault.space_dir("../memory").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(tmp.join("memory"), tmp.join("spaces").join("sneaky"))
                .unwrap();
            assert!(vault.space_dir("sneaky").is_err());
            // A link to a sibling space is not a second name for it.
            std::os::unix::fs::symlink(tmp.join("spaces").join("school"), tmp.join("spaces").join("alias"))
                .unwrap();
            assert!(vault.space_dir("alias").is_err());
        }
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn legacy_steward_vault_moves_once() {
        let home = std::env::temp_dir().join(format!("phaethon-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("Steward/default/.steward")).unwrap();
        fs::create_dir_all(home.join("Steward/default/spaces/school/.steward")).unwrap();
        fs::write(home.join("Steward/default/spaces/school/.steward/thread.json"), "[]").unwrap();
        fs::write(home.join("Steward/default/.steward/settings.json"), r#"{"backend":"steward","appearance":{"tokens":{"--st-accent-h":200}}}"#).unwrap();
        migrate_legacy_root(&home);
        assert!(!home.join("Steward").exists());
        assert!(home.join("Phaethon/default/spaces/school/.phaethon/thread.json").is_file());
        let s = Vault::at(home.join("Phaethon/default")).settings();
        assert_eq!(s.backend, Backend::Phaethon);
        assert_eq!(s.appearance.unwrap()["tokens"]["--ph-accent-h"], 200);
        // A second run, or an old folder next to a new one with files, changes nothing.
        fs::create_dir_all(home.join("Steward/default")).unwrap();
        migrate_legacy_root(&home);
        assert!(home.join("Steward/default").is_dir());
        assert!(home.join("Phaethon/default/spaces/school/.phaethon/thread.json").is_file());
        fs::remove_dir_all(&home).unwrap();

        // An empty skeleton (a launch before the migration existed) gives way.
        fs::create_dir_all(home.join("Phaethon/default/spaces/work")).unwrap();
        fs::create_dir_all(home.join("Steward/default/spaces/work/.steward")).unwrap();
        fs::write(home.join("Steward/default/spaces/work/.steward/session"), "x").unwrap();
        migrate_legacy_root(&home);
        assert!(!home.join("Steward").exists());
        assert!(home.join("Phaethon/default/spaces/work/.phaethon/session").is_file());
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn settings_round_trip_keeps_unknown_fields() {
        let tmp = std::env::temp_dir().join(format!("phaethon-settings-test-{}", std::process::id()));
        let vault = Vault::at(&tmp);
        assert_eq!(vault.settings().backend, Backend::Phaethon);
        fs::create_dir_all(tmp.join(".phaethon")).unwrap();
        fs::write(tmp.join(".phaethon/settings.json"), r#"{"isolateClaudeConfig": true, "future": 1}"#).unwrap();
        vault.set_setting("backend", serde_json::json!("claude-cli")).unwrap();
        let s = vault.settings();
        assert_eq!(s.backend, Backend::ClaudeCli);
        assert!(s.isolate_claude_config);
        assert!(fs::read_to_string(tmp.join(".phaethon/settings.json")).unwrap().contains("future"));
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn appearance_accepts_well_formed() {
        use serde_json::json;
        assert!(validate_appearance(&json!({})).is_ok());
        assert!(validate_appearance(&json!({
            "version": 1,
            "theme": "dark",
            "readingFont": "opendyslexic",
            "reduceMotion": "on",
            "increaseContrast": "system",
            "tokens": {
                "--ph-accent-h": 290,
                "--ph-text-scale": 1.25,
                "--ph-tracking-normal": "0.02em",
                "--ph-focus-width": "3px",
                "--ph-some-colour": "oklch(0.62 0.08 168 / 90%)",
                "--ph-other-colour": "oklab(0.7 -0.05 0.02)"
            }
        }))
        .is_ok());
    }

    #[test]
    fn appearance_rejects_bad_shape() {
        use serde_json::json;
        let bad = [
            json!(null),
            json!([]),
            json!("dark"),
            json!({ "theme": "neon" }),
            json!({ "readingFont": "comic-sans" }),
            json!({ "theme": 1 }),
            json!({ "reduceMotion": "maybe" }),
            json!({ "version": 0 }),
            json!({ "version": "1" }),
            json!({ "fontUrl": "https://example.com" }),
            json!({ "tokens": [] }),
            json!({ "tokens": { "color": "red" } }),
            json!({ "tokens": { "--ph-": 1 } }),
            json!({ "tokens": { "--ph-Accent-h": 1 } }),
            json!({ "tokens": { "--ph-accent-h;": 1 } }),
            json!({ "tokens": { "--ph-accent-": 1 } }),
            json!({ "tokens": { "--x-accent-h": 1 } }),
            json!({ "tokens": { "--ph-accent-h": null } }),
            json!({ "tokens": { "--ph-accent-h": true } }),
            json!({ "tokens": { "--ph-accent-h": { "a": 1 } } }),
            json!({ "tokens": { "--ph-accent": "#ff0000" } }),
            json!({ "tokens": { "--ph-accent": "rgb(1,2,3)" } }),
            json!({ "tokens": { "--ph-accent": "hsl(1 2% 3%)" } }),
            json!({ "tokens": { "--ph-accent": "red; background: url(x)" } }),
            json!({ "tokens": { "--ph-accent": "url(x)" } }),
            json!({ "tokens": { "--ph-accent": "var(--ph-danger)" } }),
            json!({ "tokens": { "--ph-accent": "oklch(1 0 0) url(x)" } }),
            json!({ "tokens": { "--ph-accent": "oklch(1 0 0" } }),
            json!({ "tokens": { "--ph-accent": "" } }),
            json!({ "tokens": { "--ph-accent": "1".repeat(65) } }),
        ];
        for v in bad {
            assert!(validate_appearance(&v).is_err(), "{v} should be rejected");
        }
    }

    #[test]
    fn appearance_is_bounded() {
        let mut tokens = serde_json::Map::new();
        for i in 0..65 {
            tokens.insert(format!("--ph-t{i}"), serde_json::json!(1));
        }
        assert!(validate_appearance(&serde_json::json!({ "tokens": tokens })).is_err());
        let mut big = serde_json::Map::new();
        // 64 tokens (the most allowed), each with a 64-character name and value: over 8 KiB.
        for i in 0..64 {
            big.insert(format!("--ph-{i:0>59}"), serde_json::json!("1".repeat(64)));
        }
        assert!(validate_appearance(&serde_json::json!({ "tokens": big })).is_err(), "over 8 KiB");
    }

    #[test]
    fn appearance_round_trips_through_settings() {
        let tmp = std::env::temp_dir().join(format!("phaethon-appearance-test-{}", std::process::id()));
        let vault = Vault::at(&tmp);
        vault.set_setting("backend", serde_json::json!("claude-cli")).unwrap();
        let a = serde_json::json!({ "theme": "dark", "tokens": { "--ph-accent-h": 290 } });
        vault.set_setting("appearance", a.clone()).unwrap();
        let s = vault.settings();
        assert_eq!(s.appearance, Some(a));
        assert_eq!(s.backend, Backend::ClaudeCli, "other settings survive");
        fs::remove_dir_all(&tmp).unwrap();
    }
}
