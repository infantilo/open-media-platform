//! Erzeugt UUIDv4-Werte für IS-04-Resource-IDs. Eigene, winzige
//! Implementierung statt der `uuid`-Crate (Minimal-Dependency-Regel,
//! `UMSETZUNG.md` §0.5), Standardverfahren nach RFC 4122 §4.4 — Rust-Pendant
//! zu `nodes/mock/internal/idgen` (Go). `getrandom` ist der schmalste
//! Baustein für kryptografisch-taugliche OS-Zufallszahlen, den die
//! Rust-Standardbibliothek selbst nicht mitbringt (anders als Gos
//! `crypto/rand`): ein einzelner Syscall-Wrapper, keine Framework-Tiefe.

/// Erzeugt eine zufällige UUID Version 4 im Standard-Textformat
/// (8-4-4-4-12), kompatibel mit dem in AMWA-TV/is-04 geforderten Pattern
/// `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
pub fn new_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("idgen: OS-Zufallszahlen nicht verfügbar");
    b[6] = (b[6] & 0x0f) | 0x40; // Version 4
    b[8] = (b[8] & 0x3f) | 0x80; // Variante RFC 4122

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        b[6],
        b[7],
        b[8],
        b[9],
        b[10],
        b[11],
        b[12],
        b[13],
        b[14],
        b[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_uuid_v4_pattern() {
        let id = new_v4();
        let bytes = id.as_bytes();
        assert_eq!(id.len(), 36);
        assert_eq!(bytes[8], b'-');
        assert_eq!(bytes[13], b'-');
        assert_eq!(bytes[14], b'4'); // Version-Nibble
        assert_eq!(bytes[18], b'-');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b')); // Variante
        assert_eq!(bytes[23], b'-');
    }

    #[test]
    fn is_reasonably_random() {
        assert_ne!(new_v4(), new_v4());
    }
}
