//! Phaethon's own file tools, confined to one space folder.
//!
//! Every path the model names is relative to the space root. It is checked
//! lexically (no absolute paths, no `..`, nothing under `.phaethon/`) and then
//! against the real filesystem, so a symlink cannot lead outside the space.
//!
//! The read tools can also address another space as `@<space>/<path>`, but
//! only where a read-only grant covers that path (see grants.rs); the same
//! checks then run against the other space's root and the granted folder.
//! `write_file` never accepts an `@` path.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use crate::grants::{self, Grant};
use crate::lms::access::{self, Place, Visible};
use crate::vault::Vault;

/// Largest file `read_file` returns, in bytes.
const MAX_READ: u64 = 256 * 1024;
const MAX_LIST: usize = 500;
const MAX_HITS: usize = 200;
/// Files `search_files` skips because they are too big to be notes.
const MAX_SEARCH_FILE: u64 = 2 * 1024 * 1024;
/// Characters of a request_access reason kept for the user.
const MAX_REASON: usize = 500;

/// Folder inside each space that holds Phaethon's own state.
pub const STATE_DIR: &str = ".phaethon";

/// What the loop needs to know about a tool before running it.
pub enum Access {
    /// Runs without asking.
    Read,
    /// Shown to the user first; runs only if they allow it.
    Write,
    /// Asks the user for read access to part of another space.
    Ask,
}

pub fn access(name: &str) -> Access {
    match name {
        "write_file" => Access::Write,
        "request_access" => Access::Ask,
        _ => Access::Read,
    }
}

/// Tool definitions sent to the model. Kept in a fixed order so the prompt
/// prefix (and its cache) stays stable across requests.
pub fn definitions() -> Value {
    let path = json!({"type": "string", "description": "Path relative to the space root, e.g. \"notes/today.md\", or \"@<space>/<path>\" for a granted part of another space, e.g. \"@work/calendar/oct.md\"."});
    json!([
        {
            "name": "list_files",
            "description": "List the files and folders in a folder of this space. Folders end with \"/\". A path like \"@work/calendar\" lists a folder of another space, if this space has been granted read access to it.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Folder relative to the space root. Omit or use \"\" for the root. \"@<space>/<folder>\" for a granted folder of another space."}},
                "additionalProperties": false
            }
        },
        {
            "name": "read_file",
            "description": "Read a text file in this space, or with \"@<space>/<path>\" a file in a granted part of another space.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {"path": path},
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "search_files",
            "description": "Find lines containing some text (case-insensitive) in the text files of this space. Returns path:line: text. With path \"@<space>/<folder>\" it searches a granted folder of another space instead.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to look for."},
                    "path": {"type": "string", "description": "Folder to search, relative to the space root. Omit for the whole space. \"@<space>/<folder>\" for a granted folder of another space."}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "write_file",
            "description": "Create or replace a text file in this space with the given contents. The user is asked to approve every write first, and may decline. Only this space can be written: \"@<space>/...\" paths are always refused.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the space root, e.g. \"notes/today.md\"."},
                    "contents": {"type": "string", "description": "The complete new contents of the file."}
                },
                "required": ["path", "contents"],
                "additionalProperties": false
            }
        },
        {
            "name": "request_access",
            "description": "Ask the user to let this space read a folder or file of another space. Nothing in another space can be read without this. The user sees your reason and answers: allow once (this reply only), allow always, or deny. Access is read-only. Ask for the narrowest folder or file that does the job, and only when the user's request needs it. Once granted, read it with paths starting \"@<space>/<path>\".",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "space": {"type": "string", "description": "Name of the other space, e.g. \"work\"."},
                    "path": {"type": "string", "description": "Folder or file inside that space, relative to its root, e.g. \"calendar\"."},
                    "reason": {"type": "string", "description": "One short sentence for the user on why you need it."}
                },
                "required": ["space", "path", "reason"],
                "additionalProperties": false
            }
        },
        {
            "name": "app_guide",
            "description": "Where everything is in Phaethon, the app the user is talking to you in: spaces and their menus, adding files and folders, attaching files, the views, keyboard shortcuts and every section of Settings, by the names shown in the app. Call it before telling the user where something is or how to change a setting.",
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "study_attempt",
            "description": "Find completed quiz attempts in this space. Call with no path to list them, then call with an attempt path from that list to read the answers and results. Read the quiz itself with read_file using the quiz path in the attempt. This tool cannot read other hidden app state or another space.",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "A quiz attempt path returned by this tool. Omit to list completed attempts."}},
                "additionalProperties": false
            }
        }
    ])
}

/// A tool call's input, checked against its schema. With eager input streaming
/// the API does not validate inputs, so this is the only check.
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    List { path: String },
    Read { path: String },
    Search { query: String, path: String },
    Write { path: String, contents: String },
    RequestAccess { space: String, path: String, reason: String },
    /// Where things are in the app (app_guide.rs).
    Guide,
    StudyAttempt { path: String },
}

