//! Kernel-Bypass für ST 2110 (Kap. 76, Plan: `docs/END-GOAL-FEATURES.md` §19.3d).
//!
//! Der RTP-Pfad bleibt der Kernel-Socket (`udpsink`/`udpsrc`). Für Hosts mit passender NIC gibt es **Intel MTL**
//! (E810/E830 u. a., BSD-3, Backends DPDK/AF_XDP/Kernel): MTL arbeitet auf *Bildebene* (`mtl_st20p_tx`/`mtl_st20p_rx`
//! nehmen Rohvideo, Payloader und Socket entfallen) und ist deshalb kein Drop-in — [`mtl_video_tx`]/[`mtl_video_rx`]
//! bauen die Elemente, die Verdrahtung in `St2110VideoOutput` ist bewusst noch nicht erfolgt (Bildformat-Abgleich nur
//! an echter Karte prüfbar). Proprietäre Bypass-Stacks sind nicht enthalten.
//!
//! Gewählt wird per `OMP_2110_TRANSPORT=kernel|mtl` (Standard `kernel`). Fehlt das Plugin, fällt [`resolve`] auf
//! `kernel` zurück und nennt den Grund — nie ein stiller Absturz. Elementeigenschaften werden nur gesetzt, wenn das
//! Element sie kennt ([`set_if_exists`]); die MTL-Eigenschaftsnamen stützen sich auf die Dokumentation von MTL und sind
//! an Hardware noch zu bestätigen.

use gstreamer as gst;
use gst::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Kernel,
    Mtl,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Kernel => "kernel",
            Backend::Mtl => "mtl",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preference {
    Kernel,
    Mtl,
}

pub fn parse_preference(s: &str) -> Result<Preference, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "" | "kernel" | "udp" => Ok(Preference::Kernel),
        "mtl" => Ok(Preference::Mtl),
        other => Err(format!("OMP_2110_TRANSPORT={other:?} unbekannt (kernel|mtl)")),
    }
}

/// Welche Bypass-Plugins sind installiert (Elemente über `ElementFactory::find`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Available {
    pub mtl: bool,
}

pub fn detect() -> Available {
    let _ = gst::init();
    let has = |n: &str| gst::ElementFactory::find(n).is_some();
    Available { mtl: has("mtl_st20p_tx") && has("mtl_st20p_rx") }
}

/// Ergebnis der Auswahl: genutzter Backend-Weg und ggf. warum nicht der gewünschte.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub backend: Backend,
    pub note: Option<String>,
}

/// Reine Auswahlregel (ohne GStreamer, testbar). MTL ist kein Paket-Ersatz ([`Backend::Mtl`] wird
/// nur für `mtl_video_*` gebraucht): `packet_level` verlangt einen udpsink-Ersatz, dann gilt MTL als
/// nicht verfügbar.
pub fn resolve(pref: Preference, av: Available, packet_level: bool) -> Resolved {
    let ok = |b| Resolved { backend: b, note: None };
    let fallback = |why: &str| Resolved { backend: Backend::Kernel, note: Some(format!("Rückfall auf Kernel-Socket: {why}")) };
    match pref {
        Preference::Kernel => ok(Backend::Kernel),
        Preference::Mtl if packet_level => fallback("MTL arbeitet auf Bildebene, nicht als udpsink-Ersatz"),
        Preference::Mtl if av.mtl => ok(Backend::Mtl),
        Preference::Mtl => fallback("MTL-Plugin (mtl_st20p_tx/rx) nicht installiert"),
    }
}

/// Auswahl aus der Umgebung für den Paket-Pfad (`udpsink`-Ersatz). Ungültiger Wert → Kernel + Hinweis.
pub fn selected() -> Resolved {
    let raw = std::env::var("OMP_2110_TRANSPORT").unwrap_or_default();
    match parse_preference(&raw) {
        Ok(p) => resolve(p, detect(), true),
        Err(e) => Resolved { backend: Backend::Kernel, note: Some(e) },
    }
}

/// Setzt `prop` nur, wenn das Element sie kennt. `true` = gesetzt.
pub fn set_if_exists(el: &gst::Element, prop: &str, value: &str) -> bool {
    if el.find_property(prop).is_none() {
        return false;
    }
    el.set_property_from_str(prop, value);
    true
}

/// Sendeelement für RTP-Pakete. `udpsink`.
pub fn make_sink(name: &str, host: &str, port: u16) -> Result<(gst::Element, Resolved), String> {
    let r = selected();
    if let Some(n) = &r.note {
        eprintln!("omp-mediaio(kbypass): {n}");
    }
    let el = gst::ElementFactory::make("udpsink")
        .name(name)
        .property("sync", true)
        .property("async", false)
        .build()
        .map_err(|e| format!("udpsink: {e}"))?;
    set_destination(&el, host, port);
    Ok((el, r))
}

