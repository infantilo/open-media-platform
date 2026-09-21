//! WebRTC-Monitor (MXL → Smartphone), Nachtrag 240/243, Richtung `monitor`.
//!
//! Aufbau: EINE dauerhafte Pipeline. Die per IS-05 gewählten MXL-Quellen
//! (`MxlVideoInput`/`MxlAudioInput`) hängen an je einem festen `identity`
//! (`*_mid`) → `tee` → Dummy-Zweig (`fakesink`, hält die Pipeline auch
//! ohne Zuschauer am Laufen und den Quell-Reader nie im `not-linked`).
//! Eine IS-05-Umschaltung tauscht nur die Quelle chirurgisch aus
//! (Muster `omp-switcher`), eine WHEP-Sitzung hängt ihren eigenen Zweig
//! (`tee` → Encoder → RTP-Payloader → `webrtcbin`) an und baut ihn beim
//! Beenden wieder ab. Beides ist unabhängig: Quellwechsel unterbrechen die
//! Sitzung nicht, ein neuer Zuschauer braucht keinen Quellwechsel.
//!
//! Codec: Video H.264 (`x264enc`, zerolatency, keine B-Frames), Audio Opus
//! (10-ms-Frames). WHEP-Signalisierung wie WHIP in `pipeline.rs` selbst
//! gebaut (Nicht-Trickle), siehe dortige Moduldoku.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput};
use tokio::sync::mpsc::UnboundedSender;

use crate::pipeline::Event;

pub struct Config {
    pub domain: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub bitrate_kbps: u32,
}

/// Elemente einer WHEP-Sitzung samt angeforderten `tee`-Pads (zum
/// sauberen Abbau).
struct Session {
    webrtcbin: gst::Element,
    elements: Vec<gst::Element>,
    tee_pads: Vec<(gst::Element, gst::Pad)>,
}

pub struct Monitor {
    pipeline: gst::Pipeline,
    context: Arc<MxlContext>,
    video_mid: gst::Element,
    audio_mid: gst::Element,
    video_tee: gst::Element,
    audio_tee: gst::Element,
    video_input: Mutex<Option<MxlVideoInput>>,
    audio_input: Mutex<Option<MxlAudioInput>>,
    video_flowed: Arc<AtomicBool>,
    audio_flowed: Arc<AtomicBool>,
    session: Mutex<Option<Session>>,
    connection_state: Arc<Mutex<String>>,
    config: Config,
    pub heartbeat: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
}

fn make(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|e| format!("{name}: {e}"))
}

/// `tee → queue(leaky) → fakesink` — permanenter Abschluss, s. Moduldoku.
fn add_dummy_branch(pipeline: &gst::Pipeline, tee: &gst::Element) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .property_from_str("leaky", "downstream")
        .property("max-size-buffers", 2u32)
        .build()
        .map_err(|e| format!("queue: {e}"))?;
    // async=false: sonst hängt der Zustandswechsel der Pipeline ohne
    // Preroll-Daten (s. pipeline.rs / Nachtrag 241).
    let sink = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .property("async", false)
        .build()
        .map_err(|e| format!("fakesink: {e}"))?;
    pipeline
        .add_many([&queue, &sink])
        .map_err(|e| format!("add dummy: {e}"))?;
    let pad = tee.request_pad_simple("src_%u").ok_or("tee request pad")?;
    pad.link(&queue.static_pad("sink").ok_or("queue sink")?)
        .map_err(|e| format!("link dummy: {e:?}"))?;
    queue
        .link(&sink)
        .map_err(|e| format!("link dummy sink: {e}"))?;
    Ok(())
}

