//! Text recognition for pages that are pictures: handwritten notes, scans and
//! photos. On macOS it uses Apple's Vision on the device (nothing leaves the
//! computer); elsewhere it isn't available yet and the text copy says so.
//!
//! Recognition runs in a child process (this same program, started with
//! [`CHILD_ENV`]), like the PDF reader in text.rs: a crash there never takes
//! the app down. The child prints one JSON line per page as it finishes; the
//! parent kills it when a page takes longer than [`PAGE_TIMEOUT`] and starts
//! a new one for the pages left, until [`FILE_TIMEOUT`] runs out.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const CHILD_ENV: &str = "PHAETHON_OCR";
/// Which pages of the PDF to recognise ("1,3,4"); absent for a picture.
pub const PAGES_ENV: &str = "PHAETHON_OCR_PAGES";
pub const PAGE_TIMEOUT: Duration = Duration::from_secs(90);
pub const FILE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Most pages of one PDF recognised.
pub const MAX_PAGES: usize = 300;
/// Pages are drawn at about 300 dpi, the longest side at most this many pixels.
pub const MAX_SIDE: f64 = 4000.0;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const DPI: f64 = 300.0;
/// Most text kept from one page, in bytes.
const MAX_PAGE_TEXT: usize = 256 * 1024;

/// Recognition works on this computer.
pub const AVAILABLE: bool = cfg!(target_os = "macos");

/// Picture files a text copy is made for by recognising their text.
pub fn is_picture(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "heic" | "heif" | "tif" | "tiff" | "gif" | "webp" | "bmp")
}

/// What became of one page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Page {
    /// Recognised text, possibly empty (nothing written on it).
    Text(String),
    /// Why it couldn't be recognised, in plain words.
    Failed(String),
}

