//! `<space>/.phaethon/lms.json`: the space's course site connections and what
//! was imported from them. Nothing secret (the sessions are in the keychain):
//! addresses, course ids and folders, due dates for the agent's index, and a
//! map of each remote file to its local copy so a re-import downloads only
//! what changed.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{Kind, names};

pub const FILE: &str = "lms.json";
/// Largest lms.json read.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub connections: Vec<Conn>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    pub id: String,
    pub kind: Kind,
    /// The site's https origin.
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub school_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    /// Imported courses by the site's course id.
    #[serde(default)]
    pub courses: BTreeMap<String, CourseState>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseState {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    /// The course's folder name under `<space>/courses/`.
    pub folder: String,
    /// Remote file address → its local copy.
    #[serde(default)]
    pub files: BTreeMap<String, FileRec>,
    /// Link out of the course → what came of it (saved, a web page, or why not).
    #[serde(default)]
    pub links: BTreeMap<String, LinkRec>,
    /// Every dated assignment, for "Coming up" and the agent's index.
    #[serde(default)]
    pub due: Vec<Due>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRec {
    /// Relative to the course folder, under `files/`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// The download's ETag and Last-Modified, to tell a changed file from the same one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRec {
    /// Saved copy, relative to the course folder (under `readings/`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// A web page's title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Why it wasn't saved, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// For a copy found through a book's page: that page's address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(default)]
    pub web_page: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Due {
    pub title: String,
    /// RFC 3339, as the site gave it.
    pub due: String,
    /// Where it is in assignments.md.
    #[serde(default)]
    pub anchor: String,
}

pub fn load(space_dir: &Path) -> Result<Store, String> {
    let path = space_dir.join(crate::tools::STATE_DIR).join(FILE);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(e) => return Err(format!("This space’s course sites couldn’t be read: {e}")),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("This space’s course sites file isn’t a plain file Phaethon can read.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("This space’s course sites couldn’t be read: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("This space’s course sites file is damaged ({e}). Fix or remove .phaethon/lms.json."))
}

pub fn save(space_dir: &Path, store: &Store) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    names::write(space_dir, &Path::new(crate::tools::STATE_DIR).join(FILE), &json)
        .map_err(|e| format!("This space’s course sites couldn’t be saved: {e}"))
}

impl Store {
    pub fn get(&self, id: &str) -> Option<&Conn> {
        self.connections.iter().find(|c| c.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Conn> {
        self.connections.iter_mut().find(|c| c.id == id)
    }

    /// Every course folder in use in this space, by any connection.
    pub fn folders(&self) -> Vec<String> {
        self.connections.iter().flat_map(|c| c.courses.values().map(|s| s.folder.clone())).collect()
    }
}

// ---- Dates ------------------------------------------------------------------

/// Seconds since the epoch for an RFC 3339 time ("2026-10-14T23:59:00Z",
/// "2026-10-14T23:59:00-04:00", fractions allowed). A date alone is midnight UTC.
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> { s.get(a..a + n).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse().ok()) };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if b.len() == 10 {
        return Some(days * 86_400);
    }
    if !matches!(b.get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let (h, mi) = (num(11, 2)?, num(14, 2)?);
    let mut at = 16;
    let mut sec = 0;
    if b.get(16) == Some(&b':') {
        sec = num(17, 2)?;
        at = 19;
        if b.get(19) == Some(&b'.') {
            at = 20 + b[20..].iter().take_while(|c| c.is_ascii_digit()).count();
        }
    }
    let offset = match b.get(at) {
        Some(b'Z' | b'z') | None => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(at + 1, 2)?;
            let om = num(at + 4, 2)?;
            let o = oh * 3600 + om * 60;
            if *sign == b'-' { -o } else { o }
        }
        _ => return None,
    };
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A time as the person reads it, in this computer's time zone: "Tue Oct 14 2026, 11:59 PM".
pub fn display_time(secs: i64) -> String {
    let (y, mo, d, h, mi, wd) = local_parts(secs);
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (h12, ampm) = match h {
        0 => (12, "AM"),
        1..=11 => (h, "AM"),
        12 => (12, "PM"),
        _ => (h - 12, "PM"),
    };
    format!("{} {} {d} {y}, {h12}:{mi:02} {ampm}", DAYS[wd as usize % 7], MONTHS[(mo as usize).clamp(1, 12) - 1])
}

#[cfg(unix)]
fn local_parts(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: localtime_r writes only into `tm`, which outlives the call.
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return utc_parts(secs);
    }
    (tm.tm_year as i64 + 1900, tm.tm_mon as i64 + 1, tm.tm_mday as i64, tm.tm_hour as i64, tm.tm_min as i64, tm.tm_wday as i64)
}

#[cfg(not(unix))]
fn local_parts(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    utc_parts(secs)
}

fn utc_parts(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, rem / 3600, rem % 3600 / 60, (days + 4).rem_euclid(7))
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Dated items from `due` that are still ahead of `now`, soonest first.
pub fn upcoming(due: &[Due], now: i64) -> Vec<(i64, &Due)> {
    let mut v: Vec<(i64, &Due)> = due.iter().filter_map(|d| parse_time(&d.due).map(|t| (t, d))).filter(|(t, _)| *t >= now).collect();
    v.sort_by_key(|(t, _)| *t);
    v
}

// ---- The agent's index ------------------------------------------------------

const INDEX_COURSES: usize = 20;
const INDEX_DUE: usize = 3;
const INDEX_MAX: usize = 4000;

/// A short index of this space's imported courses for the system prompt, or
/// `None` when there are none. Only this space's lms.json is read.
pub fn prompt_index(space_dir: &Path, now: i64) -> Option<String> {
    let store = load(space_dir).ok()?;
    let mut lines = vec![];
    for conn in &store.connections {
        for c in conn.courses.values() {
            if lines.len() >= INDEX_COURSES {
                break;
            }
            let label = match &c.code {
                Some(code) if !c.name.contains(code.as_str()) => format!("{} ({code})", c.name),
                _ => c.name.clone(),
            };
            let mut line = format!("- {label}: courses/{}/", c.folder);
            let next: Vec<String> = upcoming(&c.due, now).into_iter().take(INDEX_DUE).map(|(t, d)| format!("{} ({})", d.title, display_time(t))).collect();
            if !next.is_empty() {
                line.push_str(&format!(" Next due: {}.", next.join("; ")));
            }
            lines.push(line);
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut s = String::from(
        "# Courses\n\nThese courses were imported from the user's course site into this space, one folder each under courses/. \
Before answering anything about a course, read its folder with your file tools: README.md (what's coming up, the textbooks and readings), \
syllabus.md, assignments.md, modules.md, and the files and readings the question touches. PDFs and Office files have a text copy beside them \
(the same name ending in .md); read that. Answer from the course's own material and say which file it came from.\n\n",
    );
    for l in lines {
        if s.len() + l.len() > INDEX_MAX {
            s.push_str("- …and more under courses/\n");
            break;
        }
        s.push_str(&l);
        s.push('\n');
    }
    Some(s.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_times() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-10-14T23:59:00Z"), Some(1_792_022_340));
        assert_eq!(parse_time("2026-10-14T19:59:00-04:00"), Some(1_792_022_340));
        assert_eq!(parse_time("2026-10-14T23:59:00.123Z"), Some(1_792_022_340));
        assert_eq!(parse_time("2026-10-14"), Some(1_791_936_000));
        assert_eq!(parse_time("soon"), None);
        assert_eq!(parse_time("2026-13-01T00:00:00Z"), None);
        let (y, m, d, h, mi, wd) = utc_parts(1_792_022_340);
        assert_eq!((y, m, d, h, mi, wd), (2026, 10, 14, 23, 59, 3));
    }

    #[test]
    fn the_index_lists_this_spaces_courses_with_whats_next() {
        let dir = std::env::temp_dir().join(format!("phaethon-lms-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(prompt_index(&dir, 0), None);
        let mut store = Store::default();
        let mut conn = Conn { id: "canvas-x".into(), kind: Kind::Canvas, address: "https://x".into(), school_name: None, last_sync: None, courses: BTreeMap::new() };
        conn.courses.insert(
            "1".into(),
            CourseState {
                name: "Calculus II".into(),
                code: Some("M212".into()),
                folder: "Calculus II".into(),
                due: vec![
                    Due { title: "Old".into(), due: "2026-01-01T00:00:00Z".into(), anchor: String::new() },
                    Due { title: "PS 5".into(), due: "2026-10-20T00:00:00Z".into(), anchor: String::new() },
                    Due { title: "PS 4".into(), due: "2026-10-13T00:00:00Z".into(), anchor: String::new() },
                ],
                ..Default::default()
            },
        );
        store.connections.push(conn);
        save(&dir, &store).unwrap();
        assert_eq!(load(&dir).unwrap(), store);
        let now = parse_time("2026-10-10T00:00:00Z").unwrap();
        let idx = prompt_index(&dir, now).unwrap();
        assert!(idx.contains("- Calculus II (M212): courses/Calculus II/ Next due: PS 4 ("), "{idx}");
        assert!(idx.find("PS 4").unwrap() < idx.find("PS 5").unwrap());
        assert!(!idx.contains("Old"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
