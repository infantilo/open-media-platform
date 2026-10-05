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
use omp_audio_rules::{AudioPlan, AudioSettings, Layout, Mapping, ProbeInfo, SourceDesc, SourceKind, SourceTrack};

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

fn service_token(orchestrator_url: &str, instance_id: &str, launch_secret: &str) -> Result<String, String> {
    let url = format!("{}/api/v1/instances/{}/service-token", orchestrator_url.trim_end_matches('/'), instance_id);
    let mut resp = ureq::post(&url).send_json(serde_json::json!({ "launchSecret": launch_secret })).map_err(|e| format!("service-token request failed: {e}"))?;
    let body: serde_json::Value = resp.body_mut().read_json().map_err(|e| format!("service-token response: {e}"))?;
    body.get("token").and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| "service-token response missing 'token' field".to_string())
}

/// Lädt das Audio-Dokument vom Orchestrator; jeder Fehler (kein Launcher,
/// nicht erreichbar, ungültig) fällt mit Log-Zeile auf die eingebauten
/// Standardwerte zurück, damit der Node immer startet.
pub fn load_settings(orchestrator_url: &str, instance_id: Option<&str>, launch_secret: &str) -> AudioSettings {
    let fallback = |why: String| {
        eprintln!("omp-channel-player: Audio-Einstellungen: {why} — verwende eingebaute Standardwerte");
        omp_audio_rules::defaults::default_settings()
    };
    let Some(instance_id) = instance_id.filter(|_| !launch_secret.is_empty()) else {
        return fallback("OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen".to_string());
    };
    let token = match service_token(orchestrator_url, instance_id, launch_secret) {
        Ok(t) => t,
        Err(e) => return fallback(e),
    };
    let url = format!("{}/api/v1/audio-rules", orchestrator_url.trim_end_matches('/'));
    let fetched = ureq::get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Abruf fehlgeschlagen: {e}"))
        .and_then(|mut r| r.body_mut().read_json::<AudioSettings>().map_err(|e| format!("Antwort ungültig: {e}")));
    match fetched {
        Ok(s) => {
            let errs = s.validate();
            if errs.is_empty() {
                eprintln!("omp-channel-player: Audio-Einstellungen vom Orchestrator geladen ({} Zielgruppen, {} Zuordnungen)", s.output_profile.groups.len(), s.mappings.len());
                s
            } else {
                fallback(format!("Dokument ungültig ({})", errs.join("; ")))
            }
        }
        Err(e) => fallback(e),
    }
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
    /// Verarbeitungsschritt `gain` (Standard 1,0 = Durchgriff).
    volume: gst::Element,
    /// Verarbeitungsschritt `delay`: `min-threshold-time` der Queue (Standard 0).
    delay: gst::Element,
    channels: u32,
    tail: gst::Element,
}

/// Verarbeitungsschritte, die dieser Node ausführt (Rest wird als Warnung gemeldet).
const EXECUTABLE_STEPS: [&str; 2] = ["gain", "delay"];

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
            let delay = gst::ElementFactory::make("queue")
                .property("max-size-buffers", 0u32)
                .property("max-size-bytes", 0u32)
                .property("max-size-time", 10_000_000_000u64)
                .build()
                .map_err(|e| format!("queue(delay): {e}"))?;
            let tail = make("identity")?;
            pipeline.add_many([&queue, &matrix, &caps, &volume, &delay, &tail]).map_err(|e| format!("add group chain ({}): {e}", g.id))?;
            gst::Element::link_many([&tee, &queue, &matrix, &caps, &volume, &delay, &tail]).map_err(|e| format!("link group chain ({}): {e}", g.id))?;
            groups.push(DistGroup { matrix, volume, delay, channels: g.channels, tail });
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
        SourceDesc { kind, tracks: vec![SourceTrack { n: 1, layout: Layout::Stereo, channels: vec![], tags: vec!["role:pt".to_string()] }] }
    }

    /// MXF-Datei mit `track_count` Spuren: Schema per Probe, sonst `pos:N`-Mono-Spuren.
    pub fn mxf_source(&self, track_count: u32, path: &str) -> SourceDesc {
        let probe = ProbeInfo { format: "mxf".to_string(), track_count, path: path.to_string() };
        if let Some(schema) = omp_audio_rules::select_schema(&self.ctx.settings.track_schemas, &probe) {
            return SourceDesc { kind: SourceKind::File, tracks: schema.tracks.clone() };
        }
        let tracks = (1..=track_count).map(|n| SourceTrack { n, layout: Layout::Mono, channels: vec![], tags: vec![format!("pos:{n}")] }).collect();
        SourceDesc { kind: SourceKind::File, tracks }
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
    dg.volume.set_property("volume", 10f64.powf(gain_db / 20.0).clamp(0.0, 10.0));
    dg.delay.set_property("min-threshold-time", (delay_ms * 1_000_000.0) as u64);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_and_delay_are_applied_and_reset_per_chain() {
        gst::init().unwrap();
        let mk = |n: &str| gst::ElementFactory::make(n).build().unwrap();
        let dg = DistGroup { matrix: mk("audiomixmatrix"), volume: mk("volume"), delay: mk("queue"), channels: 2, tail: mk("identity") };
        let step = |name: &str, key: &str, v: f64| omp_audio_rules::ProcessorRef { name: name.into(), params: [(key.to_string(), serde_json::json!(v))].into_iter().collect() };
        apply_chain(&dg, &[step("gain", "db", -6.0), step("delay", "ms", 40.0)]);
        assert!((dg.volume.property::<f64>("volume") - 0.501).abs() < 0.01);
        assert_eq!(dg.delay.property::<u64>("min-threshold-time"), 40_000_000);
        apply_chain(&dg, &[]);
        assert_eq!(dg.volume.property::<f64>("volume"), 1.0);
        assert_eq!(dg.delay.property::<u64>("min-threshold-time"), 0);
    }
}
