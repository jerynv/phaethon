//! Full access: a space whose CLI (Claude Code, Codex, Gemini CLI) runs with
//! no walls at all. It reads and changes anything the person's account can,
//! runs any command and uses the network, without asking. Off unless the
//! person turns it on for that space in Settings › Spaces (after a warning),
//! and shown in the space for as long as it is on.
//!
//! Which spaces have it is kept on this computer only, in the app's own data
//! folder, never in the vault: a vault syncs, and a switch like this must not
//! turn itself on on another computer. Keyed by the vault's real path and the
//! space's id. Nothing a space can reach can turn it on: the file is outside
//! every space, and a walled CLI can write nowhere.
//!
//! What stays the same with it on: each CLI's own setup folder for the vault
//! (its login, never the person's config, hooks or instructions), and
//! Phaethon's own assistant, which keeps its tools and asks before saving.

use std::collections::BTreeSet;
use std::path::Path;

/// "<vault real path>\n<space id>" for each space with full access.
fn read(file: &Path) -> BTreeSet<String> {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn key(vault_root: &Path, space: &str) -> String {
    let root = vault_root.canonicalize().unwrap_or_else(|_| vault_root.to_path_buf());
    format!("{}\n{space}", root.display())
}

/// Whether `space` in the vault at `vault_root` has full access. Anything
/// unreadable counts as off.
pub fn is_on(file: Option<&Path>, vault_root: &Path, space: &str) -> bool {
    file.is_some_and(|f| read(f).contains(&key(vault_root, space)))
}

/// The spaces of this vault with full access.
pub fn list(file: Option<&Path>, vault_root: &Path) -> Vec<String> {
    let Some(f) = file else { return vec![] };
    let prefix = key(vault_root, "");
    read(f).iter().filter_map(|k| k.strip_prefix(&prefix)).map(str::to_string).collect()
}

/// Turn full access on or off for `space`, written whole (a temporary file
/// renamed over the old one).
pub fn set(file: Option<&Path>, vault_root: &Path, space: &str, on: bool) -> Result<(), String> {
    let f = file.ok_or("Phaethon has no folder of its own on this computer to keep this setting in.")?;
    let mut all = read(f);
    let k = key(vault_root, space);
    if on {
        all.insert(k);
    } else {
        all.remove(&k);
    }
    let fail = |e: std::io::Error| format!("Full access couldn’t be saved: {e}");
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let tmp = f.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&all).expect("a set of strings serializes")).map_err(fail)?;
    std::fs::rename(&tmp, f).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_per_space_and_per_vault_and_off_again() {
        let dir = std::env::temp_dir().join(format!("phaethon-full-access-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (vault, other) = (dir.join("Phaethon/default"), dir.join("Phaethon/other"));
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let file = dir.join("app-data/full-access.json");
        let f = Some(file.as_path());

        assert!(!is_on(f, &vault, "life"), "off until turned on");
        set(f, &vault, "life", true).unwrap();
        assert!(is_on(f, &vault, "life"));
        assert!(!is_on(f, &vault, "school"), "only the space it was turned on for");
        assert!(!is_on(f, &other, "life"), "only in that vault");
        assert_eq!(list(f, &vault), vec!["life"]);
        assert!(list(f, &other).is_empty());

        set(f, &vault, "life", false).unwrap();
        assert!(!is_on(f, &vault, "life"));
        assert!(list(f, &vault).is_empty());

        std::fs::write(&file, "not json").unwrap();
        assert!(!is_on(f, &vault, "life"), "an unreadable file is off");
        assert!(!is_on(None, &vault, "life"));
        assert!(set(None, &vault, "life", true).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
