//! Selbstbeschreibung eines Nodes (Parameter + Methoden), Wire-Format nach
//! `docs/descriptor-v0.schema.json` — identisch zum Go-Pendant
//! (`nodes/mock/internal/descriptor`), damit Orchestrator und UI (A8/B6)
//! Rust- und Go-Nodes ununterscheidbar behandeln.

use serde::{Deserialize, Serialize};

/// Datentyp eines Parameters/Methodenarguments (Schema: "number", "boolean",
/// "enum", "string").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    Number,
    Boolean,
    Enum,
    String,
}

/// Wertebereich eines Parameters: Min/Max für Zahlen, erlaubte Werte für
/// Enums. Fehlt (`None`) für `string`/`boolean`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Range {
    Number { min: f64, max: f64 },
    Enum { values: Vec<String> },
}

/// Ein über `GET`/`PATCH /params/<name>` erreichbarer Parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ParamType,
    pub unit: Option<String>,
    pub range: Option<Range>,
    pub readonly: bool,
}

/// Ein Argument einer Methode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MethodArg {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ParamType,
}

/// Eine über `POST /methods/<name>` aufrufbare Methode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MethodSpec {
    pub name: String,
    pub args: Vec<MethodArg>,
}

/// Latenzbereich (Frames/Samples in der Grain-Rate des betroffenen Flows)
/// für eine Medienart — `min`/`max` können gleich sein (deterministische
/// Latenz, z. B. `omp-scaler`) oder auseinanderfallen (Jitter-Spanne, z. B.
/// `omp-video-mixer-me`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyRange {
    pub min_latency_frames: u32,
    pub max_latency_frames: u32,
}

/// Per-Node-Latenzdeklaration (additiv, `ARCHITECTURE.md` §15,
/// `UMSETZUNG.md` D8 Teil 1) — getrennt nach Medienart, da ein
/// Video-Frame-Budget kein automatisches Audio-/Daten-Budget ist (§15.1
/// Punkt 5). Live gemessen per Kopf-Index/Wallclock-Skew-Verfahren
/// (`docs/decisions.md`, Nachtrag zur A/V-Sync-Messung 2026-07-29), nicht
/// geraten — Werte spiegeln, was der Node tatsächlich zusätzlich an
/// Latenz einbringt (bei origin-erhaltenden Nodes wie `omp-scaler`
/// gegenüber dem Eingang; bei Nodes, die laut §15.1 Punkt 4 einen neuen
/// Ursprung setzen, wie Mixer, gegenüber der Wallclock).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyInfo {
    pub video: Option<LatencyRange>,
    pub audio: Option<LatencyRange>,
    pub data: Option<LatencyRange>,
    /// `true`, falls der Node zusätzlich `POST /methods/setOutputDelay
    /// {"frames": N}` unterstützt (§15.1 Punkt 3, D8 Teil 3 — der
    /// eigentliche Delay-Ausgleich ist noch nicht implementiert, dieses
    /// Feld beschreibt nur die Fähigkeit).
    pub supports_delay_compensation: bool,
}

/// Body von `GET /descriptor.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Descriptor {
    pub parameters: Vec<ParamSpec>,
    pub methods: Vec<MethodSpec>,
    /// Optional (D8 Teil 1) — `None`/fehlend im JSON (per
    /// `skip_serializing_if`) verhält sich exakt wie vor diesem Feld,
    /// bestehende Nodes ohne Latenzangabe bleiben unverändert lauffähig.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency: Option<LatencyInfo>,
}
