//! Text copies of course documents (PDF, Word, PowerPoint, pictures), so the
//! agent can read the actual material. Pure Rust, except that pages with no
//! text (handwriting, scans) and pictures are recognised by [`ocr`].
//!
//! PDFs are read in a child process (this same program, started with
//! [`CHILD_ENV`]): a PDF from the internet can be malformed in ways that make a
//! parser panic or spin, and the app is built to abort on panic. The child is
//! killed after [`PDF_TIMEOUT`] and its output is capped.

pub mod ocr;
pub mod pictures;
pub mod png;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::attachments;
use ocr::Page;

pub const CHILD_ENV: &str = "PHAETHON_PDF_TEXT";
const PDF_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest text copy kept, in bytes.
pub const MAX_TEXT: usize = 8 * 1024 * 1024;
/// Most bytes a PDF's streams may inflate to while reading it.
const MAX_INFLATE: usize = 512 * 1024 * 1024;
/// Largest Office part read (one slide's XML, a document's body).
const MAX_PART: usize = 64 * 1024 * 1024;
const MAX_SLIDES: usize = 1000;
/// A PDF page with fewer letters than this in its text layer is recognised as a picture.
pub const SPARSE: usize = 30;
/// After a page heading: its text was recognised from its picture.
pub const RECOGNISED: &str = "(recognised from handwriting or a scan; may contain mistakes)";
/// Under a typed page's text: it also shows pictures.
pub const PICTURES_NOTE: &str = "(This page also shows ";
pub const NO_TEXT_IN_PICTURE: &str = "(No text was found in this picture.)";
/// What copies made before recognition worked off macOS said; made again once it works.
const NO_OCR: &str = "(This page is handwriting or a scan; text recognition needs macOS for now.)";
const NO_OCR_PICTURE: &str = "(This is a picture; recognising any text in it needs macOS for now.)";
/// A page or picture whose text couldn't be recognised on this computer, and why.
pub const CANT_RECOGNISE: &str = "its text can’t be recognised on this computer:";
const OLD_NO_TEXT: &str = "(This file has no text in it";

/// What kind of document a file is, by its first bytes (and, for zip-based
/// Office files, by what the zip holds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Doc {
    Pdf,
    Docx,
    Pptx,
    Picture,
    Other,
}

pub fn kind_of(path: &Path) -> Doc {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => Doc::Pdf,
        "docx" => Doc::Docx,
        "pptx" => Doc::Pptx,
        _ if ocr::is_picture(path) => Doc::Picture,
        _ => Doc::Other,
    }
}

/// The text of the document at `path`, or why there is none. `Ok("")` for a
/// document with no text.
pub fn extract(path: &Path) -> Result<String, String> {
    extract_with(None, path)
}

/// [`extract`], with `reader` as the program started to read PDFs and
/// recognise text (`None`: this one). Tests outside the crate pass the app.
pub fn extract_with(reader: Option<&Path>, path: &Path) -> Result<String, String> {
    match kind_of(path) {
        Doc::Pdf => pdf_text(reader, path),
        Doc::Docx => {
            let bytes = read_capped(path)?;
            attachments::docx_text(&bytes)
        }
        Doc::Pptx => {
            let bytes = read_capped(path)?;
            pptx_text(&bytes)
        }
        Doc::Picture => picture_text(reader, path),
        Doc::Other => Err("not a document Phaethon can read".into()),
    }
}

