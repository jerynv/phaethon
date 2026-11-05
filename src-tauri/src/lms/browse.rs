//! A read-only map of one imported course for the course browser
//! (`lms_course_content`): its overview files, pages, modules, assignments and
//! files, each as a space-relative path (`courses/<folder>/...`) that the
//! existing file viewer opens. Built from lms.json and the folder on disk, never
//! the network; every path is checked through [`access::Visible::place`], so a
//! space is shown only the courses and parts it may see, and only plain files
//! inside the course's folder.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use super::access::{self, Place, Seen, Visible};
use super::import::anchor;
use super::store::COURSES_DIR;
use crate::vault::Vault;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowseKind {
    Overview,
    Page,
    Module,
    Assignment,
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    /// Relative to the space: `courses/<folder>/...`.
    pub path: String,
    pub title: String,
    pub kind: BrowseKind,
    /// Size on disk, for files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// A heading in `path` (a module in modules.md, an assignment in assignments.md).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    /// Zero-based H2 position, independent of rendered math or inline markup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_index: Option<usize>,
    /// The text copy beside a document (`<path>.md`), when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseBrowse {
    pub entries: Vec<BrowseEntry>,
    pub truncated: bool,
    /// When the course was last imported, ms since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<u64>,
}

/// Most entries listed for one course.
const MAX_ENTRIES: usize = 5000;
/// Most of a page read for its title.
const TITLE_BYTES: u64 = 4096;

/// The course `course` (`<connection>/<course id>`) as `space` may see it.
pub fn course_content(vault: &Vault, space: &str, course: &str) -> Result<CourseBrowse, String> {
    vault.space_dir(space)?;
    let visible = access::visible(vault, space);
    browse(&visible, course)
}

/// [`course_content`] for an already-built [`Visible`].
pub fn browse(visible: &Visible, course: &str) -> Result<CourseBrowse, String> {
    let hidden = || "That course isn’t among the courses this space can see.".to_string();
    let seen = visible.courses.iter().find(|c| c.key == course).ok_or_else(hidden)?;
    let dir = visible.dir_of(seen).ok_or("This course’s folder isn’t there any more; import it again.")?;
    let folder = seen.folder().to_string();
    let mut b = Builder { visible, seen, folder: &folder, entries: vec![], truncated: false };

    for (rel, title) in [("README.md", "Overview"), ("syllabus.md", "Syllabus"), ("announcements.md", "Announcements"), ("grades.md", "Grades"), ("links.md", "Links")] {
        b.push(rel, title.into(), BrowseKind::Overview, None);
    }
    for (file, label, kind) in [("assignments.md", "Assignments", BrowseKind::Assignment), ("modules.md", "Modules", BrowseKind::Module)] {
        if b.push(file, label.into(), kind, None) {
            if std::fs::metadata(dir.join(file)).is_ok_and(|m| m.len() > 4 * 1024 * 1024) { b.truncated = true; }
            for (index, (title, anc)) in headings(&dir.join(file)).into_iter().enumerate() {
                if b.push(file, title, kind, Some(anc)) {
                    b.entries.last_mut().unwrap().heading_index = Some(index);
                }
            }
        }
    }
    let mut pages: Vec<(String, String)> = visible
        .walk(seen, &dir, &dir.join("pages"), MAX_ENTRIES)
        .into_iter()
        .filter(|(rel, _)| rel.extension().is_some_and(|e| e == "md"))
        .map(|(rel, real)| {
            let title = first_heading(&real).unwrap_or_else(|| rel.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
            (slash(&rel), title)
        })
        .collect();
    pages.sort();
    for (rel, title) in pages {
        b.push(&rel, title, BrowseKind::Page, None);
    }
    let mut docs: Vec<&str> = seen.state.files.values().map(|r| r.path.as_str()).chain(seen.state.links.values().filter_map(|r| r.path.as_deref())).collect();
    docs.sort();
    docs.dedup();
    for rel in docs {
        let title = Path::new(rel).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| rel.to_string());
        b.push(rel, title, BrowseKind::File, None);
    }
    Ok(CourseBrowse { entries: b.entries, truncated: b.truncated, updated: seen.state.last_sync })
}

