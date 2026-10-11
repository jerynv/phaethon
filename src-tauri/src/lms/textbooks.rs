//! Spotting textbooks in a course: ISBNs (checked by their check digit, so a
//! phone number is never one), links the syllabus calls a textbook or
//! required reading, and open textbook sites, whose book page links the PDF.

use url::Url;

use super::html::{self, FoundLink};

/// An ISBN found in a course's text, with the line it was on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Isbn {
    /// Digits only (and a final X for some ISBN-10s).
    pub isbn: String,
    pub line: String,
}

fn isbn10_ok(d: &[u8]) -> bool {
    d.len() == 10
        && d[..9].iter().all(u8::is_ascii_digit)
        && (d[9].is_ascii_digit() || d[9] == b'X')
        && d.iter().enumerate().map(|(i, c)| (10 - i as u32) * if *c == b'X' { 10 } else { (c - b'0') as u32 }).sum::<u32>() % 11 == 0
}

fn isbn13_ok(d: &[u8]) -> bool {
    d.len() == 13
        && d.iter().all(u8::is_ascii_digit)
        && (d.starts_with(b"978") || d.starts_with(b"979"))
        && d.iter().enumerate().map(|(i, c)| if i % 2 == 0 { 1 } else { 3 } * (c - b'0') as u32).sum::<u32>() % 10 == 0
}

/// Every ISBN in `text`. ISBN-13s count anywhere (978/979 and a valid check
/// digit); an ISBN-10 only right after the word "ISBN", since ten digits alone
/// are too often something else.
pub fn isbns(text: &str) -> Vec<Isbn> {
    let mut out: Vec<Isbn> = vec![];
    for line in text.lines() {
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if !chars[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            // A run of digits, hyphens, spaces and a final X.
            let start = i;
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_digit() || matches!(chars[j], '-' | ' ' | '‐' | '–' | 'X' | 'x')) {
                j += 1;
            }
            let run: String = chars[start..j].iter().collect();
            // Try the parts split by spaces, alone and joined with their neighbours.
            let parts: Vec<&str> = run.split(' ').filter(|p| !p.is_empty()).collect();
            let prefix: String = chars[start.saturating_sub(16)..start].iter().collect::<String>().to_lowercase();
            let after_isbn = prefix.contains("isbn");
            for a in 0..parts.len() {
                for b in a..parts.len() {
                    let digits: Vec<u8> = parts[a..=b]
                        .concat()
                        .bytes()
                        .filter(|c| c.is_ascii_digit() || *c == b'X' || *c == b'x')
                        .map(|c| c.to_ascii_uppercase())
                        .collect();
                    if digits.len() > 13 {
                        break;
                    }
                    let found = isbn13_ok(&digits) || (a == 0 && after_isbn && isbn10_ok(&digits));
                    let isbn = String::from_utf8(digits).unwrap_or_default();
                    if found && !out.iter().any(|x| x.isbn == isbn) {
                        let line: String = line.trim().chars().take(240).collect();
                        out.push(Isbn { isbn, line });
                    }
                }
            }
            i = j.max(i + 1);
        }
    }
    out
}

const TEXTBOOK_WORDS: &[&str] = &[
    "textbook", "text book", "required text", "required reading", "course text", "course materials", "required materials",
    "isbn", "open textbook", "e-book", "ebook", "edition", "course reader", "course pack", "coursepack",
];

/// Sites whose books are free to download (Open Educational Resources).
pub fn open_textbook_host(u: &Url) -> bool {
    let Some(host) = u.host_str() else { return false };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["openstax.org", "libretexts.org", "open.umn.edu", "pressbooks.pub", "opentextbc.ca", "oercommons.org", "oer.galileo.usg.edu", "openoregon.pressbooks.pub", "saylor.org"]
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// True when a link reads as a textbook: the words around it say so, or it is an open textbook site.
pub fn is_textbook(link: &FoundLink) -> bool {
    let words = format!("{} {}", link.text, link.context).to_lowercase();
    open_textbook_host(&link.url) || TEXTBOOK_WORDS.iter().any(|w| words.contains(w))
}

/// On a book's web page, the link most likely to be its PDF: an address ending
/// in .pdf, or a link whose words say PDF or download. The page's own address
/// resolves relative links.
pub fn pdf_link_on_page(page_html: &str, page_url: &Url) -> Option<Url> {
    let scan = html::scan(page_html, Some(page_url));
    let web = |u: &Url| matches!(u.scheme(), "http" | "https");
    let by_address = scan.links.iter().find(|l| web(&l.url) && l.url.path().to_ascii_lowercase().ends_with(".pdf"));
    let by_words = || {
        scan.links.iter().find(|l| {
            let t = l.text.to_lowercase();
            web(&l.url) && (t.contains("pdf") || (t.contains("download") && !t.contains("app")))
        })
    };
    by_address.or_else(by_words).map(|l| l.url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isbns_need_a_valid_check_digit() {
        let text = "Required: Stewart, Calculus 9th ed., ISBN 978-1-337-61392-7 (hardcover).\n\
                    Also ISBN-10: 0-306-40615-2.\nCall 812-555-1234 or 9781337613920 (wrong check digit).\n\
                    Ten digits without the word: 0306406152.";
        let found = isbns(text);
        let digits: Vec<&str> = found.iter().map(|i| i.isbn.as_str()).collect();
        assert_eq!(digits, vec!["9781337613927", "0306406152"]);
        assert!(found[0].line.starts_with("Required: Stewart"));
    }

    #[test]
    fn textbook_links_by_words_or_host() {
        let l = |u: &str, text: &str, ctx: &str| FoundLink { url: Url::parse(u).unwrap(), text: text.into(), context: ctx.into() };
        assert!(is_textbook(&l("https://example.com/book", "Book", "Required textbook: Book")));
        assert!(is_textbook(&l("https://math.libretexts.org/Bookshelves/x", "Chapter 2", "Read Chapter 2")));
        assert!(!is_textbook(&l("https://zoom.us/j/1", "Office hours", "Office hours on Zoom")));
    }

    #[test]
    fn the_pdf_link_on_a_book_page() {
        let page = Url::parse("https://open.umn.edu/opentextbooks/textbooks/123").unwrap();
        let html = "<a href=\"/about\">About</a><a href=\"https://cdn.example.org/files/book.PDF\">Get it</a>";
        assert_eq!(pdf_link_on_page(html, &page).unwrap().as_str(), "https://cdn.example.org/files/book.PDF");
        let html = "<a href=\"/dl/77\">Download PDF</a>";
        assert_eq!(pdf_link_on_page(html, &page).unwrap().as_str(), "https://open.umn.edu/dl/77");
        assert_eq!(pdf_link_on_page("<a href=\"/x\">Read online</a>", &page), None);
    }
}
