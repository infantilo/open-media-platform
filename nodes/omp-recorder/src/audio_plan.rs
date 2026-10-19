//! Kanalplan der Aufnahme (Kapitel 45): welche Quelle/welcher Kanal landet auf welchem Ausgabekanal der Datei — mehrere
//! Quellen, beliebige Reihenfolge („Shuffling“), Stille und Gain je Kanal.
//!
//! Aufbau je gelesener Quelle (Eingang `i`): `audioconvert → audioresample → F32LE/48 kHz → audiomixmatrix` (Eingangskanäle →
//! alle `N` Ausgabekanäle, Zeile = Ausgabekanal, Spalte = Eingangskanal, Wert = linearer Gain). Die Matrizen aller Eingänge werden im
//! `audiomixer` addiert; ein Ausgabekanal, den kein Eingang speist, bleibt still.
//!
//! Plan-JSON (`record.audioPlan`): `{"channels":[{"input":0,"channel":1,"gainDb":-3},{"input":null}]}` — `input` 0 ist die
//! Hauptquelle (Audio-Receiver 1), 1… die weiteren Audio-Receiver; `null` = Stille.

use gst::prelude::*;
use gstreamer as gst;
use serde_json::Value;

pub const MAX_CHANNELS: usize = 32;
const MIN_GAIN_DB: f64 = -96.0;
const MAX_GAIN_DB: f64 = 24.0;
/// Zusätzliche Wartezeit des Mischers auf den langsamsten Eingang. Ändert keine Zeitstempel (Bild/Ton bleiben synchron), nur
/// wann ein Puffer ausgegeben wird.
const MIXER_LATENCY_NS: u64 = 40_000_000;

#[derive(Debug, Clone, PartialEq)]
pub struct OutChannel {
    /// `None` = Stille.
    pub input: Option<usize>,
    /// 0-basierter Kanal des Eingangs.
    pub channel: usize,
    pub gain_db: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioPlan {
    pub channels: Vec<OutChannel>,
}

impl AudioPlan {
    /// Leerer Text = kein Plan (Durchreichen des Tons der Hauptquelle wie bisher).
    pub fn parse(text: &str) -> Result<Option<AudioPlan>, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        let v: Value = serde_json::from_str(text).map_err(|e| format!("Kanalplan ist kein JSON: {e}"))?;
        let list = v.get("channels").and_then(Value::as_array).ok_or("Kanalplan: Feld \"channels\" fehlt")?;
        if list.is_empty() {
            return Ok(None);
        }
        if list.len() > MAX_CHANNELS {
            return Err(format!("Kanalplan: höchstens {MAX_CHANNELS} Ausgabekanäle"));
        }
        let mut channels = Vec::with_capacity(list.len());
        for (n, c) in list.iter().enumerate() {
            let input = match c.get("input") {
                None | Some(Value::Null) => None,
                Some(x) => Some(x.as_u64().ok_or_else(|| format!("Kanalplan: Ausgabekanal {}: \"input\" ungültig", n + 1))? as usize),
            };
            let channel = c.get("channel").map_or(Some(0), Value::as_u64).ok_or_else(|| format!("Kanalplan: Ausgabekanal {}: \"channel\" ungültig", n + 1))? as usize;
            let gain_db = c.get("gainDb").map_or(Some(0.0), Value::as_f64).ok_or_else(|| format!("Kanalplan: Ausgabekanal {}: \"gainDb\" ungültig", n + 1))?;
            if !(MIN_GAIN_DB..=MAX_GAIN_DB).contains(&gain_db) {
                return Err(format!("Kanalplan: Ausgabekanal {}: Gain {gain_db} dB außerhalb {MIN_GAIN_DB}…{MAX_GAIN_DB}", n + 1));
            }
            channels.push(OutChannel { input, channel, gain_db });
        }
        if channels.iter().all(|c| c.input.is_none()) {
            return Err("Kanalplan: kein Ausgabekanal ist mit einer Quelle belegt".to_string());
        }
        Ok(Some(AudioPlan { channels }))
    }

