//! What the `lms_*` commands do, apart from the sign-in window (login.rs):
//! the vault's connections, their courses, importing them, and forgetting a
//! connection. Course sites belong to the vault: the record is
//! `<vault>/.phaethon/lms.json`, the sessions are in the keychain under the
//! vault's name, and imported courses are in `<vault>/courses/`. Which spaces
//! see which courses is access.rs.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use url::Url;

use super::access::{self, Part, Visible};
pub use super::browse::{BrowseEntry, BrowseKind, CourseBrowse, course_content};
use super::cancel::{CANCELLED, Cancel};
use super::import::{self, Options};
use super::store::{self, Conn, GradeRec};
use super::{CourseGrades, Credential, Kind, LmsError, Session, Site, names};
use crate::secrets;
use crate::vault::Vault;

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
    /// Imported in full at least once.
    pub imported: bool,
    /// Its first import was stopped part way: choosing it again resumes it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
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
    Course {
        course: String,
        folder: String,
        files: usize,
        readings: usize,
        links: usize,
        skipped: Vec<String>,
        /// What its documents are made of (typed, handwriting, pictures).
        #[serde(skip_serializing_if = "Option::is_none")]
        material: Option<super::material::Summary>,
    },
    /// The person cancelled: what finished is kept, and importing again resumes. Followed by `Done`.
    Cancelled,
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

