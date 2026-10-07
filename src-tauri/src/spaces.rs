//! The spaces in a vault, as the sidebar and Settings show them.
//!
//! A space is any valid folder under `<vault>/spaces/` (see [`Vault::space_dir`]
//! for what valid means). Its display name, description and colour live in
//! `<space>/.phaethon/space.json`:
//!
//! ```json
//! { "name": "School", "description": "Courses, deadlines, study notes", "hue": 250 }
//! ```
//!
//! The file is user-editable and may sync, so every field is checked on the
//! way in and a bad one is ignored (its default is used) rather than failing
//! the whole space. Unknown fields are kept when Phaethon writes the file.
//! The folder name is the space's id: grants, threads and the agent's working
//! directory all use it, so renaming a space changes only its display name.
//! There is no delete: removing a space destroys its files, and that needs its
//! own confirmation flow.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::vault::{Vault, is_valid_space_id};

/// Longest display name, in characters.
pub const NAME_MAX: usize = 60;
/// Longest description, in characters.
pub const DESCRIPTION_MAX: usize = 160;
/// Largest space.json read. Real ones are well under 1 KiB.
const META_MAX_BYTES: u64 = 64 * 1024;
/// Longest id derived from a name (ids may be up to 64; room for "-99").
const SLUG_MAX: usize = 48;

/// One space as the webview gets it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SpaceView {
    pub id: String,
    pub name: String,
    pub description: String,
    /// oklch hue angle, 0 to 360.
    pub hue: u16,
}

/// Every valid space in the vault, sorted by name (then id). Folders that are
/// not valid spaces (bad names, symlinks, files, anything outside the vault)
/// are skipped. A vault without a `spaces/` folder has no spaces.
pub fn list(vault: &Vault) -> Result<Vec<SpaceView>, String> {
    let root = vault.root().join("spaces");
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("The spaces folder couldn’t be read: {e}")),
    };
    let mut out: Vec<SpaceView> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            // A symlink is never listed, even one that points at a sibling:
            // it would show the same files twice under two names.
            if !entry.file_type().ok()?.is_dir() || !is_valid_space_id(&id) {
                return None;
            }
            let dir = vault.space_dir(&id).ok()?;
            Some(view(&id, &dir))
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// Create a new space from a display name. The id is a slug of the name made
/// unique with `-2`, `-3`…; the folder and its space.json are created.
pub fn create(
    vault: &Vault,
    name: &str,
    description: Option<&str>,
    hue: Option<f64>,
) -> Result<SpaceView, String> {
    let name = check_name(name)?;
    let description = description.map(check_description).transpose()?;
    let hue = hue.map(check_hue).transpose()?;

    let spaces = vault.root().join("spaces");
    fs::create_dir_all(&spaces).map_err(|e| format!("The spaces folder couldn’t be created: {e}"))?;
    let base = slug(&name);
    let mut id = None;
    for n in 1..=999 {
        let candidate = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        // create_dir, not create_dir_all: it fails if anything (a folder, a
        // file, a link) already has the name, so two creates never share one.
        match fs::create_dir(spaces.join(&candidate)) {
            Ok(()) => {
                id = Some(candidate);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("The space’s folder couldn’t be created: {e}")),
        }
    }
    let id = id.ok_or("Too many spaces already have that name. Choose a different one.")?;
    let dir = vault.space_dir(&id)?;

    let mut meta = serde_json::Map::new();
    meta.insert("name".into(), name.into());
    if let Some(d) = description.filter(|d| !d.is_empty()) {
        meta.insert("description".into(), d.into());
    }
    meta.insert("hue".into(), hue.unwrap_or_else(|| default_hue(&id)).into());
    write_meta(&dir, &meta).map_err(|e| format!("The space was created, but its name couldn’t be saved: {e}"))?;
    Ok(view(&id, &dir))
}

