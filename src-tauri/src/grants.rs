//! Read-only access grants between spaces.
//!
//! Nothing crosses between spaces by default. A grant lets one space (`to`)
//! read one folder or file (`path`) of another space (`from`). Writing into
//! another space is never grantable.
//!
//! "always" grants are plain JSON in `<vault>/.phaethon/grants.json`, so they
//! are visible to the user, editable and synced with the vault. "once" grants
//! live only in memory for the turn that asked for them and are never written.
//!
//! The file is user-editable, so nothing in it is trusted: every entry is
//! validated on every read, and invalid ones are ignored and reported (see
//! `load`), never used.

use std::collections::HashSet;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::tools;
use crate::vault::Vault;

/// Serialises read-modify-write of grants.json within this process.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Saved in grants.json until the user revokes it.
    Always,
    /// This turn only; never written to disk.
    Once,
}

/// The user's answer to an access request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessAnswer {
    Once,
    Always,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    /// The space that may read.
    pub to: String,
    /// The space that is read.
    pub from: String,
    /// Folder or file inside `from`, relative to its root, `/`-separated.
    pub path: String,
    /// ISO 8601, UTC.
    pub created: String,
    pub scope: Scope,
}

/// What the UI shows for one grant.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub id: String,
    pub from: String,
    pub path: String,
    pub created: String,
    pub scope: Scope,
}

/// What the UI shows for a grant that lets another space (`to`) read this one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingGrantView {
    pub id: String,
    pub to: String,
    pub path: String,
    pub created: String,
    pub scope: Scope,
}

/// Grants a space has, grants other spaces have into it, plus anything wrong
/// with grants.json.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantsView {
    pub grants: Vec<GrantView>,
    /// Other spaces that may read part of this one, sorted by space then path.
    pub incoming: Vec<IncomingGrantView>,
    /// Plain-language notes on entries that were ignored. Empty when the file is fine.
    pub problems: Vec<String>,
}

/// Every valid grant in the file, and a note for each entry that was ignored.
#[derive(Debug, Default)]
pub struct Loaded {
    pub grants: Vec<Grant>,
    pub problems: Vec<String>,
}

fn file(vault: &Vault) -> PathBuf {
    vault.root().join(".phaethon").join("grants.json")
}

/// Read and validate grants.json. A missing file means no grants.
pub fn load(vault: &Vault) -> Loaded {
    let raw = match fs::read_to_string(file(vault)) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::default(),
        Err(e) => {
            return Loaded { grants: vec![], problems: vec![format!("grants.json couldn’t be read, so no folders are shared between spaces: {e}")] };
        }
    };
    let entries = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(o)) => match o.get("grants") {
            Some(Value::Array(a)) => a.clone(),
            None => vec![],
            Some(_) => {
                return Loaded { grants: vec![], problems: vec!["grants.json isn’t laid out as Phaethon expects, so no folders are shared between spaces.".into()] };
            }
        },
        _ => {
            return Loaded { grants: vec![], problems: vec!["grants.json has a typing mistake, so no folders are shared between spaces. Fix it in a text editor or delete it.".into()] };
        }
    };
    let mut out = Loaded::default();
    let mut seen_ids = HashSet::new();
    for (i, entry) in entries.iter().enumerate() {
        match validate(vault, entry) {
            Ok(g) if !seen_ids.insert(g.id.clone()) => {
                out.problems.push(format!("Entry {} is skipped: its id “{}” appears twice.", i + 1, g.id));
            }
            Ok(g) => out.grants.push(g),
            Err(why) => out.problems.push(format!("Entry {} is skipped: {why}.", i + 1)),
        }
    }
    out
}

fn validate(vault: &Vault, entry: &Value) -> Result<Grant, String> {
    let obj = entry.as_object().ok_or("it is not an object")?;
    let s = |k: &str| -> Result<String, String> {
        obj.get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("“{k}” is missing or isn’t text"))
    };
    let id = s("id")?;
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("its id isn’t valid".into());
    }
    let to = s("to")?;
    let from = s("from")?;
    match obj.get("scope").and_then(Value::as_str) {
        Some("always") => {}
        Some("once") => return Err("it’s marked “once”, and only grants you chose to keep belong in this file".into()),
        _ => return Err("its “scope” should be “always”".into()),
    }
    if to == from {
        return Err(format!("it lets {to} read itself"));
    }
    for space in [&to, &from] {
        vault.space_dir(space)?;
    }
    let path = normalize(&s("path")?)?;
    let created = obj.get("created").and_then(Value::as_str).unwrap_or("").to_string();
    Ok(Grant { id, to, from, path, created, scope: Scope::Always })
}