/// Ziel setzen — `host`/`port` heißen bei udpsink so; andere Elemente werden über Introspektion bedient.
pub fn set_destination(el: &gst::Element, host: &str, port: u16) {
    if !set_if_exists(el, "host", host) {
        set_if_exists(el, "address", host);
    }
    set_if_exists(el, "port", &port.to_string());
}

/// Empfangselement für RTP-Pakete (`caps` = RTP-Caps, `group` = Multicast-Gruppe).
pub fn make_src(name: &str, port: u16, caps: &gst::Caps, group: Option<&str>) -> Result<(gst::Element, Resolved), String> {
    let r = selected();
    if let Some(n) = &r.note {
        eprintln!("omp-mediaio(kbypass): {n}");
    }
    let el = gst::ElementFactory::make("udpsrc").name(name).build().map_err(|e| format!("udpsrc: {e}"))?;
    set_if_exists(&el, "port", &port.to_string());
    el.set_property("caps", caps);
    if let Some(g) = group {
        set_if_exists(&el, "address", g);
    }
    Ok((el, r))
}

/// Intel-MTL-Sender (Bildebene): Rohvideo hinein, ST-2110-20 auf die NIC. `dev_port` ist die PCI-Adresse
/// der NIC (`0000:3b:00.0`) bzw. ein Kernel-Interface-Name, `dev_ip` die lokale Adresse.
pub fn mtl_video_tx(name: &str, dev_port: &str, dev_ip: &str, host: &str, port: u16) -> Result<gst::Element, String> {
    let el = gst::ElementFactory::make("mtl_st20p_tx").name(name).build().map_err(|e| format!("mtl_st20p_tx: {e}"))?;
    mtl_common(&el, dev_port, dev_ip, host, port)?;
    Ok(el)
}

pub fn mtl_video_rx(name: &str, dev_port: &str, dev_ip: &str, group: &str, port: u16) -> Result<gst::Element, String> {
    let el = gst::ElementFactory::make("mtl_st20p_rx").name(name).build().map_err(|e| format!("mtl_st20p_rx: {e}"))?;
    mtl_common(&el, dev_port, dev_ip, group, port)?;
    Ok(el)
}

fn mtl_common(el: &gst::Element, dev_port: &str, dev_ip: &str, ip: &str, port: u16) -> Result<(), String> {
    // Nur Eigenschaften setzen, die das installierte Plugin wirklich hat; fehlt die Port-Angabe
    // vollständig, ist das Element für uns unbenutzbar und der Fehler soll sofort sichtbar sein.
    let mut hit = false;
    hit |= set_if_exists(el, "dev-port", dev_port);
    set_if_exists(el, "dev-ip", dev_ip);
    for p in ["tx-ip", "rx-ip", "ip"] {
        if set_if_exists(el, p, ip) {
            break;
        }
    }
    for p in ["udp-port", "tx-udp-port", "rx-udp-port"] {
        if set_if_exists(el, p, &port.to_string()) {
            break;
        }
    }
    if hit { Ok(()) } else { Err("MTL-Element ohne Eigenschaft `dev-port` — Plugin-Version passt nicht".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Available = Available { mtl: false };

    #[test]
    fn preference_parsing() {
        assert_eq!(parse_preference("").unwrap(), Preference::Kernel);
        assert_eq!(parse_preference(" MTL ").unwrap(), Preference::Mtl);
        assert!(parse_preference("dpdk").is_err());
        assert!(parse_preference("rivermax").is_err());
    }

    #[test]
    fn resolve_falls_back_with_reason() {
        let r = resolve(Preference::Mtl, NONE, false);
        assert_eq!(r.backend, Backend::Kernel);
        assert!(r.note.unwrap().contains("MTL"));
        assert_eq!(resolve(Preference::Kernel, Available { mtl: true }, true).note, None);
    }

    #[test]
    fn mtl_is_not_packet_level() {
        let av = Available { mtl: true };
        assert_eq!(resolve(Preference::Mtl, av, false).backend, Backend::Mtl);
        let r = resolve(Preference::Mtl, av, true);
        assert_eq!(r.backend, Backend::Kernel);
        assert!(r.note.unwrap().contains("Bildebene"));
    }

    #[test]
    fn kernel_sink_and_introspected_destination() {
        gst::init().unwrap();
        let (el, r) = make_sink("t", "127.0.0.1", 5004).unwrap();
        assert_eq!(r.backend, Backend::Kernel);
        set_destination(&el, "127.0.0.2", 6000);
        assert_eq!(el.property::<String>("host"), "127.0.0.2");
        assert_eq!(el.property::<i32>("port"), 6000);
        assert!(!set_if_exists(&el, "gibt-es-nicht", "1"));
    }
}
