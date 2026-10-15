//! Each installed CLI's model list, from the real CLI: one listing call each,
//! no model turn, Codex and Gemini CLI with a throwaway home of their own
//! (signed out). `cargo test --test cli_models -- --ignored --nocapture`.
#![cfg(unix)]

use phaethon_lib::agent::{Cli, models};

#[test]
#[ignore = "runs the installed claude, codex and gemini (listing only)"]
fn each_installed_cli_lists_its_models() {
    for cli in Cli::ALL {
        if cli.find().is_none() {
            eprintln!("{}: not installed", cli.name());
            continue;
        }
        let home = std::env::temp_dir().join(format!("phaethon-cli-models-{}-{}", cli.id(), std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let listed = tauri::async_runtime::block_on(models::list(cli, cli.own_home().then_some(home.as_path())));
        eprintln!("{}: {:?} note: {:?}", cli.name(), listed.models.iter().map(|m| &m.id).collect::<Vec<_>>(), listed.note);
        assert!(!listed.models.is_empty(), "{} lists models", cli.name());
        if cli == Cli::Codex {
            assert_eq!(listed.note, None, "Codex lists its own models");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
