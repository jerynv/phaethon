//! Flashcard decks as Markdown, readable and editable by hand:
//!
//! ```text
//! ---
//! title: Graph theory basics
//! course: CSCI-C 241 Fall 2026 (All Sections)
//! sources:
//!   - courses/CSCI-C 241 Fall 2026 (All Sections)/files/Notes/x.pdf
//! ---
//!
//! Q: What is a bipartite graph?
//! A: A graph whose vertices split into two sets with every edge between the sets.
//! From: courses/CSCI-C 241 Fall 2026 (All Sections)/files/Notes/x.pdf
//!
//! Q: The {{chromatic number}} of a bipartite graph with an edge is 2.
//! ```
//!
//! Parsing is tolerant: no front matter (the title comes from the file name),
//! Windows line endings, a byte-order mark, `q:`/`a:` in any case, indented
//! markers, cards without `A:` and text before the first card (kept as is).
//! Fronts and backs may run over several lines; a line inside one that would
//! read as a marker is written with a backslash (`\Q: ...`).
//!
//! Cloze: `{{...}}` in a front hides that text. A front with several blanks is
//! ONE card with every blank hidden at once (not one card per blank), so a
//! card is always one note in the file and editing it is unambiguous. Anki's
//! `{{c1::text::hint}}` is read as `text`. An optional `A:` on a cloze card is
//! an extra note shown with the answer.

use std::collections::HashMap;

/// Longest front and back accepted, in characters.
pub const FRONT_MAX: usize = 2_000;
pub const BACK_MAX: usize = 4_000;
pub const TITLE_MAX: usize = 120;
pub const CARDS_MAX: usize = 2_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Deck {
    pub title: String,
    pub course: Option<String>,
    pub sources: Vec<String>,
    /// Front matter lines this version doesn't know, kept verbatim.
    pub extra: Vec<String>,
    /// Text before the first card, kept verbatim.
    pub preamble: String,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Note {
    pub front: String,
    pub back: String,
    /// The file the card came from, relative to the space.
    pub source: Option<String>,
    /// The passage in that file it was made from, word for word (checked when it was made).
    pub quote: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Basic,
    Cloze,
}

impl Note {
    pub fn kind(&self) -> Kind {
        if self.front.contains("{{") { Kind::Cloze } else { Kind::Basic }
    }
}

/// The text hidden by each `{{...}}` in `front`, in order. Errors on an
/// unclosed or empty blank.
pub fn cloze_answers(front: &str) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut rest = front;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or("a {{ blank is never closed with }}")?;
        let inner = &after[..end];
        if inner.contains("{{") {
            return Err("a {{ blank is never closed with }}".into());
        }
        out.push(cloze_text(inner).to_string());
        if out.last().is_some_and(|s| s.trim().is_empty()) {
            return Err("a {{ }} blank is empty".into());
        }
        rest = &after[end + 2..];
    }
    if rest.contains("}}") {
        return Err("a }} has no {{ before it".into());
    }
    Ok(out)
}

/// `c1::text::hint` (Anki) -> `text`; anything else as is.
fn cloze_text(inner: &str) -> &str {
    let mut s = inner;
    if let Some((tag, rest)) = s.split_once("::")
        && tag.len() <= 4
        && tag.starts_with(['c', 'C'])
        && tag[1..].bytes().all(|b| b.is_ascii_digit())
    {
        s = rest;
    }
    s.split("::").next().unwrap_or(s).trim()
}

