//! Text recognition with the `tesseract` program, where there is no
//! recogniser built into the system (Linux and other Unix). Nothing leaves
//! the computer. A page's picture is taken from the PDF as it is stored
//! (pictures.rs: scans and photos), or drawn by poppler's `pdftoppm` when
//! that is installed (pages written with a pen in a tablet app); a page with
//! neither says what to install.
//!
//! Runs inside the recogniser child (ocr.rs), so a crash or a hang there is
//! the child's; each program it starts is killed after [`RUN_LIMIT`].

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::lms::text::pictures;

/// Longest one program (tesseract, pdftoppm) may run for one page.
const RUN_LIMIT: Duration = Duration::from_secs(80);
/// Most output read from one program.
const OUT_MAX: u64 = 64 * 1024 * 1024;
/// pdftoppm draws pages at this many dots per inch.
const DPI: &str = "300";

pub const INSTALL: &str = "reading handwriting and scans needs the free tesseract program: install it (for example “sudo apt install tesseract-ocr”, or “sudo dnf install tesseract”), then import the course again";

/// A program on PATH or in the usual places (an app started from a desktop
/// menu may have a short PATH).
pub fn find(name: &str) -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let usual = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"].map(PathBuf::from);
    on_path.into_iter().chain(usual).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Run `bin` with `args`, `input` on stdin; its stdout. Killed after [`RUN_LIMIT`].
fn run(bin: &Path, args: &[&std::ffi::OsStr], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let name = bin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = Command::new(bin)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{name} couldn’t start ({e})"))?;
    let feed = input.map(|b| b.to_vec()).zip(child.stdin.take()).map(|(bytes, mut stdin)| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })
    });
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut out).take(OUT_MAX).read_to_end(&mut buf);
        let _ = std::io::copy(&mut out, &mut std::io::sink());
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = (&mut err).take(4096).read_to_string(&mut s);
        let _ = std::io::copy(&mut err, &mut std::io::sink());
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() < RUN_LIMIT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} took too long"));
            }
        }
    };
    if let Some(f) = feed {
        let _ = f.join();
    }
    let out = reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let last = err.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it stopped");
        return Err(format!("{name}: {}", last.chars().take(160).collect::<String>()));
    }
    Ok(out)
}

/// The text tesseract recognises in a picture (PNG, JPEG, TIFF…), line by line.
pub fn recognise(tesseract: &Path, image: &[u8]) -> Result<String, String> {
    let out = run(tesseract, &["stdin".as_ref(), "stdout".as_ref()], Some(image))?;
    let text = String::from_utf8_lossy(&out);
    Ok(text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n"))
}

/// Page `n` (from 1) of the PDF at `path` drawn by pdftoppm, in grey, as a PNG.
pub fn draw_page(pdftoppm: &Path, path: &Path, n: u32) -> Result<Vec<u8>, String> {
    let n = n.to_string();
    let png = run(pdftoppm, &["-f".as_ref(), n.as_ref(), "-l".as_ref(), n.as_ref(), "-r".as_ref(), DPI.as_ref(), "-gray".as_ref(), "-png".as_ref(), path.as_os_str()], None)?;
    if png.starts_with(b"\x89PNG") { Ok(png) } else { Err("pdftoppm drew nothing".into()) }
}

/// Recognition is possible here: tesseract is installed. `Err` says what to install.
pub fn availability() -> Result<(), String> {
    find("tesseract").map(|_| ()).ok_or_else(|| INSTALL.to_string())
}

/// A PDF being recognised page by page.
pub struct Pdf {
    path: PathBuf,
    doc: lopdf::Document,
    tesseract: PathBuf,
    pdftoppm: Option<PathBuf>,
}

impl Pdf {
    pub fn open(path: &Path) -> Result<Self, String> {
        let tesseract = find("tesseract").ok_or_else(|| INSTALL.to_string())?;
        let bytes = std::fs::read(path).map_err(|e| format!("the file couldn’t be read ({e})"))?;
        let doc = lopdf::Document::load_mem(&bytes).map_err(|_| "it couldn’t be opened as a PDF".to_string())?;
        if doc.is_encrypted() {
            return Err("the PDF is password protected".into());
        }
        Ok(Pdf { path: path.to_path_buf(), doc, tesseract, pdftoppm: find("pdftoppm") })
    }

    /// The page's picture: as stored in the PDF, else drawn by pdftoppm.
    pub fn page_image(&self, n: u32) -> Result<Vec<u8>, String> {
        let pages = self.doc.get_pages();
        let id = *pages.get(&n).ok_or("there is no such page")?;
        if let Some((_, bytes)) = pictures::page_picture(&self.doc, id) {
            return Ok(bytes);
        }
        match &self.pdftoppm {
            Some(p) => draw_page(p, &self.path, n),
            None => Err("this page is drawn, not a stored picture, and drawing it needs poppler’s pdftoppm (for example “sudo apt install poppler-utils”)".into()),
        }
    }

    pub fn page_text(&self, n: u32) -> Result<String, String> {
        recognise(&self.tesseract, &self.page_image(n)?)
    }
}

/// The text of a picture file.
pub fn picture_text(path: &Path) -> Result<String, String> {
    let tesseract = find("tesseract").ok_or_else(|| INSTALL.to_string())?;
    let bytes = std::fs::read(path).map_err(|e| format!("it couldn’t be read ({e})"))?;
    recognise(&tesseract, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_that_fail_or_are_missing_say_so() {
        assert!(find("phaethon-no-such-program").is_none());
        let sh = Path::new("/bin/sh");
        assert_eq!(run(sh, &["-c".as_ref(), "cat".as_ref()], Some(b"page text")).unwrap(), b"page text");
        let e = run(sh, &["-c".as_ref(), "echo broken image >&2; exit 3".as_ref()], None).unwrap_err();
        assert_eq!(e, "sh: broken image");
        assert!(run(Path::new("/nonexistent/tesseract"), &[], None).unwrap_err().contains("couldn’t start"));
    }

    /// The Linux path, run wherever tesseract is installed (it is on the
    /// machine this was written on, through Homebrew): a page that is only a
    /// stored picture, read back.
    #[test]
    fn tesseract_reads_a_scanned_page_where_it_is_installed() {
        let Some(tesseract) = find("tesseract") else {
            eprintln!("tesseract isn’t installed here; skipped");
            return;
        };
        // A page with no text layer whose picture shows printed words.
        let Some((w, h, grey)) = crate::lms::text::ocr::test_text_pixels("Chapter 4 Hash tables") else {
            eprintln!("no way to draw test text here; skipped");
            return;
        };
        let png = crate::lms::text::png::encode(w as u32, h as u32, 1, &grey, false).unwrap();
        let text = recognise(&tesseract, &png).unwrap();
        assert!(text.contains("Hash tables"), "{text}");
        let pdf = crate::lms::text::pictures::tests::grey_pdf(w, h, &grey);
        let dir = std::env::temp_dir().join(format!("phaethon-tess-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("scan.pdf");
        std::fs::write(&file, pdf).unwrap();
        let doc = Pdf::open(&file).unwrap();
        assert!(doc.page_text(1).unwrap().contains("Hash tables"));
        assert!(doc.page_text(2).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
