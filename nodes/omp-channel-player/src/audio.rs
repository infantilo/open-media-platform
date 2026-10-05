//! Dynamische Audio-Ausgabe (docs/ENTWURF-AUDIO-REGELN.md, A3): statt eines
//! festen Stereo-Ausgangs erzeugt dieser Node je Zielgruppe des Ausgabeprofils
//! einen eigenen MXL-Audio-Flow. Quelle → [`Distributor`] → je Gruppe
//! `audiomixmatrix` mit den Koeffizienten des aufgelösten [`AudioPlan`]s.
//!
//! Die Gruppen-Struktur (Anzahl, Kanäle) steht beim Start fest (neue NMOS-
//! Sender nur beim Start, wie überall im System); Zuordnung und Matrizen
//! wechseln dagegen bei jedem `load()`.

use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use omp_audio_rules::loudness::{LoudnessParams, Normalizer};
use omp_audio_rules::{AudioPlan, AudioSettings, Mapping, SourceDesc, SourceKind};

use crate::pipeline::SAMPLE_RATE;

/// Standardzuordnung für MXF-Dateien, wenn das Event keine nennt (frühere feste Wahl).
pub const DEFAULT_MXF_MAPPING: &str = "stereo";

/// Eine Zielgruppe mit ihrem festen MXL-Flow.
#[derive(Clone, Debug)]
pub struct GroupFlow {
    pub id: String,
    pub label: String,
    pub channels: u32,
    pub flow_id: String,
}

/// Alles Audio-Konfigurative, vom Orchestrator beim Start geladen.
pub struct AudioCtx {
    pub settings: AudioSettings,
    pub groups: Vec<GroupFlow>,
}

impl AudioCtx {
    pub fn new(settings: AudioSettings, new_flow_id: impl Fn() -> String) -> Self {
        let groups = settings
            .output_profile
            .groups
            .iter()
            .map(|g| GroupFlow { id: g.id.clone(), label: g.label.clone(), channels: g.channel_names().len() as u32, flow_id: new_flow_id() })
            .collect();
        AudioCtx { settings, groups }
    }
}

/// Lädt das Audio-Dokument vom Orchestrator (Fallback: Standardwerte), s. `omp_audio_rules::client`.
pub fn load_settings(orchestrator_url: &str, instance_id: Option<&str>, launch_secret: &str) -> AudioSettings {
    omp_audio_rules::client::load_settings("omp-channel-player", orchestrator_url, instance_id, launch_secret)
}

fn group_caps(channels: u32) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", channels as i32)
        .field("layout", "interleaved")
        .build()
}

fn matrix_to_gst_array(matrix: &[Vec<f64>]) -> gst::Array {
    gst::Array::new(matrix.iter().map(|row| gst::Array::new(row.iter().copied())))
}

/// Ein Zweig des Verteilers: `queue → audiomixmatrix → capsfilter → volume → queue(delay)`, am Ende `tail`.
struct DistGroup {
    matrix: gst::Element,
    /// Verarbeitungsschritt `gain` (Standard 1,0 = Durchgriff); mit `loudness` führt ihn der Normalizer nach.
    volume: gst::Element,
    /// Schritt `loudness` (EBU R128): `Some` = aktiv. Der Pad-Probe vor `volume` misst und regelt.
    loudness: Arc<Mutex<Option<Normalizer>>>,
    /// Fester Gain des Schritts `gain` (linear), mit dem der Normalizer-Gain multipliziert wird.
    base_gain: Arc<Mutex<f64>>,
    /// Verarbeitungsschritt `delay`: `min-threshold-time` der Queue (Standard 0).
    delay: gst::Element,
    channels: u32,
    tail: gst::Element,
}

/// Verarbeitungsschritte, die dieser Node ausführt (Rest wird als Warnung gemeldet).
const EXECUTABLE_STEPS: [&str; 3] = ["gain", "delay", "loudness"];

/// Verteilt einen interleaved Quellstrom (N Kanäle) auf alle Zielgruppen.
pub struct Distributor {
    /// Hier hängt die Quelle an (interleaved F32LE, beliebige Kanalzahl).
    pub input: gst::Element,
    groups: Vec<DistGroup>,
    ctx: Arc<AudioCtx>,
    plan: Arc<Mutex<Option<AudioPlan>>>,
}

