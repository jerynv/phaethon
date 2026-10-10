//! Search the text of saved conversations: the user's own view of their
//! files, read-only. Nothing found here is ever sent to the model.
//!
//! Only what the conversation shows is searched (your messages and the
//! replies, as [`thread::to_ui`] gives them): never thinking, tool calls or
//! tool results. Matching ignores case and accents ("resume" finds "Résumé"),
//! and any run of whitespace matches any other.

use std::path::PathBuf;

use serde::Serialize;

use crate::thread;

/// Conversations returned at most, newest first.
pub const MAX_CONVERSATIONS: usize = 50;
/// Snippets shown per conversation; the rest are only counted.
pub const MAX_SNIPPETS: usize = 3;
/// A longer query is cut to this many characters.
pub const MAX_QUERY_CHARS: usize = 200;
/// Characters of context kept before and after a match.
const BEFORE: usize = 48;
const AFTER: usize = 96;

pub const CLI: &str = "Claude Code keeps its own history, which Phaethon can’t search. Only conversations with Phaethon’s own agent can be searched.";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub conversations: Vec<Conversation>,
    /// More conversations matched than were returned.
    pub truncated: bool,
}

/// One conversation with at least one match.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub space: String,
    /// `"current"` or the archive id, as `threads_list` gives it.
    pub thread_id: String,
    pub title: String,
    pub updated: u64,
    pub current: bool,
    /// Every match in the conversation, including those without a snippet.
    pub matches: usize,
    pub snippets: Vec<Snippet>,
}

/// A match in its context. The UI marks `matched`; nothing here is HTML.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// Position of the message in the conversation as the UI shows it.
    pub message: usize,
    pub role: &'static str,
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// Text folded for matching, with where each folded character came from.
struct Folded {
    chars: Vec<char>,
    /// Byte range in the original text, per folded character.
    spans: Vec<(usize, usize)>,
}

/// Lower-case letters with an accent, by the letter they are read as. Latin
/// scripts only; other characters are matched as they are (after lower-casing).
const ACCENTED: &[(&str, &str)] = &[
    ("àáâãäåāăąǎ", "a"),
    ("çćĉċč", "c"),
    ("ďđ", "d"),
    ("èéêëēĕėęě", "e"),
    ("ĝğġģ", "g"),
    ("ĥħ", "h"),
    ("ìíîïĩīĭįı", "i"),
    ("ĵ", "j"),
    ("ķ", "k"),
    ("ĺļľŀł", "l"),
    ("ñńņňŉ", "n"),
    ("òóôõöøōŏőǒ", "o"),
    ("ŕŗř", "r"),
    ("śŝşšș", "s"),
    ("ţťŧț", "t"),
    ("ùúûüũūŭůűųǔ", "u"),
    ("ŵ", "w"),
    ("ýÿŷ", "y"),
    ("źżž", "z"),
    ("æ", "ae"),
    ("œ", "oe"),
    ("ß", "ss"),
];

fn base_of(c: char) -> Option<&'static str> {
    if c.is_ascii() {
        return None;
    }
    ACCENTED.iter().find(|(set, _)| set.contains(c)).map(|(_, base)| *base)
}

/// Combining marks (a decomposed accent, U+0300 to U+036F) belong to the letter before them.
fn is_combining(c: char) -> bool {
    ('\u{300}'..='\u{36f}').contains(&c)
}

fn fold(text: &str) -> Folded {
    let mut out = Folded { chars: vec![], spans: vec![] };
    let mut gap = true;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        if c.is_whitespace() {
            if !gap {
                out.chars.push(' ');
                out.spans.push((i, end));
                gap = true;
            }
            continue;
        }
        if is_combining(c) {
            if let Some(last) = out.spans.last_mut() {
                last.1 = end;
            }
            continue;
        }
        gap = false;
        for l in c.to_lowercase() {
            match base_of(l) {
                Some(base) => base.chars().for_each(|b| {
                    out.chars.push(b);
                    out.spans.push((i, end));
                }),
                None => {
                    out.chars.push(l);
                    out.spans.push((i, end));
                }
            }
        }
    }
    if out.chars.last() == Some(&' ') {
        out.chars.pop();
        out.spans.pop();
    }
    out
}

/// The query as it is matched: folded, at most [`MAX_QUERY_CHARS`]. Empty
/// when there is nothing to look for.
pub fn fold_query(query: &str) -> Vec<char> {
    let cut: String = query.chars().take(MAX_QUERY_CHARS).collect();
    fold(&cut).chars
}

