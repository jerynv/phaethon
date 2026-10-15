//! Files and folders the user adds to a space from elsewhere on their
//! computer (Add files… / Add a folder…, from the + menu, a space's menu, the
//! palette or a button under a reply). They are copied, never moved or
//! linked, into the space's `files/` folder, so they live in the vault like
//! anything else and the assistant reads them with its usual file tools. The
//! paths come from the system's own picker in the core: the webview never
//! names one.
//!
//! What is copied: ordinary files and folders. Hidden ones (a name starting
//! with ".", like `.git` or `.DS_Store`) and links are left out, so a link
//! can never pull something else in. Nothing in the vault is copied into it
//! again, and a name already in `files/` gets a number ("Resume 2.pdf"), so
//! nothing there is ever replaced. A folder is copied under a hidden name and
//! renamed when it is whole, so a failed copy leaves nothing half done.

use std::fs;
use std::path::{Path, PathBuf};

pub const FOLDER: &str = "files";
const MAX_FILES: usize = 5000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    /// Where each picked file or folder now is, relative to the space ("files/Resume.pdf").
    pub paths: Vec<String>,
    /// Files copied, counting those inside folders.
    pub files: usize,
    /// Hidden files and links left out.
    pub skipped: usize,
}

/// What would be copied: each picked source with its files (relative to it).
struct Plan {
    items: Vec<(PathBuf, Vec<PathBuf>)>,
    bytes: u64,
    files: usize,
    skipped: usize,
}

fn hidden(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

fn walk(root: &Path, rel: &Path, out: &mut Vec<PathBuf>, plan: &mut Plan) -> Result<(), String> {
    let dir = root.join(rel);
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("“{}” couldn’t be read: {e}", dir.display()))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("“{}” couldn’t be read: {e}", path.display()))?;
        let child = rel.join(e.file_name());
        if hidden(&path) || meta.file_type().is_symlink() {
            plan.skipped += 1;
        } else if meta.is_dir() {
            out.push(child.clone()); // the folder itself, so an empty one is kept
            walk(root, &child, out, plan)?;
        } else if meta.is_file() {
            plan.files += 1;
            plan.bytes += meta.len();
            out.push(child);
        } else {
            plan.skipped += 1;
        }
        if plan.files > MAX_FILES {
            return Err(format!(
                "That’s more than {MAX_FILES} files, so nothing was added. Add a smaller folder, or the folders inside it one at a time."
            ));
        }
    }
    Ok(())
}

fn plan(sources: &[PathBuf], vault_root: &Path) -> Result<Plan, String> {
    let vault = vault_root.canonicalize().unwrap_or_else(|_| vault_root.to_path_buf());
    let mut plan = Plan { items: vec![], bytes: 0, files: 0, skipped: 0 };
    for src in sources {
        let meta = fs::symlink_metadata(src).map_err(|_| format!("“{}” isn’t there any more.", src.display()))?;
        if meta.file_type().is_symlink() {
            plan.skipped += 1;
            continue;
        }
        let real = src.canonicalize().map_err(|e| format!("“{}” couldn’t be read: {e}", src.display()))?;
        if real.starts_with(&vault) {
            return Err("That’s already in your Phaethon folder, so nothing was added. Anything inside a space can already be read there.".into());
        }
        if vault.starts_with(&real) {
            return Err("That folder holds your Phaethon folder, so nothing was added. Pick a folder inside it instead.".into());
        }
        if meta.is_dir() {
            let mut inside = vec![];
            walk(&real, Path::new(""), &mut inside, &mut plan)?;
            plan.items.push((real, inside));
        } else if meta.is_file() {
            plan.files += 1;
            plan.bytes += meta.len();
            plan.items.push((real, vec![]));
        } else {
            plan.skipped += 1;
        }
    }
    if plan.bytes > MAX_BYTES {
        return Err(format!(
            "That’s {:.1} GB, more than the 1 GB Phaethon adds at once, so nothing was added. Add a smaller folder, or the folders inside it one at a time.",
            plan.bytes as f64 / 1e9
        ));
    }
    Ok(plan)
}

/// A name in `dir` that isn't taken: "Resume.pdf", then "Resume 2.pdf", "Resume 3.pdf"…
fn free_name(dir: &Path, name: &str, is_dir: bool) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| format!("{stem} {n}{ext}")).find(|n| !dir.join(n).exists()).unwrap()
}

