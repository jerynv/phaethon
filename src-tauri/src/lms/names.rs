//! Safe file names for what a course site sends, and writing them without
//! ever leaving `<space>/courses/`.
//!
//! Names come from the site (a file called `../../.ssh/config`, a folder
//! called `/etc`): each part is cleaned on its own, so the result is always a
//! plain relative path. Writes go through [`dir_in`], which refuses a symlink
//! anywhere on the way, and land by rename from a temporary file, so a
//! half-downloaded file never takes the place of a good one.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Longest name kept for one path part, in characters.
const SEGMENT_MAX: usize = 100;

/// One path part: no separators, control characters or characters Windows
/// refuses; no leading dots (no `..`, no hidden files); never empty.
pub fn segment(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_start_matches(['.', ' ', '-']).trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > SEGMENT_MAX {
        let ext = Path::new(&s)
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .filter(|e| e.chars().count() <= 10)
            .map(|e| format!(".{e}"))
            .unwrap_or_default();
        let keep = SEGMENT_MAX - ext.chars().count();
        s = s.chars().take(keep).collect::<String>().trim_end_matches(['.', ' ']).to_string() + &ext;
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    if s.is_empty() { "untitled".into() } else { s }
}

/// A site folder path ("Lectures/Week 1") and a file name as a relative path,
/// each part cleaned; empty, `.` and `..` parts are dropped.
pub fn rel_path(folder: Option<&str>, name: &str) -> PathBuf {
    let mut p = PathBuf::new();
    for part in folder.unwrap_or("").split(['/', '\\']) {
        let part = part.trim();
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        p.push(segment(part));
    }
    p.push(segment(name));
    p
}

/// Paths already used in one folder tree, compared without case (macOS and
/// Windows folders ignore it), so two names never land on one file.
#[derive(Default)]
pub struct Taken(HashSet<String>);

impl Taken {
    fn key(p: &Path) -> String {
        p.to_string_lossy().to_lowercase()
    }

    pub fn reserve(&mut self, p: &Path) {
        self.0.insert(Self::key(p));
    }

    /// `p`, or `name (2).ext`, `name (3).ext`... when it is taken.
    pub fn claim(&mut self, p: &Path) -> PathBuf {
        if self.0.insert(Self::key(p)) {
            return p.to_path_buf();
        }
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        for n in 2.. {
            let candidate = p.with_file_name(format!("{stem} ({n}){ext}"));
            if self.0.insert(Self::key(&candidate)) {
                return candidate;
            }
        }
        unreachable!()
    }
}

/// True when `rel` is a plain relative path (only normal parts).
pub fn is_plain(rel: &Path) -> bool {
    rel.components().next().is_some() && rel.components().all(|c| matches!(c, Component::Normal(_)))
}

/// `root/rel` as a real directory, created part by part. Refuses if any part
/// on the way (from `root` down) is a symlink or not a directory, so nothing
/// is ever written through a link to somewhere else.
pub fn dir_in(root: &Path, rel: &Path) -> io::Result<PathBuf> {
    let refuse = |p: &Path| io::Error::other(format!("{} is not a plain folder", p.display()));
    let meta = fs::symlink_metadata(root)?;
    if !meta.is_dir() {
        return Err(refuse(root));
    }
    if !rel.as_os_str().is_empty() && !is_plain(rel) {
        return Err(refuse(rel));
    }
    let mut at = root.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(refuse(&at)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(&at)?,
            Err(e) => return Err(e),
        }
    }
    Ok(at)
}