pub fn parse_call(name: &str, input: &Value) -> Result<Call, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "input must be a JSON object".to_string())?;
    let allowed: &[&str] = match name {
        "list_files" => &["path"],
        "read_file" => &["path"],
        "search_files" => &["query", "path"],
        "write_file" => &["path", "contents"],
        "request_access" => &["space", "path", "reason"],
        "app_guide" => &[],
        "study_attempt" => &["path"],
        _ => return Err(format!("there is no tool named {name}")),
    };
    if let Some(k) = obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!("unexpected field \"{k}\""));
    }
    let opt = |k: &str| -> Result<String, String> {
        match obj.get(k) {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) => Ok(s.clone()),
            Some(_) => Err(format!("\"{k}\" must be a string")),
        }
    };
    let req = |k: &str| -> Result<String, String> {
        match obj.get(k) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(format!("\"{k}\" is required and must be a string")),
        }
    };
    Ok(match name {
        "list_files" => Call::List { path: opt("path")? },
        "read_file" => Call::Read { path: req("path")? },
        "search_files" => Call::Search {
            query: req("query")?,
            path: opt("path")?,
        },
        "request_access" => Call::RequestAccess {
            space: req("space")?,
            path: req("path")?,
            reason: req("reason")?.chars().take(MAX_REASON).collect(),
        },
        "app_guide" => Call::Guide,
        "study_attempt" => Call::StudyAttempt { path: opt("path")? },
        _ => {
            let path = req("path")?;
            if let Target::Other { space, .. } = target(&path) {
                return Err(format!(
                    "write_file can only write in this space; \"{path}\" is in the {space} space, and other spaces can never be written"
                ));
            }
            Call::Write {
                path,
                contents: req("contents")?,
            }
        }
    })
}

/// Where a path points: this space, or `@<space>/<rest>` in another one.
/// (A file in this space whose name starts with `@` is reached as `./@name`.)
#[derive(Debug, PartialEq)]
pub enum Target<'a> {
    Local(&'a str),
    Other { space: &'a str, rel: &'a str },
}

pub fn target(path: &str) -> Target<'_> {
    match path.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((space, rel)) => Target::Other { space, rel },
            None => Target::Other { space: rest, rel: "" },
        },
        None => Target::Local(path),
    }
}

/// Whether a read tool call addresses another space.
pub fn is_cross(call: &Call) -> bool {
    match call {
        Call::List { path } | Call::Read { path } | Call::Search { path, .. } => {
            matches!(target(path), Target::Other { .. })
        }
        _ => false,
    }
}

/// Short present-tense description for the UI, e.g. "Reading file notes.md".
/// Reads in another space name it ("Reading work/calendar/oct.md"), so
/// cross-space access is always visible in the conversation.
pub fn label(call: &Call) -> String {
    let shown = |p: &str| if p.is_empty() { "the space".to_string() } else { p.to_string() };
    let other = |p: &str| match target(p) {
        Target::Other { space, rel } if rel.trim_end_matches('/').is_empty() => Some(space.to_string()),
        Target::Other { space, rel } => Some(format!("{space}/{}", rel.trim_end_matches('/'))),
        Target::Local(_) => None,
    };
    match call {
        Call::List { path } => match other(path) {
            Some(o) => format!("Listing {o}"),
            None => format!("Listing {}", shown(path)),
        },
        Call::Read { path } => match other(path) {
            Some(o) => format!("Reading {o}"),
            None => format!("Reading file {path}"),
        },
        Call::Search { query, path } => match other(path) {
            Some(o) => format!("Searching {o} for \u{201c}{query}\u{201d}"),
            None => format!("Searching files for \u{201c}{query}\u{201d}"),
        },
        Call::Write { path, .. } => format!("Writing file {path}"),
        Call::RequestAccess { space, path, .. } => format!(
            "Asking for read access to {}/{}",
            space.trim_start_matches('@'),
            path.trim_end_matches('/')
        ),
        Call::Guide => "Looking up where things are in Phaethon".into(),
        Call::StudyAttempt { path } if path.is_empty() => "Finding completed quizzes".into(),
        Call::StudyAttempt { .. } => "Reading a completed quiz".into(),
    }
}

/// What a tool call may reach: its own space, plus whatever `grants` let it
/// read elsewhere in the vault. Only grants *to* `space_id` are ever used.
#[derive(Clone)]
pub struct Ctx {
    pub space: PathBuf,
    pub space_id: String,
    pub vault: Vault,
    pub grants: Vec<Grant>,
    /// The courses this space may see, as `courses/<folder>/...` (see lms/access.rs).
    pub courses: Visible,
}

/// Run a tool with `@space/path` support. `Err` is a message for the model.
pub fn run_in(ctx: &Ctx, call: &Call) -> Result<String, String> {
    // `@<this space>/x` is just `x`.
    let split = |path: &str| -> (Option<String>, String) {
        match target(path) {
            Target::Other { space, rel } if space != ctx.space_id => (Some(space.to_string()), rel.to_string()),
            Target::Other { rel, .. } => (None, rel.to_string()),
            Target::Local(p) => (None, p.to_string()),
        }
    };
    match call {
        Call::List { path } => match split(path) {
            (Some(space), rel) => list_at(&resolve_other(ctx, &space, &rel)?.0, path),
            (None, rel) => list_here(ctx, &rel),
        },
        Call::Read { path } => match split(path) {
            (Some(space), rel) => read_at(&resolve_other(ctx, &space, &rel)?.0, path),
            (None, rel) => read_here(ctx, &rel),
        },
        Call::Search { query, path } => match split(path) {
            (Some(space), rel) => {
                let (start, root) = resolve_other(ctx, &space, &rel)?;
                search_at(&root, start, query, &format!("@{space}/"))
            }
            (None, rel) => search_here(ctx, query, &rel),
        },
        Call::Write { path, contents } => match target(path) {
            Target::Other { .. } => Err("write_file can only write in this space; other spaces can never be written".into()),
            Target::Local(p) => write(&ctx.space, p, contents),
        },
        Call::RequestAccess { .. } => Err("request_access is answered by the user, not run as a file tool".into()),
        Call::Guide => Ok(crate::app_guide::guide()),
        Call::StudyAttempt { path } => study_attempt(&ctx.space, path),
    }
}

