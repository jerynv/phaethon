//! Files the user attaches to a message.
//!
//! Each upload is checked and saved as an ordinary file in the space,
//! `attachments/<YYYY-MM-DD>/<name>`, so it lives in the user's vault like
//! anything else. The thread keeps only a reference block
//! (`{"type": "steward_attachment", "path", "media_type", "name"}`); just before
//! each request it is expanded into the API's image or document block. The
//! expansion is deterministic, so the prompt cache keeps working.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::tools;

pub const MAX_FILES: usize = 10;
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_PDF: usize = 30 * 1024 * 1024;
const MAX_TEXT: usize = 1024 * 1024;
const MAX_TOTAL: usize = 30 * 1024 * 1024;
pub const FOLDER: &str = "attachments";

/// One file as the webview sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub name: String,
    pub media_type: String,
    /// Base64 of the file's bytes.
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Image,
    Pdf,
    Text,
}

fn kind(media_type: &str, name: &str) -> Option<Kind> {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match media_type {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => Some(Kind::Image),
        "application/pdf" => Some(Kind::Pdf),
        t if t.starts_with("text/") || t == "application/json" => Some(Kind::Text),
        // Browsers often send "" for .md and friends.
        _ if matches!(ext.as_str(), "md" | "markdown" | "txt" | "csv" | "json" | "tsv" | "log") => Some(Kind::Text),
        _ => None,
    }
}

/// A saved attachment, as stored in the thread.
pub fn reference(path: &str, media_type: &str, name: &str) -> Value {
    json!({"type": "steward_attachment", "path": path, "media_type": media_type, "name": name})
}

/// Check and save every upload, or none: on any error nothing is written.
/// Returns reference blocks, in order.
pub fn save(space: &Path, uploads: &[Upload]) -> Result<Vec<Value>, String> {
    if uploads.len() > MAX_FILES {
        return Err(format!("You can attach up to {MAX_FILES} files to one message."));
    }
    let mut decoded = vec![];
    let mut total = 0;
    for u in uploads {
        let k = kind(&u.media_type, &u.name).ok_or_else(|| {
            format!("{} is not a supported file type. Attach images (PNG, JPEG, GIF, WebP), PDFs or text files.", u.name)
        })?;
        let bytes = B64
            .decode(u.data.as_bytes())
            .map_err(|_| format!("{} could not be read.", u.name))?;
        let (limit, label) = match k {
            Kind::Image => (MAX_IMAGE, "5 MB for images"),
            Kind::Pdf => (MAX_PDF, "30 MB for PDFs"),
            Kind::Text => (MAX_TEXT, "1 MB for text files"),
        };
        if bytes.len() > limit {
            return Err(format!("{} is too large (the limit is {label}).", u.name));
        }
        if k == Kind::Text && std::str::from_utf8(&bytes).is_err() {
            return Err(format!("{} is not a plain text file.", u.name));
        }
        total += bytes.len();
        if total > MAX_TOTAL {
            return Err("These files are too large together (the limit is 30 MB per message).".into());
        }
        let media_type = match k {
            Kind::Text => "text/plain".to_string(),
            _ => u.media_type.clone(),
        };
        decoded.push((u, media_type, bytes));
    }
    let dir_rel = format!("{FOLDER}/{}", today());
    let dir = tools::resolve(space, &dir_rel, false)?;
    let mut refs = vec![];
    let mut written = vec![];
    for (u, media_type, bytes) in decoded {
        let name = clean_name(&u.name);
        let rel = unique(&dir, &dir_rel, &name);
        let full = tools::resolve(space, &rel, false)?;
        let result = fs::create_dir_all(&dir).and_then(|_| fs::write(&full, &bytes));
        if let Err(e) = result {
            for w in written {
                let _ = fs::remove_file(w);
            }
            return Err(format!("{} could not be saved: {e}", u.name));
        }
        written.push(full);
        refs.push(reference(&rel, &media_type, &u.name));
    }
    Ok(refs)
}

/// Replace reference blocks with what the API understands. A file that has
/// since been removed from the space becomes a short note instead.
pub fn expand(space: &Path, msgs: &[Value]) -> Vec<Value> {
    msgs.iter()
        .map(|m| {
            let Some(blocks) = m["content"].as_array() else { return m.clone() };
            if !blocks.iter().any(|b| b["type"] == "steward_attachment") {
                return m.clone();
            }
            let content: Vec<Value> = blocks
                .iter()
                .map(|b| if b["type"] == "steward_attachment" { expand_one(space, b) } else { b.clone() })
                .collect();
            json!({"role": m["role"], "content": content})
        })
        .collect()
}

