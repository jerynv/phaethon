//! HTML from a course site to Markdown, and the links and text in it.
//!
//! Small on purpose: course pages are simple (headings, paragraphs, lists,
//! links, tables). Scripts, styles, forms and the document head are dropped,
//! never run. Every link goes through the caller's `rewrite`, so a link to a
//! course file can point at the downloaded copy.

use url::Url;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Open { name: String, attrs: Vec<(String, String)>, closed: bool },
    Close(String),
    Text(String),
}

/// Elements whose content is never shown (or never safe to keep).
const DROPPED: &[&str] = &["script", "style", "noscript", "template", "head", "svg", "math", "select", "textarea", "button", "object", "canvas"];
/// Elements with no closing tag.
const VOID: &[&str] = &["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "param"];

fn tokens(html: &str) -> Vec<Token> {
    let mut out = vec![];
    let b = html.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    let lower = html.to_ascii_lowercase();
    let flush = |out: &mut Vec<Token>, from: usize, to: usize| {
        if to > from {
            out.push(Token::Text(decode_entities(&html[from..to])));
        }
    };
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &lower[i..];
        if rest.starts_with("<!--") {
            flush(&mut out, text_start, i);
            i = rest.find("-->").map(|e| i + e + 3).unwrap_or(b.len());
            text_start = i;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            flush(&mut out, text_start, i);
            i = rest.find('>').map(|e| i + e + 1).unwrap_or(b.len());
            text_start = i;
            continue;
        }
        let closing = rest.starts_with("</");
        let name_at = i + if closing { 2 } else { 1 };
        let name_len = b[name_at..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'-' || **c == b':').count();
        if name_len == 0 || !b[name_at].is_ascii_alphabetic() {
            i += 1; // a lone "<" in text
            continue;
        }
        flush(&mut out, text_start, i);
        let name = lower[name_at..name_at + name_len].to_string();
        let (attrs, end, self_closed) = attributes(html, name_at + name_len);
        i = end;
        text_start = i;
        if closing {
            out.push(Token::Close(name));
            continue;
        }
        if DROPPED.contains(&name.as_str()) && !self_closed {
            // Skip to the matching close tag (raw text: no tags inside count).
            let close = format!("</{name}");
            i = lower[i..].find(&close).map(|e| i + e).unwrap_or(b.len());
            i = lower[i..].find('>').map(|e| i + e + 1).unwrap_or(b.len());
            text_start = i;
            continue;
        }
        let closed = self_closed || VOID.contains(&name.as_str());
        out.push(Token::Open { name, attrs, closed });
    }
    flush(&mut out, text_start, b.len());
    out
}

