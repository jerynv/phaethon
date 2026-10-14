//! Finding a quoted passage in a course file, mechanically. Every citation a
//! model gives (a scope map's evidence, a question's sources, a chat reply's
//! `[source: … "…"]`) is checked here against the file's text before it is
//! believed: the quote must be in the file, character for character, except
//! for whitespace (PDF text copies break lines after every symbol), typographic
//! quotes and dashes, ligatures, and a word hyphenated across a line break.
//! A quote may skip text with an ellipsis; each piece must then be found, in
//! order, close together.

/// Shortest quote believed: anything shorter is found almost anywhere.
pub const MIN_CHARS: usize = 12;
const MIN_WORDS: usize = 3;
/// Longest quote read.
pub const MAX_CHARS: usize = 1_200;
/// Pieces of a quote cut with "…" must be this close together.
const GAP_MAX: usize = 2_000;

/// One character as compared: typographic variants made plain.
fn fold(c: char, out: &mut String) {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' | '\u{2032}' | '`' | '\u{00b4}' => out.push('\''),
        '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' | '\u{2033}' => out.push('"'),
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}' => out.push('-'),
        '\u{fb00}' => out.push_str("ff"),
        '\u{fb01}' => out.push_str("fi"),
        '\u{fb02}' => out.push_str("fl"),
        '\u{fb03}' => out.push_str("ffi"),
        '\u{fb04}' => out.push_str("ffl"),
        // Soft hyphen, zero-width characters and Markdown's emphasis marks (`**not**`) vanish.
        '\u{00ad}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' | '*' => {}
        c => out.push(c),
    }
}

/// `text` without whitespace, with each kept character's byte offset in
/// `text` (so a match can be shown in place). A hyphen at a line's end joins
/// the word ("func-\ntions" reads "functions").
pub struct Compact {
    pub chars: Vec<char>,
    pub at: Vec<usize>,
}

pub fn compact(text: &str) -> Compact {
    let mut chars = vec![];
    let mut at = vec![];
    let mut buf = String::new();
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c.is_whitespace() {
            continue;
        }
        // "func- tions" / "func-\ntions": a hyphen followed by whitespace then a lowercase letter.
        if matches!(c, '-' | '\u{00ad}' | '\u{2010}') {
            let mut look = it.clone();
            let mut saw_space = false;
            while let Some(&(_, n)) = look.peek() {
                if n.is_whitespace() {
                    saw_space = true;
                    look.next();
                } else {
                    break;
                }
            }
            if saw_space && look.peek().is_some_and(|(_, n)| n.is_lowercase()) {
                continue;
            }
        }
        buf.clear();
        fold(c, &mut buf);
        for f in buf.chars() {
            chars.push(f);
            at.push(i);
        }
    }
    Compact { chars, at }
}

/// Where `needle` starts in `hay` at or after `from`.
fn find_from(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let first = needle[0];
    (from..=hay.len() - needle.len()).find(|&i| hay[i] == first && hay[i..i + needle.len()] == *needle)
}

/// Why a quote can't be checked at all (too short, too long), if it can't.
pub fn unusable(quote: &str) -> Option<&'static str> {
    let q = strip_marks(quote);
    let kept: usize = q.chars().filter(|c| !c.is_whitespace() && !matches!(c, '.' | '…')).count();
    let words = q.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count();
    if q.chars().count() > MAX_CHARS {
        return Some("is too long to be a quote");
    }
    if kept < MIN_CHARS || words < MIN_WORDS {
        return Some("is too short to check");
    }
    None
}

/// The quote without the quotation marks a model may wrap it in.
pub fn strip_marks(quote: &str) -> &str {
    let t = quote.trim();
    for (open, close) in [('"', '"'), ('\u{201c}', '\u{201d}'), ('\'', '\''), ('\u{2018}', '\u{2019}')] {
        if let Some(inner) = t.strip_prefix(open).and_then(|r| r.strip_suffix(close)) {
            return inner.trim();
        }
    }
    t
}

/// A found quote as it is kept and shown: no wrapping marks, no Markdown
/// emphasis, whitespace squeezed (it still matches its file).
pub fn tidy(quote: &str) -> String {
    strip_marks(quote).replace("**", "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pieces of a quote cut with an ellipsis ("...", "…", "[…]", ". . .").
fn pieces(quote: &str) -> Vec<String> {
    let mut q = strip_marks(quote).to_string();
    for e in ["[…]", "[...]", "(…)", "(...)", ". . .", "…"] {
        q = q.replace(e, "\u{0}");
    }
    // "..." but not a decimal or a path: three dots in a row.
    q = q.replace("...", "\u{0}");
    q.split('\u{0}').map(str::trim).filter(|p| p.chars().filter(|c| !c.is_whitespace()).count() >= 4).map(String::from).collect()
}

/// A match: byte range in the original text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub start: usize,
    pub end: usize,
}

/// Find `quote` in an already compacted text (see [`compact`]); `text` is
/// the original, for the byte range. `None` when it isn't there (or can't be
/// checked: see [`unusable`]).
pub fn find_in(text: &str, hay: &Compact, quote: &str) -> Option<Found> {
    if unusable(quote).is_some() {
        return None;
    }
    let parts = pieces(quote);
    if parts.is_empty() {
        return None;
    }
    // Try each place the first piece occurs: the rest must follow it closely.
    let first = compact(&parts[0]).chars;
    let mut from = 0;
    while let Some(start) = find_from(&hay.chars, &first, from) {
        let mut end = start + first.len();
        let mut ok = true;
        for p in &parts[1..] {
            let needle = compact(p).chars;
            match find_from(&hay.chars, &needle, end) {
                Some(i) if i - end <= GAP_MAX => end = i + needle.len(),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            let last = end - 1;
            let end_byte = hay.at[last] + text[hay.at[last]..].chars().next().map_or(1, char::len_utf8);
            return Some(Found { start: hay.at[start], end: end_byte });
        }
        from = start + 1;
    }
    None
}

/// [`find_in`] for a text not yet compacted.
pub fn find(text: &str, quote: &str) -> Option<Found> {
    find_in(text, &compact(text), quote)
}

/// The passage around a match: up to `around` characters each side, cut at
/// word boundaries, whitespace squeezed. (before, the match, after).
pub fn context(text: &str, f: Found, around: usize) -> (String, String, String) {
    let squeeze = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let before_full = &text[..f.start];
    let after_full = &text[f.end..];
    let mut before: String = before_full.chars().rev().take(around).collect::<Vec<_>>().into_iter().rev().collect();
    if before.len() < before_full.len()
        && let Some(sp) = before.find(char::is_whitespace)
    {
        before = format!("…{}", &before[sp..]);
    }
    let mut after: String = after_full.chars().take(around).collect();
    if after.len() < after_full.len()
        && let Some(sp) = after.rfind(char::is_whitespace)
    {
        after = format!("{}…", &after[..sp]);
    }
    let lead = if before.ends_with(char::is_whitespace) { " " } else { "" };
    let trail = if after.starts_with(char::is_whitespace) { " " } else { "" };
    (format!("{}{lead}", squeeze(&before)).trim_start().to_string(), squeeze(&text[f.start..f.end]), format!("{trail}{}", squeeze(&after)).trim_end().to_string())
}

/// Where in its file a passage is, in a few words: the nearest numbered
/// section before it ("§5.3") or, on a problem set, the problem ("#3").
pub fn locate(text: &str, at: usize, problem_set: bool) -> Option<String> {
    let head = &text[..at.min(text.len())];
    // The last 12,000 bytes, started on a character.
    let mut from = head.len().saturating_sub(12_000);
    while !head.is_char_boundary(from) {
        from += 1;
    }
    let window = &head[from..];
    if problem_set {
        // "3." on its own line, or at a line's start followed by text.
        let mut last = None;
        for line in window.lines() {
            let t = line.trim();
            let num: String = t.chars().take_while(char::is_ascii_digit).collect();
            if !num.is_empty() && num.len() <= 2 && t[num.len()..].starts_with('.') && t[num.len() + 1..].chars().next().is_none_or(char::is_whitespace) {
                last = Some(num);
            }
        }
        return last.map(|n| format!("#{n}"));
    }
    // "5.3 Properties of Functions": digits.digits(.digits) then a capitalised word.
    let bytes = window.as_bytes();
    let mut best: Option<String> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'.')) {
            let mut j = i;
            let mut dots = 0;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || (bytes[j] == b'.' && j + 1 < bytes.len() && bytes[j + 1].is_ascii_digit())) {
                if bytes[j] == b'.' {
                    dots += 1;
                }
                j += 1;
            }
            let rest = &window[j..];
            let next_word = rest.trim_start_matches(' ');
            let spaced = rest.len() > next_word.len() && rest.len() - next_word.len() <= 2;
            if (1..=3).contains(&dots) && j - i <= 8 && spaced && next_word.chars().next().is_some_and(char::is_uppercase) {
                let words: Vec<&str> = next_word.split_whitespace().take(2).collect();
                // A section title, not a page number in a contents line ("…  116 5.3 Properties").
                if words.first().is_some_and(|w| w.chars().count() >= 3 && w.chars().all(|c| c.is_alphabetic() || c == '-')) {
                    best = Some(format!("§{}", &window[i..j]));
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const PDF: &str = "## Page 1\n\nc\n1\n:\nR\n→\nR\n defined by\nc\n1\n(\nx\n)\n=\nx\n3\n−\n10\n.  Is\nc\n1\n injective?\n\n5.3 Properties of Functions\n\nA function f is injective (or \u{201c}one-to-one\u{201d}) if no two inputs give the same out- put.";

    #[test]
    fn exact_and_whitespace_insensitive() {
        assert!(find(PDF, "A function f is injective").is_some());
        // Every symbol on its own line in the file, written on one line in the quote.
        let f = find(PDF, "c 1 : R → R defined by c 1 ( x ) = x 3 − 10").unwrap();
        assert!(PDF[f.start..f.end].starts_with('c') && PDF[f.start..f.end].ends_with("10"));
        // Typographic quotes and dashes, and a word broken across a line.
        assert!(find(PDF, "injective (or \"one-to-one\") if no two inputs give the same output.").is_some());
        assert!(find(PDF, "c1 : R -> R").is_none(), "an arrow written differently is not the same text");
    }

    #[test]
    fn missing_short_and_ellipses() {
        assert_eq!(find(PDF, "A function f is surjective if every output is hit"), None);
        assert_eq!(unusable("is f"), Some("is too short to check"));
        assert_eq!(find(PDF, "Properties"), None, "too short to believe");
        assert!(find(PDF, "\u{201c}A function f is injective … the same out- put.\u{201d}").is_some());
        assert!(find(PDF, "A function f is injective ... inputs give the same nothing").is_none(), "every piece must be there");
        assert!(unusable(&"word ".repeat(400)).is_some());
    }

    #[test]
    fn the_passage_around_a_match_and_where_it_is() {
        let f = find(PDF, "if no two inputs give the same").unwrap();
        let (before, hit, after) = context(PDF, f, 40);
        assert_eq!(hit, "if no two inputs give the same");
        assert!(before.ends_with("one-to-one\u{201d}) ") && after.starts_with(" out- put"), "spaces kept at the joins: {before:?} {after:?}");
        assert!(find("Test 1 will **not** cover graphs.", "Test 1 will not cover graphs").is_some(), "Markdown emphasis isn't part of the words");
        assert_eq!(locate(PDF, f.start, false).as_deref(), Some("§5.3"));
        let toc = "Contents 5 Functions 116 5.3 Properties of Functions . . . 117\n\n5.4 Functions on Sets\n\nLet's look at examples of functions on sets.";
        let at = toc.find("Let's").unwrap();
        assert_eq!(locate(toc, at, false).as_deref(), Some("§5.4"));
        let hw = "Problems\n1.\nFor this problem, use these.\n2.\nHere are several functions.\n3.\nAnswer each question about c.";
        assert_eq!(locate(hw, hw.find("Answer each").unwrap(), true).as_deref(), Some("#3"));
        assert_eq!(locate(hw, 3, true), None);
        // Far into a file of bullets (three bytes each): the window never starts inside one.
        let long = format!("5.1 Sets\n\n{}A passage here.", "• item ".repeat(3_000));
        for cut in 0..3 {
            let at = long.find("A passage").unwrap() - cut;
            if long.is_char_boundary(at) {
                assert_eq!(locate(&long, at, false), None, "the heading is out of the window");
            }
        }
        // 12,000 bytes back from here lands inside an "é" (the real C241 notes hit this).
        let mixed = format!("{}{}", "é".repeat(7_000), "•".repeat(10));
        assert_eq!(locate(&mixed, 14_003, false), None);
        assert_eq!(locate(&mixed, 14_003, true), None);
    }
}