/// Recognise `pages` of the PDF at `file` (or, with `pages` = `None`, the
/// picture at `file`, reported as page 1) in a child process of `exe`.
pub fn recognise(exe: &Path, file: &Path, pages: Option<&[u32]>) -> BTreeMap<u32, Page> {
    let wanted: Vec<u32> = pages.map(|p| p.to_vec()).unwrap_or_else(|| vec![1]);
    let picture = pages.is_none();
    supervise(
        |left| {
            let mut c = Command::new(exe);
            c.env(CHILD_ENV, file);
            if !picture {
                c.env(PAGES_ENV, left.iter().map(u32::to_string).collect::<Vec<_>>().join(","));
            }
            c
        },
        &wanted,
        PAGE_TIMEOUT,
        FILE_TIMEOUT,
    )
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Line {
    page: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Run children made by `make` (given the pages still to do) until every page
/// has an answer: a page that takes longer than `page_limit`, or that the
/// child dies on, is marked failed and the next child starts after it.
pub(crate) fn supervise(make: impl Fn(&[u32]) -> Command, pages: &[u32], page_limit: Duration, file_limit: Duration) -> BTreeMap<u32, Page> {
    let started = Instant::now();
    let mut left: Vec<u32> = pages.to_vec();
    let mut out = BTreeMap::new();
    while !left.is_empty() {
        let Some(budget) = file_limit.checked_sub(started.elapsed()) else { break };
        let mut cmd = make(&left);
        let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
            Ok(c) => c,
            Err(e) => {
                let why = format!("text recognition couldn’t start ({e})");
                for p in left.drain(..) {
                    out.insert(p, Page::Failed(why.clone()));
                }
                break;
            }
        };
        let stdout = child.stdout.take().expect("piped");
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut r = BufReader::new(stdout.take((MAX_PAGES * MAX_PAGE_TEXT) as u64));
            let mut line = String::new();
            while r.read_line(&mut line).is_ok_and(|n| n > 0) {
                if tx.send(std::mem::take(&mut line)).is_err() {
                    break;
                }
            }
            let mut rest = r.into_inner().into_inner();
            let _ = std::io::copy(&mut rest, &mut std::io::sink());
        });
        let deadline = Instant::now() + budget;
        let mut why_stopped = None;
        loop {
            let wait = page_limit.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(wait) {
                Ok(raw) => {
                    let Ok(l) = serde_json::from_str::<Line>(raw.trim()) else { continue };
                    let Some(at) = left.iter().position(|&p| p == l.page) else { continue };
                    left.remove(at);
                    let page = match (l.text, l.error) {
                        (_, Some(e)) => Page::Failed(e),
                        (Some(t), None) => Page::Text(cap(t)),
                        (None, None) => Page::Text(String::new()),
                    };
                    out.insert(l.page, page);
                    if left.is_empty() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    why_stopped = Some("recognising its text took too long");
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    why_stopped = Some("text recognition stopped on it");
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        // Not joined: anything the child left running could hold the pipe open.
        // The reader ends once the pipe closes or its next line has nowhere to go.
        drop(reader);
        // The child works in order, so the page it stopped on is the first one left.
        if let Some(why) = why_stopped
            && !left.is_empty()
        {
            out.insert(left.remove(0), Page::Failed(why.into()));
        }
    }
    for p in left {
        out.insert(p, Page::Failed("there wasn’t time to recognise its text".into()));
    }
    out
}

/// The same as [`recognise`], in this process (tests: a test binary can't be the child).
#[cfg(test)]
pub(crate) fn recognise_here(file: &Path, pages: Option<&[u32]>) -> BTreeMap<u32, Page> {
    let wanted: Vec<u32> = pages.map(|p| p.to_vec()).unwrap_or_else(|| vec![1]);
    wanted
        .into_iter()
        .map(|p| {
            #[cfg(target_os = "macos")]
            let r = if pages.is_none() { picture_text(file) } else { page_text_here(file, p) };
            #[cfg(not(target_os = "macos"))]
            let r: Result<String, String> = Err(format!("no text recognition here ({})", file.display()));
            (p, r.map(Page::Text).unwrap_or_else(Page::Failed))
        })
        .collect()
}

fn cap(mut t: String) -> String {
    if t.len() > MAX_PAGE_TEXT {
        let mut cut = MAX_PAGE_TEXT;
        while !t.is_char_boundary(cut) {
            cut -= 1;
        }
        t.truncate(cut);
    }
    t
}

/// When started as the recogniser: recognise the file named by
/// [`CHILD_ENV`], one JSON line per page, and say how to exit.
pub fn child_main() -> Option<i32> {
    let path = std::env::var_os(CHILD_ENV)?;
    let pages: Option<Vec<u32>> = std::env::var(PAGES_ENV).ok().map(|s| s.split(',').filter_map(|p| p.trim().parse().ok()).collect());
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let mut emit = |page: u32, r: Result<String, String>| {
        let line = match r {
            Ok(t) => Line { page, text: Some(t), error: None },
            Err(e) => Line { page, text: None, error: Some(e) },
        };
        serde_json::to_string(&line).map(|s| writeln!(out, "{s}").and_then(|_| out.flush()).is_ok()).unwrap_or(false)
    };
    #[cfg(target_os = "macos")]
    {
        let path = Path::new(&path);
        match pages {
            None => {
                emit(1, mac::picture_text(path));
            }
            Some(pages) => match mac::Pdf::open(path) {
                Ok(pdf) => {
                    for p in pages {
                        if !emit(p, pdf.page_text(p)) {
                            return Some(1);
                        }
                    }
                }
                Err(e) => {
                    for p in pages {
                        emit(p, Err(e.clone()));
                    }
                }
            },
        }
        Some(0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        for p in pages.unwrap_or_else(|| vec![1]) {
            emit(p, Err("text recognition needs macOS for now".into()));
        }
        Some(0)
    }
}

#[cfg(target_os = "macos")]
pub use mac::{page_text_here, picture_text};

#[cfg(target_os = "macos")]
mod mac {
    use std::path::Path;
    use std::ptr;

    use objc2::AnyThread;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGInterpolationQuality, CGPDFBox,
        CGPDFDocument, CGPDFPage,
    };
    use objc2_foundation::{NSArray, NSDictionary};
    use objc2_image_io::{
        CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize,
    };
    use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

    use super::{DPI, MAX_SIDE};

    pub struct Pdf(CFRetained<CGPDFDocument>);

    impl Pdf {
        pub fn open(path: &Path) -> Result<Self, String> {
            let url = CFURL::from_file_path(path).ok_or("the file couldn’t be found")?;
            let doc = CGPDFDocument::with_url(Some(&url)).ok_or("it couldn’t be opened as a PDF")?;
            if CGPDFDocument::is_encrypted(Some(&doc)) && !CGPDFDocument::is_unlocked(Some(&doc)) {
                return Err("the PDF is password protected".into());
            }
            Ok(Self(doc))
        }

        pub fn page_text(&self, n: u32) -> Result<String, String> {
            autoreleasepool(|_| {
                let image = render(&self.0, n as usize).ok_or("the page couldn’t be drawn")?;
                recognise(&image)
            })
        }
    }

    /// Draw page `n` (from 1) in shades of grey at about 300 dpi, white behind it.
    pub(super) fn render(doc: &CGPDFDocument, n: usize) -> Option<CFRetained<CGImage>> {
        if n == 0 || n > CGPDFDocument::number_of_pages(Some(doc)) {
            return None;
        }
        let page = CGPDFDocument::page(Some(doc), n)?;
        let page = Some(&*page);
        let crop = CGPDFPage::box_rect(page, CGPDFBox::CropBox);
        let turned = CGPDFPage::rotation_angle(page).rem_euclid(180) == 90;
        let (pw, ph) = if turned { (crop.size.height, crop.size.width) } else { (crop.size.width, crop.size.height) };
        if !(pw > 0.0 && ph > 0.0) {
            return None;
        }
        let scale = (DPI / 72.0).min(MAX_SIDE / pw.max(ph));
        let (w, h) = (((pw * scale).round() as usize).max(1), ((ph * scale).round() as usize).max(1));
        let grey = CGColorSpace::new_device_gray()?;
        // SAFETY: a null buffer asks Core Graphics to allocate one itself.
        let ctx = unsafe { CGBitmapContextCreate(ptr::null_mut(), w, h, 8, 0, Some(&grey), CGImageAlphaInfo::None.0) }?;
        let c = Some(&*ctx);
        CGContext::set_gray_fill_color(c, 1.0, 1.0);
        CGContext::fill_rect(c, CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)));
        CGContext::set_interpolation_quality(c, CGInterpolationQuality::High);
        CGContext::scale_ctm(c, w as f64 / pw, h as f64 / ph);
        // Never scales up, so it is asked for the page's own size, after the scale above.
        let fit = CGPDFPage::drawing_transform(page, CGPDFBox::CropBox, CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(pw, ph)), 0, true);
        CGContext::concat_ctm(c, fit);
        CGContext::draw_pdf_page(c, page);
        CGBitmapContextCreateImage(c)
    }

    /// The text of a picture file (PNG, JPEG, HEIC…), turned upright as the
    /// camera says and no bigger than [`MAX_SIDE`].
    pub fn picture_text(path: &Path) -> Result<String, String> {
        autoreleasepool(|_| {
            let url = CFURL::from_file_path(path).ok_or("the file couldn’t be found")?;
            // SAFETY: plain ImageIO calls with a valid URL and a dictionary of the documented keys and value types.
            let image = unsafe {
                let source = CGImageSource::with_url(&url, None).ok_or("it couldn’t be read as a picture")?;
                let keys: [&CFString; 3] =
                    [kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize];
                let side = CFNumber::new_i32(MAX_SIDE as i32);
                let values: [&CFType; 3] = [CFBoolean::new(true).as_ref(), CFBoolean::new(true).as_ref(), side.as_ref()];
                let opts = CFDictionary::from_slices(&keys, &values);
                source.thumbnail_at_index(0, Some(opts.as_opaque())).ok_or("it couldn’t be read as a picture")?
            };
            recognise(&image)
        })
    }

    /// Vision's most accurate text recognition, with language correction
    /// (it reads handwriting at this level), line by line in reading order.
    pub(super) fn recognise(image: &CGImage) -> Result<String, String> {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        // SAFETY: an empty options dictionary is valid.
        let handler = unsafe { VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), image, &NSDictionary::new()) };
        let as_request: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
        handler.performRequests_error(&NSArray::from_retained_slice(&[as_request])).map_err(|e| format!("text recognition failed ({})", e.localizedDescription()))?;
        let mut lines = vec![];
        for obs in request.results().map(|r| r.to_vec()).unwrap_or_default() {
            if let Some(best) = obs.topCandidates(1).firstObject() {
                lines.push(best.string().to_string());
            }
        }
        Ok(lines.join("\n"))
    }

    /// The text of page `n` of a PDF, in this process (tests and the child).
    pub fn page_text_here(path: &Path, n: u32) -> Result<String, String> {
        Pdf::open(path)?.page_text(n)
    }

    /// A one-page PDF that is only a picture: page 1 of `pdf` drawn to grey
    /// pixels at `dpi` and put back as an image, so it has no text layer.
    /// For tests (here and tests/ocr_child.rs).
    #[doc(hidden)]
    pub fn image_only_pdf(pdf: &[u8], dpi: f64) -> Vec<u8> {
        let (w, h, pixels) = grey_pixels(pdf, dpi);
        let (pw, ph) = (w as f64 * 72.0 / dpi, h as f64 * 72.0 / dpi);
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&pixels, 6);
        let content = format!("q {pw} 0 0 {ph} 0 0 cm /Im1 Do Q");
        let mut objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>").into_bytes(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).into_bytes(),
        ];
        let mut image = format!(
            "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {} >>\nstream\n",
            packed.len()
        )
        .into_bytes();
        image.extend_from_slice(&packed);
        image.extend_from_slice(b"\nendstream");
        objects.push(image);
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![];
        for (i, o) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(o);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
        out
    }

    /// Page 1 of `pdf` as grey pixels at `dpi`: (width, height, one byte per
    /// pixel, rows top to bottom). For tests.
    #[doc(hidden)]
    pub fn grey_pixels(pdf: &[u8], dpi: f64) -> (usize, usize, Vec<u8>) {
        use objc2_core_foundation::CFData;
        use objc2_core_graphics::{CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGDataProvider};
        let data = CFData::from_bytes(pdf);
        let provider = CGDataProvider::with_cf_data(Some(&data)).expect("provider");
        let doc = CGPDFDocument::with_provider(Some(&provider)).expect("a pdf");
        let page = CGPDFDocument::page(Some(&doc), 1).expect("page 1");
        let media = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox);
        let (pw, ph) = (media.size.width, media.size.height);
        let (w, h) = ((pw * dpi / 72.0) as usize, (ph * dpi / 72.0) as usize);
        let grey = CGColorSpace::new_device_gray().unwrap();
        // SAFETY: Core Graphics allocates the buffer; it is read below while `ctx` lives.
        let ctx = unsafe { CGBitmapContextCreate(ptr::null_mut(), w, h, 8, 0, Some(&grey), CGImageAlphaInfo::None.0) }.unwrap();
        let c = Some(&*ctx);
        CGContext::set_gray_fill_color(c, 1.0, 1.0);
        CGContext::fill_rect(c, CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)));
        CGContext::scale_ctm(c, dpi / 72.0, dpi / 72.0);
        CGContext::draw_pdf_page(c, Some(&page));
        let stride = CGBitmapContextGetBytesPerRow(c);
        // SAFETY: the context's own buffer, `stride * h` bytes, alive while `ctx` is.
        let buf = unsafe { std::slice::from_raw_parts(CGBitmapContextGetData(c) as *const u8, stride * h) };
        let mut pixels = Vec::with_capacity(w * h);
        for row in buf.chunks(stride) {
            pixels.extend_from_slice(&row[..w]);
        }
        (w, h, pixels)
    }
}

