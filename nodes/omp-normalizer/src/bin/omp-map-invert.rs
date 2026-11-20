//! Testdienst für den Abbildungsvertrag (UMSETZUNG 106.3b): invertiert die Helligkeit.
//! Zeigt, dass ein fremder Prozess mit dem minimalen Vertrag (siehe `tonemap::ProcessBackend`) die eingebaute Stufe ersetzt.
use std::io::{Read, Write};

fn main() {
    let mut i = std::io::stdin().lock();
    let mut o = std::io::stdout().lock();
    loop {
        let mut h = [0u8; 20];
        if i.read_exact(&mut h).is_err() {
            return;
        }
        if &h[0..4] != b"OMPM" || u32::from_le_bytes(h[4..8].try_into().unwrap()) != 1 {
            eprintln!("omp-map-invert: falscher Kopf");
            std::process::exit(2);
        }
        let w = u32::from_le_bytes(h[8..12].try_into().unwrap()) as usize;
        let hh = u32::from_le_bytes(h[12..16].try_into().unwrap()) as usize;
        let mut buf = vec![0u8; w * hh];
        if i.read_exact(&mut buf).is_err() {
            return;
        }
        for p in buf.iter_mut() {
            *p = 251 - *p; // 16..235 gespiegelt
        }
        if o.write_all(&buf).and_then(|_| o.flush()).is_err() {
            return;
        }
    }
}
