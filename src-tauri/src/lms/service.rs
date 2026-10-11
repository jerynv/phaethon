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
use super::store::{self, Conn, GradeRec};
use super::{CourseGrades, Credential, Kind, LmsError, Session, Site, names};
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

/// Streamed by `lms_grades_refresh`, ending with exactly one `Done`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GradesEvent {
    Progress { course: String, step: &'static str, done: usize, total: usize },
    Course { course: String, grades: Box<GradeRec> },
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
    let courses_root = names::dir_in(space_dir, Path::new(store::COURSES_DIR)).map_err(|e| format!("The courses folder couldn’t be made: {e}"))?;
    for course in chosen {
        emit(ImportEvent::Progress { course: course.id.clone(), step: "reading", done: 0, total: 1 });
        let mut content = match super::content(&session, &course.id).await {
            Ok(c) => c,
            Err(LmsError::SignedOut) => return Err(SIGNED_OUT.into()),
            Err(e) => {
                emit(ImportEvent::Error { message: format!("{}: {e}", course.name) });
                continue;
            }
        };
        // Grades are a bonus: one that can't be read is a line in "Not imported", never a failed import.
        let grades = match super::grades(&session, &course.id).await {
            Ok(g) => Some(g),
            Err(e) => {
                content.skipped.push(grades_skipped(&e));
                None
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
        let opts = Options { grades: grades.clone(), ..Options::default() };
        let out = match import::import_course(&session, &courses_root, &course, content, prev.as_ref(), &others, &opts, &mut progress).await {
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
        let mut skipped = out.skipped;
        if let Some(g) = grades
            && let Err(e) = store::put_grades(space_dir, grade_rec(id, &course.id, &course.name, &folder, g))
        {
            skipped.push(format!("Grades: {e}"));
        }
        emit(ImportEvent::Course { course: course.id.clone(), folder: format!("courses/{folder}"), files: out.files, readings: out.readings, links: out.links, skipped });
    }
    Ok(())
}

fn grades_skipped(e: &LmsError) -> String {
    match e {
        LmsError::SignedOut => "Grades: couldn’t be read (sign in again if this keeps happening)".into(),
        e => format!("Grades: couldn’t be read ({e})"),
    }
}

fn grade_rec(connection: &str, course_id: &str, course: &str, folder: &str, grades: CourseGrades) -> GradeRec {
    GradeRec {
        connection: connection.to_string(),
        course_id: course_id.to_string(),
        course: course.to_string(),
        folder: format!("{}/{folder}", store::COURSES_DIR),
        updated: store::now_ms(),
        grades,
    }
}

/// Every imported course's grades in this space, from `.phaethon/grades.json` (no network), by course name.
pub fn grades(space_dir: &Path) -> Result<Vec<GradeRec>, String> {
    let mut list: Vec<GradeRec> = store::load_grades(space_dir)?.courses.into_values().collect();
    list.sort_by(|a, b| a.course.to_lowercase().cmp(&b.course.to_lowercase()).then(a.connection.cmp(&b.connection)));
    Ok(list)
}

/// Read the grades again (only grades) for each course imported from connection `id`:
/// grades.md in the course's folder, the numbers in grades.json. Ends with `Done`;
/// an ended session is one `Error { "signedOut" }` and stops there.
pub async fn grades_refresh(vault: &str, space: &str, space_dir: &Path, id: &str, emit: &(dyn Fn(GradesEvent) + Send + Sync)) {
    if let Err(message) = grades_refresh_inner(vault, space, space_dir, id, emit).await {
        emit(GradesEvent::Error { message });
    }
    emit(GradesEvent::Done);
}

async fn grades_refresh_inner(vault: &str, space: &str, space_dir: &Path, id: &str, emit: &(dyn Fn(GradesEvent) + Send + Sync)) -> Result<(), String> {
    let session = session(vault, space, space_dir, id)?;
    refresh_grades_with(&session, space_dir, id, emit).await
}

async fn refresh_grades_with(session: &Session, space_dir: &Path, id: &str, emit: &(dyn Fn(GradesEvent) + Send + Sync)) -> Result<(), String> {
    let st = store::load(space_dir)?;
    let courses: Vec<(String, store::CourseState)> = st.get(id).map(|c| c.courses.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    let total = courses.len();
    for (n, (cid, cs)) in courses.into_iter().enumerate() {
        emit(GradesEvent::Progress { course: cid.clone(), step: "grades", done: n, total });
        let g = match super::grades(session, &cid).await {
            Ok(g) => g,
            Err(LmsError::SignedOut) => return Err(SIGNED_OUT.into()),
            Err(e) => {
                emit(GradesEvent::Error { message: format!("{}: {e}", cs.name) });
                continue;
            }
        };
        // The folder as the import left it; one removed since isn't made again just for grades.md.
        if let Some(dir) = store::course_dir(space_dir, &cs.folder)
            && let Err(e) = import::write_grades(&dir, &cs.name, &g)
        {
            emit(GradesEvent::Error { message: format!("{}: {e}", cs.name) });
        }
        let rec = grade_rec(id, &cid, &cs.name, &cs.folder, g);
        store::put_grades(space_dir, rec.clone())?;
        emit(GradesEvent::Course { course: cid, grades: Box::new(rec) });
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
    let found = accounts
        .into_iter()
        .filter_map(|a| {
            // Canvas's list has stray double spaces ("Indiana Online  - Parents").
            let name = a.name?.split_whitespace().collect::<Vec<_>>().join(" ");
            let site = Site::new(Kind::Canvas, a.domain?.trim()).ok()?;
            let address = site.base.as_str().trim_end_matches('/').to_string();
            (!name.is_empty() && seen.insert((name.clone(), address.clone()))).then_some(School { name, address })
        })
        .collect();
    Ok(rank_schools(found, &q))
}

/// Best match first: the name as typed, then names starting with it, then a word
/// starting with it, then the rest; shorter names first within each (so "Indiana
/// University" comes before "Indiana University Health, Inc.").
pub fn rank_schools(mut found: Vec<School>, query: &str) -> Vec<School> {
    let q = query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let score = |s: &School| {
        let n = s.name.to_lowercase();
        if n == q {
            0
        } else if n.starts_with(&q) {
            1
        } else if n.split(|c: char| !c.is_alphanumeric()).any(|w| !w.is_empty() && q.split(' ').next().is_some_and(|first| w.starts_with(first))) {
            2
        } else {
            3
        }
    };
    found.sort_by(|a, b| score(a).cmp(&score(b)).then(a.name.len().cmp(&b.name.len())).then(a.name.cmp(&b.name)));
    found
}

#[cfg(test)]
mod tests {
    #[test]
    fn schools_best_match_first() {
        let names = [
            "Indiana Online - Parents",
            "Bethel University (Indiana)",
            "Indiana University Health, Inc.",
            "Lebanon Community School Corporation (Parent/Guardian Indiana)",
            "Indiana University",
            "Indiana State University",
        ];
        let found = names.iter().map(|n| super::School { name: n.to_string(), address: "https://x.instructure.com".into() }).collect();
        let got: Vec<String> = super::rank_schools(found, "Indiana  university").into_iter().map(|s| s.name).collect();
        assert_eq!(got[0], "Indiana University");
        assert_eq!(got[1], "Indiana University Health, Inc.");
        assert_eq!(got.last().unwrap(), "Lebanon Community School Corporation (Parent/Guardian Indiana)");
    }

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

    /// A space with one Canvas connection (at `base`) and course 1001 imported into courses/Discrete/.
    fn grades_space(tag: &str, base: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-grades-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("courses/Discrete")).unwrap();
        std::fs::write(dir.join("courses/Discrete/README.md"), "# Discrete\n\nImported from x on today.\n\n## Coming up\n\nNothing.\n").unwrap();
        let mut conn = Conn { id: "canvas-x".into(), kind: Kind::Canvas, address: base.into(), school_name: None, last_sync: None, courses: Default::default() };
        conn.courses.insert("1001".into(), store::CourseState { name: "Discrete Structures".into(), folder: "Discrete".into(), ..Default::default() });
        store::save(&dir, &store::Store { connections: vec![conn] }).unwrap();
        dir
    }

    fn canvas_session(base: &str) -> Session {
        let cookies = vec![super::super::Cookie { name: "_normandy_session".into(), value: "s".into() }];
        Session::new(Site::for_test(Kind::Canvas, base), Credential { cookies, csrf: None })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_grades_refresh_writes_grades_md_and_grades_json_and_lms_grades_reads_them_back() {
        use crate::lms::fake::{self, json, status};
        let (base, _) = fake::serve(std::sync::Arc::new(|t: &str| match t.split('?').next().unwrap() {
            "/api/v1/courses/1001/enrollments" => json(include_str!("../../tests/fixtures/canvas/grades_enrollments.json")),
            "/api/v1/courses/1001" => json(r#"{"id":1001,"apply_assignment_group_weights":true}"#),
            "/api/v1/courses/1001/assignment_groups" => json(include_str!("../../tests/fixtures/canvas/grades_groups.json")),
            "/api/v1/courses/1001/students/submissions" => json(include_str!("../../tests/fixtures/canvas/grades_submissions.json")),
            _ => status(404),
        }))
        .await;
        let dir = grades_space("refresh", &base);
        let events = Mutex::new(vec![]);
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|e| events.lock().unwrap().push(e)).await.unwrap();
        let events = events.into_inner().unwrap();
        assert_eq!(events[0], GradesEvent::Progress { course: "1001".into(), step: "grades", done: 0, total: 1 });
        let GradesEvent::Course { course, grades: rec } = &events[1] else { panic!("{events:?}") };
        let rec = &**rec;
        assert_eq!((course.as_str(), rec.folder.as_str(), rec.course.as_str()), ("1001", "courses/Discrete", "Discrete Structures"));

        // grades.md, read back as the person (and the agent) would.
        let md = std::fs::read_to_string(dir.join("courses/Discrete/grades.md")).unwrap();
        assert!(md.starts_with("# Grades: Discrete Structures\n"), "{md}");
        assert!(md.contains("**Current grade: 88.42% (B+)**"), "{md}");
        assert!(md.contains("Final grade if nothing more is graded (work not graded counts as zero): 74.1% (C)."), "{md}");
        assert!(md.contains("## Homework (40% of the grade)") && md.contains("## Exams (60% of the grade)"), "{md}");
        assert!(md.contains("- **Homework 1**: 9 / 10 (90%) · due "), "{md}");
        assert!(md.contains("  - Teacher’s comment: Nice proof. Watch the base case."), "{md}");
        assert!(md.lines().any(|l| l.starts_with("- **Homework 2**: 7 / 10 (70%)") && l.ends_with(" · late")), "{md}");
        assert!(md.lines().any(|l| l.starts_with("- **Homework 3**: 0 / 10 (0%)") && l.ends_with(" · missing")), "{md}");
        assert!(md.contains("- **Homework 4**: excused (doesn’t count)"), "{md}");
        assert!(md.lines().any(|l| l.starts_with("- **Midterm**: not graded yet (out of 150)") && l.ends_with("handed in, not graded yet")), "{md}");
        assert!(md.contains("- **Quiz week 3 (paper)**: 152 / 160 (95%), A-"), "{md}");
        assert!(md.find("## Homework").unwrap() < md.find("**Homework 1**").unwrap() && md.find("## Exams").unwrap() < md.find("**Midterm**").unwrap());
        let readme = std::fs::read_to_string(dir.join("courses/Discrete/README.md")).unwrap();
        assert!(readme.contains("Imported from x on today.\n\n**Grades**: 88.42% (B+) so far. Every grade, by group: [grades.md](grades.md).\n\n## Coming up"), "{readme}");

        // lms_grades: the same numbers from disk, in the contract's shape.
        let list = grades(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(&list[0], rec);
        let v = serde_json::to_value(&list[0]).unwrap();
        for k in ["connection", "courseId", "course", "folder", "updated", "current", "final", "groups", "items"] {
            assert!(v.get(k).is_some(), "{k} in {v}");
        }
        assert_eq!(v["current"], serde_json::json!({"percent": 88.42, "letter": "B+", "points": 168.0}));
        assert_eq!(v["items"][2]["missing"], true);

        // Again: the README keeps one grades line.
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| {}).await.unwrap();
        let readme = std::fs::read_to_string(dir.join("courses/Discrete/README.md")).unwrap();
        assert_eq!(readme.matches("**Grades**").count(), 1, "{readme}");
        // The agent's course index carries the grade.
        let idx = store::prompt_index(&dir, 0).unwrap();
        assert!(idx.contains("- Discrete Structures: courses/Discrete/ Current grade: 88.42% (B+) (grades.md)."), "{idx}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_grades_refresh_stops_signed_out_and_a_hidden_course_is_noted() {
        use crate::lms::fake::{self, json, status};
        let (base, _) = fake::serve(std::sync::Arc::new(|_: &str| status(401))).await;
        let dir = grades_space("signedout", &base);
        let err = refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| {}).await.unwrap_err();
        assert_eq!(err, SIGNED_OUT);
        assert!(!dir.join("courses/Discrete/grades.md").exists());
        assert!(grades(&dir).unwrap().is_empty());

        let (base, _) = fake::serve(std::sync::Arc::new(|t: &str| if t.starts_with("/api/v1/users/self") { json(r#"{"id":1}"#) } else { status(403) })).await;
        let dir = grades_space("hidden", &base);
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| {}).await.unwrap();
        let md = std::fs::read_to_string(dir.join("courses/Discrete/grades.md")).unwrap();
        assert!(md.contains(crate::lms::GRADES_HIDDEN), "{md}");
        let readme = std::fs::read_to_string(dir.join("courses/Discrete/README.md")).unwrap();
        assert!(readme.contains("**Grades**: Your course site doesn’t show you grades for this course. See [grades.md](grades.md)."), "{readme}");
        assert_eq!(grades(&dir).unwrap()[0].grades.note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grades_events_have_the_contracts_shape() {
        assert_eq!(serde_json::to_value(GradesEvent::Done).unwrap(), serde_json::json!({"type": "done"}));
        let e = serde_json::to_value(GradesEvent::Progress { course: "1".into(), step: "grades", done: 0, total: 3 }).unwrap();
        assert_eq!(e, serde_json::json!({"type": "progress", "course": "1", "step": "grades", "done": 0, "total": 3}));
        let rec = grade_rec("c", "1", "Calc", "Calc", CourseGrades::default());
        let e = serde_json::to_value(GradesEvent::Course { course: "1".into(), grades: Box::new(rec) }).unwrap();
        assert_eq!(e["type"], "course");
        assert_eq!(e["grades"]["folder"], "courses/Calc");
        assert_eq!(e["grades"]["items"], serde_json::json!([]));
        assert_eq!(serde_json::to_value(GradesEvent::Error { message: SIGNED_OUT.into() }).unwrap(), serde_json::json!({"type": "error", "message": "signedOut"}));
    }
}