/// A grant path in canonical form ("calendar/oct", no `./`, no trailing `/`).
/// Refuses empty paths (a grant names a folder or file, never a whole space),
/// absolute paths, `..`, and Phaethon's own state folder.
pub fn normalize(path: &str) -> Result<String, String> {
    let clean = tools::clean_rel(path)?;
    if clean.as_os_str().is_empty() {
        return Err("it names a whole space, and a grant has to name a folder or file".into());
    }
    let parts: Vec<String> = clean
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Ok(parts.join("/"))
}

/// Whether a grant for `grant_path` covers `rel` (both relative to the other
/// space's root). Prefix match on whole path components: "calendar" covers
/// "calendar" and "calendar/oct.md", never "calendar-old".
pub fn covers(grant_path: &str, rel: &Path) -> bool {
    let g = Path::new(grant_path);
    g.components().next().is_some() && rel.starts_with(g)
}

/// Valid "always" grants that let `space` read other spaces, in a stable
/// order (by space, then path) so prompts built from them stay cacheable.
pub fn for_space(vault: &Vault, space: &str) -> Vec<Grant> {
    let mut g: Vec<Grant> = load(vault).grants.into_iter().filter(|g| g.to == space).collect();
    g.sort_by(|a, b| (&a.from, &a.path).cmp(&(&b.from, &b.path)));
    g
}

/// For the UI: what `space` may read, and any problems with the file.
pub fn view(vault: &Vault, space: &str) -> GrantsView {
    let loaded = load(vault);
    let mut mine: Vec<&Grant> = loaded.grants.iter().filter(|g| g.to == space).collect();
    mine.sort_by(|a, b| (&a.from, &a.path).cmp(&(&b.from, &b.path)));
    let mut into: Vec<&Grant> = loaded.grants.iter().filter(|g| g.from == space).collect();
    into.sort_by(|a, b| (&a.to, &a.path).cmp(&(&b.to, &b.path)));
    GrantsView {
        grants: mine
            .into_iter()
            .map(|g| GrantView { id: g.id.clone(), from: g.from.clone(), path: g.path.clone(), created: g.created.clone(), scope: g.scope })
            .collect(),
        incoming: into
            .into_iter()
            .map(|g| IncomingGrantView { id: g.id.clone(), to: g.to.clone(), path: g.path.clone(), created: g.created.clone(), scope: g.scope })
            .collect(),
        problems: loaded.problems,
    }
}