struct Builder<'a> {
    visible: &'a Visible,
    seen: &'a Seen,
    folder: &'a str,
    entries: Vec<BrowseEntry>,
    truncated: bool,
}

impl Builder<'_> {
    /// The space-relative path of `rel` in this course when the space may open it as a plain file.
    fn checked(&self, rel: &str) -> Option<(String, u64)> {
        let path = format!("{COURSES_DIR}/{}/{rel}", self.folder);
        let clean = crate::tools::clean_rel(&path).ok()?;
        match self.visible.place(&clean, true).ok()? {
            Place::Course { seen, real, sub, .. } if seen.key == self.seen.key && !sub.as_os_str().is_empty() => {
                let m = std::fs::symlink_metadata(&real).ok()?;
                m.is_file().then_some((path, m.len()))
            }
            _ => None,
        }
    }

    /// Add `rel` if the space may see it; true when added.
    fn push(&mut self, rel: &str, title: String, kind: BrowseKind, anchor: Option<String>) -> bool {
        if self.entries.len() >= MAX_ENTRIES {
            self.truncated = true;
            return false;
        }
        let Some((path, len)) = self.checked(rel) else { return false };
        let text = (kind == BrowseKind::File).then(|| self.checked(&format!("{rel}.md")).map(|(p, _)| p)).flatten();
        let bytes = (kind == BrowseKind::File).then_some(len);
        self.entries.push(BrowseEntry { path, title, kind, bytes, anchor, heading_index: None, text });
        true
    }
}

fn slash(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

fn read_head(path: &Path, max: u64) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let longer = file.metadata().ok()?.len() > max;
    let mut bytes = vec![];
    file.take(max).read_to_end(&mut bytes).ok()?;
    if longer { bytes.truncate(bytes.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1)); }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A Markdown file's first `# ` heading.
fn first_heading(path: &Path) -> Option<String> {
    read_head(path, TITLE_BYTES)?.lines().find_map(|l| l.strip_prefix("# ")).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// modules.md's `## ` headings with the anchors a Markdown viewer gives them
/// (the `# ` title counts toward repeats, as on GitHub).
fn headings(path: &Path) -> Vec<(String, String)> {
    let Some(text) = read_head(path, 4 * 1024 * 1024) else { return vec![] };
    let mut used = HashMap::new();
    let mut out = vec![];
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(ch) = trimmed.chars().next().filter(|c| *c == '`' || *c == '~') {
            let count = trimmed.chars().take_while(|c| *c == ch).count();
            if count >= 3 {
                match fence {
                    None => fence = Some((ch, count)),
                    Some((old, n)) if old == ch && count >= n => fence = None,
                    _ => {}
                }
                continue;
            }
        }
        if fence.is_some() { continue; }
        if let Some(t) = line.strip_prefix("## ") {
            let t = t.trim();
            out.push((t.to_string(), anchor(t, &mut used)));
        } else if let Some(t) = line.strip_prefix("# ") {
            anchor(t.trim(), &mut used);
        }
    }
    out
}

#[cfg(test)]
mod heading_tests {
    use super::*;
    fn sample(name: &str, text: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("phaethon-browse-{name}-{}.md", std::process::id()));
        std::fs::write(&path, text).unwrap();
        path
    }
    #[test]
    fn module_navigation_ignores_fenced_examples_and_keeps_duplicate_ordinals() {
        let path = sample("fences", "# Modules\n## Algebra `$x$`\n```markdown\n## Not a module\n```\n### A detail\n## Algebra `$x$`\n");
        let rows = headings(&path);
        assert_eq!(rows, vec![("Algebra `$x$`".into(), "algebra-x".into()), ("Algebra `$x$`".into(), "algebra-x-1".into())]);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn a_utf8_boundary_after_the_title_does_not_hide_it() {
        let path = sample("utf8", &format!("# Name\n{}", "é".repeat(5000)));
        assert_eq!(first_heading(&path), Some("Name".into()));
        std::fs::remove_file(path).unwrap();
    }
}