/// Resolve `rel` in another space through a grant. Returns the real path and
/// the other space's real root. Refused unless a grant covers the path; then
/// the usual escape checks run against that space, and the result must also
/// stay inside the granted folder, so a symlink inside it cannot reach the
/// rest of that space.
pub fn resolve_other(ctx: &Ctx, space: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let shown = format!("@{space}/{rel}");
    let dir = ctx
        .vault
        .space_dir(space)
        .map_err(|_| format!("there is no space called \"{space}\""))?;
    let clean = clean_rel(rel)
        .map_err(|_| format!("\"{shown}\" must be a path inside the {space} space, like \"@{space}/notes/today.md\""))?;
    let grant = ctx
        .grants
        .iter()
        .find(|g| g.to == ctx.space_id && g.from == space && grants::covers(&g.path, &clean))
        .ok_or_else(|| format!("\"{shown}\" is in the {space} space; ask for access with request_access first"))?;
    let granted = resolve(&dir, &grant.path, true)
        .map_err(|_| format!("the granted path \"@{space}/{}\" no longer exists", grant.path))?;
    let real = resolve(&dir, &clean.to_string_lossy(), true)
        .map_err(|e| e.replace("this space", &format!("the {space} space")))?;
    if !real.starts_with(&granted) {
        return Err(format!("\"{shown}\" leads outside the part of the {space} space you have access to"));
    }
    let root = dir
        .canonicalize()
        .map_err(|e| format!("space folder unavailable: {e}"))?;
    Ok((real, root))
}

/// Run a tool in this space only (no `@space/` paths). `Err` is a message for
/// the model (sent back with `is_error`).
pub fn run(space: &Path, call: &Call) -> Result<String, String> {
    match call {
        Call::List { path } => list(space, path),
        Call::Read { path } => read(space, path),
        Call::Search { query, path } => search(space, query, path),
        Call::Write { path, contents } => write(space, path, contents),
        Call::RequestAccess { .. } => Err("request_access is answered by the user, not run as a file tool".into()),
        Call::Guide => Ok(crate::app_guide::guide()),
        Call::StudyAttempt { path } => study_attempt(space, path),
    }
}

fn study_attempt(space: &Path, path: &str) -> Result<String, String> {
    if path.is_empty() {
        let mut attempts = crate::study::attempts(space);
        attempts.sort_by_key(|a| std::cmp::Reverse(a.taken));
        let list: Vec<_> = attempts.into_iter().take(100).map(|a| json!({
            "path": a.path, "quiz": a.quiz, "taken": a.taken, "score": a.score
        })).collect();
        return serde_json::to_string(&list).map_err(|e| e.to_string());
    }
    let attempt = crate::study::load_attempt(space, path)?;
    serde_json::to_string(&attempt).map_err(|e| e.to_string())
}

/// The lexical check every path gets: relative, no `..`, not under `.phaethon/`.
/// Returns the path without `.` parts (empty for the root).
pub fn clean_rel(rel: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(format!("\"{rel}\" must be a path inside this space, like \"notes/today.md\"")),
        }
    }
    if clean
        .components()
        .next()
        .is_some_and(|c| c.as_os_str() == STATE_DIR)
    {
        return Err(format!("\"{rel}\" is Phaethon's own state and cannot be used by tools"));
    }
    Ok(clean)
}

/// Resolve `rel` inside `space`. `must_exist` false allows a path whose final
/// parts do not exist yet (for writes); the deepest existing ancestor is still
/// checked, so a symlinked folder cannot redirect a new file outside the space.
pub fn resolve(space: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    let root = space
        .canonicalize()
        .map_err(|e| format!("space folder unavailable: {e}"))?;
    let clean = clean_rel(rel)?;
    let full = root.join(&clean);
    let mut existing = full.as_path();
    while !existing.exists() {
        if must_exist {
            return Err(format!("\"{rel}\" does not exist"));
        }
        existing = existing.parent().unwrap_or(&root);
    }
    let real = existing
        .canonicalize()
        .map_err(|e| format!("cannot open \"{rel}\": {e}"))?;
    if !real.starts_with(&root) {
        return Err(format!("\"{rel}\" leads outside this space"));
    }
    // Rebuild from the checked ancestor so no unchecked symlink is followed.
    // (Joining an empty remainder would add a trailing slash and break files.)
    match full.strip_prefix(existing) {
        Ok(rest) if !rest.as_os_str().is_empty() => Ok(real.join(rest)),
        _ => Ok(real),
    }
}

// ---- Courses ----------------------------------------------------------------
//
// `courses/...` in a space is not a folder of the space: it shows the vault's
// imported courses that this space may see, and only the parts it may see
// (lms/access.rs decides). It is read-only: courses are the site's copy, and
// importing again would overwrite any change.

/// `rel` as a clean `courses/...` path, when it names the courses.
fn course_path(rel: &str) -> Option<PathBuf> {
    clean_rel(rel).ok().filter(|c| access::is_courses_path(c))
}

