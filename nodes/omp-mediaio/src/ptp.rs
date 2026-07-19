//! PTP-Zeitbasis (Kapitel 19 Teil 2, `docs/END-GOAL-FEATURES.md` §19.3a
//! Punkt 3, opt-in) — Feature `ptp`. Ersetzt die Pipeline-Clock durch
//! `gst_net::PtpClock` (echtes IEEE-1588-PTPv2, dieselbe Uhr, die
//! echte 2110-/AES67-Fremdgeräte für ihre Medien-Taktung nutzen) statt
//! des GStreamer-Standard-Systemtakts ("Free-Run"). Ohne PTP-Master im
//! Netz bleibt eine Pipeline weiterhin Free-Run-tauglich
//! (`ARCHITECTURE.md` §8) — dieses Modul erzwingt keine Synchronität,
//! es bietet sie nur an: `apply_ptp_clock` setzt die Clock sofort
//! (`Pipeline::use_clock`), auch wenn `wait_for_sync` noch nicht
//! erfolgreich war — GStreamers `GstPtpClock` schaltet automatisch auf
//! Free-Run-Verhalten der internen Systemuhr zurück, bis ein Master
//! gefunden wird, und dann nahtlos um (Standardverhalten von
//! `GstPtpClock`, kein Extra-Code hier nötig).
//!
//! In PIPELINE CONTROLLER blieb der analoge Pfad (`ptp-generic` in
//! `lib/ClockStrategy.js`) ein Stub, weil gst-kit keine Clock-API
//! anbietet (`docs/END-GOAL-FEATURES.md` §19.2) — diese Blockade
//! existiert hier nicht: `gstreamer-rs` exponiert `Pipeline::use_clock`
//! und `gstreamer-net::PtpClock` vollständig.

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_net::PtpClock;

