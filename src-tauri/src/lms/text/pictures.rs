//! The pictures a PDF page shows besides its text, in pure Rust (any OS).
//!
//! A page's pictures are the images its content stream actually draws: image
//! XObjects named by `Do` (also inside form XObjects, a few levels deep) and
//! inline images, each counted once. Resources shared by every page (some
//! PDFs keep all their images on the page tree) don't count for a page that
//! never draws them. Icons, bullets and rules are too small to count.
//!
//! [`page_picture`] gives a page's main picture as a file a model or text
//! recognition can read, without rendering: a JPEG as it is stored, or grey
//! and RGB pixels as a PNG. Pages drawn with vector strokes (handwriting
//! from a tablet app) have no such picture; on macOS they are rendered
//! instead (ocr.rs).
//!
//! Only ever called on a PDF from the internet inside a child process (see
//! text.rs), with every stream's inflated size bounded.

use std::collections::HashSet;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};

/// A picture smaller than this on either side, or with fewer pixels, is
/// decoration (a logo, a bullet, a rule), not content.
const MIN_SIDE: i64 = 48;
const MIN_PIXELS: i64 = 40_000;
/// Form XObjects followed this deep.
const FORM_DEPTH: usize = 3;
/// Most bytes a page's (or form's) content may inflate to.
const MAX_CONTENT: usize = 64 * 1024 * 1024;
/// Largest picture inflated to pixels.
const MAX_PIXELS_BYTES: usize = 96 * 1024 * 1024;

/// One picture drawn on a page.
#[derive(Debug, Clone, PartialEq)]
pub struct Pic {
    /// The image XObject; `None` for an inline image.
    pub id: Option<ObjectId>,
    pub width: i64,
    pub height: i64,
}

impl Pic {
    pub fn counts(&self) -> bool {
        self.width >= MIN_SIDE && self.height >= MIN_SIDE && self.width * self.height >= MIN_PIXELS
    }
}

fn deref<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Object> {
    doc.dereference(o).ok().map(|(_, o)| o)
}

fn dict_of<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    deref(doc, o)?.as_dict().ok()
}

/// The XObject dictionaries a page's names are looked up in: its own
/// Resources, then those it inherits from the page tree.
fn page_xobjects(doc: &Document, page: ObjectId) -> Vec<&Dictionary> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut node = doc.get_dictionary(page).ok();
    // Up the page tree (written directly or by reference), never round a loop.
    while let Some(d) = node {
        if let Some(x) = d.get(b"Resources").ok().and_then(|r| dict_of(doc, r)).and_then(|r| r.get(b"XObject").ok()).and_then(|x| dict_of(doc, x)) {
            out.push(x);
        }
        node = d.get(b"Parent").ok().and_then(|p| p.as_reference().ok()).filter(|id| seen.insert(*id) && seen.len() < 64).and_then(|id| doc.get_dictionary(id).ok());
    }
    out
}

fn int(doc: &Document, d: &Dictionary, k: &[u8]) -> Option<i64> {
    d.get(k).ok().and_then(|o| deref(doc, o)).and_then(|o| o.as_i64().ok().or_else(|| o.as_float().ok().map(|f| f as i64)))
}