fn read_capped(path: &Path) -> Result<Vec<u8>, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > super::MAX_DOWNLOAD {
        return Err("too big to read".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// Slide by slide: each slide's text runs, one paragraph per line, under "## Slide N".
pub fn pptx_text(bytes: &[u8]) -> Result<String, String> {
    let mut out = String::new();
    let mut found = false;
    for n in 1..=MAX_SLIDES {
        let Some(xml) = attachments::zip_entry(bytes, &format!("ppt/slides/slide{n}.xml"), MAX_PART) else { break };
        found = true;
        let xml = String::from_utf8_lossy(&xml);
        let mut slide = String::new();
        let mut rest: &str = &xml;
        let mut in_text = false;
        while let Some(open) = rest.find('<') {
            if in_text {
                slide.push_str(&attachments::unescape(&rest[..open]));
            }
            let Some(close) = rest[open..].find('>') else { break };
            let tag = &rest[open + 1..open + close];
            rest = &rest[open + close + 1..];
            let self_closing = tag.ends_with('/');
            match tag.trim_end_matches('/').split(char::is_whitespace).next().unwrap_or("") {
                "a:t" => in_text = !self_closing,
                "/a:t" => in_text = false,
                "a:br" => slide.push('\n'),
                "/a:p" => slide.push('\n'),
                _ => {}
            }
        }
        let slide = slide.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n");
        out.push_str(&format!("## Slide {n}\n\n{slide}\n\n"));
    }
    if !found {
        return Err("it couldn’t be read as a PowerPoint file (.pptx)".into());
    }
    Ok(out.trim_end().to_string())
}

/// One PDF page as its text layer shows it: the text, and how many pictures
/// (figures, diagrams, photos; not decoration) it draws besides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub page: u32,
    pub text: String,
    #[serde(default)]
    pub pictures: u32,
}

/// Each page's text layer and pictures, read in the same process. Only the child (and tests) call this.
pub fn pdf_pages_here(bytes: &[u8]) -> Result<Vec<Layer>, String> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| format!("it couldn’t be read as a PDF ({e})"))?;
    if doc.is_encrypted() {
        return Err("the PDF is password protected".into());
    }
    let pages = doc.get_pages();
    let mut out = vec![];
    let mut size = 0;
    for (&p, &id) in &pages {
        // Page by page, so one unreadable page doesn't lose the rest (it is
        // kept, empty, so it can be recognised as a picture instead).
        let t = doc.extract_text_with_limit(&[p], MAX_INFLATE).unwrap_or_default();
        let t = t.lines().map(str::trim_end).collect::<Vec<_>>().join("\n").trim().to_string();
        size += t.len();
        let pictures = pictures::content_count(&doc, id, letters(&t) >= SPARSE);
        out.push(Layer { page: p, text: t, pictures });
        if size > MAX_TEXT {
            break;
        }
    }
    Ok(out)
}

/// The text layer of a PDF as Markdown, page by page, in the same process (tests).
pub fn pdf_text_here(bytes: &[u8]) -> Result<String, String> {
    Ok(assemble(&pdf_pages_here(bytes)?, &BTreeMap::new(), &Ok(())))
}

/// First thing the app does: when started as the PDF reader, read the PDF
/// named by [`CHILD_ENV`], print its pages' text as JSON and say how to exit;
/// started for page pictures, see [`PICTURES_ENV`]; started as the text
/// recogniser, see [`ocr::child_main`].
pub fn child_main() -> Option<i32> {
    if let Some(code) = ocr::child_main() {
        return Some(code);
    }
    if let Some(path) = std::env::var_os(PICTURES_ENV) {
        return Some(pictures_child(Path::new(&path)));
    }
    let path = std::env::var_os(CHILD_ENV)?;
    let code = match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| pdf_pages_here(&b)) {
        Ok(pages) => {
            use std::io::Write;
            let mut out = std::io::stdout().lock();
            if serde_json::to_writer(&mut out, &pages).is_ok() && out.flush().is_ok() { 0 } else { 1 }
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    };
    Some(code)
}

/// The unit-test binary is not the app, so it can't be the child: its tests read in-process.
fn in_process(reader: Option<&Path>) -> bool {
    cfg!(test) && reader.is_none()
}

fn reader_exe(reader: Option<&Path>) -> Result<std::path::PathBuf, String> {
    match reader {
        Some(r) => Ok(r.to_path_buf()),
        None => std::env::current_exe().map_err(|e| e.to_string()),
    }
}

