//! Hochladen und Registrieren der wartenden Segmente (Spezifikation 8.2: `POST …/storage` → Object per PUT →
//! `POST …/segments`). Arbeitet die Warteschlange ([`crate::spool`]) in Zeitreihenfolge je Flow ab.
//!
//! Regeln:
//! * **Live-Kette nie blockieren:** der Uploader läuft auf eigenem Thread; Fehler führen nur zu Wartezeit (Rückstau).
//! * **Zeitachse:** Segmente eines Flows werden in Zeitreihenfolge registriert. Dauerhaft abgelehnte Segmente werden
//!   verworfen (Lücke), nie umgeschrieben.
//! * **Unklarer Ausgang** (Verbindung bricht nach dem Registrieren ab): vor jedem erneuten Versuch fragt der Uploader
//!   den Dienst, ob das Segment dort schon steht (`confirm_registered`), statt blind zu wiederholen.
//! * **ts_offset** kommt aus dem **tatsächlichen** ersten PTS der Datei: `ts_offset = Anfangszeit − PTS/90000`.

use crate::spool::{SegmentMeta, SlotMeta, Spool};
use omp_tams::client::{Client, Error, Registered, SegmentQuery};
use omp_tams::mpegts::{first_pts, ticks_to_ns};
use omp_tams::time::{TimeRange, Timestamp};
use omp_tams::types::{SegmentPost, StorageRequest};
use omp_tams::{VersionCheck, check_api_version};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Ein Flow, den der Schreiber im Speicher führt.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FlowDef {
    pub flow_id: String,
    /// Fertige Nutzlast für `PUT /flows/{id}`.
    pub body: serde_json::Value,
    /// MIME-Typ der Objects (Container des Flows).
    pub container: String,
}

/// Zähler und Zustand für Parameter und Alarme (alles ohne Sperre lesbar, außer dem letzten Fehlertext).
#[derive(Default, Debug)]
pub struct UploaderStatus {
    pub connected: AtomicBool,
    pub queue_segments: AtomicU32,
    pub queue_bytes: AtomicU64,
    pub registered: AtomicU64,
    /// Vom Dienst dauerhaft abgelehnt und verworfen.
    pub rejected: AtomicU64,
    /// Wegen Platzmangel verworfen (siehe [`Spool::enforce_limit`]).
    pub dropped_overflow: AtomicU64,
    pub errors: AtomicU64,
    /// Ende (TAI-ns) des zuletzt registrierten Segments.
    pub last_end_ns: AtomicU64,
    /// Abstand zwischen „jetzt“ und dem Ende des letzten registrierten Segments in ms (−1 = noch keines).
    pub lag_ms: AtomicI64,
    pub last_error: Mutex<String>,
}

impl UploaderStatus {
    pub fn set_error(&self, e: &str) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        *self.last_error.lock().expect("lock poisoned") = e.to_string();
    }
    pub fn error_text(&self) -> String {
        self.last_error.lock().expect("lock poisoned").clone()
    }
}

/// Ergebnis eines Durchgangs von [`Uploader::step`].
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Nichts zu tun.
    Idle,
    /// Ein Segment ist im Speicher.
    Registered,
    /// Ein Segment wurde dauerhaft abgelehnt und verworfen.
    Rejected(String),
    /// Vorübergehender Fehler: später erneut.
    Retry(String),
}

/// Die dem Uploader bekannten Flows. Neue kommen von `tams.start` (Aufnahme einer neuen Quelle) und werden mit
/// auf der Platte gemerkt, damit wartende Segmente früherer Aufnahmen nach einem Neustart angelegt werden können.
pub struct FlowRegistry {
    flows: Mutex<Vec<FlowDef>>,
    dirty: AtomicBool,
    spool: Arc<Spool>,
}

impl FlowRegistry {
    pub fn new(spool: Arc<Spool>, initial: Vec<FlowDef>) -> Arc<FlowRegistry> {
        let reg = Arc::new(FlowRegistry { flows: Mutex::new(Vec::new()), dirty: AtomicBool::new(true), spool: spool.clone() });
        for f in spool.load_flow_defs().into_iter().chain(initial) {
            reg.register(f);
        }
        reg
    }

