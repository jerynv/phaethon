//! Reading a file for the in-app viewer: a file the agent wrote or read, an
//! attachment, a link in a reply. The same walls as opening one (open.rs) and
//! the agent's own tools: only inside the space (no absolute paths, no `..`,
//! nothing under `.phaethon/`, no symlink leading out, no `@other/...`), or
//! `courses/...` where this space may see that course and that part of it
//! (lms/access.rs), with a course's README filtered as the agent sees it.
//! Text comes back as text; supported documents and media come back as bytes,
//! each with a size cap. Classification does not promise renderer or codec
//! support; anything else is named so the viewer can offer its app.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::lms::access::{self, Place, Visible};
use crate::open;
use crate::tools;

/// The most text shown.
pub const MAX_TEXT: u64 = 1024 * 1024;
/// The largest encoded binary input supplied to an in-app renderer.
pub const MAX_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ViewKind {
    Markdown,
    Tex,
    Text,
    Pdf,
    Image,
    Docx,
    Spreadsheet,
    Slides,
    Audio,
    Video,
    Other,
}

impl ViewKind {
    fn has_bytes(self) -> bool {
        matches!(self, Self::Pdf | Self::Image | Self::Docx | Self::Spreadsheet | Self::Slides | Self::Audio | Self::Video)
    }
}

/// A file as the viewer shows it.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    /// As it was asked for, trimmed.
    pub path: String,
    pub name: String,
    pub kind: ViewKind,
    pub size: u64,
    pub media_type: String,
    /// Markdown, LaTeX and text: the contents.
    pub text: Option<String>,
    /// For code: the language its extension names (for syntax colours).
    pub language: Option<String>,
    /// Larger than the viewer shows: open it in its app instead.
    pub too_big: bool,
}

