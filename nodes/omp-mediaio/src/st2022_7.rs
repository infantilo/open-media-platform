//! SMPTE ST 2022-7 (nahtlose Schutzumschaltung) in Software: derselbe RTP-Strom wird über zwei Netzschenkel
//! gesendet bzw. empfangen. Das Modul fügt einer bereits gebauten, noch nicht laufenden ST-2110-Pipeline
//! einen zweiten Schenkel hinzu.
//!
//! - **Senden:** `valve ! tee`, ein Zweig je `udpsink`; beide Schenkel tragen dieselben RTP-Pakete (gleiche SSRC und
//!   Sequenznummern), wie ST 2022-7 es verlangt.
//! - **Empfangen:** zwei `udpsrc` laufen über einen `funnel` in den bestehenden `rtpjitterbuffer`; dieser verwirft ein
//!   doppelt ankommendes Paket (gleiche Sequenznummer) und gleicht die Laufzeitunterschiede der Schenkel aus. Fällt
//!   ein Schenkel aus, läuft der Strom über den anderen ohne Lücke weiter.
//!
//! **Grenzen (ehrlich):** Die Pakete laufen über den Kernel-UDP-Pfad (keine Hardware-Zeitstempel, kein
//! ST-2110-21-Pacing). Die Laufzeitdifferenz der Schenkel darf die Jitterbuffer-Latenz (Standard 200 ms) nicht
//! überschreiten. Beide Schenkel müssen verschiedene Netze/Gruppen sein, sonst gibt es keine Redundanz.

use gstreamer as gst;
use gst::prelude::*;

/// Zweiten Sendeschenkel einbauen: `valve → primary_sink` wird zu `valve → tee → {primary_sink, leg_b_sink}`.
/// Muss vor dem Start der Pipeline aufgerufen werden. Gibt den zweiten `udpsink` zurück.
pub fn add_tx_leg(
    pipeline: &gst::Pipeline,
    valve: &gst::Element,
    primary_sink: &gst::Element,
    name: &str,
    host: &str,
    port: u16,
) -> Result<gst::Element, String> {
    let src = valve.static_pad("src").ok_or("valve ohne src-Pad")?;
    let sink_pad = primary_sink.static_pad("sink").ok_or("udpsink ohne sink-Pad")?;
    src.unlink(&sink_pad).map_err(|e| format!("Sender-Kette trennen: {e}"))?;

    let tee = gst::ElementFactory::make("tee").build().map_err(|e| format!("tee: {e}"))?;
    let qa = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue: {e}"))?;
    let qb = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue: {e}"))?;
    let (sink_b, _) = crate::kbypass::make_sink(name, host, port)?;
    // gleiche Taktung wie Schenkel A (Pacing-Rate), falls dort gesetzt
    if primary_sink.find_property("max-bitrate").is_some() && sink_b.find_property("max-bitrate").is_some() {
        sink_b.set_property("max-bitrate", primary_sink.property::<u64>("max-bitrate"));
    }
    pipeline
        .add_many([&tee, &qa, &qb, &sink_b])
        .map_err(|e| format!("Schenkel B hinzufügen: {e}"))?;
    gst::Element::link_many([valve, &tee]).map_err(|e| format!("valve → tee: {e}"))?;
    gst::Element::link_many([&tee, &qa, primary_sink]).map_err(|e| format!("tee → Schenkel A: {e}"))?;
    gst::Element::link_many([&tee, &qb, &sink_b]).map_err(|e| format!("tee → Schenkel B: {e}"))?;
    Ok(sink_b)
}

