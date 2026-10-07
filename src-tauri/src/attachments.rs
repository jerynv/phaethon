//! Files the user attaches to a message.
//!
//! Each upload is checked and saved as an ordinary file in the space,
//! `attachments/<YYYY-MM-DD>/<name>`, so it lives in the user's vault like
//! anything else. The thread keeps only a reference block
//! (`{"type": "phaethon_attachment", "path", "media_type", "name"}`); just before
//! each request it is expanded into the API's image or document block. The
//! expansion is deterministic, so the prompt cache keeps working.
//!
//! What is accepted: PNG, JPEG, GIF and WebP images (checked by their bytes);
//! HEIC/HEIF photos, converted to JPEG with macOS's `sips` first; PDFs; Word
//! documents (.docx), sent as their text; and any file whose bytes are UTF-8
//! text, whatever its name or type says (source code, Cargo.toml, .env files).

use std::fs;
use std::io::Write;
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
/// A HEIC photo before conversion; the JPEG must still fit [`MAX_IMAGE`].
const MAX_HEIC: usize = 30 * 1024 * 1024;
const MAX_DOCX: usize = 30 * 1024 * 1024;
/// Largest `word/document.xml` unpacked from a .docx (guards against zip bombs).
const MAX_DOCX_XML: usize = 64 * 1024 * 1024;
const MAX_TOTAL: usize = 30 * 1024 * 1024;
pub const FOLDER: &str = "attachments";
const DOCX_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
    Docx,
    /// Only on the way in: converted to a JPEG image before it is saved.
    Heic,
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// The kind a file says it is, by its media type or extension. Text is not
/// decided here: any file that says nothing else is checked for text by its bytes.
fn declared_kind(media_type: &str, name: &str) -> Option<Kind> {
    match (media_type, extension(name).as_str()) {
        ("image/png" | "image/jpeg" | "image/gif" | "image/webp", _) | (_, "png" | "jpg" | "jpeg" | "gif" | "webp") => {
            Some(Kind::Image)
        }
        ("image/heic" | "image/heif" | "image/heic-sequence" | "image/heif-sequence", _) | (_, "heic" | "heif") => {
            Some(Kind::Heic)
        }
        ("application/pdf", _) | (_, "pdf") => Some(Kind::Pdf),
        (DOCX_TYPE, _) | (_, "docx") => Some(Kind::Docx),
        _ => None,
    }
}

/// How a saved reference is expanded, from the media type saved with it.
fn stored_kind(media_type: &str) -> Option<Kind> {
    match media_type {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => Some(Kind::Image),
        "application/pdf" => Some(Kind::Pdf),
        DOCX_TYPE => Some(Kind::Docx),
        t if t.starts_with("text/") || t == "application/json" => Some(Kind::Text),
        _ => None,
    }
}

/// An image's real type, from its first bytes.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A HEIC/HEIF photo, by its `ftyp` box, whatever its name says.
fn is_heic(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"mif1" | b"msf1")
}

/// UTF-8 text with no NUL bytes (UTF-16 and binary files have them).
fn is_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

/// A reference block, under its current name or the one it had before the
/// app was renamed (threads saved then still load).
pub fn is_attachment_ref(b: &Value) -> bool {
    matches!(b["type"].as_str(), Some("phaethon_attachment" | "steward_attachment"))
}

/// A saved attachment, as stored in the thread.
pub fn reference(path: &str, media_type: &str, name: &str) -> Value {
    json!({"type": "phaethon_attachment", "path": path, "media_type": media_type, "name": name})
}

/// One upload, checked and ready to write.
struct Ready<'a> {
    upload: &'a Upload,
    /// The name it is saved under (a HEIC photo becomes `<name>.jpg`).
    file_name: String,
    media_type: String,
    bytes: Vec<u8>,
}

