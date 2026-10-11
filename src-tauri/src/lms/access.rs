//! Which imported courses each space can see, and which parts of them.
//!
//! Course sites and their imported courses belong to the vault (`<vault>/courses/`,
//! `<vault>/.phaethon/lms.json`). A space sees a course only where
//! `<vault>/.phaethon/course-access.json` allows it, part by part:
//!
//! ```json
//! { "school": { "canvas-iu-instructure-com/2411651": ["overview", "syllabus", "files"] } }
//! ```
//!
//! Inside a space the courses it may see appear as `courses/<folder>/...`, and
//! everything that reads course material in a space (the agent's file tools,
//! study sources, the prompt's course index, the plan, grades) goes through
//! [`Visible`], so what a space may see is decided here and nowhere else.
//! The file lives under `.phaethon/`, which the agent's tools never reach: only
//! the person, through the UI (or a text editor), changes it. Like grants.json
//! it is user-editable, so every entry is validated on every read.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::store::{self, COURSES_DIR, CourseState};
use super::names;
use crate::tools::{self, STATE_DIR};
use crate::vault::Vault;

pub const FILE: &str = "course-access.json";
/// Largest course-access.json read.
const MAX_BYTES: u64 = 1024 * 1024;

/// Serialises read-modify-write of course-access.json within this process.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// A part of a course a space may be allowed to see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Part {
    /// README.md, and what's due (in the index and the plan).
    Overview,
    Syllabus,
    Assignments,
    Announcements,
    /// files/, readings/, pages/, links.md, modules.md and anything else in the folder.
    Files,
    /// grades.md and the numbers behind it.
    Grades,
}

impl Part {
    pub const ALL: [Part; 6] = [Part::Overview, Part::Syllabus, Part::Assignments, Part::Announcements, Part::Files, Part::Grades];

    pub fn parse(s: &str) -> Option<Part> {
        Part::ALL.into_iter().find(|p| p.name() == s)
    }

    pub fn name(self) -> &'static str {
        match self {
            Part::Overview => "overview",
            Part::Syllabus => "syllabus",
            Part::Assignments => "assignments",
            Part::Announcements => "announcements",
            Part::Files => "files",
            Part::Grades => "grades",
        }
    }
}

/// The part a path inside a course folder belongs to, by its first component,
/// compared without case (macOS and Windows folders ignore it) and without the
/// trailing dots and spaces Windows drops. Anything not named here is "files".
pub fn part_of(sub: &Path) -> Part {
    let Some(first) = sub.components().next() else { return Part::Overview };
    let name = first.as_os_str().to_string_lossy().to_lowercase();
    let name = name.trim_end_matches(['.', ' ']);
    let only = sub.components().count() == 1;
    match name {
        "readme.md" if only => Part::Overview,
        "syllabus.md" => Part::Syllabus,
        "assignments.md" => Part::Assignments,
        "announcements.md" => Part::Announcements,
        "grades.md" => Part::Grades,
        _ => Part::Files,
    }
}

/// The key a course is known by in course-access.json and grades.json:
/// `<connection id>/<course id>`.
pub fn course_key(connection: &str, course_id: &str) -> String {
    store::grade_key(connection, course_id)
}

fn valid_key(key: &str) -> bool {
    let Some((conn, course)) = key.split_once('/') else { return false };
    let plain = |s: &str, extra: &[char]| !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || extra.contains(&c));
    plain(conn, &[]) && plain(course, &['_', '.', ':'])
}

/// Space id → course key → the parts it may see.
pub type AccessMap = BTreeMap<String, BTreeMap<String, BTreeSet<Part>>>;

/// Every valid entry in the file, and a note for each one that was ignored.
#[derive(Debug, Default)]
pub struct Loaded {
    pub map: AccessMap,
    pub problems: Vec<String>,
}

fn file(vault: &Vault) -> PathBuf {
    vault.root().join(STATE_DIR).join(FILE)
}

/// The file's text: `None` when there is none. Never through a link, never huge.
fn read_raw(vault: &Vault) -> Result<Option<String>, String> {
    let path = file(vault);
    match fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() && m.len() <= MAX_BYTES => {}
        Ok(_) => return Err("course-access.json isn’t a plain file Phaethon can read".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("course-access.json couldn’t be read: {e}")),
    }
    fs::read_to_string(&path).map(Some).map_err(|e| format!("course-access.json couldn’t be read: {e}"))
}