/// Attributes from `at` (just after the tag name) to the tag's `>`: (attrs, index after `>`, self-closing).
fn attributes(html: &str, mut at: usize) -> (Vec<(String, String)>, usize, bool) {
    let b = html.as_bytes();
    let mut attrs = vec![];
    let mut self_closed = false;
    loop {
        while at < b.len() && b[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= b.len() {
            return (attrs, at, self_closed);
        }
        match b[at] {
            b'>' => return (attrs, at + 1, self_closed),
            b'/' => {
                self_closed = true;
                at += 1;
                continue;
            }
            _ => {}
        }
        self_closed = false;
        let start = at;
        while at < b.len() && !b[at].is_ascii_whitespace() && !matches!(b[at], b'=' | b'>' | b'/') {
            at += 1;
        }
        let name = html[start..at].to_ascii_lowercase();
        while at < b.len() && b[at].is_ascii_whitespace() {
            at += 1;
        }
        let mut value = String::new();
        if at < b.len() && b[at] == b'=' {
            at += 1;
            while at < b.len() && b[at].is_ascii_whitespace() {
                at += 1;
            }
            if at < b.len() && (b[at] == b'"' || b[at] == b'\'') {
                let q = b[at];
                let end = b[at + 1..].iter().position(|c| *c == q).map(|p| at + 1 + p).unwrap_or(b.len());
                value = decode_entities(&html[at + 1..end]);
                at = (end + 1).min(b.len());
            } else {
                let s = at;
                while at < b.len() && !b[at].is_ascii_whitespace() && b[at] != b'>' {
                    at += 1;
                }
                value = decode_entities(&html[s..at]);
            }
        }
        if !name.is_empty() {
            attrs.push((name, value));
        }
        if at == start {
            at += 1; // never stall on an odd byte
        }
    }
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

/// HTML character references: the common named ones and all numeric ones.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map(|e| e + 1).unwrap_or(rest.len());
        let entity = &rest[1..end];
        let ch: Option<String> = match entity {
            "amp" => Some("&".into()),
            "lt" => Some("<".into()),
            "gt" => Some(">".into()),
            "quot" => Some("\"".into()),
            "apos" | "#39" => Some("'".into()),
            "nbsp" => Some(" ".into()),
            "ndash" => Some("–".into()),
            "mdash" => Some("—".into()),
            "hellip" => Some("…".into()),
            "lsquo" => Some("‘".into()),
            "rsquo" => Some("’".into()),
            "ldquo" => Some("“".into()),
            "rdquo" => Some("”".into()),
            "bull" => Some("•".into()),
            "middot" => Some("·".into()),
            "copy" => Some("©".into()),
            "reg" => Some("®".into()),
            "trade" => Some("™".into()),
            "times" => Some("×".into()),
            "divide" => Some("÷".into()),
            "deg" => Some("°".into()),
            "plusmn" => Some("±".into()),
            "le" => Some("≤".into()),
            "ge" => Some("≥".into()),
            "ne" => Some("≠".into()),
            "rarr" => Some("→".into()),
            "larr" => Some("←".into()),
            "shy" | "zwj" | "zwnj" => Some(String::new()),
            "eacute" => Some("é".into()),
            "egrave" => Some("è".into()),
            "aacute" => Some("á".into()),
            "iacute" => Some("í".into()),
            "oacute" => Some("ó".into()),
            "uacute" => Some("ú".into()),
            "ntilde" => Some("ñ".into()),
            "uuml" => Some("ü".into()),
            "ouml" => Some("ö".into()),
            "auml" => Some("ä".into()),
            "ccedil" => Some("ç".into()),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .map(|h| u32::from_str_radix(h, 16).ok())
                .unwrap_or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32)
                .filter(|c| *c != '\0')
                .map(String::from),
        };
        match ch {
            Some(c) if !entity.is_empty() => {
                out.push_str(&c);
                rest = &rest[end..];
                rest = rest.strip_prefix(';').unwrap_or(rest);
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A link found in HTML, with the words around it (for spotting textbooks).
#[derive(Debug, Clone, PartialEq)]
pub struct FoundLink {
    pub url: Url,
    pub text: String,
    /// The sentence around it (at most 150 characters each side, within its block).
    pub context: String,
}

/// The plain text of a page (one line per block) and the links in it.
#[derive(Debug, Default)]
pub struct Scan {
    pub text: String,
    pub links: Vec<FoundLink>,
    /// The page's `<title>`, when it has one.
    pub title: Option<String>,
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "nav" | "aside" | "li" | "ul" | "ol" | "tr" | "table"
            | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre" | "br" | "hr" | "dd" | "dt" | "dl" | "figure" | "figcaption"
    )
}

/// Resolve an href against the page's address. Only web and mail links count.
pub fn resolve(base: Option<&Url>, href: &str) -> Option<Url> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let u = match base {
        Some(b) => b.join(href).ok()?,
        None => Url::parse(href).ok()?,
    };
    matches!(u.scheme(), "http" | "https" | "mailto").then_some(u)
}

/// The text and links of `html`, for spotting textbooks and readings.
pub fn scan(html: &str, base: Option<&Url>) -> Scan {
    let title = page_title(html);
    let mut text = String::new();
    // (url, link text, start offset in `text`)
    let mut open: Option<(Url, usize)> = None;
    let mut found: Vec<(Url, String, usize, usize)> = vec![];
    for t in tokens(html) {
        match t {
            Token::Text(s) => push_collapsed(&mut text, &s),
            Token::Open { name, attrs, .. } => {
                if is_block(&name) && !text.ends_with('\n') && !text.is_empty() {
                    text.push('\n');
                }
                match name.as_str() {
                    "a" => open = attr(&attrs, "href").and_then(|h| resolve(base, h)).map(|u| (u, text.len())),
                    "iframe" | "embed" => {
                        if let Some(u) = attr(&attrs, "src").and_then(|h| resolve(base, h)) {
                            let label = attr(&attrs, "title").unwrap_or("").to_string();
                            found.push((u, label, text.len(), text.len()));
                        }
                    }
                    _ => {}
                }
            }
            Token::Close(name) => {
                if name == "a"
                    && let Some((u, start)) = open.take()
                {
                    let label = text[start..].trim().to_string();
                    found.push((u, label, start, text.len()));
                }
                if is_block(&name) && !text.ends_with('\n') {
                    text.push('\n');
                }
            }
        }
    }
    let links = found
        .into_iter()
        .map(|(url, label, start, end)| {
            let block_start = text[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let block_end = text[end..].find('\n').map(|i| end + i).unwrap_or(text.len());
            // The sentence the link is in, within its block, at most 150 characters each side.
            let before = &text[block_start..start];
            let before = [". ", "! ", "? "].iter().filter_map(|p| before.rfind(p).map(|i| i + p.len())).max().map_or(before, |i| &before[i..]);
            let after = &text[end..block_end];
            let after = [". ", "! ", "? "].iter().filter_map(|p| after.find(p).map(|i| i + 1)).min().map_or(after, |i| &after[..i]);
            let before = tail_chars(before, 150);
            let after = head_chars(after, 150);
            FoundLink { url, text: label, context: format!("{before}{}{after}", &text[start..end]) }
        })
        .collect();
    Scan { text, links, title }
}

fn tail_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let skip = s.char_indices().nth(count - n).map(|(i, _)| i).unwrap_or(0);
    &s[skip..]
}

fn head_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// The `<title>` of an HTML page, whitespace collapsed, at most 200 characters.
pub fn page_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let t: String = decode_entities(&html[start..end]).split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(200).collect();
    (!t.is_empty()).then_some(t)
}