/// Check one upload. `Err` says why it was refused, to follow its name.
fn prepare(u: &Upload) -> Result<Ready<'_>, String> {
    let bytes = B64
        .decode(u.data.as_bytes())
        .map_err(|_| "it couldn’t be read".to_string())?;
    let too_big = |limit: &str| format!("it’s too large (the limit is {limit})");
    let ready = |media_type: &str, bytes: Vec<u8>| Ready {
        upload: u,
        file_name: u.name.clone(),
        media_type: media_type.to_string(),
        bytes,
    };
    // Phones sometimes label HEIC photos as JPEG; the bytes decide.
    let kind = if is_heic(&bytes) { Some(Kind::Heic) } else { declared_kind(&u.media_type, &u.name) };
    match kind {
        Some(Kind::Image) => {
            if bytes.len() > MAX_IMAGE {
                return Err(too_big("5 MB for images"));
            }
            // The real type, not the claimed one: a mislabelled image would be refused by the model.
            let t = image_type(&bytes).ok_or("it isn’t a PNG, JPEG, GIF or WebP image")?;
            Ok(ready(t, bytes))
        }
        Some(Kind::Heic) => {
            if bytes.len() > MAX_HEIC {
                return Err(too_big("30 MB for HEIC photos"));
            }
            let jpeg = heic_to_jpeg(&bytes)?;
            if jpeg.len() > MAX_IMAGE {
                return Err(too_big("5 MB for images, after converting it to JPEG"));
            }
            let stem = Path::new(&u.name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(Ready { file_name: format!("{stem}.jpg"), ..ready("image/jpeg", jpeg) })
        }
        Some(Kind::Pdf) => {
            if bytes.len() > MAX_PDF {
                return Err(too_big("30 MB for PDFs"));
            }
            if !bytes.starts_with(b"%PDF-") {
                return Err("it isn’t a PDF".into());
            }
            Ok(ready("application/pdf", bytes))
        }
        Some(Kind::Docx) => {
            if bytes.len() > MAX_DOCX {
                return Err(too_big("30 MB for Word documents"));
            }
            let text = docx_text(&bytes)?;
            if text.len() > MAX_TEXT {
                return Err("it has more text than one message can carry (1 MB of text)".into());
            }
            Ok(ready(DOCX_TYPE, bytes))
        }
        Some(Kind::Text) | None => {
            if !is_text(&bytes) {
                return Err(
                    "it isn’t a kind of file Phaethon can read. Attach images, PDFs, Word documents (.docx) or text files".into(),
                );
            }
            if bytes.len() > MAX_TEXT {
                return Err(too_big("1 MB for text files"));
            }
            Ok(ready("text/plain", bytes))
        }
    }
}

/// Check and save every upload, or none: on any error nothing is written.
/// Returns reference blocks, in order. When files are refused, one message
/// names each of them and why.
pub fn save(space: &Path, uploads: &[Upload]) -> Result<Vec<Value>, String> {
    if uploads.len() > MAX_FILES {
        return Err(format!("You can attach up to {MAX_FILES} files to one message."));
    }
    let mut ready = vec![];
    let mut refused = vec![];
    for u in uploads {
        match prepare(u) {
            Ok(r) => ready.push(r),
            Err(why) => refused.push(format!("{}: {why}.", display_name(&u.name))),
        }
    }
    match refused.len() {
        0 => {}
        1 => return Err(format!("This file wasn’t attached, so nothing was sent. {}", refused[0])),
        _ => return Err(format!("These files weren’t attached, so nothing was sent.\n{}", refused.join("\n"))),
    }
    if ready.iter().map(|r| r.bytes.len()).sum::<usize>() > MAX_TOTAL {
        return Err("These files are too large together (the limit is 30 MB per message), so nothing was sent.".into());
    }
    let dir_rel = format!("{FOLDER}/{}", today());
    let dir = tools::resolve(space, &dir_rel, false)?;
    let mut refs = vec![];
    let mut written = vec![];
    for r in ready {
        let name = clean_name(&r.file_name);
        let saved = fs::create_dir_all(&dir)
            .and_then(|_| tools::resolve(space, &dir_rel, true).map_err(std::io::Error::other))
            .and_then(|real_dir| create_unique(&real_dir, &name, &r.bytes));
        match saved {
            Ok((candidate, full)) => {
                written.push(full);
                refs.push(reference(&format!("{dir_rel}/{candidate}"), &r.media_type, &r.upload.name));
            }
            Err(e) => {
                for w in written {
                    let _ = fs::remove_file(w);
                }
                return Err(format!("{} could not be saved: {e}", display_name(&r.upload.name)));
            }
        }
    }
    Ok(refs)
}