fn view(c: &Conn) -> ConnectionView {
    let signed_in = c.signed_in;
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

/// The vault's connections. Reads only lms.json, never the keychain.
pub fn connections(vault: &Vault) -> Result<Vec<ConnectionView>, String> {
    Ok(store::load(vault.root())?.connections.iter().map(view).collect())
}

/// After signing in: keep the credential in the keychain and the connection in
/// lms.json (the same one again when it's the same site). Without asking the site who
/// signed in; [`finish_sign_in`] does.
pub fn save_sign_in(vault: &Vault, site: &Site, credential: &Credential) -> Result<ConnectionView, String> {
    save_sign_in_as(vault, site, credential, None)
}

/// After signing in: ask the site who is signed in (its documented "who am I" call, see
/// [`super::account`]), then keep the session under that account's connection, the
/// school's name with it. Signing in again as the same account finds the same connection,
/// with its imported courses and who can see them; another account on the same site gets a
/// connection of its own, so one person's courses are never filed under another's.
///
/// On a site with an account call (Canvas, Brightspace, Blackboard) a failed call fails the
/// sign-in and nothing is saved: an unverified session never replaces a known account's.
/// Moodle has no such call: there one connection per site, as before, and no per-account
/// matching is claimed.
pub async fn finish_sign_in(vault: &Vault, site: &Site, credential: &Credential, school_name: Option<String>) -> Result<ConnectionView, String> {
    let session = Session::new(site.clone(), credential.clone());
    let account = match super::account(&session).await {
        Ok(Some(id)) => Some(super::account_fingerprint(site, &id)),
        Ok(None) => None,
        Err(e) => return Err(identity_failed(&e)),
    };
    let (vault, site, credential) = (vault.clone(), site.clone(), credential.clone());
    tokio::task::spawn_blocking(move || {
        let view = save_sign_in_as(&vault, &site, &credential, account.as_deref())?;
        let Some(name) = school_name else { return Ok(view) };
        set_school_name(vault.root(), &view.id, &name)?;
        connections(&vault)?.into_iter().find(|c| c.id == view.id).ok_or_else(|| "The connection wasn’t saved.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn identity_failed(e: &LmsError) -> String {
    format!("Signed in, but your course site didn’t say which account it is, so nothing was saved. Try signing in again. ({e})")
}

/// Which connection a sign-in to `site` as `account` (a fingerprint) belongs to. Only a
/// connection on this same canonical site (the same kind and base address, Moodle's folder
/// included) is ever reused; an id that another site already has is never taken over.
/// 1. one on this site already known to be this account;
/// 2. else one on this site with no account known yet (made before accounts were kept),
///    which this account then claims, the site's own id first;
/// 3. else a new connection.
///
/// Without an account (Moodle, or the legacy [`save_sign_in`]): a connection on the site with
/// no account known, the site's id first; never one that belongs to a known account. When
/// every one does, a new connection. Moodle has one connection per site this way: it can't
/// tell its accounts apart.
///
/// A new connection gets the site's id when it's free; otherwise (another site with the same
/// id, e.g. two Moodles under one host, or another account here) the id plus 8 hex digits of
/// a hash of the site (and the account), numbered on if even that is taken.
pub fn choose_connection(st: &store::Store, accounts: &store::Accounts, site: &Site, account: Option<&str>) -> String {
    let base = connection_id(site);
    let addr = site_address(site);
    let mut on_site: Vec<&Conn> = st.connections.iter().filter(|c| c.kind == site.kind && c.address.trim_end_matches('/') == addr).collect();
    on_site.sort_by_key(|c| c.id != base);
    if let Some(fp) = account
        && let Some(c) = on_site.iter().find(|c| accounts.connections.get(&c.id).is_some_and(|a| a == fp))
    {
        return c.id.clone();
    }
    if let Some(c) = on_site.iter().find(|c| !accounts.connections.contains_key(&c.id)) {
        return c.id.clone();
    }
    let taken = |id: &str| st.get(id).is_some() || accounts.connections.contains_key(id);
    if !taken(&base) {
        return base;
    }
    let tag = super::hash::hex_of(format!("{}\n{addr}\n{}", site.kind.name(), account.unwrap_or("")).as_bytes());
    let first = format!("{base}-{}", &tag[..8]);
    if !taken(&first) {
        return first;
    }
    (2..).map(|n| format!("{first}-{n}")).find(|id| !taken(id)).expect("a free id")
}

/// A site's address as lms.json keeps it.
fn site_address(site: &Site) -> String {
    site.base.as_str().trim_end_matches('/').to_string()
}

fn save_sign_in_as(vault: &Vault, site: &Site, credential: &Credential, account: Option<&str>) -> Result<ConnectionView, String> {
    let mut st = store::load(vault.root())?;
    let mut accounts = store::load_accounts(vault.root())?;
    let id = choose_connection(&st, &accounts, site, account);
    let secret = serde_json::to_string(credential).map_err(|e| e.to_string())?;
    secrets::lms_vault_set(&vault.name(), &id, &secret)?;
    record_sign_in(&mut st, &mut accounts, site, &id, account);
    store::save(vault.root(), &st)?;
    if let Some(fp) = account
        && accounts.connections.get(&id).is_some_and(|a| a == fp)
    {
        store::save_accounts(vault.root(), &accounts)?;
    }
    Ok(view(st.get(&id).expect("just saved")))
}

/// The connection `id` signed in (made if new), and its account remembered.
fn record_sign_in(st: &mut store::Store, accounts: &mut store::Accounts, site: &Site, id: &str, account: Option<&str>) {
    if let Some(fp) = account {
        accounts.connections.insert(id.to_string(), fp.to_string());
    }
    match st.get_mut(id) {
        Some(c) => c.signed_in = true,
        None => st.connections.push(Conn {
            id: id.to_string(),
            kind: site.kind,
            address: site_address(site),
            school_name: None,
            last_sync: None,
            signed_in: true,
            courses: Default::default(),
        }),
    }
}

/// Remember a school's name for a connection (from the school search).
pub fn set_school_name(root: &Path, id: &str, name: &str) -> Result<(), String> {
    let mut st = store::load(root)?;
    if let Some(c) = st.get_mut(id) {
        let name: String = name.trim().chars().take(120).collect();
        if !name.is_empty() && c.school_name.as_deref() != Some(&name) {
            c.school_name = Some(name);
            store::save(root, &st)?;
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
pub fn session(vault: &Vault, id: &str) -> Result<Session, String> {
    let st = store::load(vault.root())?;
    let c = st.get(id).ok_or("That course site isn’t connected.")?;
    let site = site_of(c)?;
    let credential = secrets::lms_vault_get(&vault.name(), id)?.and_then(|s| serde_json::from_str::<Credential>(&s).ok());
    let Some(credential) = credential else {
        mark_signed_in(vault.root(), id, false);
        return Err(SIGNED_OUT.into());
    };
    Ok(Session::new(site, credential))
}

/// Keep the non-secret signed-in hint in lms.json in step with what was found.
pub fn mark_signed_in(root: &Path, id: &str, signed_in: bool) {
    let Ok(mut st) = store::load(root) else { return };
    if let Some(c) = st.get_mut(id)
        && c.signed_in != signed_in
    {
        c.signed_in = signed_in;
        let _ = store::save(root, &st);
    }
}

/// An error from the site, noting an ended session in lms.json.
fn ended(root: &Path, id: &str, e: String) -> String {
    if e == SIGNED_OUT {
        mark_signed_in(root, id, false);
    }
    e
}

fn lms_error(e: LmsError) -> String {
    match e {
        LmsError::SignedOut => SIGNED_OUT.into(),
        other => other.to_string(),
    }
}

pub async fn courses(vault: &Vault, id: &str) -> Result<Vec<CourseView>, String> {
    let session = session(vault, id)?;
    let list = super::courses(&session).await.map_err(|e| ended(vault.root(), id, lms_error(e)))?;
    let st = store::load(vault.root())?;
    let known: HashMap<&String, bool> = st.get(id).map(|c| c.courses.iter().map(|(k, v)| (k, v.partial)).collect()).unwrap_or_default();
    Ok(list
        .into_iter()
        .map(|c| {
            let partial = known.get(&c.id).copied();
            CourseView { imported: partial == Some(false), partial: partial == Some(true), id: c.id, name: c.name, code: c.code, term: c.term, current: c.current }
        })
        .collect())
}

/// Vaults with an import running (one at a time in a vault).
static IMPORTING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct Busy(String);

impl Busy {
    fn claim(vault: &Path) -> Option<Busy> {
        let key = vault.to_string_lossy().into_owned();
        let mut g = IMPORTING.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashSet::new).insert(key.clone()).then_some(Busy(key))
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

/// Running imports by connection id, so Cancel can reach them.
static RUNNING: Mutex<Option<HashMap<String, Cancel>>> = Mutex::new(None);

/// An import's place in [`RUNNING`] while it runs.
struct Running(String, Cancel);

impl Running {
    fn register(connection: &str, cancel: &Cancel) -> Running {
        let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashMap::new).insert(connection.to_string(), cancel.clone());
        Running(connection.to_string(), cancel.clone())
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(m) = g.as_mut()
            && m.get(&self.0).is_some_and(|c| std::ptr::eq(c.flag(), self.1.flag()))
        {
            m.remove(&self.0);
        }
    }
}

/// Stop the import running for `connection` (`lms_import_cancel`). True when one was
/// running and has been told to stop; it then ends with `Cancelled` and `Done`. The
/// network read in flight is dropped, the text reader and text recognition children are
/// killed, temporary files are removed, and what finished is recorded, so importing the
/// same courses again resumes rather than starting over.
pub fn cancel_import(connection: &str) -> bool {
    let g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    match g.as_ref().and_then(|m| m.get(connection)) {
        Some(c) => {
            c.cancel();
            true
        }
        None => false,
    }
}

/// Import (or update) `course_ids` into `<vault>/courses/`, every one chosen, in
/// order. Each course imported in full for the first time can be seen, all of it, by
/// `spaces` (the space asking, unless the person chose others); a course imported before
/// keeps who can see it. Every outcome is an event; the last one is always `Done`
/// (after `Cancelled` when [`cancel_import`] stopped it).
pub async fn import(vault: &Vault, id: &str, course_ids: &[String], spaces: &[String], emit: &(dyn Fn(ImportEvent) + Send + Sync)) {
    let result = async {
        for s in spaces {
            vault.space_dir(s).map_err(|_| format!("There’s no space called “{s}”."))?;
        }
        let _busy = Busy::claim(vault.root()).ok_or("Courses are already being imported. Wait for that to finish.")?;
        let cancel = Cancel::new();
        let _running = Running::register(id, &cancel);
        let session = session(vault, id)?;
        import_with(vault, id, &session, course_ids, spaces, &cancel, emit).await
    }
    .await;
    finish(result, emit);
}

fn finish(result: Result<(), String>, emit: &(dyn Fn(ImportEvent) + Send + Sync)) {
    match result {
        Ok(()) => {}
        Err(m) if m == CANCELLED => emit(ImportEvent::Cancelled),
        Err(m) => emit(ImportEvent::Error { message: m }),
    }
    emit(ImportEvent::Done);
}

/// [`import`] with a session in hand (tests use a fake site). `Err(CANCELLED)` when stopped.
async fn import_with(
    vault: &Vault,
    id: &str,
    session: &Session,
    course_ids: &[String],
    spaces: &[String],
    cancel: &Cancel,
    emit: &(dyn Fn(ImportEvent) + Send + Sync),
) -> Result<(), String> {
    let root = vault.root();
    let wanted: HashSet<&String> = course_ids.iter().collect();
    let list = cancel.run(super::courses(session)).await?.map_err(|e| ended(vault.root(), id, lms_error(e)))?;
    let chosen: Vec<_> = list.into_iter().filter(|c| wanted.contains(&c.id)).collect();
    if chosen.len() < wanted.len() {
        emit(ImportEvent::Error { message: "Some of the chosen courses aren’t on the course site any more.".into() });
    }
    let courses_root = names::dir_in(root, Path::new(store::COURSES_DIR)).map_err(|e| format!("The courses folder couldn’t be made: {e}"))?;
    for course in chosen {
        if cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        emit(ImportEvent::Progress { course: course.id.clone(), step: "reading", done: 0, total: 1 });
        let mut content = match cancel.run(super::content(session, &course.id)).await? {
            Ok(c) => c,
            Err(LmsError::SignedOut) => return Err(ended(root, id, SIGNED_OUT.into())),
            Err(e) => {
                emit(ImportEvent::Error { message: format!("{}: {e}", course.name) });
                continue;
            }
        };
        // Grades are a bonus: one that can't be read is a line in "Not imported", never a failed import.
        let grades = match cancel.run(super::grades(session, &course.id)).await? {
            Ok(g) => Some(g),
            Err(e) => {
                content.skipped.push(grades_skipped(&e));
                None
            }
        };
        emit(ImportEvent::Progress { course: course.id.clone(), step: "reading", done: 1, total: 1 });
        // Read again for each course: another import may have changed it.
        let st = store::load(root)?;
        let prev = st.get(id).and_then(|c| c.courses.get(&course.id)).cloned();
        let others: Vec<String> = st
            .connections
            .iter()
            .flat_map(|c| c.courses.iter().filter(|(cid, _)| !(c.id == id && **cid == course.id)).map(|(_, s)| s.folder.clone()))
            .collect();
        let cid = course.id.clone();
        let mut progress = |step: &'static str, done: usize, total: usize| emit(ImportEvent::Progress { course: cid.clone(), step, done, total });
        let opts = Options { grades: grades.clone(), cancel: cancel.clone(), ..Options::default() };
        let out = match import::import_course(session, &courses_root, &course, content, prev.as_ref(), &others, &opts, &mut progress).await {
            Ok(o) => o,
            Err(e) => {
                emit(ImportEvent::Error { message: format!("{}: {e}", course.name) });
                continue;
            }
        };
        let mut st = store::load(root)?;
        let folder = out.state.folder.clone();
        let material = out.state.material.as_ref().map(|r| super::material::summarise(r, |_| true));
        let Some(conn) = st.get_mut(id) else {
            return Err("This course site was disconnected while importing.".into());
        };
        // First complete import (a stopped first import doesn't count): the chosen spaces may see it.
        let first_complete = !out.state.partial && prev.as_ref().is_none_or(|p| p.partial);
        conn.courses.insert(course.id.clone(), out.state);
        if out.written {
            conn.last_sync = Some(store::now_ms());
        }
        store::save(root, &st)?;
        if !out.written {
            // Stopped before the course's text was written: what finished is recorded above.
            return Err(CANCELLED.into());
        }
        let mut skipped = out.skipped;
        if first_complete
            && let Err(e) = access::allow_all(vault, spaces, &[access::course_key(id, &course.id)])
        {
            skipped.push(format!("Who can see it: {e}"));
        }
        if let Some(g) = grades
            && let Err(e) = store::put_grades(root, grade_rec(id, &course.id, &course.name, &folder, g))
        {
            skipped.push(format!("Grades: {e}"));
        }
        emit(ImportEvent::Course { course: course.id.clone(), folder: format!("courses/{folder}"), files: out.files, readings: out.readings, links: out.links, skipped, material });
        if out.cancelled {
            return Err(CANCELLED.into());
        }
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

/// The grades of the courses a space may see grades for, from the vault's
/// `.phaethon/grades.json` (no network), by course name.
pub fn grades(vault: &Vault, visible: &Visible) -> Result<Vec<GradeRec>, String> {
    grades_where(vault.root(), |key| visible.courses.iter().any(|c| c.key == key && c.can(Part::Grades)))
}

fn grades_where(root: &Path, allowed: impl Fn(&str) -> bool) -> Result<Vec<GradeRec>, String> {
    let mut list: Vec<GradeRec> = store::load_grades(root)?.courses.into_iter().filter(|(k, _)| allowed(k)).map(|(_, v)| v).collect();
    list.sort_by(|a, b| a.course.to_lowercase().cmp(&b.course.to_lowercase()).then(a.connection.cmp(&b.connection)));
    Ok(list)
}

/// Read the grades again (only grades) for each course imported from connection
/// `id` that the space asking may see grades for: grades.md in the course's
/// folder, the numbers in grades.json. Ends with `Done`; an ended session is one
/// `Error { "signedOut" }` and stops there.
pub async fn grades_refresh(vault: &Vault, visible: &Visible, id: &str, emit: &(dyn Fn(GradesEvent) + Send + Sync)) {
    if let Err(message) = grades_refresh_inner(vault, visible, id, emit).await {
        emit(GradesEvent::Error { message });
    }
    emit(GradesEvent::Done);
}

async fn grades_refresh_inner(vault: &Vault, visible: &Visible, id: &str, emit: &(dyn Fn(GradesEvent) + Send + Sync)) -> Result<(), String> {
    if !visible.courses.iter().any(|c| c.connection == id && c.can(Part::Grades)) {
        return Ok(());
    }
    let allowed = |cid: &str| visible.courses.iter().any(|c| c.connection == id && c.course_id == cid && c.can(Part::Grades));
    let session = session(vault, id)?;
    refresh_grades_with(&session, vault.root(), id, &allowed, emit).await
}

async fn refresh_grades_with(
    session: &Session,
    root: &Path,
    id: &str,
    allowed: &(dyn Fn(&str) -> bool + Send + Sync),
    emit: &(dyn Fn(GradesEvent) + Send + Sync),
) -> Result<(), String> {
    let st = store::load(root)?;
    let courses: Vec<(String, store::CourseState)> =
        st.get(id).map(|c| c.courses.iter().filter(|(k, _)| allowed(k)).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    let total = courses.len();
    for (n, (cid, cs)) in courses.into_iter().enumerate() {
        emit(GradesEvent::Progress { course: cid.clone(), step: "grades", done: n, total });
        let g = match super::grades(session, &cid).await {
            Ok(g) => g,
            Err(LmsError::SignedOut) => return Err(ended(root, id, SIGNED_OUT.into())),
            Err(e) => {
                emit(GradesEvent::Error { message: format!("{}: {e}", cs.name) });
                continue;
            }
        };
        // The folder as the import left it; one removed since isn't made again just for grades.md.
        if let Some(dir) = store::course_dir(root, &cs.folder)
            && let Err(e) = import::write_grades(&dir, &cs.name, &g)
        {
            emit(GradesEvent::Error { message: format!("{}: {e}", cs.name) });
        }
        let rec = grade_rec(id, &cid, &cs.name, &cs.folder, g);
        store::put_grades(root, rec.clone())?;
        emit(GradesEvent::Course { course: cid, grades: Box::new(rec) });
    }
    Ok(())
}

/// Sign out: forget the session (keychain). The connection stays in lms.json,
/// so its imported courses keep their folders and who can see them, and
/// signing in to the same site again picks it up where it was.
pub fn disconnect(vault: &Vault, id: &str) -> Result<(), String> {
    store::load(vault.root())?.get(id).ok_or("That course site isn’t connected.")?;
    secrets::lms_vault_clear(&vault.name(), id)?;
    mark_signed_in(vault.root(), id, false);
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
        assert!(secrets::lms_vault_account("default", &connection_id(&s)).is_ok());
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
        let e = serde_json::to_value(ImportEvent::Course { course: "1".into(), folder: "courses/X".into(), files: 1, readings: 2, links: 3, skipped: vec![], material: None }).unwrap();
        assert_eq!(e, serde_json::json!({"type": "course", "course": "1", "folder": "courses/X", "files": 1, "readings": 2, "links": 3, "skipped": []}));
        let report = crate::lms::material::Report {
            version: 1,
            files: vec![crate::lms::material::FileQuality { path: "files/n.pdf".into(), pages: 2, handwriting: vec![1, 2], ..Default::default() }],
            cant_recognise: None,
        };
        let material = Some(crate::lms::material::summarise(&report, |_| true));
        let e = serde_json::to_value(ImportEvent::Course { course: "1".into(), folder: "courses/X".into(), files: 1, readings: 0, links: 0, skipped: vec![], material }).unwrap();
        assert_eq!(e["material"]["handwritingPages"], 2);
        assert_eq!(e["material"]["lines"][0], "2 pages are handwriting or scans: read with text recognition; may contain mistakes.");
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
        let mut conn = Conn { id: "canvas-x".into(), kind: Kind::Canvas, address: base.into(), school_name: None, last_sync: None, signed_in: false, courses: Default::default() };
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
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| true, &|e| events.lock().unwrap().push(e)).await.unwrap();
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
        let list = grades_where(&dir, |_| true).unwrap();
        assert!(grades_where(&dir, |k| k != "canvas-x/1001").unwrap().is_empty());
        assert_eq!(list.len(), 1);
        assert_eq!(&list[0], rec);
        let v = serde_json::to_value(&list[0]).unwrap();
        for k in ["connection", "courseId", "course", "folder", "updated", "current", "final", "groups", "items"] {
            assert!(v.get(k).is_some(), "{k} in {v}");
        }
        assert_eq!(v["current"], serde_json::json!({"percent": 88.42, "letter": "B+", "points": 168.0}));
        assert_eq!(v["items"][2]["missing"], true);

        // Again: the README keeps one grades line.
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| true, &|_| {}).await.unwrap();
        let readme = std::fs::read_to_string(dir.join("courses/Discrete/README.md")).unwrap();
        assert_eq!(readme.matches("**Grades**").count(), 1, "{readme}");
        // The agent's course index carries the grade.
        std::fs::create_dir_all(dir.join("spaces/s")).unwrap();
        let vault = Vault::at(&dir);
        access::allow_all(&vault, &["s".into()], &["canvas-x/1001".into()]).unwrap();
        let idx = store::prompt_index(&access::visible(&vault, "s").courses, &store::load_grades(&dir).unwrap(), 0).unwrap();
        assert!(idx.contains("- Discrete Structures: courses/Discrete/ Current grade: 88.42% (B+) (grades.md)."), "{idx}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_grades_refresh_stops_signed_out_and_a_hidden_course_is_noted() {
        use crate::lms::fake::{self, json, status};
        let (base, _) = fake::serve(std::sync::Arc::new(|_: &str| status(401))).await;
        let dir = grades_space("signedout", &base);
        let err = refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| true, &|_| {}).await.unwrap_err();
        assert_eq!(err, SIGNED_OUT);
        assert!(!dir.join("courses/Discrete/grades.md").exists());
        assert!(grades_where(&dir, |_| true).unwrap().is_empty());

        let (base, _) = fake::serve(std::sync::Arc::new(|t: &str| if t.starts_with("/api/v1/users/self") { json(r#"{"id":1}"#) } else { status(403) })).await;
        let dir = grades_space("hidden", &base);
        refresh_grades_with(&canvas_session(&base), &dir, "canvas-x", &|_| true, &|_| {}).await.unwrap();
        let md = std::fs::read_to_string(dir.join("courses/Discrete/grades.md")).unwrap();
        assert!(md.contains(crate::lms::GRADES_HIDDEN), "{md}");
        let readme = std::fs::read_to_string(dir.join("courses/Discrete/README.md")).unwrap();
        assert!(readme.contains("**Grades**: Your course site doesn’t show you grades for this course. See [grades.md](grades.md)."), "{readme}");
        assert_eq!(grades_where(&dir, |_| true).unwrap()[0].grades.note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn listing_reads_the_signed_in_hint_and_grades_follow_access() {
        let dir = grades_space("hint", "https://x");
        std::fs::create_dir_all(dir.join("spaces/school")).unwrap();
        std::fs::create_dir_all(dir.join("spaces/work")).unwrap();
        let vault = Vault::at(&dir);
        // No keychain read: the hint in lms.json is what the list says.
        assert!(!connections(&vault).unwrap()[0].signed_in);
        mark_signed_in(&dir, "canvas-x", true);
        assert!(connections(&vault).unwrap()[0].signed_in);
        assert!(store::load(&dir).unwrap().connections[0].signed_in);
        assert_eq!(ended(&dir, "canvas-x", "Not found".into()), "Not found");
        assert!(connections(&vault).unwrap()[0].signed_in, "only an ended session clears it");
        assert_eq!(ended(&dir, "canvas-x", SIGNED_OUT.into()), SIGNED_OUT);
        assert!(!connections(&vault).unwrap()[0].signed_in);
        // Grades: only for a space allowed to see them.
        store::put_grades(&dir, grade_rec("canvas-x", "1001", "Discrete Structures", "Discrete", CourseGrades::default())).unwrap();
        access::set(&vault, "school", "canvas-x/1001", &[Part::Grades]).unwrap();
        access::set(&vault, "work", "canvas-x/1001", &[Part::Overview, Part::Syllabus]).unwrap();
        assert_eq!(grades(&vault, &access::visible(&vault, "school")).unwrap().len(), 1);
        assert!(grades(&vault, &access::visible(&vault, "work")).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_grades_refresh_skips_courses_the_space_cant_see_grades_for() {
        let dir = grades_space("refresh-denied", "http://127.0.0.1:9");
        std::fs::create_dir_all(dir.join("spaces/work")).unwrap();
        let vault = Vault::at(&dir);
        access::set(&vault, "work", "canvas-x/1001", &[Part::Overview]).unwrap();
        let events = Mutex::new(vec![]);
        // Nothing to refresh, so not even the keychain is asked.
        grades_refresh(&vault, &access::visible(&vault, "work"), "canvas-x", &|e| events.lock().unwrap().push(e)).await;
        assert_eq!(events.into_inner().unwrap(), [GradesEvent::Done]);
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

    // ---- Import integrity: every chosen course, cancel and resume, identity, browsing ----

    use crate::lms::cancel::Cancel;
    use crate::lms::fake::{Reply, html as html_reply, json, status, stalled, tagged};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A fake Canvas with two courses, the second only on the second page of the course list.
    /// Course 1 has a.txt (with an ETag) and b.txt, whose download stalls while `stall` is set.
    fn two_course_canvas(stall: Arc<AtomicBool>) -> crate::lms::fake::Route {
        Arc::new(move |t: &str| -> Reply {
            let (path, query) = t.split_once('?').unwrap_or((t, ""));
            match path {
                "/api/v1/courses" if query.contains("enrollment_state=completed") => json("[]"),
                "/api/v1/courses" if query.contains("page=2") => json(r#"[{"id":2,"name":"Beta"}]"#),
                "/api/v1/courses" => {
                    let mut r = json(r#"[{"id":1,"name":"Alpha"}]"#);
                    r.headers.push(("link", "</api/v1/courses?enrollment_state=active&page=2>; rel=\"next\"".into()));
                    r
                }
                "/api/v1/users/self" => json(r#"{"id":42}"#),
                "/api/v1/courses/1" => json(r#"{"id":1,"syllabus_body":"<p>Alpha syllabus</p>"}"#),
                "/api/v1/courses/2" => json(r#"{"id":2,"syllabus_body":"<p>Beta syllabus</p>"}"#),
                "/api/v1/courses/1/files" => json(
                    r#"[{"id":11,"display_name":"a.txt","url":"/files/11/download","size":11},{"id":12,"display_name":"b.txt","url":"/files/12/download"}]"#,
                ),
                "/files/11/download" => tagged("text/plain", "alpha bytes", "\"e1\""),
                "/files/12/download" if stall.load(Ordering::SeqCst) => stalled("text/plain", "partial"),
                "/files/12/download" => json("beta"),
                _ => status(404),
            }
        })
    }

    fn integrity_vault(tag: &str, base: &str) -> (std::path::PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("phaethon-integrity-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("spaces/s")).unwrap();
        std::fs::create_dir_all(dir.join("spaces/other")).unwrap();
        let conn = Conn { id: "canvas-x".into(), kind: Kind::Canvas, address: base.into(), school_name: None, last_sync: None, signed_in: true, courses: Default::default() };
        store::save(&dir, &store::Store { connections: vec![conn] }).unwrap();
        let vault = Vault::at(&dir);
        (dir, vault)
    }

    fn parts_left(dir: &Path) -> Vec<String> {
        let mut out = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.to_string_lossy().ends_with(".part") {
                    out.push(p.to_string_lossy().into_owned());
                }
            }
        }
        out
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_chosen_course_across_list_pages_is_imported_and_a_cancel_resumes_where_it_stopped() {
        let stall = Arc::new(AtomicBool::new(true));
        let (base, log) = crate::lms::fake::serve(two_course_canvas(stall.clone())).await;
        let (dir, vault) = integrity_vault("cancel", &base);
        let ids = vec!["1".to_string(), "2".to_string()];
        let spaces = vec!["s".to_string()];

        // 1. Cancel while b.txt is downloading, through the same registry lms_import_cancel uses.
        assert!(!cancel_import("canvas-x"), "nothing running yet");
        let cancel = Cancel::new();
        let running = Running::register("canvas-x", &cancel);
        let watch = log.clone();
        let canceller = tokio::spawn(async move {
            for _ in 0..400 {
                if watch.lock().unwrap().iter().any(|s| s.target.starts_with("/files/12/download")) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    return cancel_import("canvas-x");
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            false
        });
        let events = Mutex::new(vec![]);
        let started = std::time::Instant::now();
        let r = import_with(&vault, "canvas-x", &canvas_session(&base), &ids, &spaces, &cancel, &|e| events.lock().unwrap().push(e)).await;
        finish(r, &|e| events.lock().unwrap().push(e));
        assert!(canceller.await.unwrap(), "cancel_import found the running import");
        drop(running);
        assert!(!cancel_import("canvas-x"), "unregistered once it ends");
        assert!(started.elapsed() < std::time::Duration::from_secs(30), "the stalled download was interrupted");
        let events = events.into_inner().unwrap();
        assert_eq!(&events[events.len() - 2..], &[ImportEvent::Cancelled, ImportEvent::Done], "{events:?}");
        assert!(!events.iter().any(|e| matches!(e, ImportEvent::Course { .. })), "{events:?}");
        assert_eq!(serde_json::to_value(ImportEvent::Cancelled).unwrap(), serde_json::json!({"type": "cancelled"}));
        // Consistent and resumable: what finished is recorded, nothing half-written is left.
        let st = store::load(&dir).unwrap();
        let alpha = &st.get("canvas-x").unwrap().courses["1"];
        assert!(alpha.partial);
        let a_key = format!("{base}/files/11/download");
        assert_eq!(alpha.files[&a_key].etag.as_deref(), Some("\"e1\""));
        assert_eq!(alpha.files[&a_key].sha256.as_deref(), Some(crate::lms::hash::hex_of(b"alpha bytes").as_str()));
        assert_eq!(alpha.files.len(), 1, "b.txt wasn't finished");
        assert!(!st.get("canvas-x").unwrap().courses.contains_key("2"), "the second course wasn't started");
        assert_eq!(std::fs::read_to_string(dir.join("courses/Alpha/files/a.txt")).unwrap(), "alpha bytes");
        assert!(!dir.join("courses/Alpha/files/b.txt").exists() && !dir.join("courses/Alpha/README.md").exists());
        assert!(parts_left(&dir.join("courses")).is_empty(), "{:?}", parts_left(&dir.join("courses")));
        assert!(access::visible(&vault, "s").courses.is_empty(), "no space sees a course whose first import didn't finish");
        assert!(store::load_grades(&dir).unwrap().courses.is_empty());

        // 2. Import again: it resumes (a.txt is only asked about, not downloaded) and both courses come in.
        stall.store(false, Ordering::SeqCst);
        let before = log.lock().unwrap().len();
        let events = Mutex::new(vec![]);
        let r = import_with(&vault, "canvas-x", &canvas_session(&base), &ids, &spaces, &Cancel::new(), &|e| events.lock().unwrap().push(e)).await;
        finish(r, &|e| events.lock().unwrap().push(e));
        let events = events.into_inner().unwrap();
        let done: Vec<&str> = events.iter().filter_map(|e| if let ImportEvent::Course { course, .. } = e { Some(course.as_str()) } else { None }).collect();
        assert_eq!(done, ["1", "2"], "every chosen course, the second from page 2 of the list: {events:?}");
        assert_eq!(events.last(), Some(&ImportEvent::Done));
        let hits: Vec<crate::lms::fake::Seen> = log.lock().unwrap()[before..].to_vec();
        assert!(hits.iter().any(|s| s.target.contains("page=2")), "the list's second page was read");
        let a_hits: Vec<_> = hits.iter().filter(|s| s.target == "/files/11/download").collect();
        assert_eq!(a_hits.len(), 1);
        assert_eq!(a_hits[0].if_none_match.as_deref(), Some("\"e1\""), "a conditional request, answered 304");
        let st = store::load(&dir).unwrap();
        let conn = st.get("canvas-x").unwrap();
        assert!(!conn.courses["1"].partial && !conn.courses["2"].partial);
        assert_eq!(std::fs::read_to_string(dir.join("courses/Alpha/files/b.txt")).unwrap(), "beta");
        let seen: Vec<String> = access::visible(&vault, "s").courses.iter().map(|c| c.key.clone()).collect();
        assert_eq!(seen, ["canvas-x/1", "canvas-x/2"], "the first complete import gives the chosen space both");
        assert!(access::visible(&vault, "other").courses.is_empty());
        assert!(!dir.join("spaces/s/courses").exists(), "the source tree lives in the vault, never inside a space");

        // 3. The browser: space-relative paths this space may open, nothing for a space without the course.
        let b = course_content(&vault, "s", "canvas-x/1").unwrap();
        let has = |p: &str, k: BrowseKind| b.entries.iter().any(|e| e.path == p && e.kind == k);
        assert!(has("courses/Alpha/README.md", BrowseKind::Overview) && has("courses/Alpha/syllabus.md", BrowseKind::Overview), "{b:?}");
        let a = b.entries.iter().find(|e| e.path == "courses/Alpha/files/a.txt").expect("a.txt listed");
        assert_eq!((a.kind, a.bytes), (BrowseKind::File, Some(11)));
        assert!(b.updated.is_some());
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["entries"][0]["kind"], "overview");
        assert!(course_content(&vault, "other", "canvas-x/1").is_err());
        access::set(&vault, "other", "canvas-x/1", &[Part::Overview]).unwrap();
        let only = course_content(&vault, "other", "canvas-x/1").unwrap();
        assert!(only.entries.iter().all(|e| e.path == "courses/Alpha/README.md"), "{only:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_connection_is_reused_only_for_its_own_site_and_account() {
        let mut st = store::Store::default();
        let mut acc = store::Accounts::default();
        let canvas = Site::new(Kind::Canvas, "https://iu.instructure.com").unwrap();
        let fp = |id: &str| crate::lms::account_fingerprint(&canvas, id);
        assert_eq!(fp("42"), fp("42"));
        assert_eq!(fp("42").len(), 32);
        assert_ne!(fp("42"), fp("99"));
        // A connection from before accounts were kept, with an imported course and its choices.
        record_sign_in(&mut st, &mut acc, &canvas, "canvas-iu-instructure-com", None);
        st.get_mut("canvas-iu-instructure-com").unwrap().courses.insert("7".into(), store::CourseState { name: "Calc".into(), folder: "Calc".into(), ..Default::default() });
        // The first account to sign in claims it; signing in again as it finds it, courses kept.
        let a = choose_connection(&st, &acc, &canvas, Some(&fp("42")));
        assert_eq!(a, "canvas-iu-instructure-com");
        record_sign_in(&mut st, &mut acc, &canvas, &a, Some(&fp("42")));
        assert_eq!(choose_connection(&st, &acc, &canvas, Some(&fp("42"))), a);
        assert!(st.get(&a).unwrap().courses.contains_key("7"), "reconnecting keeps the imported courses");
        assert_eq!(st.connections.len(), 1, "no duplicate on reconnect");
        // Another account on the same site: its own connection, deterministically named.
        let b = choose_connection(&st, &acc, &canvas, Some(&fp("99")));
        assert_ne!(b, a);
        assert_eq!(b, choose_connection(&st, &acc, &canvas, Some(&fp("99"))));
        record_sign_in(&mut st, &mut acc, &canvas, &b, Some(&fp("99")));
        assert!(st.get(&b).unwrap().courses.is_empty());
        assert_eq!(choose_connection(&st, &acc, &canvas, Some(&fp("42"))), a);
        assert_eq!(choose_connection(&st, &acc, &canvas, Some(&fp("99"))), b);
        // Unknown identity never lands on a known account's connection.
        let unknown = choose_connection(&st, &acc, &canvas, None);
        assert!(unknown != a && unknown != b, "{unknown}");

        // Two Moodles under one host: never one id for both, each kept on reconnect.
        let m1 = Site::new(Kind::Moodle, "https://x.edu/moodle-a/").unwrap();
        let m2 = Site::new(Kind::Moodle, "https://x.edu/moodle-b/").unwrap();
        assert_eq!(connection_id(&m1), connection_id(&m2), "the host-only id collides");
        let id1 = choose_connection(&st, &acc, &m1, None);
        record_sign_in(&mut st, &mut acc, &m1, &id1, None);
        let id2 = choose_connection(&st, &acc, &m2, None);
        assert_ne!(id1, id2);
        record_sign_in(&mut st, &mut acc, &m2, &id2, None);
        assert_eq!(choose_connection(&st, &acc, &m1, None), id1);
        assert_eq!(choose_connection(&st, &acc, &m2, None), id2);
        assert_eq!(st.get(&id2).unwrap().address, "https://x.edu/moodle-b");
        assert!(id2.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert!(access::course_key(&id2, "5").len() < 128);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_identity_check_saves_nothing_and_keeps_the_known_accounts_session() {
        // Canvas answers the account call with an error (and a login page for good measure).
        let (base, log) = crate::lms::fake::serve(Arc::new(|t: &str| if t.starts_with("/api/v1/users/self") { status(500) } else { html_reply("<html>login</html>") })).await;
        let (dir, vault) = integrity_vault("identity", &base);
        let site = Site::for_test(Kind::Canvas, &base);
        let mut acc = store::Accounts::default();
        acc.connections.insert("canvas-x".into(), crate::lms::account_fingerprint(&site, "42"));
        store::save_accounts(&dir, &acc).unwrap();
        let before_store = store::load(&dir).unwrap();
        let cred = Credential { cookies: vec![super::super::Cookie { name: "_normandy_session".into(), value: "someone-else".into() }], csrf: None };
        let err = finish_sign_in(&vault, &site, &cred, Some("School".into())).await.unwrap_err();
        assert!(err.contains("nothing was saved"), "{err}");
        assert!(log.lock().unwrap().iter().any(|s| s.target == "/api/v1/users/self"));
        assert_eq!(store::load(&dir).unwrap(), before_store, "lms.json untouched");
        assert_eq!(store::load_accounts(&dir).unwrap(), acc, "the known account stays");
        // (No keychain access happened: the error comes before the session would be stored.)
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn account_ids_come_from_each_sites_documented_whoami() {
        let (base, _) = crate::lms::fake::serve(Arc::new(|t: &str| if t.starts_with("/api/v1/users/self") { json(r#"{"id":4242,"name":"Sam"}"#) } else { status(404) })).await;
        assert_eq!(crate::lms::account(&canvas_session(&base)).await.unwrap().as_deref(), Some("4242"));
        let moodle = Session::new(Site::for_test(Kind::Moodle, &base), Credential { cookies: vec![], csrf: None });
        assert_eq!(crate::lms::account(&moodle).await.unwrap(), None, "Moodle: no per-account identity claimed");
    }
}