fn copy_tree(src: &Path, inside: &[PathBuf], dest: &Path) -> std::io::Result<()> {
    fs::create_dir(dest)?;
    for rel in inside {
        let (from, to) = (src.join(rel), dest.join(rel));
        if from.is_dir() {
            fs::create_dir_all(&to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy `sources` (picked by the user) into `<space>/files/`. Checks
/// everything first: over the limits, or anything from inside the vault, and
/// nothing is copied.
pub fn add(space_dir: &Path, vault_root: &Path, sources: &[PathBuf]) -> Result<Added, String> {
    let plan = plan(sources, vault_root)?;
    let dir = space_dir.join(FOLDER);
    fs::create_dir_all(&dir).map_err(|e| format!("The space’s files folder couldn’t be made: {e}"))?;
    let mut paths = vec![];
    for (src, inside) in &plan.items {
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Added".into());
        let is_dir = src.is_dir();
        let name = free_name(&dir, &name, is_dir);
        let fail = |e: std::io::Error| format!("“{name}” couldn’t be copied: {e}. What was added before it is kept.");
        if is_dir {
            let temp = dir.join(format!(".adding-{}-{name}", std::process::id()));
            if let Err(e) = copy_tree(src, inside, &temp).and_then(|_| fs::rename(&temp, dir.join(&name))) {
                let _ = fs::remove_dir_all(&temp);
                return Err(fail(e));
            }
        } else {
            fs::copy(src, dir.join(&name)).map_err(fail)?;
        }
        paths.push(format!("{FOLDER}/{name}"));
    }
    Ok(Added { paths, files: plan.files, skipped: plan.skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("phaethon-space-add-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn setup(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = tmp(tag);
        let vault = root.join("vault");
        let space = vault.join("spaces/life");
        fs::create_dir_all(&space).unwrap();
        let outside = root.join("Documents");
        fs::create_dir_all(&outside).unwrap();
        (vault, space, outside)
    }

    #[test]
    fn copies_a_folder_whole_without_hidden_files_or_links() {
        let (vault, space, docs) = setup("folder");
        let school = docs.join("Scool");
        fs::create_dir_all(school.join("2026/empty")).unwrap();
        fs::create_dir_all(school.join(".git")).unwrap();
        fs::write(school.join("2026/Resume.pdf"), b"%PDF-1.7").unwrap();
        fs::write(school.join("notes.md"), "hi").unwrap();
        fs::write(school.join(".DS_Store"), "x").unwrap();
        fs::write(school.join(".git/config"), "x").unwrap();
        fs::write(docs.join("secret.txt"), "no").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(docs.join("secret.txt"), school.join("link.txt")).unwrap();

        let added = add(&space, &vault, &[school.clone()]).unwrap();
        assert_eq!(added.paths, vec!["files/Scool"]);
        assert_eq!(added.files, 2);
        assert_eq!(fs::read(space.join("files/Scool/2026/Resume.pdf")).unwrap(), b"%PDF-1.7");
        assert_eq!(fs::read_to_string(space.join("files/Scool/notes.md")).unwrap(), "hi");
        assert!(space.join("files/Scool/2026/empty").is_dir(), "an empty folder is kept");
        for gone in [".DS_Store", ".git", "link.txt"] {
            assert!(!space.join("files/Scool").join(gone).exists(), "{gone} left out");
        }
        assert_eq!(added.skipped, if cfg!(unix) { 3 } else { 2 });
        assert!(school.join("notes.md").exists(), "copied, never moved");

        // Again: a second copy beside it, nothing replaced, no temp folder left.
        let again = add(&space, &vault, &[school]).unwrap();
        assert_eq!(again.paths, vec!["files/Scool 2"]);
        let names: Vec<_> = fs::read_dir(space.join("files")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn files_get_a_number_when_the_name_is_taken() {
        let (vault, space, docs) = setup("files");
        fs::write(docs.join("Resume.pdf"), "1").unwrap();
        fs::write(docs.join("cover.txt"), "2").unwrap();
        fs::create_dir_all(space.join("files")).unwrap();
        fs::write(space.join("files/Resume.pdf"), "old").unwrap();
        let added = add(&space, &vault, &[docs.join("Resume.pdf"), docs.join("cover.txt")]).unwrap();
        assert_eq!(added.paths, vec!["files/Resume 2.pdf", "files/cover.txt"]);
        assert_eq!(added.files, 2);
        assert_eq!(fs::read_to_string(space.join("files/Resume.pdf")).unwrap(), "old", "never replaced");
        assert_eq!(fs::read_to_string(space.join("files/Resume 2.pdf")).unwrap(), "1");
    }

    #[test]
    fn refuses_the_vault_itself_and_what_holds_it() {
        let (vault, space, _) = setup("vault");
        fs::write(vault.join("MANUAL.md"), "m").unwrap();
        let inside = add(&space, &vault, &[vault.join("MANUAL.md")]).unwrap_err();
        assert!(inside.contains("already in your Phaethon folder"), "{inside}");
        let holds = add(&space, &vault, &[vault.parent().unwrap().to_path_buf()]).unwrap_err();
        assert!(holds.contains("holds your Phaethon folder"), "{holds}");
        assert!(!space.join("files").exists(), "nothing made");
    }

    #[test]
    fn too_many_files_adds_nothing() {
        let (vault, space, docs) = setup("many");
        let big = docs.join("big");
        fs::create_dir_all(&big).unwrap();
        for i in 0..=MAX_FILES {
            fs::write(big.join(format!("{i}.txt")), "").unwrap();
        }
        let e = add(&space, &vault, &[big]).unwrap_err();
        assert!(e.contains("more than 5000 files") && e.contains("nothing was added"), "{e}");
        assert!(!space.join("files").exists());
    }
}
