//! `omp-srt-gateway` (`UMSETZUNG.md` D4, `ARCHITECTURE.md` §6):
//! bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) — Referenz-
//! Implementierung der in §6 beschriebenen Cloud-Gateway-Node.
//! Gerichtet je Instanz (`OMP_SRT_GATEWAY_DIRECTION=uplink|downlink`,
//! gleiches Muster wie `omp-player`s `OMP_PLAYER_PROFILE`), nicht
//! bidirektional in einem Prozess — mirrort die in `ARCHITECTURE.md`
//! §6.5 für NDI/RTSP-Gateways festgelegte Richtungs-Trennung.
//!
//! **Bewusst kein Live-Parameter/keine Methode:** Richtung/Endpunkte
//! sind Prozess-Start-Konfiguration (Env-Variablen), nicht zur Laufzeit
//! änderbar — ein Gateway ist hier als "einmal konfiguriert, dauerhaft
//! aktiv" modelliert (wie ein Hardware-Gateway), kein Cue/Take-Workflow
//! nötig. Der generische Parameter-Proxy (A8) bleibt trotzdem nutzbar
//! (readonly Status-Parameter), nur eben ohne Schreibpfad.

mod pipeline;

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, SetError};
use pipeline::{Config, Direction};
use serde_json::Value;

struct GatewayStore {
    direction: Direction,
    st2110_host: String,
    st2110_port: u16,
    srt_uri: String,
    /// AMWA BCP-008 (`docs/decisions.md` BCP-008-Nachtrag) — **bewusste
    /// Abweichung von den bisherigen vier BCP-008-Nodes:**
    /// `omp-srt-gateway` registriert gar keine NMOS-Sender/Receiver
    /// (`main()`s `NodeConfig{senders: vec![], receivers: vec![]}` unten
    /// — "reines Protokoll-zu-Protokoll-Gateway, kein MXL-Bezug",
    /// Moduldoku `pipeline.rs`), es gibt also keinen echten NMOS-
    /// Touchpoint, an den ein `NcReceiverMonitor`/`NcSenderMonitor` laut
    /// Spec eigentlich gehört. Trotzdem als generische `monitor.*`-
    /// Parameter exponiert (Nutzerentscheidung nach Rückfrage) — nur
    /// über OMPs eigene Param-API abrufbar, nicht über echtes
    /// NMOS-BCP-008-Tooling auffindbar. Immer aktiv (kein Enable/
    /// Disable-Konzept, Moduldoku: "einmal konfiguriert, dauerhaft
    /// aktiv"), `monitor.activate()` einmalig in `main()`, nie
    /// `deactivate()`.
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ParamStore for GatewayStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec {
                name: "direction".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "st2110Endpoint".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "srtUri".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!(match self.direction {
                Direction::Uplink => "uplink",
                Direction::Downlink => "downlink",
            })),
            "st2110Endpoint" => Some(serde_json::json!(format!(
                "{}:{}",
                self.st2110_host, self.st2110_port
            ))),
            "srtUri" => Some(serde_json::json!(self.srt_uri)),
            // Kein Rückkanal, der eine echte Zählerliste liefern würde
            // (die SRT-Statistik fließt hier direkt in die Domain-
            // Level, nicht in eine separate Zähler-Liste, s. `main()`s
            // Tick-Doku) — leere Liste statt erfundener Werte.
            _ => self.monitor.get("monitor", name, None, Vec::new),
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match self.monitor.set("monitor", name, &value) {
            Some(true) => Ok(()),
            Some(false) => Err(SetError::Unknown),
            None => Err(SetError::ReadOnly),
        }
    }

    fn invoke(&self, name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }
}