/// Pictures drawn by `content` with names from `xobjects`, into `out`.
fn walk(doc: &Document, content: &[u8], xobjects: &[&Dictionary], depth: usize, seen: &mut HashSet<ObjectId>, out: &mut Vec<Pic>) {
    let Ok(ops) = Content::decode(content) else { return };
    for op in ops.operations {
        match op.operator.as_str() {
            "Do" => {
                let Some(name) = op.operands.first().and_then(|o| o.as_name().ok()) else { continue };
                let Some(target) = xobjects.iter().find_map(|x| x.get(name).ok()) else { continue };
                let Ok(id) = target.as_reference() else { continue };
                if !seen.insert(id) {
                    continue;
                }
                let Some(stream) = doc.get_object(id).ok().and_then(|o| o.as_stream().ok()) else { continue };
                let d = &stream.dict;
                match d.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) {
                    Some(b"Image") => out.push(Pic { id: Some(id), width: int(doc, d, b"Width").unwrap_or(0), height: int(doc, d, b"Height").unwrap_or(0) }),
                    Some(b"Form") if depth < FORM_DEPTH => {
                        let Ok(inner) = stream.decompressed_content_with_limit(MAX_CONTENT).or_else(|_| {
                            // An unfiltered form's content is its stream as it is.
                            if stream.dict.get(b"Filter").is_err() { Ok(stream.content.clone()) } else { Err(()) }
                        }) else {
                            continue;
                        };
                        let own = d.get(b"Resources").ok().and_then(|r| dict_of(doc, r)).and_then(|r| r.get(b"XObject").ok()).and_then(|x| dict_of(doc, x));
                        let names: Vec<&Dictionary> = own.into_iter().chain(xobjects.iter().copied()).collect();
                        walk(doc, &inner, &names, depth + 1, seen, out);
                    }
                    _ => {}
                }
            }
            "BI" => {
                let Some(s) = op.operands.first().and_then(|o| o.as_stream().ok()) else { continue };
                let w = int(doc, &s.dict, b"W").or_else(|| int(doc, &s.dict, b"Width")).unwrap_or(0);
                let h = int(doc, &s.dict, b"H").or_else(|| int(doc, &s.dict, b"Height")).unwrap_or(0);
                out.push(Pic { id: None, width: w, height: h });
            }
            _ => {}
        }
    }
}

/// Every picture page `page` draws (decoration included; see [`Pic::counts`]).
pub fn page_pictures(doc: &Document, page: ObjectId) -> Vec<Pic> {
    let Ok(content) = doc.get_page_content_with_limit(page, MAX_CONTENT) else { return vec![] };
    let xobjects = page_xobjects(doc, page);
    let mut out = vec![];
    walk(doc, &content, &xobjects, 0, &mut HashSet::new(), &mut out);
    out
}

/// How many pictures page `page` shows that count as content.
pub fn count(doc: &Document, page: ObjectId) -> u32 {
    page_pictures(doc, page).iter().filter(|p| p.counts()).count() as u32
}

