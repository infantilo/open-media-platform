//! Farbraum und Übertragungsfunktion eines Videoflows — Kapitel 79 (HDR-Kennzeichnung).
//!
//! Die Felder und Werte folgen **AMWA NMOS IS-04 v1.3** (`flow_video.json`): `colorspace` ∈ {BT601, BT709, BT2020,
//! BT2100} und `transfer_characteristic` ∈ {SDR, HLG, PQ} (Vorgabe SDR). HDR ist damit **BT2100 + PQ** oder
//! **BT2100 + HLG**; die Bilddaten bleiben 10-Bit-YCbCr 4:2:2 (v210).
//!
//! **Was das leistet und was nicht:** OMP kennzeichnet HDR und reicht die Kennzeichnung bis zu den Messgeräten
//! durch. OMP **wandelt keine** Übertragungsfunktionen (kein Tone-Mapping SDR↔HDR) und mischt nicht
//! farbmetrisch. Ein Mischer, der HDR- und SDR-Quellen zusammenführt, liefert falsche Bilder — dafür gibt es
//! eine Warnung beim Verbinden ([`warn_if_mismatch`]).
//!
//! Setzen: Umgebungsvariable `OMP_COLORIMETRY` je Node-Prozess: `sdr` (Standard, BT709/SDR), `hlg`
//! (BT2100/HLG), `pq` (BT2100/PQ) oder ausdrücklich `<colorspace>/<transfer>` (z. B. `BT601/SDR`).

use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Colorimetry {
    pub colorspace: String,
    pub transfer: String,
}

impl Default for Colorimetry {
    fn default() -> Self {
        Colorimetry { colorspace: "BT709".to_string(), transfer: "SDR".to_string() }
    }
}

const COLORSPACES: [&str; 4] = ["BT601", "BT709", "BT2020", "BT2100"];
const TRANSFERS: [&str; 3] = ["SDR", "HLG", "PQ"];

impl Colorimetry {
    pub fn parse(s: &str) -> Result<Colorimetry, String> {
        let t = s.trim();
        match t.to_ascii_lowercase().as_str() {
            "" | "sdr" => return Ok(Colorimetry::default()),
            "hlg" => return Ok(Colorimetry { colorspace: "BT2100".into(), transfer: "HLG".into() }),
            "pq" | "hdr10" => return Ok(Colorimetry { colorspace: "BT2100".into(), transfer: "PQ".into() }),
            _ => {}
        }
        let (cs, tr) = t.split_once('/').ok_or_else(|| format!("Farbraum „{t}“: sdr, hlg, pq oder <Farbraum>/<Übertragung>"))?;
        let (cs, tr) = (cs.trim().to_ascii_uppercase(), tr.trim().to_ascii_uppercase());
        if !COLORSPACES.contains(&cs.as_str()) {
            return Err(format!("colorspace {cs}: {}", COLORSPACES.join(", ")));
        }
        if !TRANSFERS.contains(&tr.as_str()) {
            return Err(format!("transfer_characteristic {tr}: {}", TRANSFERS.join(", ")));
        }
        Ok(Colorimetry { colorspace: cs, transfer: tr })
    }

    /// Aus den beiden Feldern einer Flow-Beschreibung (fehlend: BT709/SDR; `transfer_characteristic` fehlt bei
    /// Flows ohne HDR-Kennzeichnung).
    pub fn from_fields(colorspace: Option<&str>, transfer: Option<&str>) -> Colorimetry {
        Colorimetry { colorspace: colorspace.unwrap_or("BT709").to_string(), transfer: transfer.unwrap_or("SDR").to_string() }
    }

    pub fn is_hdr(&self) -> bool {
        self.transfer == "HLG" || self.transfer == "PQ"
    }

    pub fn label(&self) -> String {
        format!("{} {}", self.colorspace, self.transfer)
    }

    /// Aus `OMP_COLORIMETRY` einmal je Prozess; ungültiger Wert → Meldung auf stderr und SDR.
    pub fn process_default() -> &'static Colorimetry {
        static CELL: OnceLock<Colorimetry> = OnceLock::new();
        CELL.get_or_init(|| match std::env::var("OMP_COLORIMETRY") {
            Ok(v) => Colorimetry::parse(&v).unwrap_or_else(|e| {
                eprintln!("omp-mediaio: OMP_COLORIMETRY ungültig ({e}) — SDR/BT709");
                Colorimetry::default()
            }),
            Err(_) => Colorimetry::default(),
        })
    }
}

/// Warnt auf stderr, wenn ein Eingang anders gekennzeichnet ist als der eigene Ausgang dieses Prozesses (z. B. ein
/// HDR-Flow an einem SDR-Mischer). Gibt `true` bei Abweichung zurück.
pub fn warn_if_mismatch(flow_id: &str, input: &Colorimetry) -> bool {
    let own = Colorimetry::process_default();
    if input == own {
        return false;
    }
    eprintln!(
        "omp-mediaio: Flow {flow_id} ist {} gekennzeichnet, dieser Prozess schreibt {} — OMP wandelt keine Übertragungsfunktionen, das Bild wird falsch dargestellt (OMP_COLORIMETRY setzen oder gleich gekennzeichnete Quellen verwenden)",
        input.label(),
        own.label()
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_variants() {
        assert_eq!(Colorimetry::parse("").unwrap(), Colorimetry::default());
        assert_eq!(Colorimetry::parse("PQ").unwrap().label(), "BT2100 PQ");
        assert_eq!(Colorimetry::parse("hlg").unwrap().label(), "BT2100 HLG");
        assert_eq!(Colorimetry::parse("bt601/sdr").unwrap().label(), "BT601 SDR");
        assert_eq!(Colorimetry::parse("BT2020/PQ").unwrap().label(), "BT2020 PQ");
        assert!(Colorimetry::parse("BT9999/SDR").is_err());
        assert!(Colorimetry::parse("BT709/LOG").is_err());
        assert!(Colorimetry::parse("quatsch").is_err());
    }

    #[test]
    fn from_fields_defaults_to_sdr() {
        assert!(!Colorimetry::from_fields(Some("BT709"), None).is_hdr());
        assert!(!Colorimetry::from_fields(None, None).is_hdr());
        let c = Colorimetry::from_fields(Some("BT2100"), Some("PQ"));
        assert!(c.is_hdr());
        assert_eq!(c.label(), "BT2100 PQ");
    }
}
