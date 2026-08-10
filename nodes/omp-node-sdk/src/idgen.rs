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
    format_uuid(b)
}

/// Deterministische Variante von [`new_v4`]: derselbe `seed` liefert
/// immer denselben Wert (Bug 2026-08-10: "beim Stoppen/Neustarten eines
/// Workflows verlieren viele Nodes ihre UID" — `node::start` ruft dies
/// mit einem vom Orchestrator vorgegebenen, pro Workflow-Rolle stabilen
/// Seed auf, s. `OMP_ROLE_SEED`, damit dieselbe Rolle nach einem
/// Workflow-Neustart wieder dieselbe NMOS-Node-/Device-ID bekommt statt
/// jedes Mal neu zu würfeln). Kein kryptografisches Verfahren nötig —
/// hier geht es um Stabilität und praktische Kollisionsfreiheit
/// innerhalb eines Deployments, nicht um Angreifer-Resistenz — daher
/// FNV-1a (RFC-frei, ein paar Zeilen) statt einer zusätzlichen
/// Hash-Crate (Minimal-Dependency-Regel, `UMSETZUNG.md` §0.5).
pub fn deterministic_v4(seed: &str) -> String {
    let mut b = [0u8; 16];
    b[0..8].copy_from_slice(&fnv1a64(seed.as_bytes()).to_be_bytes());
    // Zweite Hälfte aus demselben Seed, aber mit einem Trennbyte, das in
    // keinem gültigen UTF-8-String vorkommen kann (0xFF) — verhindert,
    // dass z. B. die Seeds "ab" und "a"+"b" (Konkatenation ohne
    // Trennzeichen an anderer Stelle gebildet) dieselbe zweite Hälfte
    // ergäben.
    let mut salted = Vec::with_capacity(seed.len() + 1);
    salted.extend_from_slice(seed.as_bytes());
    salted.push(0xFF);
    b[8..16].copy_from_slice(&fnv1a64(&salted).to_be_bytes());
    format_uuid(b)
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn format_uuid(mut b: [u8; 16]) -> String {
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

    #[test]
    fn deterministic_v4_is_stable_per_seed() {
        assert_eq!(deterministic_v4("workflow-1|source-a"), deterministic_v4("workflow-1|source-a"));
    }

    #[test]
    fn deterministic_v4_differs_per_seed() {
        assert_ne!(deterministic_v4("workflow-1|source-a"), deterministic_v4("workflow-1|source-b"));
        assert_ne!(deterministic_v4("workflow-1|source-a"), deterministic_v4("workflow-2|source-a"));
    }

    #[test]
    fn deterministic_v4_matches_uuid_v4_pattern() {
        let id = deterministic_v4("some-seed");
        let bytes = id.as_bytes();
        assert_eq!(id.len(), 36);
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
    }
}
