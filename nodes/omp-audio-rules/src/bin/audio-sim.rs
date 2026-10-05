//! Testwerkzeug für den Audio-Editor: löst einen Plan für eine beschriebene Quelle auf, ohne Medien.
//! Eingabe (stdin, JSON): `{"settings": <audio-rules-Dokument>, "source": {"kind":"file|live","tracks":[…]}, "mapping": "<id>"|null}`.
//! Ausgabe (stdout, JSON): der `AudioPlan`, oder `{"errors":[…]}` bei ungültigem Dokument/Eingabe.
//! Die Logik ist dieselbe wie in den Nodes (`omp_audio_rules::resolve`), der Orchestrator ruft dieses Programm auf.

use std::io::Read;

use omp_audio_rules::{AudioSettings, SourceDesc};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    settings: AudioSettings,
    source: SourceDesc,
    #[serde(default)]
    mapping: Option<String>,
}

fn fail(errors: Vec<String>) -> ! {
    println!("{}", serde_json::json!({ "errors": errors }));
    std::process::exit(0);
}

fn main() {
    let mut raw = String::new();
    if std::io::stdin().take(4 * 1024 * 1024).read_to_string(&mut raw).is_err() {
        fail(vec!["Eingabe nicht lesbar".to_string()]);
    }
    let input: Input = match serde_json::from_str(&raw) {
        Ok(i) => i,
        Err(e) => fail(vec![format!("Eingabe ungültig: {e}")]),
    };
    let errors = input.settings.validate();
    if !errors.is_empty() {
        fail(errors);
    }
    let mapping = match &input.mapping {
        Some(id) if !id.is_empty() => match input.settings.mappings.iter().find(|m| &m.id == id) {
            Some(m) => Some(m),
            None => fail(vec![format!("Zuordnung '{id}' unbekannt")]),
        },
        _ => None,
    };
    let s = &input.settings;
    let plan = omp_audio_rules::resolve(&s.output_profile, &input.source, mapping, &s.rule_set);
    println!("{}", serde_json::to_string(&plan).expect("Plan ist serialisierbar"));
}