/// Refuse a write the tools may never make: into the courses.
pub fn check_writable(rel: &str) -> Result<(), String> {
    if course_path(rel).is_some() {
        return Err(format!(
            "\"{rel}\" is in courses/, the course site's copy, which can't be changed here (importing again would overwrite it); write notes elsewhere in this space, e.g. notes/"
        ));
    }
    Ok(())
}

fn list_here(ctx: &Ctx, rel: &str) -> Result<String, String> {
    if let Some(clean) = course_path(rel) {
        let names = match ctx.courses.place(&clean, true)? {
            Place::Root => ctx.courses.courses.iter().filter(|c| ctx.courses.dir_of(c).is_some()).map(|c| format!("{}/", c.folder())).collect(),
            Place::Course { seen, sub, real, .. } => {
                if !real.is_dir() {
                    return Err(format!("\"{rel}\" is a file, not a folder"));
                }
                ctx.courses.list_course(seen, &sub, &real)?
            }
        };
        return Ok(render(names));
    }
    let dir = resolve(&ctx.space, rel, true)?;
    let mut names = names_in(&dir, rel)?;
    if clean_rel(rel).is_ok_and(|c| c.as_os_str().is_empty()) {
        // The space's own folder named like the courses is hidden behind them.
        names.retain(|n| !n.trim_end_matches('/').eq_ignore_ascii_case(crate::lms::store::COURSES_DIR));
        if !ctx.courses.is_empty() {
            names.push(format!("{}/", crate::lms::store::COURSES_DIR));
            names.sort();
        }
    }
    Ok(render(names))
}

fn read_here(ctx: &Ctx, rel: &str) -> Result<String, String> {
    let Some(clean) = course_path(rel) else { return read(&ctx.space, rel) };
    match ctx.courses.place(&clean, true)? {
        Place::Root => Err(format!("\"{rel}\" is a folder; use list_files")),
        Place::Course { seen, sub, real, .. } => Ok(access::filter_text(seen, &sub, read_at(&real, rel)?)),
    }
}

fn search_here(ctx: &Ctx, query: &str, rel: &str) -> Result<String, String> {
    if query.is_empty() {
        return Err("query must not be empty".into());
    }
    let mut hits = vec![];
    if let Some(clean) = course_path(rel) {
        match ctx.courses.place(&clean, true)? {
            Place::Root => search_courses(&ctx.courses, None, query, &mut hits),
            Place::Course { seen, real, .. } => search_courses(&ctx.courses, Some((seen, real)), query, &mut hits),
        }
    } else {
        let root = resolve(&ctx.space, "", true)?;
        let start = resolve(&ctx.space, rel, true)?;
        let whole = start == root;
        walk_search(&root, start, query, "", whole, &mut hits);
        if whole {
            search_courses(&ctx.courses, None, query, &mut hits);
        }
    }
    Ok(found(hits, query))
}

/// Search the courses a space may see (or one course from `start`), only the
/// parts it may see, README as it may see it.
fn search_courses(courses: &Visible, only: Option<(&access::Seen, PathBuf)>, query: &str, hits: &mut Vec<String>) {
    let needle = query.to_lowercase();
    let list: Vec<(&access::Seen, PathBuf, PathBuf)> = match only {
        Some((seen, start)) => courses.dir_of(seen).map(|d| vec![(seen, d, start)]).unwrap_or_default(),
        None => courses.courses.iter().filter_map(|c| courses.dir_of(c).map(|d| (c, d.clone(), d))).collect(),
    };
    for (seen, dir, start) in list {
        for (sub, real) in courses.walk(seen, &dir, &start, 10_000) {
            if hits.len() >= MAX_HITS {
                return;
            }
            if fs::symlink_metadata(&real).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_SEARCH_FILE {
                continue;
            }
            let Ok(text) = fs::read_to_string(&real) else { continue };
            let text = access::filter_text(seen, &sub, text);
            let shown = format!("{}/{}/{}", crate::lms::store::COURSES_DIR, seen.folder(), sub.to_string_lossy());
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    hits.push(format!("{shown}:{}: {}", i + 1, line.trim()));
                    if hits.len() >= MAX_HITS {
                        return;
                    }
                }
            }
        }
    }
}

fn list_at(dir: &Path, rel: &str) -> Result<String, String> {
    names_in(dir, rel).map(render)
}

fn render(mut names: Vec<String>) -> String {
    if names.is_empty() {
        return "(empty folder)".into();
    }
    let total = names.len();
    names.truncate(MAX_LIST);
    let mut out = names.join("\n");
    if total > MAX_LIST {
        out.push_str(&format!("\n… and {} more", total - MAX_LIST));
    }
    out
}

fn names_in(dir: &Path, rel: &str) -> Result<Vec<String>, String> {
    if !dir.is_dir() {
        return Err(format!("\"{rel}\" is a file, not a folder"));
    }
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| format!("cannot list \"{rel}\": {e}"))?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != STATE_DIR)
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .collect();
    names.sort();
    Ok(names)
}

fn list(space: &Path, rel: &str) -> Result<String, String> {
    list_at(&resolve(space, rel, true)?, rel)
}

fn read(space: &Path, rel: &str) -> Result<String, String> {
    read_at(&resolve(space, rel, true)?, rel)
}

