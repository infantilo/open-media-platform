//! `omp-scte35` (Kapitel 27 / P9.2, Kapitel 37): SCTE-35/-104-Generator als eigener Node. Der
//! Playout-Automator plant (Child Event `SCTE35`, automatische Werbeblöcke), dieser Node kodiert und
//! liefert den Marker — nicht im Playlist-Core.
//!
//! Methoden: `splice.out(durationMs?, eventId?, autoReturn?, inMs?)`, `splice.in(eventId, inMs?)`,
//! `splice.cancel(eventId)`, `signal(typeId, eventId?, durationMs?, upid?, inMs?)`. `inMs` = Abstand
//! bis zum Schnitt (Vorlauf); `atTaiNs` = absoluter Schnittzeitpunkt (MXL-TAI, Vorrang vor `inMs`);
//! ohne beides gilt der Marker als „sofort“.
//!
//! Ausgabewege (alle optional, Umgebungsvariablen):
//! - Parameter `lastSection`/`lastBase64`/`history` (immer) und `OMP_SCTE35_UDP=host:port` (roher Abschnitt).
//! - `OMP_SCTE35_TS=udp://host:port|srt://…` (+ `OMP_SCTE35_PID`, `OMP_SCTE35_REPEAT`): Sidecar-Transportstrom.
//! - `OMP_SCTE35_ANC=1`: SCTE 104 als ANC (`video/smpte291`) in einem MXL-Daten-Flow, als NMOS-Sender
//!   sichtbar (`OMP_SCTE35_RATE=25/1`, `OMP_SCTE35_ANC_LINE`, `OMP_SCTE35_ANC_OFFSET_FRAMES`,
//!   `OMP_SCTE35_ANC_REPEAT`, `OMP_SCTE35_FLOW_ID`).

// Prüf-/Lesefunktionen (Parser) dienen Tests und Selbstprüfung.
#![cfg_attr(not(test), allow(dead_code))]

mod anc;
mod cue;
mod output;
mod scte104;
mod splice;
mod ts;

use std::collections::VecDeque;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cue::Cue;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SenderSpec, SetError};
use serde_json::{json, Value};

const HISTORY_MAX: usize = 50;

struct Scte35Store {
    history: Mutex<VecDeque<Value>>,
    next_event_id: AtomicU32,
    sent: AtomicU64,
    udp: Option<(UdpSocket, String)>,
    clock: output::Clock,
    ts: Option<output::TsOutput>,
    anc: Option<output::AncOutput>,
    /// Beschreibung der aktiven Ausgänge (Anzeige).
    outputs: Vec<String>,
}

impl Scte35Store {
    #[cfg(test)]
    fn new(udp_target: Option<String>) -> Self {
        Self::with_outputs(udp_target, output::Clock::new(None), None, None)
    }

    fn with_outputs(udp_target: Option<String>, clock: output::Clock, ts: Option<output::TsOutput>, anc: Option<output::AncOutput>) -> Self {
        let udp = udp_target.filter(|t| !t.trim().is_empty()).and_then(|t| UdpSocket::bind("0.0.0.0:0").ok().map(|s| (s, t)));
        // Startwert aus der Uhr, damit Event-IDs nach Neustarts nicht kollidieren.
        let seed = (chrono::Utc::now().timestamp() as u32) & 0x00FF_FFFF;
        let mut outputs = vec!["Parameter".to_string()];
        if let Some((_, t)) = &udp {
            outputs.push(format!("UDP → {t}"));
        }
        if let Some(t) = &ts {
            outputs.push(format!("Transportstrom (PID {}) → {}", t.pid, t.uri));
        }
        if let Some(a) = &anc {
            outputs.push(format!("ANC/SCTE 104 → MXL-Flow {}", a.flow_id));
        }
        Scte35Store { history: Mutex::new(VecDeque::new()), next_event_id: AtomicU32::new(seed.max(1)), sent: AtomicU64::new(0), udp, clock, ts, anc, outputs }
    }

