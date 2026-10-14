//! Course sites used to belong to one space: `<space>/.phaethon/lms.json`,
//! `<space>/.phaethon/grades.json`, `<space>/courses/<folder>/` and a keychain
//! entry `<vault>/space/<space>/lms/<id>`. Now they belong to the vault. On
//! launch, each space's are moved there once, and the space they came from
//! may see every part of the courses it had.
//!
//! Safe to stop at any point and run again: the new state is written before
//! the old is removed, each step checks what's already done, and nothing that
//! is already at the vault level is overwritten. A course folder is moved (one
//! rename), never copied. The session is read from the old keychain entry,
//! written to the new one, and only then removed; its value is never logged.

use std::fs;
use std::io;
use std::path::Path;

use super::access;
use super::names;
use super::store::{self, COURSES_DIR, GRADES_FILE, GradeBook, Store};
use crate::tools::STATE_DIR;
use crate::vault::Vault;

/// The keychain, as the move needs it (a fake one in tests).
pub trait Keys {
    fn space_get(&self, space: &str, connection: &str) -> Result<Option<String>, String>;
    fn space_clear(&self, space: &str, connection: &str) -> Result<(), String>;
    fn vault_get(&self, connection: &str) -> Result<Option<String>, String>;
    fn vault_set(&self, connection: &str, secret: &str) -> Result<(), String>;
}

/// The real keychain, for one vault.
pub struct Keychain(pub String);

impl Keys for Keychain {
    fn space_get(&self, space: &str, connection: &str) -> Result<Option<String>, String> {
        crate::secrets::lms_get(&self.0, space, connection)
    }
    fn space_clear(&self, space: &str, connection: &str) -> Result<(), String> {
        crate::secrets::lms_clear(&self.0, space, connection)
    }
    fn vault_get(&self, connection: &str) -> Result<Option<String>, String> {
        crate::secrets::lms_vault_get(&self.0, connection)
    }
    fn vault_set(&self, connection: &str, secret: &str) -> Result<(), String> {
        crate::secrets::lms_vault_set(&self.0, connection, secret)
    }
}

/// What a run did, in plain words (for the dev log; never a secret).
#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub moved: Vec<String>,
    pub notes: Vec<String>,
}

/// Move every space's course sites to the vault. Spaces without any are
/// left alone.
pub fn run(vault: &Vault, keys: &dyn Keys) -> Report {
    let mut report = Report::default();
    for space in access::spaces(vault) {
        let Ok(dir) = vault.space_dir(&space) else { continue };
        if let Err(e) = move_space(vault, &space, &dir, keys, &mut report) {
            report.notes.push(format!("{space}: {e}"));
        }
    }
    adopt_left_sign_ins(vault, keys, &mut report);
    report
}

/// A vault connection marked signed out whose session is still under a space's
/// old keychain entry (an earlier move couldn't read it and went on without it):
/// moved now, the same way. Only signed-out connections are looked at, so a
/// normal launch reads nothing from the keychain.
fn adopt_left_sign_ins(vault: &Vault, keys: &dyn Keys, report: &mut Report) {
    let root = vault.root();
    let Ok(st) = store::load(root) else { return };
    for conn in st.connections.iter().filter(|c| !c.signed_in) {
        for space in access::spaces(vault) {
            let found = match keys.space_get(&space, &conn.id) {
                Ok(Some(secret)) => secret,
                Ok(None) => continue,
                Err(e) => {
                    report.notes.push(format!("{space}: the sign-in for {} couldn’t be read yet ({e}); trying again next time", conn.id));
                    break;
                }
            };
            let moved = match keys.vault_get(&conn.id) {
                Ok(Some(_)) => true,
                Ok(None) => keys.vault_set(&conn.id, &found).is_ok() && keys.vault_get(&conn.id).ok().flatten().is_some_and(|s| s == found),
                Err(_) => false,
            };
            if moved {
                let _ = keys.space_clear(&space, &conn.id);
                super::service::mark_signed_in(root, &conn.id, true);
                report.moved.push(format!("{space}: the sign-in for {} → the vault", conn.id));
            }
            break;
        }
    }
}

