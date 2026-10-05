//! Vault and space folders on disk.
//!
//! Layout (see docs/ARCHITECTURE.md): `<vault>/spaces/<space>/`, with per-space
//! app state in `<space>/.steward/`. Every path the UI names is validated here;
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

/// Per-vault preferences, read from `<vault>/.steward/settings.json`.
/// Preferences only: secrets never go in the vault (it may be synced).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultSettings {
    /// Opt-in: run the `claude` CLI with a per-vault `CLAUDE_CONFIG_DIR`.
    /// Off by default because a fresh config dir is logged out: turning this on
    /// means logging in to the CLI again for this vault. See ARCHITECTURE.md.
    pub isolate_claude_config: bool,
}

impl Vault {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `~/Steward/default`.
    pub fn default_location() -> io::Result<Self> {
        let home = home_dir().ok_or_else(|| io::Error::other("home directory not found"))?;
        Ok(Self::at(home.join("Steward").join(DEFAULT_VAULT)))
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

    pub fn settings(&self) -> VaultSettings {
        fs::read_to_string(self.root.join(".steward").join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
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
    space_dir.join(".steward").join("session")
}

fn is_valid_space_id(id: &str) -> bool {
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
            "", "..", "../work", "a/b", "School", "-x", ".steward", "a b",
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
        let tmp = std::env::temp_dir().join(format!("steward-vault-test-{}", std::process::id()));
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
        }
        fs::remove_dir_all(&tmp).unwrap();
    }
}
