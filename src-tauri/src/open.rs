//! Opening a file from a space in the user's default app, or showing it in
//! the file manager (Finder on macOS).
//!
//! Only files inside the space itself can be opened: the path gets the same
//! checks as the agent's tools (no absolute paths, no `..`, nothing under
//! `.phaethon/`, no symlink leading out), and `@space/...` paths are refused
//! outright, grant or not; `courses/...` opens a course file only where the
//! space may see it (lms/access.rs). The path is passed to the opener as one argument,
//! never through a shell. Files that could run a program are only ever shown,
//! never opened, because the agent can write files into the space.
//!
//! A whole space can be opened in the file manager too, by its id only: the
//! folder comes from [`Vault::space_dir`](crate::vault::Vault::space_dir),
//! which refuses anything that is not a real folder directly under `spaces/`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::lms::access::{self, Place, Visible};
use crate::tools;

/// Extensions whose default action runs something instead of showing it.
const RUNNABLE: &[&str] = &[
    "app", "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "ksh", "fish", "scpt", "scptd", "applescript",
    "workflow", "action", "pkg", "mpkg", "dmg", "jar", "py", "pyw", "pl", "rb", "php", "js", "jse", "vbs", "vbe", "wsf",
    "wsh", "ps1", "psm1", "bat", "cmd", "com", "exe", "msi", "scr", "lnk", "url", "webloc", "inetloc", "fileloc",
    "desktop", "appimage", "run", "bin", "prefpane", "saver", "kext", "plugin", "mobileconfig",
];

/// The real path of `path` in the space, after every check.
pub fn target(space: &Path, courses: &Visible, path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("No file was named.".into());
    }
    if matches!(tools::target(path), tools::Target::Other { .. }) {
        return Err("Only files in this space can be opened from here.".into());
    }
    // `courses/...`: a course this space may see, a part it may see (lms/access.rs).
    if let Some(clean) = tools::clean_rel(path).ok().filter(|c| access::is_courses_path(c)) {
        return match courses.place(&clean, true) {
            Ok(Place::Course { real, .. }) => Ok(real),
            _ => Err(format!("“{path}” isn’t among the courses this space can see.")),
        };
    }
    tools::resolve(space, path, true).map_err(|e| {
        if e.ends_with("does not exist") {
            format!("“{path}” isn’t in this space any more. It may have been moved or deleted.")
        } else {
            format!("“{path}” can’t be opened: only files inside this space can be opened from here.")
        }
    })
}

/// Whether opening `p` could run a program: a runnable extension, or (on
/// Unix) a file marked executable.
pub fn is_runnable(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if RUNNABLE.contains(&ext.as_str()) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(p)
            && m.is_file()
            && m.permissions().mode() & 0o111 != 0
        {
            return true;
        }
    }
    false
}

/// The command that opens `p` (or shows it, when `reveal`).
fn opener(p: &Path, reveal: bool) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("/usr/bin/open");
        if reveal {
            c.arg("-R");
        }
        c.arg(p);
        c
    }
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("explorer.exe");
        if reveal {
            c.arg(format!("/select,{}", p.display()));
        } else {
            c.arg(p);
        }
        c
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut c = Command::new("xdg-open");
        // xdg-open can't select a file, so showing it opens its folder.
        let shown = if reveal { p.parent().unwrap_or(p) } else { p };
        c.arg(shown);
        c
    }
}

/// Open `path` (relative to `space`) with the default app, or show it in the
/// file manager when `reveal`.
pub fn open(space: &Path, courses: &Visible, path: &str, reveal: bool) -> Result<(), String> {
    let full = target(space, courses, path)?;
    if !reveal && is_runnable(&full) {
        return Err("This file can run a program, so Phaethon won’t open it. Use Show in Finder to see where it is instead.".into());
    }
    launch(opener(&full, reveal)).map_err(|e| format!("The file couldn’t be opened: {e}"))
}

/// Open a space's folder (from `Vault::space_dir`) in the file manager. A
/// space id has no dots, so the folder can never be an app bundle that opening
/// would run.
pub fn show_space(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("This space’s folder isn’t there any more.".into());
    }
    launch(opener(dir, false)).map_err(|e| format!("The space’s folder couldn’t be shown: {e}"))
}