fn push_collapsed(out: &mut String, s: &str) {
    for c in s.chars() {
        if c.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                out.push(' ');
            }
        } else if !c.is_control() {
            out.push(c);
        }
    }
}

// ---- Markdown ---------------------------------------------------------------

#[derive(Debug)]
enum Frame {
    Root,
    Link(Option<String>),
    Emph(&'static str),
    Code,
    Pre,
    Heading(usize),
    Item(String),
    List { ordered: bool, n: usize },
    Quote,
    Table { rows: Vec<Vec<String>>, head: bool },
    Row(Vec<String>),
    Cell,
    Skip,
}

struct Md<'a> {
    frames: Vec<(Frame, String)>,
    base: Option<&'a Url>,
    rewrite: &'a mut dyn FnMut(&Url) -> String,
}

impl Md<'_> {
    fn buf(&mut self) -> &mut String {
        &mut self.frames.last_mut().expect("root").1
    }

    fn in_pre(&self) -> bool {
        self.frames.iter().any(|(f, _)| matches!(f, Frame::Pre))
    }

    fn in_cell(&self) -> bool {
        self.frames.iter().any(|(f, _)| matches!(f, Frame::Cell))
    }

    fn skipping(&self) -> bool {
        self.frames.iter().any(|(f, _)| matches!(f, Frame::Skip))
    }

    fn text(&mut self, s: &str) {
        if self.skipping() {
            return;
        }
        if self.in_pre() {
            self.buf().push_str(s);
        } else {
            push_collapsed(self.buf(), s);
        }
    }

    /// End the current block: a blank line (a space inside a table cell).
    fn block(&mut self) {
        let cell = self.in_cell();
        let b = self.buf();
        trim_end_spaces(b);
        if b.is_empty() {
            return;
        }
        if cell {
            if !b.ends_with(' ') {
                b.push(' ');
            }
            return;
        }
        while !b.ends_with("\n\n") {
            b.push('\n');
        }
    }

    fn line(&mut self) {
        let cell = self.in_cell();
        let b = self.buf();
        trim_end_spaces(b);
        if b.is_empty() || b.ends_with('\n') {
            return;
        }
        b.push(if cell { ' ' } else { '\n' });
    }

    fn open(&mut self, name: &str, attrs: &[(String, String)], closed: bool) {
        if self.skipping() && !closed {
            self.frames.push((Frame::Skip, String::new()));
            return;
        }
        match name {
            "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "aside" | "figure" | "figcaption" | "dl" | "dt" | "dd" | "center" => self.block(),
            "form" | "nav" if !closed => self.frames.push((Frame::Skip, String::new())),
            "br" => {
                if self.in_cell() {
                    self.buf().push(' ');
                } else if self.in_pre() {
                    self.buf().push('\n');
                } else {
                    trim_end_spaces(self.buf());
                    self.buf().push('\n');
                }
            }
            "hr" => {
                self.block();
                self.buf().push_str("---");
                self.block();
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" if !closed => {
                self.block();
                self.frames.push((Frame::Heading(name[1..].parse().unwrap_or(2)), String::new()));
            }
            "strong" | "b" if !closed => self.frames.push((Frame::Emph("**"), String::new())),
            "em" | "i" | "cite" if !closed => self.frames.push((Frame::Emph("*"), String::new())),
            "code" | "kbd" | "samp" | "tt" if !closed && !self.in_pre() => self.frames.push((Frame::Code, String::new())),
            "pre" if !closed => {
                self.block();
                self.frames.push((Frame::Pre, String::new()));
            }
            "a" if !closed => {
                let target = attr(attrs, "href").and_then(|h| self.target(h));
                self.frames.push((Frame::Link(target), String::new()));
            }
            "img" => {
                let alt = attr(attrs, "alt").unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
                match attr(attrs, "src").and_then(|s| self.target(s)) {
                    Some(t) => {
                        let s = format!("![{}]({})", escape_label(&alt), t);
                        self.inline(&s);
                    }
                    None if !alt.is_empty() => {
                        let s = format!("[image: {alt}]");
                        self.inline(&s);
                    }
                    None => {}
                }
            }
            "iframe" | "embed" | "video" | "audio" => {
                if let Some(t) = attr(attrs, "src").and_then(|s| self.target(s)) {
                    let label = attr(attrs, "title").filter(|t| !t.trim().is_empty()).unwrap_or("Embedded content").to_string();
                    self.block();
                    let s = format!("[{}]({})", escape_label(&label), t);
                    self.buf().push_str(&s);
                    self.block();
                }
                if !closed && name == "iframe" {
                    self.frames.push((Frame::Skip, String::new()));
                }
            }
            "ul" | "ol" if !closed => {
                self.line();
                let start = attr(attrs, "start").and_then(|s| s.parse().ok()).unwrap_or(1);
                self.frames.push((Frame::List { ordered: name == "ol", n: start }, String::new()));
            }
            "li" if !closed => {
                // An item left open (`<li>a<li>b`) ends where the next one starts.
                let list = self.frames.iter().rposition(|(f, _)| matches!(f, Frame::List { .. }));
                if let Some(item) = self.frames.iter().rposition(|(f, _)| matches!(f, Frame::Item(_)))
                    && list.is_none_or(|l| item > l)
                {
                    while self.frames.len() > item {
                        self.pop();
                    }
                }
                let marker = match self.frames.iter_mut().rev().find(|(f, _)| matches!(f, Frame::List { .. })) {
                    Some((Frame::List { ordered: true, n }, _)) => {
                        *n += 1;
                        format!("{}. ", *n - 1)
                    }
                    _ => "- ".to_string(),
                };
                self.frames.push((Frame::Item(marker), String::new()));
            }
            "blockquote" if !closed => {
                self.block();
                self.frames.push((Frame::Quote, String::new()));
            }
            "table" if !closed => {
                self.block();
                self.frames.push((Frame::Table { rows: vec![], head: false }, String::new()));
            }
            "tr" if !closed => self.frames.push((Frame::Row(vec![]), String::new())),
            "td" | "th" if !closed => {
                if name == "th"
                    && let Some((Frame::Table { head, rows }, _)) = self.frames.iter_mut().rev().find(|(f, _)| matches!(f, Frame::Table { .. }))
                    && rows.is_empty()
                {
                    *head = true;
                }
                self.frames.push((Frame::Cell, String::new()));
            }
            _ => {}
        }
    }

    fn inline(&mut self, s: &str) {
        let b = self.buf();
        b.push_str(s);
    }

    fn target(&mut self, href: &str) -> Option<String> {
        let u = resolve(self.base, href)?;
        Some(if u.scheme() == "mailto" { u.to_string() } else { (self.rewrite)(&u) })
    }

    fn close(&mut self, name: &str) {
        let want: fn(&Frame) -> bool = match name {
            "a" => |f| matches!(f, Frame::Link(_)),
            "strong" | "b" => |f| matches!(f, Frame::Emph("**")),
            "em" | "i" | "cite" => |f| matches!(f, Frame::Emph("*")),
            "code" | "kbd" | "samp" | "tt" => |f| matches!(f, Frame::Code),
            "pre" => |f| matches!(f, Frame::Pre),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => |f| matches!(f, Frame::Heading(_)),
            "ul" | "ol" => |f| matches!(f, Frame::List { .. }),
            "li" => |f| matches!(f, Frame::Item(_)),
            "blockquote" => |f| matches!(f, Frame::Quote),
            "table" => |f| matches!(f, Frame::Table { .. }),
            "tr" => |f| matches!(f, Frame::Row(_)),
            "td" | "th" => |f| matches!(f, Frame::Cell),
            "form" | "nav" | "iframe" => |f| matches!(f, Frame::Skip),
            "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "aside" | "figure" | "figcaption" | "dl" | "dt" | "dd" | "center" => {
                if !self.skipping() {
                    self.block();
                }
                return;
            }
            _ => return,
        };
        // Close everything opened inside it that was left open (sloppy HTML), then it.
        let Some(at) = self.frames.iter().rposition(|(f, _)| want(f)) else { return };
        if at == 0 {
            return;
        }
        while self.frames.len() > at {
            self.pop();
        }
    }

    fn pop(&mut self) {
        let (frame, inner) = self.frames.pop().expect("frame");
        match frame {
            Frame::Root | Frame::Skip => {}
            Frame::Link(target) => {
                let label = inner.split_whitespace().collect::<Vec<_>>().join(" ");
                match target {
                    Some(t) => {
                        let label = if label.is_empty() { t.clone() } else { label };
                        let s = format!("[{}]({})", escape_label(&label), t);
                        self.inline(&s);
                    }
                    None => self.inline(&label),
                }
            }
            Frame::Emph(mark) => {
                let t = inner.trim();
                if t.is_empty() {
                    if !inner.is_empty() {
                        self.text(" ");
                    }
                    return;
                }
                let lead = if inner.starts_with(' ') { " " } else { "" };
                let trail = if inner.ends_with(' ') { " " } else { "" };
                let s = format!("{lead}{mark}{t}{mark}{trail}");
                self.inline(&s);
            }
            Frame::Code => {
                let t = inner.trim();
                if !t.is_empty() {
                    let fence = if t.contains('`') { "``" } else { "`" };
                    let s = format!("{fence}{t}{fence}");
                    self.inline(&s);
                }
            }
            Frame::Pre => {
                let body = inner.trim_matches('\n');
                let s = format!("```\n{body}\n```");
                self.inline(&s);
                self.block();
            }
            Frame::Heading(n) => {
                let t = inner.split_whitespace().collect::<Vec<_>>().join(" ");
                if !t.is_empty() {
                    let s = format!("{} {t}", "#".repeat(n.clamp(1, 6)));
                    self.inline(&s);
                }
                self.block();
            }
            Frame::Item(marker) => {
                let body = tidy(&inner);
                self.line();
                let pad = " ".repeat(marker.chars().count());
                let mut s = String::new();
                for (i, l) in body.lines().filter(|l| !l.trim().is_empty()).enumerate() {
                    if i == 0 {
                        s.push_str(&marker);
                    } else {
                        s.push('\n');
                        s.push_str(&pad);
                    }
                    s.push_str(l);
                }
                if s.is_empty() {
                    s = marker.trim_end().to_string();
                }
                self.inline(&s);
                self.line();
            }
            Frame::List { .. } => {
                let body = tidy(&inner);
                self.line();
                self.inline(&body);
                if self.frames.iter().any(|(f, _)| matches!(f, Frame::Item(_))) {
                    self.line();
                } else {
                    self.block();
                }
            }
            Frame::Quote => {
                let body = tidy(&inner);
                let s: Vec<String> = body.lines().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect();
                self.inline(&s.join("\n"));
                self.block();
            }
            Frame::Cell => {
                let t = inner.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "\\|");
                if let Some((Frame::Row(cells), _)) = self.frames.last_mut() {
                    cells.push(t);
                }
            }
            Frame::Row(cells) => {
                if let Some((Frame::Table { rows, .. }, _)) = self.frames.iter_mut().rev().find(|(f, _)| matches!(f, Frame::Table { .. }))
                    && !cells.is_empty()
                {
                    rows.push(cells);
                }
            }
            Frame::Table { rows, head } => {
                let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                if width == 0 {
                    return;
                }
                let row = |r: &Vec<String>| {
                    let mut cells = r.clone();
                    cells.resize(width, String::new());
                    format!("| {} |", cells.join(" | "))
                };
                let mut lines = vec![];
                let mut iter = rows.iter();
                // Markdown tables need a header row; a table without one gets an empty one.
                if head {
                    lines.push(row(iter.next().expect("a row")));
                } else {
                    lines.push(row(&vec![String::new(); width]));
                }
                lines.push(format!("|{}", " --- |".repeat(width)));
                lines.extend(iter.map(row));
                self.block();
                let s = lines.join("\n");
                self.inline(&s);
                self.block();
            }
        }
    }
}