impl Monitor {
    pub fn new(config: Config, tx: UnboundedSender<Event>) -> Result<Arc<Self>, String> {
        gst::init().map_err(|e| format!("gst init failed: {e}"))?;
        let context = Arc::new(MxlContext::new(&config.domain)?);
        let pipeline = gst::Pipeline::new();

        let video_mid = make("identity")?;
        let audio_mid = make("identity")?;
        let video_tee = gst::ElementFactory::make("tee")
            .property("allow-not-linked", true)
            .build()
            .map_err(|e| format!("tee: {e}"))?;
        let audio_tee = gst::ElementFactory::make("tee")
            .property("allow-not-linked", true)
            .build()
            .map_err(|e| format!("tee: {e}"))?;
        pipeline
            .add_many([&video_mid, &audio_mid, &video_tee, &audio_tee])
            .map_err(|e| format!("pipeline add: {e}"))?;
        video_mid
            .link(&video_tee)
            .map_err(|e| format!("link video: {e}"))?;
        audio_mid
            .link(&audio_tee)
            .map_err(|e| format!("link audio: {e}"))?;
        add_dummy_branch(&pipeline, &video_tee)?;
        add_dummy_branch(&pipeline, &audio_tee)?;

        // "media-ready": echte Buffer aus der gewählten Quelle gesehen.
        let video_flowed = Arc::new(AtomicBool::new(false));
        let audio_flowed = Arc::new(AtomicBool::new(false));
        for (mid, flag) in [(&video_mid, &video_flowed), (&audio_mid, &audio_flowed)] {
            let flag = flag.clone();
            mid.static_pad("src").ok_or("identity src pad")?.add_probe(
                gst::PadProbeType::BUFFER,
                move |_, _| {
                    flag.store(true, Ordering::Relaxed);
                    gst::PadProbeReturn::Ok
                },
            );
        }

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("set state playing: {e}"))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let heartbeat = Arc::new(AtomicU64::new(0));
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
            context,
            video_mid,
            audio_mid,
            video_tee,
            audio_tee,
            video_input: Mutex::new(None),
            audio_input: Mutex::new(None),
            video_flowed,
            audio_flowed,
            session: Mutex::new(None),
            connection_state: Arc::new(Mutex::new("none".to_string())),
            config,
            heartbeat,
            shutdown,
        }))
    }

    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }

    pub fn audio_flowed(&self) -> bool {
        self.audio_flowed.load(Ordering::Relaxed)
    }

    pub fn connection_state(&self) -> String {
        self.connection_state.lock().expect("lock poisoned").clone()
    }

    pub fn bitrate_kbps(&self) -> u32 {
        self.config.bitrate_kbps
    }

    // ---- Quellwahl (IS-05) --------------------------------------------

    pub fn connect_video(&self, flow_id: &str) -> Result<(), String> {
        self.disconnect_video();
        let input = MxlVideoInput::new(&self.pipeline, self.context.clone(), flow_id)?;
        input
            .tail
            .link(&self.video_mid)
            .map_err(|e| format!("link video input: {e}"))?;
        self.video_flowed.store(false, Ordering::Relaxed);
        *self.video_input.lock().expect("lock poisoned") = Some(input);
        Ok(())
    }

    pub fn disconnect_video(&self) {
        if let Some(input) = self.video_input.lock().expect("lock poisoned").take() {
            // stop() vor dem Entfernen, sonst pusht der Reader-Thread noch
            // gegen ein auf Null gesetztes Element (s. omp-switcher).
            input.stop();
            std::thread::sleep(Duration::from_millis(20));
            for el in &input.elements {
                let _ = el.set_state(gst::State::Null);
                let _ = self.pipeline.remove(el);
            }
        }
        self.video_flowed.store(false, Ordering::Relaxed);
    }

    pub fn connect_audio(&self, flow_id: &str) -> Result<(), String> {
        self.disconnect_audio();
        let input = MxlAudioInput::new(&self.pipeline, self.context.clone(), flow_id)?;
        input
            .tail
            .link(&self.audio_mid)
            .map_err(|e| format!("link audio input: {e}"))?;
        self.audio_flowed.store(false, Ordering::Relaxed);
        *self.audio_input.lock().expect("lock poisoned") = Some(input);
        Ok(())
    }

    pub fn disconnect_audio(&self) {
        if let Some(input) = self.audio_input.lock().expect("lock poisoned").take() {
            input.stop();
            std::thread::sleep(Duration::from_millis(20));
            for el in &input.elements {
                let _ = el.set_state(gst::State::Null);
                let _ = self.pipeline.remove(el);
            }
        }
        self.audio_flowed.store(false, Ordering::Relaxed);
    }

    // ---- WHEP-Sitzung -------------------------------------------------

    pub fn teardown(&self) {
        let Some(session) = self.session.lock().expect("lock poisoned").take() else {
            return;
        };
        let _ = session.webrtcbin.set_state(gst::State::Null);
        for el in &session.elements {
            let _ = el.set_state(gst::State::Null);
        }
        for (tee, pad) in &session.tee_pads {
            tee.release_request_pad(pad);
        }
        for el in &session.elements {
            let _ = self.pipeline.remove(el);
        }
        let _ = self.pipeline.remove(&session.webrtcbin);
        *self.connection_state.lock().expect("lock poisoned") = "none".to_string();
    }

    /// WHEP: SDP-Offer des Browsers (recvonly) → SDP-Answer (sendonly).
    pub fn whep_offer(&self, offer_sdp: &str) -> Result<String, String> {
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
            .build()
            .map_err(|e| format!("webrtcbin: {e}"))?;
        crate::ice::configure(&webrtcbin);
        self.pipeline
            .add(&webrtcbin)
            .map_err(|e| format!("add webrtcbin: {e}"))?;
        webrtcbin
            .sync_state_with_parent()
            .map_err(|e| format!("webrtcbin sync: {e}"))?;
        {
            let state = self.connection_state.clone();
            webrtcbin.connect_notify(Some("connection-state"), move |el, _| {
                let s = el.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state");
                *state.lock().expect("lock poisoned") = format!("{s:?}").to_lowercase();
            });
        }
        *self.session.lock().expect("lock poisoned") = Some(Session {
            webrtcbin: webrtcbin.clone(),
            elements: Vec::new(),
            tee_pads: Vec::new(),
        });

        let result = self
            .negotiate(&webrtcbin, offer, offer_sdp, &media_kinds)
            .map(|sdp| crate::ice::rewrite_candidates(&sdp));
        if result.is_err() {
            self.teardown();
        }
        result
    }

    fn negotiate(
        &self,
        webrtcbin: &gst::Element,
        offer: gst_sdp::SDPMessage,
        offer_text: &str,
        kinds: &[String],
    ) -> Result<String, String> {
        // Generische Sende-Transceiver je m-Line (H.264 bzw. Opus ohne
        // Profil-Einschränkung) VOR set-remote-description. Die Pads der
        // Encoder-Zweige (unten) werden MIT Caps angefordert und docken so
        // an den unassoziierten Transceiver der gleichen Art an. Nur
        // Pads mit Caps zu fordern (ohne add-transceiver) machte die
        // Video-m-Line `inactive`: das Profil des x264-Encoders passte
        // nicht zu den Offer-Profilen des Browsers.
        for kind in kinds {
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
                &[&gst_webrtc::WebRTCRTPTransceiverDirection::Sendonly, &caps],
            );
        }

        // Encoder-Zweige VOR der Aushandlung an die (jetzt vorhandenen)
        // Transceiver hängen: der Payload-Type kommt aus dem Offer (der
        // Browser bestimmt ihn; der erste passende Codec wird auch von
        // webrtcbin gewählt, das wird unten gegen die Antwort geprüft).
        // Live gefunden: Zweige NACH set-local-description anzuhängen ließ
        // jeden Zweig nach dem ersten Buffer im webrtcbin hängen.
        let video_pt = payload_type(offer_text, "H264");
        let audio_pt = payload_type(offer_text, "opus");
        for (mline, kind) in kinds.iter().enumerate() {
            match kind.as_str() {
                "video" => self.attach_video_branch(webrtcbin, video_pt.unwrap_or(102), mline)?,
                "audio" => self.attach_audio_branch(webrtcbin, audio_pt.unwrap_or(111), mline)?,
                _ => {}
            }
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
        let answer_text = answer
            .sdp()
            .as_text()
            .map_err(|e| format!("sdp as_text: {e}"))?;
        wait_promise(webrtcbin, "set-local-description", &answer)?;

        // Kontrolle: der vom Browser gewählte Payload-Type muss dem
        // entsprechen, mit dem die Zweige vorab gebaut wurden.
        for (name, pt) in [("H264", video_pt), ("opus", audio_pt)] {
            if let (Some(pt), Some(answered)) = (pt, payload_type(&answer_text, name))
                && pt != answered
            {
                return Err(format!(
                    "payload type mismatch for {name}: built {pt}, answered {answered}"
                ));
            }
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while webrtcbin.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state")
            != gst_webrtc::WebRTCICEGatheringState::Complete
        {
            if Instant::now() > deadline {
                return Err("ICE gathering timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        webrtcbin
            .property::<Option<gst_webrtc::WebRTCSessionDescription>>("local-description")
            .ok_or("no local description")?
            .sdp()
            .as_text()
            .map_err(|e| format!("sdp as_text: {e}"))
    }

    /// Hängt Elemente in die Pipeline, verkettet sie und hebt sie auf deren
    /// Zustand; merkt sie sich für den Abbau.
    fn add_chain(
        &self,
        chain: &[gst::Element],
        tee: &gst::Element,
        payloader_to: &gst::Element,
        rtp_caps: &gst::Caps,
        mline: usize,
    ) -> Result<(), String> {
        let refs: Vec<&gst::Element> = chain.iter().collect();
        self.pipeline
            .add_many(refs.iter().copied())
            .map_err(|e| format!("add chain: {e}"))?;
        gst::Element::link_many(refs.iter().copied()).map_err(|e| format!("link chain: {e}"))?;
        let tee_pad = tee.request_pad_simple("src_%u").ok_or("tee request pad")?;
        tee_pad
            .link(&chain[0].static_pad("sink").ok_or("chain sink pad")?)
            .map_err(|e| format!("link tee: {e:?}"))?;
        // Pad MIT Caps anfordern: das legt den (Sende-)Transceiver der
        // passenden Art an, den `set-remote-description` danach mit der
        // m-Line des Offers zusammenführt. Mit `add-transceiver` +
        // `request_pad_simple` entstanden dagegen zusätzliche, nie
        // ausgehandelte Transceiver (mline -1) und die Pads blieben
        // für immer geblockt (live gefunden, Nachtrag 243).
        let tmpl = payloader_to
            .pad_template("sink_%u")
            .ok_or("webrtcbin sink template")?;
        let web_pad = payloader_to
            .request_pad(&tmpl, Some(&format!("sink_{mline}")), Some(rtp_caps))
            .ok_or("webrtcbin request sink pad")?;
        chain
            .last()
            .and_then(|p| p.static_pad("src"))
            .ok_or("payloader src pad")?
            .link(&web_pad)
            .map_err(|e| format!("link webrtcbin: {e:?}"))?;
        for el in chain {
            el.sync_state_with_parent()
                .map_err(|e| format!("sync chain: {e}"))?;
        }
        let mut guard = self.session.lock().expect("lock poisoned");
        let session = guard.as_mut().ok_or("session vanished")?;
        session.elements.extend(chain.iter().cloned());
        session.tee_pads.push((tee.clone(), tee_pad));
        Ok(())
    }

    fn attach_video_branch(
        &self,
        webrtcbin: &gst::Element,
        pt: u32,
        mline: usize,
    ) -> Result<(), String> {
        let c = &self.config;
        let raw_caps = gst::Caps::builder("video/x-raw")
            .field("format", "I420")
            .field("width", c.width as i32)
            .field("height", c.height as i32)
            .field(
                "framerate",
                gst::Fraction::new(c.fps_num as i32, c.fps_den as i32),
            )
            .build();
        let fps = (c.fps_num / c.fps_den.max(1)).max(1);
        let chain = vec![
            gst::ElementFactory::make("queue")
                .property_from_str("leaky", "downstream")
                .property("max-size-buffers", 3u32)
                .build()
                .map_err(|e| format!("queue: {e}"))?,
            make("videoconvert")?,
            make("videoscale")?,
            make("videorate")?,
            gst::ElementFactory::make("capsfilter")
                .property("caps", &raw_caps)
                .build()
                .map_err(|e| format!("capsfilter: {e}"))?,
            gst::ElementFactory::make("x264enc")
                .property_from_str("tune", "zerolatency")
                .property_from_str("speed-preset", "ultrafast")
                .property("bitrate", c.bitrate_kbps)
                .property("key-int-max", fps * 2)
                .property("bframes", 0u32)
                .build()
                .map_err(|e| format!("x264enc: {e}"))?,
            gst::ElementFactory::make("rtph264pay")
                .property("pt", pt)
                .property("config-interval", -1i32)
                .build()
                .map_err(|e| format!("rtph264pay: {e}"))?,
        ];
        // Der Payloader meldet `profile-level-id`/`sprop-parameter-sets`
        // des x264-Streams (z. B. 42c01f) in seinen Caps; webrtcbin
        // gleicht diese exakt mit den Profilen des Browser-Offers ab
        // (42e01f/42001f/...) und ließ die Video-m-Line sonst
        // unbeantwortet (Transceiver ohne Treffer, kein RTP). SPS/PPS
        // kommen ohnehin inline (`config-interval=-1`), also die Felder
        // aus dem Caps-Event streichen.
        if let Some(pad) = chain.last().and_then(|p| p.static_pad("src")) {
            pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, |_, info| {
                if let Some(gst::PadProbeData::Event(ev)) = &info.data
                    && let gst::EventView::Caps(c) = ev.view()
                {
                    let mut caps = c.caps().to_owned();
                    if let Some(s) = caps.make_mut().structure_mut(0) {
                        s.remove_fields(["profile-level-id", "sprop-parameter-sets", "profile"]);
                    }
                    info.data = Some(gst::PadProbeData::Event(gst::event::Caps::new(&caps)));
                }
                gst::PadProbeReturn::Ok
            });
        }
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "video")
            .field("encoding-name", "H264")
            .field("clock-rate", 90000i32)
            .field("payload", pt as i32)
            .build();
        self.add_chain(&chain, &self.video_tee, webrtcbin, &rtp_caps, mline)
    }

    fn attach_audio_branch(
        &self,
        webrtcbin: &gst::Element,
        pt: u32,
        mline: usize,
    ) -> Result<(), String> {
        let raw_caps = gst::Caps::builder("audio/x-raw")
            .field("rate", self.config.sample_rate as i32)
            .field("channels", self.config.channels as i32)
            .build();
        let chain = vec![
            gst::ElementFactory::make("queue")
                .property_from_str("leaky", "downstream")
                .property("max-size-buffers", 8u32)
                .build()
                .map_err(|e| format!("queue: {e}"))?,
            make("audioconvert")?,
            make("audioresample")?,
            gst::ElementFactory::make("capsfilter")
                .property("caps", &raw_caps)
                .build()
                .map_err(|e| format!("capsfilter: {e}"))?,
            gst::ElementFactory::make("opusenc")
                .property_from_str("frame-size", "10")
                .build()
                .map_err(|e| format!("opusenc: {e}"))?,
            gst::ElementFactory::make("rtpopuspay")
                .property("pt", pt)
                .build()
                .map_err(|e| format!("rtpopuspay: {e}"))?,
        ];
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "audio")
            .field("encoding-name", "OPUS")
            .field("clock-rate", 48000i32)
            .field("payload", pt as i32)
            .build();
        self.add_chain(&chain, &self.audio_tee, webrtcbin, &rtp_caps, mline)
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.teardown();
        self.disconnect_video();
        self.disconnect_audio();
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

/// Payload-Type des Codecs `name` (Groß-/Kleinschreibung egal) aus einem
/// SDP-Text (`a=rtpmap:<pt> <name>/<rate>`).
fn payload_type(sdp: &str, name: &str) -> Option<u32> {
    sdp.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("a=rtpmap:")?;
        let (pt, codec) = rest.split_once(' ')?;
        codec
            .to_ascii_lowercase()
            .starts_with(&format!("{}/", name.to_ascii_lowercase()))
            .then(|| pt.parse().ok())?
    })
}

#[cfg(test)]
mod tests {
    use super::payload_type;

    #[test]
    fn finds_payload_types_case_insensitively() {
        let sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 OPUS/48000/2\r\nm=video 9 X 102\r\na=rtpmap:102 H264/90000\r\n";
        assert_eq!(payload_type(sdp, "opus"), Some(111));
        assert_eq!(payload_type(sdp, "H264"), Some(102));
        assert_eq!(payload_type(sdp, "VP8"), None);
    }
}
