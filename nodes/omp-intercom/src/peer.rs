//! Ein WebRTC-Teilnehmerzugang (Kapitel 47.3): der Browser sendet das Angebot (Mikrofon + Datenkanal
//! `ctl`), der Node antwortet mit `sendrecv`-Audio (Opus) und nimmt den Datenkanal an.
//!
//! Die Pipeline je Teilnehmer ist **statisch** (webrtcbin ⇄ Opus ⇄ appsink/appsrc); alle Routen- und
//! Pegeländerungen passieren im Mix-Kern, nie hier.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;

use crate::mix::FRAME;

/// Höchstens so viele Frames Rückstau im Empfangspuffer (danach werden die ältesten verworfen).
const MAX_INBOX_FRAMES: usize = 4;

pub struct Peer {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    inbox: Arc<Mutex<VecDeque<f32>>>,
    state: Arc<Mutex<String>>,
    channel: Arc<Mutex<Option<gst_webrtc::WebRTCDataChannel>>>,
    pub rx_samples: Arc<AtomicU64>,
    pub underruns: AtomicU64,
    pub dropped: Arc<AtomicU64>,
    /// Mittlere Füllung des Eingangspuffers beim Abholen in Mikrosekunden Audio (gleitend).
    pub ring_us: AtomicU64,
    trim: Mutex<TrimState>,
    out_clock: Mutex<OutClock>,
    pub created: Instant,
}

/// Minimum-Fenster über den Rest im Eingangspuffer nach dem Abholen: bleibt dauerhaft ein Rest übrig, ist der
/// Puffer unnötig tief (Folge eines Bursts) und wird auf einen kleinen Rest gekürzt.
#[derive(Default)]
struct TrimState {
    ticks: u32,
    min_rest: usize,
}

/// Regelmäßige Ausgangszeitstempel (Mehrfaches von 20 ms), unabhängig vom Jitter des Taktthreads — sonst deutet
/// der Browser den Takt-Jitter als Netzjitter und vergrößert seinen Puffer.
#[derive(Default)]
struct OutClock {
    base_ns: Option<u64>,
    n: u64,
}

fn make(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"))
}

fn payload_type(sdp: &str, name: &str) -> Option<u32> {
    let needle = format!(" {}/", name.to_ascii_lowercase());
    sdp.lines().find_map(|l| {
        let rest = l.strip_prefix("a=rtpmap:")?;
        if rest.to_ascii_lowercase().contains(&needle) {
            rest.split(' ').next()?.parse().ok()
        } else {
            None
        }
    })
}

fn wait_promise(webrtcbin: &gst::Element, signal: &str, desc: &gst_webrtc::WebRTCSessionDescription) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |_| {
        let _ = tx.send(());
    });
    webrtcbin.emit_by_name::<()>(signal, &[desc, &promise]);
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| format!("{signal} timed out"))
}