fn escape_label(s: &str) -> String {
    s.replace('[', "\\[").replace(']', "\\]")
}

fn trim_end_spaces(b: &mut String) {
    while b.ends_with(' ') {
        b.pop();
    }
}

/// Trailing spaces off each line, at most one blank line in a row, no blank lines at the ends.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    let mut in_fence = false;
    for l in s.lines() {
        if l.starts_with("```") {
            in_fence = !in_fence;
        }
        let l = if in_fence { l } else { l.trim_end() };
        if l.trim().is_empty() && !in_fence {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(l);
    }
    out
}

/// `html` as Markdown. Every link and image address is resolved against `base`
/// and passed through `rewrite`, which returns what the Markdown should point at.
pub fn to_markdown(html: &str, base: Option<&Url>, rewrite: &mut dyn FnMut(&Url) -> String) -> String {
    let mut md = Md { frames: vec![(Frame::Root, String::new())], base, rewrite };
    for t in tokens(html) {
        match t {
            Token::Text(s) => md.text(&s),
            Token::Open { name, attrs, closed } => md.open(&name, &attrs, closed),
            Token::Close(name) => md.close(&name),
        }
    }
    while md.frames.len() > 1 {
        md.pop();
    }
    tidy(&md.frames.pop().expect("root").1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(html: &str) -> String {
        let base = Url::parse("https://site.example/courses/1/").unwrap();
        to_markdown(html, Some(&base), &mut |u| u.to_string())
    }

    #[test]
    fn scripts_styles_and_forms_are_dropped() {
        let out = md("<head><title>T</title><style>p{}</style></head><p>Hi <script>alert('x</p>')</script>there</p><form><input name=a>Secret</form>");
        assert_eq!(out, "Hi there");
    }

    #[test]
    fn structure_becomes_markdown() {
        let out = md(
            "<h2>Week&nbsp;1</h2><p>Read <strong>chapter 1 </strong>and <em>2</em>.</p>\
             <ul><li>One</li><li>Two<ul><li>Two a</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>\
             <p>See <a href=\"pages/intro\">the intro</a> or <a href=\"mailto:prof@x.edu\">email</a>.</p>\
             <table><tr><th>Week</th><th>Topic</th></tr><tr><td>1</td><td>Limits | intro</td></tr></table>\
             <pre><code>let x = 1;\n  y</code></pre><blockquote><p>Quote</p></blockquote>",
        );
        let want = "## Week 1\n\nRead **chapter 1** and *2*.\n\n- One\n- Two\n  - Two a\n\n1. First\n2. Second\n\n\
See [the intro](https://site.example/courses/1/pages/intro) or [email](mailto:prof@x.edu).\n\n\
| Week | Topic |\n| --- | --- |\n| 1 | Limits \\| intro |\n\n```\nlet x = 1;\n  y\n```\n\n> Quote";
        assert_eq!(out, want);
    }

    #[test]
    fn links_are_rewritten_and_javascript_links_dropped() {
        let base = Url::parse("https://site.example/courses/1/pages/a").unwrap();
        let out = to_markdown(
            "<a href=\"/courses/1/files/9?wrap=1\">Slides</a> <a href=\"javascript:evil()\">x</a> <img src=\"/f/2\" alt=\"Graph\">",
            Some(&base),
            &mut |u| if u.path() == "/courses/1/files/9" { "files/Slides.pdf".into() } else { u.to_string() },
        );
        assert_eq!(out, "[Slides](files/Slides.pdf) x ![Graph](https://site.example/f/2)");
    }

    #[test]
    fn scan_finds_links_with_their_context_and_the_title() {
        let base = Url::parse("https://site.example/").unwrap();
        let s = scan(
            "<title> My  Page </title><p>Other paragraph.</p><p>Required textbook: <a href=\"https://openstax.org/details/books/calculus\">Calculus Vol 1</a>, free online.</p>",
            Some(&base),
        );
        assert_eq!(s.title.as_deref(), Some("My Page"));
        assert_eq!(s.links.len(), 1);
        assert_eq!(s.links[0].text, "Calculus Vol 1");
        assert_eq!(s.links[0].context, "Required textbook: Calculus Vol 1, free online.");
        assert!(s.text.contains("Other paragraph.\nRequired textbook"));
    }

    #[test]
    fn entities_decode_and_odd_input_never_panics() {
        assert_eq!(decode_entities("a &amp; b &#x2014; &#8212; &bogus; &"), "a & b — — &bogus; &");
        for junk in ["<", "<a href=", "<<p>>", "</>", "<a href='x", "&#xffffffff;", "<table><td>x", "<li>x<li>y", "<pre>"] {
            let _ = md(junk);
            let _ = scan(junk, None);
        }
    }
}
