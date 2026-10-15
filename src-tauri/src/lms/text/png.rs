//! A small PNG writer: 8-bit grey or RGB pixels (or rows already filtered
//! the PNG way) into a PNG file, with zlib from miniz_oxide. Enough to hand a
//! page's picture to a model or to text recognition without an image library.

/// Write a PNG. `rows` is `height` rows of `width * channels` bytes each, or,
/// when `filtered`, each row led by its PNG filter byte. `channels` is 1
/// (grey) or 3 (RGB). `None` when the sizes don't add up.
pub fn encode(width: u32, height: u32, channels: u8, rows: &[u8], filtered: bool) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || !matches!(channels, 1 | 3) {
        return None;
    }
    let stride = width as usize * channels as usize;
    let want = (stride + usize::from(filtered)) * height as usize;
    if rows.len() < want {
        return None;
    }
    let raw: Vec<u8> = if filtered {
        rows[..want].to_vec()
    } else {
        let mut v = Vec::with_capacity((stride + 1) * height as usize);
        for row in rows[..want].chunks(stride) {
            v.push(0);
            v.extend_from_slice(row);
        }
        v
    };
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, if channels == 1 { 0 } else { 2 }, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6));
    chunk(&mut out, b"IEND", &[]);
    Some(out)
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in bytes {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// Width and height of a PNG or JPEG file, from its header.
pub fn size_of(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        // Walk the JPEG markers to the first start-of-frame.
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if marker == 0xff {
                i += 1;
                continue;
            }
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]);
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]);
                return Some((u32::from(w), u32::from(h)));
            }
            i += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_and_a_png_that_reads_back() {
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
        let px: Vec<u8> = (0..12).collect();
        let png = encode(4, 3, 1, &px, false).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(size_of(&png), Some((4, 3)));
        // The image data inflates back to each row with filter 0.
        let at = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(png[at - 4..at].try_into().unwrap()) as usize;
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&png[at + 4..at + 4 + len]).unwrap();
        assert_eq!(raw, [0, 0, 1, 2, 3, 0, 4, 5, 6, 7, 0, 8, 9, 10, 11]);
        assert!(encode(4, 3, 1, &px[..11], false).is_none(), "too few pixels");
        assert!(encode(4, 3, 2, &px, false).is_none(), "grey or RGB only");
        assert_eq!(size_of(b"not a picture"), None);
        // A JPEG's size from its frame header.
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0];
        assert_eq!(size_of(&jpeg), Some((30, 20)));
    }
}