/// Show (select, never open) a file the core itself wrote, such as an export.
pub fn reveal_file(file: &Path) -> Result<(), String> {
    if !file.is_file() {
        return Err("That file isn’t there any more. It may have been moved or deleted.".into());
    }
    launch(opener(file, true)).map_err(|e| format!("The file couldn’t be shown: {e}"))
}

fn launch(mut cmd: Command) -> std::io::Result<()> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    // Reap the opener when it exits (it returns as soon as the app is asked).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn only_files_inside_the_space_can_be_opened() {
        let dir = std::env::temp_dir().join(format!("phaethon-open-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let space = dir.join("spaces/school");
        fs::create_dir_all(space.join("notes")).unwrap();
        fs::create_dir_all(dir.join("spaces/work")).unwrap();
        fs::create_dir_all(space.join(".phaethon")).unwrap();
        fs::write(space.join("notes/plan.md"), "x").unwrap();
        fs::write(space.join(".phaethon/thread.json"), "[]").unwrap();
        fs::write(dir.join("spaces/work/secret.md"), "s").unwrap();
        fs::write(dir.join("MANUAL.md"), "m").unwrap();

        let real = target(&space, &Visible::default(), "notes/plan.md").unwrap();
        assert!(real.ends_with("notes/plan.md") && real.is_file());
        assert_eq!(target(&space, &Visible::default(), " notes/plan.md ").unwrap(), real);
        assert!(target(&space, &Visible::default(), "notes").unwrap().is_dir());
        for bad in [
            "",
            "/etc/passwd",
            "../work/secret.md",
            "../../MANUAL.md",
            "notes/../../work/secret.md",
            "@work/secret.md",
            "@school/notes/plan.md",
            ".phaethon/thread.json",
            "missing.md",
        ] {
            assert!(target(&space, &Visible::default(), bad).is_err(), "{bad:?} should be refused");
            // open checks first, so nothing is ever launched for these.
            assert!(open(&space, &Visible::default(), bad, false).is_err() && open(&space, &Visible::default(), bad, true).is_err(), "{bad:?}");
        }
        assert!(target(&space, &Visible::default(), "missing.md").unwrap_err().contains("isn’t in this space"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("spaces/work/secret.md"), space.join("link.md")).unwrap();
            assert!(target(&space, &Visible::default(), "link.md").is_err(), "a symlink out of the space is refused");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn show_space_takes_only_a_space_id() {
        let dir = std::env::temp_dir().join(format!("phaethon-open-space-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let vault = crate::vault::Vault::at(&dir);
        vault.ensure_initialized().unwrap();
        fs::write(dir.join("spaces/notes.md"), "a file, not a space").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("memory"), dir.join("spaces/linked")).unwrap();
            std::os::unix::fs::symlink("/", dir.join("spaces/root")).unwrap();
            std::os::unix::fs::symlink(dir.join("spaces/school"), dir.join("spaces/alias")).unwrap();
        }
        // What the space_show command does: the id goes through space_dir, then show_space.
        for bad in ["..", "../..", "", ".", "spaces", "school/..", "school/../work", "/", "/etc", "notes.md", "linked", "root", "alias", "School", "nope", "a.app"] {
            assert!(vault.space_dir(bad).is_err(), "{bad:?} must not resolve to a folder");
        }
        assert!(vault.space_dir("school").unwrap().ends_with("spaces/school"));
        // A folder gone since it was resolved is refused before anything is launched.
        assert!(show_space(&dir.join("spaces/gone")).is_err());
        assert!(reveal_file(&dir.join("spaces/gone.zip")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn runnable_files_are_only_shown() {
        let dir = std::env::temp_dir().join(format!("phaethon-open-run-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Tool.app")).unwrap();
        for f in ["run.command", "x.sh", "notes.md", "SETUP.PY"] {
            fs::write(dir.join(f), "echo hi").unwrap();
        }
        assert!(is_runnable(&dir.join("run.command")));
        assert!(is_runnable(&dir.join("x.sh")));
        assert!(is_runnable(&dir.join("SETUP.PY")));
        assert!(is_runnable(&dir.join("Tool.app")));
        assert!(!is_runnable(&dir.join("notes.md")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.join("notes.md"), fs::Permissions::from_mode(0o755)).unwrap();
            assert!(is_runnable(&dir.join("notes.md")), "an executable file is never opened");
        }
        let err = open(&dir, &Visible::default(), "run.command", false).unwrap_err();
        assert!(err.contains("run a program"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