/// Change a space's display name, description or colour. Fields left `None`
/// are not touched; an empty description clears it. Other fields in
/// space.json are kept. The folder (the id) never changes.
pub fn update(
    vault: &Vault,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    hue: Option<f64>,
) -> Result<SpaceView, String> {
    let dir = vault.space_dir(id)?;
    let name = name.map(check_name).transpose()?;
    let description = description.map(check_description).transpose()?;
    let hue = hue.map(check_hue).transpose()?;

    let file = meta_file(&dir);
    let mut meta = match read_meta_raw(&dir) {
        Ok(Some(serde_json::Value::Object(o))) => o,
        Ok(None) => serde_json::Map::new(),
        Ok(Some(_)) | Err(_) if file.exists() => {
            return Err(format!(
                "This space’s settings file can’t be read, so it wasn’t changed. Fix or delete {}.",
                file.display()
            ));
        }
        _ => serde_json::Map::new(),
    };
    if let Some(n) = name {
        meta.insert("name".into(), n.into());
    }
    if let Some(d) = description {
        meta.insert("description".into(), d.into());
    }
    if let Some(h) = hue {
        meta.insert("hue".into(), h.into());
    }
    write_meta(&dir, &meta).map_err(|e| format!("The change couldn’t be saved: {e}"))?;
    Ok(view(id, &dir))
}

/// The space as shown: space.json's fields where they pass the checks, the
/// defaults for the rest.
fn view(id: &str, dir: &Path) -> SpaceView {
    let meta = read_meta_raw(dir).ok().flatten();
    let field = |k: &str| meta.as_ref().and_then(|m| m.get(k));
    SpaceView {
        id: id.to_string(),
        name: field("name")
            .and_then(|v| v.as_str())
            .and_then(|s| check_name(s).ok())
            .unwrap_or_else(|| default_name(id)),
        description: field("description")
            .and_then(|v| v.as_str())
            .and_then(|s| check_description(s).ok())
            .unwrap_or_default(),
        hue: field("hue")
            .and_then(|v| v.as_f64())
            .and_then(|h| check_hue(h).ok())
            .unwrap_or_else(|| default_hue(id)),
    }
}

fn meta_file(dir: &Path) -> PathBuf {
    dir.join(".phaethon").join("space.json")
}

/// space.json as JSON, `None` when it does not exist. Refuses a `.phaethon`
/// folder or space.json that is a symlink (it could point outside the vault),
/// anything that is not a plain file, and anything too large.
fn read_meta_raw(dir: &Path) -> io::Result<Option<serde_json::Value>> {
    let state = dir.join(".phaethon");
    match state.symlink_metadata() {
        Ok(m) if !m.is_dir() => return Err(io::Error::other(".phaethon is not a folder")),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    }
    let file = meta_file(dir);
    let m = match file.symlink_metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !m.is_file() || m.len() > META_MAX_BYTES {
        return Err(io::Error::other("space.json is not a small plain file"));
    }
    let text = fs::read_to_string(&file)?;
    serde_json::from_str(&text).map(Some).map_err(io::Error::other)
}

/// Write space.json through a temporary file and a rename, so a crash never
/// leaves half a file.
fn write_meta(dir: &Path, meta: &serde_json::Map<String, serde_json::Value>) -> io::Result<()> {
    let state = dir.join(".phaethon");
    if state.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
        return Err(io::Error::other(".phaethon in this space is not a folder"));
    }
    fs::create_dir_all(&state)?;
    let file = meta_file(dir);
    if file.symlink_metadata().is_ok_and(|m| !m.is_file()) {
        return Err(io::Error::other("space.json in this space is not a plain file"));
    }
    let tmp = state.join("space.json.tmp");
    let mut bytes = serde_json::to_vec_pretty(meta)?;
    bytes.push(b'\n');
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, file)
}

/// Trimmed, 1 to 60 characters, no control characters.
fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A space needs a name.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("A space’s name can be at most {NAME_MAX} characters."));
    }
    if name.chars().any(char::is_control) {
        return Err("A space’s name can’t contain line breaks or tabs.".into());
    }
    Ok(name.to_string())
}