impl Distributor {
    /// Baut `input(identity) → tee → je Gruppe [queue → audiomixmatrix → caps → identity]`.
    pub fn build(pipeline: &gst::Pipeline, ctx: Arc<AudioCtx>, plan: Arc<Mutex<Option<AudioPlan>>>) -> Result<Self, String> {
        let make = |name: &str| gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"));
        let input = make("identity")?;
        let tee = make("tee")?;
        pipeline.add_many([&input, &tee]).map_err(|e| format!("add distributor: {e}"))?;
        input.link(&tee).map_err(|e| format!("link distributor input: {e}"))?;
        let mut groups = Vec::new();
        for g in &ctx.groups {
            let queue = make("queue")?;
            // Reihenfolge kritisch: erst bauen, dann sequenziell setzen (sonst validiert
            // audiomixmatrix die Matrix gegen die 0/0-Standardwerte).
            let matrix = make("audiomixmatrix")?;
            matrix.set_property("out-channels", g.channels);
            matrix.set_property("in-channels", 1u32);
            matrix.set_property("matrix", matrix_to_gst_array(&vec![vec![0.0f64; 1]; g.channels as usize]));
            let caps = gst::ElementFactory::make("capsfilter").property("caps", group_caps(g.channels)).build().map_err(|e| format!("capsfilter({}): {e}", g.id))?;
            let volume = make("volume")?;
            let loudness: Arc<Mutex<Option<Normalizer>>> = Arc::new(Mutex::new(None));
            let base_gain = Arc::new(Mutex::new(1.0f64));
            {
                // Messen und nachregeln: jeder Puffer vor `volume` geht durch den Normalizer (nur wenn aktiv).
                let (state, base, vol) = (loudness.clone(), base_gain.clone(), volume.clone());
                volume.static_pad("sink").ok_or("volume: kein sink-Pad")?.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
                    if let Some(buf) = info.buffer()
                        && let Ok(mut guard) = state.try_lock()
                        && let Some(n) = guard.as_mut()
                        && let Ok(map) = buf.map_readable()
                    {
                        let samples: Vec<f32> = map.as_slice().chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                        let lin = n.process(&samples) * *base.lock().expect("lock poisoned");
                        vol.set_property("volume", lin.clamp(0.0, 10.0));
                    }
                    gst::PadProbeReturn::Ok
                });
            }
            let delay = gst::ElementFactory::make("queue")
                .property("max-size-buffers", 0u32)
                .property("max-size-bytes", 0u32)
                .property("max-size-time", 10_000_000_000u64)
                .build()
                .map_err(|e| format!("queue(delay): {e}"))?;
            let tail = make("identity")?;
            pipeline.add_many([&queue, &matrix, &caps, &volume, &delay, &tail]).map_err(|e| format!("add group chain ({}): {e}", g.id))?;
            gst::Element::link_many([&tee, &queue, &matrix, &caps, &volume, &delay, &tail]).map_err(|e| format!("link group chain ({}): {e}", g.id))?;
            groups.push(DistGroup { matrix, volume, loudness, base_gain, delay, channels: g.channels, tail });
        }
        Ok(Distributor { input, groups, ctx, plan })
    }

    /// Ausgangs-Tails je Gruppe, in Profil-Reihenfolge.
    pub fn tails(&self) -> Vec<gst::Element> {
        self.groups.iter().map(|g| g.tail.clone()).collect()
    }

    /// Löst den Plan für `source` auf und setzt die Matrizen. Muss vor dem ersten
    /// Datenfluss laufen (nach `no-more-pads` bzw. vor `Playing`).
    pub fn configure(&self, source: &SourceDesc, mapping: Option<&Mapping>) -> AudioPlan {
        let settings = &self.ctx.settings;
        let mut plan = omp_audio_rules::resolve(&settings.output_profile, source, mapping, &settings.rule_set);
        let ncols = plan.src_channels.len().max(1) as u32;
        for (dg, gp) in self.groups.iter().zip(&plan.groups) {
            dg.matrix.set_property("out-channels", dg.channels);
            dg.matrix.set_property("in-channels", ncols);
            let rows: Vec<Vec<f64>> = if gp.matrix.iter().all(|r| r.len() == ncols as usize) {
                gp.matrix.iter().map(|r| r.iter().map(|&c| f64::from(c)).collect()).collect()
            } else {
                vec![vec![0.0; ncols as usize]; dg.channels as usize]
            };
            dg.matrix.set_property("matrix", matrix_to_gst_array(&rows));
            apply_chain(dg, &gp.chain);
        }
        // Nicht ausführbare Verarbeitungsschritte als Warnung am Plan (sichtbar in der Automation).
        for gp in plan.groups.iter_mut() {
            for step in gp.chain.iter().filter(|p| !EXECUTABLE_STEPS.contains(&p.name.as_str())) {
                let label = settings.output_profile.groups.iter().find(|g| g.id == gp.group).map_or(gp.group.clone(), |g| g.label.clone());
                gp.warnings.push(format!("{label}: Verarbeitungsschritt '{}' wird von diesem Node nicht ausgeführt", step.name));
            }
        }
        plan.warnings = plan.groups.iter().flat_map(|g| g.warnings.clone()).collect();
        for w in &plan.warnings {
            eprintln!("omp-channel-player: Audio: {w}");
        }
        *self.plan.lock().expect("lock poisoned") = Some(plan.clone());
        plan
    }

    /// Quelle ohne Mehrspur-Container: ein Programmton-Stream (Live, Testton, Standbild, generische Datei).
    pub fn stereo_program_source(&self, kind: SourceKind) -> SourceDesc {
        AudioSettings::stereo_program_source(kind)
    }

    /// MXF-Datei mit `track_count` Spuren: Schema per Probe, sonst `pos:N`-Mono-Spuren.
    pub fn mxf_source(&self, track_count: u32, path: &str) -> SourceDesc {
        self.ctx.settings.mxf_source(track_count, path)
    }

    pub fn mapping_named(&self, id: &str) -> Option<&Mapping> {
        self.ctx.settings.mappings.iter().find(|m| m.id == id)
    }
}