/// Read and validate course-access.json. A missing file means no space sees any course.
pub fn load(vault: &Vault) -> Loaded {
    let raw = match read_raw(vault) {
        Ok(Some(s)) => s,
        Ok(None) => return Loaded::default(),
        Err(e) => return Loaded { map: AccessMap::new(), problems: vec![format!("{e}, so no space can see any course.")] },
    };
    let Ok(Value::Object(top)) = serde_json::from_str::<Value>(&raw) else {
        return Loaded {
            map: AccessMap::new(),
            problems: vec!["course-access.json has a typing mistake, so no space can see any course. Fix it in a text editor or delete it.".into()],
        };
    };
    let mut out = Loaded::default();
    for (space, courses) in &top {
        if vault.space_dir(space).is_err() {
            out.problems.push(format!("“{space}” is skipped: there’s no space by that name."));
            continue;
        }
        let Value::Object(courses) = courses else {
            out.problems.push(format!("“{space}” is skipped: it isn’t laid out as Phaethon expects."));
            continue;
        };
        let mut seen = BTreeMap::new();
        for (key, parts) in courses {
            if !valid_key(key) {
                out.problems.push(format!("In “{space}”, “{key}” is skipped: it isn’t a course Phaethon knows."));
                continue;
            }
            let Value::Array(parts) = parts else {
                out.problems.push(format!("In “{space}”, “{key}” is skipped: its parts should be a list."));
                continue;
            };
            let mut set = BTreeSet::new();
            for p in parts {
                match p.as_str().and_then(Part::parse) {
                    Some(p) => {
                        set.insert(p);
                    }
                    None => out.problems.push(format!("In “{space}”, “{key}”: {p} isn’t a part of a course, so it’s ignored.")),
                }
            }
            if !set.is_empty() {
                seen.insert(key.clone(), set);
            }
        }
        if !seen.is_empty() {
            out.map.insert(space.clone(), seen);
        }
    }
    out
}

/// The file as a JSON object, for editing. Refuses to touch a file it cannot
/// parse rather than overwrite what the person wrote.
fn read_doc(vault: &Vault) -> Result<Map<String, Value>, String> {
    match read_raw(vault)? {
        None => Ok(Map::new()),
        Some(s) => match serde_json::from_str::<Value>(&s) {
            Ok(Value::Object(o)) => Ok(o),
            _ => Err("course-access.json has a typing mistake, so Phaethon won’t change it. Fix it in a text editor or delete it, then try again.".into()),
        },
    }
}

fn write_doc(vault: &Vault, doc: &Map<String, Value>) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    // Temporary file and rename, never through a link (names::write refuses one on the way).
    names::write(vault.root(), &Path::new(STATE_DIR).join(FILE), &json).map_err(|e| format!("Who can see your courses couldn’t be saved: {e}"))
}

fn parts_value(parts: &BTreeSet<Part>) -> Value {
    Value::Array(Part::ALL.iter().filter(|p| parts.contains(p)).map(|p| Value::String(p.name().into())).collect())
}

/// Let `space` see `parts` of `course` (an empty list: nothing). Other entries
/// in the file, even ones Phaethon doesn't understand, are kept as they are.
pub fn set(vault: &Vault, space: &str, course: &str, parts: &[Part]) -> Result<(), String> {
    vault.space_dir(space).map_err(|_| format!("There’s no space called “{space}”."))?;
    if !valid_key(course) {
        return Err("That isn’t a course Phaethon knows.".into());
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(vault)?;
    let parts: BTreeSet<Part> = parts.iter().copied().collect();
    let entry = doc.entry(space.to_string()).or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(courses) = entry else {
        return Err(format!("course-access.json has something Phaethon doesn’t understand for “{space}”, so it won’t change it. Fix it or delete it, then try again."));
    };
    if parts.is_empty() {
        courses.remove(course);
    } else {
        courses.insert(course.to_string(), parts_value(&parts));
    }
    if courses.is_empty() {
        doc.remove(space);
    }
    write_doc(vault, &doc)
}

/// Let each of `spaces` see every part of each of `courses` (an import, and
/// the move to the vault). What a space could already see is only added to.
pub fn allow_all(vault: &Vault, spaces: &[String], courses: &[String]) -> Result<(), String> {
    if spaces.is_empty() || courses.is_empty() {
        return Ok(());
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(vault)?;
    let all: BTreeSet<Part> = Part::ALL.into_iter().collect();
    for space in spaces {
        vault.space_dir(space).map_err(|_| format!("There’s no space called “{space}”."))?;
        let entry = doc.entry(space.clone()).or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(map) = entry else {
            return Err(format!("course-access.json has something Phaethon doesn’t understand for “{space}”, so it won’t change it. Fix it or delete it, then try again."));
        };
        for c in courses.iter().filter(|c| valid_key(c)) {
            map.insert(c.clone(), parts_value(&all));
        }
    }
    write_doc(vault, &doc)
}

/// Remove every space's access to `courses` (the courses are gone).
pub fn forget(vault: &Vault, courses: &[String]) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(vault)?;
    let mut changed = false;
    for v in doc.values_mut() {
        if let Value::Object(map) = v {
            for c in courses {
                changed |= map.remove(c).is_some();
            }
        }
    }
    doc.retain(|_, v| !matches!(v, Value::Object(m) if m.is_empty()));
    if changed { write_doc(vault, &doc) } else { Ok(()) }
}

// ---- What a space sees ----------------------------------------------------------------

/// One imported course a space may see, with the parts it may see.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub key: String,
    pub connection: String,
    pub course_id: String,
    pub state: CourseState,
    pub parts: BTreeSet<Part>,
}