/// Each page's text layer and pictures, no recognition: in a child (or, in unit tests, here).
pub fn pdf_layers(reader: Option<&Path>, path: &Path) -> Result<Vec<Layer>, String> {
    if in_process(reader) { pdf_pages_here(&read_capped(path)?) } else { pdf_pages(&reader_exe(reader)?, path) }
}

fn pdf_text(reader: Option<&Path>, path: &Path) -> Result<String, String> {
    let pages = pdf_layers(reader, path)?;
    let sparse: Vec<u32> = pages.iter().filter(|l| letters(&l.text) < SPARSE).map(|l| l.page).take(ocr::MAX_PAGES).collect();
    let can = ocr::availability();
    let recognised = if sparse.is_empty() || can.is_err() { BTreeMap::new() } else { recognise(reader, path, Some(&sparse))? };
    Ok(assemble(&pages, &recognised, &can))
}

fn recognise(reader: Option<&Path>, path: &Path, pages: Option<&[u32]>) -> Result<BTreeMap<u32, Page>, String> {
    #[cfg(test)]
    if in_process(reader) {
        return Ok(ocr::recognise_here(path, pages));
    }
    Ok(ocr::recognise(&reader_exe(reader)?, path, pages))
}

pub fn letters(t: &str) -> usize {
    t.chars().filter(|c| c.is_alphanumeric()).count()
}

/// The note under a typed page that also shows pictures.
fn pictures_note(n: u32) -> String {
    if n == 1 {
        format!("{PICTURES_NOTE}a picture (a figure, diagram or photo); it can’t be read as text.)")
    } else {
        format!("{PICTURES_NOTE}{n} pictures (figures, diagrams or photos); they can’t be read as text.)")
    }
}

/// The text copy of a PDF: each page's text layer, or for a page with (almost)
/// none, what was recognised from its picture, marked as such. A typed page
/// that also shows pictures says so under its text. `can_recognise` is
/// whether recognition works here, and if not why.
fn assemble(pages: &[Layer], recognised: &BTreeMap<u32, Page>, can_recognise: &Result<(), String>) -> String {
    let mut out = String::new();
    for l in pages {
        let (n, layer) = (l.page, &l.text);
        let (label, body) = match recognised.get(&n) {
            Some(Page::Text(t)) if letters(t) > letters(layer) => (format!(" {RECOGNISED}"), t.trim().to_string()),
            Some(Page::Text(_)) if layer.is_empty() => (String::new(), "(No text was found on this page.)".to_string()),
            Some(Page::Failed(why)) if layer.is_empty() => {
                (String::new(), format!("(This page is handwriting or a scan, and its text couldn’t be recognised: {why}.)"))
            }
            None if layer.is_empty() => match can_recognise {
                Err(why) => (String::new(), format!("(This page is handwriting or a scan, and {CANT_RECOGNISE} {why}.)")),
                Ok(()) => (String::new(), format!("(This page has no text, and only the first {} such pages are recognised.)", ocr::MAX_PAGES)),
            },
            _ => (String::new(), layer.clone()),
        };
        let typed = label.is_empty() && letters(layer) >= SPARSE;
        let note = if typed && l.pictures > 0 { format!("\n\n{}", pictures_note(l.pictures)) } else { String::new() };
        out.push_str(&format!("## Page {n}{label}\n\n{body}{note}\n\n"));
    }
    out.trim_end().to_string()
}

/// A text copy of a picture: whatever text was recognised in it.
fn picture_text(reader: Option<&Path>, path: &Path) -> Result<String, String> {
    if let Err(why) = ocr::availability() {
        return Ok(format!("(This is a picture, and {CANT_RECOGNISE} {why}.)"));
    }
    Ok(match recognise(reader, path, None)?.remove(&1) {
        Some(Page::Text(t)) if !t.trim().is_empty() => format!("## Picture {RECOGNISED}\n\n{}", t.trim()),
        Some(Page::Text(_)) => NO_TEXT_IN_PICTURE.into(),
        Some(Page::Failed(why)) => format!("(Any text in this picture couldn’t be recognised: {why}.)"),
        None => "(Any text in this picture couldn’t be recognised.)".into(),
    })
}