fn move_space(vault: &Vault, space: &str, dir: &Path, keys: &dyn Keys, report: &mut Report) -> Result<(), String> {
    let old_file = dir.join(STATE_DIR).join(store::FILE);
    let old_grades = dir.join(STATE_DIR).join(GRADES_FILE);
    if fs::symlink_metadata(&old_file).is_err() {
        // A space without course sites; maybe only a grades file left by an interrupted move.
        if fs::symlink_metadata(&old_grades).is_ok_and(|m| m.is_file()) {
            merge_grades(vault, dir, &store::load(vault.root())?)?;
            let _ = fs::remove_file(&old_grades);
        }
        return Ok(());
    }
    let old = store::load(dir)?;
    let root = vault.root();

    // 1. The record, merged into the vault's: connections and courses it doesn't
    //    have yet are added; a course already there keeps the vault's record.
    //    A folder name already taken at the vault level gets " (2)" and so on.
    let mut new = store::load(root)?;
    let mut moves: Vec<(String, String)> = vec![]; // (folder in the space, folder in the vault)
    let mut keys_moved: Vec<String> = vec![];
    for conn in &old.connections {
        if new.get(&conn.id).is_none() {
            let mut c = conn.clone();
            c.courses.clear();
            c.signed_in = false;
            new.connections.push(c);
        }
        for (cid, state) in &conn.courses {
            let taken: Vec<String> = new.folders();
            let target = new.get_mut(&conn.id).expect("added above");
            let folder = match target.courses.get(cid) {
                Some(there) => there.folder.clone(),
                None => {
                    let folder = free_folder(root, &state.folder, &taken);
                    target.courses.insert(cid.clone(), store::CourseState { folder: folder.clone(), ..state.clone() });
                    folder
                }
            };
            if target.last_sync < conn.last_sync {
                target.last_sync = conn.last_sync;
            }
            if target.school_name.is_none() {
                target.school_name.clone_from(&conn.school_name);
            }
            moves.push((state.folder.clone(), folder));
            keys_moved.push(access::course_key(&conn.id, cid));
        }
    }
    store::save(root, &new)?;

    // 2. The space it came from may see all of it.
    access::allow_all(vault, &[space.to_string()], &keys_moved)?;

    // 3. The sessions: old entry read, new one written (unless the vault already
    //    has one), and only then the old one removed.
    for conn in &old.connections {
        // Unreadable (macOS asked for keychain access and nobody said yes): stop here,
        // keeping the old record, so the next launch tries again rather than leaving
        // the sign-in behind.
        let had = keys.space_get(space, &conn.id).map_err(|e| format!("the sign-in for {} couldn’t be read yet ({e}); trying again next time", conn.id))?;
        let signed_in = match (had, keys.vault_get(&conn.id)?) {
            (_, Some(_)) => true,
            (Some(secret), None) => {
                keys.vault_set(&conn.id, &secret)?;
                // Check it landed before the old one goes.
                keys.vault_get(&conn.id)?.is_some_and(|s| s == secret)
            }
            (None, None) => false,
        };
        if signed_in {
            keys.space_clear(space, &conn.id)?;
            super::service::mark_signed_in(root, &conn.id, true);
        }
    }

    // 4. Grades, with their folders as they are now.
    merge_grades(vault, dir, &new)?;

    // 5. The folders: one rename each, never over something already there.
    let courses_root = names::dir_in(root, Path::new(COURSES_DIR)).map_err(|e| format!("the courses folder couldn’t be made: {e}"))?;
    for (from, to) in &moves {
        let src = dir.join(COURSES_DIR).join(from);
        let dst = courses_root.join(to);
        let plain = names::segment(from) == *from && fs::symlink_metadata(dir.join(COURSES_DIR)).is_ok_and(|m| m.is_dir());
        match (plain && fs::symlink_metadata(&src).is_ok_and(|m| m.is_dir()), fs::symlink_metadata(&dst).is_ok()) {
            (true, false) => {
                fs::rename(&src, &dst).map_err(|e| format!("“{from}” couldn’t be moved: {e}"))?;
                report.moved.push(format!("{space}/courses/{from} → courses/{to}"));
            }
            (true, true) => report.notes.push(format!("{space}/courses/{from} stays where it is: the vault already has courses/{to}.")),
            (false, _) => {}
        }
    }
    // The space's courses folder goes when nothing is left in it (macOS litter aside).
    let left = dir.join(COURSES_DIR);
    if fs::symlink_metadata(&left).is_ok_and(|m| m.is_dir()) {
        let _ = fs::remove_file(left.join(".DS_Store"));
        let _ = fs::remove_dir(&left);
    }

    // 6. Last, the old record.
    remove(&old_grades)?;
    remove(&old_file)?;
    Ok(())
}

