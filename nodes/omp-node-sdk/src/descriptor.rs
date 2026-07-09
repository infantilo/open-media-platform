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

/// Body von `GET /descriptor.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Descriptor {
    pub parameters: Vec<ParamSpec>,
    pub methods: Vec<MethodSpec>,
}