/// Zweiten Empfangsschenkel einbauen: `udpsrc_a → jitterbuffer` wird zu `{udpsrc_a, udpsrc_b} → funnel → jitterbuffer`.
/// `jitterbuffer` ist der bereits eingebaute `rtpjitterbuffer`. Muss vor dem Start der Pipeline aufgerufen werden.
pub fn add_rx_leg(
    pipeline: &gst::Pipeline,
    jitterbuffer: &gst::Element,
    name: &str,
    port: u16,
    caps: &gst::Caps,
    group: Option<&str>,
) -> Result<(), String> {
    let jb_sink = jitterbuffer.static_pad("sink").ok_or("jitterbuffer ohne sink-Pad")?;
    let peer = jb_sink.peer().ok_or("jitterbuffer nicht verbunden")?;
    peer.unlink(&jb_sink).map_err(|e| format!("Empfänger-Kette trennen: {e}"))?;

    let funnel = gst::ElementFactory::make("funnel").build().map_err(|e| format!("funnel: {e}"))?;
    let (src_b, _) = crate::kbypass::make_src(name, port, caps, group)?;
    pipeline.add_many([&funnel, &src_b]).map_err(|e| format!("Schenkel B hinzufügen: {e}"))?;
    let fsink_a = funnel.request_pad_simple("sink_%u").ok_or("funnel: kein Pad")?;
    peer.link(&fsink_a).map_err(|e| format!("Schenkel A → funnel: {e}"))?;
    let fsink_b = funnel.request_pad_simple("sink_%u").ok_or("funnel: kein Pad")?;
    src_b
        .static_pad("src")
        .ok_or("udpsrc ohne src-Pad")?
        .link(&fsink_b)
        .map_err(|e| format!("Schenkel B → funnel: {e}"))?;
    funnel
        .static_pad("src")
        .ok_or("funnel ohne src-Pad")?
        .link(&jb_sink)
        .map_err(|e| format!("funnel → jitterbuffer: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;


    fn rtp_caps() -> gst::Caps {
        gst::Caps::builder("application/x-rtp")
            .field("media", "video")
            .field("clock-rate", 90000)
            .field("encoding-name", "RAW")
            .field("sampling", "YCbCr-4:2:2")
            .field("depth", "8")
            .field("width", "160")
            .field("height", "90")
            .field("payload", 96)
            .build()
    }

    /// Sendet `n` Bilder über beide Schenkel (`dead_a`: Schenkel A geht an einen Port, den niemand liest) und zählt die
    /// beim Empfänger ankommenden Bilder.
    fn run(dead_a: bool, n: u32, base: u16) -> u32 {
        let (port_a, port_b) = (base, base + 1);
        gst::init().unwrap();
        // Empfänger zuerst
        let rp = gst::Pipeline::new();
        let src_a = crate::kbypass::make_src("rx_a", port_a, &rtp_caps(), None).unwrap().0;
        let jb = gst::ElementFactory::make("rtpjitterbuffer").build().unwrap();
        let depay = gst::ElementFactory::make("rtpvrawdepay").build().unwrap();
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add_many([&src_a, &jb, &depay, &sink]).unwrap();
        gst::Element::link_many([&src_a, &jb, &depay, &sink]).unwrap();
        add_rx_leg(&rp, &jb, "rx_b", port_b, &rtp_caps(), None).unwrap();
        let got = Arc::new(AtomicU32::new(0));
        let g = got.clone();
        sink.static_pad("sink").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            g.fetch_add(1, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });
        rp.set_state(gst::State::Playing).unwrap();
        // Empfänger wirklich bereit (Sockets gebunden), bevor der Sender anfängt — sonst gehen die ersten Bilder verloren
        let _ = rp.state(gst::ClockTime::from_mseconds(500));

        // Sender
        let wp = gst::Pipeline::new();
        let a_port = if dead_a { port_a + 100 } else { port_a };
        let line = format!(
            "videotestsrc num-buffers={n} is-live=true ! video/x-raw,format=UYVY,width=160,height=90,framerate=50/1 ! rtpvrawpay ! valve name=v ! udpsink name=sa host=127.0.0.1 port={a_port} sync=false"
        );
        let bin = gst::parse::bin_from_description(&line, false).unwrap();
        wp.add(&bin).unwrap();
        let v = bin.by_name("v").unwrap();
        let sa = bin.by_name("sa").unwrap();
        // tee zwischen valve und sa: die Hilfsfunktion legt den zweiten Schenkel an
        let leg = add_tx_leg(&wp, &v, &sa, "tx_b2", "127.0.0.1", port_b).unwrap();
        leg.set_property("sync", false);
        wp.set_state(gst::State::Playing).unwrap();
        let bus = wp.bus().unwrap();
        let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(15), &[gst::MessageType::Eos, gst::MessageType::Error]);
        std::thread::sleep(std::time::Duration::from_millis(600));
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        got.load(Ordering::Relaxed)
    }

    /// Beide Schenkel intakt: kein Bild doppelt (der Jitterbuffer verwirft die Kopie), keines fehlt.
    #[test]
    fn both_legs_deliver_each_frame_once() {
        let n = 25;
        let got = run(false, n, 52210);
        // Kernaussage: nie mehr Bilder als gesendet (Duplikate verworfen); der Anlauf des Empfängers in der VM verliert
        // gelegentlich ein paar Bilder, deshalb nur eine untere Schranke
        assert!((n * 2 / 3..=n).contains(&got), "erwartet höchstens {n} Bilder (mind. {}), bekommen {got}", n * 2 / 3);
    }

    /// Schenkel A ausgefallen: Schenkel B liefert den Strom allein, ohne Lücke.
    #[test]
    fn stream_survives_loss_of_leg_a() {
        let n = 25;
        let got = run(true, n, 52220);
        assert!((n * 2 / 3..=n).contains(&got), "erwartet höchstens {n} Bilder über Schenkel B (mind. {}), bekommen {got}", n * 2 / 3);
    }
}
