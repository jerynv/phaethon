//! Export: a copy of one whole space as a single .zip.
//!
//! The archive holds everything in the space folder, its conversations and
//! attachments under `.phaethon/` included, inside one top folder named after
//! the space's id. Nothing outside the space goes in: the walk starts at the
//! space's real folder and never follows a symlink (a link is left out, whether
//! it points inside the space or out of it). Keys live in the OS keychain, not
//! in the space, so none can end up in an export.
//!
//! Where the file goes is chosen by the person in a native save dialog that
//! the core opens itself (lib.rs `space_export`); the webview names only the
//! space. The zip is written next to its destination under a temporary name
//! and renamed into place once complete, so a failed export never leaves half
//! a file under the chosen name.

use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::{Component, Path, PathBuf};

use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

/// What one export wrote.
#[derive(Debug, Clone, PartialEq)]
pub struct Exported {
    pub file: PathBuf,
    /// Files (not folders) in the archive.
    pub files: usize,
}

/// The suggested file name: the space's name and today's date, "School 2026-10-10.zip".
/// Characters a file name can't hold on some system are dropped; the id stands
/// in when nothing is left.
pub fn suggested_name(display: &str, id: &str) -> String {
    let clean: String = display
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .collect();
    let clean = clean.trim().trim_start_matches('.').trim();
    let base = if clean.is_empty() { id } else { clean };
    format!("{base} {}.zip", crate::attachments::today())
}

/// One thing in the space, relative to its folder.
struct Entry {
    rel: PathBuf,
    dir: bool,
}

/// Every folder and plain file under `root`, depth first, in name order.
/// Symlinks and anything that is neither (sockets, devices) are skipped.
fn walk(root: &Path, rel: &Path, out: &mut Vec<Entry>) -> io::Result<()> {
    let mut children: Vec<_> = fs::read_dir(root.join(rel))?.collect::<Result<_, _>>()?;
    children.sort_by_key(|e| e.file_name());
    for child in children {
        // file_type() does not follow links: a symlink reports as one.
        let kind = child.file_type()?;
        let path = rel.join(child.file_name());
        if kind.is_dir() {
            out.push(Entry { rel: path.clone(), dir: true });
            walk(root, &path, out)?;
        } else if kind.is_file() {
            out.push(Entry { rel: path, dir: false });
        }
    }
    Ok(())
}

/// The name inside the archive: `<id>/notes/plan.md`, always with forward slashes.
fn entry_name(id: &str, rel: &Path) -> String {
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    format!("{id}/{}", parts.join("/"))
}

/// Open a file for reading without following a link at its last step (it was
/// a plain file when listed; it may have been swapped for a link since).
fn open_no_follow(path: &Path) -> io::Result<File> {
    let mut o = fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    o.open(path)
}

/// Write `space_dir` (a space's folder, already resolved by `Vault::space_dir`)
/// to `dest` as a zip whose top folder is `id`.
pub fn export(space_dir: &Path, id: &str, dest: &Path) -> Result<Exported, String> {
    let root = space_dir
        .canonicalize()
        .map_err(|e| format!("The space’s folder couldn’t be found: {e}"))?;
    let mut entries = Vec::new();
    walk(&root, Path::new(""), &mut entries).map_err(|e| format!("The space’s files couldn’t be listed: {e}"))?;

    let file_name = dest
        .file_name()
        .ok_or("Choose a file name for the export.")?
        .to_string_lossy()
        .into_owned();
    let tmp = dest.with_file_name(format!(".{file_name}.part"));
    let written = write_zip(&root, id, &entries, &tmp);
    let files = match written {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("The export couldn’t be saved as “{file_name}”: {e}")
    })?;
    Ok(Exported { file: dest.to_path_buf(), files })
}