/// A name as the user knows it, without any folders the browser included.
fn display_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "A file".into())
}

/// Write `bytes` to a new file in `dir` named `name`, or `name (2)`, ...
/// The file is created exclusively, so an existing file or a symlink planted
/// under that name is never written through.
fn create_unique(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<(String, std::path::PathBuf)> {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.into());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 1..10_000 {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem} ({n}){ext}") };
        let full = dir.join(&candidate);
        match fs::OpenOptions::new().write(true).create_new(true).open(&full) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(bytes) {
                    let _ = fs::remove_file(&full);
                    return Err(e);
                }
                return Ok((candidate, full));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("too many files with this name"))
}

/// Replace reference blocks with what the API understands. A file that has
/// since been removed from the space becomes a short note instead.
pub fn expand(space: &Path, msgs: &[Value]) -> Vec<Value> {
    msgs.iter()
        .map(|m| {
            let Some(blocks) = m["content"].as_array() else { return m.clone() };
            if !blocks.iter().any(is_attachment_ref) {
                return m.clone();
            }
            let content: Vec<Value> = blocks
                .iter()
                .map(|b| if is_attachment_ref(b) { expand_one(space, b) } else { b.clone() })
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
    let kind = stored_kind(media_type);
    let text_doc = |text: &str| json!({"type": "document", "title": name, "source": {"type": "text", "media_type": "text/plain", "data": text}});
    match kind {
        Some(Kind::Image) => json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": B64.encode(&bytes)}}),
        Some(Kind::Pdf) => json!({"type": "document", "title": name, "source": {"type": "base64", "media_type": "application/pdf", "data": B64.encode(&bytes)}}),
        Some(Kind::Docx) => match docx_text(&bytes) {
            Ok(text) => text_doc(&text),
            Err(_) => json!({"type": "text", "text": format!("[The attached Word document {name} can no longer be read.]")}),
        },
        Some(Kind::Text) => text_doc(&String::from_utf8_lossy(&bytes)),
        _ => missing(),
    }
}

// ---- HEIC photos ----------------------------------------------------------

/// Convert a HEIC/HEIF photo to JPEG with macOS's own `sips`, through a
/// private temporary folder that is removed afterwards. No shell is involved.
#[cfg(target_os = "macos")]
fn heic_to_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!(
        "phaethon-heic-{}-{nanos}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let failed = || "it couldn’t be converted from HEIC to JPEG".to_string();
    // create_dir, not create_dir_all: the folder must be new, and ours.
    fs::create_dir(&dir).map_err(|_| failed())?;
    let (input, output) = (dir.join("photo.heic"), dir.join("photo.jpg"));
    let converted = fs::write(&input, bytes).ok().and_then(|_| {
        Command::new("/usr/bin/sips")
            .args(["-s", "format", "jpeg"])
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .filter(|s| s.success())
            .and_then(|_| fs::read(&output).ok())
    });
    let _ = fs::remove_dir_all(&dir);
    converted.filter(|j| image_type(j) == Some("image/jpeg")).ok_or_else(failed)
}

#[cfg(not(target_os = "macos"))]
fn heic_to_jpeg(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("HEIC photos can be attached only on a Mac for now. Save it as a JPEG first, then attach that".into())
}

// ---- Word documents -------------------------------------------------------

fn u16_at(b: &[u8], i: usize) -> Option<usize> {
    b.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)
}

fn u32_at(b: &[u8], i: usize) -> Option<usize> {
    b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// One file's bytes from a zip archive, by exact name. Just enough of the
/// format for .docx: the central directory, stored or deflated entries, no
/// zip64 or encryption.
fn zip_entry(zip: &[u8], wanted: &str, limit: usize) -> Option<Vec<u8>> {
    // End of central directory: 22 bytes plus a comment of up to 64 KiB.
    let floor = zip.len().saturating_sub(22 + 0xFFFF);
    let eocd = (floor..=zip.len().checked_sub(22)?).rev().find(|&i| zip[i..].starts_with(b"PK\x05\x06"))?;
    let entries = u16_at(zip, eocd + 10)?;
    let mut at = u32_at(zip, eocd + 16)?;
    for _ in 0..entries {
        if !zip.get(at..)?.starts_with(b"PK\x01\x02") {
            return None;
        }
        let flags = u16_at(zip, at + 8)?;
        let method = u16_at(zip, at + 10)?;
        let compressed = u32_at(zip, at + 20)?;
        let size = u32_at(zip, at + 24)?;
        let (name_len, extra_len, comment_len) = (u16_at(zip, at + 28)?, u16_at(zip, at + 30)?, u16_at(zip, at + 32)?);
        let local = u32_at(zip, at + 42)?;
        let name = zip.get(at + 46..at + 46 + name_len)?;
        if name == wanted.as_bytes() {
            if flags & 1 != 0 || size > limit {
                return None;
            }
            if !zip.get(local..)?.starts_with(b"PK\x03\x04") {
                return None;
            }
            let start = local + 30 + u16_at(zip, local + 26)? + u16_at(zip, local + 28)?;
            let data = zip.get(start..start.checked_add(compressed)?)?;
            return match method {
                0 => Some(data.to_vec()),
                8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, limit).ok(),
                _ => None,
            };
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    None
}

/// The text of a .docx: each paragraph on its own line, tabs and line breaks kept.
fn docx_text(bytes: &[u8]) -> Result<String, String> {
    let unreadable = || "it couldn’t be read as a Word document (.docx)".to_string();
    let xml = zip_entry(bytes, "word/document.xml", MAX_DOCX_XML).ok_or_else(unreadable)?;
    let xml = String::from_utf8(xml).map_err(|_| unreadable())?;
    let mut out = String::new();
    let mut in_text = false;
    let mut rest = xml.as_str();
    while let Some(open) = rest.find('<') {
        if in_text {
            out.push_str(&unescape(&rest[..open]));
        }
        let Some(close) = rest[open..].find('>') else { break };
        let tag = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        let self_closing = tag.ends_with('/');
        let name = tag.trim_end_matches('/').split(|c: char| c.is_whitespace()).next().unwrap_or("");
        match name {
            "w:t" => in_text = !self_closing,
            "/w:t" => in_text = false,
            "w:tab" => out.push('\t'),
            "w:br" | "w:cr" => out.push('\n'),
            "/w:p" => out.push('\n'),
            _ => {}
        }
    }
    Ok(out.trim_end().to_string())
}

/// XML's five named entities and numeric character references.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .map(|h| u32::from_str_radix(h, 16).ok())
                .unwrap_or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
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

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10];

    fn temp_space(tag: &str) -> std::path::PathBuf {
        let space = std::env::temp_dir().join(format!("phaethon-attach-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&space);
        fs::create_dir_all(&space).unwrap();
        space
    }

    /// A zip archive with the given entries, stored or deflated.
    fn zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = vec![];
        let mut central = vec![];
        for (name, data, deflate) in entries {
            let packed = if *deflate { miniz_oxide::deflate::compress_to_vec(data, 6) } else { data.to_vec() };
            let method: u16 = if *deflate { 8 } else { 0 };
            let offset = out.len() as u32;
            let sizes = |v: &mut Vec<u8>| {
                v.extend_from_slice(&0u32.to_le_bytes()); // crc, not checked
                v.extend_from_slice(&(packed.len() as u32).to_le_bytes());
                v.extend_from_slice(&(data.len() as u32).to_le_bytes());
                v.extend_from_slice(&(name.len() as u16).to_le_bytes());
                v.extend_from_slice(&0u16.to_le_bytes());
            };
            out.extend_from_slice(b"PK\x03\x04\x14\0\0\0");
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            sizes(&mut out);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&packed);
            central.extend_from_slice(b"PK\x01\x02\x14\0\x14\0\0\0");
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 4]);
            sizes(&mut central);
            central.extend_from_slice(&[0; 8]); // comment length, disk, internal and external attributes
            central.extend_from_slice(&[0; 2]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0; 2]);
        out
    }

    const DOC_XML: &str = r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Test 1</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> Oct 14 &amp; 16 </w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two &#x2014; &lt;ok&gt; &#233;</w:t><w:t/></w:r></w:p></w:body></w:document>"#;

    #[test]
    fn dates() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(20_735), "2026-10-09");
        assert_eq!(civil(11_016), "2000-02-29");
    }

    #[test]
    fn saves_checks_and_expands() {
        let space = temp_space("basic");
        let refs = save(&space, &[
            up("../../evil notes.md", "", b"# hi"),
            up("pic.png", "image/png", PNG),
            // Labelled PNG but really a JPEG: saved with its real type.
            up("pic.png", "image/png", JPEG),
        ])
        .unwrap();
        let paths: Vec<&str> = refs.iter().map(|r| r["path"].as_str().unwrap()).collect();
        assert!(paths[0].starts_with("attachments/") && paths[0].ends_with("/evil notes.md"), "{paths:?}");
        assert!(paths[2].ends_with("/pic (2).png"), "{paths:?}");
        assert_eq!(refs[2]["media_type"], "image/jpeg");
        assert_eq!(fs::read(space.join(paths[0])).unwrap(), b"# hi");

        let msgs = vec![json!({"role": "user", "content": [refs[0], refs[1], {"type": "text", "text": "look"}]})];
        let wire = expand(&space, &msgs);
        let c = &wire[0]["content"];
        assert_eq!(c[0]["type"], "document");
        assert_eq!(c[0]["source"]["data"], "# hi");
        assert_eq!(c[1]["source"]["data"], B64.encode(PNG));
        assert_eq!(c[2]["text"], "look");

        fs::remove_file(space.join(paths[1])).unwrap();
        assert_eq!(expand(&space, &msgs)[0]["content"][1]["type"], "text");

        // Bad input saves nothing at all.
        let before = fs::read_dir(space.join(paths[0]).parent().unwrap()).unwrap().count();
        assert!(save(&space, &[up("ok.txt", "text/plain", b"x"), up("a.exe", "application/x-msdownload", b"MZ\0\0")]).is_err());
        assert!(save(&space, &[up("bin.txt", "text/plain", &[0xff, 0xfe, 0x00])]).is_err());
        assert!(save(&space, &[up("big.png", "image/png", &vec![0; MAX_IMAGE + 1])]).is_err());
        assert!(save(&space, &[up("fake.png", "image/png", b"not an image")]).is_err());
        assert!(save(&space, &[up("fake.pdf", "application/pdf", b"hello")]).is_err());
        assert_eq!(fs::read_dir(space.join(paths[0]).parent().unwrap()).unwrap().count(), before);
        fs::remove_dir_all(&space).unwrap();
    }

    #[test]
    fn any_utf8_text_is_accepted_by_its_bytes() {
        let space = temp_space("sniff");
        let files = [
            up("main.rs", "", b"fn main() {}\n"),
            up("Cargo.toml", "application/toml", b"[package]\nname = \"x\"\n"),
            up(".env.example", "application/octet-stream", b"API_URL=https://example.com\n"),
            up("Makefile", "", "build:\n\tcargo build # \u{2713}\n".as_bytes()),
            up("notes.weird", "application/x-unknown", b""),
        ];
        let refs = save(&space, &files).unwrap();
        assert_eq!(refs.len(), 5);
        assert!(refs.iter().all(|r| r["media_type"] == "text/plain"), "{refs:?}");
        // The name shown is the user's; the file saved has no leading dot.
        assert_eq!(refs[2]["name"], ".env.example");
        assert!(refs[2]["path"].as_str().unwrap().ends_with("/env.example"));
        let wire = expand(&space, &[json!({"role": "user", "content": refs})]);
        assert_eq!(wire[0]["content"][1]["source"]["data"], "[package]\nname = \"x\"\n");
        assert_eq!(wire[0]["content"][1]["title"], "Cargo.toml");

        // Binary (NULs, invalid UTF-8, UTF-16) and over-size text are refused,
        // and one message names every refused file and why.
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("hi".encode_utf16().flat_map(|u| u.to_le_bytes()));
        let err = save(&space, &[
            up("ok.md", "", b"fine"),
            up("program", "", &[0x7f, b'E', b'L', b'F', 0, 1]),
            up("latin1.csv", "text/csv", &[b'c', 0xE9]),
            up("utf16.txt", "text/plain", &utf16),
            up("huge.log", "", &vec![b'a'; MAX_TEXT + 1]),
        ])
        .unwrap_err();
        assert!(err.starts_with("These files weren’t attached, so nothing was sent."), "{err}");
        for name in ["program:", "latin1.csv:", "utf16.txt:", "huge.log: it’s too large (the limit is 1 MB for text files)."] {
            assert!(err.contains(name), "{name} missing from: {err}");
        }
        assert!(!err.contains("ok.md"));
        let one = save(&space, &[up("a.bin", "", &[0, 1, 2])]).unwrap_err();
        assert!(one.starts_with("This file wasn’t attached") && one.contains("a.bin: it isn’t a kind of file"), "{one}");
        fs::remove_dir_all(&space).unwrap();
    }

    #[test]
    fn docx_becomes_text() {
        assert_eq!(docx_text(&zip(&[("word/document.xml", DOC_XML.as_bytes(), false)])).unwrap(), "Test 1\t Oct 14 & 16 \nLine\ntwo — <ok> é");
        let deflated = zip(&[
            ("[Content_Types].xml", b"<Types/>", true),
            ("word/styles.xml", b"<w:styles/>", true),
            ("word/document.xml", DOC_XML.as_bytes(), true),
        ]);
        assert!(docx_text(&deflated).unwrap().starts_with("Test 1\t Oct 14 & 16"));
        // Not a zip, or a zip without the document: refused with a plain reason.
        assert!(docx_text(b"PK\x03\x04 nope").is_err());
        assert!(docx_text(&zip(&[("other.xml", b"<x/>", false)])).is_err());
        // A bomb larger than the limit is refused, not unpacked.
        assert!(zip_entry(&zip(&[("word/document.xml", &vec![b'a'; 4096], true)]), "word/document.xml", 1024).is_none());
        assert_eq!(unescape("a &amp;&amp; b &unknown; &#65;&#x42; & c"), "a && b &unknown; AB & c");

        let space = temp_space("docx");
        let refs = save(&space, &[up("Essay draft.docx", "", &deflated)]).unwrap();
        assert_eq!(refs[0]["media_type"], DOCX_TYPE);
        assert!(refs[0]["path"].as_str().unwrap().ends_with(".docx"), "the original file is kept in the space");
        let wire = expand(&space, &[json!({"role": "user", "content": refs})]);
        assert_eq!(wire[0]["content"][0]["source"]["type"], "text");
        assert!(wire[0]["content"][0]["source"]["data"].as_str().unwrap().contains("Oct 14 & 16"));
        let err = save(&space, &[up("broken.docx", DOCX_TYPE, b"not a zip")]).unwrap_err();
        assert!(err.contains("broken.docx: it couldn’t be read as a Word document"), "{err}");
        fs::remove_dir_all(&space).unwrap();
    }

    /// A document Word-compatible software really wrote (macOS's textutil).
    #[cfg(target_os = "macos")]
    #[test]
    fn docx_from_textutil() {
        let dir = temp_space("textutil");
        fs::write(dir.join("in.txt"), "Problem set 4 is due Friday.\nBring a calculator.").unwrap();
        let ok = std::process::Command::new("/usr/bin/textutil")
            .args(["-convert", "docx", "-output"])
            .arg(dir.join("out.docx"))
            .arg(dir.join("in.txt"))
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eprintln!("textutil unavailable; skipped");
            return;
        }
        let text = docx_text(&fs::read(dir.join("out.docx")).unwrap()).unwrap();
        assert!(text.contains("Problem set 4 is due Friday.") && text.contains("Bring a calculator."), "{text:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn heic_becomes_jpeg() {
        // A 1x1 PNG, turned into a HEIC photo by sips itself.
        let png = B64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==").unwrap();
        let dir = temp_space("heic-src");
        fs::write(dir.join("p.png"), &png).unwrap();
        let made = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(dir.join("p.png"))
            .arg("--out")
            .arg(dir.join("p.heic"))
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !made {
            eprintln!("sips can't write HEIC here; skipped");
            return;
        }
        let heic = fs::read(dir.join("p.heic")).unwrap();
        let space = temp_space("heic");
        assert!(is_heic(&heic));
        let refs = save(&space, &[up("IMG_0042.HEIC", "image/heic", &heic), up("mislabelled.jpg", "image/jpeg", &heic)]).unwrap();
        assert_eq!(refs[0]["media_type"], "image/jpeg");
        assert_eq!(refs[0]["name"], "IMG_0042.HEIC");
        let path = refs[0]["path"].as_str().unwrap();
        assert!(path.ends_with("/IMG_0042.jpg"), "{path}");
        assert_eq!(image_type(&fs::read(space.join(path)).unwrap()), Some("image/jpeg"));
        assert_eq!(image_type(&fs::read(space.join(refs[1]["path"].as_str().unwrap())).unwrap()), Some("image/jpeg"));
        // Junk that only claims to be HEIC is refused, and the temporary folder is gone.
        let err = save(&space, &[up("x.heic", "", b"nope")]).unwrap_err();
        assert!(err.contains("x.heic: it couldn’t be converted from HEIC to JPEG"), "{err}");
        let leftovers = fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&format!("phaethon-heic-{}-", std::process::id())))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&space).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn saving_never_writes_through_a_symlink() {
        let space = temp_space("link");
        let outside = temp_space("link-outside");
        let day = space.join(FOLDER).join(today());
        fs::create_dir_all(&day).unwrap();
        // A dangling link where the attachment would go, pointing out of the space.
        std::os::unix::fs::symlink(outside.join("planted.md"), day.join("notes.md")).unwrap();
        let refs = save(&space, &[up("notes.md", "", b"mine")]).unwrap();
        assert!(refs[0]["path"].as_str().unwrap().ends_with("/notes (2).md"));
        assert!(!outside.join("planted.md").exists(), "nothing was written outside the space");
        // The attachments folder itself linked out of the space: refused.
        fs::remove_dir_all(space.join(FOLDER)).unwrap();
        std::os::unix::fs::symlink(&outside, space.join(FOLDER)).unwrap();
        assert!(save(&space, &[up("a.md", "", b"x")]).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(&space).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
