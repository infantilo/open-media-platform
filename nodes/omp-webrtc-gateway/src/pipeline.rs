//! WebRTC-Ingest (Smartphone-Kamera → MXL), Nachtrag 240/241.
//!
//! Aufbau: EINE dauerhafte Pipeline mit den MXL-Ausgängen (Video + Audio)
//! und je einem `identity` als festem Andockpunkt davor. Jede WHIP-Sitzung
//! fügt ihr eigenes `webrtcbin` samt Depayloader/Decoder zur laufenden
//! Pipeline hinzu und entfernt es beim Beenden wieder — die MXL-Flows
//! bleiben dabei bestehen (kein Flow-Neuaufbau bei jedem Handy-Reconnect;
//! Mixer/Viewer, die den Flow schon kennen, sehen nur eine Pause).
//!
//! Codec: Video H.264 (Handys kodieren hardwarebeschleunigt), Audio Opus.
//! Die WHIP-Signalisierung (POST SDP-Offer → SDP-Answer) ist selbst
//! gebaut, weil die gst-plugins-rs-Elemente (`whipserversrc`) hier nicht
//! installiert sind. Nicht-Trickle: die Antwort enthält alle lokalen
//! ICE-Kandidaten (im LAN nach Millisekunden fertig).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;

pub enum Event {
    Error(String),
}

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub channels: u32,
    /// webrtcbin-Jitterbuffer in ms — der eigentliche Latenz-Regler
    /// (Default von webrtcbin: 200 ms, für LAN zu viel).
    pub latency_ms: u32,
}

/// Ein laufender WHIP-Peer: sein `webrtcbin` plus alle für ihn zur
/// Pipeline hinzugefügten Elemente (zum sauberen Entfernen).
struct Session {
    webrtcbin: gst::Element,
    elements: Arc<Mutex<Vec<gst::Element>>>,
}

pub struct Gateway {
    pipeline: gst::Pipeline,
    video_tail: gst::Element,
    audio_tail: gst::Element,
    _video_out: MxlVideoOutput,
    _audio_out: MxlAudioOutput,
    session: Mutex<Option<Session>>,
    connection_state: Arc<Mutex<String>>,
    latency_ms: u32,
    pub heartbeat: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
}

impl Gateway {
    pub fn new(config: Config, tx: UnboundedSender<Event>) -> Result<Arc<Self>, String> {
        gst::init().map_err(|e| format!("gst init failed: {e}"))?;
        let context = Arc::new(MxlContext::new(&config.domain)?);
        let pipeline = gst::Pipeline::new();

        let make = |name: &str| {
            gst::ElementFactory::make(name)
                .build()
                .map_err(|e| format!("{name}: {e}"))
        };
        let video_tail = make("identity")?;
        let audio_tail = make("identity")?;
        pipeline
            .add_many([&video_tail, &audio_tail])
            .map_err(|e| format!("pipeline add: {e}"))?;

        let video_out = MxlVideoOutput::new(
            &pipeline,
            &video_tail,
            context.clone(),
            &config.flow_id,
            &config.label,
            config.width,
            config.height,
            config.fps_num,
            config.fps_den,
            Arc::new(AtomicU64::new(0)),
        )?;
        video_out.set_active(true);
        let audio_out = MxlAudioOutput::new(
            &pipeline,
            &audio_tail,
            context,
            &config.audio_flow_id,
            &format!("{} Audio", config.label),
            config.sample_rate,
            config.channels,
        )?;
        audio_out.set_active(true);

        // Ohne eingehende Daten prerollen die MXL-Appsinks nie (der
        // Audio-Appsink in omp-mediaio ist bewusst `async`) — die Pipeline
        // bliebe bei einem ASYNC-Zustandswechsel in READY hängen, bekäme
        // keine Clock, und der webrtcbin-Jitterbuffer gäbe nie ein Bild
        // aus (live gefunden, Nachtrag 241). Deshalb hier (nicht in der
        // gemeinsamen Bibliothek) alle Appsinks auf `async=false`.
        for el in pipeline.iterate_elements().into_iter().flatten() {
            if el.factory().is_some_and(|f| f.name() == "appsink") {
                el.set_property("async", false);
            }
        }
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("set state playing: {e}"))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let heartbeat = Arc::new(AtomicU64::new(0));

