//! The app's identifier was `dev.phaethon.app` until 0.1.2. It ended in `.app`, which
//! clashes with macOS bundle names, and named a domain the project doesn't own; it is
//! now `io.github.jerynv.phaethon`. Each OS keeps folders under the identifier (app
//! data with the per-vault CLI logins and full-access.json, the cache, the webview's
//! storage), so the old ones are moved to the new name once, at launch, before
//! anything opens them. A folder already at the new name is left alone, as is the old
//! one beside it.

use std::path::PathBuf;

pub const OLD_IDENTIFIER: &str = "dev.phaethon.app";

/// (old, new) for each folder in `dirs` that is named `identifier`: the same folder
/// under the old identifier, beside it. Each pair once.
pub fn moves(dirs: impl IntoIterator<Item = PathBuf>, identifier: &str) -> Vec<(PathBuf, PathBuf)> {
    let mut out: Vec<(PathBuf, PathBuf)> = vec![];
    for new in dirs {
        if new.file_name().and_then(|n| n.to_str()) != Some(identifier) {
            continue;
        }
        let Some(parent) = new.parent() else { continue };
        let pair = (parent.join(OLD_IDENTIFIER), new);
        if !out.contains(&pair) {
            out.push(pair);
        }
    }
    out
}

/// Move each old folder to its new name when only the old one exists. Says what it did.
pub fn migrate(moves: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut said = vec![];
    for (old, new) in moves {
        if !old.is_dir() {
            continue;
        }
        if new.exists() {
            said.push(format!("left {} as it is: {} already exists", old.display(), new.display()));
            continue;
        }
        let moved = new.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::rename(old, new));
        said.push(match moved {
            Ok(()) => format!("moved {} to {}", old.display(), new.display()),
            Err(e) => format!("couldn’t move {} to {}: {e}", old.display(), new.display()),
        });
    }
    said
}

/// Every folder the OS keeps under this app's identifier, for [`moves`].
pub fn app_dirs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<PathBuf> {
    use tauri::Manager;
    let p = app.path();
    let mut dirs: Vec<PathBuf> =
        [p.app_data_dir(), p.app_local_data_dir(), p.app_config_dir(), p.app_cache_dir()].into_iter().flatten().collect();
    // WKWebView keeps the window's storage (and the course sign-in windows') here.
    #[cfg(target_os = "macos")]
    if let Ok(home) = p.home_dir() {
        let id = &app.config().identifier;
        dirs.push(home.join("Library/WebKit").join(id));
        dirs.push(home.join("Library/HTTPStorages").join(id));
    }
    dirs
}

/// Run the move for this app. Called first thing in `run`'s setup.
pub fn migrate_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let id = app.config().identifier.clone();
    if id == OLD_IDENTIFIER {
        return;
    }
    for line in migrate(&moves(app_dirs(app), &id)) {
        eprintln!("identifier: {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NEW: &str = "io.github.jerynv.phaethon";

    fn root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("phaethon-identity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pairs_only_folders_named_by_the_identifier_once_each() {
        let support = PathBuf::from("/Users/a/Library/Application Support");
        let m = moves(
            [support.join(NEW), support.join(NEW), PathBuf::from("/Users/a/Library/Caches").join(NEW), PathBuf::from("/elsewhere")],
            NEW,
        );
        assert_eq!(
            m,
            [
                (support.join(OLD_IDENTIFIER), support.join(NEW)),
                (PathBuf::from("/Users/a/Library/Caches").join(OLD_IDENTIFIER), PathBuf::from("/Users/a/Library/Caches").join(NEW)),
            ]
        );
    }

    #[test]
    fn moves_the_old_folder_with_everything_in_it() {
        let r = root("move");
        fs::create_dir_all(r.join(OLD_IDENTIFIER).join("claude-config/vault")).unwrap();
        fs::write(r.join(OLD_IDENTIFIER).join("full-access.json"), "[\"x\"]").unwrap();
        let said = migrate(&moves([r.join(NEW)], NEW));
        assert_eq!(said.len(), 1, "{said:?}");
        assert!(!r.join(OLD_IDENTIFIER).exists());
        assert_eq!(fs::read_to_string(r.join(NEW).join("full-access.json")).unwrap(), "[\"x\"]");
        assert!(r.join(NEW).join("claude-config/vault").is_dir());
        // Run again (every later launch): nothing to do.
        assert!(migrate(&moves([r.join(NEW)], NEW)).is_empty());
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn never_overwrites_a_folder_already_at_the_new_name() {
        let r = root("both");
        fs::create_dir_all(r.join(OLD_IDENTIFIER)).unwrap();
        fs::write(r.join(OLD_IDENTIFIER).join("full-access.json"), "old").unwrap();
        fs::create_dir_all(r.join(NEW)).unwrap();
        fs::write(r.join(NEW).join("full-access.json"), "new").unwrap();
        let said = migrate(&moves([r.join(NEW)], NEW));
        assert!(said[0].starts_with("left"), "{said:?}");
        assert_eq!(fs::read_to_string(r.join(NEW).join("full-access.json")).unwrap(), "new");
        assert_eq!(fs::read_to_string(r.join(OLD_IDENTIFIER).join("full-access.json")).unwrap(), "old");
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn the_shipped_identifier_is_the_new_one() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW);
        // Windows keeps its install records under the publisher, which used to come from
        // the old identifier ("phaethon"); it stays that, so updates find the install.
        assert_eq!(conf["bundle"]["publisher"], "phaethon");
    }
}