/// A stable id for a card: FNV-1a of the deck's path and the card's front
/// (whitespace-normalised). Editing the answer keeps the id, and so the progress.
pub fn card_id(deck_path: &str, front: &str) -> String {
    let norm = front.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in deck_path.bytes().chain([0u8]).chain(norm.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Ids for every note of a deck, in order. Two notes with the same front (a
/// hand edit can make that) get `-2`, `-3`... so ids stay unique.
pub fn card_ids(deck_path: &str, deck: &Deck) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    deck.notes
        .iter()
        .map(|n| {
            let id = card_id(deck_path, &n.front);
            let k = seen.entry(id.clone()).or_default();
            *k += 1;
            if *k == 1 { id } else { format!("{id}-{k}") }
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Part {
    Front,
    Back,
}

/// A marker (`Q:` / `A:` / `From:`) at the start of `line`, ignoring indent and
/// case; returns the text after it.
fn marker<'a>(line: &'a str, m: &str) -> Option<&'a str> {
    let t = line.trim_start();
    let head = t.get(..m.len())?;
    head.eq_ignore_ascii_case(m).then(|| t[m.len()..].strip_prefix(' ').unwrap_or(&t[m.len()..]))
}

const MARKERS: [&str; 4] = ["Q:", "A:", "From:", "Quote:"];

fn unescape(line: &str) -> String {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix('\\')
        && MARKERS.iter().any(|m| marker(rest, m).is_some())
    {
        let indent = &line[..line.len() - t.len()];
        return format!("{indent}{rest}");
    }
    line.to_string()
}

fn escape(line: &str) -> String {
    let t = line.trim_start();
    let escaped_already = t.strip_prefix('\\').is_some_and(|r| MARKERS.iter().any(|m| marker(r, m).is_some()));
    if MARKERS.iter().any(|m| marker(line, m).is_some()) || escaped_already {
        let indent = &line[..line.len() - t.len()];
        format!("{indent}\\{t}")
    } else {
        line.to_string()
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

/// `a, "b, c"` -> `a`, `"b, c"`: commas inside quotes don't split.
fn split_list(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote) = (vec![], String::new(), None);
    for c in s.chars() {
        match (c, quote) {
            ('"' | '\'', None) => {
                quote = Some(c);
                cur.push(c);
            }
            (q, Some(open)) if q == open => {
                quote = None;
                cur.push(c);
            }
            (',', None) => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

fn trim_lines(s: &str) -> String {
    s.trim_matches('\n').lines().map(str::trim_end).collect::<Vec<_>>().join("\n").trim_matches('\n').to_string()
}

/// Read a deck. Never fails: whatever isn't a card is kept as the preamble or
/// extra front matter. `fallback_title` (the file name) is used when the file
/// has no title.
pub fn parse(text: &str, fallback_title: &str) -> Deck {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n").replace('\r', "\n");
    let mut deck = Deck::default();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut body_start = 0;
    if lines.first().map(|l| l.trim_end()) == Some("---")
        && let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---")
    {
        let fm = &lines[1..end + 1];
        body_start = end + 2;
        let mut i = 0;
        while i < fm.len() {
            let line = fm[i];
            let (key, value) = line.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim())).unwrap_or_default();
            match key.as_str() {
                "title" if !line.starts_with(' ') => deck.title = unquote(value),
                "course" if !line.starts_with(' ') => {
                    let c = unquote(value);
                    deck.course = (!c.is_empty()).then_some(c);
                }
                "sources" if !line.starts_with(' ') => {
                    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                        deck.sources.extend(split_list(inner).iter().map(|s| unquote(s)).filter(|s| !s.is_empty()));
                    } else if !value.is_empty() {
                        deck.sources.push(unquote(value));
                    }
                    while let Some(item) = fm.get(i + 1).and_then(|l| l.trim_start().strip_prefix("- ")) {
                        let s = unquote(item);
                        if !s.is_empty() {
                            deck.sources.push(s);
                        }
                        i += 1;
                    }
                }
                _ if line.trim().is_empty() => {}
                _ => deck.extra.push(line.to_string()),
            }
            i += 1;
        }
    }
    if deck.title.trim().is_empty() {
        deck.title = fallback_title.to_string();
    }

    let mut preamble: Vec<&str> = vec![];
    let mut cur: Option<(Note, Part)> = None;
    let mut notes = vec![];
    for &line in &lines[body_start.min(lines.len())..] {
        if let Some(rest) = marker(line, "Q:") {
            if let Some((n, _)) = cur.take() {
                notes.push(n);
            }
            cur = Some((Note { front: rest.to_string(), ..Default::default() }, Part::Front));
            continue;
        }
        match &mut cur {
            None => preamble.push(line),
            Some((n, part)) => {
                if *part == Part::Front
                    && let Some(rest) = marker(line, "A:")
                {
                    n.back = rest.to_string();
                    *part = Part::Back;
                    continue;
                }
                let target = if *part == Part::Front { &mut n.front } else { &mut n.back };
                target.push('\n');
                target.push_str(line);
            }
        }
    }
    if let Some((n, _)) = cur {
        notes.push(n);
    }
    deck.preamble = trim_lines(&preamble.join("\n"));
    deck.notes = notes.into_iter().map(finish_note).collect();
    deck
}

/// Trim a parsed note, take a `From:` last line as its source (and a
/// `Quote:` line after it as the passage), unescape lines.
fn finish_note(mut n: Note) -> Note {
    let has_back = !n.back.trim().is_empty();
    let take = |s: &mut String, m: &str| -> Option<String> {
        let t = trim_lines(s);
        let (head, last) = t.rsplit_once('\n').unwrap_or(("", t.as_str()));
        let got = marker(last, m).map(|r| r.trim().to_string()).filter(|r| !r.is_empty())?;
        *s = head.to_string();
        Some(got)
    };
    let text = if has_back { &mut n.back } else { &mut n.front };
    let before = text.clone();
    let quote = take(text, "Quote:");
    n.source = take(text, "From:");
    // A passage belongs to its source: without one, the line stays part of the card.
    match (&n.source, quote) {
        (Some(_), q) => n.quote = q.map(|q| unquote(&q)).filter(|q| !q.is_empty()),
        (None, Some(_)) => *text = before,
        (None, None) => {}
    }
    // The first line follows its marker, so only the lines after it can be escaped.
    let clean = |s: &str| {
        let lines: Vec<String> = s.lines().enumerate().map(|(i, l)| if i == 0 { l.to_string() } else { unescape(l) }).collect();
        trim_lines(&lines.join("\n"))
    };
    n.front = clean(&n.front);
    n.back = clean(&n.back);
    n
}

fn needs_quotes(s: &str) -> bool {
    s != s.trim() || s.starts_with(['"', '\'', '[', '-']) || s.contains(": ") || s.contains(" #")
}

fn fm_value(s: &str) -> String {
    if needs_quotes(s) && !s.contains('"') { format!("\"{s}\"") } else { s.to_string() }
}

/// Write a deck in the canonical form [`parse`] reads back exactly.
pub fn write(deck: &Deck) -> String {
    let mut s = String::from("---\n");
    s.push_str(&format!("title: {}\n", fm_value(deck.title.trim())));
    if let Some(c) = deck.course.as_deref().filter(|c| !c.trim().is_empty()) {
        s.push_str(&format!("course: {}\n", fm_value(c.trim())));
    }
    if !deck.sources.is_empty() {
        s.push_str("sources:\n");
        for src in &deck.sources {
            s.push_str(&format!("  - {}\n", fm_value(src)));
        }
    }
    for l in &deck.extra {
        s.push_str(l);
        s.push('\n');
    }
    s.push_str("---\n");
    if !deck.preamble.trim().is_empty() {
        s.push('\n');
        s.push_str(deck.preamble.trim_matches('\n'));
        s.push('\n');
    }
    for n in &deck.notes {
        s.push('\n');
        let block = |t: &str| t.lines().enumerate().map(|(i, l)| if i == 0 { l.to_string() } else { escape(l) }).collect::<Vec<_>>().join("\n");
        s.push_str(&format!("Q: {}\n", block(n.front.trim())));
        if !n.back.trim().is_empty() {
            s.push_str(&format!("A: {}\n", block(n.back.trim())));
        }
        if let Some(src) = n.source.as_deref().filter(|s| !s.trim().is_empty()) {
            s.push_str(&format!("From: {}\n", src.trim()));
            if let Some(q) = n.quote.as_deref().map(|q| q.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|q| !q.is_empty()) {
                s.push_str(&format!("Quote: \"{q}\"\n"));
            }
        }
    }
    s
}

/// Problems that would make a deck unusable, in plain words. The first one only.
pub fn validate(deck: &Deck) -> Result<(), String> {
    let title = deck.title.trim();
    if title.is_empty() {
        return Err("The deck needs a title.".into());
    }
    if title.chars().count() > TITLE_MAX || title.contains('\n') {
        return Err(format!("The title is too long: keep it under {TITLE_MAX} characters, on one line."));
    }
    if deck.notes.is_empty() {
        return Err("The deck has no cards yet.".into());
    }
    if deck.notes.len() > CARDS_MAX {
        return Err(format!("A deck can hold up to {CARDS_MAX} cards; split this one in two."));
    }
    let mut fronts = HashMap::new();
    for (i, n) in deck.notes.iter().enumerate() {
        let num = i + 1;
        let front = n.front.trim();
        if front.is_empty() {
            return Err(format!("Card {num} has no question."));
        }
        if front.chars().count() > FRONT_MAX {
            return Err(format!("Card {num}’s question is too long (over {FRONT_MAX} characters)."));
        }
        if n.back.chars().count() > BACK_MAX {
            return Err(format!("Card {num}’s answer is too long (over {BACK_MAX} characters)."));
        }
        match n.kind() {
            Kind::Basic if front.contains("}}") => return Err(format!("Card {num}: a }} has no {{{{ before it.")),
            Kind::Basic if n.back.trim().is_empty() => return Err(format!("Card {num} has no answer.")),
            Kind::Cloze => cloze_answers(front).map_err(|e| format!("Card {num}: {e}."))?.len(),
            Kind::Basic => 0,
        };
        let key = front.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if let Some(first) = fronts.insert(key, num) {
            return Err(format!("Cards {first} and {num} ask the same thing; change one or remove it."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "---
title: Test 1 review
course: CSCI-C 241 Fall 2026 (All Sections)
sources:
  - courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf
---

Q: When is p → q false?
A: Only when p is true and q is false.
From: courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf

Q: “A is a necessary condition for B” in propositional logic
A: B → A
(the condition comes after the arrow)

Q: The {{power set}} of a set with n members has {{2^n}} members.

Q: What does |X ∩ Y| mean?
A: The number of members X and Y have in common.
";

    #[test]
    fn a_real_looking_deck_round_trips_exactly() {
        let d = parse(REAL, "x");
        assert_eq!(d.title, "Test 1 review");
        assert_eq!(d.course.as_deref(), Some("CSCI-C 241 Fall 2026 (All Sections)"));
        assert_eq!(d.sources.len(), 1);
        assert_eq!(d.notes.len(), 4);
        assert_eq!(d.notes[0].source.as_deref(), Some("courses/CSCI-C 241 Fall 2026 (All Sections)/files/HW/Test 1 Review - C241 Fa26.pdf"));
        assert_eq!(d.notes[1].back, "B → A\n(the condition comes after the arrow)");
        assert_eq!(d.notes[2].kind(), Kind::Cloze);
        assert_eq!(cloze_answers(&d.notes[2].front).unwrap(), ["power set", "2^n"]);
        assert_eq!(d.notes[2].back, "");
        assert_eq!(write(&d), REAL);
        assert_eq!(parse(&write(&d), "x"), d);
    }

    #[test]
    fn hand_edits_are_tolerated() {
        // No front matter, CRLF, BOM, lower-case and indented markers, a heading
        // before the cards, a card without A:, blank lines inside an answer.
        let text = "\u{feff}# My notes\r\nsome intro\r\n\r\nq: one\r\na: uno\r\n\r\n   Q:two\r\n  A: dos\r\n\r\nmore dos\r\n\r\nQ: three has no answer\r\n";
        let d = parse(text, "Spanish");
        assert_eq!(d.title, "Spanish");
        assert_eq!(d.preamble, "# My notes\nsome intro");
        assert_eq!(d.notes.len(), 3);
        assert_eq!((d.notes[0].front.as_str(), d.notes[0].back.as_str()), ("one", "uno"));
        assert_eq!((d.notes[1].front.as_str(), d.notes[1].back.as_str()), ("two", "dos\n\nmore dos"));
        assert_eq!(d.notes[2].back, "");
        assert!(validate(&d).unwrap_err().contains("Card 3 has no answer"));
        // Written back, the preamble and cards survive.
        let again = parse(&write(&d), "Spanish");
        assert_eq!(again.notes, d.notes);
        assert_eq!(again.preamble, d.preamble);
    }

    #[test]
    fn front_matter_variants_and_unknown_keys() {
        let text = "---\ntitle: \"Graph theory: basics\"\nsources: [a.md, \"b, c.pdf\"]\ntags: graphs\n---\nQ: x\nA: y\n";
        let d = parse(text, "f");
        assert_eq!(d.title, "Graph theory: basics");
        assert_eq!(d.sources, ["a.md", "b, c.pdf"]);
        assert_eq!(d.extra, ["tags: graphs"]);
        let w = write(&d);
        assert!(w.contains("title: \"Graph theory: basics\"\n") && w.contains("tags: graphs\n"), "{w}");
        assert_eq!(parse(&w, "f").title, "Graph theory: basics");
        // An unclosed front matter is just text.
        let d = parse("---\ntitle: x\nQ: a\nA: b\n", "f");
        assert_eq!(d.title, "f");
        assert_eq!(d.notes.len(), 1);
    }

    #[test]
    fn marker_lines_inside_text_are_escaped() {
        let d = Deck {
            title: "t".into(),
            notes: vec![Note { front: "Line one\nQ: not a new card".into(), back: "A: still the answer\nFrom: not a source".into(), source: Some("x.md".into()), quote: None }],
            ..Default::default()
        };
        let w = write(&d);
        assert!(w.contains("\\Q: not a new card") && w.contains("\\From: not a source"), "{w}");
        assert_eq!(parse(&w, "t"), d);
    }

    #[test]
    fn a_cards_passage_is_kept_after_its_source() {
        let n = Note { front: "What is an injective function?".into(), back: "No two inputs share an output.".into(), source: Some("courses/C/notes.pdf".into()), quote: Some("A function f is  injective if\nno two inputs give the same output.".into()) };
        let d = Deck { title: "t".into(), notes: vec![n.clone(), Note { front: "{{x}} y".into(), source: Some("s.md".into()), quote: Some("a quoted bit of text".into()), ..Default::default() }], ..Default::default() };
        let w = write(&d);
        assert!(w.contains("From: courses/C/notes.pdf\nQuote: \"A function f is injective if no two inputs give the same output.\"\n"), "{w}");
        let back = parse(&w, "t");
        assert_eq!(back.notes[0].quote.as_deref(), Some("A function f is injective if no two inputs give the same output."));
        assert_eq!((back.notes[1].source.as_deref(), back.notes[1].quote.as_deref(), back.notes[1].front.as_str()), (Some("s.md"), Some("a quoted bit of text"), "{{x}} y"));
        // A Quote: line with no source is part of the card, as written.
        let d = parse("Q: a\nA: b\nQuote: c\n", "t");
        assert_eq!((d.notes[0].back.as_str(), d.notes[0].quote.as_deref()), ("b\nQuote: c", None));
    }

    #[test]
    fn ids_are_stable_and_follow_the_front_only() {
        let a = card_id("study/decks/A.md", "What is  a set?");
        assert_eq!(a, card_id("study/decks/A.md", "What is a set?\n"));
        assert_ne!(a, card_id("study/decks/B.md", "What is a set?"));
        assert_ne!(a, card_id("study/decks/A.md", "What is a graph?"));
        assert_eq!(a.len(), 16);
        let d = parse("Q: same\nA: 1\n\nQ: same\nA: 2\n", "t");
        let ids = card_ids("p", &d);
        assert_eq!(ids[1], format!("{}-2", ids[0]));
        assert!(validate(&d).unwrap_err().contains("ask the same thing"));
    }

    #[test]
    fn cloze_checks() {
        assert_eq!(cloze_answers("The {{c1::chromatic number::a count}} is 2").unwrap(), ["chromatic number"]);
        assert!(cloze_answers("open {{ never closed").is_err());
        assert!(cloze_answers("empty {{ }} blank").is_err());
        assert!(cloze_answers("stray }} close").is_err());
        let d = Deck { title: "t".into(), notes: vec![Note { front: "a {{b".into(), ..Default::default() }], ..Default::default() };
        assert!(validate(&d).unwrap_err().contains("never closed"));
        let d = Deck { title: "t".into(), notes: vec![Note { front: "2 + 2 = {{4}}".into(), ..Default::default() }], ..Default::default() };
        assert!(validate(&d).is_ok());
    }
}