fn read_at(file: &Path, rel: &str) -> Result<String, String> {
    if file.is_dir() {
        return Err(format!("\"{rel}\" is a folder; use list_files"));
    }
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    if size > MAX_READ {
        return Err(format!("\"{rel}\" is {size} bytes, more than the {MAX_READ}-byte limit"));
    }
    let bytes = fs::read(file).map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("\"{rel}\" is not a text file"))
}

fn search(space: &Path, query: &str, rel: &str) -> Result<String, String> {
    if query.is_empty() {
        return Err("query must not be empty".into());
    }
    search_at(&resolve(space, "", true)?, resolve(space, rel, true)?, query, "")
}

/// Search from `start`, showing each hit's path relative to `root` after `prefix`.
fn search_at(root: &Path, start: PathBuf, query: &str, prefix: &str) -> Result<String, String> {
    if query.is_empty() {
        return Err("query must not be empty".into());
    }
    let mut hits = vec![];
    walk_search(root, start, query, prefix, false, &mut hits);
    Ok(found(hits, query))
}

fn found(hits: Vec<String>, query: &str) -> String {
    if hits.is_empty() {
        return format!("No lines contain \u{201c}{query}\u{201d}.");
    }
    hits.join("\n")
}

/// The walk behind a search. `hide_courses`: leave out a folder of `root`
/// named like the courses (in a space they are searched as courses instead).
fn walk_search(root: &Path, start: PathBuf, query: &str, prefix: &str, hide_courses: bool, hits: &mut Vec<String>) {
    let needle = query.to_lowercase();
    let mut stack = vec![start];
    while let Some(p) = stack.pop() {
        if hits.len() >= MAX_HITS {
            break;
        }
        // symlink_metadata: never follow a link while walking.
        let Ok(meta) = p.symlink_metadata() else { continue };
        if meta.is_dir() {
            if p.file_name().is_some_and(|n| n == STATE_DIR) {
                continue;
            }
            if hide_courses && p.parent() == Some(root) && p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(crate::lms::store::COURSES_DIR)) {
                continue;
            }
            if let Ok(rd) = fs::read_dir(&p) {
                let mut kids: Vec<_> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
                kids.sort();
                stack.extend(kids.into_iter().rev());
            }
        } else if meta.is_file() && meta.len() <= MAX_SEARCH_FILE {
            let Ok(text) = fs::read_to_string(&p) else { continue };
            let shown = format!("{prefix}{}", p.strip_prefix(root).unwrap_or(&p).display());
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    hits.push(format!("{shown}:{}: {}", i + 1, line.trim()));
                    if hits.len() >= MAX_HITS {
                        break;
                    }
                }
            }
        }
    }
}

