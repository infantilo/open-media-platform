//! `omp-scte35` (Kapitel 27 / P9.2, Spec §134): SCTE-35-Generator als eigener Node. Der Playout-
//! Automator plant (Child Event `SCTE35`), dieser Node kodiert und liefert die
//! `splice_info_section` — nicht im Playlist-Core.
//!
//! Methoden: `splice.out(durationMs?, eventId?, autoReturn?)`, `splice.in(eventId)`,
//! `splice.cancel(eventId)`, `signal(typeId, eventId?, durationMs?, upid?)`.
//! Ausgabe: Parameter `lastSection`/`lastBase64`/`history` und — wenn `OMP_SCTE35_UDP=host:port`
//! gesetzt ist — der rohe Abschnitt als UDP-Datagramm. Eine Einbettung in einen MXL-ANC- oder
//! Transportstrom-Ausgang ist NICHT Teil dieses Schritts (s. docs/PLAYOUT-AUTOMATION.md).

mod anc;
mod cue;
mod scte104;
mod splice;
mod ts;

use std::collections::VecDeque;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SetError};
use serde_json::{json, Value};

const HISTORY_MAX: usize = 50;

struct Scte35Store {
    history: Mutex<VecDeque<Value>>,
    next_event_id: AtomicU32,
    sent: AtomicU64,
    udp: Option<(UdpSocket, String)>,
}

impl Scte35Store {
    fn new(udp_target: Option<String>) -> Self {
        let udp = udp_target.filter(|t| !t.trim().is_empty()).and_then(|t| UdpSocket::bind("0.0.0.0:0").ok().map(|s| (s, t)));
        // Startwert aus der Uhr, damit Event-IDs nach Neustarts nicht kollidieren.
        let seed = (chrono::Utc::now().timestamp() as u32) & 0x00FF_FFFF;
        Scte35Store { history: Mutex::new(VecDeque::new()), next_event_id: AtomicU32::new(seed.max(1)), sent: AtomicU64::new(0), udp }
    }

    fn event_id(&self, args: &serde_json::Map<String, Value>) -> u32 {
        args.get("eventId").and_then(Value::as_u64).map(|v| v as u32).unwrap_or_else(|| self.next_event_id.fetch_add(1, Ordering::Relaxed))
    }

    fn emit(&self, kind: &str, event_id: u32, section: Vec<u8>, summary: String) -> Result<(), InvokeError> {
        // Jede erzeugte Zeile wird vor dem Ausliefern wieder geparst und geprüft.
        splice::parse(&section).map_err(|e| InvokeError::Message(format!("interner Kodierfehler: {e}")))?;
        let mut udp_note = Value::Null;
        if let Some((sock, target)) = &self.udp {
            udp_note = match sock.send_to(&section, target) {
                Ok(n) => json!(format!("{n} Byte an {target}")),
                Err(e) => json!(format!("UDP-Fehler: {e}")),
            };
        }
        let rec = json!({
            "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "kind": kind, "eventId": event_id, "summary": summary,
            "hex": splice::to_hex(&section), "base64": splice::to_base64(&section), "udp": udp_note,
        });
        eprintln!("omp-scte35: {kind} eventId={event_id} {summary}");
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
                MethodSpec { name: "splice.out".to_string(), args: vec![n("durationMs"), n("eventId"), b("autoReturn")] },
                MethodSpec { name: "splice.in".to_string(), args: vec![n("eventId")] },
                MethodSpec { name: "splice.cancel".to_string(), args: vec![n("eventId")] },
                MethodSpec { name: "signal".to_string(), args: vec![n("typeId"), n("eventId"), n("durationMs"), t("upid")] },
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
            "output" => Some(json!(match &self.udp {
                Some((_, t)) => format!("Parameter + UDP → {t}"),
                None => "nur Parameter (OMP_SCTE35_UDP nicht gesetzt)".to_string(),
            })),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let msg = |e: String| InvokeError::Message(e);
        match name {
            "splice.out" => {
                let id = self.event_id(args);
                let duration = num(args, "durationMs").filter(|d| *d > 0);
                let auto_return = args.get("autoReturn").and_then(Value::as_bool).unwrap_or(true);
                let sec = splice::splice_insert(&splice::SpliceInsert { event_id: id, out_of_network: true, duration_ms: duration, auto_return, pts_90k: None, unique_program_id: 1, avail_num: 0, avails_expected: 0 }).map_err(msg)?;
                self.emit("splice_insert OUT", id, sec, format!("Out of Network, Dauer {} ms, Auto-Return {}", duration.map_or("—".to_string(), |d| d.to_string()), auto_return))
            }
            "splice.in" => {
                let id = num(args, "eventId").ok_or_else(|| msg("eventId fehlt (das Event, das beendet wird)".to_string()))? as u32;
                let sec = splice::splice_insert(&splice::SpliceInsert { event_id: id, out_of_network: false, duration_ms: None, auto_return: false, pts_90k: None, unique_program_id: 1, avail_num: 0, avails_expected: 0 }).map_err(msg)?;
                self.emit("splice_insert IN", id, sec, "Rückkehr ins Netz".to_string())
            }
            "splice.cancel" => {
                let id = num(args, "eventId").ok_or_else(|| msg("eventId fehlt".to_string()))? as u32;
                self.emit("splice_insert CANCEL", id, splice::splice_cancel(id), "Event zurückgenommen".to_string())
            }
            "signal" => {
                let id = self.event_id(args);
                let type_id = num(args, "typeId").filter(|t| *t <= 255).ok_or_else(|| msg("typeId (segmentation_type_id, 0…255) fehlt".to_string()))? as u8;
                let upid = args.get("upid").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec();
                let sec = splice::time_signal(&splice::Segmentation { event_id: id, type_id, duration_ms: num(args, "durationMs").filter(|d| *d > 0), upid_type: if upid.is_empty() { 0 } else { 1 }, upid, segment_num: 1, segments_expected: 1, pts_90k: None }).map_err(msg)?;
                self.emit("time_signal", id, sec, format!("segmentation_type_id 0x{type_id:02X}"))
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let store = Arc::new(Scte35Store::new(std::env::var("OMP_SCTE35_UDP").ok()));
    let _handle = omp_node_sdk::start(
        NodeConfig {
            label: env("OMP_LABEL", "SCTE-35"),
            host: env("OMP_HOST", "127.0.0.1"),
            port: std::env::var("OMP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0),
            registry_url: env("OMP_REGISTRY_URL", "http://127.0.0.1:8011"),
            nats_url: env("OMP_NATS_URL", "nats://127.0.0.1:4222"),
            senders: vec![],
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
