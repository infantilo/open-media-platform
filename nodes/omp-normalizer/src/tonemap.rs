//! Abbildung der Übertragungsfunktion (SDR / HLG / PQ) hinter austauschbarer Schnittstelle (UMSETZUNG 106.3b).
//!
//! **Ausdrücklich ohne Qualitätsversprechen.** Die eingebaute Stufe ist eine feste Kennlinie auf der Helligkeit (Y,
//! begrenzter Bereich 16–235, 8 Bit), die Farbigkeit (Cb/Cr) bleibt unberührt. Sie ist als Mindest-Abbildung gedacht;
//! ein hochwertiger Dienst (3D-Tabellen, Szenenanalyse) kommt später von außen und ersetzt sie über [`StageBackend`].
//!
//! Gemeinsamer Bezug aller Kennlinien: **Bezugsweiß = 1,0 (linear)**. SDR: BT.709-Kennlinie, Weiß = 100 %.
//! HLG: Bezugsweiß bei 75 % Signal (Szenenlicht 0,2652). PQ: Bezugsweiß 203 cd/m². Das sind Konventionen dieser
//! Mindest-Abbildung, keine Normwerte aus gelesenem Text; sie sind hier bewusst als Näherung benannt.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Kennlinie des Signals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    Sdr,
    Hlg,
    Pq,
}

impl Curve {
    pub fn parse(s: &str) -> Option<Curve> {
        match s.trim().to_ascii_uppercase().as_str() {
            "SDR" | "BT709" => Some(Curve::Sdr),
            "HLG" => Some(Curve::Hlg),
            "PQ" | "ST2084" => Some(Curve::Pq),
            _ => None,
        }
    }
    fn id(self) -> u8 {
        match self {
            Curve::Sdr => 0,
            Curve::Hlg => 1,
            Curve::Pq => 2,
        }
    }
}

const HLG_WHITE_SCENE: f64 = 0.2652; // Szenenlicht bei 75 % Signal
const PQ_WHITE_NITS: f64 = 203.0;

fn oetf709(l: f64) -> f64 {
    if l < 0.018 { 4.5 * l } else { 1.099 * l.powf(0.45) - 0.099 }
}
fn inv_oetf709(e: f64) -> f64 {
    if e < 0.081 { e / 4.5 } else { ((e + 0.099) / 1.099).powf(1.0 / 0.45) }
}
const HLG_A: f64 = 0.17883277;
const HLG_B: f64 = 0.28466892;
const HLG_C: f64 = 0.55991073;
fn hlg_oetf(ls: f64) -> f64 {
    if ls <= 1.0 / 12.0 { (3.0 * ls).sqrt() } else { HLG_A * (12.0 * ls - HLG_B).ln() + HLG_C }
}
fn hlg_inv(e: f64) -> f64 {
    if e <= 0.5 { e * e / 3.0 } else { (((e - HLG_C) / HLG_A).exp() + HLG_B) / 12.0 }
}
const PQ_M1: f64 = 2610.0 / 16384.0;
const PQ_M2: f64 = 2523.0 / 4096.0 * 128.0;
const PQ_C1: f64 = 3424.0 / 4096.0;
const PQ_C2: f64 = 2413.0 / 4096.0 * 32.0;
const PQ_C3: f64 = 2392.0 / 4096.0 * 32.0;
fn pq_inv(e: f64) -> f64 {
    let p = e.max(0.0).powf(1.0 / PQ_M2);
    let n = (p - PQ_C1).max(0.0);
    10000.0 * (n / (PQ_C2 - PQ_C3 * p)).powf(1.0 / PQ_M1)
}
fn pq_oetf(nits: f64) -> f64 {
    let y = (nits / 10000.0).clamp(0.0, 1.0).powf(PQ_M1);
    ((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y)).powf(PQ_M2)
}

