//! Hersteller-Backend der Karten-Node (Kap. 76): derselbe Node (Ingest, Ausgabe, IS-05, Untertitel-
//! Einbettung, Kanalzuordnung) steuert neben Blackmagic DeckLink auch SDK-Karten, deren Hersteller ein
//! GStreamer-Plugin mitbringt:
//!
//! - `decklink` (Standard): `decklink{video,audio}{src,sink}`.
//! - `aja`: `aja{video,audio}{src,sink}` (AJA NTV2, u. a. KONA IP im SDI-/Mischbetrieb über das AJA-Plugin).
//! - `custom`: Elementnamen aus `OMP_CARD_ELEMENTS="videosrc,audiosrc,videosink,audiosink"` — für Matrox
//!   (DSX LE5 / xMIO) und andere SDK-Karten. Matrox liefert kein öffentliches GStreamer-Plugin; ein vom
//!   Kunden auf dem Hersteller-SDK gebautes Plugin lässt sich so einhängen, ohne Node-Änderung.
//!
//! Hersteller-Eigenschaften werden nie geraten: Modus-Enum, Geräteauswahl und Zusatzwerte
//! (`OMP_CARD_PROPS="input-source=sdi-1,channel=0"`) gehen über Introspektion; was das Element nicht kennt,
//! ist ein klarer Startfehler (nie ein Panic durch ungültigen Enum-Nick).
//! Nicht an Hardware geprüft — die Tests decken die reine Logik (Modus-Zuordnung, Elementtabelle, Zusatzwerte).

use gstreamer as gst;
use gst::glib;
use gst::prelude::*;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    VideoSrc,
    AudioSrc,
    VideoSink,
    AudioSink,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backend {
    pub vendor: String,
    pub video_src: String,
    pub audio_src: String,
    pub video_sink: String,
    pub audio_sink: String,
    pub props: Vec<(String, String)>,
}

impl Backend {
    pub fn decklink() -> Self {
        Self::named("decklink", "decklink")
    }

    fn named(vendor: &str, prefix: &str) -> Self {
        Backend {
            vendor: vendor.into(),
            video_src: format!("{prefix}videosrc"),
            audio_src: format!("{prefix}audiosrc"),
            video_sink: format!("{prefix}videosink"),
            audio_sink: format!("{prefix}audiosink"),
            props: Vec::new(),
        }
    }

    pub fn element(&self, role: Role) -> &str {
        match role {
            Role::VideoSrc => &self.video_src,
            Role::AudioSrc => &self.audio_src,
            Role::VideoSink => &self.video_sink,
            Role::AudioSink => &self.audio_sink,
        }
    }

    pub fn is_decklink(&self) -> bool {
        self.vendor == "decklink"
    }
}

/// `OMP_CARD_PROPS`: `schlüssel=wert,schlüssel=wert`.
pub fn parse_props(s: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=').ok_or_else(|| format!("OMP_CARD_PROPS: {part:?} ist nicht schlüssel=wert"))?;
        let k = k.trim();
        if k.is_empty() {
            return Err(format!("OMP_CARD_PROPS: leerer Schlüssel in {part:?}"));
        }
        out.push((k.to_string(), v.trim().to_string()));
    }
    Ok(out)
}

/// Aus Hersteller, optionaler Elementliste und Zusatzwerten (rein, testbar).
pub fn build_backend(vendor: &str, elements: &str, props: &str) -> Result<Backend, String> {
    let mut b = match vendor.trim().to_ascii_lowercase().as_str() {
        "" | "decklink" => Backend::decklink(),
        "aja" => Backend::named("aja", "aja"),
        "custom" | "matrox" => {
            let names: Vec<&str> = elements.split(',').map(str::trim).collect();
            if names.len() != 4 || names.iter().any(|n| n.is_empty()) {
                return Err(format!(
                    "OMP_CARD_ELEMENTS muss vier Elementnamen liefern (videosrc,audiosrc,videosink,audiosink), bekam {elements:?}. \
                     Für Matrox braucht der Host ein auf dem Hersteller-SDK gebautes GStreamer-Plugin."
                ));
            }
            Backend {
                vendor: "custom".into(),
                video_src: names[0].into(),
                audio_src: names[1].into(),
                video_sink: names[2].into(),
                audio_sink: names[3].into(),
                props: Vec::new(),
            }
        }
        other => return Err(format!("OMP_CARD_VENDOR={other:?} unbekannt (decklink|aja|custom)")),
    };
    b.props = parse_props(props)?;
    Ok(b)
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

pub fn set_backend_from_env() -> Result<(), String> {
    let get = |k: &str| std::env::var(k).unwrap_or_default();
    let b = build_backend(&get("OMP_CARD_VENDOR"), &get("OMP_CARD_ELEMENTS"), &get("OMP_CARD_PROPS"))?;
    let _ = BACKEND.set(b);
    Ok(())
}

pub fn backend() -> &'static Backend {
    BACKEND.get_or_init(Backend::decklink)
}