/// Baut eine `PtpClock` für `domain` (AES67/Dante-Pflichtprofil:
/// Domain 0, s. `st2110.rs`-Moduldoku zu AES67) und setzt sie sofort
/// als Pipeline-Clock — unabhängig davon, ob `wait_for_sync` innerhalb
/// von `sync_timeout` erfolgreich war (s. Moduldoku oben). Gibt die
/// Clock zurück, damit der Aufrufer `is_synced()`/`domain()` z. B. als
/// Node-Contract-Parameter weiterreichen kann (gleiches Prinzip wie
/// `media_ready`: ein echtes, abfragbares Signal statt "Pipeline läuft"
/// als stillschweigende Annahme).
pub fn apply_ptp_clock(pipeline: &gst::Pipeline, domain: u32, sync_timeout: gst::ClockTime) -> Result<PtpClock, String> {
    let clock = PtpClock::new(None, domain).map_err(|e| format!("PtpClock::new(domain={domain}): {e}"))?;

    if let Err(e) = clock.wait_for_sync(sync_timeout) {
        eprintln!(
            "omp-mediaio(ptp): Domain {domain} nicht innerhalb {sync_timeout} synchronisiert ({e}) — \
             Pipeline startet trotzdem im Free-Run, GStreamer übernimmt automatisch, sobald ein \
             PTP-Master gefunden wird"
        );
    }

    pipeline.use_clock(Some(&clock));
    Ok(clock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Echte Gegenprobe (Kapitel 19 Teil 2 Verifikationskriterium,
    /// `docs/END-GOAL-FEATURES.md` §19.4: "`ptp4l` als Software-Master
    /// ... Clock erreicht Synced-Zustand"): ein echter `ptp4l`-Prozess
    /// läuft als Software-Timestamping-Master, `GstPtpClock` muss
    /// echten Synced-Zustand erreichen. Zwei Betriebsarten:
    ///
    /// 1. **Default (Ein-Host):** `ptp4l` wird selbst gestartet, auf
    ///    demselben Interface wie `PtpClock::init`. Live entdeckt: das
    ///    scheitert in dieser Sandbox strukturell — `ptp4l` erreicht
    ///    real die Master-Rolle und sendet nachweislich korrekt
    ///    geformte Sync-Pakete (per unabhängigem Python-Multicast-Probe
    ///    auf `224.0.1.129:319` bestätigt: 0 Pakete auf demselben
    ///    Interface/derselben Netzwerk-Namespace wie Sender+Empfänger,
    ///    aber genau 1 Sync-Paket (`msgtype 0x00`), sobald Sender und
    ///    Empfänger in zwei per `veth` verbundenen echten
    ///    Netzwerk-Namespaces laufen) — vermutlich eine
    ///    `SO_BINDTODEVICE`+Multicast-Loopback-Eigenheit dieses
    ///    virtualisierten Netzwerkstacks beim Senden **und** Empfangen
    ///    über dasselbe Interface im selben Namespace, ohne
    ///    Paketmitschnitt-Werkzeuge (kein `tcpdump`/`strace` verfügbar)
    ///    nicht abschließend beweisbar. Deshalb schlägt dieser Modus
    ///    hier zuverlässig fehl — dokumentiertes Sandbox-Artefakt, kein
    ///    Code-Bug (reale PTP-Aufbauten haben ohnehin immer ≥2 echte
    ///    Hosts, ein Ein-Host-Test ist selbst schon ein Grenzfall).
    /// 2. **Externer Master** (`OMP_PTP_TEST_EXTERNAL_MASTER=1`,
    ///    `OMP_PTP_TEST_IFACE=<iface>`): erwartet einen bereits
    ///    laufenden `ptp4l`, typischerweise in einer separaten
    ///    Netzwerk-Namespace, per `veth`-Paar verbunden (zwei echte,
    ///    getrennte Netzwerk-Stacks — näher an einem echten
    ///    Mehr-Host-Aufbau als Modus 1). Damit **live bestätigt**: ein
    ///    `veth`-Paar zwischen zwei `ip netns` (`omp-ptp-a`/`-b`, je
    ///    eigenes, in die Namespace umbenanntes `eth0`) mit `ptp4l -i
    ///    eth0 -4 -S -m` in Namespace A und dieser Test mit
    ///    `OMP_PTP_TEST_EXTERNAL_MASTER=1 OMP_PTP_TEST_IFACE=eth0` per
    ///    `sudo ip netns exec omp-ptp-b` in Namespace B ausgeführt
    ///    erreicht echten `is_synced()==true`.
    ///
    /// `#[ignore]`, weil beide Modi `ptp4l`/`sudo`/`CAP_NET_BIND_SERVICE`
    /// voraussetzen; gezielt aufrufen mit `sudo -E cargo test -p
    /// omp-mediaio --features ptp ptp::tests::real_ptp4l_master_syncs_the_clock
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ptp4l_master_syncs_the_clock() {
        gst::init().expect("gst::init");

        let iface = std::env::var("OMP_PTP_TEST_IFACE").unwrap_or_else(|_| "eth0".to_string());
        let external_master = std::env::var("OMP_PTP_TEST_EXTERNAL_MASTER").is_ok();

        // Live entdeckt: `Stdio::piped()` ohne einen lesenden
        // Verbraucher blockiert `ptp4l`, sobald der (kleine, 64KiB-)
        // Pipe-Puffer voll läuft — bei `-m` (Log nach stdout) reicht
        // dafür bereits die normale Zustandsübergangs-Protokollierung.
        // `ptp4l` erbt hier stattdessen direkt stdout/stderr des
        // Testprozesses (sichtbar mit `--nocapture`, kein Blockierrisiko).
        let mut ptp4l = if external_master {
            None
        } else {
            Some(
                Command::new("ptp4l")
                    .args(["-i", &iface, "-4", "-S", "-m", "-l", "6"])
                    .spawn()
                    .expect("spawn ptp4l (im PATH, CAP_NET_BIND_SERVICE?)"),
            )
        };

        // Live entdeckt: `clock_id: None` lässt GStreamer eine
        // EUI-64-Kennung aus der MAC-Adresse des Interfaces ableiten —
        // im Ein-Host-Modus (Modus 1 oben) exakt dieselbe Adresse, aus
        // der `ptp4l` (derselbe Host/dasselbe Interface) seine eigene
        // Grandmaster-`clockIdentity` ableitet. Beide Identitäten
        // kollidierten dadurch (per `GST_DEBUG=ptp*:7` bestätigt:
        // identische `0x00163efffe19ea9e`-ID auf beiden Seiten) — PTP
        // verweigert laut Spec das Synchronisieren auf eine Quelle mit
        // der eigenen `clockIdentity`. Im Zwei-Namespace-Modus (Modus 2)
        // wäre das ohnehin unproblematisch (unterschiedliche
        // veth-MAC-Adressen), die feste `clock_id` schadet dort aber
        // nicht und hält den Test in beiden Modi identisch.
        PtpClock::init(Some(0x0000_0000_0000_0001), &[&iface]).expect("PtpClock::init");

        // ptp4l führt zunächst BMCA (Best-Master-Clock-Algorithmus) und
        // eine LISTENING-Phase durch, bevor es sich mangels Konkurrenz
        // selbst zum Master erklärt (live beobachtet: ca. 7s bis
        // "assuming the grand master role") — kein fester Schlaf nach
        // Prozessstart, sondern das GstPtpClock-eigene
        // `wait_for_sync`-Timeout unten deckt diese Anlaufzeit mit ab.
        let pipeline = gst::Pipeline::new();
        let clock = apply_ptp_clock(&pipeline, 0, gst::ClockTime::from_seconds(25)).expect("apply_ptp_clock");

        if let Some(mut ptp4l) = ptp4l.take() {
            let _ = ptp4l.kill();
            let _ = ptp4l.wait();
        }

        assert!(
            clock.is_synced(),
            "GstPtpClock sollte gegen den echten ptp4l-Master synchronisiert sein"
        );
    }
}
