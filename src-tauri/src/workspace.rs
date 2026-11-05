//! Device-local, explicitly chosen CLI working folders. Vault files never grant
//! an external path. Callers serialize read/modify/write with the AppState lock.
//! The native picker owns approval; `bind` must only receive its approved path.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::vault::is_valid_space_id;

const MAX_MAP_BYTES: u64 = 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub path: String,
    pub kind: WorkspaceKind,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Folder,
    Managed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    path: String,
    identity: Option<Identity>,
}

type Bindings = BTreeMap<String, Binding>;

fn text_path(path: &Path) -> Result<String, String> {
    path.to_str().map(str::to_owned).ok_or_else(|| "The workspace path is not valid Unicode.".into())
}

fn key(vault_root: &Path, space: &str) -> Result<String, String> {
    if !is_valid_space_id(space) {
        return Err("That is not a valid space id.".into());
    }
    let root = vault_root.canonicalize().map_err(|e| format!("The vault folder is unavailable: {e}"))?;
    let root = text_path(&root)?;
    if root.contains('\n') {
        return Err("The vault path cannot contain a newline.".into());
    }
    Ok(format!("{root}\n{space}"))
}

/// Resolve a trusted app-data file's existing parent, without creating it.
fn map_location(file: &Path, vault_root: &Path) -> Result<PathBuf, String> {
    if !file.is_absolute() || file.file_name().is_none() || file.components().any(|component| matches!(component, std::path::Component::ParentDir)) {
        return Err("The workspace settings path must be an absolute file path.".into());
    }
    let mut parent = file.parent().ok_or("The workspace settings folder is unavailable.")?;
    let mut missing = Vec::new();
    while !parent.exists() {
        missing.push(parent.file_name().ok_or("The workspace settings folder is unavailable.")?.to_os_string());
        parent = parent.parent().ok_or("The workspace settings folder is unavailable.")?;
    }
    let mut real = parent.canonicalize().map_err(|e| format!("The workspace settings folder is unavailable: {e}"))?;
    if !real.is_dir() {
        return Err("The workspace settings folder is not a directory.".into());
    }
    for component in missing.into_iter().rev() {
        real.push(component);
    }
    let root = vault_root.canonicalize().map_err(|e| format!("The vault folder is unavailable: {e}"))?;
    if real.starts_with(&root) {
        return Err("Workspace bindings must be stored outside the synced vault.".into());
    }
    Ok(real.join(file.file_name().unwrap()))
}