impl Seen {
    pub fn can(&self, p: Part) -> bool {
        self.parts.contains(&p)
    }

    pub fn folder(&self) -> &str {
        &self.state.folder
    }

    /// Whether the space may see when things are due.
    pub fn sees_due(&self) -> bool {
        self.can(Part::Overview) || self.can(Part::Assignments)
    }
}

/// The courses one space may see. Built fresh for each use, so a change in
/// Settings applies to the very next read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Visible {
    /// The vault's root (courses are under `<vault>/courses/`).
    vault_root: PathBuf,
    pub courses: Vec<Seen>,
}

/// What `space` may see: the vault's imported courses that course-access.json
/// lets it see, sorted by name. Nothing when either file can't be read.
pub fn visible(vault: &Vault, space: &str) -> Visible {
    let mut out = Visible { vault_root: vault.root().to_path_buf(), courses: vec![] };
    let Some(mine) = load(vault).map.remove(space) else { return out };
    let Ok(st) = store::load(vault.root()) else { return out };
    for conn in &st.connections {
        for (cid, state) in &conn.courses {
            let key = course_key(&conn.id, cid);
            if let Some(parts) = mine.get(&key).filter(|p| !p.is_empty()) {
                out.courses.push(Seen { key, connection: conn.id.clone(), course_id: cid.clone(), state: state.clone(), parts: parts.clone() });
            }
        }
    }
    out.courses.sort_by(|a, b| a.state.name.to_lowercase().cmp(&b.state.name.to_lowercase()).then(a.key.cmp(&b.key)));
    out
}

/// Whether a (lexically clean) path in a space names its courses: the first
/// part is `courses`, in any case, since macOS folders ignore case.
pub fn is_courses_path(clean: &Path) -> bool {
    clean.components().next().is_some_and(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(COURSES_DIR))
}

/// Where a `courses/...` path in a space leads.
#[derive(Debug)]
pub enum Place<'a> {
    /// `courses` itself: the list of courses the space may see.
    Root,
    /// Inside one course's folder. `sub` is the path inside it as written
    /// (empty for the folder itself); `real` the file or folder on disk.
    Course { seen: &'a Seen, dir: PathBuf, sub: PathBuf, real: PathBuf },
}

impl Visible {
    pub fn is_empty(&self) -> bool {
        self.courses.is_empty()
    }

    pub fn get(&self, folder: &str) -> Option<&Seen> {
        self.courses.iter().find(|c| c.state.folder == folder)
    }

    /// A course's folder on disk, canonical, when it is still a plain folder.
    pub fn dir_of(&self, seen: &Seen) -> Option<PathBuf> {
        store::course_dir(&self.vault_root, &seen.state.folder)?.canonicalize().ok()
    }