    /// Flow merken (ersetzt einen gleichnamigen) und den Uploader anweisen, ihn im Dienst anzulegen.
    pub fn register(&self, def: FlowDef) {
        let mut g = self.flows.lock().expect("lock poisoned");
        match g.iter_mut().find(|f| f.flow_id == def.flow_id) {
            Some(f) => *f = def,
            None => g.push(def),
        }
        let _ = self.spool.save_flow_defs(&g);
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// IDs der Flows, die dieser Schreiber aufnimmt.
    pub fn flow_ids(&self) -> Vec<String> {
        self.flows.lock().expect("lock poisoned").iter().map(|f| f.flow_id.clone()).collect()
    }

    fn snapshot(&self) -> Vec<FlowDef> {
        self.flows.lock().expect("lock poisoned").clone()
    }
}

pub struct Uploader {
    client: Client,
    spool: Arc<Spool>,
    flows: Arc<FlowRegistry>,
    pub status: Arc<UploaderStatus>,
    flows_ready: bool,
    min_object_timeout_s: u64,
    now_tai_ns: Box<dyn Fn() -> u64 + Send>,
    /// Fragmentiertes MP4: schon registrierte Init-Objects je (Flow, Init-Datei) — Init-Segmente werden wiederverwendet (AppNote 0024).
    init_objects: std::collections::HashMap<(String, String), String>,
}

fn unix_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Uploader {
    pub fn new(client: Client, spool: Arc<Spool>, flows: Arc<FlowRegistry>, now_tai_ns: Box<dyn Fn() -> u64 + Send>) -> Uploader {
        Uploader { client, spool, flows, status: Arc::new(UploaderStatus { lag_ms: AtomicI64::new(-1), ..Default::default() }), flows_ready: false, min_object_timeout_s: 600, now_tai_ns, init_objects: Default::default() }
    }

    /// Dienst prüfen (Version, D-T4) und alle Flows anlegen. Muss nach jedem Verbindungsverlust erneut gelingen.
    fn ensure_flows(&mut self) -> Result<(), String> {
        let (info, check) = self.client.service().map_err(|e| e.to_string())?;
        if check == VersionCheck::NewerMinor {
            self.status.set_error(&format!("Dienst nutzt neuere Nebenversion {} (gebaut gegen {})", info.api_version, omp_tams::API_VERSION));
        }
        debug_assert!(!matches!(check_api_version(&info.api_version), VersionCheck::Reject(_)));
        // `min_object_timeout` ist ein Timestamp-String (Sekunden:Nanosekunden)
        if let Ok(t) = Timestamp::parse(&info.min_object_timeout) {
            self.min_object_timeout_s = (t.ns() / 1_000_000_000).max(1) as u64;
        }
        // Merker zuerst zurücknehmen: kommt während des Anlegens ein neuer Flow dazu, bleibt `dirty` gesetzt
        self.flows.dirty.store(false, Ordering::Relaxed);
        for f in self.flows.snapshot() {
            if let Err(e) = self.client.put_flow(&f.flow_id, &f.body) {
                self.flows.dirty.store(true, Ordering::Relaxed);
                return Err(format!("Flow {} anlegen: {e}", f.flow_id));
            }
        }
        self.flows_ready = true;
        self.status.connected.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn refresh_queue_status(&self) {
        let (n, b) = self.spool.usage();
        self.status.queue_segments.store(n, Ordering::Relaxed);
        self.status.queue_bytes.store(b, Ordering::Relaxed);
    }

    /// Ein Durchgang: das älteste wartende Segment bearbeiten.
    pub fn step(&mut self) -> Step {
        self.refresh_queue_status();
        let pending = self.spool.pending();
        let Some(mut seg) = pending.into_iter().next() else {
            return Step::Idle;
        };
        if self.flows.dirty.load(Ordering::Relaxed) {
            self.flows_ready = false;
        }
        if !self.flows_ready
            && let Err(e) = self.ensure_flows()
        {
            self.status.connected.store(false, Ordering::Relaxed);
            self.status.set_error(&e);
            return Step::Retry(e);
        }
        let Some(flow) = self.flows.snapshot().into_iter().find(|f| f.flow_id == seg.flow_id) else {
            self.spool.remove(&seg);
            let m = format!("Segment für unbekannten Flow {} verworfen", seg.flow_id);
            self.status.set_error(&m);
            return Step::Rejected(m);
        };
        let res = self.process(&mut seg, &flow);
        match &res {
            Step::Registered => {
                self.status.registered.fetch_add(1, Ordering::Relaxed);
                self.status.last_end_ns.fetch_max(seg.end_ns, Ordering::Relaxed);
                let now = (self.now_tai_ns)();
                self.status.lag_ms.store(now.saturating_sub(seg.end_ns) as i64 / 1_000_000, Ordering::Relaxed);
                self.status.connected.store(true, Ordering::Relaxed);
            }
            Step::Rejected(m) => {
                self.status.rejected.fetch_add(1, Ordering::Relaxed);
                self.status.set_error(m);
            }
            Step::Retry(m) => {
                self.status.set_error(m);
                // Verbindung gilt als gestört; die Flows werden beim nächsten Erfolg erneut angelegt (idempotent)
                self.status.connected.store(false, Ordering::Relaxed);
                self.flows_ready = false;
            }
            Step::Idle => {}
        }
        self.refresh_queue_status();
        res
    }

    fn process(&mut self, seg: &mut SegmentMeta, flow: &FlowDef) -> Step {
        let data = match std::fs::read(self.spool.file_path(&seg.file)) {
            Ok(d) => d,
            Err(_) => {
                self.spool.remove(seg);
                return Step::Rejected(format!("Segmentdatei {} fehlt", seg.file));
            }
        };
        // Container-Zeit des ersten Samples: MPEG-TS = erster PTS; fragmentiertes MP4 = (tfdt + Kompositionsversatz) / Zeitskala
        let init_bytes = match &seg.init_file {
            Some(f) => match std::fs::read(self.spool.file_path(f)) {
                Ok(b) => Some(b),
                Err(_) => {
                    self.spool.remove(seg);
                    return Step::Rejected(format!("Init-Segment {f} fehlt"));
                }
            },
            None => None,
        };
        let first_ns: i128 = match &init_bytes {
            Some(init) => match omp_tams::mp4::first_pts_ns(init, &data) {
                Some(n) => n,
                None => {
                    self.spool.remove(seg);
                    return Step::Rejected(format!("Segment {} enthält keine lesbare Zeit (kein gültiges fragmentiertes MP4)", seg.file));
                }
            },
            None => match first_pts(&data) {
                Some(pts) => ticks_to_ns(pts),
                None => {
                    self.spool.remove(seg);
                    return Step::Rejected(format!("Segment {} enthält keinen lesbaren PTS (kein gültiges MPEG-TS)", seg.file));
                }
            },
        };
        let ts_offset = Timestamp::from_ns(seg.start_ns as i128 - first_ns);
        let range = TimeRange::half_open(Timestamp::from_ns(seg.start_ns as i128), Timestamp::from_ns(seg.end_ns as i128));

        // Platz reservieren (oder den vorhandenen weiterverwenden, solange der Dienst ihn nicht verworfen hat)
        let slot_fresh = seg.slot.as_ref().is_some_and(|s| unix_s().saturating_sub(s.reserved_at) < self.min_object_timeout_s / 2);
        if !slot_fresh {
            match self.client.request_storage(&seg.flow_id, &StorageRequest { limit: Some(1), ..Default::default() }) {
                Ok(r) => match r.media_objects.into_iter().next() {
                    Some(o) => {
                        seg.slot = Some(SlotMeta { object_id: o.object_id, put_url: o.put_url, reserved_at: unix_s() });
                        let _ = self.spool.update(seg);
                    }
                    None => return Step::Retry("Dienst lieferte keinen Speicherplatz".into()),
                },
                Err(e) => return self.classify(seg, &range, e, "Speicher reservieren"),
            }
        }
        let slot = seg.slot.clone().expect("Platz gesetzt");
        let upload = omp_tams::types::MediaObjectSlot { object_id: slot.object_id.clone(), put_url: slot.put_url.clone(), presigned: false };
        if let Err(e) = self.client.upload_object(&upload, &flow.container, &data) {
            // 403/404 auf eine alte Adresse: Platz verwerfen, beim nächsten Versuch neu reservieren
            if matches!(e.status(), Some(403 | 404)) {
                seg.slot = None;
                let _ = self.spool.update(seg);
            }
            return self.classify(seg, &range, e, "Object hochladen");
        }
        // Fragmentiertes MP4: Init-Segment einmal hochladen und wiederverwenden (AppNote 0024)
        let mut new_init: Option<((String, String), String)> = None;
        let init_object_id = match (&seg.init_file, &init_bytes) {
            (Some(f), Some(bytes)) => {
                let key = (seg.flow_id.clone(), f.clone());
                match self.init_objects.get(&key) {
                    Some(id) => Some(id.clone()),
                    None => {
                        let slots = match self.client.request_storage(&seg.flow_id, &StorageRequest { limit: Some(1), ..Default::default() }) {
                            Ok(r) => r,
                            Err(e) => return self.classify(seg, &range, e, "Speicher für Init-Segment reservieren"),
                        };
                        let Some(o) = slots.media_objects.into_iter().next() else { return Step::Retry("Dienst lieferte keinen Speicherplatz für das Init-Segment".into()) };
                        if let Err(e) = self.client.upload_object(&o, &flow.container, bytes) {
                            return self.classify(seg, &range, e, "Init-Segment hochladen");
                        }
                        new_init = Some((key, o.object_id.clone()));
                        Some(o.object_id)
                    }
                }
            }
            _ => None,
        };
        let post = SegmentPost {
            object_id: slot.object_id.clone(),
            timerange: range.to_string(),
            ts_offset: Some(ts_offset.to_string()),
            object_timerange: None,
            last_duration: None,
            sample_offset: None,
            sample_count: None,
            key_frame_count: Some(seg.key_frame_count),
            init_object_id: init_object_id.clone(),
        };
        match self.client.register_segments(&seg.flow_id, std::slice::from_ref(&post)) {
            Ok(Registered::All) => {
                if let Some((k, id)) = new_init {
                    self.init_objects.insert(k, id); // erst jetzt gilt es als verwendet (sonst verwirft der Dienst es nach dem Timeout)
                }
                self.spool.remove(seg);
                Step::Registered
            }
            Ok(Registered::Partial(bf)) => {
                // Der Dienst hat dieses Segment abgelehnt (z. B. Überlappung): wiederholen ändert nichts
                if self.confirm_registered(seg, &slot.object_id, &range) {
                    self.spool.remove(seg);
                    return Step::Registered;
                }
                let why = bf.failed_segments.first().and_then(|f| f.error.as_ref()).and_then(|e| e.get("summary")).and_then(|s| s.as_str()).unwrap_or("ohne Angabe").to_string();
                self.spool.remove(seg);
                Step::Rejected(format!("Segment {range} abgelehnt: {why}"))
            }
            Err(e) => self.classify(seg, &range, e, "Segment registrieren"),
        }
    }

    /// Fehler einordnen: dauerhaft (verwerfen), vorübergehend (später), oder „steht vielleicht schon dort“.
    fn classify(&mut self, seg: &SegmentMeta, range: &TimeRange, e: Error, what: &str) -> Step {
        let msg = format!("{what}: {e}");
        if let Some(slot) = &seg.slot
            && (e.is_retryable() || e.status() == Some(400))
            && self.confirm_registered(seg, &slot.object_id, range)
        {
            self.spool.remove(seg);
            return Step::Registered;
        }
        match e {
            // Version/Einstellung falsch: kein Verwerfen der Daten, Betreiber muss eingreifen
            Error::Version(_) | Error::Config(_) => Step::Retry(msg),
            ref er if er.is_retryable() => Step::Retry(msg),
            // 401/403: Rechte fehlen oder Flow schreibgeschützt → Daten behalten, Betreiber muss eingreifen
            Error::Status { code: 401 | 403, .. } => Step::Retry(msg),
            // 400/404/409/…: der Dienst lehnt genau dieses Segment ab
            Error::Status { .. } | Error::Protocol(_) => {
                self.spool.remove(seg);
                Step::Rejected(msg)
            }
            _ => Step::Retry(msg),
        }
    }

    /// Steht dieses Segment (gleiches Object) schon im Speicher?
    fn confirm_registered(&self, seg: &SegmentMeta, object_id: &str, range: &TimeRange) -> bool {
        let q = SegmentQuery { timerange: Some(*range), accept_get_urls: Some(vec![]), ..Default::default() };
        match self.client.list_segments(&seg.flow_id, &q, 1000) {
            Ok(list) => list.iter().any(|s| s.object_id == object_id),
            Err(_) => false,
        }
    }

    /// Arbeitsschleife für den eigenen Thread. Bei Fehlern Rückstau (0,5 s … 10 s), bei Leerlauf 200 ms Pause.
    pub fn run(mut self, shutdown: Arc<AtomicBool>) {
        let mut failures: u32 = 0;
        while !shutdown.load(Ordering::Relaxed) {
            match self.step() {
                Step::Idle => {
                    failures = 0;
                    sleep_interruptible(Duration::from_millis(200), &shutdown);
                }
                Step::Registered | Step::Rejected(_) => failures = 0,
                Step::Retry(m) => {
                    failures = failures.saturating_add(1);
                    eprintln!("omp-tams-writer: {m} (Versuch {failures})");
                    sleep_interruptible(Duration::from_millis(500).saturating_mul(1 << failures.min(5)).min(Duration::from_secs(10)), &shutdown);
                }
            }
        }
    }
}

fn sleep_interruptible(total: Duration, stop: &AtomicBool) {
    let mut left = total;
    while !left.is_zero() && !stop.load(Ordering::Relaxed) {
        let d = left.min(Duration::from_millis(100));
        std::thread::sleep(d);
        left -= d;
    }
}

#[allow(clippy::too_many_arguments)]
/// Nutzlast für einen Video-Flow (H.264 in MPEG-TS) — aus den Werten des MXL-Flows.
pub fn video_flow_body(flow_id: &str, source_id: &str, label: &str, width: u32, height: u32, rate_num: u32, rate_den: u32, interlace: Option<&str>, segment_s: u32, bitrate_kbps: u32) -> serde_json::Value {
    let mut ess = serde_json::json!({
        "frame_width": width, "frame_height": height,
        "frame_rate": if rate_den == 1 { serde_json::json!({"numerator": rate_num}) } else { serde_json::json!({"numerator": rate_num, "denominator": rate_den}) },
    });
    if let Some(i) = interlace {
        ess["interlace_mode"] = i.into();
    }
    serde_json::json!({
        "id": flow_id, "source_id": source_id, "label": label,
        "format": omp_tams::types::FORMAT_VIDEO, "codec": "video/h264", "container": omp_tams::types::CONTAINER_MPEGTS,
        "essence_parameters": ess,
        "segment_duration": {"numerator": segment_s},
        "avg_bit_rate": bitrate_kbps,
    })
}

/// Flow-Nutzlast auf fragmentiertes MP4 umstellen (Kapitel 105.3b, AppNote 0024): Container `video/mp4` bzw. `audio/mp4`,
/// `essence_parameters.init_segments = true` (jedes Segment verweist auf ein Init-Segment).
pub fn to_mp4_body(mut body: serde_json::Value, audio: bool) -> (serde_json::Value, String) {
    let container = if audio { "audio/mp4" } else { "video/mp4" };
    body["container"] = container.into();
    if let Some(ep) = body.get_mut("essence_parameters").and_then(|e| e.as_object_mut()) {
        ep.insert("init_segments".into(), true.into());
    }
    (body, container.to_string())
}

/// Nutzlast für einen Audio-Flow (AAC in MPEG-TS).
pub fn audio_flow_body(flow_id: &str, source_id: &str, label: &str, sample_rate: u32, channels: u32, segment_s: u32, bitrate_kbps: u32) -> serde_json::Value {
    serde_json::json!({
        "id": flow_id, "source_id": source_id, "label": label,
        "format": omp_tams::types::FORMAT_AUDIO, "codec": "audio/aac", "container": omp_tams::types::CONTAINER_MPEGTS,
        "essence_parameters": {"sample_rate": sample_rate, "channels": channels},
        "segment_duration": {"numerator": segment_s},
        "avg_bit_rate": bitrate_kbps,
    })
}