/// A folder name for a course at the vault level that no other course and no
/// folder already there uses.
fn free_folder(root: &Path, want: &str, taken: &[String]) -> String {
    let base = names::segment(want);
    let used = |f: &str| taken.iter().any(|t| t.eq_ignore_ascii_case(f)) || fs::symlink_metadata(root.join(COURSES_DIR).join(f)).is_ok();
    if !used(&base) {
        return base;
    }
    (2..).map(|n| format!("{base} ({n})")).find(|f| !used(f)).expect("a free name")
}

/// Put the space's grades.json entries into the vault's, with folders as the
/// vault has them; an entry the vault already has stays.
fn merge_grades(vault: &Vault, dir: &Path, new: &Store) -> Result<(), String> {
    let theirs = store::load_grades(dir)?;
    if theirs.courses.is_empty() {
        return Ok(());
    }
    let mut book: GradeBook = store::load_grades(vault.root())?;
    for (key, mut rec) in theirs.courses {
        if book.courses.contains_key(&key) {
            continue;
        }
        if let Some(state) = new.get(&rec.connection).and_then(|c| c.courses.get(&rec.course_id)) {
            rec.folder = format!("{COURSES_DIR}/{}", state.folder);
        }
        book.courses.insert(key, rec);
    }
    store::save_grades(vault.root(), &book)
}

