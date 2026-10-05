//! steward's own file tools, confined to one space folder.
//!
//! Every path the model names is relative to the space root. It is checked
//! lexically (no absolute paths, no `..`, nothing under `.steward/`) and then
//! against the real filesystem, so a symlink cannot lead outside the space.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

/// Largest file `read_file` returns, in bytes.
const MAX_READ: u64 = 256 * 1024;
const MAX_LIST: usize = 500;
const MAX_HITS: usize = 200;
/// Files `search_files` skips because they are too big to be notes.
const MAX_SEARCH_FILE: u64 = 2 * 1024 * 1024;

/// Folder inside each space that holds steward's own state.
pub const STATE_DIR: &str = ".steward";

/// What the loop needs to know about a tool before running it.
pub enum Access {
    /// Runs without asking.
    Read,
    /// Shown to the user first; runs only if they allow it.
    Write,
}

pub fn access(name: &str) -> Access {
    match name {
        "write_file" => Access::Write,
        _ => Access::Read,
    }
}

/// Tool definitions sent to the model. Kept in a fixed order so the prompt
/// prefix (and its cache) stays stable across requests.
pub fn definitions() -> Value {
    let path = json!({"type": "string", "description": "Path relative to the space root, e.g. \"notes/today.md\"."});
    json!([
        {
            "name": "list_files",
            "description": "List the files and folders in a folder of this space. Folders end with \"/\".",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Folder relative to the space root. Omit or use \"\" for the root."}},
                "additionalProperties": false
            }
        },
        {
            "name": "read_file",
            "description": "Read a text file in this space.",
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
            "description": "Find lines containing some text (case-insensitive) in the text files of this space. Returns path:line: text.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to look for."},
                    "path": {"type": "string", "description": "Folder to search, relative to the space root. Omit for the whole space."}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "write_file",
            "description": "Create or replace a text file in this space with the given contents. The user is asked to approve every write first, and may decline.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": path,
                    "contents": {"type": "string", "description": "The complete new contents of the file."}
                },
                "required": ["path", "contents"],
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
        _ => Call::Write {
            path: req("path")?,
            contents: req("contents")?,
        },
    })
}

/// Short present-tense description for the UI, e.g. "Reading file notes.md".
pub fn label(call: &Call) -> String {
    let shown = |p: &str| if p.is_empty() { "the space".to_string() } else { p.to_string() };
    match call {
        Call::List { path } => format!("Listing {}", shown(path)),
        Call::Read { path } => format!("Reading file {path}"),
        Call::Search { query, .. } => format!("Searching files for \u{201c}{query}\u{201d}"),
        Call::Write { path, .. } => format!("Writing file {path}"),
    }
}

/// Run a tool. `Err` is a message for the model (sent back with `is_error`).
pub fn run(space: &Path, call: &Call) -> Result<String, String> {
    match call {
        Call::List { path } => list(space, path),
        Call::Read { path } => read(space, path),
        Call::Search { query, path } => search(space, query, path),
        Call::Write { path, contents } => write(space, path, contents),
    }
}

/// Resolve `rel` inside `space`. `must_exist` false allows a path whose final
/// parts do not exist yet (for writes); the deepest existing ancestor is still
/// checked, so a symlinked folder cannot redirect a new file outside the space.
pub fn resolve(space: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    let root = space
        .canonicalize()
        .map_err(|e| format!("space folder unavailable: {e}"))?;
    let rel_path = Path::new(rel);
    let mut clean = PathBuf::new();
    for c in rel_path.components() {
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
        return Err(format!("\"{rel}\" is steward's own state and cannot be used by tools"));
    }
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

fn list(space: &Path, rel: &str) -> Result<String, String> {
    let dir = resolve(space, rel, true)?;
    if !dir.is_dir() {
        return Err(format!("\"{rel}\" is a file, not a folder"));
    }
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("cannot list \"{rel}\": {e}"))?
        .filter_map(Result::ok)
        .filter(|e| e.file_name() != STATE_DIR)
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .collect();
    names.sort();
    if names.is_empty() {
        return Ok("(empty folder)".into());
    }
    let total = names.len();
    names.truncate(MAX_LIST);
    let mut out = names.join("\n");
    if total > MAX_LIST {
        out.push_str(&format!("\n… and {} more", total - MAX_LIST));
    }
    Ok(out)
}

fn read(space: &Path, rel: &str) -> Result<String, String> {
    let file = resolve(space, rel, true)?;
    if file.is_dir() {
        return Err(format!("\"{rel}\" is a folder; use list_files"));
    }
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    if size > MAX_READ {
        return Err(format!("\"{rel}\" is {size} bytes, more than the {MAX_READ}-byte limit"));
    }
    let bytes = fs::read(&file).map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("\"{rel}\" is not a text file"))
}

fn search(space: &Path, query: &str, rel: &str) -> Result<String, String> {
    if query.is_empty() {
        return Err("query must not be empty".into());
    }
    let root = resolve(space, "", true)?;
    let start = resolve(space, rel, true)?;
    let needle = query.to_lowercase();
    let mut hits = vec![];
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
            if let Ok(rd) = fs::read_dir(&p) {
                let mut kids: Vec<_> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
                kids.sort();
                stack.extend(kids.into_iter().rev());
            }
        } else if meta.is_file() && meta.len() <= MAX_SEARCH_FILE {
            let Ok(text) = fs::read_to_string(&p) else { continue };
            let shown = p.strip_prefix(&root).unwrap_or(&p).display().to_string();
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
    if hits.is_empty() {
        return Ok(format!("No lines contain \u{201c}{query}\u{201d}."));
    }
    Ok(hits.join("\n"))
}

fn write(space: &Path, rel: &str, contents: &str) -> Result<String, String> {
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

    fn space(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("steward-tools-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("space/notes")).unwrap();
        fs::create_dir_all(dir.join("space/.steward")).unwrap();
        fs::create_dir_all(dir.join("sibling")).unwrap();
        fs::write(dir.join("space/notes/a.md"), "Hello world\nsecond line\n").unwrap();
        fs::write(dir.join("space/.steward/session"), "secret").unwrap();
        fs::write(dir.join("sibling/secret.txt"), "marmalade").unwrap();
        dir
    }

    #[test]
    fn paths_stay_inside_the_space() {
        let dir = space("paths");
        let s = dir.join("space");
        assert!(resolve(&s, "notes/a.md", true).is_ok());
        assert!(resolve(&s, "notes/new/b.md", false).is_ok());
        for bad in ["../sibling/secret.txt", "/etc/passwd", "notes/../../sibling", ".steward/session", "./.steward"] {
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
        assert!(!run(&s, &Call::Search { query: "secret".into(), path: String::new() }).unwrap().contains(".steward"));
        run(&s, &Call::Write { path: "drafts/b.md".into(), contents: "new".into() }).unwrap();
        assert_eq!(fs::read_to_string(s.join("drafts/b.md")).unwrap(), "new");
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
    }
}