/// Gültige Nicks eines Enum-Properties (leer, wenn es keins ist).
fn enum_nicks(el: &gst::Element, prop: &str) -> Vec<String> {
    let Some(p) = el.find_property(prop) else { return Vec::new() };
    match glib::EnumClass::with_type(p.value_type()) {
        Some(c) => c.values().iter().map(|v| v.nick().to_string()).collect(),
        None => Vec::new(),
    }
}

/// Setzt ein Property aus Text und prüft vorher: bekannt? Enum-Nick gültig?
fn set_checked(el: &gst::Element, prop: &str, value: &str) -> Result<(), String> {
    let Some(p) = el.find_property(prop) else {
        return Err(format!("{}: kennt die Eigenschaft `{prop}` nicht", el.factory().map(|f| f.name().to_string()).unwrap_or_default()));
    };
    if glib::EnumClass::with_type(p.value_type()).is_some() {
        let nicks = enum_nicks(el, prop);
        if !nicks.iter().any(|n| n == value) {
            return Err(format!("`{prop}={value}` ungültig, erlaubt: {nicks:?}"));
        }
    }
    el.set_property_from_str(prop, value);
    Ok(())
}

/// Erzeugt das Element der Rolle und wählt das Gerät.
/// DeckLink: `device-number`; andere: `device-number`, sonst `device-identifier` (Text) – danach `OMP_CARD_PROPS`.
pub fn make(role: Role, device_number: i32, name: Option<&str>) -> Result<gst::Element, String> {
    let b = backend();
    let factory = b.element(role);
    let mut builder = gst::ElementFactory::make(factory);
    if let Some(n) = name {
        builder = builder.name(n);
    }
    let el = builder.build().map_err(|e| format!("{factory}: {e}"))?;
    if el.find_property("device-number").is_some() {
        el.set_property("device-number", device_number);
    } else if el.find_property("device-identifier").is_some() {
        el.set_property_from_str("device-identifier", &device_number.to_string());
    }
    for (k, v) in &b.props {
        // Zusatzwerte gelten für das Element, das sie kennt (z. B. `input-source` nur an der Quelle).
        if el.find_property(k).is_some() {
            set_checked(&el, k, v).map_err(|e| format!("{factory}: {e}"))?;
        }
    }
    Ok(el)
}

/// Spiegelt jede unbekannte Zusatzeigenschaft zurück (Tippfehler sollen auffallen, nicht verpuffen).
pub fn unused_props(elements: &[&gst::Element]) -> Vec<String> {
    backend()
        .props
        .iter()
        .filter(|(k, _)| !elements.iter().any(|e| e.find_property(k).is_some()))
        .map(|(k, _)| k.clone())
        .collect()
}

/// Normalisiert einen Modus-Nick zum Vergleich (`1080p-2500` → `1080p2500`).
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

/// Passenden Hersteller-Nick für Auflösung/Bildrate aus der Enum-Liste wählen. Erkennt Schreibweisen wie
/// `1080p25`, `1080p-2500`, `1080p2997`, `720p-5994`; Halbbilder (`i`) zählen nicht, weil OMP progressiv arbeitet.
pub fn pick_mode_nick(nicks: &[String], height: u32, num: u32, den: u32) -> Option<String> {
    let fps = num as f64 / den as f64;
    let x100 = (fps * 100.0).round() as u32; // 25 → 2500, 29.97 → 2997, 59.94 → 5994
    let mut wanted = vec![format!("{height}p{x100:04}"), format!("{height}p{}", x100)];
    if x100 % 100 == 0 {
        wanted.push(format!("{height}p{}", x100 / 100));
    }
    // Ganzzahl-Schreibweise nur, wenn die Rate wirklich ganzzahlig ist: 29.97 darf nie "1080p30" treffen.
    nicks.iter().find(|n| {
        let m = norm(n);
        wanted.iter().any(|w| m == *w)
    }).cloned()
}

