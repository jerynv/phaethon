//! Text copies made by the real app binary as the child process: the PDF
//! reader for the text layer, then the recogniser for a page that is only a
//! picture (macOS). Unit tests read in-process, so only this proves the
//! children the importer starts.

use std::path::{Path, PathBuf};

use phaethon_lib::lms::text;

fn app() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_phaethon"))
}

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("phaethon-text-child-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A one-page PDF with `text` in its text layer.
fn text_pdf(text: &str) -> Vec<u8> {
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

#[test]
fn the_app_reads_a_pdfs_text_layer_in_a_child() {
    let dir = temp("layer");
    let file = dir.join("lecture.pdf");
    std::fs::write(&file, text_pdf("Week 3: Hash tables and their load factor")).unwrap();
    assert_eq!(text::extract_with(Some(app()), &file).unwrap(), "## Page 1\n\nWeek 3: Hash tables and their load factor");
    std::fs::write(&file, b"%PDF-1.4 broken").unwrap();
    assert!(text::extract_with(Some(app()), &file).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn the_app_recognises_a_scanned_page_in_a_child() {
    let dir = temp("scan");
    let file = dir.join("scan.pdf");
    std::fs::write(&file, text::ocr::image_only_pdf(&text_pdf("Week 3: Hash tables"), 150.0)).unwrap();
    let md = text::extract_with(Some(app()), &file).unwrap();
    assert!(md.starts_with("## Page 1 (recognised from handwriting or a scan; may contain mistakes)\n\n"), "{md}");
    assert!(md.contains("Week 3: Hash tables"), "{md}");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Recognise a real file and write its text copy body somewhere to look at:
/// `PHAETHON_OCR_SAMPLE=<file> PHAETHON_OCR_OUT=<file.md> cargo test --test text_child -- --ignored`.
#[test]
#[ignore]
fn a_real_file() {
    let (Some(sample), Some(out)) = (std::env::var_os("PHAETHON_OCR_SAMPLE"), std::env::var_os("PHAETHON_OCR_OUT")) else {
        panic!("set PHAETHON_OCR_SAMPLE and PHAETHON_OCR_OUT");
    };
    let started = std::time::Instant::now();
    let md = text::extract_with(Some(app()), Path::new(&sample)).unwrap();
    std::fs::write(&out, &md).unwrap();
    eprintln!("{} bytes in {:.1?}", md.len(), started.elapsed());
}