/// Every match of `needle` in `hay`, as folded-character ranges, not overlapping.
fn find_all(hay: &[char], needle: &[char]) -> Vec<(usize, usize)> {
    let mut out = vec![];
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push((i, i + needle.len()));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Whitespace runs as single spaces.
fn squash(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars() {
        if c.is_whitespace() {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    if gap && !out.is_empty() {
        out.push(' ');
    }
    out
}

fn snippet(text: &str, (start, end): (usize, usize), message: usize, role: &'static str) -> Snippet {
    let head = &text[..start];
    let tail = &text[end..];
    let head_chars = head.chars().count();
    let before = if head_chars > BEFORE {
        format!("…{}", head.chars().skip(head_chars - BEFORE).collect::<String>().trim_start())
    } else {
        head.to_string()
    };
    let after = if tail.chars().count() > AFTER {
        format!("{}…", tail.chars().take(AFTER).collect::<String>().trim_end())
    } else {
        tail.to_string()
    };
    Snippet {
        message,
        role,
        before: squash(&before).trim_start().to_string(),
        matched: squash(&text[start..end]),
        after: squash(&after).trim_end().to_string(),
    }
}

/// The matches in one conversation's messages (as `to_ui` gives them), or
/// `None` when there are none.
fn search_messages(msgs: &[thread::UiMessage], needle: &[char]) -> Option<(usize, Vec<Snippet>)> {
    let mut count = 0;
    let mut snippets = vec![];
    for (pos, m) in msgs.iter().enumerate() {
        let f = fold(&m.text);
        for (a, b) in find_all(&f.chars, needle) {
            count += 1;
            if snippets.len() < MAX_SNIPPETS {
                snippets.push(snippet(&m.text, (f.spans[a].0, f.spans[b - 1].1), pos, m.role));
            }
        }
    }
    (count > 0).then_some((count, snippets))
}

/// Search every conversation in each of `spaces` (id and folder) for `query`.
/// Conversations that can't be read are skipped. Newest first, at most
/// [`MAX_CONVERSATIONS`].
pub fn search(spaces: &[(String, PathBuf)], query: &str) -> Results {
    let needle = fold_query(query);
    let mut found = vec![];
    if needle.is_empty() {
        return Results { conversations: found, truncated: false };
    }
    for (space, dir) in spaces {
        let Ok(list) = thread::list(dir) else { continue };
        for t in list {
            let Ok(msgs) = thread::load_conversation(dir, &t.id) else { continue };
            if let Some((matches, snippets)) = search_messages(&thread::to_ui(&msgs), &needle) {
                found.push(Conversation {
                    space: space.clone(),
                    thread_id: t.id,
                    title: t.title,
                    updated: t.updated,
                    current: t.current,
                    matches,
                    snippets,
                });
            }
        }
    }
    found.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.space.cmp(&b.space)).then_with(|| b.thread_id.cmp(&a.thread_id)));
    let truncated = found.len() > MAX_CONVERSATIONS;
    found.truncate(MAX_CONVERSATIONS);
    Results { conversations: found, truncated }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::{Value, json};

    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chat(pairs: &[(&str, &str)]) -> Vec<Value> {
        pairs
            .iter()
            .flat_map(|(q, a)| [thread::user_text(q), json!({"role": "assistant", "content": [{"type": "text", "text": a}]})])
            .collect()
    }

    fn save_archived(space: &Path, msgs: &[Value]) {
        thread::save(space, msgs).unwrap();
        thread::start_new(space).unwrap();
        // Archive ids are milliseconds: keep them apart.
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    #[test]
    fn folding_ignores_case_accents_and_spacing() {
        let q = fold_query("resume CAFE");
        let hay = fold("My Résumé  \n café list");
        assert!(find_all(&hay.chars, &fold_query("résumé")).len() == 1);
        assert!(find_all(&hay.chars, &fold_query("RESUME")).len() == 1);
        assert!(find_all(&fold("Résumé café").chars, &q).len() == 1);
        // A decomposed accent (e + U+0301) folds the same as the composed letter.
        assert_eq!(find_all(&fold("cafe\u{301}").chars, &fold_query("café")).len(), 1);
        assert_eq!(fold("Straße").chars.iter().collect::<String>(), "strasse");
        // Non-Latin text still matches itself, case-folded.
        assert_eq!(find_all(&fold("Ελληνικά ΚΕΙΜΕΝΟ").chars, &fold_query("κειμενο")).len(), 1);
        assert!(fold_query("   ").is_empty());
        assert_eq!(fold_query(&"x".repeat(500)).len(), MAX_QUERY_CHARS);
    }

    #[test]
    fn snippets_point_at_the_original_text() {
        let text = "Before the test, re-read the Résumé notes.\n\nThen rest.";
        let f = fold(text);
        let hits = find_all(&f.chars, &fold_query("resume notes"));
        assert_eq!(hits.len(), 1);
        let (a, b) = hits[0];
        let s = snippet(text, (f.spans[a].0, f.spans[b - 1].1), 4, "assistant");
        assert_eq!(s.matched, "Résumé notes");
        assert_eq!(s.before, "Before the test, re-read the ");
        assert_eq!(s.after, ". Then rest.");
        assert_eq!((s.message, s.role), (4, "assistant"));
        // Long context is cut with an ellipsis on each side.
        let long = format!("{} needle {}", "a ".repeat(100), "b ".repeat(100));
        let f = fold(&long);
        let (a, b) = find_all(&f.chars, &fold_query("needle"))[0];
        let s = snippet(&long, (f.spans[a].0, f.spans[b - 1].1), 0, "user");
        assert!(s.before.starts_with('…') && s.after.ends_with('…'), "{s:?}");
        assert!(s.before.chars().count() <= BEFORE + 1 && s.after.chars().count() <= AFTER + 1);
    }

    #[test]
    fn finds_in_current_and_past_conversations_newest_first() {
        let school = temp("school");
        save_archived(&school, &chat(&[("When is the midterm?", "The Midterm is on Thursday.")]));
        save_archived(&school, &chat(&[("Plan my week", "Nothing about exams here.")]));
        thread::save(&school, &chat(&[("Remind me about the midterm", "Okay.")])).unwrap();

        let r = search(&[("school".into(), school.clone())], "MIDTERM");
        assert!(!r.truncated);
        assert_eq!(r.conversations.len(), 2);
        // The current conversation was written last, so it comes first.
        let c = &r.conversations[0];
        assert!(c.current && c.thread_id == "current" && c.space == "school" && c.matches == 1);
        assert_eq!(c.snippets[0].message, 0);
        let old = &r.conversations[1];
        assert!(!old.current && thread::is_valid_id(&old.thread_id));
        assert_eq!(old.title, "When is the midterm?");
        assert_eq!(old.matches, 2);
        assert_eq!(old.snippets.iter().map(|s| (s.message, s.role)).collect::<Vec<_>>(), vec![(0, "user"), (1, "assistant")]);
        assert!(old.updated <= c.updated);

        assert!(search(&[("school".into(), school.clone())], "nowhere to be found").conversations.is_empty());
        assert!(search(&[("school".into(), school.clone())], "  ").conversations.is_empty());
        fs::remove_dir_all(&school).unwrap();
    }

    #[test]
    fn scope_is_only_the_spaces_given() {
        let school = temp("scope-school");
        let work = temp("scope-work");
        thread::save(&school, &chat(&[("budget for books", "ok")])).unwrap();
        thread::save(&work, &chat(&[("quarterly budget", "ok")])).unwrap();
        let one = search(&[("school".into(), school.clone())], "budget");
        assert_eq!(one.conversations.iter().map(|c| c.space.as_str()).collect::<Vec<_>>(), ["school"]);
        let both = search(&[("school".into(), school.clone()), ("work".into(), work.clone())], "budget");
        let mut spaces: Vec<&str> = both.conversations.iter().map(|c| c.space.as_str()).collect();
        spaces.sort();
        assert_eq!(spaces, ["school", "work"]);
        fs::remove_dir_all(&school).unwrap();
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn caps_snippets_and_conversations_and_skips_unreadable_files() {
        let dir = temp("caps");
        let many: Vec<(&str, &str)> = (0..5).map(|_| ("cap cap", "cap")).collect();
        thread::save(&dir, &chat(&many)).unwrap();
        let r = search(&[("s".into(), dir.clone())], "cap");
        assert_eq!(r.conversations[0].matches, 15);
        assert_eq!(r.conversations[0].snippets.len(), MAX_SNIPPETS);

        // A damaged file is listed by thread::list but skipped here, never an error.
        fs::write(dir.join(crate::tools::STATE_DIR).join("thread.json"), "{ half").unwrap();
        assert!(search(&[("s".into(), dir.clone())], "cap").conversations.is_empty());

        // More matching conversations than the cap: the newest are kept.
        let archive = dir.join(crate::tools::STATE_DIR).join("threads");
        fs::create_dir_all(&archive).unwrap();
        let body = serde_json::to_vec(&chat(&[("cap", "x")])).unwrap();
        for n in 0..MAX_CONVERSATIONS + 5 {
            fs::write(archive.join(format!("{}.json", 1_700_000_000_000u64 + n as u64)), &body).unwrap();
        }
        let r = search(&[("s".into(), dir.clone())], "cap");
        assert!(r.truncated);
        assert_eq!(r.conversations.len(), MAX_CONVERSATIONS);
        assert!(r.conversations.windows(2).all(|w| w[0].updated >= w[1].updated));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_shown_text_is_searched() {
        let dir = temp("shown");
        let msgs = vec![
            thread::user_text("what's in notes?"),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "secretword in thinking", "signature": "s"},
                {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "secretword.md"}}
            ]}),
            json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "secretword in a file"}]}),
            json!({"role": "assistant", "content": [{"type": "text", "text": "Nothing much."}]}),
        ];
        thread::save(&dir, &msgs).unwrap();
        assert!(search(&[("s".into(), dir.clone())], "secretword").conversations.is_empty());
        assert_eq!(search(&[("s".into(), dir.clone())], "nothing much").conversations.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