/// The other spaces of this vault, sorted. Folders that are not valid spaces
/// (bad names, symlinks) are left out.
pub fn other_spaces(vault: &Vault, current: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(vault.root().join("spaces"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n != current && vault.space_dir(n).is_ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Check an access request before asking the user. Returns the normalized
/// path. The other space must exist and differ from this one, and the path
/// must exist inside it without escaping (symlinks included).
pub fn check_request(vault: &Vault, current: &str, space: &str, path: &str) -> Result<String, String> {
    let space = space.strip_prefix('@').unwrap_or(space);
    if space == current {
        return Err(format!("{space} is this space; read it directly without asking"));
    }
    let dir = vault
        .space_dir(space)
        .map_err(|_| format!("there is no space called \"{space}\""))?;
    let clean = normalize(path)?;
    tools::resolve(&dir, &clean, true)?;
    Ok(clean)
}

/// A grant for this turn only.
pub fn once(to: &str, from: &str, path: &str) -> Grant {
    Grant { id: new_id(), to: to.into(), from: from.into(), path: path.into(), created: now_iso(), scope: Scope::Once }
}

/// Save an "always" grant. Returns the existing one if the same grant is
/// already saved. Other entries in the file, even invalid ones, are kept as
/// they are: the file is the user's.
pub fn add_always(vault: &Vault, to: &str, from: &str, path: &str) -> Result<Grant, String> {
    let path = normalize(path)?;
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(g) = load(vault)
        .grants
        .into_iter()
        .find(|g| g.to == to && g.from == from && g.path == path)
    {
        return Ok(g);
    }
    let grant = Grant { id: new_id(), to: to.into(), from: from.into(), path, created: now_iso(), scope: Scope::Always };
    let mut doc = read_doc(vault)?;
    doc["grants"]
        .as_array_mut()
        .expect("read_doc guarantees a list")
        .push(serde_json::to_value(&grant).expect("serializes"));
    write_doc(vault, &doc)?;
    Ok(grant)
}

/// How long a revoke can be undone. Long enough for a slow click; the
/// webview's own Undo window is shorter.
const UNDO_FOR: Duration = Duration::from_secs(10 * 60);

/// Entries removed by [`revoke`] in this run, by vault and id, kept only in
/// memory so Undo can put back exactly what was there. The webview names a
/// grant by id and nothing else: it can never describe a new grant itself.
static REVOKED: Mutex<Vec<(PathBuf, String, Value, Instant)>> = Mutex::new(Vec::new());

/// Undo a revoke made in the last few minutes in this run: the entry that was
/// removed goes back unchanged (same id, date and folder). Once only. Err if
/// there is no such recent revoke, or if the entry would no longer be valid
/// (a space has gone since).
pub fn restore(vault: &Vault, id: &str) -> Result<Grant, String> {
    let entry = {
        let mut revoked = REVOKED.lock().unwrap_or_else(|e| e.into_inner());
        revoked.retain(|(_, _, _, at)| at.elapsed() < UNDO_FOR);
        let at = revoked.iter().position(|(root, rid, _, _)| root == vault.root() && rid == id);
        at.map(|i| revoked.remove(i).2).ok_or_else(|| "That access can’t be put back any more.".to_string())?
    };
    let grant = validate(vault, &entry).map_err(|why| format!("That access couldn’t be put back: {why}."))?;
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(vault)?;
    let list = doc["grants"].as_array_mut().expect("read_doc guarantees a list");
    if !list.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(id)) {
        list.push(entry);
        write_doc(vault, &doc)?;
    }
    Ok(grant)
}

/// Remove the grant `id`. False if no entry has that id.
pub fn revoke(vault: &Vault, id: &str) -> Result<bool, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(vault)?;
    let list = doc["grants"].as_array_mut().expect("read_doc guarantees a list");
    let Some(at) = list.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(id)) else {
        return Ok(false);
    };
    let removed = list.remove(at);
    // A hand-edited file may hold the same id twice: remove every copy.
    list.retain(|e| e.get("id").and_then(Value::as_str) != Some(id));
    write_doc(vault, &doc)?;
    REVOKED.lock().unwrap_or_else(|e| e.into_inner()).push((vault.root().to_path_buf(), id.to_string(), removed, Instant::now()));
    Ok(true)
}

/// The file as JSON with a `grants` list, for editing. Refuses to touch a file
/// it cannot parse rather than overwrite what the user wrote.
fn read_doc(vault: &Vault) -> Result<Value, String> {
    let mut doc = match fs::read_to_string(file(vault)) {
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v @ Value::Object(_)) => v,
            _ => return Err("grants.json has a typing mistake, so Phaethon won’t change it. Fix it in a text editor or delete it, then try again.".into()),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("grants.json couldn’t be read: {e}")),
    };
    match doc.get("grants") {
        None => doc["grants"] = json!([]),
        Some(Value::Array(_)) => {}
        Some(_) => return Err("grants.json isn’t laid out as Phaethon expects, so Phaethon won’t change it. Fix it or delete it, then try again.".into()),
    }
    Ok(doc)
}

fn write_doc(vault: &Vault, doc: &Value) -> Result<(), String> {
    let path = file(vault);
    let save = || -> io::Result<()> {
        fs::create_dir_all(path.parent().expect("grants file has a parent"))?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(doc)?)?;
        fs::rename(tmp, &path)
    };
    save().map_err(|e| format!("grants.json could not be saved: {e}"))
}