/// The page's width and height in points (its MediaBox, maybe inherited).
fn page_size(doc: &Document, page: ObjectId) -> Option<(f64, f64)> {
    let mut id = page;
    for _ in 0..16 {
        let d = doc.get_dictionary(id).ok()?;
        if let Some(b) = d.get(b"MediaBox").ok().and_then(|b| deref(doc, b)).and_then(|b| b.as_array().ok()) {
            let n: Vec<f64> = b.iter().filter_map(|x| deref(doc, x)).filter_map(|x| x.as_float().ok().map(f64::from).or_else(|| x.as_i64().ok().map(|i| i as f64))).collect();
            return (n.len() == 4).then(|| ((n[2] - n[0]).abs(), (n[3] - n[1]).abs())).filter(|(w, h)| *w > 0.0 && *h > 0.0);
        }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// [`count`] for a page that has text of its own: a picture the size and
/// shape of the whole page there is a scan under a text layer someone
/// recognised already, not a figure, so it isn't counted.
pub fn content_count(doc: &Document, page: ObjectId, has_text: bool) -> u32 {
    let pics = page_pictures(doc, page);
    let size = if has_text { page_size(doc, page) } else { None };
    let scan_under_text = |p: &Pic| {
        size.is_some_and(|(w, h)| {
            let (pw, ph) = (p.width as f64, p.height as f64);
            pw.min(ph) >= 900.0 && ((pw / ph) - (w / h)).abs() <= 0.08 * (w / h)
        })
    };
    pics.iter().filter(|p| p.counts() && !scan_under_text(p)).count() as u32
}

fn names(doc: &Document, o: Option<&Object>) -> Vec<Vec<u8>> {
    match o.and_then(|o| deref(doc, o)) {
        Some(Object::Name(n)) => vec![n.clone()],
        Some(Object::Array(a)) => a.iter().filter_map(|x| deref(doc, x).and_then(|x| x.as_name().ok()).map(<[u8]>::to_vec)).collect(),
        _ => vec![],
    }
}

/// Channels of a colour space a picture can be handed on in: grey 1, RGB 3.
fn channels(doc: &Document, cs: Option<&Object>) -> Option<u8> {
    let cs = deref(doc, cs?)?;
    let name = match cs {
        Object::Name(n) => n.clone(),
        Object::Array(a) => {
            let first = a.first().and_then(|x| x.as_name().ok())?;
            if first == b"ICCBased" {
                let n = a.get(1).and_then(|s| deref(doc, s)).and_then(|s| s.as_stream().ok()).and_then(|s| int(doc, &s.dict, b"N"))?;
                return match n {
                    1 => Some(1),
                    3 => Some(3),
                    _ => None,
                };
            }
            first.to_vec()
        }
        _ => return None,
    };
    match name.as_slice() {
        b"DeviceGray" | b"CalGray" | b"G" => Some(1),
        b"DeviceRGB" | b"CalRGB" | b"RGB" => Some(3),
        _ => None,
    }
}

/// A page's main picture (its largest that counts) as a file: (`image/jpeg`
/// or `image/png`, the bytes). `None` when it has none, or its picture is
/// stored in a way handed on only after rendering (CMYK, JPEG 2000, fax
/// compression, a palette, a mask).
pub fn page_picture(doc: &Document, page: ObjectId) -> Option<(&'static str, Vec<u8>)> {
    let best = page_pictures(doc, page).into_iter().filter(|p| p.counts() && p.id.is_some()).max_by_key(|p| p.width * p.height)?;
    let stream = doc.get_object(best.id?).ok()?.as_stream().ok()?;
    let d = &stream.dict;
    if d.get(b"ImageMask").ok().and_then(|m| m.as_bool().ok()) == Some(true) {
        return None;
    }
    let filters = names(doc, d.get(b"Filter").ok());
    let ch = channels(doc, d.get(b"ColorSpace").ok());
    let bpc = int(doc, d, b"BitsPerComponent").unwrap_or(8);
    match filters.as_slice() {
        [f] if f == b"DCTDecode" || f == b"DCT" => {
            // A JPEG as stored, unless its colours are CMYK (most viewers and models get those wrong).
            if ch.is_none() && d.get(b"ColorSpace").is_ok() {
                return None;
            }
            stream.content.starts_with(&[0xff, 0xd8]).then(|| ("image/jpeg", stream.content.clone()))
        }
        [] | [_] if bpc == 8 => {
            let ch = ch?;
            if !filters.is_empty() && filters[0] != b"FlateDecode" && filters[0] != b"Fl" {
                return None;
            }
            let (w, h) = (u32::try_from(best.width).ok()?, u32::try_from(best.height).ok()?);
            let need = (w as usize).checked_mul(h as usize)?.checked_mul(ch as usize)?;
            if need > MAX_PIXELS_BYTES {
                return None;
            }
            // PNG predictors (10 and up) leave each row led by its PNG filter byte: kept as they are.
            let parms = d.get(b"DecodeParms").ok().and_then(|p| dict_of(doc, p));
            let predictor = parms.and_then(|p| int(doc, p, b"Predictor")).unwrap_or(1);
            let raw = if filters.is_empty() {
                stream.content.clone()
            } else {
                miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&stream.content, need + h as usize + 1024).ok()?
            };
            match predictor {
                1 => super::png::encode(w, h, ch, &raw, false).map(|p| ("image/png", p)),
                10..=15 => super::png::encode(w, h, ch, &raw, true).map(|p| ("image/png", p)),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A PDF from `objects` (numbered from 1; the catalog first), with an xref.
    pub fn pdf(objects: &[Vec<u8>]) -> Vec<u8> {
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

    /// A one-page PDF that is only a stored grey picture, `w`×`h` pixels, no text layer.
    pub fn grey_pdf(w: usize, h: usize, grey: &[u8]) -> Vec<u8> {
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(grey, 6);
        let (pw, ph) = (w as f64 * 72.0 / 150.0, h as f64 * 72.0 / 150.0);
        let content = format!("q {pw} 0 0 {ph} 0 0 cm /Im1 Do Q");
        pdf(&[
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>").into_bytes(),
            stream("", content.as_bytes()),
            stream(&format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"), &packed),
        ])
    }

    fn stream(dict: &str, body: &[u8]) -> Vec<u8> {
        let mut s = format!("<< {dict} /Length {} >>\nstream\n", body.len()).into_bytes();
        s.extend_from_slice(body);
        s.extend_from_slice(b"\nendstream");
        s
    }

    /// Two pages, typed text on both. Page 1 draws a 300×200 grey picture (through
    /// a form) and a 16×16 icon; page 2 draws nothing although every picture is in
    /// the page tree's shared resources. A third page draws a JPEG and an inline image.
    pub fn sample() -> Vec<u8> {
        let grey: Vec<u8> = (0..300 * 200).map(|i| (i % 251) as u8).collect();
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&grey, 6);
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 144, 1, 44, 3, 0, 0, 0, 0xff, 0xd9];
        let text = "BT /F1 12 Tf 72 712 Td (A typed paragraph with plenty of words on it.) Tj ET";
        let p1 = format!("{text} q 300 0 0 200 72 300 cm /Fm1 Do Q q 16 0 0 16 10 10 cm /Icon Do Q /Icon Do");
        let p2 = text.to_string();
        let p3 = format!("{text} q 400 0 0 300 0 0 cm /Photo Do Q BI /W 200 /H 200 /BPC 8 /CS /Gray ID {} EI", "x".repeat(200 * 200));
        pdf(&[
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /Resources << /Font << /F1 9 0 R >> /XObject << /Fm1 10 0 R /Icon 11 0 R /Pic 12 0 R /Photo 13 0 R >> >> >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R >>".to_vec(),
            stream("", p1.as_bytes()),
            stream("", p2.as_bytes()),
            stream("", p3.as_bytes()),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
            stream("/Type /XObject /Subtype /Form /BBox [0 0 1 1]", b"/Pic Do"),
            stream("/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8", &[0u8; 256]),
            stream("/Type /XObject /Subtype /Image /Width 300 /Height 200 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", &packed),
            stream("/Type /XObject /Subtype /Image /Width 300 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", &jpeg),
        ])
    }

    #[test]
    fn pictures_a_page_draws_are_found_and_shared_ones_it_doesnt_draw_arent() {
        let doc = Document::load_mem(&sample()).unwrap();
        let pages = doc.get_pages();
        let p1 = page_pictures(&doc, pages[&1]);
        assert_eq!(p1.len(), 2, "the picture inside the form, and the icon once: {p1:?}");
        assert_eq!(count(&doc, pages[&1]), 1, "the icon is decoration");
        assert_eq!(count(&doc, pages[&2]), 0, "page 2 draws nothing");
        assert_eq!(count(&doc, pages[&3]), 2, "a JPEG and an inline image");
        assert_eq!(content_count(&doc, pages[&1], true), 1);
        assert_eq!(content_count(&doc, pages[&3], true), 2, "300×400 is no page-sized scan");

        let (mime, png) = page_picture(&doc, pages[&1]).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(super::super::png::size_of(&png), Some((300, 200)));
        let (mime, jpeg) = page_picture(&doc, pages[&3]).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        assert!(page_picture(&doc, pages[&2]).is_none());
    }
}
