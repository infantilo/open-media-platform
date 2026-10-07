//! KLV-Grundfunktionen (SMPTE ST 336): Schlüssel 16 Byte, BER-Länge, Wert.

use crate::keys::Ul;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Klv<'a> {
    pub key: Ul,
    pub value: &'a [u8],
    /// Gesamtlänge von Key + Length + Value in Bytes.
    pub total: usize,
}

/// BER-Länge lesen: (Wert, Anzahl der Längen-Bytes).
pub fn read_ber(buf: &[u8]) -> Option<(u64, usize)> {
    let first = *buf.first()?;
    if first & 0x80 == 0 {
        return Some((u64::from(first), 1));
    }
    let n = (first & 0x7F) as usize;
    if n == 0 || n > 8 || buf.len() < 1 + n {
        return None;
    }
    let mut v = 0u64;
    for b in &buf[1..=n] {
        v = (v << 8) | u64::from(*b);
    }
    Some((v, 1 + n))
}

/// BER-Länge schreiben. `min_bytes` > 0 erzwingt die lange Form mit genau so
/// vielen Längen-Bytes (z. B. 4 für feste 4-Byte-Längen in Header-Metadaten).
pub fn write_ber(len: u64, min_bytes: usize) -> Vec<u8> {
    if min_bytes == 0 && len < 0x80 {
        return vec![len as u8];
    }
    let mut n = 1;
    while n < 8 && (len >> (8 * n)) != 0 {
        n += 1;
    }
    let n = n.max(min_bytes.saturating_sub(1)).max(1);
    let mut out = vec![0x80 | n as u8];
    for i in (0..n).rev() {
        out.push((len >> (8 * i)) as u8);
    }
    out
}

/// Ein KLV-Paket ab Offset 0 von `buf` lesen (None bei Pufferende/ungültig/abgeschnitten).
pub fn read_klv(buf: &[u8]) -> Option<Klv<'_>> {
    if buf.len() < 17 {
        return None;
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&buf[..16]);
    let (len, n) = read_ber(&buf[16..])?;
    let start = 16 + n;
    let end = start.checked_add(usize::try_from(len).ok()?)?;
    if end > buf.len() {
        return None;
    }
    Some(Klv { key, value: &buf[start..end], total: end })
}

/// Ein KLV-Paket serialisieren.
pub fn write_klv(key: &Ul, value: &[u8], min_len_bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 9 + value.len());
    out.extend_from_slice(key);
    out.extend(write_ber(value.len() as u64, min_len_bytes));
    out.extend_from_slice(value);
    out
}

/// UTF-16BE-String (MXF „UTF16String“) dekodieren; Abschluss-NUL wird entfernt.
pub fn utf16be_decode(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    let end = units.iter().rposition(|u| *u != 0).map_or(0, |i| i + 1);
    String::from_utf16_lossy(&units[..end])
}

pub fn utf16be_encode(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ber_round_trip() {
        for v in [0u64, 1, 127, 128, 255, 256, 65535, 1 << 24, 1 << 40] {
            let b = write_ber(v, 0);
            assert_eq!(read_ber(&b), Some((v, b.len())), "{v}");
        }
        assert_eq!(write_ber(5, 4), vec![0x83, 0, 0, 5]);
        assert_eq!(read_ber(&[0x83, 0, 0, 5]), Some((5, 4)));
        assert_eq!(read_ber(&[0x80]), None);
    }

    #[test]
    fn klv_round_trip_and_truncation() {
        let key = [7u8; 16];
        let b = write_klv(&key, b"hallo", 4);
        let k = read_klv(&b).unwrap();
        assert_eq!((k.key, k.value, k.total), (key, &b"hallo"[..], b.len()));
        assert!(read_klv(&b[..b.len() - 1]).is_none());
    }

    #[test]
    fn utf16() {
        let e = utf16be_encode("Fön");
        assert_eq!(utf16be_decode(&e), "Fön");
        let mut z = e.clone();
        z.extend([0, 0]);
        assert_eq!(utf16be_decode(&z), "Fön");
    }
}