    /// Resolve a lexically clean `courses/...` path (see [`tools::clean_rel`]).
    /// Refused, with the same words whether or not the course exists, unless
    /// the space may see that course and that part of it; the path must stay
    /// inside the course's folder (symlinks included), and the part is checked
    /// both as written and as it lands on disk.
    pub fn place(&self, clean: &Path, must_exist: bool) -> Result<Place<'_>, String> {
        let shown = clean.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
        let hidden = || format!("\"{shown}\" isn’t among the courses this space can see");
        let mut parts = clean.components();
        if !parts.next().is_some_and(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(COURSES_DIR)) {
            return Err(hidden());
        }
        let Some(folder) = parts.next() else { return Ok(Place::Root) };
        let folder = folder.as_os_str().to_string_lossy();
        let seen = self.get(&folder).ok_or_else(hidden)?;
        let dir = self.dir_of(seen).ok_or_else(|| format!("\"{shown}\" isn’t there any more; the course may need importing again"))?;
        let sub: PathBuf = parts.collect();
        if sub.as_os_str().is_empty() {
            return Ok(Place::Course { seen, real: dir.clone(), dir, sub });
        }
        if !seen.can(part_of(&sub)) {
            return Err(hidden());
        }
        let real = tools::resolve(&dir, &sub.to_string_lossy(), must_exist).map_err(|e| {
            if e.ends_with("does not exist") { format!("\"{shown}\" does not exist") } else { hidden() }
        })?;
        let landed = real.strip_prefix(&dir).map_err(|_| hidden())?;
        if !landed.as_os_str().is_empty() && !seen.can(part_of(landed)) {
            return Err(hidden());
        }
        Ok(Place::Course { seen, dir, sub, real })
    }

    /// The entries of a course folder (or a folder in it) the space may see:
    /// names, folders ending in "/", no hidden files, sorted.
    pub fn list_course(&self, seen: &Seen, sub: &Path, real: &Path) -> Result<Vec<String>, String> {
        let rd = fs::read_dir(real).map_err(|e| format!("cannot list it: {e}"))?;
        let mut names: Vec<String> = rd
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !seen.can(part_of(&sub.join(&name))) {
                    return None;
                }
                let is_dir = fs::symlink_metadata(e.path()).is_ok_and(|m| m.is_dir());
                Some(if is_dir { format!("{name}/") } else { name })
            })
            .collect();
        names.sort();
        Ok(names)
    }

    /// Every file under `start` in a course folder that the space may see, as
    /// (path inside the course, real path), without following a link, hidden
    /// files left out. At most `max`.
    pub fn walk(&self, seen: &Seen, dir: &Path, start: &Path, max: usize) -> Vec<(PathBuf, PathBuf)> {
        let mut out = vec![];
        let mut stack = vec![start.to_path_buf()];
        while let Some(p) = stack.pop() {
            if out.len() >= max {
                break;
            }
            let Ok(meta) = p.symlink_metadata() else { continue };
            let rel = p.strip_prefix(dir).unwrap_or(Path::new("")).to_path_buf();
            if !rel.as_os_str().is_empty() && (rel.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) || !seen.can(part_of(&rel))) {
                continue;
            }
            if meta.is_dir() {
                if let Ok(rd) = fs::read_dir(&p) {
                    let mut kids: Vec<_> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
                    kids.sort();
                    stack.extend(kids.into_iter().rev());
                }
            } else if meta.is_file() && !rel.as_os_str().is_empty() {
                out.push((rel, p));
            }
        }
        out
    }

    /// Folders the `claude` CLI backend may read: only courses this space sees
    /// in full, since the CLI can't be shown part of a folder. As (label, real path).
    pub fn cli_dirs(&self) -> Vec<(String, PathBuf)> {
        self.courses
            .iter()
            .filter(|c| Part::ALL.iter().all(|p| c.can(*p)))
            .filter_map(|c| Some((format!("{COURSES_DIR}/{}", c.state.folder), self.dir_of(c)?)))
            .collect()
    }
}

/// A course file's text as the space may see it. Only README.md mixes parts:
/// without "grades" its grades line and link go; without "files" its lists of
/// files and readings go; links to the other parts go when they're not allowed.
pub fn filter_text(seen: &Seen, sub: &Path, text: String) -> String {
    let is_readme = sub.components().count() == 1 && sub.to_string_lossy().eq_ignore_ascii_case("README.md");
    if !is_readme || Part::ALL.iter().all(|p| seen.can(*p)) {
        return text;
    }
    let mut out: Vec<&str> = vec![];
    let mut skipping = false;
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ").or_else(|| line.strip_prefix("### ")) {
            let h = h.trim().to_lowercase();
            skipping = !seen.can(Part::Files) && (h.starts_with("textbooks") || matches!(h.as_str(), "pages" | "files" | "readings"));
            if skipping {
                continue;
            }
        } else if line.starts_with("# ") {
            skipping = false;
        }
        if skipping {
            continue;
        }
        if line.starts_with("**Grades**") && !seen.can(Part::Grades) {
            continue;
        }
        if line.starts_with("- Grades:") && !seen.can(Part::Grades) {
            continue;
        }
        // "- [syllabus.md](syllabus.md): the syllabus" and the like.
        if let Some(target) = line.strip_prefix("- [").and_then(|r| r.split_once("](")).map(|(_, r)| r.split(')').next().unwrap_or(""))
            && !target.contains("://")
            && !target.contains('#')
            && !seen.can(part_of(Path::new(target)))
        {
            continue;
        }
        out.push(line);
    }
    // Drop blank lines left doubled by what was taken out.
    let mut s = String::new();
    let mut blank = false;
    for l in out {
        if l.trim().is_empty() {
            if blank {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        s.push_str(l);
        s.push('\n');
    }
    s
}

// ---- For the UI -----------------------------------------------------------------------

/// One imported course, as Settings shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseInfo {
    pub key: String,
    pub connection: String,
    pub course_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    /// "courses/<folder>", as spaces see it.
    pub folder: String,
}