/// BCP-008-Tick — 1s-Kadenz, gleiche Begründung wie bei den anderen drei
/// Gateway-Nodes (`omp-2110-gateway`/`omp-decklink`/`omp-aes67-gateway`).
/// Anders als dort aber EIN Tick pro Prozess, der je nach `direction`
/// unterschiedliche Signalpaare liest (Uplink/Downlink betreiben
/// jeweils nur EINEN SRT-Endpunkt, s. `pipeline::ActiveEndpoint`) —
/// eine gemeinsame Funktion statt zwei fast identischer, weil beide
/// Zweige dieselben drei Domains (`link`/`activity`/`content`) über
/// dieselben `PipelineHandle`-Methoden füllen, nur mit vertauschten
/// Quellen.
///
/// **Domain-Zuordnung, bewusst nicht 1:1 mit den anderen Gateways:**
/// Uplink ist `MonitorKind::Sender` (er SENDET über SRT ins WAN, auch
/// wenn er lokal 2110 empfängt) — `essenceStatus` kommt vom LOKALEN
/// 2110-Empfangs-Jitterbuffer (ist der Inhalt, den wir senden WOLLEN,
/// überhaupt gültig?), `transmissionStatus` von `srtsink`s echter
/// SRT-Sendestatistik (kommt der Inhalt auch TATSÄCHLICH beim Peer an?
/// — `packets-sent-lost`/`packets-retransmitted`, echte, nicht
/// erfundene GStreamer-SRT-Plugin-Felder, live per Testpipeline
/// geprüft). Downlink ist `MonitorKind::Receiver` (er EMPFÄNGT über
/// SRT aus dem WAN) — `connectionStatus` vom lokalen, ZWISCHEN `srtsrc`
/// und dem Depayloader sitzenden `rtpjitterbuffer` (RTP-Ebene NACH der
/// SRT-Reassemblierung), `streamStatus` event-getrieben aus dem
/// `Event::Error`-Zweig unten (gleiche Begründung wie bei `omp-
/// decklink`/`omp-aes67-gateway`: die Ausgabeseiten-`has_flowed()` ist
/// "einmal wahr, bleibt wahr", kein brauchbares Dauersignal).
///
/// **Bewusst ausgeklammert:** `srtsrc`s eigentliche SRT-Empfangs-
/// statistik (Paketverlust/RTT) steckt im Listener-Modus in einer
/// verschachtelten `callers`-`GValueArray` (live per Testpipeline
/// bestätigt) — das Entpacken dieser Struktur in Rust wäre für den
/// Nutzen hier unverhältnismäßiger Aufwand; `linkStatus` nutzt
/// stattdessen nur das flache `bytes-received-total`-Feld (s.
/// `PipelineHandle::srt_receive_bytes_total`-Doku).
fn spawn_srt_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, pipeline: Arc<pipeline::PipelineHandle>, direction: Direction) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        let (mut prev_lost, mut prev_late) = pipeline.local_jitterbuffer_stats();
        let mut prev_link_bytes: u64 = match direction {
            Direction::Uplink => pipeline.srt_send_stats().map(|(bytes, _, _)| bytes).unwrap_or(0),
            Direction::Downlink => pipeline.srt_receive_bytes_total().unwrap_or(0),
        };
        let (mut prev_sent_lost, mut prev_retransmitted) = (0i32, 0i32);
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();

            let (lost, late) = pipeline.local_jitterbuffer_stats();
            let (delta_lost, delta_late) = (lost.saturating_sub(prev_lost), late.saturating_sub(prev_late));
            prev_lost = lost;
            prev_late = late;
            let jitter_level = if delta_lost > 0 {
                omp_node_sdk::HealthLevel::Unhealthy
            } else if delta_late > 0 {
                omp_node_sdk::HealthLevel::PartiallyHealthy
            } else {
                omp_node_sdk::HealthLevel::Healthy
            };

            match direction {
                Direction::Uplink => {
                    monitor.content.observe(
                        jitter_level,
                        delay,
                        Some(&format!("lokaler 2110-Empfang: {delta_lost} verlorene/{delta_late} verspätete Pakete seit dem letzten Tick")),
                    );
                    let (link_bytes, sent_lost, retransmitted) = pipeline.srt_send_stats().unwrap_or((0, 0, 0));
                    let link_level = if link_bytes > prev_link_bytes {
                        omp_node_sdk::HealthLevel::Healthy
                    } else {
                        omp_node_sdk::HealthLevel::Unhealthy
                    };
                    prev_link_bytes = link_bytes;
                    monitor.link.observe(link_level, delay, Some("srtsink sendet seit dem letzten Tick keine neuen Bytes (Peer getrennt?)"));

                    let delta_sent_lost = (sent_lost - prev_sent_lost).max(0);
                    let delta_retransmitted = (retransmitted - prev_retransmitted).max(0);
                    prev_sent_lost = sent_lost;
                    prev_retransmitted = retransmitted;
                    let transmission_level = if delta_sent_lost > 0 {
                        omp_node_sdk::HealthLevel::Unhealthy
                    } else if delta_retransmitted > 0 {
                        omp_node_sdk::HealthLevel::PartiallyHealthy
                    } else {
                        omp_node_sdk::HealthLevel::Healthy
                    };
                    monitor.activity.observe(
                        transmission_level,
                        delay,
                        Some(&format!("srtsink meldet {delta_sent_lost} verlorene/{delta_retransmitted} retransmittierte Pakete seit dem letzten Tick")),
                    );
                }
                Direction::Downlink => {
                    monitor.activity.observe(
                        jitter_level,
                        delay,
                        Some(&format!("lokaler RTP-Jitterbuffer nach SRT-Empfang: {delta_lost} verlorene/{delta_late} verspätete Pakete seit dem letzten Tick")),
                    );
                    let link_bytes = pipeline.srt_receive_bytes_total().unwrap_or(0);
                    let link_level = if link_bytes > prev_link_bytes {
                        omp_node_sdk::HealthLevel::Healthy
                    } else {
                        omp_node_sdk::HealthLevel::Unhealthy
                    };
                    prev_link_bytes = link_bytes;
                    monitor.link.observe(link_level, delay, Some("srtsrc empfängt seit dem letzten Tick keine neuen Bytes (Peer getrennt?)"));

                    monitor.content.observe(omp_node_sdk::HealthLevel::Healthy, delay, None);
                }
            }
        }
    });
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "SRT-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let direction = match env_or("OMP_SRT_GATEWAY_DIRECTION", "uplink").as_str() {
        "downlink" => Direction::Downlink,
        _ => Direction::Uplink,
    };
    // Uplink: st2110_host/port ist der lokale Empfangsport (st2110_host
    // wird dafür nicht gebraucht, bleibt aber Teil der Config-Struct für
    // beide Richtungen — einfacher als zwei Config-Typen).
    // Downlink: st2110_host/port ist das Ziel, an das der erzeugte
    // 2110-Strom geschickt wird.
    let st2110_host = env_or("OMP_SRT_GATEWAY_ST2110_HOST", "127.0.0.1");
    let st2110_port: u16 = env_or("OMP_SRT_GATEWAY_ST2110_PORT", "6000").parse()?;
    let srt_uri = env_or("OMP_SRT_GATEWAY_SRT_URI", "srt://127.0.0.1:7000");

    let cfg = Config {
        direction,
        st2110_host: st2110_host.clone(),
        st2110_port,
        srt_uri: srt_uri.clone(),
    };

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_handle = Arc::new(
        pipeline::build(&cfg, events_tx, pipeline_heartbeat.clone())
            .map_err(|e| format!("omp-srt-gateway: pipeline build failed: {e}"))?,
    );
    let media_ready_pipeline = pipeline_handle.clone();

    let monitor = Arc::new(omp_node_sdk::Monitor::new(match direction {
        Direction::Uplink => omp_node_sdk::MonitorKind::Sender,
        Direction::Downlink => omp_node_sdk::MonitorKind::Receiver,
    }));
    // Immer aktiv, kein Enable/Disable-Konzept (Moduldoku).
    monitor.activate();
    spawn_srt_monitor_tick(monitor.clone(), pipeline_handle.clone(), direction);

    let store: Arc<dyn ParamStore> = Arc::new(GatewayStore {
        direction,
        st2110_host,
        st2110_port,
        srt_uri,
        monitor: monitor.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): fragt den
            // jeweils aktiven 2110-Endpunkt (Uplink-Input oder
            // Downlink-Output, je nach Richtung) ab.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130/131).
    handle.register_worker("pipeline", pipeline_heartbeat);

    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-srt-gateway: pipeline error: {message}");
                    // Ein Bus-Fehler betrifft hier typischerweise die
                    // GANZE Pipeline (GStreamer-Fehler sind meist
                    // fatal) — sofort beide nicht-Link/Sync-Domains auf
                    // Unhealthy, statt nur eine zu raten (s.
                    // `spawn_srt_monitor_tick`-Doku).
                    let delay = monitor.status_reporting_delay();
                    monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&message));
                    monitor.content.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&message));
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-srt-gateway: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-srt-gateway: pipeline thread ended");
        }
    }

    pipeline_handle.shutdown();

    Ok(())
}

