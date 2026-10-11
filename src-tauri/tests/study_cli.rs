//! Making a deck with the real Claude Code CLI, from a copy of a course file.
//! It uses the person's own CLI login, so it is ignored by default; run with
//! `STUDY_SOURCE=<a .pdf.md file> cargo test --test study_cli -- --ignored --nocapture`.

use phaethon_lib::study::generate::{self, DeckOptions, StudyEvent};
use phaethon_lib::lms::{access, store};
use phaethon_lib::study::model::CliModel;
use phaethon_lib::vault::Vault;

#[test]
#[ignore = "calls the real Claude Code CLI"]
fn makes_cards_from_a_course_file_with_the_real_cli() {
    let source = std::env::var("STUDY_SOURCE").expect("STUDY_SOURCE names a text copy to read");
    let source = std::path::Path::new(&source);
    let root = std::env::temp_dir().join(format!("phaethon-study-real-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let space = root.join("spaces/school");
    std::fs::create_dir_all(&space).unwrap();
    let dir = root.join("courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW");
    std::fs::create_dir_all(&dir).unwrap();
    let name = source.file_name().unwrap().to_string_lossy().into_owned();
    std::fs::copy(source, dir.join(&name)).unwrap();
    let rel = format!("courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/{name}");
    // The course belongs to the vault; the space sees all of it.
    let mut conn = store::Conn { id: "canvas-x".into(), kind: phaethon_lib::lms::Kind::Canvas, address: "https://x".into(), school_name: None, last_sync: None, signed_in: true, courses: Default::default() };
    let folder = "CSCI-C 241 Fall 2026 (All Sections)".to_string();
    conn.courses.insert("1".into(), store::CourseState { name: folder.clone(), folder, ..Default::default() });
    store::save(&root, &store::Store { connections: vec![conn] }).unwrap();
    let vault = Vault::at(&root);
    access::allow_all(&vault, &["school".into()], &["canvas-x/1".into()]).unwrap();
    let visible = access::visible(&vault, "school");

    let bin = phaethon_lib::agent::find_claude().expect("claude is installed");
    let model = CliModel { bin, cwd: space.clone(), config_dir: None };
    let emit = |e: StudyEvent| eprintln!("{e:?}");
    let opts = DeckOptions { count: 8, ..Default::default() };
    let started = std::time::Instant::now();
    let (path, n) = tauri::async_runtime::block_on(generate::make_deck(&space, &visible, &[rel], &opts, &model, &emit)).unwrap();
    eprintln!("made {n} cards in {:?} at {}", started.elapsed(), space.join(&path).display());
    println!("{}", std::fs::read_to_string(space.join(&path)).unwrap());
    assert!((1..=8).contains(&n));
}
