//! What the `lms_*` commands do, apart from the sign-in window (login.rs):
//! the space's connections, its courses, importing them, and forgetting a
//! connection. Every call names a space; its record lives in that space's
//! lms.json and its session in the keychain under that space's name.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use url::Url;

use super::import::{self, Options};
use super::store::{self, Conn};
use super::{Credential, Kind, LmsError, Session, Site, names};
use crate::secrets;

/// The error text the UI acts on (Sign in again).
pub const SIGNED_OUT: &str = "signedOut";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    pub kind: Kind,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub school_name: Option<String>,
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    pub courses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    pub current: bool,
    pub imported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct School {
    pub name: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImportEvent {
    Progress { course: String, step: &'static str, done: usize, total: usize },
    Course { course: String, folder: String, files: usize, readings: usize, links: usize, skipped: Vec<String> },
    Done,
    Error { message: String },
}

/// A connection's id: the kind and the site's host, so signing in again to the
/// same site finds the same connection. Only letters, digits and `-`.
pub fn connection_id(site: &Site) -> String {
    let host = site.base.host_str().unwrap_or("site");
    let port = site.base.port().map(|p| format!("-{p}")).unwrap_or_default();
    let raw = format!("{}-{host}{port}", site.kind.name().to_ascii_lowercase());
    let id: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    id.chars().take(100).collect()
}

fn view(vault: &str, space: &str, c: &Conn) -> ConnectionView {
    let signed_in = matches!(secrets::lms_get(vault, space, &c.id), Ok(Some(_)));
    ConnectionView {
        id: c.id.clone(),
        kind: c.kind,
        address: c.address.clone(),
        school_name: c.school_name.clone(),
        signed_in,
        last_sync: c.last_sync,
        courses: c.courses.keys().cloned().collect(),
    }
}

pub fn connections(vault: &str, space: &str, space_dir: &Path) -> Result<Vec<ConnectionView>, String> {
    Ok(store::load(space_dir)?.connections.iter().map(|c| view(vault, space, c)).collect())
}

/// After signing in: keep the credential in the keychain and the connection in
/// lms.json (the same one again when it's the same site).
pub fn save_sign_in(vault: &str, space: &str, space_dir: &Path, site: &Site, credential: &Credential) -> Result<ConnectionView, String> {
    let id = connection_id(site);
    let mut st = store::load(space_dir)?;
    let secret = serde_json::to_string(credential).map_err(|e| e.to_string())?;
    secrets::lms_set(vault, space, &id, &secret)?;
    if st.get(&id).is_none() {
        st.connections.push(Conn {
            id: id.clone(),
            kind: site.kind,
            address: site.base.as_str().trim_end_matches('/').to_string(),
            school_name: None,
            last_sync: None,
            courses: Default::default(),
        });
        store::save(space_dir, &st)?;
    }
    Ok(view(vault, space, st.get(&id).expect("just saved")))
}

/// Remember a school's name for a connection (from the school search).
pub fn set_school_name(space_dir: &Path, id: &str, name: &str) -> Result<(), String> {
    let mut st = store::load(space_dir)?;
    if let Some(c) = st.get_mut(id) {
        let name: String = name.trim().chars().take(120).collect();
        if !name.is_empty() && c.school_name.as_deref() != Some(&name) {
            c.school_name = Some(name);
            store::save(space_dir, &st)?;
        }
    }
    Ok(())
}

fn site_of(c: &Conn) -> Result<Site, String> {
    #[cfg(test)]
    if c.address.starts_with("http://127.0.0.1") {
        return Ok(Site::for_test(c.kind, &c.address));
    }
    Site::new(c.kind, &c.address).map_err(|e| e.to_string())
}

/// The connection's session from the keychain; `SIGNED_OUT` when there is none.
pub fn session(vault: &str, space: &str, space_dir: &Path, id: &str) -> Result<Session, String> {
    let st = store::load(space_dir)?;
    let c = st.get(id).ok_or("That course site isn’t connected to this space.")?;
    let site = site_of(c)?;
    let secret = secrets::lms_get(vault, space, id)?.ok_or(SIGNED_OUT)?;
    let credential: Credential = serde_json::from_str(&secret).map_err(|_| SIGNED_OUT.to_string())?;
    Ok(Session::new(site, credential))
}

fn lms_error(e: LmsError) -> String {
    match e {
        LmsError::SignedOut => SIGNED_OUT.into(),
        other => other.to_string(),
    }
}

pub async fn courses(vault: &str, space: &str, space_dir: &Path, id: &str) -> Result<Vec<CourseView>, String> {
    let session = session(vault, space, space_dir, id)?;
    let list = super::courses(&session).await.map_err(lms_error)?;
    let st = store::load(space_dir)?;
    let imported: HashSet<&String> = st.get(id).map(|c| c.courses.keys().collect()).unwrap_or_default();
    Ok(list
        .into_iter()
        .map(|c| CourseView { imported: imported.contains(&c.id), id: c.id, name: c.name, code: c.code, term: c.term, current: c.current })
        .collect())
}

/// Spaces with an import running (one at a time in a space).
static IMPORTING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct Busy(String);

impl Busy {
    fn claim(space: &str) -> Option<Busy> {
        let mut g = IMPORTING.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashSet::new).insert(space.to_string()).then(|| Busy(space.to_string()))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        let mut g = IMPORTING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = g.as_mut() {
            s.remove(&self.0);
        }
    }
}

/// Import (or update) `course_ids` into `<space>/courses/`. Every outcome is an
/// event; the last one is always `Done`.
pub async fn import(vault: &str, space: &str, space_dir: &Path, id: &str, course_ids: &[String], emit: &(dyn Fn(ImportEvent) + Send + Sync)) {
    let err = |m: String| emit(ImportEvent::Error { message: m });
    match import_inner(vault, space, space_dir, id, course_ids, emit).await {
        Ok(()) => {}
        Err(m) => err(m),
    }
    emit(ImportEvent::Done);
}

async fn import_inner(vault: &str, space: &str, space_dir: &Path, id: &str, course_ids: &[String], emit: &(dyn Fn(ImportEvent) + Send + Sync)) -> Result<(), String> {
    let _busy = Busy::claim(space).ok_or("Courses are already being imported into this space. Wait for that to finish.")?;
    let session = session(vault, space, space_dir, id)?;
    let wanted: HashSet<&String> = course_ids.iter().collect();
    let list = super::courses(&session).await.map_err(lms_error)?;
    let chosen: Vec<_> = list.into_iter().filter(|c| wanted.contains(&c.id)).collect();
    if chosen.len() < wanted.len() {
        emit(ImportEvent::Error { message: "Some of the chosen courses aren’t on the course site any more.".into() });
    }
    let courses_root = names::dir_in(space_dir, Path::new("courses")).map_err(|e| format!("The courses folder couldn’t be made: {e}"))?;
    for course in chosen {
        emit(ImportEvent::Progress { course: course.id.clone(), step: "reading", done: 0, total: 1 });
        let content = match super::content(&session, &course.id).await {
            Ok(c) => c,
            Err(LmsError::SignedOut) => return Err(SIGNED_OUT.into()),
            Err(e) => {
                emit(ImportEvent::Error { message: format!("{}: {e}", course.name) });
                continue;
            }
        };
        emit(ImportEvent::Progress { course: course.id.clone(), step: "reading", done: 1, total: 1 });
        // Read again for each course: another import may have changed it.
        let st = store::load(space_dir)?;
        let prev = st.get(id).and_then(|c| c.courses.get(&course.id)).cloned();
        let others: Vec<String> = st
            .connections
            .iter()
            .flat_map(|c| c.courses.iter().filter(|(cid, _)| !(c.id == id && **cid == course.id)).map(|(_, s)| s.folder.clone()))
            .collect();
        let cid = course.id.clone();
        let mut progress = |step: &'static str, done: usize, total: usize| emit(ImportEvent::Progress { course: cid.clone(), step, done, total });
        let out = match import::import_course(&session, &courses_root, &course, content, prev.as_ref(), &others, &Options::default(), &mut progress).await {
            Ok(o) => o,
            Err(e) => {
                emit(ImportEvent::Error { message: format!("{}: {e}", course.name) });
                continue;
            }
        };
        let mut st = store::load(space_dir)?;
        let folder = out.state.folder.clone();
        let Some(conn) = st.get_mut(id) else {
            return Err("This course site was disconnected while importing.".into());
        };
        conn.courses.insert(course.id.clone(), out.state);
        conn.last_sync = Some(store::now_ms());
        store::save(space_dir, &st)?;
        emit(ImportEvent::Course {
            course: course.id.clone(),
            folder: format!("courses/{folder}"),
            files: out.files,
            readings: out.readings,
            links: out.links,
            skipped: out.skipped,
        });
    }
    Ok(())
}

/// Forget the session (keychain) and the connection (lms.json). The imported folders stay.
pub fn disconnect(vault: &str, space: &str, space_dir: &Path, id: &str) -> Result<(), String> {
    let mut st = store::load(space_dir)?;
    secrets::lms_clear(vault, space, id)?;
    let before = st.connections.len();
    st.connections.retain(|c| c.id != id);
    if st.connections.len() != before {
        store::save(space_dir, &st)?;
    }
    Ok(())
}

pub const CANVAS_SEARCH: &str = "https://canvas.instructure.com/api/v1/accounts/search";

/// Schools by name: Canvas's public school search (the one its own apps use,
/// no sign-in); the other kinds have none, so the person types the address.
pub async fn schools(kind: Kind, query: &str) -> Result<Vec<School>, String> {
    if kind != Kind::Canvas {
        return Ok(vec![]);
    }
    canvas_schools(&Url::parse(CANVAS_SEARCH).expect("valid"), query).await
}

#[derive(serde::Deserialize)]
struct CanvasAccount {
    name: Option<String>,
    domain: Option<String>,
}

pub async fn canvas_schools(endpoint: &Url, query: &str) -> Result<Vec<School>, String> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(vec![]);
    }
    let q: String = q.chars().take(100).collect();
    let mut url = endpoint.clone();
    url.query_pairs_mut().append_pair("search_term", &q).append_pair("per_page", "50");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Phaethon/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| format!("Couldn’t search for schools: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Couldn’t search for schools (the search answered {}).", res.status().as_u16()));
    }
    let accounts: Vec<CanvasAccount> = res.json().await.map_err(|e| format!("Couldn’t search for schools: {e}"))?;
    let mut seen = HashSet::new();
    Ok(accounts
        .into_iter()
        .filter_map(|a| {
            let name = a.name?.trim().to_string();
            let site = Site::new(Kind::Canvas, a.domain?.trim()).ok()?;
            let address = site.base.as_str().trim_end_matches('/').to_string();
            (!name.is_empty() && seen.insert((name.clone(), address.clone()))).then_some(School { name, address })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_ids_are_plain_and_stable() {
        let s = Site::new(Kind::Canvas, "iu.instructure.com/courses/1").unwrap();
        assert_eq!(connection_id(&s), "canvas-iu-instructure-com");
        assert!(secrets::lms_account("default", "school", &connection_id(&s)).is_ok());
        let t = Site::for_test(Kind::Moodle, "http://127.0.0.1:8080");
        assert_eq!(connection_id(&t), "moodle-127-0-0-1-8080");
    }

    /// The real Canvas school search (public, no sign-in): `cargo test real_canvas -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_canvas_school_search() {
        let found = schools(Kind::Canvas, "indiana university").await.unwrap();
        assert!(found.iter().any(|s| s.name == "Indiana University" && s.address == "https://iu.instructure.com"), "{found:?}");
        assert!(schools(Kind::Canvas, "i").await.unwrap().is_empty());
    }

    #[test]
    fn events_have_the_contracts_shape() {
        let e = serde_json::to_value(ImportEvent::Progress { course: "1".into(), step: "files", done: 2, total: 5 }).unwrap();
        assert_eq!(e, serde_json::json!({"type": "progress", "course": "1", "step": "files", "done": 2, "total": 5}));
        let e = serde_json::to_value(ImportEvent::Course { course: "1".into(), folder: "courses/X".into(), files: 1, readings: 2, links: 3, skipped: vec![] }).unwrap();
        assert_eq!(e, serde_json::json!({"type": "course", "course": "1", "folder": "courses/X", "files": 1, "readings": 2, "links": 3, "skipped": []}));
        assert_eq!(serde_json::to_value(ImportEvent::Done).unwrap(), serde_json::json!({"type": "done"}));
        let c = ConnectionView { id: "a".into(), kind: Kind::Canvas, address: "https://x".into(), school_name: None, signed_in: true, last_sync: None, courses: vec![] };
        assert_eq!(serde_json::to_value(c).unwrap(), serde_json::json!({"id": "a", "kind": "canvas", "address": "https://x", "signedIn": true, "courses": []}));
    }
}
