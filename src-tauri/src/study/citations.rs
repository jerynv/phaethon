//! Citations in a chat reply, checked when the reply is shown. Every backend
//! is asked to cite the course as `[source: courses/<folder>/<file> "words"]`
//! (scope.rs's prompt section); the webview finds them in the text and asks
//! here whether each quote is really in that file, as this space may read it.
//! Post hoc and on the text alone, so it works the same whoever answered.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::quote;
use super::sources;
use crate::lms::access::Visible;

/// Most citations checked in one call.
pub const MAX: usize = 60;
const AROUND: usize = 400;

#[derive(Debug, Clone, Deserialize)]
pub struct Asked {
    pub path: String,
    pub quote: String,
}

/// What a citation turned out to be.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub found: bool,
    /// The file as the space names it (the original for a text copy), or the path as written.
    pub path: String,
    /// Its file name, for the chip.
    pub name: String,
    /// Where in the file: "§5.3", "#3".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The passage, with the text either side.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub before: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub passage: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub after: String,
    /// Why it wasn't found, in plain words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

fn name_of(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p).to_string()
}

/// Check each citation against its file. Never fails as a whole: each says what it is.
pub fn check(space: &Path, visible: &Visible, asked: &[Asked]) -> Vec<Checked> {
    let mut read: Vec<(String, Result<sources::Cited, String>)> = vec![];
    asked
        .iter()
        .take(MAX)
        .map(|a| {
            let path = a.path.trim().trim_matches(['"', '\'', '`']).to_string();
            let miss = |why: &str, path: String| Checked { found: false, name: name_of(&path), path, at: None, before: String::new(), passage: String::new(), after: String::new(), why: Some(why.to_string()) };
            if let Some(why) = quote::unusable(&a.quote) {
                return miss(&format!("The quote {why}."), path);
            }
            let doc = match read.iter().find(|(p, _)| *p == path) {
                Some((_, d)) => d.clone(),
                None => {
                    let d = sources::read_cited(space, visible, &path);
                    read.push((path.clone(), d.clone()));
                    d
                }
            };
            let Ok(doc) = doc else {
                return miss("That isn’t a file in your materials that this space can read.", path);
            };
            match quote::find(&doc.text, &a.quote) {
                None => miss("Those words aren’t in that file.", doc.label),
                Some(f) => {
                    let name = name_of(&doc.label);
                    let low = name.to_lowercase();
                    let problem_set = low.starts_with("hw") || low.contains("homework") || low.contains("review") || low.contains("problem set");
                    let (before, passage, after) = quote::context(&doc.text, f, AROUND);
                    Checked { found: true, at: quote::locate(&doc.text, f.start, problem_set), name, path: doc.label, before, passage, after, why: None }
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lms::access::{Part, fixture};
    use std::fs;

    #[test]
    fn found_missing_and_outside() {
        let root = std::env::temp_dir().join(format!("phaethon-cite-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let c = root.join("courses/C241/files");
        fs::create_dir_all(&c).unwrap();
        fs::create_dir_all(root.join("spaces/s")).unwrap();
        fs::write(c.join("Notes.pdf"), "%PDF").unwrap();
        fs::write(c.join("Notes.pdf.md"), "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is\ninjective if no two inputs give the same output.").unwrap();
        fs::write(root.join("courses/C241/grades.md"), "Grade: 91% on everything so far").unwrap();
        fs::write(root.join("spaces/s/notes.md"), "My own notes say sets have members.").unwrap();
        fs::write(root.join("secret.md"), "A function f is injective if no two inputs give the same output.").unwrap();
        let vis = fixture(&root, "s", &[("C241", &[Part::Files])]);
        let space = root.join("spaces/s");
        let ask = |path: &str, quote: &str| Asked { path: path.into(), quote: quote.into() };
        let got = check(
            &space,
            &vis,
            &[
                ask("courses/C241/files/Notes.pdf", "A function f is injective if no two inputs give the same output."),
                ask("courses/C241/files/Notes.pdf.md", "injective if no two inputs give the same output"),
                ask("courses/C241/files/Notes.pdf", "A function is surjective if every output is hit."),
                ask("courses/C241/grades.md", "Grade: 91% on everything so far"),
                ask("../../secret.md", "A function f is injective if no two inputs"),
                ask("/etc/hosts", "localhost is the local machine here"),
                ask("notes.md", "My own notes say sets have members."),
                ask("courses/C241/files/Notes.pdf", "f is"),
            ],
        );
        assert!(got[0].found && got[0].path == "courses/C241/files/Notes.pdf" && got[0].name == "Notes.pdf" && got[0].at.as_deref() == Some("§5.3"), "{:?}", got[0]);
        assert_eq!(got[0].passage, "A function f is injective if no two inputs give the same output.");
        assert!(got[1].found && got[1].path == "courses/C241/files/Notes.pdf", "a text copy is cited as its PDF");
        assert!(!got[2].found && got[2].why.as_deref() == Some("Those words aren’t in that file."));
        for g in &got[3..6] {
            assert!(!g.found && g.why.as_deref().unwrap().contains("isn’t a file"), "{g:?}: grades this space can't see, and anything outside, are the same");
            assert!(g.passage.is_empty());
        }
        assert!(got[6].found, "the space's own files count");
        assert!(got[7].why.as_deref().unwrap().contains("too short"));
        fs::remove_dir_all(root).unwrap();
    }
}