/// Signalwert (0..1) → linear, bezogen auf Bezugsweiß = 1,0.
fn to_linear(c: Curve, e: f64) -> f64 {
    match c {
        Curve::Sdr => inv_oetf709(e),
        Curve::Hlg => hlg_inv(e) / HLG_WHITE_SCENE,
        Curve::Pq => pq_inv(e) / PQ_WHITE_NITS,
    }
}
/// Linear (Bezugsweiß = 1,0) → Signalwert 0..1.
fn from_linear(c: Curve, l: f64) -> f64 {
    let v = match c {
        Curve::Sdr => oetf709(l.min(1.0)),
        Curve::Hlg => hlg_oetf((l * HLG_WHITE_SCENE).min(1.0)),
        Curve::Pq => pq_oetf(l * PQ_WHITE_NITS),
    };
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

/// Tabelle für den Helligkeitscode (begrenzter Bereich, 8 Bit). Codes außerhalb 16–235 werden festgehalten.
pub fn luma_lut(from: Curve, to: Curve) -> [u8; 256] {
    let mut lut = [0u8; 256];
    for (code, out) in lut.iter_mut().enumerate() {
        let e = ((code as f64 - 16.0) / 219.0).clamp(0.0, 1.0);
        let v = from_linear(to, to_linear(from, e));
        *out = (16.0 + v * 219.0).round().clamp(16.0, 235.0) as u8;
    }
    lut
}

/// Anfrage an eine Abbildungsstufe. `luma` ist die Y-Ebene, dicht gepackt (`width * height` Bytes).
#[derive(Clone, Copy, Debug)]
pub struct MapRequest {
    pub from: Curve,
    pub to: Curve,
    pub width: u32,
    pub height: u32,
}

/// Austauschbare Abbildungsstufe. Der Normalizer kennt nur diese Schnittstelle.
pub trait StageBackend: Send {
    fn name(&self) -> String;
    /// Wandelt die Y-Ebene an Ort und Stelle. Bei `Err` bleibt `luma` unverändert (Aufrufer entscheidet über Alarm).
    fn map_luma(&mut self, req: &MapRequest, luma: &mut [u8]) -> Result<(), String>;
}

/// Eingebaute Mindest-Abbildung (feste Tabelle).
#[derive(Default)]
pub struct Builtin {
    cache: Option<((Curve, Curve), [u8; 256])>,
}

impl StageBackend for Builtin {
    fn name(&self) -> String {
        "builtin".into()
    }
    fn map_luma(&mut self, req: &MapRequest, luma: &mut [u8]) -> Result<(), String> {
        let key = (req.from, req.to);
        if self.cache.as_ref().map(|c| c.0) != Some(key) {
            self.cache = Some((key, luma_lut(req.from, req.to)));
        }
        let lut = &self.cache.as_ref().expect("gerade gesetzt").1;
        for p in luma.iter_mut() {
            *p = lut[*p as usize];
        }
        Ok(())
    }
}

/// Externer Dienst als Kindprozess. **Vertrag Version 1** (Standard-Ein-/Ausgabe, kleine Bytes-Rahmen):
///
/// Anfrage: 20 Bytes Kopf + `width*height` Bytes Y-Ebene
/// `"OMPM"` | version u32 LE (=1) | width u32 LE | height u32 LE | from u8 | to u8 | 2 Bytes 0 (Kurve: 0 SDR, 1 HLG, 2 PQ)
/// Antwort: genau `width*height` Bytes Y-Ebene. Ende der Eingabe = Dienst beendet sich.
/// Fehlerverhalten: beendet sich der Dienst oder antwortet nicht vollständig, liefert `map_luma` `Err`.
pub struct ProcessBackend {
    cmd: String,
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl ProcessBackend {
    /// `cmd` = Programm (ohne Argumente) oder `Programm Argument...` durch Leerzeichen getrennt.
    pub fn spawn(cmd: &str) -> Result<ProcessBackend, String> {
        let mut parts = cmd.split_whitespace();
        let prog = parts.next().ok_or("leerer Dienst-Befehl")?;
        let mut child = Command::new(prog)
            .args(parts)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Dienst {prog}: {e}"))?;
        let stdin = child.stdin.take().ok_or("Dienst ohne stdin")?;
        let stdout = child.stdout.take().ok_or("Dienst ohne stdout")?;
        Ok(ProcessBackend { cmd: cmd.to_string(), child, stdin, stdout })
    }
}

impl StageBackend for ProcessBackend {
    fn name(&self) -> String {
        self.cmd.clone()
    }
    fn map_luma(&mut self, req: &MapRequest, luma: &mut [u8]) -> Result<(), String> {
        let mut head = Vec::with_capacity(20);
        head.extend_from_slice(b"OMPM");
        head.extend_from_slice(&1u32.to_le_bytes());
        head.extend_from_slice(&req.width.to_le_bytes());
        head.extend_from_slice(&req.height.to_le_bytes());
        head.extend_from_slice(&[req.from.id(), req.to.id(), 0, 0]);
        self.stdin.write_all(&head).and_then(|_| self.stdin.write_all(luma)).and_then(|_| self.stdin.flush()).map_err(|e| format!("Dienst schreibt: {e}"))?;
        let mut out = vec![0u8; luma.len()];
        self.stdout.read_exact(&mut out).map_err(|e| format!("Dienst antwortet nicht: {e}"))?;
        luma.copy_from_slice(&out);
        Ok(())
    }
}

impl Drop for ProcessBackend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `builtin` oder ein Dienst-Befehl (alles andere).
pub fn make_backend(name: &str) -> Result<Box<dyn StageBackend>, String> {
    let n = name.trim();
    if n.is_empty() || n.eq_ignore_ascii_case("builtin") {
        Ok(Box::new(Builtin::default()))
    } else {
        Ok(Box::new(ProcessBackend::spawn(n)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(from: Curve, to: Curve, signal: f64) -> u8 {
        luma_lut(from, to)[(16.0 + signal * 219.0).round() as usize]
    }

    #[test]
    fn same_curve_is_identity_in_the_legal_range() {
        for c in [Curve::Sdr, Curve::Hlg, Curve::Pq] {
            let lut = luma_lut(c, c);
            for code in 17..235usize {
                assert!((lut[code] as i32 - code as i32).abs() <= 1, "{c:?} {code} -> {}", lut[code]);
            }
        }
    }

    #[test]
    fn hlg_reference_white_becomes_sdr_white() {
        // HLG 75 % (Bezugsweiß) → SDR ≈ 100 % (Code 235), Toleranz 3 Codewerte.
        assert!((code_of(Curve::Hlg, Curve::Sdr, 0.75) as i32 - 235).abs() <= 3);
        // HLG 50 % → SDR ≈ 55,5 % (Code ≈ 138).
        assert!((code_of(Curve::Hlg, Curve::Sdr, 0.5) as i32 - 138).abs() <= 3);
        // Schwarz bleibt Schwarz.
        assert_eq!(code_of(Curve::Hlg, Curve::Sdr, 0.0), 16);
    }

    #[test]
    fn hlg_test_image_maps_to_sdr_within_documented_limits() {
        // Testbild: Rampe über den ganzen Bereich. Mittelwert des Eingangs ≈ 125; Ausgang muss heller sein (HLG-Spitzen
        // werden abgeschnitten), aber im gültigen Bereich bleiben, monoton und ohne Ausreißer.
        let mut img: Vec<u8> = (16..=235u8).collect();
        let before: f64 = img.iter().map(|&p| p as f64).sum::<f64>() / img.len() as f64;
        let mut b = Builtin::default();
        b.map_luma(&MapRequest { from: Curve::Hlg, to: Curve::Sdr, width: img.len() as u32, height: 1 }, &mut img).unwrap();
        let after: f64 = img.iter().map(|&p| p as f64).sum::<f64>() / img.len() as f64;
        assert!(img.windows(2).all(|w| w[0] <= w[1]), "nicht monoton");
        assert!(img.iter().all(|&p| (16..=235).contains(&p)), "außerhalb 16..235");
        assert!(after > before && after < 200.0, "Mittelwert {before} -> {after} außerhalb der Grenzen");
        assert_eq!(*img.last().unwrap(), 235); // oberes Ende geclippt, nicht über Weiß
    }

    #[test]
    fn sdr_to_hlg_and_back_roundtrips_below_reference_white() {
        let up = luma_lut(Curve::Sdr, Curve::Hlg);
        let down = luma_lut(Curve::Hlg, Curve::Sdr);
        for code in 20..220usize {
            let r = down[up[code] as usize] as i32;
            assert!((r - code as i32).abs() <= 3, "{code} -> {r}");
        }
    }

    #[test]
    fn pq_maps_without_invalid_values() {
        for (a, b) in [(Curve::Pq, Curve::Sdr), (Curve::Sdr, Curve::Pq), (Curve::Pq, Curve::Hlg), (Curve::Hlg, Curve::Pq)] {
            let lut = luma_lut(a, b);
            assert!(lut.iter().all(|&p| (16..=235).contains(&p)));
            assert!(lut.windows(2).all(|w| w[0] <= w[1]));
        }
    }

    #[test]
    fn parse_curves() {
        assert_eq!(Curve::parse("hlg"), Some(Curve::Hlg));
        assert_eq!(Curve::parse("PQ"), Some(Curve::Pq));
        assert_eq!(Curve::parse("SDR"), Some(Curve::Sdr));
        assert_eq!(Curve::parse("x"), None);
    }
}