#[cfg(target_os = "macos")]
#[doc(hidden)]
pub use mac::{grey_pixels, image_only_pdf};

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> impl Fn(&[u32]) -> Command + '_ {
        move |left: &[u32]| {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", script, "sh"]).args(left.iter().map(u32::to_string));
            c
        }
    }

    #[test]
    fn every_page_answered_once() {
        let r = supervise(sh(r#"for p in "$@"; do echo "{\"page\":$p,\"text\":\"page $p\"}"; done"#), &[2, 5], Duration::from_secs(5), Duration::from_secs(20));
        assert_eq!(r[&2], Page::Text("page 2".into()));
        assert_eq!(r[&5], Page::Text("page 5".into()));
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn a_slow_page_is_given_up_and_the_rest_still_done() {
        // Page 3 hangs; every new child starts after the page given up.
        let script = r#"for p in "$@"; do if [ "$p" = 3 ]; then sleep 30; fi; echo "{\"page\":$p,\"text\":\"ok $p\"}"; done"#;
        let started = Instant::now();
        let r = supervise(sh(script), &[1, 3, 4], Duration::from_millis(700), Duration::from_secs(20));
        assert_eq!(r[&1], Page::Text("ok 1".into()));
        assert_eq!(r[&3], Page::Failed("recognising its text took too long".into()));
        assert_eq!(r[&4], Page::Text("ok 4".into()));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_crash_marks_that_page_and_the_file_limit_ends_it() {
        let crash = r#"for p in "$@"; do if [ "$p" = 2 ]; then kill -9 $$; fi; echo "{\"page\":$p,\"text\":\"\"}"; done"#;
        let r = supervise(sh(crash), &[1, 2, 3], Duration::from_secs(5), Duration::from_secs(20));
        assert_eq!(r[&1], Page::Text(String::new()));
        assert_eq!(r[&2], Page::Failed("text recognition stopped on it".into()));
        assert_eq!(r[&3], Page::Text(String::new()));

        let started = Instant::now();
        let r = supervise(sh("sleep 30"), &[1, 2], Duration::from_secs(5), Duration::from_millis(600));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(matches!(&r[&1], Page::Failed(_)) && matches!(&r[&2], Page::Failed(_)), "{r:?}");

        let r = supervise(|_: &[u32]| Command::new("/nonexistent/recogniser"), &[7], Duration::from_secs(1), Duration::from_secs(1));
        assert!(matches!(&r[&7], Page::Failed(e) if e.contains("couldn’t start")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn printed_text_in_a_picture_only_page_is_recognised() {
        let pdf = image_only_pdf(&crate::lms::text::test_pdf("Chapter 1: Limits"), 150.0);
        // No text layer at all.
        let layer = crate::lms::text::pdf_text_here(&pdf).unwrap();
        assert!(!layer.contains("Limits"), "{layer}");
        let dir = std::env::temp_dir().join(format!("phaethon-ocr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("scan.pdf");
        std::fs::write(&file, &pdf).unwrap();
        let text = page_text_here(&file, 1).unwrap();
        assert!(text.contains("Chapter 1: Limits"), "{text}");
        assert!(page_text_here(&file, 2).is_err());
        assert!(page_text_here(&dir.join("missing.pdf"), 1).is_err());
        std::fs::write(dir.join("junk.pdf"), b"%PDF-1.4 nothing").unwrap();
        assert!(page_text_here(&dir.join("junk.pdf"), 1).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