/// What `course_access_get` gives the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    /// Every space in the vault, sorted.
    pub spaces: Vec<String>,
    /// Every imported course in the vault, by name.
    pub courses: Vec<CourseInfo>,
    /// Space → course key → parts, only for imported courses; for one space
    /// when one was asked about.
    pub access: BTreeMap<String, BTreeMap<String, Vec<Part>>>,
    /// Plain-language notes on entries of the file that were ignored.
    pub problems: Vec<String>,
}

pub fn all_courses(vault: &Vault) -> Result<Vec<CourseInfo>, String> {
    let st = store::load(vault.root())?;
    let mut out: Vec<CourseInfo> = st
        .connections
        .iter()
        .flat_map(|conn| {
            conn.courses.iter().map(|(cid, c)| CourseInfo {
                key: course_key(&conn.id, cid),
                connection: conn.id.clone(),
                course_id: cid.clone(),
                name: c.name.clone(),
                code: c.code.clone(),
                term: c.term.clone(),
                folder: format!("{COURSES_DIR}/{}", c.folder),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.key.cmp(&b.key)));
    Ok(out)
}

pub fn spaces(vault: &Vault) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(vault.root().join("spaces"))
        .map(|rd| rd.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).filter(|n| vault.space_dir(n).is_ok()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

pub fn view(vault: &Vault, space: Option<&str>) -> Result<AccessView, String> {
    if let Some(s) = space {
        vault.space_dir(s)?;
    }
    let courses = all_courses(vault)?;
    let known: BTreeSet<&str> = courses.iter().map(|c| c.key.as_str()).collect();
    let loaded = load(vault);
    let access = loaded
        .map
        .into_iter()
        .filter(|(s, _)| space.is_none_or(|want| want == s))
        .map(|(s, m)| (s, m.into_iter().filter(|(k, _)| known.contains(k.as_str())).map(|(k, p)| (k, p.into_iter().collect())).collect()))
        .collect();
    Ok(AccessView { spaces: spaces(vault), courses, access, problems: loaded.problems })
}

/// For tests elsewhere: a vault at `root` whose space `space` exists and sees
/// each course folder in `courses` (under `<root>/courses/`, made by the
/// caller) with the parts given. Course ids are "1", "2"... on "canvas-x".
#[cfg(test)]
pub(crate) fn fixture(root: &Path, space: &str, courses: &[(&str, &[Part])]) -> Visible {
    use super::store::{Conn, Store};
    fs::create_dir_all(root.join("spaces").join(space)).unwrap();
    let mut conn = Conn { id: "canvas-x".into(), kind: super::Kind::Canvas, address: "https://x".into(), school_name: None, last_sync: None, signed_in: true, courses: BTreeMap::new() };
    for (i, (folder, _)) in courses.iter().enumerate() {
        conn.courses.insert((i + 1).to_string(), CourseState { name: folder.to_string(), folder: folder.to_string(), ..Default::default() });
    }
    store::save(root, &Store { connections: vec![conn] }).unwrap();
    let vault = Vault::at(root);
    for (i, (_, parts)) in courses.iter().enumerate() {
        set(&vault, space, &course_key("canvas-x", &(i + 1).to_string()), parts).unwrap();
    }
    visible(&vault, space)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::lms::Kind;
    use crate::lms::store::{Conn, Store};
    use serde_json::json;

    /// A vault with spaces school, work and home; one Canvas connection with
    /// two imported courses in `<vault>/courses/`.
    pub(crate) fn vault(tag: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("phaethon-access-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for s in ["school", "work", "home"] {
            fs::create_dir_all(dir.join("spaces").join(s)).unwrap();
        }
        let calc = dir.join("courses/Calculus II");
        for d in ["files/Notes", "readings", "pages"] {
            fs::create_dir_all(calc.join(d)).unwrap();
        }
        let put = |rel: &str, body: &str| fs::write(calc.join(rel), body).unwrap();
        put(
            "README.md",
            "# Calculus II\n\nImported from x.\n\n**Grades**: 91% (A-) so far. Every grade, by group: [grades.md](grades.md).\n\n## Coming up\n\n- Tue Oct 14 2026, 11:59 PM: [PS 4](assignments.md#ps-4)\n\n## Textbooks and readings\n\n- **Textbook**: [Stewart](readings/stewart.pdf)\n\n## In this folder\n\n- [syllabus.md](syllabus.md): the syllabus\n- [assignments.md](assignments.md): 1 assignment by due date\n- [grades.md](grades.md): your grades, by group\n\n### Files\n\n- [files/Notes/series.pdf](files/Notes/series.pdf)\n",
        );
        put("syllabus.md", "Syllabus: integrals and series. Office hours Tuesday.\n");
        put("assignments.md", "# Assignments\n\n## PS 4\n\nDue Oct 14. Series convergence.\n");
        put("announcements.md", "Quiz moved to Friday.\n");
        put("grades.md", "# Grades: Calculus II\n\n**Current grade: 91% (A-)**\n");
        put("files/Notes/series.pdf.md", "Ratio test: series converge when the limit is below one.\n");
        put("readings/stewart.pdf.md", "Stewart chapter 11 on series.\n");
        put("pages/week 1.md", "Week 1: review integrals.\n");
        put("modules.md", "Module 1: series.\n");
        fs::create_dir_all(dir.join("courses/Linear Algebra")).unwrap();
        fs::write(dir.join("courses/Linear Algebra/syllabus.md"), "Linear algebra syllabus: eigenvalues.\n").unwrap();
        let mut conn = Conn { id: "canvas-x".into(), kind: Kind::Canvas, address: "https://x".into(), school_name: None, last_sync: None, signed_in: false, courses: BTreeMap::new() };
        conn.courses.insert(
            "1".into(),
            CourseState {
                name: "Calculus II".into(),
                folder: "Calculus II".into(),
                due: vec![store::Due { title: "PS 4".into(), due: "2026-10-14T23:59:00Z".into(), anchor: "ps-4".into() }],
                ..Default::default()
            },
        );
        conn.courses.insert("2".into(), CourseState { name: "Linear Algebra".into(), folder: "Linear Algebra".into(), ..Default::default() });
        store::save(&dir, &Store { connections: vec![conn] }).unwrap();
        let v = Vault::at(&dir);
        (dir, v)
    }

    pub(crate) fn write_file(dir: &Path, v: Value) {
        fs::create_dir_all(dir.join(".phaethon")).unwrap();
        fs::write(dir.join(".phaethon").join(FILE), v.to_string()).unwrap();
    }

    #[test]
    fn parts_of_a_course_folder() {
        let p = |s: &str| part_of(Path::new(s));
        assert_eq!(p("README.md"), Part::Overview);
        assert_eq!(p("readme.MD"), Part::Overview);
        assert_eq!(p("syllabus.md"), Part::Syllabus);
        assert_eq!(p("Syllabus.md."), Part::Syllabus);
        assert_eq!(p("assignments.md"), Part::Assignments);
        assert_eq!(p("announcements.md"), Part::Announcements);
        assert_eq!(p("grades.md"), Part::Grades);
        assert_eq!(p("GRADES.MD "), Part::Grades);
        assert_eq!(p("grades.md/x"), Part::Grades);
        for f in ["files/a.pdf", "files/a.pdf.md", "readings/x.pdf", "pages/w.md", "links.md", "modules.md", "notes.txt", "README.md/x", "files/grades.md"] {
            assert_eq!(p(f), Part::Files, "{f}");
        }
    }

    #[test]
    fn the_file_is_validated_and_unknown_entries_are_kept() {
        let (dir, v) = vault("load");
        write_file(
            &dir,
            json!({
                "school": {"canvas-x/1": ["overview", "grades", "bogus", "grades"], "canvas-x/../2": ["files"], "bad key": ["files"], "canvas-x/2": "files"},
                "nope": {"canvas-x/1": ["files"]},
                "../work": {"canvas-x/1": ["files"]},
                "work": ["files"],
                "home": {"canvas-x/2": []},
            }),
        );
        let l = load(&v);
        assert_eq!(l.map.len(), 1, "{:?}", l.map);
        assert_eq!(l.map["school"]["canvas-x/1"], BTreeSet::from([Part::Overview, Part::Grades]));
        assert_eq!(l.problems.len(), 7, "{:#?}", l.problems);
        // Changing one entry keeps the others as they were.
        set(&v, "work", "canvas-x/2", &[Part::Syllabus]).unwrap_err(); // "work" isn't laid out as expected
        set(&v, "home", "canvas-x/2", &[Part::Syllabus, Part::Syllabus]).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(dir.join(".phaethon").join(FILE)).unwrap()).unwrap();
        assert_eq!(raw["home"]["canvas-x/2"], json!(["syllabus"]));
        assert_eq!(raw["nope"], json!({"canvas-x/1": ["files"]}), "unknown entries are the person's");
        set(&v, "home", "canvas-x/2", &[]).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(dir.join(".phaethon").join(FILE)).unwrap()).unwrap();
        assert!(raw.get("home").is_none());
        for (space, key) in [("nope", "canvas-x/1"), ("../school", "canvas-x/1"), ("school", "x"), ("school", "a/b/c"), ("school", "canvas-x/1 2")] {
            assert!(set(&v, space, key, &[Part::Files]).is_err(), "{space} {key}");
        }
        // A broken file is never overwritten, and gives nothing.
        fs::write(dir.join(".phaethon").join(FILE), "{ not json").unwrap();
        assert!(load(&v).map.is_empty() && load(&v).problems.len() == 1);
        assert!(set(&v, "school", "canvas-x/1", &[Part::Files]).is_err());
        assert!(allow_all(&v, &["school".into()], &["canvas-x/1".into()]).is_err());
        assert_eq!(fs::read_to_string(dir.join(".phaethon").join(FILE)).unwrap(), "{ not json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_never_read_or_written_through_a_link() {
        let (dir, v) = vault("link");
        let outside = dir.join("outside.json");
        fs::write(&outside, json!({"school": {"canvas-x/1": ["files"]}}).to_string()).unwrap();
        fs::create_dir_all(dir.join(".phaethon")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".phaethon").join(FILE)).unwrap();
        assert!(load(&v).map.is_empty());
        assert!(visible(&v, "school").is_empty());
        assert!(set(&v, "school", "canvas-x/1", &[Part::Files]).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), json!({"school": {"canvas-x/1": ["files"]}}).to_string());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn allow_all_adds_and_forget_removes() {
        let (dir, v) = vault("all");
        set(&v, "school", "canvas-x/2", &[Part::Syllabus]).unwrap();
        allow_all(&v, &["school".into(), "work".into()], &["canvas-x/1".into()]).unwrap();
        let l = load(&v);
        assert_eq!(l.map["school"]["canvas-x/1"].len(), 6);
        assert_eq!(l.map["school"]["canvas-x/2"], BTreeSet::from([Part::Syllabus]));
        assert_eq!(l.map["work"]["canvas-x/1"].len(), 6);
        assert!(allow_all(&v, &["nope".into()], &["canvas-x/1".into()]).is_err());
        forget(&v, &["canvas-x/1".into()]).unwrap();
        let l = load(&v);
        assert!(!l.map.contains_key("work"));
        assert_eq!(l.map["school"].len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_space_sees_only_what_it_was_allowed() {
        let (dir, v) = vault("visible");
        assert!(visible(&v, "school").is_empty(), "nothing by default");
        set(&v, "school", "canvas-x/1", &[Part::Overview, Part::Files]).unwrap();
        set(&v, "school", "canvas-x/9", &[Part::Files]).unwrap(); // not imported: nothing
        let vis = visible(&v, "school");
        assert_eq!(vis.courses.len(), 1);
        assert_eq!(vis.courses[0].folder(), "Calculus II");
        assert!(visible(&v, "work").is_empty());
        let ok = |p: &str| vis.place(Path::new(p), true).map(|_| ());
        ok("courses").unwrap();
        ok("courses/Calculus II").unwrap();
        ok("Courses/Calculus II/README.md").unwrap();
        ok("courses/Calculus II/files/Notes/series.pdf.md").unwrap();
        ok("courses/Calculus II/readings/stewart.pdf.md").unwrap();
        ok("courses/Calculus II/pages/week 1.md").unwrap();
        for bad in [
            "courses/Calculus II/syllabus.md",
            "courses/Calculus II/grades.md",
            "courses/Calculus II/GRADES.md",
            "courses/Calculus II/assignments.md",
            "courses/Linear Algebra/syllabus.md",
            "courses/Linear Algebra",
            "courses/calculus ii/README.md",
            "courses/Calculus%20II/README.md",
            "courses/Calculus II/missing.md",
        ] {
            assert!(ok(bad).is_err(), "{bad}");
        }
        // The refusal reads the same whether or not the course exists.
        assert_eq!(ok("courses/Linear Algebra").unwrap_err(), "\"courses/Linear Algebra\" isn’t among the courses this space can see");
        assert_eq!(ok("courses/Nope").unwrap_err(), "\"courses/Nope\" isn’t among the courses this space can see");
        let seen = &vis.courses[0];
        let calc = vis.dir_of(seen).unwrap();
        let listed = vis.list_course(seen, Path::new(""), &calc).unwrap();
        assert_eq!(listed, ["README.md", "files/", "modules.md", "pages/", "readings/"]);
        let walked: Vec<String> = vis.walk(seen, &calc, &calc, 100).into_iter().map(|(r, _)| r.to_string_lossy().into_owned()).collect();
        assert!(walked.contains(&"README.md".to_string()) && !walked.iter().any(|w| w.contains("grades") || w.contains("syllabus")), "{walked:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_reach_a_part_or_place_not_allowed() {
        let (dir, v) = vault("links");
        set(&v, "school", "canvas-x/1", &[Part::Files]).unwrap();
        let calc = dir.join("courses/Calculus II");
        std::os::unix::fs::symlink(calc.join("grades.md"), calc.join("files/g.md")).unwrap();
        std::os::unix::fs::symlink(dir.join("courses/Linear Algebra"), calc.join("files/la")).unwrap();
        std::os::unix::fs::symlink(dir.join("spaces/work"), calc.join("files/work")).unwrap();
        let vis = visible(&v, "school");
        for bad in ["courses/Calculus II/files/g.md", "courses/Calculus II/files/la/syllabus.md", "courses/Calculus II/files/work"] {
            assert!(vis.place(Path::new(bad), true).is_err(), "{bad}");
        }
        let seen = &vis.courses[0];
        let real = vis.dir_of(seen).unwrap();
        assert!(vis.walk(seen, &real, &real, 100).iter().all(|(r, _)| !r.ends_with("g.md")));
        // A course folder that is itself a link is not a course folder.
        fs::rename(&calc, dir.join("calc-real")).unwrap();
        std::os::unix::fs::symlink(dir.join("calc-real"), &calc).unwrap();
        assert!(visible(&v, "school").place(Path::new("courses/Calculus II/files"), true).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_readme_shows_only_allowed_parts() {
        let (dir, v) = vault("readme");
        set(&v, "school", "canvas-x/1", &[Part::Overview, Part::Syllabus]).unwrap();
        let vis = visible(&v, "school");
        let text = fs::read_to_string(dir.join("courses/Calculus II/README.md")).unwrap();
        let shown = filter_text(&vis.courses[0], Path::new("README.md"), text.clone());
        assert!(shown.contains("## Coming up") && shown.contains("PS 4") && shown.contains("[syllabus.md](syllabus.md)"), "{shown}");
        for gone in ["**Grades**", "91%", "grades.md", "Textbooks", "Stewart", "### Files", "series.pdf", "[assignments.md](assignments.md)"] {
            assert!(!shown.contains(gone), "{gone} in {shown}");
        }
        assert!(!shown.contains("\n\n\n"));
        // Everything allowed: unchanged; other files are never filtered.
        set(&v, "school", "canvas-x/1", &Part::ALL).unwrap();
        let vis = visible(&v, "school");
        assert_eq!(filter_text(&vis.courses[0], Path::new("README.md"), text.clone()), text);
        assert_eq!(filter_text(&vis.courses[0], Path::new("files/README.md"), "**Grades**".into()), "**Grades**");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_view_for_settings() {
        let (dir, v) = vault("view");
        set(&v, "work", "canvas-x/2", &[Part::Syllabus]).unwrap();
        allow_all(&v, &["school".into()], &["canvas-x/1".into()]).unwrap();
        let all = view(&v, None).unwrap();
        assert_eq!(all.spaces, ["home", "school", "work"]);
        assert_eq!(all.courses.iter().map(|c| c.folder.as_str()).collect::<Vec<_>>(), ["courses/Calculus II", "courses/Linear Algebra"]);
        assert_eq!(all.access.len(), 2);
        let one = view(&v, Some("work")).unwrap();
        assert_eq!(serde_json::to_value(&one.access).unwrap(), json!({"work": {"canvas-x/2": ["syllabus"]}}));
        assert!(view(&v, Some("nope")).is_err());
        let c = serde_json::to_value(&one.courses[0]).unwrap();
        assert_eq!(c, json!({"key": "canvas-x/1", "connection": "canvas-x", "courseId": "1", "name": "Calculus II", "folder": "courses/Calculus II"}));
        fs::remove_dir_all(&dir).unwrap();
    }
}