fn write_zip(root: &Path, id: &str, entries: &[Entry], to: &Path) -> Result<usize, String> {
    let out = File::create(to).map_err(|e| format!("The export couldn’t be saved there: {e}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(out));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let save_err = |e: &dyn std::fmt::Display| format!("The export couldn’t be written: {e}");
    zip.add_directory(format!("{id}/"), options).map_err(|e| save_err(&e))?;
    let mut files = 0;
    for entry in entries {
        let name = entry_name(id, &entry.rel);
        if entry.dir {
            zip.add_directory(format!("{name}/"), options).map_err(|e| save_err(&e))?;
            continue;
        }
        let shown = entry.rel.display();
        let path = root.join(&entry.rel);
        // A folder on the way swapped for a link since the walk would lead out: check where it really is.
        let real = path.canonicalize().map_err(|e| format!("“{shown}” couldn’t be read, so nothing was exported: {e}"))?;
        if !real.starts_with(root) {
            return Err(format!("“{shown}” now leads outside the space, so nothing was exported."));
        }
        let mut src = open_no_follow(&path).map_err(|e| format!("“{shown}” couldn’t be read, so nothing was exported: {e}"))?;
        let big = src.metadata().map(|m| m.len() >= u64::from(u32::MAX)).unwrap_or(false);
        zip.start_file(name, options.large_file(big)).map_err(|e| save_err(&e))?;
        io::copy(&mut src, &mut zip).map_err(|e| format!("“{shown}” couldn’t be copied into the export: {e}"))?;
        files += 1;
    }
    let mut buf = zip.finish().map_err(|e| save_err(&e))?;
    io::Write::flush(&mut buf).map_err(|e| save_err(&e))?;
    buf.get_ref().sync_all().map_err(|e| save_err(&e))?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-export-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every entry name in the zip, with each file's contents ("" for folders).
    fn contents(zip: &Path) -> Vec<(String, String)> {
        let mut a = zip::ZipArchive::new(File::open(zip).unwrap()).unwrap();
        (0..a.len())
            .map(|i| {
                let mut f = a.by_index(i).unwrap();
                let mut s = String::new();
                if f.is_file() {
                    f.read_to_string(&mut s).unwrap();
                }
                (f.name().unwrap().to_string(), s)
            })
            .collect()
    }

    #[test]
    fn exports_the_files_and_conversations_and_nothing_outside() {
        let dir = temp("all");
        let vault = crate::vault::Vault::at(&dir);
        vault.ensure_initialized().unwrap();
        let school = dir.join("spaces/school");
        fs::create_dir_all(school.join("notes/empty")).unwrap();
        fs::create_dir_all(school.join(".phaethon/threads")).unwrap();
        fs::create_dir_all(school.join("attachments/2026-10-10")).unwrap();
        fs::write(school.join("notes/plan.md"), "plan").unwrap();
        fs::write(school.join(".phaethon/thread.json"), "[current]").unwrap();
        fs::write(school.join(".phaethon/threads/1.json"), "[old]").unwrap();
        fs::write(school.join("attachments/2026-10-10/a.png"), "png").unwrap();
        // Outside the space: a sibling space, the vault's own files, and links to them.
        fs::write(dir.join("spaces/work/secret.md"), "work secret").unwrap();
        fs::write(dir.join("MANUAL.md"), "manual").unwrap();
        fs::write(dir.join("outside.txt"), "outside").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(dir.join("spaces/work/secret.md"), school.join("leak.md")).unwrap();
            symlink(dir.join("spaces/work"), school.join("work-link")).unwrap();
            symlink("/etc", school.join("notes/etc")).unwrap();
            symlink(dir.join("outside.txt"), school.join(".phaethon/linked.json")).unwrap();
            // Even a link that stays inside the space is left out (it would duplicate files).
            symlink(school.join("notes/plan.md"), school.join("plan-again.md")).unwrap();
        }

        let space_dir = vault.space_dir("school").unwrap();
        let out = temp("all-out").join("School 2026-10-10.zip");
        let done = export(&space_dir, "school", &out).unwrap();
        assert_eq!(done, Exported { file: out.clone(), files: 4 });
        let got = contents(&out);
        let names: Vec<&str> = got.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "school/",
                "school/.phaethon/",
                "school/.phaethon/thread.json",
                "school/.phaethon/threads/",
                "school/.phaethon/threads/1.json",
                "school/attachments/",
                "school/attachments/2026-10-10/",
                "school/attachments/2026-10-10/a.png",
                "school/notes/",
                "school/notes/empty/",
                "school/notes/plan.md",
            ]
        );
        let text = |n: &str| got.iter().find(|(name, _)| name == n).map(|(_, s)| s.as_str());
        assert_eq!(text("school/notes/plan.md"), Some("plan"));
        assert_eq!(text("school/.phaethon/thread.json"), Some("[current]"));
        for (_, body) in &got {
            assert!(!body.contains("secret") && !body.contains("manual") && !body.contains("outside"), "{body}");
        }
        assert!(!out.with_file_name(".School 2026-10-10.zip.part").exists(), "no temporary file is left");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(out.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_failed_export_leaves_nothing_under_the_name() {
        let dir = temp("fail");
        fs::write(dir.join("a.md"), "a").unwrap();
        // The destination's folder does not exist.
        let out = dir.join("missing/School.zip");
        let err = export(&dir, "school", &out).unwrap_err();
        assert!(err.contains("couldn’t be saved"), "{err}");
        assert!(!out.exists());
        // An unreadable file stops the export rather than leaving it out silently.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.join("a.md"), fs::Permissions::from_mode(0o000)).unwrap();
            let out = temp("fail-out").join("School.zip");
            // Root can read anything; only check when the permission actually bites.
            if File::open(dir.join("a.md")).is_err() {
                let err = export(&dir, "school", &out).unwrap_err();
                assert!(err.contains("“a.md” couldn’t be read"), "{err}");
                assert!(!out.exists() && !out.with_file_name(".School.zip.part").exists());
            }
            fs::set_permissions(dir.join("a.md"), fs::Permissions::from_mode(0o644)).unwrap();
            fs::remove_dir_all(out.parent().unwrap()).unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names() {
        let today = crate::attachments::today();
        assert_eq!(suggested_name("School", "school"), format!("School {today}.zip"));
        assert_eq!(suggested_name("a/b: c?", "x"), format!("ab c {today}.zip"));
        assert_eq!(suggested_name("..", "side-project"), format!("side-project {today}.zip"));
        assert_eq!(entry_name("school", Path::new("notes/plan.md")), "school/notes/plan.md");
    }
}