/// A text copy written before pages could be recognised (or on a computer
/// that can't, now read on one that can) is missing pages: make it again.
/// Also true when there is no copy at all.
pub fn copy_is_stale(md: &Path) -> bool {
    let Ok(copy) = std::fs::read_to_string(md) else { return true };
    if copy.contains(OLD_NO_TEXT) || (ocr::available() && (copy.contains(NO_OCR) || copy.contains(NO_OCR_PICTURE) || copy.contains(CANT_RECOGNISE))) {
        return true;
    }
    // A "## Page N" heading with nothing under it before the next heading.
    let mut empty_page = false;
    for line in copy.lines() {
        if line.starts_with("## ") {
            if empty_page {
                return true;
            }
            empty_page = line.starts_with("## Page ");
        } else if !line.trim().is_empty() {
            empty_page = false;
        }
    }
    empty_page
}

/// Run this program as a child with `envs`: its stdout (at most `cap` bytes),
/// or why not. Killed after `limit`.
fn run_child(exe: &Path, envs: &[(&str, &std::ffi::OsStr)], limit: Duration, cap: u64) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(exe);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("couldn’t start the PDF reader: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(cap).read_to_end(&mut buf);
        // Drain the rest so the child never blocks on a full pipe.
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = (&mut stderr).take(4096).read_to_string(&mut s);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("reading the PDF took too long".into());
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let e = err.trim();
        return Err(if e.is_empty() { "the PDF couldn’t be read".into() } else { e.chars().take(200).collect() });
    }
    Ok(out)
}

/// Each page's text layer, from a child process (see the module's notes).
fn pdf_pages(exe: &Path, path: &Path) -> Result<Vec<Layer>, String> {
    let out = run_child(exe, &[(CHILD_ENV, path.as_os_str())], PDF_TIMEOUT, 2 * MAX_TEXT as u64 + 1)?;
    serde_json::from_slice(&out).map_err(|_| "the PDF’s text was too long or couldn’t be read".into())
}

// ---- Page pictures, for a model that can look at them ---------------------------------

/// Started with this naming a PDF (and [`ocr::PAGES_ENV`] its pages), the
/// program prints those pages' pictures as JSON and exits.
pub const PICTURES_ENV: &str = "PHAETHON_PAGE_PICTURES";
/// Longest side of a page picture drawn for a model, in pixels.
pub const PICTURE_SIDE: f64 = 1568.0;
/// Largest picture handed on as it is stored.
const PICTURE_BYTES: usize = 3_500_000;
/// Most pages drawn in one go.
pub const PICTURES_MAX: usize = 12;
const PICTURES_TIMEOUT: Duration = Duration::from_secs(90);

/// One page's picture, for a model to look at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PagePicture {
    pub page: u32,
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    /// The file, base64.
    pub data: String,
}

