//! Brings in the earlier Claude Code conversations of a real space, as a launch
//! would (once). Ignored, and it touches nothing unless PHAETHON_IMPORT_SPACE
//! names the space's folder; Claude Code's folder is ~/.claude unless
//! CLAUDE_CONFIG_DIR says otherwise. Back the space's .phaethon up first.
//!
//!   PHAETHON_IMPORT_SPACE=~/Phaethon/default/spaces/school \
//!     cargo test --test cli_import_real -- --ignored --nocapture

use std::path::PathBuf;

use phaethon_lib::{cli_import, thread};

#[test]
#[ignore]
fn import_a_real_space() {
    let Some(space) = std::env::var_os("PHAETHON_IMPORT_SPACE").map(PathBuf::from) else {
        eprintln!("PHAETHON_IMPORT_SPACE isn't set: nothing done");
        return;
    };
    let space = space.canonicalize().expect("the space's folder");
    let home = cli_import::claude_home(None).expect("Claude Code's folder");
    for p in cli_import::transcripts(&home, &space) {
        eprintln!("transcript: {}", p.display());
    }
    eprintln!("known before: {:?}", cli_import::known_sessions(&space));
    let titles = cli_import::import_once(&space, &home).expect("brought in");
    eprintln!("brought in: {titles:?}");
    for t in thread::list(&space).unwrap() {
        eprintln!("listed: {} | {} | {} messages | updated {}", t.id, t.title, t.messages, t.updated);
    }
}