/// Folders the `claude` CLI backend may read for `space`: each valid "always"
/// grant that names an existing folder, as (label like "work/calendar", real
/// path). Grants naming a single file are skipped, because the CLI's
/// `--add-dir` takes folders and granting the parent would grant too much.
pub fn cli_dirs(vault: &Vault, space: &str) -> Vec<(String, PathBuf)> {
    for_space(vault, space)
        .into_iter()
        .filter_map(|g| {
            let dir = vault.space_dir(&g.from).ok()?;
            let real = tools::resolve(&dir, &g.path, true).ok()?;
            real.is_dir().then(|| (format!("{}/{}", g.from, g.path), real))
        })
        .collect()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A random (version 4 format) UUID. Uniqueness is what matters here, not
/// unpredictability: ids only name grants and are shown in a user-editable file.
fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut b = [0u8; 16];
    for (i, chunk) in b.chunks_mut(8).enumerate() {
        // RandomState is seeded from the OS per thread and varies per instance.
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_usize(i);
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Current time as "2026-10-10T14:03:00Z".
fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant), proleptic Gregorian, UTC.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault with spaces school and work; work has calendar/oct.md.
    pub(crate) fn vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("phaethon-grants-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for s in ["school", "work"] {
            fs::create_dir_all(dir.join("spaces").join(s)).unwrap();
        }
        fs::create_dir_all(dir.join("spaces/work/calendar")).unwrap();
        fs::create_dir_all(dir.join("spaces/work/calendar-old")).unwrap();
        fs::write(dir.join("spaces/work/calendar/oct.md"), "Oct 14: shift 9-5").unwrap();
        let v = Vault::at(&dir);
        (dir, v)
    }

    fn write_file(dir: &Path, v: Value) {
        fs::create_dir_all(dir.join(".phaethon")).unwrap();
        fs::write(dir.join(".phaethon/grants.json"), v.to_string()).unwrap();
    }

    fn entry(id: &str, path: &str) -> Value {
        json!({"id": id, "to": "school", "from": "work", "path": path, "created": "2026-10-10T00:00:00Z", "scope": "always"})
    }

    #[test]
    fn parses_valid_and_ignores_hostile_entries() {
        let (dir, v) = vault("parse");
        write_file(&dir, json!({"grants": [
            entry("a", "calendar"),
            entry("b", "../x"),
            entry("c", "/etc"),
            entry("d", ".phaethon"),
            entry("e", ""),
            entry("f", "calendar/../../school"),
            json!({"id": "g", "to": "school", "from": "work", "path": "calendar", "scope": "once"}),
            json!({"id": "h", "to": "work", "from": "work", "path": "calendar", "scope": "always"}),
            json!({"id": "i", "to": "school", "from": "nope", "path": "calendar", "scope": "always"}),
            json!({"id": "j", "to": "school", "from": "../work", "path": "calendar", "scope": "always"}),
            json!({"id": "bad id!", "to": "school", "from": "work", "path": "calendar", "scope": "always"}),
            json!("just a string"),
            entry("a", "calendar-old"),
            entry("k", "./calendar-old/"),
        ]}));
        let l = load(&v);
        let ids: Vec<&str> = l.grants.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["a", "k"], "{:?}", l.problems);
        assert_eq!(l.grants[1].path, "calendar-old", "normalized");
        assert_eq!(l.problems.len(), 12, "{:#?}", l.problems);
        assert!(l.problems.iter().any(|p| p.contains("appears twice")));

        write_file(&dir, json!(["not", "an", "object"]));
        let l = load(&v);
        assert!(l.grants.is_empty() && l.problems.len() == 1);
        fs::write(dir.join(".phaethon/grants.json"), "{ not json").unwrap();
        assert_eq!(load(&v).problems.len(), 1);
        // A broken file is never overwritten.
        assert!(add_always(&v, "school", "work", "calendar").is_err());
        assert_eq!(fs::read_to_string(dir.join(".phaethon/grants.json")).unwrap(), "{ not json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prefix_matching_is_by_component() {
        assert!(covers("calendar", Path::new("calendar")));
        assert!(covers("calendar", Path::new("calendar/oct.md")));
        assert!(covers("calendar/oct.md", Path::new("calendar/oct.md")));
        assert!(!covers("calendar", Path::new("calendar-old")));
        assert!(!covers("calendar", Path::new("calendar-old/x.md")));
        assert!(!covers("calendar/oct", Path::new("calendar")));
        assert!(!covers("", Path::new("anything")));
    }

    #[test]
    fn add_revoke_and_keep_unknown_entries() {
        let (dir, v) = vault("add");
        write_file(&dir, json!({"grants": [{"note": "hand-written"}], "future": 1}));
        let g = add_always(&v, "school", "work", "calendar/").unwrap();
        assert_eq!(g.path, "calendar");
        assert_eq!(g.id.len(), 36);
        assert!(g.created.ends_with('Z') && g.created.len() == 20, "{}", g.created);
        // Same grant again: no duplicate.
        assert_eq!(add_always(&v, "school", "work", "calendar").unwrap().id, g.id);
        let shown = view(&v, "school");
        assert_eq!(shown.grants.len(), 1);
        assert_eq!(shown.problems.len(), 1, "the hand-written entry is reported");
        assert!(view(&v, "work").grants.is_empty(), "grants are one-way");
        // ...but the space being read sees who can read it.
        assert!(shown.incoming.is_empty());
        assert_eq!(
            view(&v, "work").incoming,
            vec![IncomingGrantView { id: g.id.clone(), to: "school".into(), path: "calendar".into(), created: g.created.clone(), scope: Scope::Always }]
        );
        let json = serde_json::to_value(view(&v, "work")).unwrap();
        assert_eq!(json["incoming"][0]["to"], "school");
        assert!(json["grants"].as_array().unwrap().is_empty());
        let raw = fs::read_to_string(dir.join(".phaethon/grants.json")).unwrap();
        assert!(raw.contains("hand-written") && raw.contains("future"));
        assert!(revoke(&v, &g.id).unwrap());
        assert!(!revoke(&v, &g.id).unwrap());
        assert!(for_space(&v, "school").is_empty());
        assert!(fs::read_to_string(dir.join(".phaethon/grants.json")).unwrap().contains("hand-written"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn requests_are_checked() {
        let (dir, v) = vault("req");
        assert_eq!(check_request(&v, "school", "work", "calendar/").unwrap(), "calendar");
        assert_eq!(check_request(&v, "school", "@work", "calendar/oct.md").unwrap(), "calendar/oct.md");
        for (space, path) in [
            ("school", "x"),
            ("nope", "calendar"),
            ("../work", "calendar"),
            ("work", ""),
            ("work", "../school"),
            ("work", "/etc"),
            ("work", ".phaethon"),
            ("work", "missing"),
        ] {
            assert!(check_request(&v, "school", space, path).is_err(), "{space} {path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("spaces/work/out")).unwrap();
            assert!(check_request(&v, "school", "work", "out").is_err());
        }
        assert_eq!(other_spaces(&v, "school"), ["work"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cli_dirs_are_existing_granted_folders() {
        let (dir, v) = vault("cli");
        write_file(&dir, json!({"grants": [entry("a", "calendar"), entry("b", "calendar/oct.md"), entry("c", "missing")]}));
        let dirs = cli_dirs(&v, "school");
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].0, "work/calendar");
        assert!(dirs[0].1.ends_with("spaces/work/calendar"));
        assert!(cli_dirs(&v, "work").is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_are_unique_uuids() {
        let ids: HashSet<String> = (0..1000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 1000);
        assert!(ids.iter().all(|i| i.len() == 36 && &i[14..15] == "4"));
    }

    #[test]
    fn restore_puts_back_exactly_what_was_revoked() {
        let (vault, dir) = restore_vault();
        let g = add_always(&vault, "school", "work", "calendar").unwrap();
        // Nothing revoked yet: nothing to put back, and nothing is created.
        assert!(restore(&vault, &g.id).is_err());
        assert!(revoke(&vault, &g.id).unwrap());
        assert!(load(&vault).grants.is_empty());
        let back = restore(&vault, &g.id).unwrap();
        assert_eq!(back, g);
        assert_eq!(load(&vault).grants, vec![g.clone()]);
        // Once only: a second Undo has nothing to put back.
        assert!(restore(&vault, &g.id).is_err());
        assert_eq!(load(&vault).grants.len(), 1);
        // An id that was never revoked here can't be made up.
        assert!(restore(&vault, "x1").is_err());
        assert_eq!(load(&vault).grants.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn restore_vault() -> (Vault, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("phaethon-grant-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = Vault::at(&dir);
        vault.ensure_initialized().unwrap();
        (vault, dir)
    }
}