#[cfg(test)]
mod bcp008_tests {
    use super::*;

    // `GatewayStore` braucht keine echte Pipeline (alle Felder sind
    // einfache Werte) — direkt testbar, gleiches Muster wie
    // `omp-decklink::bcp008_tests`.
    fn store(direction: Direction) -> GatewayStore {
        GatewayStore {
            direction,
            st2110_host: "127.0.0.1".to_string(),
            st2110_port: 6000,
            srt_uri: "srt://127.0.0.1:7000".to_string(),
            monitor: Arc::new(omp_node_sdk::Monitor::new(match direction {
                Direction::Uplink => omp_node_sdk::MonitorKind::Sender,
                Direction::Downlink => omp_node_sdk::MonitorKind::Receiver,
            })),
        }
    }

    #[test]
    fn descriptor_includes_bcp008_monitor_params_and_methods_for_both_directions() {
        for direction in [Direction::Uplink, Direction::Downlink] {
            let d = store(direction).descriptor();
            let names: Vec<&str> = d.parameters.iter().map(|p| p.name.as_str()).collect();
            assert!(names.contains(&"monitor.overallStatus"));
            assert!(names.contains(&"monitor.linkStatus"));
            assert_eq!(d.methods.len(), 1);
            assert_eq!(d.methods[0].name, "monitor.resetCountersAndMessages");
        }
        let uplink_names: Vec<String> = store(Direction::Uplink).descriptor().parameters.into_iter().map(|p| p.name).collect();
        assert!(uplink_names.contains(&"monitor.transmissionStatus".to_string()));
        assert!(uplink_names.contains(&"monitor.essenceStatus".to_string()));
        let downlink_names: Vec<String> = store(Direction::Downlink).descriptor().parameters.into_iter().map(|p| p.name).collect();
        assert!(downlink_names.contains(&"monitor.connectionStatus".to_string()));
        assert!(downlink_names.contains(&"monitor.streamStatus".to_string()));
    }

    #[test]
    fn get_dispatches_monitor_params_alongside_own_params() {
        let s = store(Direction::Uplink);
        assert_eq!(s.get("direction"), Some(serde_json::json!("uplink")));
        s.monitor.activate();
        assert_eq!(s.get("monitor.overallStatus"), Some(serde_json::json!("Healthy")));
    }

    #[test]
    fn invoke_reset_clears_monitor_counters() {
        let s = store(Direction::Downlink);
        s.monitor.link.observe(omp_node_sdk::HealthLevel::Unhealthy, Duration::ZERO, Some("no bytes"));
        assert_eq!(s.monitor.link.transition_counter(), 1);
        assert!(s.invoke("monitor.resetCountersAndMessages", &serde_json::Map::new()).is_ok());
        assert_eq!(s.monitor.link.transition_counter(), 0);
        assert!(matches!(s.invoke("unknownMethod", &serde_json::Map::new()), Err(InvokeError::Unknown)));
    }
}