/// A temporary file beside where `rel` will go under `root` (created new,
/// never opened through an existing name), and the final path.
pub fn temp_for(root: &Path, rel: &Path) -> io::Result<(fs::File, PathBuf, PathBuf)> {
    if !is_plain(rel) {
        return Err(io::Error::other("not a plain path"));
    }
    let dir = dir_in(root, rel.parent().unwrap_or(Path::new("")))?;
    let name = rel.file_name().ok_or_else(|| io::Error::other("no file name"))?;
    let dest = dir.join(name);
    for n in 0u32.. {
        let tmp = dir.join(format!(".{}.{}-{n}.part", std::process::id(), nanos()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => return Ok((f, tmp, dest)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && n < 100 => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Move a finished temporary file into place. A symlink at `dest` is replaced
/// (rename never follows it); a folder there is refused.
pub fn finish(tmp: &Path, dest: &Path) -> io::Result<()> {
    if fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
        let _ = fs::remove_file(tmp);
        return Err(io::Error::other(format!("{} is a folder", dest.display())));
    }
    fs::rename(tmp, dest).inspect_err(|_| {
        let _ = fs::remove_file(tmp);
    })
}

/// Write `bytes` to `root/rel` (temporary file, then rename).
pub fn write(root: &Path, rel: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let (mut f, tmp, dest) = temp_for(root, rel)?;
    if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(f);
    finish(&tmp, &dest)
}

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// A relative path as a Markdown link target: forward slashes, spaces and
/// parentheses escaped so the link survives.
pub fn link_target(rel: &Path) -> String {
    let joined = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    joined.replace('%', "%25").replace(' ', "%20").replace('(', "%28").replace(')', "%29").replace('<', "%3C").replace('>', "%3E")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_names_become_plain_parts() {
        assert_eq!(segment("../../.ssh/config"), "ssh-config");
        assert_eq!(segment(".."), "untitled");
        assert_eq!(segment("..."), "untitled");
        assert_eq!(segment("/etc/passwd"), "etc-passwd");
        assert_eq!(segment("a\u{0}b\nc\u{7f}.pdf"), "abc.pdf");
        assert_eq!(segment(".hidden"), "hidden");
        assert_eq!(segment("CON.txt"), "_CON.txt");
        assert_eq!(segment("C:\\Windows"), "C--Windows");
        let long = format!("{}.pdf", "x".repeat(300));
        assert_eq!(segment(&long).chars().count(), SEGMENT_MAX);
        assert!(segment(&long).ends_with(".pdf"));
        assert_eq!(rel_path(Some("../Lectures//./Week 1/.."), "../notes.pdf"), PathBuf::from("Lectures/Week 1/notes.pdf"));
        assert_eq!(rel_path(Some("/abs/olute"), "x"), PathBuf::from("abs/olute/x"));
        assert!(is_plain(&rel_path(Some("/"), "/")));
    }

    #[test]
    fn collisions_are_numbered_without_case() {
        let mut t = Taken::default();
        assert_eq!(t.claim(Path::new("files/a.pdf")), PathBuf::from("files/a.pdf"));
        assert_eq!(t.claim(Path::new("files/A.pdf")), PathBuf::from("files/A (2).pdf"));
        assert_eq!(t.claim(Path::new("files/a.pdf")), PathBuf::from("files/a (3).pdf"));
    }

    #[test]
    fn writes_never_follow_a_symlink() {
        let root = std::env::temp_dir().join(format!("phaethon-names-{}", std::process::id()));
        let outside = root.with_extension("outside");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        write(&root, Path::new("a/b.txt"), b"one").unwrap();
        assert_eq!(fs::read(root.join("a/b.txt")).unwrap(), b"one");
        write(&root, Path::new("a/b.txt"), b"two").unwrap();
        assert_eq!(fs::read(root.join("a/b.txt")).unwrap(), b"two");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(write(&root, Path::new("link/x.txt"), b"no").is_err());
            assert!(!outside.join("x.txt").exists());
            // A symlink where the file goes is replaced, not written through.
            std::os::unix::fs::symlink(outside.join("target.txt"), root.join("f.txt")).unwrap();
            write(&root, Path::new("f.txt"), b"safe").unwrap();
            assert!(!outside.join("target.txt").exists());
            assert!(!fs::symlink_metadata(root.join("f.txt")).unwrap().file_type().is_symlink());
        }
        assert!(write(&root, Path::new("../escape.txt"), b"no").is_err());
        assert!(write(&root, Path::new("/tmp/escape.txt"), b"no").is_err());
        let leftovers: Vec<_> = fs::read_dir(root.join("a")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".part")).collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