/// Trimmed, at most 160 characters, no control characters. May be empty.
fn check_description(d: &str) -> Result<String, String> {
    let d = d.trim();
    if d.chars().count() > DESCRIPTION_MAX {
        return Err(format!("A description can be at most {DESCRIPTION_MAX} characters."));
    }
    if d.chars().any(char::is_control) {
        return Err("A description can’t contain line breaks or tabs.".into());
    }
    Ok(d.to_string())
}

/// A finite angle from 0 to 360, rounded to a whole degree.
fn check_hue(h: f64) -> Result<u16, String> {
    if !h.is_finite() || !(0.0..=360.0).contains(&h) {
        return Err("A colour must be a hue from 0 to 360.".into());
    }
    Ok(h.round() as u16)
}

/// "side-project_2" shows as "Side project 2".
fn default_name(id: &str) -> String {
    let spaced: String = id.chars().map(|c| if c == '-' || c == '_' { ' ' } else { c }).collect();
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A colour for a space with none saved: the built-in spaces keep the hues
/// they always had; any other id gets a stable hue from a hash of the id,
/// stepped by the golden angle so different ids land far apart on the wheel.
pub fn default_hue(id: &str) -> u16 {
    match id {
        "school" => 250,
        "work" => 55,
        _ => {
            // FNV-1a: stable across runs and platforms (std's hasher is not).
            let hash = id
                .bytes()
                .fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
            ((f64::from(hash % 1000) * 137.507_764) % 360.0).round() as u16 % 360
        }
    }
}

/// A folder name from a display name: lowercase ASCII letters and digits, runs
/// of anything else as one dash, at most 48 characters, "space" if nothing is
/// left (a name in another script, or only symbols).
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= SLUG_MAX {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "space".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_vault(tag: &str) -> (PathBuf, Vault) {
        let root = std::env::temp_dir().join(format!("phaethon-spaces-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let vault = Vault::at(&root);
        vault.ensure_initialized().unwrap();
        (root, vault)
    }

    fn ids(v: &[SpaceView]) -> Vec<&str> {
        v.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn defaults_for_a_fresh_vault() {
        let (root, vault) = temp_vault("fresh");
        let spaces = list(&vault).unwrap();
        assert_eq!(
            spaces,
            vec![
                SpaceView { id: "school".into(), name: "School".into(), description: String::new(), hue: 250 },
                SpaceView { id: "work".into(), name: "Work".into(), description: String::new(), hue: 55 },
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_added_by_hand_appears_sorted_by_name() {
        let (root, vault) = temp_vault("added");
        fs::create_dir(root.join("spaces/side-project_2")).unwrap();
        fs::create_dir(root.join("spaces/art")).unwrap();
        let spaces = list(&vault).unwrap();
        assert_eq!(ids(&spaces), ["art", "school", "side-project_2", "work"]);
        assert_eq!(spaces[2].name, "Side project 2");
        assert_eq!(spaces[2].hue, default_hue("side-project_2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_entries_are_skipped() {
        let (root, vault) = temp_vault("invalid");
        let s = root.join("spaces");
        fs::create_dir(s.join("Capitals")).unwrap();
        fs::create_dir(s.join(".hidden")).unwrap();
        fs::create_dir(s.join("has space")).unwrap();
        fs::write(s.join("notes.md"), "a file, not a space").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("memory"), s.join("sneaky")).unwrap();
            std::os::unix::fs::symlink(s.join("school"), s.join("alias")).unwrap();
            std::os::unix::fs::symlink("/", s.join("rootlink")).unwrap();
        }
        assert_eq!(ids(&list(&vault).unwrap()), ["school", "work"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_spaces_folder_means_no_spaces() {
        let root = std::env::temp_dir().join(format!("phaethon-spaces-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(list(&Vault::at(&root)).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_is_read_and_bad_fields_are_ignored() {
        let (root, vault) = temp_vault("meta");
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), r#"{"name":"  Uni  ","description":"Lectures","hue":300.4,"future":true}"#).unwrap();
        let school = list(&vault).unwrap().into_iter().find(|s| s.id == "school").unwrap();
        assert_eq!((school.name.as_str(), school.description.as_str(), school.hue), ("Uni", "Lectures", 300));

        for bad in [
            json!({ "name": "", "description": 5, "hue": 361 }),
            json!({ "name": "x".repeat(61), "description": "d".repeat(161), "hue": -1 }),
            json!({ "name": "Two\nlines", "description": "tab\there", "hue": "250" }),
            json!({ "name": null, "hue": null }),
            json!(["not", "an", "object"]),
        ] {
            fs::write(state.join("space.json"), bad.to_string()).unwrap();
            let s = view("school", &root.join("spaces/school"));
            assert_eq!(s, SpaceView { id: "school".into(), name: "School".into(), description: String::new(), hue: 250 }, "{bad}");
        }
        fs::write(state.join("space.json"), "{ not json").unwrap();
        assert_eq!(view("school", &root.join("spaces/school")).name, "School");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn metadata_symlinks_are_not_followed() {
        let (root, vault) = temp_vault("metalink");
        fs::write(root.join("outside.json"), r#"{"name":"Leaked"}"#).unwrap();
        let state = root.join("spaces/school/.phaethon");
        fs::create_dir_all(&state).unwrap();
        std::os::unix::fs::symlink(root.join("outside.json"), state.join("space.json")).unwrap();
        assert_eq!(view("school", &root.join("spaces/school")).name, "School");
        // Nor written through: an update refuses rather than overwrite the target.
        assert!(update(&vault, "school", Some("New"), None, None).is_err());
        assert!(fs::read_to_string(root.join("outside.json")).unwrap().contains("Leaked"));

        let work = root.join("spaces/work");
        fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), work.join(".phaethon")).unwrap();
        assert!(update(&vault, "work", Some("New"), None, None).is_err());
        assert!(!root.join("elsewhere/space.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_derives_a_unique_id_and_saves_metadata() {
        let (root, vault) = temp_vault("create");
        let a = create(&vault, "  Side Project! ", Some("Weekend things"), Some(130.0)).unwrap();
        assert_eq!(a, SpaceView { id: "side-project".into(), name: "Side Project!".into(), description: "Weekend things".into(), hue: 130 });
        let b = create(&vault, "side project", None, None).unwrap();
        assert_eq!(b.id, "side-project-2");
        assert_eq!(b.hue, default_hue("side-project-2"));
        assert_eq!(create(&vault, "Side—Project", None, None).unwrap().id, "side-project-3");
        // A file with the name is in the way too.
        fs::write(root.join("spaces/home"), "").unwrap();
        assert_eq!(create(&vault, "Home", None, None).unwrap().id, "home-2");
        assert_eq!(create(&vault, "School", None, None).unwrap().id, "school-2");
        assert_eq!(create(&vault, "日本語", None, None).unwrap().id, "space");
        assert_eq!(create(&vault, "..", None, None).unwrap().id, "space-2");
        let long = create(&vault, &"a".repeat(60), None, None).unwrap();
        assert_eq!(long.id.len(), SLUG_MAX);

        let listed = list(&vault).unwrap();
        assert!(listed.contains(&a));
        let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("spaces/side-project/.phaethon/space.json")).unwrap()).unwrap();
        assert_eq!(saved, json!({ "name": "Side Project!", "description": "Weekend things", "hue": 130 }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_refuses_bad_input() {
        let (root, vault) = temp_vault("create-bad");
        for (name, desc, hue) in [
            ("", None, None),
            ("   ", None, None),
            (&*"x".repeat(61), None, None),
            ("Two\nlines", None, None),
            ("Ok", Some(&*"d".repeat(161)), None),
            ("Ok", None, Some(-1.0)),
            ("Ok", None, Some(360.5)),
            ("Ok", None, Some(f64::NAN)),
        ] {
            assert!(create(&vault, name, desc, hue).is_err(), "{name:?} {desc:?} {hue:?}");
        }
        assert_eq!(ids(&list(&vault).unwrap()), ["school", "work"], "nothing was created");
        assert_eq!(create(&vault, "", None, None).unwrap_err(), "A space needs a name.");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_changes_only_what_is_given_and_keeps_unknown_fields() {
        let (root, vault) = temp_vault("update");
        let state = root.join("spaces/work/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), r#"{"name":"Work","future":{"x":1}}"#).unwrap();
        fs::write(state.join("session"), "kept").unwrap();

        let w = update(&vault, "work", Some("Job"), None, None).unwrap();
        assert_eq!((w.id.as_str(), w.name.as_str(), w.hue), ("work", "Job", 55));
        let w = update(&vault, "work", None, Some("Meetings"), Some(200.0)).unwrap();
        assert_eq!((w.name.as_str(), w.description.as_str(), w.hue), ("Job", "Meetings", 200));
        let w = update(&vault, "work", None, Some(""), None).unwrap();
        assert_eq!(w.description, "");

        let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(state.join("space.json")).unwrap()).unwrap();
        assert_eq!(saved, json!({ "name": "Job", "description": "", "hue": 200, "future": { "x": 1 } }));
        assert!(!state.join("space.json.tmp").exists());
        assert_eq!(fs::read_to_string(state.join("session")).unwrap(), "kept");
        assert!(root.join("spaces/work").is_dir() && !root.join("spaces/job").exists(), "the folder keeps its id");

        // A space with no .phaethon folder yet.
        assert_eq!(update(&vault, "school", Some("Uni"), None, None).unwrap().name, "Uni");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_refuses_bad_input_and_unknown_spaces() {
        let (root, vault) = temp_vault("update-bad");
        assert!(update(&vault, "work", Some(" "), None, None).is_err());
        assert!(update(&vault, "work", None, Some(&"d".repeat(161)), None).is_err());
        assert!(update(&vault, "work", None, None, Some(400.0)).is_err());
        for id in ["nope", "../memory", "", "School", ".phaethon", "work/../school"] {
            assert!(update(&vault, id, Some("X"), None, None).is_err(), "{id:?}");
        }
        assert!(!root.join("memory/.phaethon").exists());
        // A broken space.json is not overwritten.
        let state = root.join("spaces/work/.phaethon");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("space.json"), "{ broken").unwrap();
        let err = update(&vault, "work", Some("X"), None, None).unwrap_err();
        assert!(err.contains("can’t be read"), "{err}");
        assert_eq!(fs::read_to_string(state.join("space.json")).unwrap(), "{ broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slugs_and_names() {
        assert_eq!(slug("School"), "school");
        assert_eq!(slug("  My  Big -- Plan! 2026 "), "my-big-plan-2026");
        assert_eq!(slug("Café"), "caf");
        assert_eq!(slug("!!!"), "space");
        assert!(is_valid_space_id(&slug(&"Ab".repeat(40))));
        assert_eq!(default_name("side-project_2"), "Side project 2");
        assert_eq!(default_name("2026"), "2026");
    }

    #[test]
    fn default_hues_are_stable_and_spread() {
        assert_eq!(default_hue("school"), 250);
        assert_eq!(default_hue("work"), 55);
        assert_eq!(default_hue("garden"), default_hue("garden"));
        let hues: Vec<u16> = ["home", "garden", "music", "health", "travel", "money"].iter().map(|i| default_hue(i)).collect();
        assert!(hues.iter().all(|h| *h < 360));
        let distinct: std::collections::HashSet<_> = hues.iter().collect();
        assert!(distinct.len() >= 5, "{hues:?}");
    }
}