const TEXT_EXT: &[&str] = &[
    "txt", "text", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "html", "htm", "css", "scss",
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "php", "sh",
    "bash", "zsh", "fish", "sql", "r", "m", "jl", "lua", "pl", "hs", "ml", "scala", "dart", "vue", "svelte", "bib", "sty", "cls", "rst",
    "adoc", "org", "diff", "patch", "env", "gitignore", "mermaid", "mmd", "dot", "tikz",
];

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// What kind of file `real` is, and its media type, from its extension.
fn kind_of(real: &Path) -> (ViewKind, &'static str) {
    match ext_of(real).as_str() {
        "md" | "markdown" | "mdown" => (ViewKind::Markdown, "text/markdown"),
        "tex" | "latex" | "ltx" => (ViewKind::Tex, "text/x-tex"),
        "pdf" => (ViewKind::Pdf, "application/pdf"),
        "png" => (ViewKind::Image, "image/png"),
        "jpg" | "jpeg" => (ViewKind::Image, "image/jpeg"),
        "gif" => (ViewKind::Image, "image/gif"),
        "webp" => (ViewKind::Image, "image/webp"),
        "bmp" => (ViewKind::Image, "image/bmp"),
        // Shown in an <img>, where an SVG's scripts never run.
        "svg" => (ViewKind::Image, "image/svg+xml"),
        "docx" => (ViewKind::Docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => (ViewKind::Spreadsheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => (ViewKind::Slides, "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "mp3" => (ViewKind::Audio, "audio/mpeg"),
        "m4a" => (ViewKind::Audio, "audio/mp4"),
        "wav" => (ViewKind::Audio, "audio/wav"),
        "ogg" | "oga" => (ViewKind::Audio, "audio/ogg"),
        "opus" => (ViewKind::Audio, "audio/ogg; codecs=opus"),
        "flac" => (ViewKind::Audio, "audio/flac"),
        "aac" => (ViewKind::Audio, "audio/aac"),
        "mp4" | "m4v" => (ViewKind::Video, "video/mp4"),
        "webm" => (ViewKind::Video, "video/webm"),
        "ogv" => (ViewKind::Video, "video/ogg"),
        "mov" => (ViewKind::Video, "video/quicktime"),
        e if TEXT_EXT.contains(&e) => (ViewKind::Text, "text/plain"),
        _ => (ViewKind::Other, "application/octet-stream"),
    }
}

/// The syntax colours' name for a code file's language.
fn language_of(real: &Path) -> Option<String> {
    let e = ext_of(real);
    let lang = match e.as_str() {
        "js" | "mjs" | "cjs" => "javascript",
        "ts" => "typescript",
        "py" => "python",
        "rb" => "ruby",
        "rs" => "rust",
        "sh" | "bash" | "zsh" => "bash",
        "yml" => "yaml",
        "kt" => "kotlin",
        "cs" => "csharp",
        "h" => "c",
        "hpp" | "cc" => "cpp",
        "html" | "htm" | "xml" | "svg" => "markup",
        "diff" | "patch" => "diff",
        "json" | "jsonl" => "json",
        "c" | "cpp" | "css" | "go" | "java" | "jsx" | "tsx" | "sql" | "swift" | "toml" | "yaml" => e.as_str(),
        _ => return None,
    };
    Some(lang.to_string())
}

/// Where `path` in the space leads, after every wall; for a course file, the
/// course and the path inside it (its README is filtered by the parts seen).
/// A course file: the course it is in, and its path inside it.
type InCourse<'a> = Option<(&'a access::Seen, PathBuf)>;

fn locate<'a>(space: &Path, courses: &'a Visible, path: &str) -> Result<(PathBuf, InCourse<'a>), String> {
    let trimmed = path.trim();
    if let Some(clean) = tools::clean_rel(trimmed).ok().filter(|c| access::is_courses_path(c)) {
        return match courses.place(&clean, true) {
            Ok(Place::Course { seen, sub, real, .. }) if !sub.as_os_str().is_empty() => Ok((real, Some((seen, sub)))),
            Ok(_) => Err(format!("“{trimmed}” is a folder; the viewer shows files.")),
            Err(_) => Err(format!("“{trimmed}” isn’t among the courses this space can see.")),
        };
    }
    open::target(space, courses, trimmed).map(|real| (real, None))
}

/// The file at `path` in the space, ready for the viewer.
pub fn view(space: &Path, courses: &Visible, path: &str) -> Result<FileView, String> {
    let (real, course) = locate(space, courses, path)?;
    let meta = fs::metadata(&real).map_err(|_| format!("“{}” isn’t there any more.", path.trim()))?;
    if !meta.is_file() {
        return Err(format!("“{}” is a folder; the viewer shows files.", path.trim()));
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (mut kind, mut media) = kind_of(&real);
    let size = meta.len();
    let mut view = FileView { path: path.trim().to_string(), name, kind, size, media_type: media.into(), text: None, language: None, too_big: false };
    match kind {
        ViewKind::Pdf | ViewKind::Image | ViewKind::Docx | ViewKind::Spreadsheet | ViewKind::Slides | ViewKind::Audio | ViewKind::Video => view.too_big = size > MAX_BYTES,
        ViewKind::Markdown | ViewKind::Tex | ViewKind::Text | ViewKind::Other => {
            if size > MAX_TEXT {
                view.too_big = kind != ViewKind::Other;
                return Ok(view);
            }
            let bytes = fs::read(&real).map_err(|e| format!("“{}” couldn’t be read: {e}", path.trim()))?;
            // A file with no known extension is shown as text when it is text.
            let text = match String::from_utf8(bytes) {
                Ok(t) if !t.contains('\0') => t,
                _ => {
                    if kind != ViewKind::Other {
                        kind = ViewKind::Other;
                        media = "application/octet-stream";
                    }
                    view.kind = kind;
                    view.media_type = media.into();
                    return Ok(view);
                }
            };
            if kind == ViewKind::Other {
                view.kind = ViewKind::Text;
                view.media_type = "text/plain".into();
            }
            let text = match course {
                Some((seen, sub)) => access::filter_text(seen, &sub, text),
                None => text,
            };
            view.language = language_of(&real);
            view.text = Some(text);
        }
    }
    Ok(view)
}

/// An allowlisted binary viewer input, after the same space and course checks.
pub fn bytes(space: &Path, courses: &Visible, path: &str) -> Result<Vec<u8>, String> {
    let (real, _) = locate(space, courses, path)?;
    let (kind, _) = kind_of(&real);
    if !kind.has_bytes() {
        return Err("This file type is not a binary preview input.".into());
    }
    let meta = fs::metadata(&real).map_err(|_| format!("“{}” isn’t there any more.", path.trim()))?;
    if !meta.is_file() {
        return Err(format!("“{}” is a folder; the viewer shows files.", path.trim()));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("“{}” is larger than the viewer shows ({} MB at most). Open it in its app instead.", path.trim(), MAX_BYTES / 1024 / 1024));
    }
    fs::read(&real).map_err(|e| format!("“{}” couldn’t be read: {e}", path.trim()))
}

// ---- Commands ---------------------------------------------------------------

/// A file in `space` for the viewer (text inline; binary inputs use `file_bytes`).
#[tauri::command]
pub(crate) async fn file_view(state: tauri::State<'_, crate::AppState>, space: String, path: String) -> Result<FileView, String> {
    let dir = state.vault.space_dir(&space)?;
    let courses = access::visible(&state.vault, &space);
    crate::off_main(move || view(&dir, &courses, &path)).await
}

/// A supported document's or media file's bytes in `space`, for the viewer.
#[tauri::command]
pub(crate) async fn file_bytes(state: tauri::State<'_, crate::AppState>, space: String, path: String) -> Result<tauri::ipc::Response, String> {
    let dir = state.vault.space_dir(&space)?;
    let courses = access::visible(&state.vault, &space);
    crate::off_main(move || bytes(&dir, &courses, &path).map(tauri::ipc::Response::new)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::access::{Part, fixture};

    fn vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-viewer-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let school = dir.join("spaces/school");
        fs::create_dir_all(school.join("notes")).unwrap();
        fs::create_dir_all(school.join(".phaethon")).unwrap();
        fs::create_dir_all(dir.join("spaces/work")).unwrap();
        fs::write(school.join("notes/plan.md"), "# Plan\n\n$x^2$").unwrap();
        fs::write(school.join("notes/guide.tex"), "\\documentclass{article}").unwrap();
        fs::write(school.join("notes/run.py"), "print(1)").unwrap();
        fs::write(school.join("notes/README"), "plain words").unwrap();
        fs::write(school.join("notes/blob.bin"), [0u8, 159, 146, 150]).unwrap();
        fs::write(school.join("notes/fig.png"), [137u8, 80, 78, 71]).unwrap();
        fs::write(school.join("notes/paper.pdf"), b"%PDF-1.7").unwrap();
        fs::write(school.join(".phaethon/thread.json"), "[]").unwrap();
        fs::write(dir.join("spaces/work/secret.md"), "work secret").unwrap();
        fs::write(dir.join("MANUAL.md"), "manual").unwrap();
        dir
    }

    #[test]
    fn shows_each_kind_of_file_in_the_space() {
        let dir = vault("kinds");
        let space = dir.join("spaces/school");
        let none = Visible::default();
        let md = view(&space, &none, "notes/plan.md").unwrap();
        assert_eq!((md.kind, md.text.as_deref(), md.name.as_str()), (ViewKind::Markdown, Some("# Plan\n\n$x^2$"), "plan.md"));
        assert_eq!(view(&space, &none, "notes/guide.tex").unwrap().kind, ViewKind::Tex);
        let py = view(&space, &none, " notes/run.py ").unwrap();
        assert_eq!((py.kind, py.language.as_deref(), py.path.as_str()), (ViewKind::Text, Some("python"), "notes/run.py"));
        assert_eq!(view(&space, &none, "notes/README").unwrap().kind, ViewKind::Text, "text with no extension is text");
        let bin = view(&space, &none, "notes/blob.bin").unwrap();
        assert_eq!((bin.kind, bin.text), (ViewKind::Other, None));
        let png = view(&space, &none, "notes/fig.png").unwrap();
        assert_eq!((png.kind, png.media_type.as_str(), png.text), (ViewKind::Image, "image/png", None));
        assert_eq!(bytes(&space, &none, "notes/fig.png").unwrap(), [137u8, 80, 78, 71]);
        assert_eq!(bytes(&space, &none, "notes/paper.pdf").unwrap(), b"%PDF-1.7");
        assert!(bytes(&space, &none, "notes/plan.md").is_err(), "text comes back as text only");
        assert!(view(&space, &none, "notes").is_err(), "a folder isn't a file");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn office_and_media_are_bounded_binary_inputs_not_text() {
        let dir = vault("rich-inputs");
        let space = dir.join("spaces/school");
        let none = Visible::default();
        // Deliberately valid UTF-8: these formats must not enter text sniffing.
        let payload = b"renderer owns decoding, not the host";
        for (name, kind, media) in [
            ("notes/paper.DOCX", ViewKind::Docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("notes/data.xlsx", ViewKind::Spreadsheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ("notes/lecture.pptx", ViewKind::Slides, "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ("notes/lecture.mp3", ViewKind::Audio, "audio/mpeg"),
            ("notes/lecture.m4a", ViewKind::Audio, "audio/mp4"),
            ("notes/lecture.wav", ViewKind::Audio, "audio/wav"),
            ("notes/lecture.ogg", ViewKind::Audio, "audio/ogg"),
            ("notes/lecture.oga", ViewKind::Audio, "audio/ogg"),
            ("notes/lecture.opus", ViewKind::Audio, "audio/ogg; codecs=opus"),
            ("notes/lecture.flac", ViewKind::Audio, "audio/flac"),
            ("notes/lecture.aac", ViewKind::Audio, "audio/aac"),
            ("notes/lecture.mp4", ViewKind::Video, "video/mp4"),
            ("notes/lecture.m4v", ViewKind::Video, "video/mp4"),
            ("notes/lecture.webm", ViewKind::Video, "video/webm"),
            ("notes/lecture.ogv", ViewKind::Video, "video/ogg"),
            ("notes/lecture.mov", ViewKind::Video, "video/quicktime"),
        ] {
            fs::write(space.join(name), payload).unwrap();
            let v = view(&space, &none, name).unwrap();
            assert_eq!((v.kind, v.media_type.as_str(), v.size), (kind, media, payload.len() as u64), "{name}");
            assert!(v.text.is_none() && v.language.is_none() && !v.too_big, "{name}");
            assert_eq!(bytes(&space, &none, name).unwrap(), payload, "{name}");
            assert_eq!(serde_json::to_value(&v).unwrap()["kind"], format!("{kind:?}").to_lowercase(), "serialized viewer contract");
        }
        for ext in ["docx", "xlsx", "pptx", "mp3", "mp4"] {
            let name = format!("big.{ext}");
            fs::File::create(space.join(&name)).unwrap().set_len(MAX_BYTES + 1).unwrap();
            let v = view(&space, &none, &name).unwrap();
            assert!(v.too_big && v.text.is_none(), "{name} is classified without loading");
            assert!(bytes(&space, &none, &name).unwrap_err().contains("larger than the viewer shows"), "{name}");
        }
        // Legacy Office, macro-enabled packages and arbitrary archives are not
        // made eligible merely because more binary renderers were added.
        for ext in ["doc", "xls", "ppt", "docm", "xlsm", "pptm", "zip", "bin", "exe"] {
            let name = format!("unsupported.{ext}");
            fs::write(space.join(&name), [0u8, 255]).unwrap();
            assert_eq!(view(&space, &none, &name).unwrap().kind, ViewKind::Other, "{name}");
            assert!(bytes(&space, &none, &name).is_err(), "{name} is not an allowlisted byte input");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn binary_previews_keep_space_and_course_part_boundaries() {
        let dir = vault("rich-walls");
        let space = dir.join("spaces/school");
        fs::write(dir.join("spaces/work/private.docx"), b"private document").unwrap();
        fs::write(space.join(".phaethon/private.docx"), b"private state").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("spaces/work/private.docx"), space.join("notes/escape.docx")).unwrap();
        for path in ["../work/private.docx", ".phaethon/private.docx", "@work/private.docx", "notes/escape.docx"] {
            assert!(view(&space, &Visible::default(), path).is_err(), "{path}");
            assert!(bytes(&space, &Visible::default(), path).is_err(), "{path}");
        }
        for course in ["Calculus", "Physics"] {
            fs::create_dir_all(dir.join("courses").join(course).join("files")).unwrap();
            fs::write(dir.join("courses").join(course).join("files/lecture.docx"), b"course document").unwrap();
        }
        let syllabus_only = fixture(&dir, "school", &[("Calculus", &[Part::Syllabus])]);
        let path = "courses/Calculus/files/lecture.docx";
        assert!(view(&space, &syllabus_only, path).is_err(), "files require their own part grant");
        assert!(bytes(&space, &syllabus_only, path).is_err());
        let files = fixture(&dir, "school", &[("Calculus", &[Part::Files])]);
        assert_eq!(view(&space, &files, path).unwrap().kind, ViewKind::Docx);
        assert_eq!(bytes(&space, &files, path).unwrap(), b"course document");
        for hidden in ["courses/Physics/files/lecture.docx", "courses/Calculus/../Physics/files/lecture.docx"] {
            assert!(view(&space, &files, hidden).is_err(), "{hidden}");
            assert!(bytes(&space, &files, hidden).is_err(), "{hidden}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("spaces/work/private.docx"), dir.join("courses/Calculus/files/escape.docx")).unwrap();
            assert!(bytes(&space, &files, "courses/Calculus/files/escape.docx").is_err());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_reads_outside_the_space() {
        let dir = vault("walls");
        let space = dir.join("spaces/school");
        let none = Visible::default();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("spaces/work/secret.md"), space.join("notes/link.md")).unwrap();
            std::os::unix::fs::symlink(dir.join("spaces/work"), space.join("workdir")).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", space.join("hosts.txt")).unwrap();
        }
        for bad in [
            "",
            "/etc/hosts",
            "/etc/passwd",
            "../work/secret.md",
            "../../MANUAL.md",
            "notes/../../work/secret.md",
            "@work/secret.md",
            "@school/notes/plan.md",
            ".phaethon/thread.json",
            "notes/link.md",
            "workdir/secret.md",
            "hosts.txt",
            "courses/Calculus II/syllabus.md",
            "missing.md",
        ] {
            let v = view(&space, &none, bad);
            assert!(v.is_err(), "{bad:?} must be refused: {v:?}");
            assert!(bytes(&space, &none, bad).is_err(), "{bad:?}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn courses_only_where_the_space_may_see_them() {
        let dir = std::env::temp_dir().join(format!("phaethon-viewer-courses-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for (c, files) in [("Calculus", &["syllabus.md", "grades.md", "README.md"][..]), ("Physics", &["syllabus.md"][..])] {
            fs::create_dir_all(dir.join("courses").join(c)).unwrap();
            for f in files {
                fs::write(dir.join("courses").join(c).join(f), format!("{c} {f}\n\n**Grades**: 91%\n")).unwrap();
            }
        }
        let seen = fixture(&dir, "school", &[("Calculus", &[Part::Overview, Part::Syllabus])]);
        let space = dir.join("spaces/school");
        assert_eq!(view(&space, &seen, "courses/Calculus/syllabus.md").unwrap().kind, ViewKind::Markdown);
        assert!(view(&space, &seen, "courses/Calculus/grades.md").is_err(), "a part it may not see");
        assert!(view(&space, &seen, "courses/Physics/syllabus.md").is_err(), "a course it may not see");
        assert!(view(&space, &seen, "courses/Calculus/../Physics/syllabus.md").is_err());
        assert!(view(&space, &seen, "courses/Calculus").is_err(), "a folder");
        let readme = view(&space, &seen, "courses/Calculus/README.md").unwrap().text.unwrap();
        assert!(!readme.contains("91%"), "the README without what the space may not see: {readme}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn large_files_say_so_instead_of_loading() {
        let dir = vault("large");
        let space = dir.join("spaces/school");
        let f = fs::File::create(space.join("big.txt")).unwrap();
        f.set_len(MAX_TEXT + 1).unwrap();
        let v = view(&space, &Visible::default(), "big.txt").unwrap();
        assert!(v.too_big && v.text.is_none());
        let f = fs::File::create(space.join("big.pdf")).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert!(view(&space, &Visible::default(), "big.pdf").unwrap().too_big);
        assert!(bytes(&space, &Visible::default(), "big.pdf").unwrap_err().contains("larger than the viewer shows"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