fn write(space: &Path, rel: &str, contents: &str) -> Result<String, String> {
    check_writable(rel)?;
    if rel.trim().is_empty() {
        return Err("path must name a file".into());
    }
    let file = resolve(space, rel, false)?;
    if file.is_dir() {
        return Err(format!("\"{rel}\" is a folder"));
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create the folder for \"{rel}\": {e}"))?;
    }
    fs::write(&file, contents).map_err(|e| format!("cannot write \"{rel}\": {e}"))?;
    Ok(format!("Wrote {} bytes to {rel}.", contents.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::Scope;

    fn space(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-tools-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("space/notes")).unwrap();
        fs::create_dir_all(dir.join("space/.phaethon")).unwrap();
        fs::create_dir_all(dir.join("sibling")).unwrap();
        fs::write(dir.join("space/notes/a.md"), "Hello world\nsecond line\n").unwrap();
        fs::write(dir.join("space/.phaethon/session"), "secret").unwrap();
        fs::write(dir.join("sibling/secret.txt"), "marmalade").unwrap();
        dir
    }

    #[test]
    fn paths_stay_inside_the_space() {
        let dir = space("paths");
        let s = dir.join("space");
        assert!(resolve(&s, "notes/a.md", true).is_ok());
        assert!(resolve(&s, "notes/new/b.md", false).is_ok());
        for bad in ["../sibling/secret.txt", "/etc/passwd", "notes/../../sibling", ".phaethon/session", "./.phaethon"] {
            assert!(resolve(&s, bad, false).is_err(), "{bad} should be refused");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("sibling"), s.join("link")).unwrap();
            assert!(resolve(&s, "link/secret.txt", true).is_err());
            assert!(resolve(&s, "link/new.txt", false).is_err());
            assert!(run(&s, &Call::Read { path: "link/secret.txt".into() }).is_err());
            // A search walk does not follow the link either.
            let out = run(&s, &Call::Search { query: "marmalade".into(), path: String::new() }).unwrap();
            assert!(out.starts_with("No lines contain"), "{out}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tools_work_and_hide_state() {
        let dir = space("run");
        let s = dir.join("space");
        assert_eq!(run(&s, &Call::List { path: String::new() }).unwrap(), "notes/");
        assert_eq!(run(&s, &Call::Read { path: "notes/a.md".into() }).unwrap(), "Hello world\nsecond line\n");
        assert_eq!(
            run(&s, &Call::Search { query: "WORLD".into(), path: String::new() }).unwrap(),
            "notes/a.md:1: Hello world"
        );
        assert!(!run(&s, &Call::Search { query: "secret".into(), path: String::new() }).unwrap().contains(".phaethon"));
        run(&s, &Call::Write { path: "drafts/b.md".into(), contents: "new".into() }).unwrap();
        assert_eq!(fs::read_to_string(s.join("drafts/b.md")).unwrap(), "new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn completed_quiz_can_be_reviewed_without_exposing_other_state() {
        let dir = space("study-attempt");
        let s = dir.join("space");
        let path = ".phaethon/study/attempts/Practice-42.json";
        fs::create_dir_all(s.join(".phaethon/study/attempts")).unwrap();
        fs::write(s.join(path), json!({
            "path": path,
            "quiz": "study/quizzes/Practice.json",
            "taken": 42,
            "score": 0.0,
            "results": [{
                "id": "q1", "correct": false, "given": "B", "expected": "A",
                "feedback": "A follows from the course notes."
            }]
        }).to_string()).unwrap();

        let listed: Value = serde_json::from_str(&run(&s, &Call::StudyAttempt { path: String::new() }).unwrap()).unwrap();
        assert_eq!(listed, json!([{"path": path, "quiz": "study/quizzes/Practice.json", "taken": 42, "score": 0.0}]));
        let result: Value = serde_json::from_str(&run(&s, &Call::StudyAttempt { path: path.into() }).unwrap()).unwrap();
        assert_eq!(result["results"][0]["given"], "B");
        assert_eq!(result["results"][0]["expected"], "A");
        assert!(run(&s, &Call::StudyAttempt { path: ".phaethon/session".into() }).is_err());
        assert!(run(&s, &Call::Read { path: path.into() }).is_err());
        assert!(parse_call("study_attempt", &json!({"path": path, "other": true})).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn inputs_are_validated() {
        assert_eq!(
            parse_call("read_file", &json!({"path": "a.md"})).unwrap(),
            Call::Read { path: "a.md".into() }
        );
        assert!(parse_call("read_file", &json!({})).is_err());
        assert!(parse_call("read_file", &json!({"path": 3})).is_err());
        assert!(parse_call("write_file", &json!({"path": "a"})).is_err());
        assert!(parse_call("write_file", &json!({"path": "a", "contents": "x", "mode": "777"})).is_err());
        assert!(parse_call("bash", &json!({})).is_err());
        assert_eq!(parse_call("list_files", &json!({})).unwrap(), Call::List { path: String::new() });
        assert!(parse_call("request_access", &json!({"space": "work", "path": "calendar"})).is_err());
        let long = "x".repeat(2000);
        let Call::RequestAccess { reason, .. } =
            parse_call("request_access", &json!({"space": "work", "path": "calendar", "reason": long})).unwrap()
        else {
            panic!()
        };
        assert_eq!(reason.len(), MAX_REASON);
    }

    #[test]
    fn writes_into_another_space_are_always_refused() {
        let err = parse_call("write_file", &json!({"path": "@work/calendar/oct.md", "contents": "x"})).unwrap_err();
        assert!(err.contains("other spaces can never be written"), "{err}");
        // Even with a grant, and even if a Call is built directly.
        let (dir, ctx) = cross("write");
        let call = Call::Write { path: "@work/calendar/new.md".into(), contents: "x".into() };
        assert!(run_in(&ctx, &call).is_err());
        assert!(!dir.join("spaces/work/calendar/new.md").exists());
        // A local file named with "@" is still writable as "./@name".
        assert!(parse_call("write_file", &json!({"path": "./@home.md", "contents": "x"})).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn grant(path: &str) -> Grant {
        Grant {
            id: "g".into(),
            to: "school".into(),
            from: "work".into(),
            path: path.into(),
            created: String::new(),
            scope: Scope::Once,
        }
    }

    /// Vault with spaces school and work, and a grant school <- work/calendar.
    fn cross(name: &str) -> (PathBuf, Ctx) {
        let dir = std::env::temp_dir().join(format!("phaethon-tools-cross-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for d in ["spaces/school", "spaces/work/calendar", "spaces/work/calendar-old", "spaces/work/private", "spaces/work/.phaethon"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("spaces/work/calendar/oct.md"), "Oct 14: shift 9-5\n").unwrap();
        fs::write(dir.join("spaces/work/calendar-old/sep.md"), "Sep shift\n").unwrap();
        fs::write(dir.join("spaces/work/private/salary.md"), "shift pay\n").unwrap();
        fs::write(dir.join("spaces/work/.phaethon/session"), "secret").unwrap();
        let ctx = Ctx {
            space: dir.join("spaces/school"),
            space_id: "school".into(),
            vault: Vault::at(&dir),
            grants: vec![grant("calendar")],
            courses: Visible::default(),
        };
        (dir, ctx)
    }

    #[test]
    fn cross_space_reads_need_a_covering_grant() {
        let (dir, mut ctx) = cross("read");
        let read = |p: &str| Call::Read { path: p.into() };
        assert_eq!(run_in(&ctx, &read("@work/calendar/oct.md")).unwrap(), "Oct 14: shift 9-5\n");
        assert_eq!(run_in(&ctx, &Call::List { path: "@work/calendar".into() }).unwrap(), "oct.md");
        assert_eq!(
            run_in(&ctx, &Call::Search { query: "SHIFT".into(), path: "@work/calendar".into() }).unwrap(),
            "@work/calendar/oct.md:1: Oct 14: shift 9-5"
        );
        let refused = [
            "@work/calendar-old/sep.md",
            "@work/private/salary.md",
            "@work/calendar/../private/salary.md",
            "@work/.phaethon/session",
            "@work//etc/passwd",
            "@work",
            "@nope/calendar/oct.md",
            "@../work/calendar/oct.md",
        ];
        for p in refused {
            assert!(run_in(&ctx, &read(p)).is_err(), "{p} should be refused");
        }
        let err = run_in(&ctx, &read("@work/private/salary.md")).unwrap_err();
        assert_eq!(err, "\"@work/private/salary.md\" is in the work space; ask for access with request_access first");
        // Searching the whole other space, or listing its root, is not covered by a folder grant.
        assert!(run_in(&ctx, &Call::Search { query: "shift".into(), path: "@work".into() }).is_err());
        assert!(run_in(&ctx, &Call::List { path: "@work/".into() }).is_err());
        // A grant to another space does not help this one.
        ctx.grants = vec![Grant { to: "home".into(), ..grant("calendar") }];
        assert!(run_in(&ctx, &read("@work/calendar/oct.md")).is_err());
        // No grants: plain refusal; and the local tools never reach other spaces.
        ctx.grants = vec![];
        assert!(run_in(&ctx, &read("@work/calendar/oct.md")).is_err());
        assert!(run_in(&ctx, &read("../work/calendar/oct.md")).is_err());
        // "@school/..." from school is just this space.
        fs::write(dir.join("spaces/school/a.md"), "mine").unwrap();
        assert_eq!(run_in(&ctx, &read("@school/a.md")).unwrap(), "mine");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_leave_the_granted_folder() {
        let (dir, ctx) = cross("link");
        let cal = dir.join("spaces/work/calendar");
        // Inside the granted folder, pointing elsewhere in work, and outside the vault.
        std::os::unix::fs::symlink(dir.join("spaces/work/private"), cal.join("priv")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), cal.join("tmp")).unwrap();
        std::os::unix::fs::symlink(dir.join("spaces/work/private/salary.md"), cal.join("pay.md")).unwrap();
        for p in ["@work/calendar/priv/salary.md", "@work/calendar/tmp", "@work/calendar/pay.md"] {
            let r = run_in(&ctx, &Call::Read { path: p.into() });
            assert!(r.is_err(), "{p} should be refused: {r:?}");
        }
        assert!(run_in(&ctx, &Call::List { path: "@work/calendar/priv".into() }).is_err());
        // The search walk does not follow links.
        let out = run_in(&ctx, &Call::Search { query: "pay".into(), path: "@work/calendar".into() }).unwrap();
        assert!(out.starts_with("No lines contain"), "{out}");
        // A granted path that is itself a link out of the space is refused too.
        std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("spaces/work/out")).unwrap();
        let ctx = Ctx { grants: vec![grant("out")], ..ctx };
        assert!(run_in(&ctx, &Call::List { path: "@work/out".into() }).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The access fixture's vault (Calculus II and Linear Algebra imported),
    /// with school allowed `parts` of Calculus II, as school's tool context.
    fn courses_ctx(tag: &str, parts: &[crate::lms::access::Part]) -> (PathBuf, Ctx) {
        let (dir, vault) = crate::lms::access::tests::vault(&format!("tools-{tag}"));
        crate::lms::access::set(&vault, "school", "canvas-x/1", parts).unwrap();
        fs::write(dir.join("spaces/school/notes.md"), "my own series notes\n").unwrap();
        let ctx = Ctx {
            space: dir.join("spaces/school"),
            space_id: "school".into(),
            courses: crate::lms::access::visible(&vault, "school"),
            vault,
            grants: vec![],
        };
        (dir, ctx)
    }

    #[test]
    fn courses_are_read_listed_and_searched_only_as_far_as_allowed() {
        use crate::lms::access::Part;
        let (dir, ctx) = courses_ctx("parts", &[Part::Overview, Part::Files]);
        let read = |p: &str| run_in(&ctx, &Call::Read { path: p.into() });
        let list = |p: &str| run_in(&ctx, &Call::List { path: p.into() });
        let search = |q: &str, p: &str| run_in(&ctx, &Call::Search { query: q.into(), path: p.into() }).unwrap();
        // The space's root shows courses/ beside its own files; courses/ lists what it may see.
        assert_eq!(list("").unwrap(), "courses/\nnotes.md");
        assert_eq!(list("courses").unwrap(), "Calculus II/");
        assert_eq!(list("courses/Calculus II").unwrap(), "README.md\nfiles/\nmodules.md\npages/\nreadings/");
        assert_eq!(list("courses/Calculus II/files/Notes").unwrap(), "series.pdf.md");
        assert!(read("courses/Calculus II/files/Notes/series.pdf.md").unwrap().contains("Ratio test"));
        // README without the grade or the links to parts it may not see.
        let readme = read("courses/Calculus II/README.md").unwrap();
        assert!(readme.contains("Coming up") && !readme.contains("91%") && !readme.contains("syllabus.md"), "{readme}");
        for bad in [
            "courses/Calculus II/grades.md",
            "courses/Calculus II/GRADES.MD",
            "Courses/Calculus II/syllabus.md",
            "courses/Calculus II/assignments.md",
            "courses/Calculus II/files/../grades.md",
            "courses/Calculus II/./grades.md",
            "courses/Linear Algebra/syllabus.md",
            "courses/Calculus%20II/README.md",
            "courses/../courses/Calculus II/grades.md",
            "courses/Calculus II/.phaethon",
            ".phaethon/course-access.json",
            "../../.phaethon/course-access.json",
            "../../courses/Calculus II/grades.md",
        ] {
            assert!(read(bad).is_err(), "{bad} should be refused");
        }
        assert!(list("courses/Linear Algebra").is_err());
        assert!(list(".phaethon").is_err());
        // Search finds allowed parts across the space, never grades or syllabus, never another course.
        let all = search("series", "");
        assert!(all.contains("notes.md:1:") && all.contains("courses/Calculus II/files/Notes/series.pdf.md:1:"), "{all}");
        assert!(search("91%", "").starts_with("No lines contain"), "the README's grade line is hidden");
        assert!(search("office hours", "").starts_with("No lines contain"), "syllabus isn't allowed");
        assert!(search("eigenvalues", "courses").starts_with("No lines contain"), "Linear Algebra isn't allowed");
        assert!(search("week 1", "courses/Calculus II").contains("courses/Calculus II/pages/week 1.md:1:"));
        assert!(run_in(&ctx, &Call::Search { query: "x".into(), path: "courses/Linear Algebra".into() }).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_space_without_access_sees_no_courses() {
        let (dir, ctx) = courses_ctx("none", &[]);
        assert_eq!(run_in(&ctx, &Call::List { path: String::new() }).unwrap(), "notes.md");
        assert!(run_in(&ctx, &Call::List { path: "courses".into() }).unwrap() == "(empty folder)");
        assert!(run_in(&ctx, &Call::Read { path: "courses/Calculus II/README.md".into() }).is_err());
        assert!(run_in(&ctx, &Call::Search { query: "series".into(), path: String::new() }).unwrap().starts_with("notes.md:1:"));
        // A folder of the space's own called courses is hidden behind them, never mixed in.
        fs::create_dir_all(dir.join("spaces/school/Courses/Old")).unwrap();
        fs::write(dir.join("spaces/school/Courses/Old/x.md"), "series old").unwrap();
        assert_eq!(run_in(&ctx, &Call::List { path: String::new() }).unwrap(), "notes.md");
        assert!(run_in(&ctx, &Call::Read { path: "Courses/Old/x.md".into() }).is_err());
        assert!(!run_in(&ctx, &Call::Search { query: "series".into(), path: String::new() }).unwrap().contains("old"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn courses_and_who_sees_them_are_never_written_by_the_agent() {
        use crate::lms::access::Part;
        let (dir, ctx) = courses_ctx("write", &Part::ALL);
        let access_before = fs::read_to_string(dir.join(".phaethon/course-access.json")).unwrap();
        for p in ["courses/Calculus II/syllabus.md", "courses/Calculus II/new.md", "Courses/x.md", "./courses/x.md", "courses", ".phaethon/course-access.json"] {
            let r = run_in(&ctx, &Call::Write { path: p.into(), contents: "x".into() });
            assert!(r.is_err(), "{p}: {r:?}");
        }
        assert!(check_writable("courses/a.md").unwrap_err().contains("course site's copy"));
        assert!(check_writable("notes/courses.md").is_ok());
        assert_eq!(fs::read_to_string(dir.join("courses/Calculus II/syllabus.md")).unwrap(), "Syllabus: integrals and series. Office hours Tuesday.\n");
        assert_eq!(fs::read_to_string(dir.join(".phaethon/course-access.json")).unwrap(), access_before);
        assert!(!dir.join("spaces/school/.phaethon/course-access.json").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_in_a_course_never_lead_to_a_part_or_place_not_allowed() {
        use crate::lms::access::Part;
        let (dir, _) = courses_ctx("links", &[Part::Files]);
        let calc = dir.join("courses/Calculus II");
        std::os::unix::fs::symlink(calc.join("grades.md"), calc.join("files/g.md")).unwrap();
        std::os::unix::fs::symlink(dir.join("spaces/work"), calc.join("files/work")).unwrap();
        fs::write(dir.join("spaces/work/private.md"), "work secret").unwrap();
        let ctx = Ctx { courses: crate::lms::access::visible(&Vault::at(&dir), "school"), ..courses_ctx_keep(&dir) };
        for p in ["courses/Calculus II/files/g.md", "courses/Calculus II/files/work/private.md"] {
            assert!(run_in(&ctx, &Call::Read { path: p.into() }).is_err(), "{p}");
        }
        let out = run_in(&ctx, &Call::Search { query: "secret".into(), path: String::new() }).unwrap();
        assert!(out.starts_with("No lines contain"), "{out}");
        let out = run_in(&ctx, &Call::Search { query: "91%".into(), path: "courses".into() }).unwrap();
        assert!(out.starts_with("No lines contain"), "{out}");
        fs::remove_dir_all(&dir).unwrap();
    }

    fn courses_ctx_keep(dir: &Path) -> Ctx {
        Ctx { space: dir.join("spaces/school"), space_id: "school".into(), vault: Vault::at(dir), grants: vec![], courses: Default::default() }
    }

    #[test]
    fn labels_name_the_other_space() {
        let l = |c: Call| label(&c);
        assert_eq!(l(Call::Read { path: "@work/calendar/oct.md".into() }), "Reading work/calendar/oct.md");
        assert_eq!(l(Call::List { path: "@work/calendar/".into() }), "Listing work/calendar");
        assert_eq!(l(Call::Search { query: "x".into(), path: "@work/calendar".into() }), "Searching work/calendar for \u{201c}x\u{201d}");
        assert_eq!(l(Call::Read { path: "a.md".into() }), "Reading file a.md");
        assert!(is_cross(&Call::Read { path: "@work/a".into() }));
        assert!(!is_cross(&Call::Read { path: "./@work/a".into() }));
    }
}