fn remove(p: &Path) -> Result<(), String> {
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} couldn’t be removed: {e}", p.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::Kind;
    use crate::lms::access::Part;
    use crate::lms::store::{Conn, CourseState, GradeRec};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    /// A keychain in memory: (account → secret), and every account read.
    #[derive(Default)]
    struct Fake {
        entries: RefCell<BTreeMap<String, String>>,
        fail_vault_set: bool,
        fail_space_get: bool,
    }

    impl Keys for Fake {
        fn space_get(&self, space: &str, c: &str) -> Result<Option<String>, String> {
            if self.fail_space_get {
                return Err("Unable to obtain authorization for this operation.".into());
            }
            Ok(self.entries.borrow().get(&format!("space/{space}/{c}")).cloned())
        }
        fn space_clear(&self, space: &str, c: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(&format!("space/{space}/{c}"));
            Ok(())
        }
        fn vault_get(&self, c: &str) -> Result<Option<String>, String> {
            Ok(self.entries.borrow().get(&format!("vault/{c}")).cloned())
        }
        fn vault_set(&self, c: &str, secret: &str) -> Result<(), String> {
            if self.fail_vault_set {
                return Err("keychain locked".into());
            }
            self.entries.borrow_mut().insert(format!("vault/{c}"), secret.into());
            Ok(())
        }
    }

    const IU: &str = "canvas-iu-instructure-com";
    const SECRET: &str = r#"{"cookies":[{"name":"canvas_session","value":"s3cr3t"}],"csrf":"t"}"#;

    /// The owner's layout: four Canvas courses imported into spaces/school.
    fn old_vault(tag: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("phaethon-migrate-lms-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for s in ["school", "work"] {
            fs::create_dir_all(dir.join("spaces").join(s).join(".phaethon")).unwrap();
        }
        let school = dir.join("spaces/school");
        let mut conn = Conn { id: IU.into(), kind: Kind::Canvas, address: "https://iu.instructure.com".into(), school_name: Some("Indiana University".into()), last_sync: Some(5), signed_in: false, courses: BTreeMap::new() };
        for (id, folder) in [
            ("2411651", "CSCI-C 241 Fall 2026 (All Sections)"),
            ("2411519", "FA26- INTRO ARTIFICIAL INTELLIGENCE- 1382"),
            ("2411657", "FA26- SYSTEM PROG WITH C AND UNIX- 11310"),
            ("2416319", "FA26- LINEAR ALGEBRA & APPLICATIONS- 11179"),
        ] {
            let c = school.join("courses").join(folder);
            fs::create_dir_all(c.join("files/Notes")).unwrap();
            fs::write(c.join("README.md"), format!("# {folder}\n")).unwrap();
            fs::write(c.join("syllabus.md"), "Syllabus.\n").unwrap();
            fs::write(c.join("files/Notes/a.pdf.md"), "Notes.\n").unwrap();
            conn.courses.insert(id.into(), CourseState { name: folder.into(), folder: folder.into(), ..Default::default() });
        }
        store::save(&school, &Store { connections: vec![conn] }).unwrap();
        let mut book = GradeBook::default();
        book.courses.insert(
            format!("{IU}/2411651"),
            GradeRec { connection: IU.into(), course_id: "2411651".into(), course: "C241".into(), folder: "courses/CSCI-C 241 Fall 2026 (All Sections)".into(), updated: 1, grades: Default::default() },
        );
        store::save_grades(&school, &book).unwrap();
        (dir.clone(), Vault::at(&dir))
    }

    fn keys_with_old() -> Fake {
        let k = Fake::default();
        k.entries.borrow_mut().insert(format!("space/school/{IU}"), SECRET.into());
        k
    }

    fn check_moved(dir: &Path, v: &Vault, k: &Fake) {
        let school = dir.join("spaces/school");
        assert!(!school.join("courses").exists(), "the space's courses folder is gone");
        assert!(!school.join(".phaethon/lms.json").exists() && !school.join(".phaethon/grades.json").exists());
        let st = store::load(dir).unwrap();
        assert_eq!(st.connections.len(), 1);
        let c = &st.connections[0];
        assert_eq!((c.id.as_str(), c.school_name.as_deref(), c.last_sync, c.signed_in), (IU, Some("Indiana University"), Some(5), true));
        assert_eq!(c.courses.len(), 4);
        for s in c.courses.values() {
            assert!(dir.join("courses").join(&s.folder).join("files/Notes/a.pdf.md").is_file(), "{}", s.folder);
        }
        assert_eq!(store::load_grades(dir).unwrap().courses[&format!("{IU}/2411651")].folder, "courses/CSCI-C 241 Fall 2026 (All Sections)");
        // The keychain: moved, the old entry gone, nothing else touched.
        assert_eq!(*k.entries.borrow(), BTreeMap::from([(format!("vault/{IU}"), SECRET.to_string())]));
        // School sees everything; work nothing.
        let vis = access::visible(v, "school");
        assert_eq!(vis.courses.len(), 4);
        assert!(vis.courses.iter().all(|c| c.parts == Part::ALL.into_iter().collect::<BTreeSet<_>>()));
        assert!(access::visible(v, "work").is_empty());
    }

    #[test]
    fn a_fresh_move_and_a_second_run_that_finds_nothing_to_do() {
        let (dir, v) = old_vault("fresh");
        let k = keys_with_old();
        let r = run(&v, &k);
        assert_eq!(r.moved.len(), 4, "{r:?}");
        assert!(r.notes.is_empty(), "{r:?}");
        check_moved(&dir, &v, &k);
        // Again: nothing changes.
        let before = fs::read_to_string(dir.join(".phaethon/lms.json")).unwrap();
        let r = run(&v, &k);
        assert_eq!(r, Report::default());
        assert_eq!(fs::read_to_string(dir.join(".phaethon/lms.json")).unwrap(), before);
        check_moved(&dir, &v, &k);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stopped_halfway_it_finishes_on_the_next_run() {
        let (dir, v) = old_vault("halfway");
        let k = keys_with_old();
        // As if stopped after the record, the access and two folders were moved,
        // before the keychain and the rest: run fully on a copy, then put the
        // space's record and two folders back.
        run(&v, &k);
        let school = dir.join("spaces/school");
        fs::create_dir_all(school.join("courses")).unwrap();
        for f in ["CSCI-C 241 Fall 2026 (All Sections)", "FA26- INTRO ARTIFICIAL INTELLIGENCE- 1382"] {
            fs::rename(dir.join("courses").join(f), school.join("courses").join(f)).unwrap();
        }
        let (_, old) = old_vault("halfway-src");
        let src = std::env::temp_dir().join(format!("phaethon-migrate-lms-halfway-src-{}", std::process::id()));
        fs::copy(src.join("spaces/school/.phaethon/lms.json"), school.join(".phaethon/lms.json")).unwrap();
        fs::copy(src.join("spaces/school/.phaethon/grades.json"), school.join(".phaethon/grades.json")).unwrap();
        drop(old);
        fs::remove_dir_all(&src).unwrap();
        k.entries.borrow_mut().insert(format!("space/school/{IU}"), SECRET.into());
        let r = run(&v, &k);
        assert_eq!(r.moved.len(), 2, "{r:?}");
        check_moved(&dir, &v, &k);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_keychain_that_fails_keeps_the_old_sign_in() {
        let (dir, v) = old_vault("keyfail");
        let k = Fake { fail_vault_set: true, ..keys_with_old() };
        let r = run(&v, &k);
        assert_eq!(r.notes.len(), 1, "{r:?}");
        assert!(!r.notes[0].contains("s3cr3t"), "never the secret");
        // The old entry and the old record stay, so the next run can finish.
        assert_eq!(k.space_get("school", IU).unwrap().as_deref(), Some(SECRET));
        assert!(dir.join("spaces/school/.phaethon/lms.json").exists());
        let k = Fake { fail_vault_set: false, entries: k.entries, ..Fake::default() };
        run(&v, &k);
        check_moved(&dir, &v, &k);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// What happened on the owner's machine: macOS refused the keychain read while
    /// nobody was there. Nothing moves until it can be read; then all of it does.
    #[test]
    fn an_unreadable_sign_in_waits_for_the_next_launch() {
        let (dir, v) = old_vault("readfail");
        let k = Fake { fail_space_get: true, ..keys_with_old() };
        let r = run(&v, &k);
        assert!(r.notes.iter().any(|n| n.contains("trying again next time")), "{r:?}");
        assert!(dir.join("spaces/school/.phaethon/lms.json").exists(), "the old record stays");
        assert_eq!(k.entries.borrow().get(&format!("space/school/{IU}")).map(String::as_str), Some(SECRET));
        let k = Fake { fail_space_get: false, entries: k.entries, ..Fake::default() };
        run(&v, &k);
        check_moved(&dir, &v, &k);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A sign-in an earlier move left under the space's old entry (its record already
    /// gone, the connection marked signed out) is picked up on the next launch.
    #[test]
    fn a_sign_in_left_behind_is_picked_up() {
        let (dir, v) = old_vault("left");
        let k = keys_with_old();
        run(&v, &k);
        check_moved(&dir, &v, &k);
        // Put things as the owner's machine has them: the session still in the old entry.
        let secret = k.entries.borrow_mut().remove(&format!("vault/{IU}")).unwrap();
        k.entries.borrow_mut().insert(format!("space/school/{IU}"), secret);
        crate::lms::service::mark_signed_in(&dir, IU, false);
        let r = run(&v, &k);
        assert!(r.moved.iter().any(|m| m.contains("the sign-in")), "{r:?}");
        check_moved(&dir, &v, &k);
        // And a launch with nothing left to pick up reads no keychain entry for it.
        let k2 = Fake { fail_space_get: true, entries: k.entries, ..Fake::default() };
        let r = run(&v, &k2);
        assert!(r.notes.is_empty() && r.moved.is_empty(), "{r:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_name_taken_at_the_vault_level_gets_another() {
        let (dir, v) = old_vault("taken");
        fs::create_dir_all(dir.join("courses/CSCI-C 241 Fall 2026 (All Sections)")).unwrap();
        fs::write(dir.join("courses/CSCI-C 241 Fall 2026 (All Sections)/mine.md"), "someone else's").unwrap();
        let k = keys_with_old();
        run(&v, &k);
        let st = store::load(&dir).unwrap();
        assert_eq!(st.connections[0].courses["2411651"].folder, "CSCI-C 241 Fall 2026 (All Sections) (2)");
        assert!(dir.join("courses/CSCI-C 241 Fall 2026 (All Sections) (2)/syllabus.md").is_file());
        assert_eq!(fs::read_to_string(dir.join("courses/CSCI-C 241 Fall 2026 (All Sections)/mine.md")).unwrap(), "someone else's");
        assert_eq!(store::load_grades(&dir).unwrap().courses[&format!("{IU}/2411651")].folder, "courses/CSCI-C 241 Fall 2026 (All Sections) (2)");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// On a copy of a real vault (never the real one), with a fake keychain:
    /// `PHAETHON_MIGRATE_COPY=<copy> cargo test on_a_copy -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a copy of a real vault"]
    fn on_a_copy_of_a_real_vault() {
        let root = PathBuf::from(std::env::var("PHAETHON_MIGRATE_COPY").expect("PHAETHON_MIGRATE_COPY"));
        assert!(!root.starts_with(crate::vault::home_dir().unwrap().join("Phaethon")), "only ever a copy");
        let v = Vault::at(&root);
        let k = Fake::default();
        let mut before = vec![];
        for space in access::spaces(&v) {
            let dir = root.join("spaces").join(&space);
            if let Ok(st) = store::load(&dir) {
                for c in &st.connections {
                    k.entries.borrow_mut().insert(format!("space/{space}/{}", c.id), "fake secret".into());
                    for s in c.courses.values() {
                        let n = fs::read_dir(dir.join("courses").join(&s.folder)).map(|r| r.count()).unwrap_or(0);
                        before.push((space.clone(), c.id.clone(), s.folder.clone(), n));
                    }
                }
            }
        }
        let r = run(&v, &k);
        eprintln!("{r:#?}");
        let st = store::load(&root).unwrap();
        for (space, conn, folder, n) in &before {
            let c = st.get(conn).unwrap();
            let s = c.courses.values().find(|s| &s.folder == folder).expect("same folder name");
            assert_eq!(fs::read_dir(root.join("courses").join(&s.folder)).unwrap().count(), *n, "{folder}");
            assert!(!root.join("spaces").join(space).join("courses").join(folder).exists());
            assert!(c.signed_in);
            let vis = access::visible(&v, space);
            assert!(vis.get(folder).is_some_and(|seen| seen.parts.len() == Part::ALL.len()), "{folder}");
        }
        assert!(k.entries.borrow().keys().all(|a| a.starts_with("vault/")), "{:?}", k.entries.borrow());
        assert_eq!(run(&v, &k), Report::default(), "a second run does nothing");
        eprintln!("{} courses moved; course-access.json:\n{}", before.len(), fs::read_to_string(root.join(".phaethon/course-access.json")).unwrap());
    }

    #[test]
    fn a_vault_without_course_sites_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("phaethon-migrate-lms-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("spaces/school/notes")).unwrap();
        let v = Vault::at(&dir);
        assert_eq!(run(&v, &Fake::default()), Report::default());
        assert!(!dir.join(".phaethon").exists() && !dir.join("courses").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