fn read(file: Option<&Path>, vault_root: &Path) -> Result<Bindings, String> {
    let Some(file) = file else { return Ok(BTreeMap::new()) };
    let file = map_location(file, vault_root)?;
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("Workspace settings could not be read: {e}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Workspace settings must be a regular file.".into());
    }
    if metadata.len() > MAX_MAP_BYTES {
        return Err("Workspace settings exceed the 1 MiB limit.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&file)
        .and_then(|file| file.take(MAX_MAP_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("Workspace settings could not be read: {e}"))?;
    if bytes.len() as u64 > MAX_MAP_BYTES {
        return Err("Workspace settings exceed the 1 MiB limit.".into());
    }
    let map: Bindings = serde_json::from_slice(&bytes).map_err(|_| "Workspace settings are invalid. Existing bindings were left unchanged.".to_string())?;
    for (key, binding) in &map {
        let (root, space) = key.split_once('\n').ok_or("Workspace settings contain an invalid key.")?;
        if !Path::new(root).is_absolute() || !is_valid_space_id(space) || !Path::new(&binding.path).is_absolute() {
            return Err("Workspace settings contain an invalid binding.".into());
        }
        #[cfg(unix)]
        if binding.identity.is_none() {
            return Err("Workspace settings are missing a folder identity.".into());
        }
    }
    Ok(map)
}

fn identity(metadata: &fs::Metadata) -> Option<Identity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(Identity { device: metadata.dev(), inode: metadata.ino() })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn folder(selected: &Path, vault_root: &Path, file: Option<&Path>) -> Result<(PathBuf, fs::Metadata), String> {
    if !selected.is_absolute() {
        return Err("Choose an absolute workspace folder.".into());
    }
    let before = fs::symlink_metadata(selected).map_err(|e| format!("The workspace folder is unavailable: {e}"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err("Choose a real folder, not a file or symbolic link.".into());
    }
    let real = selected.canonicalize().map_err(|e| format!("The workspace folder is unavailable: {e}"))?;
    let vault = vault_root.canonicalize().map_err(|e| format!("The vault folder is unavailable: {e}"))?;
    if real.parent().is_none() || real.starts_with(&vault) || real.components().any(|part| part.as_os_str() == ".phaethon") {
        return Err("Choose a project folder outside Phaethon's managed vault and state folders.".into());
    }
    if let Some(file) = file {
        let settings = map_location(file, vault_root)?;
        if settings.parent().is_some_and(|parent| real.starts_with(parent)) {
            return Err("Phaethon's app-data folder cannot be a workspace.".into());
        }
    }
    let metadata = fs::metadata(&real).map_err(|e| format!("The workspace folder is unavailable: {e}"))?;
    if identity(&before) != identity(&metadata) {
        return Err("The workspace folder changed while it was being selected. Choose it again.".into());
    }
    Ok((real, metadata))
}

fn bound_folder(binding: &Binding, vault_root: &Path, file: Option<&Path>) -> Result<PathBuf, String> {
    let selected = Path::new(&binding.path);
    let (real, metadata) = folder(selected, vault_root, file)?;
    if real != selected || identity(&metadata) != binding.identity {
        return Err("The chosen workspace folder was replaced or moved. Choose it again.".into());
    }
    Ok(real)
}

fn managed(managed_dir: &Path) -> WorkspaceView {
    let available = fs::symlink_metadata(managed_dir).is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    WorkspaceView { path: managed_dir.to_string_lossy().into_owned(), kind: WorkspaceKind::Managed, available }
}

/// A missing bound folder stays visible as unavailable; it never falls back.
pub fn get(file: Option<&Path>, vault_root: &Path, space: &str, managed_dir: &Path) -> Result<WorkspaceView, String> {
    let key = key(vault_root, space)?;
    let all = read(file, vault_root)?;
    Ok(match all.get(&key) {
        Some(binding) => WorkspaceView { path: binding.path.clone(), kind: WorkspaceKind::Folder, available: bound_folder(binding, vault_root, file).is_ok() },
        None => managed(managed_dir),
    })
}

fn write(file: &Path, vault_root: &Path, all: &Bindings) -> Result<(), String> {
    let file = map_location(file, vault_root)?;
    let bytes = serde_json::to_vec_pretty(all).map_err(|e| format!("Workspace settings could not be saved: {e}"))?;
    if bytes.len() as u64 > MAX_MAP_BYTES {
        return Err("Workspace settings exceed the 1 MiB limit.".into());
    }
    let parent = file.parent().ok_or("The workspace settings folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(|e| format!("Workspace settings could not be saved: {e}"))?;
    let temp = parent.join(format!(".workspaces-{}-{}.tmp", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(&temp).map_err(|e| format!("Workspace settings could not be saved: {e}"))?;
    let result = (|| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        output.write_all(&bytes)?;
        output.sync_all()
    })();
    drop(output);
    let result = result.and_then(|_| fs::rename(&temp, &file));
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Workspace settings could not be saved: {error}"));
    }
    Ok(())
}

/// Save only a path approved by this device's native picker. Never touches project contents.
pub fn bind(file: Option<&Path>, vault_root: &Path, space: &str, selected: &Path) -> Result<WorkspaceView, String> {
    let file = file.ok_or("Phaethon's app-data folder is unavailable.")?;
    let key = key(vault_root, space)?;
    let mut all = read(Some(file), vault_root)?;
    let (real, metadata) = folder(selected, vault_root, Some(file))?;
    let path = text_path(&real)?;
    all.insert(key, Binding { path: path.clone(), identity: identity(&metadata) });
    write(file, vault_root, &all)?;
    Ok(WorkspaceView { path, kind: WorkspaceKind::Folder, available: true })
}

/// Return to managed space files. Removing a binding never deletes its folder.
pub fn clear(file: Option<&Path>, vault_root: &Path, space: &str, managed_dir: &Path) -> Result<WorkspaceView, String> {
    let file = file.ok_or("Phaethon's app-data folder is unavailable.")?;
    let key = key(vault_root, space)?;
    let mut all = read(Some(file), vault_root)?;
    if all.remove(&key).is_some() {
        write(file, vault_root, &all)?;
    }
    Ok(managed(managed_dir))
}

/// CLI execution uses this result, never a display path or a synced preference.
pub fn resolve(file: Option<&Path>, vault_root: &Path, space: &str, managed_dir: &Path) -> Result<PathBuf, String> {
    let key = key(vault_root, space)?;
    let all = read(file, vault_root)?;
    match all.get(&key) {
        Some(binding) => bound_folder(binding, vault_root, file),
        None if managed(managed_dir).available => managed_dir.canonicalize().map_err(|e| format!("The managed workspace is unavailable: {e}")),
        None => Err("The managed workspace folder is unavailable.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        vault: PathBuf,
        managed: PathBuf,
        file: PathBuf,
        project: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("phaethon-workspace-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
            let vault = root.join("vault");
            let managed = vault.join("spaces/work");
            let file = root.join("app-data/workspaces.json");
            let project = root.join("A project with spaces");
            fs::create_dir_all(&managed).unwrap();
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("keep.txt"), "existing project").unwrap();
            Self { root, vault, managed, file, project }
        }
        fn file(&self) -> Option<&Path> {
            Some(&self.file)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn managed_default_pick_persists_and_clear_never_changes_project_files() {
        let f = Fixture::new();
        assert_eq!(get(f.file(), &f.vault, "work", &f.managed).unwrap(), managed(&f.managed));
        assert_eq!(resolve(f.file(), &f.vault, "work", &f.managed).unwrap(), f.managed.canonicalize().unwrap());
        assert!(!f.file.exists(), "viewing or cancelling without bind writes no map");
        let picked = bind(f.file(), &f.vault, "work", &f.project).unwrap();
        assert_eq!(picked.kind, WorkspaceKind::Folder);
        assert!(picked.available);
        assert_eq!(get(f.file(), &f.vault, "work", &f.managed).unwrap(), picked, "reopening reads persisted binding");
        assert_eq!(resolve(f.file(), &f.vault, "work", &f.managed).unwrap(), f.project.canonicalize().unwrap());
        assert_eq!(clear(f.file(), &f.vault, "work", &f.managed).unwrap().kind, WorkspaceKind::Managed);
        assert_eq!(fs::read_to_string(f.project.join("keep.txt")).unwrap(), "existing project");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&f.file).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn bindings_are_independent_per_vault_and_space() {
        let f = Fixture::new();
        let other_vault = f.root.join("other-vault");
        fs::create_dir(&other_vault).unwrap();
        bind(f.file(), &f.vault, "work", &f.project).unwrap();
        assert_eq!(get(f.file(), &f.vault, "school", &f.managed).unwrap().kind, WorkspaceKind::Managed);
        assert_eq!(get(f.file(), &other_vault, "work", &f.managed).unwrap().kind, WorkspaceKind::Managed);
        bind(f.file(), &other_vault, "school", &f.project).unwrap();
        clear(f.file(), &f.vault, "work", &f.managed).unwrap();
        assert_eq!(get(f.file(), &other_vault, "school", &f.managed).unwrap().kind, WorkspaceKind::Folder);
    }

    #[test]
    fn malformed_oversized_or_non_file_map_is_not_overwritten() {
        let f = Fixture::new();
        fs::create_dir_all(f.file.parent().unwrap()).unwrap();
        for invalid in [b"{bad json".to_vec(), vec![b' '; MAX_MAP_BYTES as usize + 1], br#"{"bad-key":{"path":"/tmp"}}"#.to_vec()] {
            fs::write(&f.file, &invalid).unwrap();
            assert!(bind(f.file(), &f.vault, "work", &f.project).is_err());
            assert!(clear(f.file(), &f.vault, "work", &f.managed).is_err());
            assert!(get(f.file(), &f.vault, "work", &f.managed).is_err());
            assert_eq!(fs::read(&f.file).unwrap(), invalid);
        }
        fs::remove_file(&f.file).unwrap();
        fs::create_dir(&f.file).unwrap();
        assert!(bind(f.file(), &f.vault, "work", &f.project).is_err());
        assert!(f.file.is_dir());
    }

    #[test]
    fn invalid_ids_and_protected_paths_do_not_save_bindings() {
        let f = Fixture::new();
        for id in ["../work", "", "a\nb", "work/other"] {
            assert!(bind(f.file(), &f.vault, id, &f.project).is_err());
            assert!(get(f.file(), &f.vault, id, &f.managed).is_err());
        }
        let state = f.project.join(".phaethon");
        fs::create_dir(&state).unwrap();
        fs::create_dir_all(f.file.parent().unwrap()).unwrap();
        for path in [&f.vault, &f.managed, &state, f.file.parent().unwrap(), Path::new("/"), Path::new("relative/project")] {
            assert!(bind(f.file(), &f.vault, "work", path).is_err(), "{path:?}");
        }
        let synced_map = f.vault.join("bindings.json");
        assert!(bind(Some(&synced_map), &f.vault, "work", &f.project).is_err());
        assert!(!f.file.exists());
        assert!(!synced_map.exists());
        assert!(bind(None, &f.vault, "work", &f.project).is_err());
    }

    #[test]
    fn missing_and_replaced_roots_stay_bound_but_cannot_execute() {
        let f = Fixture::new();
        let picked = bind(f.file(), &f.vault, "work", &f.project).unwrap();
        let moved = f.root.join("moved-project");
        fs::rename(&f.project, &moved).unwrap();
        let missing = get(f.file(), &f.vault, "work", &f.managed).unwrap();
        assert_eq!(missing.path, picked.path);
        assert_eq!(missing.kind, WorkspaceKind::Folder);
        assert!(!missing.available);
        assert!(resolve(f.file(), &f.vault, "work", &f.managed).is_err());
        fs::create_dir(&f.project).unwrap();
        #[cfg(unix)]
        {
            assert!(!get(f.file(), &f.vault, "work", &f.managed).unwrap().available, "a different inode at the same path is not approved");
            assert!(resolve(f.file(), &f.vault, "work", &f.managed).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_picks_replacements_and_map_files_are_rejected() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let link = f.root.join("project-alias");
        symlink(&f.project, &link).unwrap();
        assert!(bind(f.file(), &f.vault, "work", &link).is_err());
        bind(f.file(), &f.vault, "work", &f.project).unwrap();
        let moved = f.root.join("moved-project");
        fs::rename(&f.project, &moved).unwrap();
        symlink(&moved, &f.project).unwrap();
        assert!(!get(f.file(), &f.vault, "work", &f.managed).unwrap().available);
        assert!(resolve(f.file(), &f.vault, "work", &f.managed).is_err());
        let protected = f.root.join("do-not-change.json");
        fs::write(&protected, "private data").unwrap();
        fs::remove_file(&f.file).unwrap();
        symlink(&protected, &f.file).unwrap();
        assert!(clear(f.file(), &f.vault, "work", &f.managed).is_err());
        assert_eq!(fs::read_to_string(protected).unwrap(), "private data");
    }
}