        // Bus-Wächter ohne GLib-MainLoop: meldet Pipeline-Fehler und tickt
        // den Liveness-Heartbeat.
        let bus = pipeline.bus().ok_or("pipeline has no bus")?;
        {
            let shutdown = shutdown.clone();
            let heartbeat = heartbeat.clone();
            std::thread::spawn(move || {
                while !shutdown.load(Ordering::Relaxed) {
                    heartbeat.fetch_add(1, Ordering::Relaxed);
                    if let Some(msg) = bus.timed_pop_filtered(
                        gst::ClockTime::from_mseconds(500),
                        &[gst::MessageType::Error],
                    ) && let gst::MessageView::Error(err) = msg.view()
                    {
                        let _ = tx.send(Event::Error(format!(
                            "{}: {}",
                            err.src()
                                .map(|s| s.path_string().to_string())
                                .unwrap_or_default(),
                            err.error()
                        )));
                    }
                }
            });
        }

        Ok(Arc::new(Self {
            pipeline,
            video_tail,
            audio_tail,
            _video_out: video_out,
            _audio_out: audio_out,
            session: Mutex::new(None),
            connection_state: Arc::new(Mutex::new("none".to_string())),
            latency_ms: config.latency_ms,
            heartbeat,
            shutdown,
        }))
    }

    pub fn media_ready(&self) -> bool {
        self._video_out.flowed_handle().load(Ordering::Relaxed)
    }

    pub fn connection_state(&self) -> String {
        self.connection_state.lock().expect("lock poisoned").clone()
    }

    pub fn latency_ms(&self) -> u32 {
        self.latency_ms
    }

    /// Beendet die laufende Sitzung (falls vorhanden). Die MXL-Flows
    /// bleiben bestehen.
    pub fn teardown(&self) {
        let Some(session) = self.session.lock().expect("lock poisoned").take() else {
            return;
        };
        let _ = session.webrtcbin.set_state(gst::State::Null);
        for el in session.elements.lock().expect("lock poisoned").drain(..) {
            let _ = el.set_state(gst::State::Null);
            let _ = self.pipeline.remove(&el);
        }
        let _ = self.pipeline.remove(&session.webrtcbin);
        *self.connection_state.lock().expect("lock poisoned") = "none".to_string();
    }

    /// WHIP: nimmt ein SDP-Offer an und liefert das SDP-Answer. Eine
    /// bereits laufende Sitzung wird ersetzt (eine Kamera je Node).
    pub fn whip_offer(&self, offer_sdp: &str) -> Result<String, String> {
        self.teardown();

        let offer = gst_sdp::SDPMessage::parse_buffer(offer_sdp.as_bytes())
            .map_err(|_| "invalid SDP offer".to_string())?;
        let media_kinds: Vec<String> = (0..offer.medias_len())
            .map(|i| {
                offer
                    .media(i)
                    .and_then(|m| m.media())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();

        let webrtcbin = gst::ElementFactory::make("webrtcbin")
            .property_from_str("bundle-policy", "max-bundle")
            .property("latency", self.latency_ms)
            .build()
            .map_err(|e| format!("webrtcbin: {e}"))?;
        let elements: Arc<Mutex<Vec<gst::Element>>> = Arc::new(Mutex::new(Vec::new()));

        {
            let pipeline = self.pipeline.clone();
            let video_tail = self.video_tail.clone();
            let audio_tail = self.audio_tail.clone();
            let elements = elements.clone();
            webrtcbin.connect_pad_added(move |_, pad| {
                if pad.direction() != gst::PadDirection::Src {
                    return;
                }
                if let Err(e) =
                    attach_receive_chain(&pipeline, pad, &video_tail, &audio_tail, &elements)
                {
                    eprintln!("omp-webrtc-gateway: receive chain failed: {e}");
                }
            });
        }
        {
            let state = self.connection_state.clone();
            webrtcbin.connect_notify(Some("connection-state"), move |el, _| {
                let s = el.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state");
                *state.lock().expect("lock poisoned") = format!("{s:?}").to_lowercase();
            });
        }

        self.pipeline
            .add(&webrtcbin)
            .map_err(|e| format!("pipeline add webrtcbin: {e}"))?;
        webrtcbin
            .sync_state_with_parent()
            .map_err(|e| format!("webrtcbin sync state: {e}"))?;
        *self.session.lock().expect("lock poisoned") = Some(Session {
            webrtcbin: webrtcbin.clone(),
            elements,
        });

        let result = negotiate(&webrtcbin, offer, &media_kinds);
        if result.is_err() {
            self.teardown();
        }
        result
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.teardown();
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn wait_promise(
    webrtcbin: &gst::Element,
    signal: &str,
    desc: &gst_webrtc::WebRTCSessionDescription,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |_| {
        let _ = tx.send(());
    });
    webrtcbin.emit_by_name::<()>(signal, &[desc, &promise]);
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| format!("{signal} timed out"))
}

fn negotiate(
    webrtcbin: &gst::Element,
    offer: gst_sdp::SDPMessage,
    media_kinds: &[String],
) -> Result<String, String> {
    // Empfangs-Transceiver je m-Line VOR set-remote-description anlegen
    // (webrtcbin 1.22 legt sonst erst beim Answer welche an, ein
    // Codec-Wunsch griffe ins Leere): genau H.264 bzw. Opus, damit nichts
    // anderes ausgehandelt wird. Reihenfolge = m-Line-Reihenfolge.
    for kind in media_kinds {
        let caps = match kind.as_str() {
            "video" => gst::Caps::builder("application/x-rtp")
                .field("media", "video")
                .field("encoding-name", "H264")
                .field("clock-rate", 90000i32)
                .build(),
            "audio" => gst::Caps::builder("application/x-rtp")
                .field("media", "audio")
                .field("encoding-name", "OPUS")
                .field("clock-rate", 48000i32)
                .build(),
            other => return Err(format!("unsupported media in offer: {other}")),
        };
        let _tr = webrtcbin.emit_by_name::<gst_webrtc::WebRTCRTPTransceiver>(
            "add-transceiver",
            &[&gst_webrtc::WebRTCRTPTransceiverDirection::Recvonly, &caps],
        );
    }

    let offer_desc =
        gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, offer);
    wait_promise(webrtcbin, "set-remote-description", &offer_desc)?;

    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |reply| {
        let answer = reply
            .ok()
            .flatten()
            .and_then(|s| s.get::<gst_webrtc::WebRTCSessionDescription>("answer").ok());
        let _ = tx.send(answer);
    });
    webrtcbin.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "create-answer timed out".to_string())?
        .ok_or("create-answer returned no answer (no common codec? need H.264 + Opus)")?;
    wait_promise(webrtcbin, "set-local-description", &answer)?;

    // Nicht-Trickle: auf abgeschlossenes ICE-Gathering warten.
    let deadline = Instant::now() + Duration::from_secs(5);
    while webrtcbin.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state")
        != gst_webrtc::WebRTCICEGatheringState::Complete
    {
        if Instant::now() > deadline {
            return Err("ICE gathering timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let local = webrtcbin
        .property::<Option<gst_webrtc::WebRTCSessionDescription>>("local-description")
        .ok_or("no local description")?;
    local
        .sdp()
        .as_text()
        .map_err(|e| format!("sdp as_text: {e}"))
}

/// Hängt an einen neuen webrtcbin-Src-Pad die passende Empfangskette
/// (Depayloader → [Parser →] Decoder) und verbindet sie mit dem festen
/// Andockpunkt der MXL-Ausgänge.
fn attach_receive_chain(
    pipeline: &gst::Pipeline,
    pad: &gst::Pad,
    video_tail: &gst::Element,
    audio_tail: &gst::Element,
    elements: &Arc<Mutex<Vec<gst::Element>>>,
) -> Result<(), String> {
    let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
    let structure = caps.structure(0).ok_or("pad without caps")?;
    let media = structure
        .get::<&str>("media")
        .map_err(|e| format!("media: {e}"))?;

    let make = |name: &str| -> Result<gst::Element, String> {
        gst::ElementFactory::make(name)
            .build()
            .map_err(|e| format!("{name}: {e}"))
    };

    let (chain, tail): (Vec<gst::Element>, &gst::Element) = match media {
        "video" => (
            vec![
                make("rtph264depay")?,
                make("h264parse")?,
                // max-threads=1: Frame-Threading würde mehrere Bilder
                // Latenz einbauen.
                gst::ElementFactory::make("avdec_h264")
                    .property("max-threads", 1i32)
                    .build()
                    .map_err(|e| format!("avdec_h264: {e}"))?,
            ],
            video_tail,
        ),
        "audio" => (vec![make("rtpopusdepay")?, make("opusdec")?], audio_tail),
        other => return Err(format!("unsupported media {other}")),
    };

    let refs: Vec<&gst::Element> = chain.iter().collect();
    pipeline
        .add_many(refs.iter().copied())
        .map_err(|e| format!("add chain: {e}"))?;
    gst::Element::link_many(refs.iter().copied()).map_err(|e| format!("link chain: {e}"))?;
    chain
        .last()
        .expect("non-empty")
        .link(tail)
        .map_err(|e| format!("link tail: {e}"))?;
    for el in &chain {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync chain: {e}"))?;
    }
    let first_sink = chain[0]
        .static_pad("sink")
        .ok_or("depay without sink pad")?;
    pad.link(&first_sink)
        .map_err(|e| format!("link pad: {e:?}"))?;
    elements.lock().expect("lock poisoned").extend(chain);
    Ok(())
}