impl Peer {
    /// Nimmt ein SDP-Angebot an. `on_message` bekommt jede Textnachricht des Datenkanals,
    /// `on_open` wird einmal gerufen, sobald der Datenkanal steht.
    pub fn answer(
        offer_sdp: &str,
        latency_ms: u32,
        on_message: Arc<dyn Fn(String) + Send + Sync>,
        on_open: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(Arc<Peer>, String), String> {
        let pt = payload_type(offer_sdp, "opus").ok_or("Angebot enthält kein Opus")?;
        let offer = gst_sdp::SDPMessage::parse_buffer(offer_sdp.as_bytes()).map_err(|_| "ungültiges SDP".to_string())?;

        let pipeline = gst::Pipeline::new();
        let webrtcbin = gst::ElementFactory::make("webrtcbin")
            .property_from_str("bundle-policy", "max-bundle")
            .property("latency", latency_ms)
            .build()
            .map_err(|e| format!("webrtcbin: {e}"))?;
        crate::ice::configure(&webrtcbin);

        // Sendezweig: appsrc (Stereo F32) → Opus → RTP → webrtcbin.
        let src_caps = gst::Caps::builder("audio/x-raw")
            .field("format", "F32LE")
            .field("layout", "interleaved")
            .field("rate", 48_000i32)
            .field("channels", 2i32)
            .field("channel-mask", gst::Bitmask::new(0x3))
            .build();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&src_caps)
            .format(gst::Format::Time)
            .is_live(true)
            .do_timestamp(false)
            .max_bytes((FRAME * 2 * 4 * 6) as u64)
            .build();
        appsrc.set_property_from_str("leaky-type", "downstream");
        // opusenc (GStreamer 1.22) nimmt nur S16LE: Wandlung hier, der Mix-Kern bleibt Float.
        let conv_out = make("audioconvert")?;
        let enc = make("opusenc")?;
        enc.set_property("bitrate", 48_000i32);
        enc.set_property_from_str("frame-size", "20");
        enc.set_property_from_str("audio-type", "voice");
        enc.set_property("inband-fec", true);
        enc.set_property("packet-loss-percentage", 5i32);
        let pay = make("rtpopuspay")?;
        pay.set_property("pt", pt);
        pipeline
            .add_many([appsrc.upcast_ref::<gst::Element>(), &conv_out, &enc, &pay, &webrtcbin])
            .map_err(|e| format!("pipeline add: {e}"))?;
        gst::Element::link_many([appsrc.upcast_ref::<gst::Element>(), &conv_out, &enc, &pay]).map_err(|e| format!("link: {e}"))?;

        // Sendrecv-Transceiver VOR dem Angebot, damit die Antwort `sendrecv` wird.
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "audio")
            .field("encoding-name", "OPUS")
            .field("clock-rate", 48_000i32)
            .field("payload", pt as i32)
            .field("encoding-params", "2")
            .build();
        let _tr = webrtcbin.emit_by_name::<gst_webrtc::WebRTCRTPTransceiver>(
            "add-transceiver",
            &[&gst_webrtc::WebRTCRTPTransceiverDirection::Sendrecv, &rtp_caps],
        );
        // Das Sende-Pad legt webrtcbin selbst an, sobald das Angebot dem Transceiver zugeordnet ist
        // (`pad-added` mit Richtung Sink) — ein eigener Pad-Request erzeugte einen zweiten Transceiver.

        let inbox = Arc::new(Mutex::new(VecDeque::<f32>::new()));
        let rx_samples = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let state = Arc::new(Mutex::new("new".to_string()));
        let channel: Arc<Mutex<Option<gst_webrtc::WebRTCDataChannel>>> = Arc::new(Mutex::new(None));

        // Empfangszweig: webrtcbin → Depay → Decoder → Mono F32 → appsink → Eingangspuffer.
        {
            let pipeline = pipeline.clone();
            let inbox = inbox.clone();
            let rx_samples = rx_samples.clone();
            let dropped = dropped.clone();
            let pay = pay.clone();
            webrtcbin.connect_pad_added(move |_, pad| {
                if pad.direction() == gst::PadDirection::Sink {
                    match pay.static_pad("src") {
                        Some(src) => {
                            if let Err(e) = src.link(pad) {
                                eprintln!("omp-intercom: Sendezweig nicht verbunden: {e:?}");
                            }
                        }
                        None => eprintln!("omp-intercom: rtpopuspay ohne src"),
                    }
                    return;
                }
                if let Err(e) = attach_receive(&pipeline, pad, &inbox, &rx_samples, &dropped) {
                    eprintln!("omp-intercom: Empfangszweig: {e}");
                }
            });
        }
        {
            let state = state.clone();
            webrtcbin.connect_notify(Some("connection-state"), move |el, _| {
                let s = el.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state");
                *state.lock().expect("lock poisoned") = format!("{s:?}").to_lowercase();
            });
        }
        {
            let channel = channel.clone();
            webrtcbin.connect("on-data-channel", false, move |values| {
                let dc = values[1].get::<gst_webrtc::WebRTCDataChannel>().ok()?;
                let on_message = on_message.clone();
                dc.connect_on_message_string(move |_, msg| {
                    if let Some(m) = msg {
                        on_message(m.to_string());
                    }
                });
                let on_open = on_open.clone();
                dc.connect_on_open(move |_| on_open());
                *channel.lock().expect("lock poisoned") = Some(dc);
                None
            });
        }

        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;