    /// Verwendete Eingänge, aufsteigend, ohne Doppelte.
    pub fn used_inputs(&self) -> Vec<usize> {
        let mut v: Vec<usize> = self.channels.iter().filter_map(|c| c.input).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// Prüft den Plan gegen die tatsächlichen Kanalzahlen (`in_channels(i)` = Kanäle des gelesenen Flows, `None` = nicht verbunden).
    pub fn validate(&self, in_channels: &dyn Fn(usize) -> Option<u32>) -> Result<(), String> {
        for (n, c) in self.channels.iter().enumerate() {
            let Some(i) = c.input else { continue };
            let avail = in_channels(i).ok_or_else(|| format!("Ausgabekanal {}: Audio-Eingang {} ist nicht verbunden", n + 1, i + 1))?;
            if c.channel >= avail as usize {
                return Err(format!("Ausgabekanal {}: Eingang {} hat nur {avail} Kanäle (Kanal {} gewünscht)", n + 1, i + 1, c.channel + 1));
            }
        }
        Ok(())
    }

    /// Matrix eines Eingangs: `out.len()` Zeilen × `in_channels` Spalten (linearer Gain).
    pub fn matrix(&self, input: usize, in_channels: u32) -> Vec<Vec<f64>> {
        self.channels
            .iter()
            .map(|oc| {
                let mut row = vec![0.0; in_channels as usize];
                if oc.input == Some(input) && oc.channel < row.len() {
                    row[oc.channel] = 10f64.powf(oc.gain_db / 20.0);
                }
                row
            })
            .collect()
    }
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

fn caps_f32(channels: Option<usize>) -> gst::Caps {
    let mut b = gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("layout", "interleaved").field("rate", 48_000i32);
    if let Some(n) = channels {
        b = b.field("channels", n as i32);
        // Mehr als zwei Kanäle ohne Lautsprecherbelegung: GStreamer verlangt dafür ausdrücklich die leere Kanalmaske
        // (sonst „not-negotiated“ zwischen Matrix und Mischer).
        if n > 2 {
            b = b.field("channel-mask", gst::Bitmask::new(0));
        }
    }
    b.build()
}

/// Baut den Misch-Teilgraphen. `inputs` = (Eingangsnummer, Ende der Lesekette des Eingangs, Kanalzahl). Liefert das Ende des
/// Teilgraphen (F32LE, 48 kHz, `plan.channels.len()` Kanäle). Alle Elemente werden zur Pipeline hinzugefügt und verkettet.
pub fn build_matrix_graph(pipeline: &gst::Pipeline, plan: &AudioPlan, inputs: &[(usize, gst::Element, u32)]) -> Result<gst::Element, String> {
    let out_n = plan.channels.len();
    let mixer = make("audiomixer")?;
    mixer.set_property("latency", MIXER_LATENCY_NS);
    let out_caps = gst::ElementFactory::make("capsfilter").property("caps", caps_f32(Some(out_n))).build().map_err(|e| format!("capsfilter: {e}"))?;
    pipeline.add_many([&mixer, &out_caps]).map_err(|e| format!("add mixer: {e}"))?;
    mixer.link(&out_caps).map_err(|e| format!("link mixer: {e}"))?;

    for (idx, tail, in_ch) in inputs {
        let convert = make("audioconvert")?;
        let resample = make("audioresample")?;
        let pre = gst::ElementFactory::make("capsfilter")
            .property("caps", caps_f32(Some(*in_ch as usize)))
            .build()
            .map_err(|e| format!("capsfilter: {e}"))?;
        let matrix_el = make("audiomixmatrix")?;
        matrix_el.set_property("in-channels", *in_ch);
        matrix_el.set_property("out-channels", out_n as u32);
        let rows: Vec<gst::glib::SendValue> = plan.matrix(*idx, *in_ch).into_iter().map(|r| gst::Array::new(r).to_send_value()).collect();
        matrix_el.set_property("matrix", gst::Array::new(rows));
        let post = gst::ElementFactory::make("capsfilter").property("caps", caps_f32(Some(out_n))).build().map_err(|e| format!("capsfilter: {e}"))?;
        pipeline.add_many([&convert, &resample, &pre, &matrix_el, &post]).map_err(|e| format!("add input {}: {e}", idx + 1))?;
        gst::Element::link_many([tail, &convert, &resample, &pre, &matrix_el, &post]).map_err(|e| format!("link input {}: {e}", idx + 1))?;
        let pad = mixer.request_pad_simple("sink_%u").ok_or("audiomixer: kein Pad")?;
        post.static_pad("src").ok_or("matrix: kein src-Pad")?.link(&pad).map_err(|e| format!("link input {} to mixer: {e}", idx + 1))?;
    }
    Ok(out_caps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gstreamer_app as gst_app;

    #[test]
    fn parses_plan_with_defaults_and_silence() {
        let p = AudioPlan::parse(r#"{"channels":[{"input":0,"channel":1,"gainDb":-6},{"input":null},{"input":2}]}"#).unwrap().unwrap();
        assert_eq!(p.channels.len(), 3);
        assert_eq!(p.channels[0], OutChannel { input: Some(0), channel: 1, gain_db: -6.0 });
        assert_eq!(p.channels[1].input, None);
        assert_eq!(p.channels[2], OutChannel { input: Some(2), channel: 0, gain_db: 0.0 });
        assert_eq!(p.used_inputs(), vec![0, 2]);
    }

    #[test]
    fn empty_text_means_no_plan_and_bad_plans_are_rejected() {
        assert_eq!(AudioPlan::parse("  ").unwrap(), None);
        assert_eq!(AudioPlan::parse(r#"{"channels":[]}"#).unwrap(), None);
        assert!(AudioPlan::parse("kein json").is_err());
        assert!(AudioPlan::parse(r#"{"x":1}"#).is_err());
        assert!(AudioPlan::parse(r#"{"channels":[{"input":null}]}"#).is_err(), "nur Stille ist kein sinnvoller Plan");
        assert!(AudioPlan::parse(r#"{"channels":[{"input":0,"gainDb":99}]}"#).is_err());
        assert!(AudioPlan::parse(r#"{"channels":[{"input":-1}]}"#).is_err());
        let many = format!(r#"{{"channels":[{}]}}"#, vec![r#"{"input":0}"#; MAX_CHANNELS + 1].join(","));
        assert!(AudioPlan::parse(&many).is_err());
    }

    #[test]
    fn validate_checks_connection_and_channel_range() {
        let p = AudioPlan::parse(r#"{"channels":[{"input":0,"channel":1},{"input":1,"channel":0}]}"#).unwrap().unwrap();
        assert!(p.validate(&|i| Some([2, 1][i])).is_ok());
        let e = p.validate(&|i| if i == 0 { Some(2) } else { None }).unwrap_err();
        assert!(e.contains("Eingang 2") && e.contains("nicht verbunden"), "{e}");
        let e = p.validate(&|_| Some(1)).unwrap_err();
        assert!(e.contains("nur 1 Kanäle"), "{e}");
    }

    #[test]
    fn matrix_has_one_row_per_output_and_linear_gain() {
        let p = AudioPlan::parse(r#"{"channels":[{"input":0,"channel":1,"gainDb":-6.0206},{"input":1,"channel":0},{"input":null}]}"#).unwrap().unwrap();
        let m0 = p.matrix(0, 2);
        assert_eq!(m0.len(), 3);
        assert!((m0[0][1] - 0.5).abs() < 1e-3 && m0[0][0] == 0.0);
        assert!(m0[1].iter().all(|v| *v == 0.0) && m0[2].iter().all(|v| *v == 0.0));
        assert_eq!(p.matrix(1, 1)[1], vec![1.0]);
    }

    /// Echter GStreamer-Lauf: zwei Quellen (Stereo-Sinus, Mono-Rechteck) → drei Ausgabekanäle (Kanal 2 der Quelle 0, Quelle 1 mit −6 dB, Stille).
    #[test]
    fn routes_channels_of_two_sources_and_keeps_silence() {
        gst::init().unwrap();
        let pipeline = gst::Pipeline::new();
        let src = |wave: &str, ch: i32, vol: f64| {
            let s = gst::ElementFactory::make("audiotestsrc").property("num-buffers", 20i32).property("volume", vol).build().unwrap();
            s.set_property_from_str("wave", wave);
            let c = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("audio/x-raw").field("channels", ch).field("rate", 48_000i32).build()).build().unwrap();
            pipeline.add_many([&s, &c]).unwrap();
            s.link(&c).unwrap();
            c
        };
        let a = src("sine", 2, 0.5);
        let b = src("square", 1, 0.5);
        let plan = AudioPlan::parse(r#"{"channels":[{"input":0,"channel":1},{"input":1,"channel":0,"gainDb":-6.0206},{"input":null}]}"#).unwrap().unwrap();
        let tail = build_matrix_graph(&pipeline, &plan, &[(0, a, 2), (1, b, 1)]).unwrap();
        let sink = gst_app::AppSink::builder().sync(false).build();
        pipeline.add(&sink).unwrap();
        tail.link(&sink).unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        let mut energy = [0f64; 3];
        let mut frames = 0usize;
        let bus = pipeline.bus().unwrap();
        loop {
            let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_seconds(5)) else {
                if sink.is_eos() {
                    break;
                }
                let err = bus.pop_filtered(&[gst::MessageType::Error]).map(|m| format!("{m:?}"));
                panic!("keine Daten, kein EOS; Bus: {err:?}");
            };
            let buf = sample.buffer().unwrap();
            let map = buf.map_readable().unwrap();
            for fr in map.chunks_exact(12) {
                for c in 0..3 {
                    let x = f32::from_le_bytes(fr[c * 4..c * 4 + 4].try_into().unwrap()) as f64;
                    energy[c] += x * x;
                }
                frames += 1;
            }
        }
        pipeline.set_state(gst::State::Null).unwrap();
        assert!(frames > 10_000, "zu wenig Daten: {frames}");
        let rms: Vec<f64> = energy.iter().map(|e| (e / frames as f64).sqrt()).collect();
        // Sinus 0,5 → Effektivwert ≈ 0,354; Rechteck 0,5 mit −6 dB → 0,25; Stille exakt 0
        assert!((rms[0] - 0.354).abs() < 0.03, "Kanal 1 (Quelle 0, Kanal 2): {rms:?}");
        assert!((rms[1] - 0.25).abs() < 0.03, "Kanal 2 (Quelle 1, −6 dB): {rms:?}");
        assert!(rms[2] < 1e-6, "Kanal 3 muss still sein: {rms:?}");
    }
}
