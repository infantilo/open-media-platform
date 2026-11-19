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

/// Baut eine `PtpClock` für `domain` (AES67-Pflichtprofil:
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

/// RTP-Zeitstempel-Offset nach ST 2059-1 / ST 2110-10: der RTP-Zeitstempel ist die PTP-Zeit der Abtastung in Ticks der
/// Taktrate `rate_hz`, modulo 2^32. Ist `base_time_ns` die PTP-Zeit beim Laufzeit-Nullpunkt der Pipeline, dann gilt
/// `timestamp = offset + laufzeit·rate` mit genau diesem Offset.
pub fn st2059_rtp_offset(base_time_ns: u64, rate_hz: u32) -> u32 {
    ((base_time_ns as u128 * rate_hz as u128 / 1_000_000_000) & 0xFFFF_FFFF) as u32
}

/// Richtet die RTP-Zeitstempel der Payloader (`rtpvrawpay` 90 kHz, `rtpL24pay`/`rtpL16pay` mit der Abtastrate) einer
/// Sende-Pipeline nach ST 2059-1 aus: Die Basiszeit der Pipeline wird fest auf die aktuelle PTP-Zeit gesetzt
/// (`start_time = NONE` überlässt sie der Anwendung), `timestamp-offset` entsprechend berechnet. Ohne das trägt der RTP-Strom
/// einen zufälligen Zeitstempel-Ursprung, und Empfänger können Bild und Ton verschiedener Sender nicht über die PTP-Zeit
/// zuordnen. Vor dem Wechsel nach PLAYING aufrufen; `audio_rate` ist die Abtastrate der Audio-Payloader.
/// Läuft die Clock nicht synchron (`is_synced()` falsch), bleibt alles unverändert und der Fall wird zurückgemeldet (`Ok(false)`).
pub fn align_rtp_to_st2059(pipeline: &gst::Pipeline, clock: &PtpClock, audio_rate: u32) -> Result<bool, String> {
    if !clock.is_synced() {
        return Ok(false);
    }
    set_base_time_and_offsets(pipeline, clock.time(), audio_rate)
}

/// Kern von [`align_rtp_to_st2059`], von der Uhr getrennt (testbar mit der Systemuhr).
fn set_base_time_and_offsets(pipeline: &gst::Pipeline, now: gst::ClockTime, audio_rate: u32) -> Result<bool, String> {
    pipeline.set_start_time(gst::ClockTime::NONE);
    pipeline.set_base_time(now);
    let mut n = 0;
    for el in pipeline.iterate_recurse().into_iter().flatten() {
        let Some(factory) = el.factory() else { continue };
        let rate = match factory.name().as_str() {
            "rtpvrawpay" => 90_000,
            "rtpL24pay" | "rtpL16pay" => audio_rate,
            _ => continue,
        };
        el.set_property("timestamp-offset", st2059_rtp_offset(now.nseconds(), rate));
        n += 1;
    }
    if n == 0 {
        return Err("keine RTP-Payloader in der Pipeline gefunden".to_string());
    }
    Ok(true)
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

    #[test]
    fn st2059_offset_matches_the_definition() {
        // 1 s PTP-Zeit = 90000 Ticks; 2^32 Ticks / 90 kHz = 47721,858... s Umlauf
        assert_eq!(st2059_rtp_offset(1_000_000_000, 90_000), 90_000);
        assert_eq!(st2059_rtp_offset(0, 90_000), 0);
        let wrap_ns = ((1u128 << 32) * 1_000_000_000 / 90_000) as u64;
        let w = st2059_rtp_offset(wrap_ns, 90_000);
        assert!(w <= 1 || w >= u32::MAX - 1, "Umlauf: {w}"); // Rundung an der Wrap-Grenze
        // Audio: 48 kHz
        assert_eq!(st2059_rtp_offset(2_000_000_000, 48_000), 96_000);
        // Zeitpunkt grösser als 2^64/1e9-Bereich: keine Überlaufpanik (u128-Rechnung)
        let _ = st2059_rtp_offset(u64::MAX, 90_000);
    }

    /// Mit der Systemuhr als „PTP-Ersatz“: Der RTP-Zeitstempel des ersten Pakets muss der Uhrzeit × 90 kHz entsprechen.
    #[test]
    fn rtp_timestamps_follow_the_clock_after_alignment() {
        use std::sync::{Arc, Mutex};
        gst::init().unwrap();
        let clock = gst::SystemClock::obtain();
        let p = gst::parse::launch(
            "videotestsrc is-live=true num-buffers=3 ! video/x-raw,format=UYVY,width=64,height=36,framerate=25/1 ! rtpvrawpay name=pay ! fakesink name=sink sync=false",
        )
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        p.use_clock(Some(&clock));
        assert!(set_base_time_and_offsets(&p, clock.time(), 48_000).unwrap());
        let seen = Arc::new(Mutex::new(Vec::<(u32, u64)>::new()));
        let seen_p = seen.clone();
        let clock_p = clock.clone();
        p.by_name("sink").unwrap().static_pad("sink").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(b)) = &info.data
                && let Ok(map) = b.map_readable()
                && map.len() >= 12
            {
                // RTP-Kopf: Bytes 4..8 = Zeitstempel (Netzbyteordnung)
                let ts = u32::from_be_bytes([map[4], map[5], map[6], map[7]]);
                seen_p.lock().unwrap().push((ts, clock_p.time().nseconds()));
            }
            gst::PadProbeReturn::Ok
        });
        p.set_state(gst::State::Playing).unwrap();
        let bus = p.bus().unwrap();
        let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(10), &[gst::MessageType::Eos, gst::MessageType::Error]);
        p.set_state(gst::State::Null).unwrap();
        let seen = seen.lock().unwrap();
        assert!(!seen.is_empty());
        for (ts, now_ns) in seen.iter() {
            let expect = st2059_rtp_offset(*now_ns, 90_000);
            let diff = (*ts as i64 - expect as i64).rem_euclid(1 << 32);
            let diff = diff.min((1i64 << 32) - diff); // Umlauf
            assert!(diff < 90_000, "RTP-Zeitstempel {ts} weicht {diff} Ticks (>1 s) von der Uhr ab ({expect})");
        }
    }
}