        let peer = Arc::new(Peer {
            pipeline: pipeline.clone(),
            appsrc,
            inbox,
            state,
            channel,
            rx_samples,
            underruns: AtomicU64::new(0),
            dropped,
            ring_us: AtomicU64::new(0),
            trim: Mutex::new(TrimState { ticks: 0, min_rest: usize::MAX }),
            out_clock: Mutex::new(OutClock::default()),
            created: Instant::now(),
        });

        let result = negotiate(&webrtcbin, offer).map(|sdp| crate::ice::rewrite_candidates(&sdp));
        match result {
            Ok(sdp) => Ok((peer, sdp)),
            Err(e) => {
                peer.close();
                Err(e)
            }
        }
    }

    pub fn state(&self) -> String {
        self.state.lock().expect("lock poisoned").clone()
    }

    pub fn connected(&self) -> bool {
        self.state() == "connected"
    }

    /// Ein Mono-Frame (960 Samples) vom Teilnehmer; `None` = noch nichts da (wird als Stille gemischt).
    pub fn pull_frame(&self) -> Option<Vec<f32>> {
        let mut q = self.inbox.lock().expect("lock poisoned");
        if q.len() < FRAME {
            if self.connected() {
                self.underruns.fetch_add(1, Ordering::Relaxed);
            }
            return None;
        }
        let fill_us = (q.len() as u64) * 1_000_000 / 48_000;
        let prev = self.ring_us.load(Ordering::Relaxed);
        self.ring_us.store((prev * 15 + fill_us) / 16, Ordering::Relaxed);
        if q.len() > FRAME * MAX_INBOX_FRAMES {
            let excess = q.len() - FRAME * 2;
            q.drain(..excess);
            self.dropped.fetch_add(excess as u64, Ordering::Relaxed);
        }
        let frame: Vec<f32> = q.drain(..FRAME).collect();
        let mut t = self.trim.lock().expect("lock poisoned");
        t.min_rest = t.min_rest.min(q.len());
        t.ticks += 1;
        if t.ticks >= 50 {
            // Ein Rest von mehr als ~7 ms über eine volle Sekunde ist ungenutzte Latenz.
            if t.min_rest > 320 {
                let cut = t.min_rest - 160;
                q.drain(..cut);
                self.dropped.fetch_add(cut as u64, Ordering::Relaxed);
            }
            t.ticks = 0;
            t.min_rest = usize::MAX;
        }
        Some(frame)
    }

    /// Ein Stereo-Frame zum Teilnehmer.
    pub fn push_frame(&self, left: &[f32], right: &[f32]) {
        if !self.connected() {
            return;
        }
        let mut bytes = Vec::with_capacity(FRAME * 8);
        for i in 0..FRAME {
            bytes.extend_from_slice(&left[i].to_le_bytes());
            bytes.extend_from_slice(&right[i].to_le_bytes());
        }
        let mut buffer = gst::Buffer::from_slice(bytes);
        {
            let now_ns = self.pipeline.current_running_time().map(|t| t.nseconds()).unwrap_or(0);
            let mut c = self.out_clock.lock().expect("lock poisoned");
            let step = 20_000_000u64;
            let base = *c.base_ns.get_or_insert(now_ns);
            let mut pts = base + c.n * step;
            // Bei einem Stau oder einer Lücke (> 3 Takte Abweichung) neu aufsetzen statt aufzuholen.
            if pts + 3 * step < now_ns || pts > now_ns + 3 * step {
                c.base_ns = Some(now_ns);
                c.n = 0;
                pts = now_ns;
            }
            c.n += 1;
            let b = buffer.get_mut().expect("neuer Puffer");
            b.set_pts(gst::ClockTime::from_nseconds(pts));
            b.set_duration(gst::ClockTime::from_nseconds(step));
        }
        let _ = self.appsrc.push_buffer(buffer);
    }

    pub fn send_text(&self, text: &str) {
        if let Some(dc) = self.channel.lock().expect("lock poisoned").as_ref() {
            if dc.ready_state() == gst_webrtc::WebRTCDataChannelState::Open {
                let _ = dc.send_string_full(Some(text));
            }
        }
    }

    /// Beendet die Pipeline (in eigenem Thread: der Wechsel nach Null kann blockieren).
    pub fn close(&self) {
        let pipeline = self.pipeline.clone();
        std::thread::spawn(move || {
            let _ = pipeline.set_state(gst::State::Null);
        });
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

fn negotiate(webrtcbin: &gst::Element, offer: gst_sdp::SDPMessage) -> Result<String, String> {
    let offer_desc = gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, offer);
    wait_promise(webrtcbin, "set-remote-description", &offer_desc)?;

    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |reply| {
        let answer = reply.ok().flatten().and_then(|s| s.get::<gst_webrtc::WebRTCSessionDescription>("answer").ok());
        let _ = tx.send(answer);
    });
    webrtcbin.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "create-answer timed out".to_string())?
        .ok_or("create-answer lieferte keine Antwort")?;
    wait_promise(webrtcbin, "set-local-description", &answer)?;

    // Nicht-Trickle: auf abgeschlossenes ICE-Gathering warten.
    let deadline = Instant::now() + Duration::from_secs(5);
    while webrtcbin.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state")
        != gst_webrtc::WebRTCICEGatheringState::Complete
    {
        if Instant::now() > deadline {
            return Err("ICE gathering timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let local = webrtcbin
        .property::<Option<gst_webrtc::WebRTCSessionDescription>>("local-description")
        .ok_or("keine lokale Beschreibung")?;
    local.sdp().as_text().map_err(|e| format!("sdp as_text: {e}"))
}

fn attach_receive(
    pipeline: &gst::Pipeline,
    pad: &gst::Pad,
    inbox: &Arc<Mutex<VecDeque<f32>>>,
    rx_samples: &Arc<AtomicU64>,
    dropped: &Arc<AtomicU64>,
) -> Result<(), String> {
    let _ = dropped;
    let depay = make("rtpopusdepay")?;
    let dec = make("opusdec")?;
    dec.set_property("use-inband-fec", true);
    let conv = make("audioconvert")?;
    let resample = make("audioresample")?;
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", 48_000i32)
        .field("channels", 1i32)
        .build();
    let filter = gst::ElementFactory::make("capsfilter").property("caps", &caps).build().map_err(|e| e.to_string())?;
    let sink = gst_app::AppSink::builder().sync(false).max_buffers(8).drop(true).build();
    let chain = [&depay, &dec, &conv, &resample, &filter, sink.upcast_ref::<gst::Element>()];
    pipeline.add_many(chain).map_err(|e| format!("add: {e}"))?;
    gst::Element::link_many(chain).map_err(|e| format!("link: {e}"))?;
    for el in chain {
        el.sync_state_with_parent().map_err(|e| format!("sync: {e}"))?;
    }
    pad.link(&depay.static_pad("sink").ok_or("depay ohne sink")?).map_err(|e| format!("pad link: {e:?}"))?;

    let inbox = inbox.clone();
    let rx_samples = rx_samples.clone();
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buf = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
                let mut q = inbox.lock().expect("lock poisoned");
                for c in map.as_slice().chunks_exact(4) {
                    q.push_back(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
                rx_samples.fetch_add((map.len() / 4) as u64, Ordering::Relaxed);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::payload_type;

    #[test]
    fn finds_opus_payload_type() {
        let sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:63 red/48000/2\r\n";
        assert_eq!(payload_type(sdp, "opus"), Some(111));
        assert_eq!(payload_type(sdp, "pcmu"), None);
    }
}