    fn event_id(&self, args: &serde_json::Map<String, Value>) -> u32 {
        args.get("eventId").and_then(Value::as_u64).map(|v| v as u32).unwrap_or_else(|| self.next_event_id.fetch_add(1, Ordering::Relaxed))
    }

    fn emit(&self, cue: Cue, at_ns: Option<u64>) -> Result<(), InvokeError> {
        let section = cue.to_scte35(self.clock.now_90k()).map_err(|e| InvokeError::Message(format!("Kodierfehler: {e}")))?;
        // Jede erzeugte Zeile wird vor dem Ausliefern wieder geparst und geprüft.
        splice::parse(&section).map_err(|e| InvokeError::Message(format!("interner Kodierfehler: {e}")))?;
        let mut udp_note = Value::Null;
        if let Some((sock, target)) = &self.udp {
            udp_note = match sock.send_to(&section, target) {
                Ok(n) => json!(format!("{n} Byte an {target}")),
                Err(e) => json!(format!("UDP-Fehler: {e}")),
            };
        }
        let ts_note = self.ts.as_ref().map(|t| {
            t.send_section(section.clone());
            format!("PID {}", t.pid)
        });
        let anc_note = self.anc.as_ref().map(|a| a.submit(&cue, at_ns));
        let rec = json!({
            "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "kind": cue.kind(), "eventId": cue.event_id(), "summary": cue.summary(), "leadMs": cue.lead_ms(),
            "hex": splice::to_hex(&section), "base64": splice::to_base64(&section), "udp": udp_note,
            "ts": ts_note, "anc": anc_note,
        });
        eprintln!("omp-scte35: {} eventId={} {}", cue.kind(), cue.event_id(), cue.summary());
        let mut h = self.history.lock().expect("lock poisoned");
        h.push_front(rec);
        h.truncate(HISTORY_MAX);
        self.sent.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

fn num(args: &serde_json::Map<String, Value>, k: &str) -> Option<u64> {
    args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}

impl ParamStore for Scte35Store {
    fn descriptor(&self) -> Descriptor {
        let ro = |name: &str| ParamSpec { name: name.to_string(), kind: ParamType::String, unit: None, range: None, readonly: true };
        let n = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::Number };
        let b = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::Boolean };
        let t = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::String };
        Descriptor {
            latency: None,
            parameters: vec![
                ro("lastSection"),
                ro("lastBase64"),
                ro("history"),
                ParamSpec { name: "eventsSent".to_string(), kind: ParamType::Number, unit: None, range: None, readonly: true },
                ro("output"),
            ],
            methods: vec![
                MethodSpec { name: "splice.out".to_string(), args: vec![n("durationMs"), n("eventId"), b("autoReturn"), n("inMs"), n("atTaiNs")] },
                MethodSpec { name: "splice.in".to_string(), args: vec![n("eventId"), n("inMs"), n("atTaiNs")] },
                MethodSpec { name: "splice.cancel".to_string(), args: vec![n("eventId")] },
                MethodSpec { name: "signal".to_string(), args: vec![n("typeId"), n("eventId"), n("durationMs"), t("upid"), n("inMs"), n("atTaiNs")] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let h = self.history.lock().expect("lock poisoned");
        match name {
            "lastSection" => Some(json!(h.front().and_then(|r| r["hex"].as_str()).unwrap_or(""))),
            "lastBase64" => Some(json!(h.front().and_then(|r| r["base64"].as_str()).unwrap_or(""))),
            "history" => Some(Value::Array(h.iter().cloned().collect())),
            "eventsSent" => Some(json!(self.sent.load(Ordering::Relaxed))),
            "output" => Some(json!(self.outputs.join(" · "))),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let msg = |e: String| InvokeError::Message(e);
        // Absoluter Schnittzeitpunkt (`atTaiNs`, MXL-TAI) hat Vorrang vor dem relativen Vorlauf `inMs`: er geht auf
        // dem Weg hierher nicht verloren (Laufzeit der Anfrage).
        let at_ns = args.get("atTaiNs").and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64))).filter(|a| *a > 0);
        let lead = match at_ns {
            Some(at) => at.saturating_sub(self.clock.now_ns()) / 1_000_000,
            None => num(args, "inMs").unwrap_or(0),
        };
        match name {
            "splice.out" => {
                let id = self.event_id(args);
                let duration = num(args, "durationMs").filter(|d| *d > 0);
                let auto_return = args.get("autoReturn").and_then(Value::as_bool).unwrap_or(true);
                self.emit(Cue::Out { event_id: id, duration_ms: duration, auto_return, lead_ms: lead }, at_ns)
            }
            "splice.in" => {
                let id = num(args, "eventId").ok_or_else(|| msg("eventId fehlt (das Event, das beendet wird)".to_string()))? as u32;
                self.emit(Cue::In { event_id: id, lead_ms: lead }, at_ns)
            }
            "splice.cancel" => {
                let id = num(args, "eventId").ok_or_else(|| msg("eventId fehlt".to_string()))? as u32;
                self.emit(Cue::Cancel { event_id: id }, None)
            }
            "signal" => {
                let id = self.event_id(args);
                let type_id = num(args, "typeId").filter(|t| *t <= 255).ok_or_else(|| msg("typeId (segmentation_type_id, 0…255) fehlt".to_string()))? as u8;
                let upid = args.get("upid").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec();
                self.emit(Cue::Signal { event_id: id, type_id, duration_ms: num(args, "durationMs").filter(|d| *d > 0), upid, lead_ms: lead }, at_ns)
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

/// Stabile, UUID-förmige Flow-ID aus dem Label (gleiche Instanz → gleiche ID, Verbindungen überleben Neustarts).
fn stable_flow_id(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    let h = |salt: u8| {
        let mut s = std::collections::hash_map::DefaultHasher::new();
        (salt, seed).hash(&mut s);
        s.finish()
    };
    let (a, b) = (h(1), h(2));
    format!("{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, a as u16 & 0xFFF, (b >> 52) as u16 & 0xFFF, b & 0xFFFF_FFFF_FFFF)
}

fn parse_rate(s: &str) -> Option<(u32, u32)> {
    let (n, d) = s.split_once('/').unwrap_or((s, "1"));
    let (n, d): (u32, u32) = (n.trim().parse().ok()?, d.trim().parse().ok()?);
    (n > 0 && d > 0).then_some((n, d))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let label = env("OMP_LABEL", "SCTE-35");
    let envn = |k: &str, d: i64| std::env::var(k).ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(d);

    // MXL-Kontext nur, wenn der ANC-Flow gewünscht ist (sonst kein libmxl nötig).
    let want_anc = std::env::var("OMP_SCTE35_ANC").is_ok_and(|v| v == "1");
    let mxl_ctx = if want_anc {
        match omp_mediaio::mxl::MxlContext::new(&env("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl")) {
            Ok(c) => Some(Arc::new(c)),
            Err(e) => {
                eprintln!("omp-scte35: ANC-Ausgang aus — MXL nicht verfügbar: {e}");
                None
            }
        }
    } else {
        None
    };
    let clock = output::Clock::new(mxl_ctx.clone());

    let ts_out = match std::env::var("OMP_SCTE35_TS").ok().filter(|u| !u.trim().is_empty()) {
        Some(uri) => match output::TsOutput::start(&uri, envn("OMP_SCTE35_PID", 500) as u16, envn("OMP_SCTE35_REPEAT", 3) as u32) {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("omp-scte35: Transportstrom-Ausgang aus — {e}");
                None
            }
        },
        None => None,
    };

    let mut senders = vec![];
    let mut anc_out = None;
    let rate = parse_rate(&env("OMP_SCTE35_RATE", "25/1")).unwrap_or((25, 1));
    if let Some(ctx) = mxl_ctx {
        let flow_id = std::env::var("OMP_SCTE35_FLOW_ID").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| stable_flow_id(&format!("{label}:{}", env("OMP_INSTANCE_ID", ""))));
        match output::AncOutput::start(ctx, &flow_id, &format!("{label} ANC"), rate, envn("OMP_SCTE35_ANC_LINE", 9) as u16, envn("OMP_SCTE35_ANC_OFFSET_FRAMES", 0), envn("OMP_SCTE35_ANC_REPEAT", 2) as u32) {
            Ok(a) => {
                senders.push(SenderSpec {
                    transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Data { id: Some(flow_id.clone()), grain_rate_numerator: rate.0, grain_rate_denominator: rate.1, did_sdid: vec![(anc::DID_SCTE104, anc::SDID_SCTE104)] }),
                    label: Some(format!("{label} ANC (SCTE 104)")),
                    ..Default::default()
                });
                anc_out = Some(a);
            }
            Err(e) => eprintln!("omp-scte35: ANC-Ausgang aus — {e}"),
        }
    }

    let store = Arc::new(Scte35Store::with_outputs(std::env::var("OMP_SCTE35_UDP").ok(), clock, ts_out, anc_out));
    let _handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host: env("OMP_HOST", "127.0.0.1"),
            port: std::env::var("OMP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0),
            registry_url: env("OMP_REGISTRY_URL", "http://127.0.0.1:8011"),
            nats_url: env("OMP_NATS_URL", "nats://127.0.0.1:4222"),
            senders,
            receivers: vec![],
            instance_id: std::env::var("OMP_INSTANCE_ID").ok(),
            media_ready: omp_node_sdk::MediaReadySource::NotApplicable,
        },
        store,
    )
    .await?;
    tokio::signal::ctrl_c().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn out_and_in_produce_valid_sections_and_history() {
        let s = Scte35Store::new(None);
        s.invoke("splice.out", &args(json!({"durationMs": 30000, "eventId": 42}))).unwrap();
        s.invoke("splice.in", &args(json!({"eventId": 42}))).unwrap();
        let h = s.get("history").unwrap();
        let h = h.as_array().unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0]["kind"], "splice_insert IN");
        let bytes = splice::from_base64(h[1]["base64"].as_str().unwrap()).unwrap();
        let p = splice::parse(&bytes).unwrap();
        assert_eq!((p.event_id, p.out_of_network, p.duration_ms), (Some(42), Some(true), Some(30000)));
        assert_eq!(s.get("eventsSent").unwrap(), 2);
    }

    #[test]
    fn auto_event_ids_increase_and_missing_args_are_rejected() {
        let s = Scte35Store::new(None);
        s.invoke("splice.out", &args(json!({}))).unwrap();
        s.invoke("splice.out", &args(json!({}))).unwrap();
        let h = s.get("history").unwrap();
        let ids: Vec<u64> = h.as_array().unwrap().iter().map(|r| r["eventId"].as_u64().unwrap()).collect();
        assert_eq!(ids[0], ids[1] + 1);
        assert!(s.invoke("splice.in", &args(json!({}))).is_err());
        assert!(s.invoke("signal", &args(json!({}))).is_err());
        assert!(matches!(s.invoke("nope", &args(json!({}))), Err(InvokeError::Unknown)));
    }

    #[test]
    fn udp_output_sends_the_raw_section() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let s = Scte35Store::new(Some(rx.local_addr().unwrap().to_string()));
        s.invoke("signal", &args(json!({"typeId": 0x34, "durationMs": 60000, "eventId": 5}))).unwrap();
        let mut buf = [0u8; 512];
        let n = rx.recv(&mut buf).unwrap();
        let p = splice::parse(&buf[..n]).unwrap();
        assert_eq!((p.command_type, p.event_id, p.segmentation_type_id), (0x06, Some(5), Some(0x34)));
    }
}
