//! SHA-256 (the `sha2` crate), for telling a downloaded file's bytes apart from
//! the copy already on disk when the site gives no validator, and for the
//! account fingerprint kept in lms.json.

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Streaming SHA-256 with a lowercase-hex result.
#[derive(Clone, Default)]
pub struct Hasher(Sha256);

impl Hasher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    pub fn hex(self) -> String {
        to_hex(&self.0.finalize())
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex SHA-256 of `bytes`.
pub fn hex_of(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// Hex SHA-256 of the regular file at `path` (never through a symlink).
pub fn file_hex(path: &Path) -> std::io::Result<String> {
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(std::io::Error::other("not a plain file"));
    }
    let mut f = std::fs::File::open(path)?;
    let mut h = Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_digests_and_streaming_matches_one_shot() {
        assert_eq!(hex_of(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex_of(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        let mut h = Hasher::new();
        for c in data.chunks(13) {
            h.update(c);
        }
        assert_eq!(h.hex(), hex_of(&data));
        let dir = std::env::temp_dir().join(format!("phaethon-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("f"), &data).unwrap();
        assert_eq!(file_hex(&dir.join("f")).unwrap(), hex_of(&data));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