/// Setzt den Videomodus. DeckLink: OMP-Name = GStreamer-Nick (unverändert). Andere: Nick aus der
/// Enum-Liste des Elements zuordnen; ohne `mode`-Property (z. B. Formaterkennung am Eingang) ist das kein Fehler.
pub fn set_mode(el: &gst::Element, omp_mode: &str, height: u32, num: u32, den: u32) -> Result<(), String> {
    if backend().is_decklink() {
        el.set_property_from_str("mode", omp_mode);
        return Ok(());
    }
    if el.find_property("mode").is_none() {
        return Ok(());
    }
    let nicks = enum_nicks(el, "mode");
    if nicks.is_empty() {
        // Kein Enum (z. B. Zeichenkette): OMP-Name unverändert versuchen.
        el.set_property_from_str("mode", omp_mode);
        return Ok(());
    }
    // Kundenwunsch hat Vorrang: OMP_CARD_PROPS mode=… wurde bereits in make() gesetzt.
    if backend().props.iter().any(|(k, _)| k == "mode") {
        return Ok(());
    }
    match pick_mode_nick(&nicks, height, num, den) {
        Some(n) => set_checked(el, "mode", &n),
        None => Err(format!(
            "kein Modus für {height}p{:.2} unter den Modi der Karte {nicks:?} — mit OMP_CARD_PROPS mode=<Nick> festlegen",
            num as f64 / den as f64
        )),
    }
}

/// Eingangssignal: DeckLink und AJA melden `signal`; fehlt die Eigenschaft, gilt „unbekannt = vorhanden“.
pub fn signal(el: &gst::Element) -> bool {
    if el.find_property("signal").is_some() {
        el.property::<bool>("signal")
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn vendors_and_custom_elements() {
        assert_eq!(build_backend("", "", "").unwrap().video_src, "decklinkvideosrc");
        let a = build_backend("AJA", "", "channel=1,input-source=sdi-1").unwrap();
        assert_eq!(a.audio_sink, "ajaaudiosink");
        assert_eq!(a.props.len(), 2);
        let m = build_backend("matrox", "mxvsrc, mxasrc, mxvsink, mxasink", "").unwrap();
        assert_eq!((m.video_sink.as_str(), m.audio_src.as_str()), ("mxvsink", "mxasrc"));
        assert!(build_backend("custom", "a,b", "").unwrap_err().contains("vier Elementnamen"));
        assert!(build_backend("blackmagik", "", "").is_err());
        assert!(build_backend("aja", "", "ohne-gleich").is_err());
    }

    #[test]
    fn mode_nicks_match_vendor_spellings() {
        let aja = v(&["auto", "1080i-5000", "1080p-2500", "1080p-2997", "1080p-5000", "720p-5994", "525-5994"]);
        assert_eq!(pick_mode_nick(&aja, 1080, 25, 1).unwrap(), "1080p-2500");
        assert_eq!(pick_mode_nick(&aja, 1080, 30000, 1001).unwrap(), "1080p-2997");
        assert_eq!(pick_mode_nick(&aja, 720, 60000, 1001).unwrap(), "720p-5994");
        // Halbbild-Modus ist kein progressiver Treffer.
        assert_eq!(pick_mode_nick(&v(&["1080i-5000"]), 1080, 50, 1), None);
        let short = v(&["1080p25", "1080p2997"]);
        assert_eq!(pick_mode_nick(&short, 1080, 25, 1).unwrap(), "1080p25");
        // 29,97 darf nie das ganzzahlige 30 treffen.
        assert_eq!(pick_mode_nick(&v(&["1080p30"]), 1080, 30000, 1001), None);
    }

    #[test]
    fn props_parse() {
        assert_eq!(parse_props(" a=1 , b = x ").unwrap(), vec![("a".into(), "1".into()), ("b".into(), "x".into())]);
        assert!(parse_props("=1").is_err());
        assert!(parse_props("").unwrap().is_empty());
    }

    #[test]
    fn checked_properties_reject_bad_enum_without_panic() {
        gst::init().unwrap();
        // `videotestsrc` hat das Enum `pattern` – stellvertretend für ein Hersteller-Enum.
        let el = gst::ElementFactory::make("videotestsrc").build().unwrap();
        assert!(set_checked(&el, "pattern", "smpte").is_ok());
        assert!(set_checked(&el, "pattern", "gibts-nicht").unwrap_err().contains("erlaubt"));
        assert!(set_checked(&el, "nope", "1").unwrap_err().contains("kennt"));
        assert!(enum_nicks(&el, "pattern").contains(&"ball".to_string()));
        assert!(signal(&el), "ohne signal-Property gilt: vorhanden");
    }
}
