//! Text copies of course documents (PDF, Word, PowerPoint), so the agent can
//! read the actual material. Pure Rust.
//!
//! PDFs are read in a child process (this same program, started with
//! [`CHILD_ENV`]): a PDF from the internet can be malformed in ways that make a
//! parser panic or spin, and the app is built to abort on panic. The child is
//! killed after [`PDF_TIMEOUT`] and its output is capped.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::attachments;

pub const CHILD_ENV: &str = "PHAETHON_PDF_TEXT";
const PDF_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest text copy kept, in bytes.
pub const MAX_TEXT: usize = 8 * 1024 * 1024;
/// Most bytes a PDF's streams may inflate to while reading it.
const MAX_INFLATE: usize = 512 * 1024 * 1024;
/// Largest Office part read (one slide's XML, a document's body).
const MAX_PART: usize = 64 * 1024 * 1024;
const MAX_SLIDES: usize = 1000;

/// What kind of document a file is, by its first bytes (and, for zip-based
/// Office files, by what the zip holds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Doc {
    Pdf,
    Docx,
    Pptx,
    Other,
}

pub fn kind_of(path: &Path) -> Doc {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => Doc::Pdf,
        "docx" => Doc::Docx,
        "pptx" => Doc::Pptx,
        _ => Doc::Other,
    }
}

/// The text of the document at `path`, or why there is none. `Ok("")` for a
/// document with no text (a scanned PDF).
pub fn extract(path: &Path) -> Result<String, String> {
    match kind_of(path) {
        Doc::Pdf => pdf_text(path),
        Doc::Docx => {
            let bytes = read_capped(path)?;
            attachments::docx_text(&bytes)
        }
        Doc::Pptx => {
            let bytes = read_capped(path)?;
            pptx_text(&bytes)
        }
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

/// The text of a PDF, read in the same process. Only the child (and tests) call this.
pub fn pdf_text_here(bytes: &[u8]) -> Result<String, String> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| format!("it couldn’t be read as a PDF ({e})"))?;
    if doc.is_encrypted() {
        return Err("the PDF is password protected".into());
    }
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let mut out = String::new();
    for p in pages {
        // Page by page, so one unreadable page doesn't lose the rest.
        if let Ok(t) = doc.extract_text_with_limit(&[p], MAX_INFLATE) {
            let t = t.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
            out.push_str(&format!("## Page {p}\n\n{}\n\n", t.trim()));
        }
        if out.len() > MAX_TEXT {
            break;
        }
    }
    Ok(out.trim_end().to_string())
}

/// First thing the app does: when started as the PDF reader, read the PDF
/// named by [`CHILD_ENV`], print its text and say how to exit.
pub fn child_main() -> Option<i32> {
    let path = std::env::var_os(CHILD_ENV)?;
    let code = match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| pdf_text_here(&b)) {
        Ok(text) => {
            use std::io::Write;
            let mut out = std::io::stdout().lock();
            if out.write_all(text.as_bytes()).is_ok() { 0 } else { 1 }
        }
        Err(e) => {
            eprintln!("{e}");
            2
        }
    };
    Some(code)
}

fn pdf_text(path: &Path) -> Result<String, String> {
    if cfg!(test) {
        // The test binary is not the app, so it can't be the child.
        return pdf_text_here(&read_capped(path)?);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe)
        .env(CHILD_ENV, path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn’t start the PDF reader: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(MAX_TEXT as u64 + 1).read_to_end(&mut buf);
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
            Ok(None) if started.elapsed() < PDF_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
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
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if text.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Ok(text)
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