/// The pictures of `pages` of the PDF at `path`, here: a scanned page's
/// picture as stored when it is small enough; otherwise (and for drawn pages,
/// and typed pages with figures) the whole page drawn, on macOS. Elsewhere a
/// page with no stored picture has none.
pub fn page_pictures_here(path: &Path, pages: &[u32]) -> Vec<PagePicture> {
    use base64::Engine;
    let Ok(bytes) = read_capped(path) else { return vec![] };
    let Ok(doc) = lopdf::Document::load_mem(&bytes) else { return vec![] };
    if doc.is_encrypted() {
        return vec![];
    }
    let ids = doc.get_pages();
    let mut out = vec![];
    for &p in pages.iter().take(PICTURES_MAX) {
        let Some(&id) = ids.get(&p) else { continue };
        let typed = letters(&doc.extract_text_with_limit(&[p], MAX_INFLATE).unwrap_or_default()) >= SPARSE;
        let stored = if typed { None } else { pictures::page_picture(&doc, id) };
        let small = |b: &[u8]| b.len() <= PICTURE_BYTES && png::size_of(b).is_some_and(|(w, h)| f64::from(w.max(h)) <= 2.0 * PICTURE_SIDE);
        let picked: Option<(String, Vec<u8>)> = match stored {
            Some((mime, b)) if small(&b) => Some((mime.to_string(), b)),
            other => {
                #[cfg(target_os = "macos")]
                let drawn = ocr::render_png(path, p, PICTURE_SIDE).ok().map(|b| ("image/png".to_string(), b));
                #[cfg(not(target_os = "macos"))]
                let drawn: Option<(String, Vec<u8>)> = None;
                drawn.or_else(|| other.filter(|(_, b)| b.len() <= PICTURE_BYTES).map(|(m, b)| (m.to_string(), b)))
            }
        };
        if let Some((mime, b)) = picked {
            out.push(PagePicture { page: p, mime, data: base64::engine::general_purpose::STANDARD.encode(b) });
        }
    }
    out
}

fn pictures_child(path: &Path) -> i32 {
    use std::io::Write;
    let pages: Vec<u32> = std::env::var(ocr::PAGES_ENV).unwrap_or_default().split(',').filter_map(|p| p.trim().parse().ok()).collect();
    let pics = page_pictures_here(path, &pages);
    let mut out = std::io::stdout().lock();
    if serde_json::to_writer(&mut out, &pics).is_ok() && out.flush().is_ok() { 0 } else { 1 }
}

/// [`page_pictures_here`] in a child process (the PDF is from the internet).
/// Nothing (never an error) when the pages can't be had.
pub fn page_pictures(reader: Option<&Path>, path: &Path, pages: &[u32]) -> Vec<PagePicture> {
    if pages.is_empty() {
        return vec![];
    }
    if in_process(reader) {
        return page_pictures_here(path, pages);
    }
    let Ok(exe) = reader_exe(reader) else { return vec![] };
    let list = pages.iter().take(PICTURES_MAX).map(u32::to_string).collect::<Vec<_>>().join(",");
    let cap = (PICTURES_MAX * PICTURE_BYTES * 2) as u64;
    run_child(&exe, &[(PICTURES_ENV, path.as_os_str()), (ocr::PAGES_ENV, list.as_ref())], PICTURES_TIMEOUT, cap)
        .ok()
        .and_then(|out| serde_json::from_slice(&out).ok())
        .unwrap_or_default()
}