/// Setzt `gain`/`delay` des Gruppenzweigs; ohne Eintrag Durchgriff (1,0 / 0 ms).
fn apply_chain(dg: &DistGroup, chain: &[omp_audio_rules::ProcessorRef]) {
    let num = |p: &omp_audio_rules::ProcessorRef, key: &str| p.params.get(key).and_then(|v| v.as_f64());
    let mut gain_db = 0.0f64;
    let mut delay_ms = 0.0f64;
    for step in chain {
        match step.name.as_str() {
            "gain" => gain_db += num(step, "db").unwrap_or(0.0),
            "delay" => delay_ms += num(step, "ms").unwrap_or(0.0).max(0.0),
            _ => {}
        }
    }
    let base = 10f64.powf(gain_db / 20.0).clamp(0.0, 10.0);
    dg.volume.set_property("volume", base);
    *dg.base_gain.lock().expect("lock poisoned") = base;
    // `loudness`: Ziel in LUFS (Standard -23), optional `maxGain` (dB) und `ceiling` (dBFS).
    *dg.loudness.lock().expect("lock poisoned") = chain.iter().find(|s| s.name == "loudness").and_then(|s| {
        let d = LoudnessParams::default();
        let params = LoudnessParams {
            target_lufs: num(s, "target").unwrap_or(d.target_lufs),
            max_gain_db: num(s, "maxGain").unwrap_or(d.max_gain_db).max(0.0),
            ceiling_dbfs: num(s, "ceiling").unwrap_or(d.ceiling_dbfs),
        };
        Normalizer::new(dg.channels, SAMPLE_RATE, params).map_err(|e| eprintln!("omp-channel-player: loudness: {e}")).ok()
    });
    dg.delay.set_property("min-threshold-time", (delay_ms * 1_000_000.0) as u64);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_and_delay_are_applied_and_reset_per_chain() {
        gst::init().unwrap();
        let mk = |n: &str| gst::ElementFactory::make(n).build().unwrap();
        let dg = DistGroup { matrix: mk("audiomixmatrix"), volume: mk("volume"), loudness: Default::default(), base_gain: Arc::new(Mutex::new(1.0)), delay: mk("queue"), channels: 2, tail: mk("identity") };
        let step = |name: &str, key: &str, v: f64| omp_audio_rules::ProcessorRef { name: name.into(), params: [(key.to_string(), serde_json::json!(v))].into_iter().collect() };
        apply_chain(&dg, &[step("gain", "db", -6.0), step("delay", "ms", 40.0)]);
        assert!((dg.volume.property::<f64>("volume") - 0.501).abs() < 0.01);
        assert_eq!(dg.delay.property::<u64>("min-threshold-time"), 40_000_000);
        assert!(dg.loudness.lock().unwrap().is_none());
        apply_chain(&dg, &[step("loudness", "target", -23.0)]);
        assert!(dg.loudness.lock().unwrap().is_some(), "loudness aktiviert den Normalizer");
        apply_chain(&dg, &[]);
        assert!(dg.loudness.lock().unwrap().is_none());
        assert_eq!(dg.volume.property::<f64>("volume"), 1.0);
        assert_eq!(dg.delay.property::<u64>("min-threshold-time"), 0);
    }
}
