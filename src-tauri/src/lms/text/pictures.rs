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

/// A picture drawn over less than this share of its page is decoration (an
/// icon, a logo in a corner), whatever its pixels.
const MIN_PAGE_SHARE: f64 = 0.02;
/// A picture drawn over at least this share of a page with text of its own
/// is what the text sits on (a slide's background, a scan under a text
/// layer someone recognised already), not a figure.
const BACKDROP_SHARE: f64 = 0.85;

/// One picture drawn on a page.
#[derive(Debug, Clone, PartialEq)]
pub struct Pic {
    /// The image XObject; `None` for an inline image.
    pub id: Option<ObjectId>,
    pub width: i64,
    pub height: i64,
    /// Where it is drawn, in the page's points: [left, bottom, right, top].
    pub drawn: [f64; 4],
    /// Its stored bytes, hashed: the same picture drawn again (by the same
    /// object or a copy of it) hashes the same.
    pub hash: u64,
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m` then `ctm`, as PDF's `cm` concatenates.
fn concat(m: &Matrix, c: &Matrix) -> Matrix {
    [
        m[0] * c[0] + m[1] * c[2],
        m[0] * c[1] + m[1] * c[3],
        m[2] * c[0] + m[3] * c[2],
        m[2] * c[1] + m[3] * c[3],
        m[4] * c[0] + m[5] * c[2] + c[4],
        m[4] * c[1] + m[5] * c[3] + c[5],
    ]
}

/// The box the unit square (where an image is drawn) covers under `m`.
fn unit_box(m: &Matrix) -> [f64; 4] {
    let pts = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    let xs = pts.map(|p| p.0);
    let ys = pts.map(|p| p.1);
    let min = |a: [f64; 4]| a.into_iter().fold(f64::INFINITY, f64::min);
    let max = |a: [f64; 4]| a.into_iter().fold(f64::NEG_INFINITY, f64::max);
    [min(xs), min(ys), max(xs), max(ys)]
}

fn matrix_of(ops: &[Object]) -> Option<Matrix> {
    let n: Vec<f64> = ops.iter().filter_map(|o| o.as_float().ok().map(f64::from)).collect();
    (n.len() == 6 && n.iter().all(|x| x.is_finite())).then(|| [n[0], n[1], n[2], n[3], n[4], n[5]])
}

fn hash_of(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::hash::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

impl Pic {
    pub fn counts(&self) -> bool {
        self.width >= MIN_SIDE && self.height >= MIN_SIDE && self.width * self.height >= MIN_PIXELS
    }

    /// The share of a `w`×`h` page it is drawn over (the part on the page).
    fn page_share(&self, (w, h): (f64, f64)) -> f64 {
        let clip = |lo: f64, hi: f64, max: f64| (hi.min(max) - lo.max(0.0)).max(0.0);
        clip(self.drawn[0], self.drawn[2], w) * clip(self.drawn[1], self.drawn[3], h) / (w * h)
    }

    /// Drawn in the same place as `other`, give or take 2% of the page.
    fn same_place(&self, other: &Pic, (w, h): (f64, f64)) -> bool {
        (0..4).all(|i| (self.drawn[i] - other.drawn[i]).abs() <= 0.02 * if i % 2 == 0 { w } else { h })
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

/// Pictures drawn by `content` with names from `xobjects`, into `out`, with
/// `ctm` the transformation it starts under.
fn walk(doc: &Document, content: &[u8], xobjects: &[&Dictionary], depth: usize, ctm: Matrix, seen: &mut HashSet<ObjectId>, out: &mut Vec<Pic>) {
    let Ok(ops) = Content::decode(content) else { return };
    let mut ctm = ctm;
    let mut saved: Vec<Matrix> = vec![];
    for op in ops.operations {
        match op.operator.as_str() {
            "q" if saved.len() < 256 => saved.push(ctm),
            "Q" => ctm = saved.pop().unwrap_or(ctm),
            "cm" => {
                if let Some(m) = matrix_of(&op.operands) {
                    ctm = concat(&m, &ctm);
                }
            }
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
                    Some(b"Image") => out.push(Pic {
                        id: Some(id),
                        width: int(doc, d, b"Width").unwrap_or(0),
                        height: int(doc, d, b"Height").unwrap_or(0),
                        drawn: unit_box(&ctm),
                        hash: hash_of(&stream.content),
                    }),
                    Some(b"Form") if depth < FORM_DEPTH => {
                        let Ok(inner) = stream.decompressed_content_with_limit(MAX_CONTENT).or_else(|_| {
                            // An unfiltered form's content is its stream as it is.
                            if stream.dict.get(b"Filter").is_err() { Ok(stream.content.clone()) } else { Err(()) }
                        }) else {
                            continue;
                        };
                        let own = d.get(b"Resources").ok().and_then(|r| dict_of(doc, r)).and_then(|r| r.get(b"XObject").ok()).and_then(|x| dict_of(doc, x));
                        let names: Vec<&Dictionary> = own.into_iter().chain(xobjects.iter().copied()).collect();
                        let form = d.get(b"Matrix").ok().and_then(|m| deref(doc, m)).and_then(|m| m.as_array().ok()).and_then(|m| matrix_of(m)).unwrap_or(IDENTITY);
                        walk(doc, &inner, &names, depth + 1, concat(&form, &ctm), seen, out);
                    }
                    _ => {}
                }
            }
            "BI" => {
                let Some(s) = op.operands.first().and_then(|o| o.as_stream().ok()) else { continue };
                let w = int(doc, &s.dict, b"W").or_else(|| int(doc, &s.dict, b"Width")).unwrap_or(0);
                let h = int(doc, &s.dict, b"H").or_else(|| int(doc, &s.dict, b"Height")).unwrap_or(0);
                out.push(Pic { id: None, width: w, height: h, drawn: unit_box(&ctm), hash: hash_of(&s.content) });
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
    walk(doc, &content, &xobjects, 0, IDENTITY, &mut HashSet::new(), &mut out);
    out
}

/// The page's MediaBox (maybe inherited): [left, bottom, right, top].
fn page_box(doc: &Document, page: ObjectId) -> Option<[f64; 4]> {
    let mut id = page;
    for _ in 0..16 {
        let d = doc.get_dictionary(id).ok()?;
        if let Some(b) = d.get(b"MediaBox").ok().and_then(|b| deref(doc, b)).and_then(|b| b.as_array().ok()) {
            let n: Vec<f64> = b.iter().filter_map(|x| deref(doc, x)).filter_map(|x| x.as_float().ok().map(f64::from)).collect();
            return (n.len() == 4).then(|| [n[0].min(n[2]), n[1].min(n[3]), n[0].max(n[2]), n[1].max(n[3])]).filter(|b| b[2] - b[0] > 0.0 && b[3] - b[1] > 0.0);
        }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// What one page draws, for [`content_counts`].
#[derive(Debug, Clone)]
pub struct Drawn {
    /// Pictures big enough in pixels to be anything, placed with the page's corner at 0,0.
    pics: Vec<Pic>,
    /// The page's width and height in points, when it says.
    size: Option<(f64, f64)>,
    /// The page has text of its own.
    has_text: bool,
}

/// What page `page` draws; `has_text` is whether its text layer has text.
pub fn drawn(doc: &Document, page: ObjectId, has_text: bool) -> Drawn {
    let b = page_box(doc, page);
    let pics = page_pictures(doc, page)
        .into_iter()
        .filter(Pic::counts)
        .map(|mut p| {
            if let Some(b) = b {
                p.drawn = [p.drawn[0] - b[0], p.drawn[1] - b[1], p.drawn[2] - b[0], p.drawn[3] - b[1]];
            }
            p
        })
        .collect();
    Drawn { pics, size: b.map(|b| (b[2] - b[0], b[3] - b[1])), has_text }
}

/// How many pictures each of a document's pages shows that are content
/// (figures, diagrams, photos), in order. Not counted:
/// - decoration by size: few pixels ([`Pic::counts`]), or drawn over less
///   than [`MIN_PAGE_SHARE`] of the page (an icon, a logo in a corner);
/// - what a page's text sits on: a picture over most of a page with text
///   ([`BACKDROP_SHARE`]), or one the size and shape of the page in pixels
///   (a scan under a text layer someone recognised already);
/// - a template's: the same picture (by its bytes) on most pages of a
///   document of three or more, and any picture the same size drawn in the
///   same place as one of those (a title slide's own background).
pub fn content_counts(pages: &[Drawn]) -> Vec<u32> {
    use std::collections::HashMap;
    let mut on: HashMap<u64, HashSet<usize>> = HashMap::new();
    for (i, d) in pages.iter().enumerate() {
        for p in &d.pics {
            on.entry(p.hash).or_default().insert(i);
        }
    }
    let n = pages.len();
    let repeated = |p: &Pic| n >= 3 && on.get(&p.hash).is_some_and(|s| s.len() * 2 > n);
    let template: Vec<(&Pic, (f64, f64))> = pages.iter().filter_map(|d| Some((d, d.size?))).flat_map(|(d, s)| d.pics.iter().filter(|p| repeated(p)).map(move |p| (p, s))).collect();
    pages
        .iter()
        .map(|d| {
            d.pics
                .iter()
                .filter(|p| {
                    if repeated(p) {
                        return false;
                    }
                    let Some((w, h)) = d.size else { return true };
                    let share = p.page_share((w, h));
                    if share < MIN_PAGE_SHARE {
                        return false;
                    }
                    if d.has_text {
                        let (pw, ph) = (p.width as f64, p.height as f64);
                        let page_shaped = pw.min(ph) >= 900.0 && ((pw / ph) - (w / h)).abs() <= 0.08 * (w / h);
                        if share >= BACKDROP_SHARE || page_shaped {
                            return false;
                        }
                    }
                    !template.iter().any(|(t, s)| (t.width, t.height) == (p.width, p.height) && *s == (w, h) && p.same_place(t, (w, h)))
                })
                .count() as u32
        })
        .collect()
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
        let p3 = format!("{text} q 400 0 0 300 0 0 cm /Photo Do Q q 1 0 0 1 300 400 cm 200 0 0 200 0 0 cm BI /W 200 /H 200 /BPC 8 /CS /Gray ID {} EI Q", "x".repeat(200 * 200));
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
        assert_eq!(p1[0].drawn, [72.0, 300.0, 372.0, 500.0], "placed by the cm around the form");
        let p3 = page_pictures(&doc, pages[&3]);
        assert_eq!(p3[1].drawn, [300.0, 400.0, 500.0, 600.0], "the inline image, by both cm's");
        let drawn: Vec<Drawn> = pages.values().map(|&id| drawn(&doc, id, true)).collect();
        assert_eq!(content_counts(&drawn), [1, 0, 2], "the icon is decoration; page 2 draws nothing; a JPEG and an inline image (300×400 is no page-sized scan)");

        let (mime, png) = page_picture(&doc, pages[&1]).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(super::super::png::size_of(&png), Some((300, 200)));
        let (mime, jpeg) = page_picture(&doc, pages[&3]).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        assert!(page_picture(&doc, pages[&2]).is_none());
    }

    /// A grey `w`×`h` image XObject (its bytes vary with `seed`).
    fn grey_image(w: usize, h: usize, seed: u8) -> Vec<u8> {
        let px: Vec<u8> = (0..w * h).map(|i| (i % 241) as u8 ^ seed).collect();
        stream(&format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8"), &px)
    }

    /// Slides as a template makes them: 4 pages of 1024×768 with text, each
    /// drawing a 3840×2160 background in the top half (pages 1–2 one object,
    /// 3–4 a copy with the same bytes), page 1 its own title background there
    /// instead, every page a 346 px icon drawn 40 pt wide. Page 2 also sits
    /// on a full-page picture; page 3 shows a real figure; page 4 a small
    /// thumbnail of one (60 × 40 pt).
    fn slides() -> Vec<u8> {
        let text = "BT /F1 12 Tf 72 712 Td (Speaker notes for this slide, with plenty of words.) Tj ET";
        let bg = "q 512 0 0 288 256 450 cm";
        let icon = "q 40 0 0 40 960 700 cm /Icon Do Q";
        let pages = [
            format!("{bg} /Title Do Q {icon} {text}"),
            format!("q 1024 0 0 768 0 0 cm /Paper Do Q {bg} /Bg1 Do Q {icon} {text}"),
            format!("{bg} /Bg2 Do Q {icon} q 300 0 0 200 100 100 cm /Figure Do Q {text}"),
            format!("{bg} /Bg2 Do Q {icon} q 60 0 0 40 100 100 cm /Thumb Do Q {text}"),
        ];
        let mut objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 /Resources << /Font << /F1 11 0 R >> /XObject << /Title 12 0 R /Bg1 13 0 R /Bg2 14 0 R /Icon 15 0 R /Paper 16 0 R /Figure 17 0 R /Thumb 18 0 R >> >> >>".to_vec(),
        ];
        for i in 0..4 {
            objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1024 768] /Contents {} 0 R >>", 7 + i).into_bytes());
        }
        for p in &pages {
            objects.push(stream("", p.as_bytes()));
        }
        objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());
        // Backgrounds are big: 3840×2160 grey, but stored small (one byte repeated, flate).
        let flat = |seed: u8| {
            let packed = miniz_oxide::deflate::compress_to_vec_zlib(&vec![seed; 3840 * 2160], 9);
            stream("/Type /XObject /Subtype /Image /Width 3840 /Height 2160 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", &packed)
        };
        objects.push(flat(10));
        objects.push(flat(20));
        objects.push(flat(20));
        objects.push(grey_image(346, 346, 1));
        objects.push(grey_image(1000, 1000, 2));
        objects.push(grey_image(600, 400, 3));
        objects.push(grey_image(300, 200, 4));
        pdf(&objects)
    }

    #[test]
    fn a_templates_pictures_are_decoration_and_real_figures_count() {
        let doc = Document::load_mem(&slides()).unwrap();
        let pages = doc.get_pages();
        let drawn: Vec<Drawn> = pages.values().map(|&id| drawn(&doc, id, true)).collect();
        assert_eq!(
            content_counts(&drawn),
            [0, 0, 1, 0],
            "the background repeats (by its bytes), the title's is drawn where it is, the icon is small on the page, page 2's paper is what its text sits on, the thumbnail is under 2% of the page; the figure counts"
        );
        // Without its text, page 2's full-page picture is the page itself (a scan), so it counts.
        let mut no_text = drawn.clone();
        no_text[1].has_text = false;
        assert_eq!(content_counts(&no_text), [0, 1, 1, 0]);
        // In a document of two pages nothing is "most pages": the same figure on both counts.
        assert_eq!(content_counts(&drawn[2..]), [2, 1], "two pages: the background and the figure on page 3; the background on page 4");
    }
}