/// A small, valid one-page PDF showing `text` (for tests).
#[cfg(test)]
pub fn test_pdf(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 72 712 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in offsets {
        pdf.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    pdf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdfs_text_is_read_and_junk_is_an_error_not_a_crash() {
        let text = pdf_text_here(&test_pdf("Chapter 1: Limits")).unwrap();
        assert!(text.contains("Chapter 1: Limits"), "{text}");
        assert!(text.starts_with("## Page 1"));
        assert!(pdf_text_here(b"%PDF-1.4 nothing else").is_err());
        assert!(pdf_text_here(b"").is_err());
    }

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phaethon-text-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pages_without_text_are_recognised_marked_or_explained() {
        let layer = "Printed heading and a paragraph with plenty of words in it";
        let l = |page: u32, text: &str, pictures: u32| Layer { page, text: text.into(), pictures };
        let pages = vec![l(1, layer, 2), l(2, "", 1), l(3, "", 0), l(4, "Fig. 2", 0), l(5, "", 0), l(6, "", 0), l(7, layer, 1)];
        let r = BTreeMap::from([
            (2, Page::Text("Binary search trees\nO(log n) lookups".into())),
            (3, Page::Failed("recognising its text took too long".into())),
            (4, Page::Text(String::new())),
            (5, Page::Text("  ".into())),
        ]);
        let md = assemble(&pages, &r, &Ok(()));
        assert!(md.starts_with(&format!("## Page 1\n\n{layer}\n\n(This page also shows 2 pictures (figures, diagrams or photos); they can’t be read as text.)\n\n")), "{md}");
        assert!(md.ends_with(&format!("## Page 7\n\n{layer}\n\n(This page also shows a picture (a figure, diagram or photo); it can’t be read as text.)")), "{md}");
        assert!(!md.contains("lookups\n\n(This page also"), "a scan’s picture is the page itself: {md}");
        assert!(md.contains("## Page 2 (recognised from handwriting or a scan; may contain mistakes)\n\nBinary search trees\nO(log n) lookups\n\n"), "{md}");
        assert!(md.contains("## Page 3\n\n(This page is handwriting or a scan, and its text couldn’t be recognised: recognising its text took too long.)"), "{md}");
        assert!(md.contains("## Page 4\n\nFig. 2\n\n"), "a little text beats nothing recognised: {md}");
        assert!(md.contains("## Page 5\n\n(No text was found on this page.)"), "{md}");
        assert!(md.contains("## Page 6\n\n(This page has no text, and only the first 300"), "{md}");
        // Where recognition isn't available the page says so in plain words.
        let md = assemble(&pages, &BTreeMap::new(), &Err("it needs the tesseract program".into()));
        assert!(md.contains("## Page 2\n\n(This page is handwriting or a scan, and its text can’t be recognised on this computer: it needs the tesseract program.)"), "{md}");
        assert!(md.contains("## Page 4\n\nFig. 2"), "{md}");
    }

    #[test]
    fn a_page_with_no_text_layer_is_recognised_here_or_explained_elsewhere() {
        let dir = temp("blank");
        let file = dir.join("blank.pdf");
        std::fs::write(&file, test_pdf("")).unwrap();
        let md = extract(&file).unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(md, "## Page 1\n\n(No text was found on this page.)");
        #[cfg(not(target_os = "macos"))]
        assert!(ocr::available() || md.contains(CANT_RECOGNISE), "{md}");
        // A PDF with text is read as before, nothing recognised.
        std::fs::write(&file, test_pdf("Chapter 1: Limits, continuity and the squeeze theorem")).unwrap();
        assert_eq!(extract(&file).unwrap(), "## Page 1\n\nChapter 1: Limits, continuity and the squeeze theorem");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn scanned_pages_and_pictures_get_their_text_recognised() {
        let dir = temp("scan");
        let printed = test_pdf("Chapter 1: Limits");
        let scan = dir.join("scan.pdf");
        std::fs::write(&scan, ocr::image_only_pdf(&printed, 150.0)).unwrap();
        let md = extract(&scan).unwrap();
        assert!(md.starts_with("## Page 1 (recognised from handwriting or a scan; may contain mistakes)\n\n"), "{md}");
        assert!(md.contains("Chapter 1: Limits"), "{md}");

        // A picture file (24-bit BMP, written by hand) of the same page.
        let (w, h, grey) = ocr::grey_pixels(&printed, 150.0);
        let row = (w * 3).div_ceil(4) * 4;
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&((54 + row * h) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0]);
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(h as i32).to_le_bytes());
        bmp.extend_from_slice(&[1, 0, 24, 0, 0, 0, 0, 0]);
        bmp.extend_from_slice(&((row * h) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 16]);
        for y in (0..h).rev() {
            let mut line: Vec<u8> = grey[y * w..(y + 1) * w].iter().flat_map(|&g| [g, g, g]).collect();
            line.resize(row, 0);
            bmp.extend_from_slice(&line);
        }
        let pic = dir.join("board.bmp");
        std::fs::write(&pic, bmp).unwrap();
        assert_eq!(kind_of(&pic), Doc::Picture);
        let md = extract(&pic).unwrap();
        assert!(md.starts_with("## Picture (recognised from handwriting or a scan; may contain mistakes)\n\n"), "{md}");
        assert!(md.contains("Chapter 1: Limits"), "{md}");
        std::fs::write(&pic, b"not a picture").unwrap();
        assert!(extract(&pic).unwrap().starts_with("(Any text in this picture couldn’t be recognised"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copies_missing_pages_are_made_again() {
        let dir = temp("stale");
        let md = dir.join("notes.pdf.md");
        assert!(copy_is_stale(&md), "no copy yet");
        let write = |s: &str| std::fs::write(&md, s).unwrap();
        write("# Text of notes.pdf\n\nCopied from…\n\n## Page 1\n\n\n\n## Page 2\n\nText\n");
        assert!(copy_is_stale(&md), "an empty page");
        write("# Text of notes.pdf\n\n## Page 1\n\nText\n\n## Page 2\n");
        assert!(copy_is_stale(&md), "an empty last page");
        write("# Text of scan.pdf\n\n(This file has no text in it: it may be scanned pages or pictures. Open the file itself to read it.)\n");
        assert!(copy_is_stale(&md), "the old note for a file with no text");
        write("# Text of notes.pdf\n\n## Page 1 (recognised from handwriting or a scan; may contain mistakes)\n\nTrees\n\n## Page 2\n\n(No text was found on this page.)\n");
        assert!(!copy_is_stale(&md));
        write(&format!("# Text of notes.pdf\n\n## Page 1\n\n{NO_OCR}\n"));
        assert_eq!(copy_is_stale(&md), ocr::available(), "made again once a computer can recognise it");
        write("# Text of notes.pdf\n\n## Page 1\n\n(This page is handwriting or a scan, and its text can’t be recognised on this computer: it needs tesseract.)\n");
        assert_eq!(copy_is_stale(&md), ocr::available());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_pptx_reads_slide_by_slide() {
        // Stored (uncompressed) zip with two slides.
        fn zip(files: &[(&str, &str)]) -> Vec<u8> {
            let mut out = vec![];
            let mut central = vec![];
            for (name, body) in files {
                let at = out.len() as u32;
                let crc = 0u32; // not checked by the reader
                let head = |sig: &[u8], central: bool| {
                    let mut h = sig.to_vec();
                    if central {
                        h.extend_from_slice(&[20, 0]);
                    }
                    h.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
                    h.extend_from_slice(&crc.to_le_bytes());
                    h.extend_from_slice(&(body.len() as u32).to_le_bytes());
                    h.extend_from_slice(&(body.len() as u32).to_le_bytes());
                    h.extend_from_slice(&(name.len() as u16).to_le_bytes());
                    h.extend_from_slice(&[0, 0]);
                    if central {
                        h.extend_from_slice(&[0; 10]); // comment length, disk, attributes
                        h.extend_from_slice(&at.to_le_bytes());
                    }
                    h.extend_from_slice(name.as_bytes());
                    h
                };
                out.extend(head(b"PK\x03\x04", false));
                out.extend_from_slice(body.as_bytes());
                central.extend(head(b"PK\x01\x02", true));
            }
            let cd = out.len() as u32;
            out.extend_from_slice(&central);
            out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
            out.extend_from_slice(&(files.len() as u16).to_le_bytes());
            out.extend_from_slice(&(files.len() as u16).to_le_bytes());
            out.extend_from_slice(&(central.len() as u32).to_le_bytes());
            out.extend_from_slice(&cd.to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out
        }
        let pptx = zip(&[
            ("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Limits &amp; continuity</a:t></a:r></a:p><a:p><a:r><a:t>Week 1</a:t></a:r></a:p></p:sld>"),
            ("ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>Derivatives</a:t></a:r></a:p></p:sld>"),
        ]);
        assert_eq!(pptx_text(&pptx).unwrap(), "## Slide 1\n\nLimits & continuity\nWeek 1\n\n## Slide 2\n\nDerivatives");
        assert!(pptx_text(b"not a zip").is_err());
    }
}