fn expand_one(space: &Path, b: &Value) -> Value {
    let path = b["path"].as_str().unwrap_or("");
    let name = b["name"].as_str().unwrap_or(path);
    let media_type = b["media_type"].as_str().unwrap_or("");
    let missing = || json!({"type": "text", "text": format!("[The attached file {name} is no longer in this space.]")});
    let Ok(full) = tools::resolve(space, path, true) else { return missing() };
    let Ok(bytes) = fs::read(&full) else { return missing() };
    match kind(media_type, name) {
        Some(Kind::Image) => json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": B64.encode(&bytes)}}),
        Some(Kind::Pdf) => json!({"type": "document", "title": name, "source": {"type": "base64", "media_type": "application/pdf", "data": B64.encode(&bytes)}}),
        Some(Kind::Text) => json!({"type": "document", "title": name, "source": {"type": "text", "media_type": "text/plain", "data": String::from_utf8_lossy(&bytes)}}),
        None => missing(),
    }
}

/// Note added to a prompt for the CLI backend, which reads files itself.
pub fn cli_note(refs: &[Value]) -> String {
    if refs.is_empty() {
        return String::new();
    }
    let list: Vec<String> = refs
        .iter()
        .map(|r| format!("- {}", r["path"].as_str().unwrap_or("")))
        .collect();
    format!("\n\nThe user attached these files, saved in this folder:\n{}", list.join("\n"))
}

fn clean_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut s: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '-' })
        .collect();
    s = s.trim_start_matches(['.', ' ']).trim().to_string();
    if s.chars().count() > 100 {
        let ext = Path::new(&s).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        s = s.chars().take(100 - ext.chars().count()).collect::<String>() + &ext;
    }
    if s.is_empty() { "file".into() } else { s }
}

fn unique(dir: &Path, dir_rel: &str, name: &str) -> String {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.into());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut candidate = name.to_string();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    format!("{dir_rel}/{candidate}")
}

/// Today's date (UTC) as YYYY-MM-DD.
fn today() -> String {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    civil(days)
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(name: &str, media_type: &str, bytes: &[u8]) -> Upload {
        Upload { name: name.into(), media_type: media_type.into(), data: B64.encode(bytes) }
    }

    #[test]
    fn dates() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(20_735), "2026-10-09");
        assert_eq!(civil(11_016), "2000-02-29");
    }

    #[test]
    fn saves_checks_and_expands() {
        let space = std::env::temp_dir().join(format!("steward-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&space);
        fs::create_dir_all(&space).unwrap();

        let refs = save(&space, &[
            up("../../evil notes.md", "", b"# hi"),
            up("pic.png", "image/png", &[137, 80, 78, 71]),
            up("pic.png", "image/png", &[1, 2]),
        ])
        .unwrap();
        let paths: Vec<&str> = refs.iter().map(|r| r["path"].as_str().unwrap()).collect();
        assert!(paths[0].starts_with("attachments/") && paths[0].ends_with("/evil notes.md"), "{paths:?}");
        assert!(paths[2].ends_with("/pic (2).png"), "{paths:?}");
        assert_eq!(fs::read(space.join(paths[0])).unwrap(), b"# hi");

        let msgs = vec![json!({"role": "user", "content": [refs[0], refs[1], {"type": "text", "text": "look"}]})];
        let wire = expand(&space, &msgs);
        let c = &wire[0]["content"];
        assert_eq!(c[0]["type"], "document");
        assert_eq!(c[0]["source"]["data"], "# hi");
        assert_eq!(c[1]["source"]["data"], B64.encode([137, 80, 78, 71]));
        assert_eq!(c[2]["text"], "look");

        fs::remove_file(space.join(paths[1])).unwrap();
        assert_eq!(expand(&space, &msgs)[0]["content"][1]["type"], "text");

        // Bad input saves nothing at all.
        let before = fs::read_dir(space.join(paths[0]).parent().unwrap()).unwrap().count();
        assert!(save(&space, &[up("ok.txt", "text/plain", b"x"), up("a.exe", "application/x-msdownload", b"MZ")]).is_err());
        assert!(save(&space, &[up("bin.txt", "text/plain", &[0xff, 0xfe, 0x00])]).is_err());
        assert!(save(&space, &[up("big.png", "image/png", &vec![0; MAX_IMAGE + 1])]).is_err());
        assert_eq!(fs::read_dir(space.join(paths[0]).parent().unwrap()).unwrap().count(), before);
        fs::remove_dir_all(&space).unwrap();
    }
}
